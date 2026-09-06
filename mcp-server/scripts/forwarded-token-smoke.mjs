#!/usr/bin/env node
/**
 * Forwarded-token smoke check for the FSRS MCP server.
 *
 * Verifies the multi-tenant identity-propagation contract end-to-end:
 *   1. NO-TOKEN: an HTTP POST to /mcp WITHOUT an Authorization header while
 *      Auth0 is configured is rejected with 401 (fails closed).
 *   2. FORWARDED-TOKEN: with a valid (locally signed, RS256) Auth0 JWT, the
 *      /mcp request passes the gate and the server forwards the SAME token
 *      as `Authorization: Bearer <token>` to the backend. A stub backend
 *      (loopback HTTP) captures the header and the health tool call asserts
 *      the forwarded value equals the presented token — proving the verified
 *      token is propagated per request and not swapped/cleared.
 *
 * The token is signed by an ephemeral local key whose JWKS the server is
 * pointed at (issuer = the loopback stub), so no real Auth0 tenant or network
 * is needed. The backend the MCP server calls is the stub, so this smoke
 * never touches production.
 *
 * Run: node scripts/forwarded-token-smoke.mjs   (after npm run build)
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const BACKEND_PORT = 19600 + Math.floor(Math.random() * 250);
const MCP_PORT = BACKEND_PORT + 1;
const AUDIENCE = 'https://smoke.invalid/mcp';
const LOCAL_ISSUER = `http://127.0.0.1:${BACKEND_PORT}/auth0`;

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/** Mint a compact RS256 JWT signed by `privateKey` with kid `kid`. */
function signJwt(payload, privateKey, kid) {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createSign('sha256').update(`${header}.${body}`).end().sign(privateKey).toString('base64url');
  return `${header}.${body}.${sig}`;
}

async function main() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = 'smoke-kid';
  const jwks = { keys: [{ kid, alg: 'RS256', use: 'sig', kty: 'RSA', n: jwk.n, e: jwk.e }] };

  // Captured forwarded Authorization header from the MCP server's backend call.
  let forwardedAuth = null;
  const backend = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.url === '/auth0/.well-known/jwks.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(jwks));
        return;
      }
      if (req.url.startsWith('/health')) {
        forwardedAuth = req.headers.authorization ?? null;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString(), sawAuth: forwardedAuth }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((resolve) => backend.listen(BACKEND_PORT, '127.0.0.1', resolve));

  const child = spawn(process.execPath, ['dist/index.js'], {
    env: {
      ...process.env,
      MCP_TRANSPORT: 'http',
      MCP_PORT: String(MCP_PORT),
      MCP_HOST: '127.0.0.1',
      FSRS_API_BASE_URL: `http://127.0.0.1:${BACKEND_PORT}`,
      CUELINGUA_API_KEY: 'smoke-backend-key',
      AUTH0_ISSUER: LOCAL_ISSUER,
      AUTH0_AUDIENCE: AUDIENCE,
      MCP_RESOURCE_URL: `http://127.0.0.1:${MCP_PORT}/mcp`,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));

  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${MCP_PORT}/.well-known/oauth-protected-resource`);
      if (r.ok) ready = true;
    } catch {
      await sleep(200);
    }
  }
  if (!ready) throw new Error('MCP server did not become ready');

  const base = `http://127.0.0.1:${MCP_PORT}/mcp`;

  // 1. NO-TOKEN: must fail closed with 401 + RFC 9728 challenge.
  const noToken = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' } } }),
  });
  if (noToken.status !== 401) {
    throw new Error(`no-token /mcp request expected 401, got ${noToken.status}`);
  }
  const challenge = noToken.headers.get('www-authenticate') ?? '';
  if (!challenge.includes('Bearer resource_metadata=')) {
    throw new Error(`expected RFC 9728 WWW-Authenticate challenge, got: ${challenge}`);
  }
  console.log('PASS no-token /mcp request → 401 + RFC 9728 challenge (fails closed)');

  // 2. FORWARDED-TOKEN: mint a valid token for the local issuer and use it.
  const token = signJwt({
    scope: 'openid email',
    iss: LOCAL_ISSUER,
    aud: AUDIENCE,
    sub: 'auth0|smoke-user-1',
    iat: Math.floor(Date.now() / 1000) - 5,
    exp: Math.floor(Date.now() / 1000) + 3600,
  }, privateKey, kid);

  const authorizedHeaders = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${token}`,
  };

  const initRes = await fetch(base, {
    method: 'POST',
    headers: authorizedHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' } } }),
  });
  const initBody = await initRes.json();
  if (!initRes.ok || initBody.error) {
    throw new Error(`authorized initialize failed: ${JSON.stringify(initBody)}`);
  }
  console.log('PASS authorized /mcp initialize → token accepted');

  // tools/call health must forward the SAME token to the backend.
  const healthRes = await fetch(base, {
    method: 'POST',
    headers: authorizedHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'health', arguments: {} } }),
  });
  const healthBody = await healthRes.json();
  if (healthBody.error) {
    throw new Error(`health call failed: ${JSON.stringify(healthBody)}`);
  }
  await sleep(150);
  if (forwardedAuth !== `Bearer ${token}`) {
    throw new Error(`forwarded Authorization mismatch: got ${JSON.stringify(forwardedAuth)}, want Bearer ${token}`);
  }
  console.log('PASS forwarded-token: backend received Authorization: Bearer <same verified token>');

  console.log('\nFORWARDED-TOKEN SMOKE OK');
  child.kill();
  backend.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err.message);
  process.exit(1);
});
