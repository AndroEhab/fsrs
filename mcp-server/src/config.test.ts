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

  it('does not require auth against the local Firebase emulator or chatgpt mock', () => {
    expect(needsRemoteAuth(fullConfig({ apiBaseUrl: 'http://127.0.0.1:5001/cuelingua/us-central1' }))).toBe(false);
    expect(needsRemoteAuth(fullConfig({ apiBaseUrl: 'http://localhost:8787' }))).toBe(false);
  });

  it('treats an unparseable base URL as remote (defense in depth)', () => {
    expect(needsRemoteAuth(fullConfig({ apiBaseUrl: 'not a url' }))).toBe(true);
  });
});

describe('hasAuthMechanism / authGuardError (fail-closed deploy guard)', () => {
  it('rejects an HTTP remote server with NO auth configured (would expose the backend key)', () => {
    const cfg = fullConfig({ auth0Issuer: '', auth0Audience: '', authToken: '' });
    expect(hasAuthMechanism(cfg)).toBe(false);
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

  it('never blocks stdio or a loopback backend regardless of auth config', () => {
    expect(authGuardError(fullConfig({ transport: 'stdio', auth0Issuer: '', auth0Audience: '' }))).toBeNull();
    expect(authGuardError(fullConfig({ apiBaseUrl: 'http://127.0.0.1:5001', auth0Issuer: '', auth0Audience: '' }))).toBeNull();
  });

  it('loadConfig reads MCP_AUTH_OPT_OUT and keeps defaults when unset', () => {
    const withOptOut = loadConfig({ ...process.env, MCP_AUTH_OPT_OUT: 'true', AUTH0_ISSUER: '', AUTH0_AUDIENCE: '', MCP_AUTH_TOKEN: '' });
    expect(withOptOut.authOptOut).toBe(true);
    const without = loadConfig({ ...process.env, AUTH0_ISSUER: '', AUTH0_AUDIENCE: '', MCP_AUTH_TOKEN: '' });
    expect(without.authOptOut).toBe(false);
    expect(authGuardError(without)).toMatch(/no authentication is configured/);
  });
});
