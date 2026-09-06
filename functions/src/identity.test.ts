import {
  verifyRequest, EMULATOR_OWNER, AUTH0_OPERATOR_SUBS_ENV, AUTH0_ISSUER_ENV, AUTH0_AUDIENCE_ENV,
  auth0Configured, operatorSubs, createLocalJwks, testKeyPair,
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
