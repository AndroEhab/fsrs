import { authGuardError, hasAuthMechanism, loadConfig, needsRemoteAuth, type ServerConfig } from './config';

function fullConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    apiKey: 'test-key',
    apiBaseUrl: 'https://us-central1-cuelingua.cloudfunctions.net',
    port: 8787,
    host: '0.0.0.0',
    transport: 'http',
    authToken: '',
    requestTimeoutMs: 15000,
    auth0Issuer: 'https://andrewehab.eu.auth0.com/',
    auth0Audience: 'https://cuelingua-mcp-767542644824.us-central1.run.app/mcp',
    resourceUrl: 'https://cuelingua-mcp-767542644824.us-central1.run.app/mcp',
    reviewTestMode: false,
    authOptOut: false,
    ...overrides,
  };
}

describe('needsRemoteAuth', () => {
  it('requires auth for an HTTP transport against a remote https backend (the default deploy)', () => {
    expect(needsRemoteAuth(fullConfig())).toBe(true);
  });

  it('never requires auth for stdio (local transport)', () => {
    expect(needsRemoteAuth(fullConfig({ transport: 'stdio' }))).toBe(false);
  });

  it('does not require auth against the local emulator when listener is also loopback', () => {
    expect(needsRemoteAuth(fullConfig({ apiBaseUrl: 'http://127.0.0.1:5001/cuelingua/us-central1', host: '127.0.0.1' }))).toBe(false);
    expect(needsRemoteAuth(fullConfig({ apiBaseUrl: 'http://localhost:8787', host: 'localhost' }))).toBe(false);
    expect(needsRemoteAuth(fullConfig({ apiBaseUrl: 'http://[::1]:5001', host: '::1' }))).toBe(false);
    // 127/8 range: any 127.x.x.x is loopback (RFC 5735 §2).
    expect(needsRemoteAuth(fullConfig({ apiBaseUrl: 'http://127.0.0.2:5001', host: '127.0.0.2' }))).toBe(false);
    expect(needsRemoteAuth(fullConfig({ apiBaseUrl: 'http://127.255.255.254:5001', host: '127.255.255.254' }))).toBe(false);
  });

  it('requires auth for a local backend when listener is on 0.0.0.0 (exposed to network)', () => {
    expect(needsRemoteAuth(fullConfig({ apiBaseUrl: 'http://127.0.0.1:5001/cuelingua/us-central1', host: '0.0.0.0' }))).toBe(true);
    expect(needsRemoteAuth(fullConfig({ apiBaseUrl: 'http://localhost:8787', host: '0.0.0.0' }))).toBe(true);
  });

  it('requires auth for a local backend when listener is on a non-loopback IP', () => {
    expect(needsRemoteAuth(fullConfig({ apiBaseUrl: 'http://localhost:5001', host: '192.168.1.100' }))).toBe(true);
  });

  it('treats a syntactically invalid 127.x host as non-loopback (fail closed)', () => {
    expect(needsRemoteAuth(fullConfig({ apiBaseUrl: 'http://127.0.0.1:5001', host: '127.invalid' }))).toBe(true);
  });

  it('treats an unparseable base URL as remote (defense in depth)', () => {
    expect(needsRemoteAuth(fullConfig({ apiBaseUrl: 'not a url' }))).toBe(true);
  });
});

describe('hasAuthMechanism / authGuardError (fail-closed deploy guard)', () => {
  it('rejects an HTTP remote server with NO auth configured (would expose the backend key)', () => {
    const cfg = fullConfig({ auth0Issuer: '', auth0Audience: '', authToken: '' });
    expect(hasAuthMechanism(cfg)).toBe(false);
    expect(authGuardError(cfg)).toMatch(/targets a remote backend/);
    expect(authGuardError(cfg)).toMatch(/no authentication is configured/);
  });

  it('accepts an HTTP remote server with Auth0 configured (issuer + audience)', () => {
    const cfg = fullConfig(); // Auth0 set by default
    expect(hasAuthMechanism(cfg)).toBe(true);
    expect(authGuardError(cfg)).toBeNull();
  });

  it('accepts an HTTP remote server with the static bearer token configured', () => {
    const cfg = fullConfig({ auth0Issuer: '', auth0Audience: '', authToken: 'sekrit' });
    expect(hasAuthMechanism(cfg)).toBe(true);
    expect(authGuardError(cfg)).toBeNull();
  });

  it('accepts the explicit local opt-out (MCP_AUTH_OPT_OUT) even against a remote backend', () => {
    const cfg = fullConfig({ auth0Issuer: '', auth0Audience: '', authToken: '', authOptOut: true });
    expect(authGuardError(cfg)).toBeNull();
  });

  it('never blocks stdio regardless of auth config', () => {
    expect(authGuardError(fullConfig({ transport: 'stdio', auth0Issuer: '', auth0Audience: '' }))).toBeNull();
  });

  it('blocks a local backend when listener is on 0.0.0.0 without auth', () => {
    const err = authGuardError(fullConfig({ apiBaseUrl: 'http://127.0.0.1:5001', host: '0.0.0.0', auth0Issuer: '', auth0Audience: '' }));
    expect(err).toMatch(/listener \(0\.0\.0\.0\) is not loopback/);
    expect(err).toMatch(/no authentication is configured/);
  });

  it('allows a local backend with loopback listener without auth', () => {
    expect(authGuardError(fullConfig({ apiBaseUrl: 'http://127.0.0.1:5001', host: '127.0.0.1', auth0Issuer: '', auth0Audience: '' }))).toBeNull();
  });

  it('loadConfig reads MCP_AUTH_OPT_OUT and keeps defaults when unset', () => {
    const withOptOut = loadConfig({ ...process.env, MCP_AUTH_OPT_OUT: 'true', AUTH0_ISSUER: '', AUTH0_AUDIENCE: '', MCP_AUTH_TOKEN: '' });
    expect(withOptOut.authOptOut).toBe(true);
    const without = loadConfig({ ...process.env, AUTH0_ISSUER: '', AUTH0_AUDIENCE: '', MCP_AUTH_TOKEN: '' });
    expect(without.authOptOut).toBe(false);
    expect(authGuardError(without)).toMatch(/no authentication is configured/);
  });
});
