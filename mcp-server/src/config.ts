/**
 * Environment configuration for the FSRS MCP server.
 *
 * Secrets are read exclusively from the environment: CUELINGUA_API_KEY is the
 * API key for the deployed Firebase backend (sent as the `X-API-Key` header).
 * The key is never logged, printed, or written to any file.
 *
 * Auth0 (optional but REQUIRED for a deployed HTTP server): when
 * AUTH0_ISSUER and AUTH0_AUDIENCE are both set, the HTTP /mcp endpoint
 * requires a valid RS256 access token from that issuer (see src/auth.ts).
 *
 * Deploy-mode hardening (fail-closed): an HTTP server refuses to start
 * without at least one authentication mechanism configured (Auth0 or
 * `MCP_AUTH_TOKEN`) when either its API base URL is a REMOTE origin or its
 * listener is bound to a non-loopback interface. The local-backend exception
 * (no auth) requires BOTH a local backend AND a loopback listener — binding
 * to 0.0.0.0 (the default) exposes the endpoint to the network and thus
 * requires auth regardless of the backend address. stdio and explicit
 * loopback-bound local development keep working with no auth.
 * `MCP_AUTH_OPT_OUT` (=true) is the explicit override for tunnels that
 * expose a local server via a non-loopback address.
 */

import { isIP } from 'node:net';

export interface ServerConfig {
  /** API key for the deployed Firebase backend (X-API-Key header). */
  apiKey: string;
  /** Base URL of the Firebase Functions deployment. */
  apiBaseUrl: string;
  /** HTTP listen port (MCP_PORT ?? PORT ?? 8787). */
  port: number;
  /** HTTP listen host. */
  host: string;
  /** Transport: "http" (Streamable HTTP at /mcp) or "stdio". */
  transport: 'http' | 'stdio';
  /** Optional static Bearer token gate for the /mcp endpoint. */
  authToken: string;
  /** Fetch timeout against the Firebase backend, in ms. */
  requestTimeoutMs: number;
  /** Auth0 issuer (tenant URL). Empty disables Auth0 enforcement. */
  auth0Issuer: string;
  /** Expected audience (the MCP resource's URI). Empty disables Auth0 enforcement. */
  auth0Audience: string;
  /** Public URL of this MCP resource (the /mcp endpoint), used in RFC 9728 metadata. */
  resourceUrl: string;
  /** REVIEW_TEST_MODE mirror (env). When true, review sessions queue ALL
   *  cards and submit_review skips card FSRS writes — for widget testing. */
  reviewTestMode: boolean;
  /** True when the HTTP server may run with NO auth against a remote
   *  backend. Explicit local override (MCP_AUTH_OPT_OUT=true) - see header. */
  authOptOut: boolean;
}

const DEFAULTS = {
  apiBaseUrl: 'https://us-central1-cuelingua.cloudfunctions.net',
  port: 8787,
  host: '0.0.0.0',
  transport: 'http' as const,
  requestTimeoutMs: 15000,
  resourceUrl: 'https://cuelingua-mcp-767542644824.us-central1.run.app/mcp',
};

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0 || n > 65535) return fallback;
  return n;
}

/**
 * True when the address is a loopback — reachable only from the local machine.
 * Covers 127.0.0.0/8 (full IPv4 loopback range, RFC 5735 §2), localhost,
 * and ::1.  Unrecognised or syntactically invalid addresses (e.g.
 * "127.invalid") are NOT treated as loopback — this predicate fails closed.
 */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().trim();
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true;
  // Validated IPv4 loopback: must parse as a real IPv4 address (not
  // "127.invalid" or other DNS-style strings) before checking the 127/8
  // range (RFC 5735 §2).  Fail closed on unrecognised formats.
  const stripped = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  if (isIP(stripped) === 4) return stripped.startsWith('127.');
  return false;
}

/**
 * True when the configured server needs an authentication mechanism: it is
 * an HTTP transport AND either its backend base URL is a REMOTE origin, or
 * the listener is bound to a non-loopback interface (exposed to the network).
 * The local-backend exception (no auth) only applies when BOTH the backend
 * is local AND the listener is loopback. stdio never requires auth.
 */
export function needsRemoteAuth(config: ServerConfig): boolean {
  if (config.transport !== 'http') return false;
  try {
    const rawHost = new URL(config.apiBaseUrl).hostname.toLowerCase();
    const backendHost = rawHost.startsWith('[') ? rawHost.slice(1, -1) : rawHost;
    if (isLoopbackHost(backendHost) && isLoopbackHost(config.host)) return false;
  } catch {
    // Unparseable base URL: treat as remote (defense in depth).
  }
  return true;
}

/** True when an authentication mechanism is actually configured. */
export function hasAuthMechanism(config: ServerConfig): boolean {
  return (
    (config.auth0Issuer.length > 0 && config.auth0Audience.length > 0)
    || config.authToken.length > 0
  );
}

/**
 * The deploy-time guard: fails (refuses to serve) when the HTTP server would
 * be exposed without any authentication. Returns an error message, or null
 * when the configuration is safe.
 */
export function authGuardError(config: ServerConfig): string | null {
  if (!needsRemoteAuth(config) || hasAuthMechanism(config) || config.authOptOut) {
    return null;
  }
  // State the actual reason: remote backend, or non-loopback listener with
  // a local backend.
  let exposure: string;
  try {
    const rawHost = new URL(config.apiBaseUrl).hostname.toLowerCase();
    const backendHost = rawHost.startsWith('[') ? rawHost.slice(1, -1) : rawHost;
    exposure = isLoopbackHost(backendHost)
      ? `listener (${config.host}) is not loopback`
      : `targets a remote backend (${config.apiBaseUrl})`;
  } catch {
    exposure = `has an unparseable backend URL (${config.apiBaseUrl})`;
  }
  return 'Refusing to serve: the HTTP /mcp endpoint ' + exposure
    + ' but no authentication is configured. Set AUTH0_ISSUER '
    + 'and AUTH0_AUDIENCE (recommended), set MCP_AUTH_TOKEN (static bearer), or set '
    + 'MCP_AUTH_OPT_OUT=true to run without auth (local tunnels only — '
    + 'never for a public deployment).';
}

/** True when Auth0 (issuer + audience) is fully configured and enforced. */
export function auth0Configured(config: ServerConfig): boolean {
  return config.auth0Issuer.length > 0 && config.auth0Audience.length > 0;
}

/**
 * The enforcement decision for the /mcp request gate: enforce when Auth0 is
 * configured (fails closed); otherwise rely on the static bearer gate, which
 * is enforced separately when MCP_AUTH_TOKEN is set. With neither configured
 * the request is open - allowed only for loopback/local operation (or an
 * explicit MCP_AUTH_OPT_OUT).
 */
export function shouldEnforceAuth(config: ServerConfig): boolean {
  return config.transport === 'http' && auth0Configured(config);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const transport = env.MCP_TRANSPORT === 'stdio' ? 'stdio' : 'http';
  const port = parsePort(env.MCP_PORT, parsePort(env.PORT, DEFAULTS.port));

  return {
    apiKey: env.CUELINGUA_API_KEY ?? '',
    apiBaseUrl: (env.FSRS_API_BASE_URL || DEFAULTS.apiBaseUrl).replace(/\/+$/, ''),
    port,
    host: env.MCP_HOST || DEFAULTS.host,
    transport,
    authToken: env.MCP_AUTH_TOKEN ?? '',
    requestTimeoutMs: parsePort(env.FSRS_REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs),
    auth0Issuer: env.AUTH0_ISSUER ?? '',
    auth0Audience: env.AUTH0_AUDIENCE ?? '',
    resourceUrl: (env.MCP_RESOURCE_URL || DEFAULTS.resourceUrl).replace(/\/+$/, ''),
    reviewTestMode: env.REVIEW_TEST_MODE === 'true',
    authOptOut: env.MCP_AUTH_OPT_OUT === 'true',
  };
}
