/**
 * FSRS flashcard MCP server — entry point.
 *
 * Transports:
 *  - "http" (default): Streamable HTTP server at /mcp (the transport ChatGPT's
 *    MCP connector uses). Stateless per-request, CORS for local testing.
 *  - "stdio": standard MCP stdio transport for local tools / debugging.
 *
 * The server is a pure bridge: every tool calls the deployed Firebase HTTP API
 * (functions/) with the CUELINGUA_API_KEY env var as the X-API-Key header.
 * No secrets are logged or printed.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import { FirebaseBridge } from './bridge.js';
import { authGuardError, hasAuthMechanism, loadConfig } from './config.js';
import { registerFlashcardTools } from './tools.js';
import { registerReviewWidget } from './widget.js';
import { OAUTH_RESOURCE_METADATA_MCP_PATH, OAUTH_RESOURCE_METADATA_PATH, METADATA_CORS_HEADERS, challengeFor, gateRequest, serveResourceMetadata } from './auth.js';

const config = loadConfig();

function createAppServer(bearerToken?: string): McpServer {
  const bridge = new FirebaseBridge({
    apiKey: config.apiKey,
    baseUrl: config.apiBaseUrl,
    timeoutMs: config.requestTimeoutMs,
    // Request-scoped: the verified incoming Auth0 token is attached to THIS
    // request's bridge only (the HTTP layer passes gate.token per /mcp
    // request; stdio/health pass nothing). Never stored on the shared config.
    bearerToken,
  });
  const server = new McpServer(
    {
      name: 'fsrs-flashcards',
      version: '1.0.0',
      // Quiet behavior (surfaced to the model): widget-driven review actions
      // are rendered by the review widget — do not narrate them by default.
      description: 'FSRS flashcards with a review widget. Review-session tools (start/get/submit_review, end_review_session) are widget-driven: the widget renders sessions, cards, progress, mode, and answer feedback. Do not narrate or summarize them unless the user explicitly asks; use get_flashcard for card content when asked.'
        + (config.reviewTestMode
          ? ' TEST MODE ACTIVE (REVIEW_TEST_MODE): review sessions queue ALL cards (not only due), and submit_review advances the session but does NOT apply FSRS scheduling or modify any card. This is a temporary widget-testing mode.'
          : ''),
    },
    {
      // MCP SDK 1.x does not type the open extension capability yet, but
      // MCP Apps hosts use it to negotiate UI support during initialize.
      capabilities: {
        extensions: { 'io.modelcontextprotocol/ui': {} },
      } as never,
    },
  );
  registerFlashcardTools(server, bridge);
  // Rich `ui://` review widget (Apps SDK resource). Pure addition: hosts that
  // cannot render resources keep the textual tool output (tool schemas are
  // unchanged by the widget itself).
  registerReviewWidget(server, bridge);
  return server;
}

/* ------------------------------------------------------------------ */
/* STDIO transport                                                     */
/* ------------------------------------------------------------------ */

async function runStdio(): Promise<void> {
  const server = createAppServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/* ------------------------------------------------------------------ */
/* Streamable HTTP transport (stateless, per-request server)           */
/* ------------------------------------------------------------------ */

const MCP_PATH = '/mcp';
const MCP_METHODS = new Set(['POST', 'GET', 'DELETE']);

function handleOptions(res: import('node:http').ServerResponse): void {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, mcp-session-id, authorization',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  });
  res.end();
}

function serveHttp(): Promise<void> {
  // Deploy-time fail-closed guard: never serve an unauthenticated /mcp
  // against a REMOTE backend. stdio, loopback/local backends, and explicit
  // MCP_AUTH_OPT_OUT bypass this check.
  const guardError = authGuardError(config);
  if (guardError !== null) {
    console.error(guardError);
    return Promise.reject(new Error(guardError));
  }
  const httpServer = createServer(async (req, res) => {
    try {
      // Use a fixed base: only req.url (pathname+query) drives routing — the
      // caller-supplied Host header is never needed and could be malformed.
      const url = new URL(req.url ?? '/', 'http://localhost');

      // RFC 9728 protected-resource metadata. Served at the /mcp-suffixed path
      // (the challenge target) and the root-level path (what the ChatGPT MCP
      // connector actually queries). CORS is enabled (the connector fetches
      // these cross-origin from chatgpt.com) and OPTIONS preflights are
      // answered so the browser can read the document.
      const isMetadataPath = url.pathname === OAUTH_RESOURCE_METADATA_MCP_PATH || url.pathname === OAUTH_RESOURCE_METADATA_PATH;
      if (isMetadataPath) {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, METADATA_CORS_HEADERS);
          res.end();
          return;
        }
        if (req.method === 'GET') {
          serveResourceMetadata(res, config);
          return;
        }
        res.writeHead(405, METADATA_CORS_HEADERS).end('Method Not Allowed');
        return;
      }

      if (req.method === 'OPTIONS' && url.pathname === MCP_PATH) {
        handleOptions(res);
        return;
      }

      if (url.pathname !== MCP_PATH || !req.method || !MCP_METHODS.has(req.method)) {
        res.writeHead(404).end('Not Found');
        return;
      }

      // Auth0 gate (fails closed when AUTH0_ISSUER/AUTH0_AUDIENCE are set).
      const gate = await gateRequest(req, config);
      if (!gate.ok) {
        res.writeHead(401, {
          'content-type': 'application/json',
          'WWW-Authenticate': challengeFor(config),
        }).end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      // Identity propagation: the VERIFIED token (gate.token) is handed to the
      // per-request bridge, which forwards it to the backend as Authorization
      // so the Firebase API scopes the call to the caller's verified `sub`.
      const bearerToken = gate.token ?? undefined;

      // Optional static Bearer gate (defense in depth behind a tunnel).
      if (config.authToken) {
        const auth = req.headers.authorization ?? '';
        if (auth !== `Bearer ${config.authToken}`) {
          res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

      const server = createAppServer(bearerToken);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode — one server per request
        enableJsonResponse: true,
      });

      res.on('close', () => {
        transport.close();
        server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error('Unhandled request error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => {
      console.log(`FSRS flashcard MCP server listening on http://${config.host}:${config.port}${MCP_PATH}`);
      if (!config.apiKey) {
        console.warn('Warning: CUELINGUA_API_KEY is not set. Tools other than health will fail until it is set.');
      }
      if (config.transport === 'http' && !hasAuthMechanism(config)) {
        console.warn('Warning: /mcp is running WITHOUT authentication (Auth0 or MCP_AUTH_TOKEN). '
          + 'This is only safe on loopback/local backends or with an explicit MCP_AUTH_OPT_OUT '
          + 'for a local tunnel; a public deployment must configure AUTH0_ISSUER/AUTH0_AUDIENCE.');
      }
      resolve();
    });
  });
}

/* ------------------------------------------------------------------ */
/* Entry                                                               */
/* ------------------------------------------------------------------ */

if (config.transport === 'stdio') {
  await runStdio();
} else {
  await serveHttp();
}
