import {
  verifyRequest, EMULATOR_OWNER, AUTH0_OPERATOR_SUBS_ENV, AUTH0_ISSUER_ENV, AUTH0_AUDIENCE_ENV,
  auth0Configured, operatorSubs, createLocalJwks, testKeyPair, createRemoteJwks,
  UNKNOWN_KID_COOLDOWN_MS, FETCH_TIMEOUT_MS, _resetJwksCacheForTesting,
} from './identity';

const ISSUER = 'https://tenant.example.auth0.com/';
const AUDIENCE = 'https://api.cuelingua.example';
const OPERATOR_SUB = 'auth0|op-123';
const USER_SUB = 'auth0|user-456';
const KID = 'test-kid';

function operatorSet(...subs: string[]): Set<string> {
  return new Set(subs);
}

describe('auth0Configured / operatorSubs', () => {
  it('requires both issuer and audience', () => {
    expect(auth0Configured(ISSUER, AUDIENCE)).toBe(true);
    expect(auth0Configured('', AUDIENCE)).toBe(false);
    expect(auth0Configured(ISSUER, '')).toBe(false);
    expect(auth0Configured('  ', AUDIENCE)).toBe(false);
  });

  it('parses the comma-separated operator allowlist', () => {
    expect(operatorSubs(`${OPERATOR_SUB}, auth0|two ,,`)).toEqual(new Set([OPERATOR_SUB, 'auth0|two']));
    expect(operatorSubs(undefined)).toEqual(new Set());
    expect(operatorSubs('')).toEqual(new Set());
  });
});

describe('verifyRequest (emulator/open runs)', () => {
  const original = process.env.FUNCTIONS_EMULATOR;

  afterEach(() => {
    if (original === undefined) delete process.env.FUNCTIONS_EMULATOR;
    else process.env.FUNCTIONS_EMULATOR = original;
  });

  it('assigns the fixed emulator owner when the runtime is the emulator (no JWT required)', async () => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    const { identity, error } = await verifyRequest(undefined, {
      issuer: ISSUER, audience: AUDIENCE, isProduction: false,
    });
    expect(error).toBeNull();
    expect(identity).toEqual({
      ownerId: EMULATOR_OWNER,
      subject: EMULATOR_OWNER,
      isOperator: false,
      via: 'emulator',
    });
  });

  it('keeps emulator dev data owner-scoped (never unscoped/global)', async () => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    const { identity } = await verifyRequest(undefined, { isProduction: false });
    expect(identity?.ownerId).toBe('emulator');
    expect(identity?.via).toBe('emulator');
  });
});

describe('verifyRequest (production-like runtime)', () => {
  const production = { isProduction: true };
  const keys = testKeyPair(KID);
  const jwks = createLocalJwks([keys.publicJwk]);

  const basePayload = (sub: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    scope: 'api',
    sub,
    iss: ISSUER,
    aud: AUDIENCE,
    iat: Math.floor(Date.now() / 1000) - 10,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  });

  it('fails closed when Auth0 is not configured (no verification attempted)', async () => {
    const { identity, error } = await verifyRequest(`Bearer ${keys.sign(basePayload(USER_SUB))}`, {
      ...production, issuer: '', audience: '',
    });
    expect(identity).toBeNull();
    expect(error?.message).toMatch(/AUTH0_ISSUER/);
  });

  it('fails closed without a Bearer token', async () => {
    const opts = { ...production, issuer: ISSUER, audience: AUDIENCE, jwks };
    const missing = await verifyRequest(undefined, opts);
    expect(missing.identity).toBeNull();
    expect(missing.error?.message).toMatch(/Bearer/);
    const basic = await verifyRequest('Basic abc', opts);
    expect(basic.identity).toBeNull();
    const garbage = await verifyRequest('Bearer not-a-jwt', opts);
    expect(garbage.identity).toBeNull();
  });

  it('resolves ownerId = the verified JWT sub for a normal user', async () => {
    const { identity, error } = await verifyRequest(`Bearer ${keys.sign(basePayload(USER_SUB))}`, {
      ...production, issuer: ISSUER, audience: AUDIENCE, jwks, operatorSubs: operatorSet(OPERATOR_SUB),
    });
    expect(error).toBeNull();
    expect(identity).toEqual({
      ownerId: USER_SUB,
      subject: USER_SUB,
      isOperator: false,
      via: 'auth0',
    });
  });

  it('marks a verified sub in the operator allowlist as an operator', async () => {
    const { identity } = await verifyRequest(`Bearer ${keys.sign(basePayload(OPERATOR_SUB))}`, {
      ...production, issuer: ISSUER, audience: AUDIENCE, jwks, operatorSubs: operatorSet(OPERATOR_SUB),
    });
    expect(identity?.ownerId).toBe(OPERATOR_SUB);
    expect(identity?.isOperator).toBe(true);
  });

  it('fails closed on a signature from an unknown key', async () => {
    const other = testKeyPair('unknown-kid');
    const token = other.sign(basePayload(USER_SUB));
    const { identity, error } = await verifyRequest(`Bearer ${token}`, {
      ...production, issuer: ISSUER, audience: AUDIENCE, jwks,
    });
    expect(identity).toBeNull();
    expect(error?.message).toMatch(/signing key/);
  });

  it('fails closed when the signature is invalid (tampered payload)', async () => {
    const good = keys.sign(basePayload(USER_SUB));
    // Flip one char in the payload segment: signature no longer matches.
    const parts = good.split('.');
    const tampered = `${parts[0]}.${parts[1].slice(0, -1)}${parts[1].endsWith('A') ? 'B' : 'A'}.${parts[2]}`;
    const { identity, error } = await verifyRequest(`Bearer ${tampered}`, {
      ...production, issuer: ISSUER, audience: AUDIENCE, jwks,
    });
    expect(identity).toBeNull();
    expect(error?.message).toMatch(/Invalid or expired/);
  });

  it('rejects a non-RS256 header', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', kid: KID, typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(basePayload(USER_SUB))).toString('base64url');
    const token = `${header}.${body}.AAAA`;
    const { identity, error } = await verifyRequest(`Bearer ${token}`, {
      ...production, issuer: ISSUER, audience: AUDIENCE, jwks,
    });
    expect(identity).toBeNull();
    expect(error?.message).toMatch(/RS256/);
  });

  it('fails closed on an issuer mismatch', async () => {
    const { identity } = await verifyRequest(`Bearer ${keys.sign(basePayload(USER_SUB, { iss: 'https://evil.example/' }))}`, {
      ...production, issuer: ISSUER, audience: AUDIENCE, jwks,
    });
    expect(identity).toBeNull();
  });

  it('fails closed on an audience mismatch', async () => {
    const { identity } = await verifyRequest(`Bearer ${keys.sign(basePayload(USER_SUB, { aud: 'https://someone-else.example' }))}`, {
      ...production, issuer: ISSUER, audience: AUDIENCE, jwks,
    });
    expect(identity).toBeNull();
  });

  it('fails closed on an expired token', async () => {
    const { identity } = await verifyRequest(`Bearer ${keys.sign(basePayload(USER_SUB, { exp: Math.floor(Date.now() / 1000) - 60 }))}`, {
      ...production, issuer: ISSUER, audience: AUDIENCE, jwks,
    });
    expect(identity).toBeNull();
  });

  it('fails closed when the token lacks a sub claim', async () => {
    const payload = basePayload(USER_SUB);
    delete payload.sub;
    const { identity, error } = await verifyRequest(`Bearer ${keys.sign(payload)}`, {
      ...production, issuer: ISSUER, audience: AUDIENCE, jwks,
    });
    expect(identity).toBeNull();
    expect(error?.message).toMatch(/sub/);
  });

  it('accepts an Auth0 issuer with/without a trailing slash equivalently', async () => {
    const noSlash = ISSUER.replace(/\/+$/, '');
    const { identity } = await verifyRequest(`Bearer ${keys.sign(basePayload(USER_SUB))}`, {
      ...production, issuer: noSlash, audience: AUDIENCE, jwks,
    });
    expect(identity?.ownerId).toBe(USER_SUB);
  });
});

describe('verifyRequest env defaults', () => {
  const keyEnv: Record<string, string | undefined> = {
    [AUTH0_ISSUER_ENV]: process.env[AUTH0_ISSUER_ENV],
    [AUTH0_AUDIENCE_ENV]: process.env[AUTH0_AUDIENCE_ENV],
    [AUTH0_OPERATOR_SUBS_ENV]: process.env[AUTH0_OPERATOR_SUBS_ENV],
  };

  afterEach(() => {
    for (const [k, v] of Object.entries(keyEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('reads issuer/audience/operator env vars when options omit them', async () => {
    const keys = testKeyPair('env-kid');
    const token = keys.sign({
      sub: 'auth0|from-env',
      iss: ISSUER,
      aud: AUDIENCE,
      iat: Math.floor(Date.now() / 1000) - 10,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    process.env[AUTH0_ISSUER_ENV] = ISSUER;
    process.env[AUTH0_AUDIENCE_ENV] = AUDIENCE;
    process.env[AUTH0_OPERATOR_SUBS_ENV] = 'auth0|from-env';
    const { identity } = await verifyRequest(`Bearer ${token}`, {
      isProduction: true,
      jwks: createLocalJwks([keys.publicJwk]),
      operatorSubs: undefined,
    });
    expect(identity?.ownerId).toBe('auth0|from-env');
    expect(identity?.isOperator).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* createRemoteJwks — cache, coalescing, cooldown, timeout             */
/* ------------------------------------------------------------------ */

// Minimal fake clock: replaces Date.now for deterministic TTL/cooldown tests.
let fakeNow = 0;
const fakeDateNow = jest.fn(() => fakeNow);

function advanceTime(ms: number) { fakeNow += ms; }

describe('createRemoteJwks', () => {
  beforeAll(() => { jest.spyOn(Date, 'now').mockImplementation(fakeDateNow); });
  afterAll(() => { jest.restoreAllMocks(); });

  /** Helper: create a fetcher that counts calls and returns a static JWKS body. */
  function countingFetcher(keys: Array<{ kid: string; n?: string; e?: string }> = []) {
    const calls: string[] = [];
    const fetcher = async (url: string) => { calls.push(url); return { keys }; };
    return { fetcher, calls };
  }

  beforeEach(() => { fakeNow = 0; _resetJwksCacheForTesting(); });

  it('fetches once on first getKey and serves from cache within TTL', async () => {
    const { fetcher, calls } = countingFetcher([
      { kid: 'k1', n: 'aaa', e: 'AQAB' },
    ]);
    const provider = createRemoteJwks('https://issuer.example/', fetcher);

    const key = await provider.getKey('k1');
    expect(key).not.toBeNull();
    expect(key!.kid).toBe('k1');
    expect(calls).toHaveLength(1);

    // Second call within TTL — no additional fetch.
    const key2 = await provider.getKey('k1');
    expect(key2).not.toBeNull();
    expect(calls).toHaveLength(1);

    advanceTime(60_000); // 1 min, still within 10-min TTL
    const key3 = await provider.getKey('k1');
    expect(key3).not.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('re-fetches after TTL expires (supports key rotation)', async () => {
    const { fetcher, calls } = countingFetcher([
      { kid: 'k1', n: 'aaa', e: 'AQAB' },
    ]);
    const provider = createRemoteJwks('https://issuer.example/', fetcher);

    await provider.getKey('k1');
    expect(calls).toHaveLength(1);

    advanceTime(10 * 60 * 1000 + 1); // expire TTL
    await provider.getKey('k1');
    expect(calls).toHaveLength(2);
  });

  it('coalesces concurrent getKey calls into a single fetch', async () => {
    const { fetcher, calls } = countingFetcher([
      { kid: 'k1', n: 'aaa', e: 'AQAB' },
    ]);
    const provider = createRemoteJwks('https://issuer.example/', fetcher);

    // Fire three concurrent getKey calls — should produce only one fetch.
    const [a, b, c] = await Promise.all([
      provider.getKey('k1'),
      provider.getKey('k1'),
      provider.getKey('k1'),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).not.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('coalesces concurrent calls for different kids into a single fetch', async () => {
    const { fetcher, calls } = countingFetcher([
      { kid: 'k1', n: 'aaa', e: 'AQAB' },
      { kid: 'k2', n: 'bbb', e: 'AQAB' },
    ]);
    const provider = createRemoteJwks('https://issuer.example/', fetcher);

    const [a, b] = await Promise.all([
      provider.getKey('k1'),
      provider.getKey('k2'),
    ]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('returns null for unknown kid and suppresses repeated fetches within cooldown', async () => {
    const { fetcher, calls } = countingFetcher([
      { kid: 'known', n: 'aaa', e: 'AQAB' },
    ]);
    const provider = createRemoteJwks('https://issuer.example/', fetcher);

    // First unknown kid — triggers a fetch (cooldown starts now).
    const miss1 = await provider.getKey('bogus');
    expect(miss1).toBeNull();
    expect(calls).toHaveLength(1);

    // Four more unknown kid lookups — all suppressed (no extra fetches).
    await provider.getKey('bogus2');
    await provider.getKey('bogus3');
    await provider.getKey('bogus4');
    await provider.getKey('bogus5');
    expect(calls).toHaveLength(1);

    advanceTime(UNKNOWN_KID_COOLDOWN_MS / 2); // still within cooldown
    await provider.getKey('bogus6');
    expect(calls).toHaveLength(1);
  });

  it('allows re-fetch for unknown kid after cooldown expires', async () => {
    const { fetcher, calls } = countingFetcher([
      { kid: 'known', n: 'aaa', e: 'AQAB' },
    ]);
    const provider = createRemoteJwks('https://issuer.example/', fetcher);

    await provider.getKey('bogus');
    expect(calls).toHaveLength(1);

    advanceTime(UNKNOWN_KID_COOLDOWN_MS + 1); // cooldown expired

    // This triggers a fresh fetch (rotation check).
    await provider.getKey('bogus');
    expect(calls).toHaveLength(2);
  });

  it('legitimate key rotation: new kid appears after cooldown refresh', async () => {
    let currentKeys = [{ kid: 'k1', n: 'aaa', e: 'AQAB' }];
    const fetcher = jest.fn(async () => ({ keys: currentKeys }));
    const provider = createRemoteJwks('https://issuer.example/', fetcher);

    // Initial fetch.
    expect(await provider.getKey('k1')).not.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);

    advanceTime(UNKNOWN_KID_COOLDOWN_MS + 1); // cooldown expired

    // Simulate rotation: new key 'k2' appears in the JWKS.
    currentKeys = [
      { kid: 'k1', n: 'aaa', e: 'AQAB' },
      { kid: 'k2', n: 'bbb', e: 'AQAB' },
    ];

    // Unknown kid triggers refresh — new key is now available.
    const rotated = await provider.getKey('k2');
    expect(rotated).not.toBeNull();
    expect(rotated!.kid).toBe('k2');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('successful known-key fetch does not start cooldown for a new unknown kid', async () => {
    let currentKeys = [{ kid: 'k1', n: 'aaa', e: 'AQAB' }];
    const fetcher = jest.fn(async () => ({ keys: currentKeys }));
    const provider = createRemoteJwks('https://issuer.example/', fetcher);

    // First call: fetch k1 successfully.
    expect(await provider.getKey('k1')).not.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Immediately rotate: k2 appears.
    currentKeys = [
      { kid: 'k1', n: 'aaa', e: 'AQAB' },
      { kid: 'k2', n: 'bbb', e: 'AQAB' },
    ];

    // k2 request must NOT be suppressed by cooldown — it should fetch and
    // return k2 immediately (zero time elapsed since last fetch).
    const key2 = await provider.getKey('k2');
    expect(key2).not.toBeNull();
    expect(key2!.kid).toBe('k2');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('unknown kid coalescing records cooldown so next unknown is suppressed', async () => {
    // Use a delayed fetcher so the known-key fetch is still in-flight when
    // the unknown-kid request arrives and coalesces onto it.
    const keys = [{ kid: 'k1', n: 'aaa', e: 'AQAB' }];
    let resolveFetch: (v: { keys?: unknown }) => void;
    const fetcher = jest.fn(() => new Promise<{ keys?: unknown }>((r) => { resolveFetch = r; }));
    const provider = createRemoteJwks('https://issuer.example/', fetcher);

    // Start a known-key fetch (pending, not yet resolved).
    const k1Promise = provider.getKey('k1');
    // Concurrently request an unknown kid — coalesces onto the same fetch.
    const unknownPromise = provider.getKey('bogus');

    // Settle the shared fetch with only k1 present.
    resolveFetch!({ keys });

    const [k1, bogus] = await Promise.all([k1Promise, unknownPromise]);
    expect(k1).not.toBeNull();
    expect(bogus).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Another unknown-kid request must be suppressed (cooldown was set by
    // the coalesced caller), with no second fetch.
    const bogus2 = await provider.getKey('bogus2');
    expect(bogus2).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns null on fetch failure (fail-closed)', async () => {
    const fetcher = jest.fn(async () => { throw new Error('network down'); });
    const provider = createRemoteJwks('https://issuer.example/', fetcher);

    const result = await provider.getKey('k1');
    expect(result).toBeNull();
  });

  it('returns null on fetch timeout (fail-closed)', async () => {
    // Stub AbortSignal.timeout to return an already-aborted signal so the
    // fetcher rejects immediately — zero real timers, fully deterministic.
    let capturedTimeout: number | undefined;
    const origTimeout = AbortSignal.timeout;
    try {
      AbortSignal.timeout = ((ms: number) => {
        capturedTimeout = ms;
        const controller = new AbortController();
        controller.abort();
        return controller.signal;
      }) as typeof AbortSignal.timeout;

      const fetcher = jest.fn(async (_url: string, opts?: { signal?: AbortSignal }) => {
        if (opts?.signal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        return { keys: [] };
      });
      const provider = createRemoteJwks('https://issuer.example/', fetcher);

      const result = await provider.getKey('k1');
      expect(result).toBeNull();
      expect(capturedTimeout).toBe(FETCH_TIMEOUT_MS);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      AbortSignal.timeout = origTimeout;
    }
  });

  it('returns null for kid not present in fetched JWKS', async () => {
    const { fetcher, calls } = countingFetcher([
      { kid: 'k1', n: 'aaa', e: 'AQAB' },
    ]);
    const provider = createRemoteJwks('https://issuer.example/', fetcher);

    const result = await provider.getKey('unknown-kid');
    expect(result).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
