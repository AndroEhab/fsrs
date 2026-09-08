/**
 * Auth0-protected-resource handling for the MCP server's HTTP transport.
 *
 * When AUTH0_ISSUER (and AUTH0_AUDIENCE) are set, every request to /mcp is
 * gated on a valid RS256 JWT from the Auth0 tenant's JWKS (verified with
 * jose). Unauthorized requests receive an RFC 9728 WWW-Authenticate
 * `resource_metadata` challenge, and the protected-resource metadata document
 * is served at /.well-known/oauth-protected-resource/mcp (the root-level
 * path the ChatGPT MCP connector queries, with a /mcp fallback).
 *
 * The stdio transport and the bare `MCP_AUTH_TOKEN` gate are untouched:
 * stdio has no HTTP surface, and the static token remains available as an
 * optional defense-in-depth layer.
 *
 * No secrets (CUELINGUA_API_KEY, tokens) are ever logged or exposed here.
 */

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { auth0Configured, shouldEnforceAuth, type ServerConfig } from './config.js';

// Re-export for tests/back-compat (config.ts now owns the definition).
export { auth0Configured, shouldEnforceAuth } from './config.js';

export const OAUTH_RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';
export const OAUTH_RESOURCE_METADATA_MCP_PATH = '/.well-known/oauth-protected-resource/mcp';

/**
 * Absolute URL of the RFC 9728 protected-resource metadata document.
 * The document lives at the host root (/.well-known/oauth-protected-resource/mcp),
 * NOT beneath the /mcp resource path, so the origin of MCP_RESOURCE_URL is used.
 */
function metadataDocumentUrl(config: ServerConfig): string {
  try {
    return `${new URL(config.resourceUrl).origin}${OAUTH_RESOURCE_METADATA_MCP_PATH}`;
  } catch {
    // Malformed MCP_RESOURCE_URL: best-effort fallback keeps the challenge non-empty.
    return `${config.resourceUrl.replace(/\/+$/, '')}${OAUTH_RESOURCE_METADATA_MCP_PATH}`;
  }
}

/** RFC 9728 WWW-Authenticate challenge for unauthorized /mcp requests (absolute metadata URL). */
export function challengeFor(config: ServerConfig): string {
  return `Bearer resource_metadata="${metadataDocumentUrl(config)}"`;
}

/** Serves the RFC 9728 protected-resource metadata document. */
export function serveResourceMetadata(res: ServerResponse, config: ServerConfig): void {
  const body = {
    resource: config.resourceUrl,
    ...(auth0Configured(config) ? { authorization_servers: [config.auth0Issuer] } : {}),
    // RFC 9728 §3: the client sends the access token in the Authorization
    // header (the only method this server supports).
    bearer_methods_supported: ['header'],
    // `openid` + `email` are the scopes the ChatGPT connector is granted by
    // the tenant-side client configuration (the server itself validates only
    // iss/aud/signature/expiry and does not require a specific scope).
    scopes_supported: ['openid', 'email'],
  };
  res.writeHead(200, {
    'content-type': 'application/json',
    // The ChatGPT connector fetches this document cross-origin from
    // chatgpt.com — without CORS the browser blocks the read and the
    // connector cannot discover the authorization server.
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
}

/** CORS headers for the protected-resource metadata endpoints (GET + OPTIONS). */
export const METADATA_CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
};

/**
 * Per-issuer singleton cache for jose's remote JWKS resolver. Each call to
 * `createRemoteJWKSet` creates an independent key cache; sharing the same
 * resolver across requests avoids redundant `.well-known/jwks.json` fetches
 * and lets jose's internal TTL/rate-limit logic work correctly.
 */
const jwksResolvers = new Map<string, JWTVerifyGetKey>();

/**
 * Returns a cached remote JWKS resolver for the given issuer URL. The same
 * `JWTVerifyGetKey` instance is returned for identical normalized URLs, so
 * jose's built-in key caching and rotation logic is preserved.
 */
export function getJwks(issuer: string): JWTVerifyGetKey {
  const url = new URL(`${issuer.replace(/\/+$/, '')}/.well-known/jwks.json`).href;
  let resolver = jwksResolvers.get(url);
  if (!resolver) {
    resolver = createRemoteJWKSet(new URL(url));
    jwksResolvers.set(url, resolver);
  }
  return resolver;
}

/**
 * Clears the JWKS resolver cache. Exported for test isolation — each test
 * suite should call this in `afterEach` to prevent stale resolvers from
 * leaking across tests that use different issuer URLs.
 */
export function invalidateJwksCache(): void {
  jwksResolvers.clear();
}

/**
 * Returns the JWT payload when the header carries a valid Auth0 RS256 token,
 * else null. `jwks` is injectable for tests; it defaults to the Auth0 tenant's
 * remote JWKS (shared via the singleton cache).
 */
export async function verifyAuth0Token(
  authHeader: string | undefined,
  config: ServerConfig,
  jwks: JWTVerifyGetKey = getJwks(config.auth0Issuer),
): Promise<Record<string, unknown> | null> {
  if (!auth0Configured(config)) return null;

  const match = /^Bearer\s+(.+)$/i.exec(authHeader ?? '');
  if (!match) return null;

  try {
    const { payload } = await jwtVerify(match[1], jwks, {
      issuer: config.auth0Issuer,
      audience: config.auth0Audience,
      algorithms: ['RS256'],
    });
    return payload;
  } catch {
    return null;
  }
}

export interface GateResult {
  ok: boolean;
  payload: Record<string, unknown> | null;
  /**
   * The VERIFIED raw Bearer token string (without the "Bearer " prefix),
   * request-scoped. Non-null only when Auth0 is enforced and a valid token
   * was presented; the HTTP layer forwards it to the per-request backend
   * bridge so the identity reaches the Firebase API. Never stored globally.
   */
  token: string | null;
}

/** Fails closed when Auth0 is configured: returns false unless a valid token is presented. */
export async function gateRequest(req: IncomingMessage, config: ServerConfig, jwks?: JWTVerifyGetKey): Promise<GateResult> {
  if (!shouldEnforceAuth(config)) return { ok: true, payload: null, token: null };
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  const payload = await verifyAuth0Token(req.headers.authorization, config, jwks);
  if (payload === null) return { ok: false, payload: null, token: null };
  return { ok: true, payload, token: match ? match[1].trim() : null };
}
