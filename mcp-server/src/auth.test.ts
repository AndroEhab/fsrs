import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type GenerateKeyPairResult } from 'jose';
import type { ServerResponse } from 'node:http';
import { ServerConfig } from './config';
import { OAUTH_RESOURCE_METADATA_MCP_PATH, OAUTH_RESOURCE_METADATA_PATH, challengeFor, gateRequest, getJwks, invalidateJwksCache, serveResourceMetadata, shouldEnforceAuth, verifyAuth0Token } from './auth';

type KeyPair = GenerateKeyPairResult;

const ISSUER = 'https://andrewehab.eu.auth0.com/';
const AUDIENCE = 'https://cuelingua-mcp-767542644824.us-central1.run.app/mcp';
const RESOURCE_URL = 'https://cuelingua-mcp-767542644824.us-central1.run.app/mcp';

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    apiKey: 'test-key',
    apiBaseUrl: 'https://test.invalid',
    port: 8787,
    host: '127.0.0.1',
    transport: 'http',
    authToken: '',
    requestTimeoutMs: 15000,
    auth0Issuer: ISSUER,
    auth0Audience: AUDIENCE,
    resourceUrl: RESOURCE_URL,
    reviewTestMode: false,
    authOptOut: false,
    ...overrides,
  };
}

afterEach(() => invalidateJwksCache());

/* ------------------------------------------------------------------ */
/* Config / enforcement                                                */
/* ------------------------------------------------------------------ */

describe('shouldEnforceAuth', () => {
  it('enforces on http transport when issuer and audience are set', () => {
    expect(shouldEnforceAuth(config())).toBe(true);
  });

  it('does not enforce when Auth0 config is missing (local/dev remains usable)', () => {
    expect(shouldEnforceAuth(config({ auth0Issuer: '', auth0Audience: '' }))).toBe(false);
    expect(shouldEnforceAuth(config({ auth0Issuer: '', auth0Audience: AUDIENCE }))).toBe(false);
    expect(shouldEnforceAuth(config({ auth0Issuer: ISSUER, auth0Audience: '' }))).toBe(false);
  });

  it('never enforces on stdio (local no-auth transport stays usable)', () => {
    expect(shouldEnforceAuth(config({ transport: 'stdio' }))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* verifyAuth0Token                                                    */
/* ------------------------------------------------------------------ */

describe('verifyAuth0Token', () => {
  let keyPair: KeyPair;
  let jwks: ReturnType<typeof createLocalJWKSet>;

  beforeAll(async () => {
    keyPair = await generateKeyPair('RS256');
    const jwk = { kid: 'test-kid', alg: 'RS256', ...(await exportJWK(keyPair.publicKey)) };
    jwks = createLocalJWKSet({ keys: [jwk] });
  });

  async function sign(): Promise<string> {
    return new SignJWT({ scope: 'mcp' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(keyPair.privateKey);
  }

  it('returns the payload for a valid RS256 token from the configured issuer/audience', async () => {
    const payload = await verifyAuth0Token(`Bearer ${await sign()}`, config(), jwks);
    expect(payload).not.toBeNull();
    expect(payload?.iss).toBe(ISSUER);
    expect(payload?.aud).toBe(AUDIENCE);
  });

  it('returns null without a Bearer header', async () => {
    expect(await verifyAuth0Token(undefined, config(), jwks)).toBeNull();
    expect(await verifyAuth0Token('Basic abc', config(), jwks)).toBeNull();
  });

  it('returns null when the audience does not match', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer(ISSUER)
      .setAudience('https://some-other-resource.example')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(keyPair.privateKey);
    expect(await verifyAuth0Token(`Bearer ${token}`, config(), jwks)).toBeNull();
  });

  it('returns null for a token signed by an unknown key', async () => {
    const other = await generateKeyPair('RS256');
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'unknown-kid' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(other.privateKey);
    expect(await verifyAuth0Token(`Bearer ${token}`, config(), jwks)).toBeNull();
  });

  it('returns null when Auth0 is not configured (no verification attempted)', async () => {
    expect(await verifyAuth0Token(`Bearer ${await sign()}`, config({ auth0Issuer: '', auth0Audience: '' }), jwks)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* getJwks — resolver caching                                         */
/* ------------------------------------------------------------------ */

describe('getJwks', () => {
  it('returns the same resolver instance for the same issuer (shared caching)', () => {
    const a = getJwks(ISSUER);
    const b = getJwks(ISSUER);
    expect(a).toBe(b);
  });

  it('returns different resolvers for different issuers', () => {
    const a = getJwks(ISSUER);
    const b = getJwks('https://other-issuer.example/');
    expect(a).not.toBe(b);
  });

  it('invalidateJwksCache clears the cache so the next call creates a fresh resolver', () => {
    const before = getJwks(ISSUER);
    invalidateJwksCache();
    const after = getJwks(ISSUER);
    expect(after).not.toBe(before);
  });
});

/* ------------------------------------------------------------------ */
/* gateRequest (fails closed)                                          */
/* ------------------------------------------------------------------ */

describe('gateRequest', () => {
  let keyPair: KeyPair;
  let jwks: ReturnType<typeof createLocalJWKSet>;

  beforeAll(async () => {
    keyPair = await generateKeyPair('RS256');
    const jwk = { kid: 'test-kid', alg: 'RS256', ...(await exportJWK(keyPair.publicKey)) };
    jwks = createLocalJWKSet({ keys: [jwk] });
  });

  it('lets a valid token through with its payload and the verified raw token', async () => {
    const token = await new SignJWT({ scope: 'mcp' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(keyPair.privateKey);
    const result = await gateRequest({ headers: { authorization: `Bearer ${token}` } } as never, config(), jwks);
    expect(result.ok).toBe(true);
    expect(result.payload?.scope).toBe('mcp');
    // The verified raw token is exposed for request-scoped identity
    // propagation to the backend (never for storage/logging).
    expect(result.token).toBe(token);
  });

  it('fails closed on a missing token when Auth0 is configured', async () => {
    const result = await gateRequest({ headers: {} } as never, config(), jwks);
    expect(result.ok).toBe(false);
    expect(result.payload).toBeNull();
    expect(result.token).toBeNull();
  });

  it('fails closed on a garbage token when Auth0 is configured', async () => {
    const result = await gateRequest({ headers: { authorization: 'Bearer not-a-jwt' } } as never, config(), jwks);
    expect(result.ok).toBe(false);
  });

  it('passes through (open) when Auth0 is not configured', async () => {
    const result = await gateRequest({ headers: {} } as never, config({ auth0Issuer: '', auth0Audience: '' }));
    expect(result.ok).toBe(true);
    expect(result.payload).toBeNull();
    expect(result.token).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Protected-resource metadata + challenge                             */
/* ------------------------------------------------------------------ */
describe('protected resource metadata', () => {
  function capture() {
    const state = { body: '', status: 0, headers: {} as Record<string, string | number | string[]> };
    const res = {
      writeHead(status: number, headers: Record<string, string | number | string[]>): typeof res {
        state.status = status;
        state.headers = headers;
        return res;
      },
      end(body?: string): typeof res {
        state.body = body ?? '';
        return res;
      },
    } as unknown as ServerResponse;
    return { res, get state() { return state; } };
  }

  it('serves the RFC 9728 document with the resource URL and the Auth0 authorization server', () => {
    const { res, state } = capture();
    serveResourceMetadata(res, config());
    expect(state.status).toBe(200);
    expect(state.headers['content-type']).toBe('application/json');
    const doc = JSON.parse(state.body);
    expect(doc.resource).toBe(RESOURCE_URL);
    expect(doc.authorization_servers).toEqual([ISSUER]);
  });

  it('omits OAuth authorization servers when Auth0 is disabled for local HTTP', () => {
    const { res, state } = capture();
    serveResourceMetadata(res, config({ auth0Issuer: '', auth0Audience: '' }));
    const doc = JSON.parse(state.body);
    expect(doc.authorization_servers).toBeUndefined();
  });

  it('advertises bearer_methods_supported and scopes_supported for the Apps SDK connector', () => {
    const { res, state } = capture();
    serveResourceMetadata(res, config());
    const doc = JSON.parse(state.body);
    // RFC 9728: the connector must know how to present the token (header only)
    // and which scopes to request (openid/email, per the tenant client config).
    expect(doc.bearer_methods_supported).toEqual(['header']);
    expect(doc.scopes_supported).toEqual(['openid', 'email']);
  });

  it('serves the metadata with CORS so chatgpt.com can read it cross-origin', () => {
    const { res, state } = capture();
    serveResourceMetadata(res, config());
    expect(state.headers['access-control-allow-origin']).toBe('*');
  });

  it('exposes the two metadata paths used by the connector and an absolute challenge', () => {
    expect(OAUTH_RESOURCE_METADATA_PATH).toBe('/.well-known/oauth-protected-resource');
    expect(OAUTH_RESOURCE_METADATA_MCP_PATH).toBe('/.well-known/oauth-protected-resource/mcp');
    const challenge = challengeFor(config());
    expect(challenge.startsWith('Bearer resource_metadata=')).toBe(true);
    expect(challenge).toContain(`https://cuelingua-mcp-767542644824.us-central1.run.app/.well-known/oauth-protected-resource/mcp`);
  });
});
