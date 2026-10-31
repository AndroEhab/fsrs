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
import { isIP } from 'node:net';
import { createServer } from 'node:http';
import { FirebaseBridge, MCP_HTTP_MAX_REQUEST_BODY_SIZE } from './bridge.js';
import { auth0Configured, authConfigurationError, authGuardError, backendIdentityError, hasAuthMechanism, loadConfig } from './config.js';
import { registerFlashcardTools } from './tools.js';
import { registerReviewWidget } from './widget.js';
import { OAUTH_RESOURCE_METADATA_MCP_PATH, OAUTH_RESOURCE_METADATA_PATH, METADATA_CORS_HEADERS, challengeFor, gateRequest, serveResourceMetadata } from './auth.js';
const config = loadConfig();
const configuredHosts = (process.env.MCP_ALLOWED_HOSTS ?? '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
const authConfigError = authConfigurationError(config) ?? backendIdentityError(config);
if (authConfigError) throw new Error(authConfigError);
const auth0Enabled = auth0Configured(config);
const allowedOrigins = new Set([
  'https://chatgpt.com',
  'https://chat.openai.com',
  ...((process.env.MCP_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean)),
]);
const loopbackHost = config.host.toLowerCase().replace(/^\[|\]$/g, '');
const isLoopbackListener = loopbackHost === 'localhost' || loopbackHost === '::1'
  || (isIP(loopbackHost) === 4 && loopbackHost.startsWith('127.'));
const expectedHost = `${loopbackHost.includes(':') ? `[${loopbackHost}]` : loopbackHost}:${config.port}`;
const resourceHost = (() => {
  try {
    return new URL(config.resourceUrl).host.toLowerCase();
  } catch {
    return expectedHost;
  }
})();
// Public resource authority plus explicitly configured additions and exact
// loopback authorities for local browser/desktop clients. No suffix/wildcard
// matching: arbitrary DNS names remain rejected to prevent rebinding.
const permittedHosts = new Set([
  resourceHost,
  `localhost:${config.port}`,
  `127.0.0.1:${config.port}`,
  `[::1]:${config.port}`,
  ...(isLoopbackListener ? [expectedHost] : []),
  ...configuredHosts,
]);

function createAppServer(bearerToken?: string): McpServer {
  const bridge = new FirebaseBridge({
    apiKey: config.apiKey,
    baseUrl: config.apiBaseUrl,
    timeoutMs: config.requestTimeoutMs,
    // Per-request Auth0 always wins; process identity is used only for trusted
    // stdio or static single-user mode.
    bearerToken: bearerToken ?? (!auth0Enabled ? config.backendAuthToken || undefined : undefined),
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
        const origin = req.headers.origin;
        if (!req.headers.host || !permittedHosts.has(req.headers.host.toLowerCase())) {
          res.writeHead(403).end('Forbidden');
          return;
        }
        if (origin && !allowedOrigins.has(origin)) {
          res.writeHead(403).end('Forbidden');
          return;
        }
        if (origin) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
        } else {
          res.setHeader('Access-Control-Allow-Origin', '*');
        }
        res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            ...METADATA_CORS_HEADERS,
            'access-control-allow-origin': origin ?? '*',
            'access-control-expose-headers': 'WWW-Authenticate, Mcp-Session-Id',
            ...(origin ? { Vary: 'Origin' } : {}),
          });
          res.end();
          return;
        }
        if (req.method === 'GET') {
          serveResourceMetadata(res, config, origin);
          return;
        }
        res.writeHead(405, {
          ...METADATA_CORS_HEADERS,
          'access-control-allow-origin': origin ?? '*',
          'access-control-expose-headers': 'WWW-Authenticate, Mcp-Session-Id',
          ...(origin ? { Vary: 'Origin' } : {}),
        }).end('Method Not Allowed');
        return;
      }
      if (req.method === 'OPTIONS' && url.pathname === MCP_PATH) {
        if (!req.headers.host || !permittedHosts.has(req.headers.host.toLowerCase())) {
          res.writeHead(403).end('Forbidden');
          return;
        }
        const origin = req.headers.origin;
        if (origin && !allowedOrigins.has(origin)) {
          res.writeHead(403).end('Forbidden');
          return;
        }
        res.writeHead(204, {
          'Access-Control-Allow-Origin': origin ?? '*',
          'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type, mcp-session-id, authorization, mcp-protocol-version, last-event-id',
          'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
          ...(origin ? { Vary: 'Origin' } : {}),
        });
        res.end();
        return;
      }

      if (url.pathname !== MCP_PATH || !req.method || !MCP_METHODS.has(req.method)) {
        res.writeHead(404).end('Not Found');
        return;
      }

      if (!req.headers.host || !permittedHosts.has(req.headers.host.toLowerCase())) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const auth = req.headers.authorization ?? '';
      const match = /^Bearer\s+(.+)$/i.exec(auth);
      const presented = match?.[1].trim();
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
      }
      res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');

      const gate = await gateRequest(req, config);
      const staticAuthorized = Boolean(config.authToken) && presented === config.authToken;
      if ((auth0Enabled && !gate.ok) || (config.authToken && !staticAuthorized)) {
        res.writeHead(401, {
          'content-type': 'application/json',
          ...(auth0Enabled ? { 'www-authenticate': challengeFor(config) } : {}),
        }).end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      // Only a verified Auth0 token is forwarded as request-scoped identity.
      const bearerToken = auth0Enabled ? gate.token ?? undefined : undefined;

      const server = createAppServer(bearerToken);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode — one server per request
        maxRequestBodySize: MCP_HTTP_MAX_REQUEST_BODY_SIZE,
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
