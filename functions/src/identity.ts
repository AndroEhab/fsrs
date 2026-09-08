/**
 * Request identity for the multi-tenant Cloud Functions backend.
 *
 * Identity model (replaces the shared-key-only gate):
 *  - Every user document write carries `ownerId` = the caller's OWNER, and
 *    every user read/list/search/count/mutation is scoped to it.
 *  - In production-like runtimes (`FUNCTIONS_EMULATOR !== 'true'`) a request
 *    is ONLY authenticated when it presents BOTH a valid `X-API-Key`
 *    (the existing shared key — fail-closed gate) AND a valid Auth0 RS256
 *    Bearer JWT whose verified `sub` becomes the identity. A JWT alone is
 *    NOT sufficient: the API key remains the transport credential the MCP
 *    bridge and clients present, so the existing gate stays closed unless
 *    BOTH are verified. An API-key-only production request is rejected —
 *    it would otherwise read/write data with no owner.
 *  - In the emulator (`FUNCTIONS_EMULATOR=true`) requests may stay open, but
 *    the fixed owner `'emulator'` is assigned so emulator data is scoped,
 *    never global.
 *  - Identity headers are NEVER trusted: the identity comes exclusively from
 *    the verified JWT `sub` (or the fixed emulator owner). There is no
 *    `X-User-Id` / forwarded-identity path.
 *
 * Operators (migrations / maintenance routes) are recognized ONLY from the
 * verified JWT `sub` matching a documented env allowlist
 * (`AUTH0_OPERATOR_SUBS`, comma-separated exact subs). There is no
 * caller-supplied legacy actor id as authorization.
 *
 * Verification is implemented on node:crypto (RSASSA-PKCS1-v1_5 SHA-256)
 * with an injectable JWKS provider, so the module is unit-testable without
 * firebase-admin and without an ESM-only dependency (the functions package
 * is CommonJS).
 */
import { createPublicKey, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { isProductionRuntime } from './environment';

export type IdentityVia = 'auth0' | 'emulator';

export interface RequestIdentity {
  /** Stable owner id: the verified Auth0 JWT `sub` (production) or the fixed
   *  `'emulator'` owner (emulator/open local runs). All user documents are
   *  scoped/owned by this value. */
  ownerId: string;
  /** The verified subject (`sub`) of the presented JWT, or `'emulator'`. */
  subject: string;
  /** True when the verified subject is in the documented operator allowlist
   *  (AUTH0_OPERATOR_SUBS). Operator routes (migrations/backfills) check this
   *  before running. */
  isOperator: boolean;
  /** How the identity was established. */
  via: IdentityVia;
}

/** Fixed owner id used inside the emulator (dev data is scoped, not global). */
export const EMULATOR_OWNER = 'emulator';

/** Env var: Auth0 issuer URL (e.g. https://tenant.eu.auth0.com/). */
export const AUTH0_ISSUER_ENV = 'AUTH0_ISSUER';
/** Env var: Auth0 API audience the functions' tokens are minted for. */
export const AUTH0_AUDIENCE_ENV = 'AUTH0_AUDIENCE';
/** Env var: comma-separated exact `sub` values allowed to run operator routes. */
export const AUTH0_OPERATOR_SUBS_ENV = 'AUTH0_OPERATOR_SUBS';

/** Auth0 is configured when issuer + audience are both set. */
export function auth0Configured(issuer?: string, audience?: string): boolean {
  return !!(issuer && issuer.trim() !== '' && audience && audience.trim() !== '');
}

/** Comma-separated operator subs -> trimmed Set (empty env -> empty set). */
export function operatorSubs(value: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (value ?? '').split(',')) {
    const trimmed = part.trim();
    if (trimmed !== '') out.add(trimmed);
  }
  return out;
}

/** Reads the operator allowlist from the runtime env. */
export function operatorSubsFromEnv(): Set<string> {
  return operatorSubs(process.env[AUTH0_OPERATOR_SUBS_ENV]);
}

/**
 * Error carrying a client-visible 401 message with a specific reason
 * (missing API key / missing JWT / invalid JWT / unconfigured Auth0).
 */
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

/* ------------------------------------------------------------------ */
/* RS256 / JWKS verification (node:crypto, no ESM-only dependency)     */
/* ------------------------------------------------------------------ */

/** The RSA public JWK fields this module needs (the functions tsconfig has
 *  no DOM lib, so the standard `JsonWebKey` global is unavailable). */
export interface RsaPublicJwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  /** RSA modulus (base64url). */
  n: string;
  /** RSA public exponent (base64url). */
  e: string;
}

/** A signing key provider: resolves a JWT `kid` to its public JWK. */
export interface JwksProvider {
  getKey(kid: string): Promise<RsaPublicJwk | null>;
}

/** JWKS cache TTL: re-fetch a rotated issuer's keys at most every 10 min. */
const JWKS_TTL_MS = 10 * 60 * 1000;

/**
 * Bounded cooldown after fetching for an unknown kid. Prevents repeated
 * fetches when the same bogus kid circulates, while still allowing a
 * single re-check after the cooldown expires (legitimate key rotation).
 */
export const UNKNOWN_KID_COOLDOWN_MS = 30_000;

/** Per-fetch timeout for the JWKS endpoint. */
export const FETCH_TIMEOUT_MS = 10_000;

interface JwksCacheEntry {
  keys: Map<string, RsaPublicJwk>;
  fetchedAtMs: number;
  /** Timestamp of the last fetch triggered by an unknown kid. */
  lastUnknownLookupMs: number;
  /** In-flight fetch promise (shared by concurrent getKey calls). */
  pendingFetch: Promise<Map<string, RsaPublicJwk>> | null;
}

const jwksCache = new Map<string, JwksCacheEntry>();

/** Test-only: clear the global JWKS cache for test isolation. */
export function _resetJwksCacheForTesting(): void {
  jwksCache.clear();
}

const defaultFetchJson = async (url: string, opts?: { signal?: AbortSignal }): Promise<{ keys?: unknown }> => {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: opts?.signal });
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
  return res.json() as Promise<{ keys?: unknown }>;
};

/**
 * Builds a JWKS provider from an issuer's `/.well-known/jwks.json` endpoint.
 * Keys are cached with a TTL and refreshed on a cache-missing `kid`.
 * Features:
 *  - **coalescing**: concurrent getKey calls for the same issuer share a
 *    single in-flight fetch, avoiding redundant network requests.
 *  - **unknown-kid cooldown**: after a fetch triggered by an unknown kid,
 *    further unknown-kid refreshes are suppressed for
 *    `UNKNOWN_KID_COOLDOWN_MS`, preventing repeated fetches for bogus kids
 *    while still allowing a single re-check after cooldown (legitimate
 *    key-rotation).
 *  - **fetch timeout**: each JWKS fetch uses `FETCH_TIMEOUT_MS` via
 *    `AbortSignal.timeout` to prevent hanging requests.
 *  - **fail-closed**: on fetch failure or timeout, `getKey` returns `null`.
 *
 * `fetcher` is injectable for tests.
 */
export function createRemoteJwks(
  issuer: string,
  fetcher: (url: string, opts?: { signal?: AbortSignal }) => Promise<{ keys?: unknown }> = defaultFetchJson,
): JwksProvider {
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/jwks.json`;

  return {
    async getKey(kid: string): Promise<RsaPublicJwk | null> {
      const now = Date.now();
      const cached = jwksCache.get(url);

      // TTL hit: serve known keys directly (no fetch needed).
      if (cached && now - cached.fetchedAtMs < JWKS_TTL_MS) {
        const hit = cached.keys.get(kid);
        if (hit) return hit;
      }

      // Unknown kid within cooldown window: don't re-fetch.
      if (
        cached
        && !cached.keys.has(kid)
        && now - cached.lastUnknownLookupMs < UNKNOWN_KID_COOLDOWN_MS
      ) {
        return null;
      }

      // Coalesce concurrent refresh requests via a shared in-flight Promise.
      if (cached?.pendingFetch) {
        const keys = await cached.pendingFetch;
        if (!keys.has(kid)) {
          cached.lastUnknownLookupMs = Date.now();
        }
        return keys.get(kid) ?? null;
      }

      // Fire a single fetch for this URL (with timeout). The fetch promise
      // updates `entry.keys` before resolving so coalesced callers see the
      // fresh data via `entry.keys.get(kid)`.
      const entry = cached ?? (() => {
        const e: JwksCacheEntry = {
          keys: new Map(),
          fetchedAtMs: 0,
          lastUnknownLookupMs: -Infinity,
          pendingFetch: null,
        };
        jwksCache.set(url, e);
        return e;
      })();

      const fetchPromise = (async () => {
        try {
          const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
          const body = await fetcher(url, { signal });
          const keys = new Map<string, RsaPublicJwk>();
          if (body && Array.isArray(body.keys)) {
            for (const k of body.keys as Array<Record<string, unknown>>) {
              if (typeof k?.kid === 'string' && typeof k?.n === 'string' && typeof k?.e === 'string') {
                keys.set(k.kid, k as unknown as RsaPublicJwk);
              }
            }
          }
          // Update shared state BEFORE resolving so coalesced callers see it.
          entry.keys = keys;
          entry.fetchedAtMs = Date.now();
          entry.pendingFetch = null;
          return keys;
        } catch {
          // Fail closed: treat fetch failure/timeout as empty keyset.
          entry.keys = new Map();
          entry.fetchedAtMs = Date.now();
          entry.pendingFetch = null;
          return new Map<string, RsaPublicJwk>();
        }
      })();

      entry.pendingFetch = fetchPromise;
      await fetchPromise;
      // Only start cooldown when the requested kid is missing or the fetch
      // failed. A successful hit must NOT suppress the next unknown-kid
      // refresh (legitimate rotation arriving immediately after).
      if (!entry.keys.has(kid)) {
        entry.lastUnknownLookupMs = Date.now();
      }
      return entry.keys.get(kid) ?? null;
    },
  };
}

/**
 * A local (non-network) JWKS provider over explicit keys — used by unit
 * tests that generate their own RSA key pair.
 */
export function createLocalJwks(keys: Array<{ kid: string } & RsaPublicJwk>): JwksProvider {
  const map = new Map<string, RsaPublicJwk>();
  for (const k of keys) map.set(k.kid, k);
  return { getKey: async (kid) => map.get(kid) ?? null };
}

/** Decodes a base64url JWT segment into a Buffer. */
function b64urlDecode(segment: string): Buffer {
  return Buffer.from(segment, 'base64url');
}

/** Parses a compact JWT into its three segments without verifying anything. */
function splitJwt(token: string): { headerB64: string; payloadB64: string; signatureB64: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  if (headerB64 === '' || payloadB64 === '' || signatureB64 === '') return null;
  return { headerB64, payloadB64, signatureB64 };
}

/** Verifies an RS256 signature over `data` with a public JWK. */
function verifyRs256(jwk: RsaPublicJwk, data: Buffer, signature: Buffer): boolean {
  try {
    // node:crypto accepts the runtime JWK object; the cast bridges the DOM
    // `JsonWebKey` typing that createPublicKey's signature expects (the
    // functions tsconfig has no DOM lib, but the fields are structurally
    // identical for RSA public keys).
    const publicKey = createPublicKey({ key: jwk as unknown as { kty: string; n: string; e: string }, format: 'jwk' });
    return cryptoVerify('sha256', data, publicKey, signature);
  } catch {
    return false;
  }
}

/**
 * Default JWKS provider for an issuer (remote fetch + cache). Injectable in
 * tests via the options.
 */
export function defaultJwks(issuer: string): JwksProvider {
  return createRemoteJwks(issuer);
}

/** Syntactic check that a JWT header requests RS256 (rejected otherwise). */
function headerIsRs256(header: Record<string, unknown>): boolean {
  return header?.alg === 'RS256';
}

export interface VerifyOptions {
  /** Env-provided Auth0 issuer; unset disables JWT verification. */
  issuer?: string;
  /** Env-provided Auth0 audience. */
  audience?: string;
  /** Operator allowlist (exact subs). Defaults to AUTH0_OPERATOR_SUBS env. */
  operatorSubs?: Set<string>;
  /** Injectable JWKS provider (tests pass a local set). */
  jwks?: JwksProvider;
  /** Is the current runtime production-like? Defaults to the emulator check. */
  isProduction?: boolean;
  /** Injectable clock (ms since epoch) for exp/iat/nbf checks; defaults to Date.now(). */
  nowMs?: () => number;
}

/**
 * Verifies a Bearer Auth0 JWT and resolves the request identity.
 *
 * Returns `{ identity, error? }`: when the runtime is the emulator,
 * `identity` is the fixed emulator owner (open local behavior preserved) with
 * `error` undefined. In a production-like runtime the API key must already
 * have been verified by the caller (the existing X-API-Key gate) and a valid
 * Auth0 JWT must be presented; otherwise the result carries an
 * AuthenticationError with a clear message.
 */
export async function verifyRequest(
  bearerHeader: string | undefined,
  options: VerifyOptions = {},
): Promise<{ identity: RequestIdentity | null; error: AuthenticationError | null }> {
  const production = options.isProduction ?? isProductionRuntime();
  const issuer = options.issuer ?? process.env[AUTH0_ISSUER_ENV];
  const audience = options.audience ?? process.env[AUTH0_AUDIENCE_ENV];
  const subs = options.operatorSubs ?? operatorSubsFromEnv();
  const nowMs = options.nowMs ?? (() => Date.now());

  if (!production) {
    return {
      identity: {
        ownerId: EMULATOR_OWNER,
        subject: EMULATOR_OWNER,
        isOperator: false,
        via: 'emulator',
      },
      error: null,
    };
  }

  if (!auth0Configured(issuer, audience)) {
    return {
      identity: null,
      error: new AuthenticationError(
        'Authentication is not configured: set AUTH0_ISSUER and AUTH0_AUDIENCE on the deployed runtime',
      ),
    };
  }

  const match = /^Bearer\s+(.+)$/i.exec(bearerHeader ?? '');
  if (!match) {
    return {
      identity: null,
      error: new AuthenticationError('Missing or invalid Authorization header: expected "Bearer <Auth0 JWT>"'),
    };
  }
  const token = match[1].trim();
  const segments = splitJwt(token);
  if (!segments) {
    return {
      identity: null,
      error: new AuthenticationError('Malformed Auth0 token: expected a compact JWT'),
    };
  }

  // Header: alg must be RS256.
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(b64urlDecode(segments.headerB64).toString('utf8')) as Record<string, unknown>;
  } catch {
    return { identity: null, error: new AuthenticationError('Malformed Auth0 token header') };
  }
  if (!headerIsRs256(header)) {
    return { identity: null, error: new AuthenticationError('Auth0 token must use the RS256 algorithm') };
  }
  const kid = typeof header.kid === 'string' && header.kid !== '' ? header.kid : null;

  // Resolve the signing key and verify the signature FIRST (the payload is
  // untrusted until the signature checks out).
  const provider = options.jwks ?? defaultJwks(issuer as string);
  const jwk = kid !== null ? await provider.getKey(kid) : null;
  if (!jwk) {
    return { identity: null, error: new AuthenticationError('No signing key found for the presented Auth0 token') };
  }

  const signingInput = Buffer.from(`${segments.headerB64}.${segments.payloadB64}`, 'utf8');
  const signature = b64urlDecode(segments.signatureB64);
  const ok = verifyRs256(jwk, signingInput, signature);
  if (!ok) {
    return { identity: null, error: new AuthenticationError('Invalid or expired Auth0 token') };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(b64urlDecode(segments.payloadB64).toString('utf8')) as Record<string, unknown>;
  } catch {
    return { identity: null, error: new AuthenticationError('Malformed Auth0 token payload') };
  }

  // Claim checks over the VERIFIED payload.
  const nowSec = Math.floor(nowMs() / 1000);
  if (typeof payload.iss === 'string') {
    // Auth0 issuers conventionally carry a trailing slash; compare both the
    // exact value and the trailing-slash-normalized form.
    const norm = (s: string): string => s.replace(/\/+$/, '');
    if (norm(payload.iss) !== norm(issuer as string)) {
      return { identity: null, error: new AuthenticationError('Auth0 token issuer mismatch') };
    }
  } else {
    return { identity: null, error: new AuthenticationError('Auth0 token has no issuer (iss) claim') };
  }
  const aud = payload.aud;
  const audienceMatches = typeof aud === 'string'
    ? aud === audience
    : Array.isArray(aud) && aud.some((a) => a === audience);
  if (!audienceMatches) {
    return { identity: null, error: new AuthenticationError('Auth0 token audience mismatch') };
  }
  if (typeof payload.exp !== 'number' || nowSec >= payload.exp) {
    return { identity: null, error: new AuthenticationError('Auth0 token is expired or has no exp claim') };
  }
  if (typeof payload.iat === 'number' && payload.iat > nowSec + 60) {
    return { identity: null, error: new AuthenticationError('Auth0 token issued in the future') };
  }
  if (typeof payload.nbf === 'number' && payload.nbf > nowSec + 60) {
    return { identity: null, error: new AuthenticationError('Auth0 token is not yet valid (nbf)') };
  }

  const subject = typeof payload.sub === 'string' && payload.sub !== '' ? payload.sub : null;
  if (subject === null) {
    return {
      identity: null,
      error: new AuthenticationError('Auth0 token has no subject (sub) claim'),
    };
  }

  return {
    identity: {
      ownerId: subject,
      subject,
      isOperator: subs.has(subject),
      via: 'auth0',
    },
    error: null,
  };
}

/**
 * Test-only key factory: generates a fresh RSA key pair and returns its
 * public JWK (with a kid), the PEM private key, and a `sign(payload)` helper
 * that mints a compact RS256 JWT with the given payload. Lives in the module
 * (not in test files) so unit tests across suites share one correct RS256
 * implementation instead of duplicating crypto code.
 */
export function testKeyPair(kid: string): {
  publicJwk: RsaPublicJwk & { kid: string };
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  sign: (payload: Record<string, unknown>) => string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = { kid, ...publicKey.export({ format: 'jwk' }) } as RsaPublicJwk & { kid: string };
  const sign = (payload: Record<string, unknown>): string => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = cryptoSign('sha256', Buffer.from(`${header}.${body}`, 'utf8'), privateKey).toString('base64url');
    return `${header}.${body}.${sig}`;
  };
  return { publicJwk, privateKey, sign };
}
