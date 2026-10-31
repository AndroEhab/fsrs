#!/usr/bin/env node
/**
 * Live HTTP smoke for per-user auth, Host/Origin protections, and browser CORS.
 * Uses ephemeral local RS256/JWKS and a local ownership-aware backend fixture.
 * Run after building; never touches production services or credentials.
 */
import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
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


function postWithHost(host, headers, id) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: MCP_PORT, path: '/mcp', method: 'POST', headers: { ...headers, Host: host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' } } }));
  });
}
async function main() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = 'smoke-kid';
  const jwks = { keys: [{ kid, alg: 'RS256', use: 'sig', kty: 'RSA', n: jwk.n, e: jwk.e }] };

  const tokenSubjects = new Map();
  const backendRequests = [];
  const cardsByOwner = new Map([
    ['auth0|smoke-user-1', { 'user-1-card': { id: 'user-1-card', front: 'Owned by user 1', back: 'answer 1', tags: [], createdAt: { _seconds: 1700000000, _nanoseconds: 0 }, updatedAt: { _seconds: 1700000000, _nanoseconds: 0 }, due: { _seconds: 1700000000, _nanoseconds: 0 }, state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, reviewLog: [], images: [] } }],
    ['auth0|smoke-user-2', { 'user-2-card': { id: 'user-2-card', front: 'Owned by user 2', back: 'answer 2', tags: [], createdAt: { _seconds: 1700000000, _nanoseconds: 0 }, updatedAt: { _seconds: 1700000000, _nanoseconds: 0 }, due: { _seconds: 1700000000, _nanoseconds: 0 }, state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, reviewLog: [], images: [] } }],
  ]);
  const backend = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/auth0/.well-known/jwks.json') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(jwks));
        return;
      }
      if (req.headers['x-api-key'] !== 'smoke-backend-key') {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Invalid API key' }));
        return;
      }
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const subject = token ? tokenSubjects.get(token) : undefined;
      backendRequests.push({ token, subject, url: req.url });
      if (!subject) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Verified user identity required' }));
        return;
      }
      if (req.url.startsWith('/getFlashcardHandler/')) {
        const id = decodeURIComponent(req.url.slice('/getFlashcardHandler/'.length));
        const card = cardsByOwner.get(subject)?.[id];
        if (!card) {
          res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Card not found' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(card));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((resolve) => backend.listen(BACKEND_PORT, '127.0.0.1', resolve));

  const invalidConfigurations = [
    { MCP_AUTH_TOKEN: 'static', AUTH0_ISSUER: LOCAL_ISSUER, AUTH0_AUDIENCE: AUDIENCE },
    { MCP_AUTH_TOKEN: '', AUTH0_ISSUER: LOCAL_ISSUER, AUTH0_AUDIENCE: '', MCP_BACKEND_AUTH_TOKEN: '' },
    { MCP_AUTH_TOKEN: '', AUTH0_ISSUER: '', AUTH0_AUDIENCE: AUDIENCE, MCP_BACKEND_AUTH_TOKEN: '' },
    { MCP_AUTH_TOKEN: '', AUTH0_ISSUER: LOCAL_ISSUER, AUTH0_AUDIENCE: AUDIENCE, MCP_BACKEND_AUTH_TOKEN: 'trusted-process-token' },
  ];
  for (const [index, invalid] of invalidConfigurations.entries()) {
    const rejected = spawnSync(process.execPath, ['dist/index.js'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        HOME: process.env.HOME,
        MCP_TRANSPORT: 'http', MCP_HOST: '127.0.0.1', MCP_PORT: String(MCP_PORT),
        FSRS_API_BASE_URL: `http://127.0.0.1:${BACKEND_PORT}`,
        CUELINGUA_API_KEY: 'smoke-backend-key', MCP_AUTH_OPT_OUT: 'false',
        AUTH0_ISSUER: '', AUTH0_AUDIENCE: '', MCP_AUTH_TOKEN: '',
        ...invalid,
      },
    });
    if (rejected.status === 0 || !rejected.stderr.includes('Invalid authentication configuration')) {
      throw new Error(`invalid auth configuration ${index + 1} was not rejected at startup`);
    }
  }
  console.log('PASS startup rejects mixed and incomplete Auth0/static auth settings');

  const child = spawn(process.execPath, ['dist/index.js'], {
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      HOME: process.env.HOME,
      MCP_TRANSPORT: 'http',
      MCP_PORT: String(MCP_PORT),
      MCP_HOST: '127.0.0.1',
      FSRS_API_BASE_URL: `http://127.0.0.1:${BACKEND_PORT}`,
      CUELINGUA_API_KEY: 'smoke-backend-key',
      MCP_AUTH_TOKEN: '',
      MCP_BACKEND_AUTH_TOKEN: '',
      MCP_AUTH_OPT_OUT: 'false',
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
  const preflight = await fetch(base, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://chatgpt.com',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,authorization,mcp-protocol-version,last-event-id',
    },
  });
  if (preflight.status !== 204
    || preflight.headers.get('access-control-allow-origin') !== 'https://chatgpt.com'
    || !preflight.headers.get('access-control-allow-headers')?.includes('mcp-protocol-version')
    || !preflight.headers.get('access-control-allow-headers')?.includes('last-event-id')) {
    throw new Error(`MCP CORS preflight failed: ${preflight.status} ${preflight.headers.get('access-control-allow-headers')}`);
  }
  console.log('PASS browser-style MCP preflight advertises protocol and Last-Event-ID headers');

  const unauthorizedBrowser = await fetch(base, {
    method: 'POST',
    headers: { Origin: 'https://chatgpt.com', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' } } }),
  });
  if (unauthorizedBrowser.status !== 401
    || !unauthorizedBrowser.headers.get('access-control-allow-origin')
    || !unauthorizedBrowser.headers.get('access-control-expose-headers')?.toLowerCase().includes('www-authenticate')
    || !unauthorizedBrowser.headers.get('www-authenticate')?.includes('resource_metadata=')) {
    throw new Error('allowed Origin did not receive a browser-readable RFC 9728 401 challenge');
  }
  console.log('PASS unauthorized allowed-Origin response exposes RFC 9728 challenge');

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
  const hostileHostStatus = await postWithHost('attacker.invalid', authorizedHeaders, 4);
  if (hostileHostStatus !== 403) throw new Error(`hostile Host expected 403, got ${hostileHostStatus}`);
  const hostileOrigin = await fetch(base, {
    method: 'POST',
    headers: { ...authorizedHeaders, Origin: 'https://attacker.invalid' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' } } }),
  });
  if (hostileOrigin.status !== 403 || hostileOrigin.headers.get('access-control-allow-origin') !== null) {
    throw new Error(`hostile Origin expected 403 without reflected CORS grant, got ${hostileOrigin.status}`);
  }
  console.log('PASS hostile Host/Origin rejected (403) with a valid Auth0 token');

  const allowedOrigin = await fetch(base, {
    method: 'POST',
    headers: { ...authorizedHeaders, Origin: 'https://chatgpt.com' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' } } }),
  });
  if (!allowedOrigin.ok || allowedOrigin.headers.get('access-control-allow-origin') !== 'https://chatgpt.com') {
    throw new Error(`allowed ChatGPT Origin was not accepted with scoped CORS (${allowedOrigin.status})`);
  }
  console.log('PASS authorized ChatGPT Origin accepted with exact CORS origin');

  const getCard = async (cardId, authHeaders, requestId) => fetch(base, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name: 'get_flashcard', arguments: { id: cardId } } }),
  });
  const tokenForUser1 = signJwt({ iss: LOCAL_ISSUER, aud: AUDIENCE, sub: 'auth0|smoke-user-1', iat: Math.floor(Date.now() / 1000) - 5, exp: Math.floor(Date.now() / 1000) + 3600 }, privateKey, kid);
  const tokenForUser2 = signJwt({ iss: LOCAL_ISSUER, aud: AUDIENCE, sub: 'auth0|smoke-user-2', iat: Math.floor(Date.now() / 1000) - 5, exp: Math.floor(Date.now() / 1000) + 3600 }, privateKey, kid);
  tokenSubjects.set(tokenForUser1, 'auth0|smoke-user-1');
  tokenSubjects.set(tokenForUser2, 'auth0|smoke-user-2');
  const user1Headers = { ...authorizedHeaders, Authorization: `Bearer ${tokenForUser1}` };
  const user2Headers = { ...authorizedHeaders, Authorization: `Bearer ${tokenForUser2}` };
  const [user1CardResponse, user2CardResponse, wrongOwnerResponse] = await Promise.all([
    getCard('user-1-card', user1Headers, 10),
    getCard('user-2-card', user2Headers, 11),
    getCard('user-1-card', user2Headers, 12),
  ]);
  const user1Card = (await user1CardResponse.json()).result?.structuredContent;
  const user2Card = (await user2CardResponse.json()).result?.structuredContent;
  const wrongOwner = (await wrongOwnerResponse.json()).result;
  if (user1Card?.id !== 'user-1-card' || user2Card?.id !== 'user-2-card' || wrongOwner?.isError !== true) {
    throw new Error('caller-owned reads crossed user boundaries');
  }
  const ownerRequests = backendRequests.filter((request) => request.url.startsWith('/getFlashcardHandler/'));
  if (ownerRequests.length !== 3
    || ownerRequests[0].token !== tokenForUser1 || ownerRequests[0].subject !== 'auth0|smoke-user-1'
    || ownerRequests[1].token !== tokenForUser2 || ownerRequests[1].subject !== 'auth0|smoke-user-2'
    || ownerRequests[2].token !== tokenForUser2 || ownerRequests[2].subject !== 'auth0|smoke-user-2') {
    throw new Error('verified backend identity was not scoped to each request');
  }
  console.log('PASS interleaved callers retain isolated, owner-scoped backend identity');

  console.log('\nFORWARDED-TOKEN SMOKE OK');
  child.kill();
  backend.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err.message);
  process.exit(1);
});
