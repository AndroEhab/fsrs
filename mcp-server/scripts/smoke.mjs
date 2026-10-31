#!/usr/bin/env node
/**
 * End-to-end smoke test for the FSRS MCP server using an ephemeral localhost
 * backend stub and an isolated child-process environment.
 *
 *   - tools/list and resources/list
 *   - tools/call health (proxied to the local stub)
 *   - protected tool calls with no configured API key (must fail closed)
 *
 * Run: npm run smoke (after npm run build)
 *
 * This script never loads .env, uses production credentials, or calls a
 * deployed backend. It creates no persistent data; the local stub only
 * answers the public health endpoint.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 18999 + Math.floor(Math.random() * 1000);
const BODY_LIMIT_PORT = 21000 + Math.floor(Math.random() * 1000);
const BACKEND_PORT = 22000 + Math.floor(Math.random() * 1000);
const proxiedLargeCalls = [];
const backend = createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }
  if (req.method === 'POST' && (req.url === '/importApkgHandler' || req.url === '/uploadImageHandler/audit-card')) {
    let requestBytes = 0;
    req.on('data', (chunk) => { requestBytes += chunk.length; });
    req.on('end', () => {
      proxiedLargeCalls.push({ path: req.url, requestBytes, apiKey: req.headers['x-api-key'] });
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'local smoke backend reached' }));
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Not found' }));
});
await new Promise((resolve) => backend.listen(BACKEND_PORT, '127.0.0.1', resolve));

async function bodyLimitSmoke() {
  const child = spawn(process.execPath, ['dist/index.js'], {
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: process.env.HOME,
      MCP_TRANSPORT: 'http', MCP_PORT: String(BODY_LIMIT_PORT), MCP_HOST: '127.0.0.1',
      FSRS_API_BASE_URL: `http://127.0.0.1:${BACKEND_PORT}`,
      CUELINGUA_API_KEY: 'local-smoke-api-key',
      MCP_AUTH_TOKEN: 'local-smoke-mcp-token',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[body-limit-server] ${d}`));
  try {
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${BODY_LIMIT_PORT}/.well-known/oauth-protected-resource`);
        if (response.ok) ready = true;
      } catch {
        await sleep(200);
      }
    }
    if (!ready) throw new Error('body-limit MCP server did not become ready');

    const url = `http://127.0.0.1:${BODY_LIMIT_PORT}/mcp`;
    async function sendRpc(body, authorized) {
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
      if (authorized) headers.Authorization = 'Bearer local-smoke-mcp-token';
      const response = await fetch(url, { method: 'POST', headers, body });
      return { status: response.status, body: await response.json() };
    }
    const list = await sendRpc(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), true);
    const tools = list.body.result?.tools ?? [];
    const importPackageMax = tools.find((tool) => tool.name === 'import_apkg')?.inputSchema?.properties?.package?.maxLength;
    const imageDataMax = tools.find((tool) => tool.name === 'upload_image')?.inputSchema?.properties?.data?.maxLength;
    if (list.status !== 200 || !Number.isSafeInteger(importPackageMax) || !Number.isSafeInteger(imageDataMax)) {
      throw new Error('could not read bounded import/upload schemas from tools/list');
    }

    // Derive a real, valid-sized payload from the public image schema; its
    // request body is larger than the SDK's former default and must reach the
    // mock backend rather than failing at MCP transport parsing.
    const acceptedPayload = 'A'.repeat(Math.floor(imageDataMax / 2));
    const importBody = JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'import_apkg', arguments: { package: acceptedPayload } },
    });
    const uploadBody = JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'upload_image', arguments: { id: 'audit-card', data: acceptedPayload, fileName: 'x.jpg', contentType: 'image/jpeg' } },
    });
    for (const [name, body, expectedPath] of [
      ['import_apkg', importBody, '/importApkgHandler'],
      ['upload_image', uploadBody, '/uploadImageHandler/audit-card'],
    ]) {
      const response = await sendRpc(body, true);
      if (response.status !== 200 || !response.body.result?.isError
        || !JSON.stringify(response.body.result).includes('local smoke backend reached')
        || !proxiedLargeCalls.some((call) => call.path === expectedPath && call.apiKey === 'local-smoke-api-key')) {
        throw new Error(`${name} did not reach the authenticated mock backend: ${JSON.stringify(response).slice(0, 400)}`);
      }
    }
    console.log('PASS authorized >4 MiB import_apkg/upload_image bodies pass MCP parsing and reach only the loopback backend');

    const overDeclaredBound = 'A'.repeat(importPackageMax + 4096);
    const oversized = JSON.stringify({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'import_apkg', arguments: { package: overDeclaredBound } },
    });
    const unauthenticated = await sendRpc(oversized, false);
    if (unauthenticated.status !== 401 || proxiedLargeCalls.length !== 2) {
      throw new Error(`unauthenticated oversized request was not rejected before backend access: ${unauthenticated.status}`);
    }
    const authorized = await sendRpc(oversized, true);
    if (authorized.status !== 413 || !JSON.stringify(authorized.body).includes('Payload Too Large') || proxiedLargeCalls.length !== 2) {
      throw new Error(`request above the declared package bound did not receive transport 413: ${authorized.status}`);
    }
    console.log('PASS unauthenticated oversized body → 401 before SDK body parsing/backend; authorized body above bound → 413');
  } finally {
    child.kill();
  }
}

async function main() {
  const child = spawn(process.execPath, ['dist/index.js'], {
    // Loopback-only smoke server: it talks to the REMOTE backend but must run
    // without auth, so it needs the explicit local opt-out (the same override
    // scripts/launch-local.mjs applies for local desktop connectors/tunnels).
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: process.env.HOME, MCP_TRANSPORT: 'http', MCP_PORT: String(PORT), MCP_HOST: '127.0.0.1', FSRS_API_BASE_URL: `http://127.0.0.1:${BACKEND_PORT}`, CUELINGUA_API_KEY: '', MCP_AUTH_OPT_OUT: 'true' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));

  // Wait for the listen banner.
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/.well-known/oauth-protected-resource`);
      if (r.ok) ready = true;
    } catch {
      await sleep(200);
    }
  }
  if (!ready) throw new Error('MCP server did not become ready');

  const base = `http://127.0.0.1:${PORT}/mcp`;

  async function mcpRequest(method, params) {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`MCP error ${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  }

  // 0. MCP Apps capability negotiation.
  const init = await mcpRequest('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: { extensions: { 'io.modelcontextprotocol/ui': {} } },
    clientInfo: { name: 'fsrs-smoke', version: '1.0.0' },
  });
  if (!init.capabilities?.extensions?.['io.modelcontextprotocol/ui']) {
    throw new Error('MCP Apps UI extension capability is missing');
  }
  console.log('PASS initialize: MCP Apps UI extension advertised');

  // 1. List tools.
  const { tools } = await mcpRequest('tools/list', {});
  const names = tools.map((t) => t.name).sort();
  const expected = [
    'attach_image', 'bulk_create_flashcards', 'bulk_delete_flashcards', 'bulk_enroll_cards', 'bulk_update_flashcards',
    'count_flashcards', 'create_deck', 'create_flashcard', 'delete_deck', 'delete_flashcard',
    'delete_tag', 'end_review_session', 'export_apkg', 'get_deck', 'get_due_flashcards',
    'get_enrollment_status', 'get_flashcard', 'get_review_history', 'get_review_session', 'get_study_stats', 'get_top_lapsed_cards',
    'health', 'import_apkg', 'list_card_images', 'list_decks', 'list_flashcards',
    'list_tags', 'merge_tags', 'migrate_review_events', 'remove_image', 'rename_tag', 'reset_flashcards',
    'review_flashcard', 'search_cards', 'set_due_date',
    'start_review_session', 'submit_review', 'suspend_flashcards', 'unsuspend_flashcards',
    'update_deck', 'update_flashcard', 'upload_image',
  ];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Tool mismatch: got ${JSON.stringify(names)}, want ${JSON.stringify(expected)}`);
  }
  console.log('PASS tools/list:', names.join(', '));

  // 1b. The Apps SDK review widget is registered as a ui:// resource.
  const { resources } = await mcpRequest('resources/list', {});
  const widget = resources.find((r) => r.name === 'review-session-widget');
  if (!widget || !widget.uri.startsWith('ui://review-session-')) {
    throw new Error(`review widget resource missing; got: ${JSON.stringify(resources)}`);
  }
  console.log(`PASS resources/list: ${widget.uri} present (mimeType ${widget.mimeType || '?'})`);

  // 2. Health (public, no key needed).
  const health = await mcpRequest('tools/call', { name: 'health', arguments: {} });
  if (!health.structuredContent || health.structuredContent.status !== 'ok') {
    throw new Error(`health failed: ${JSON.stringify(health)}`);
  }
  console.log('PASS tools/call health:', JSON.stringify(health.structuredContent));

  // 3. Missing-key behavior: with no CUELINGUA_API_KEY, create_flashcard must
  //    return a clean error mentioning the env var (no live write attempted).
  if (!process.env.CUELINGUA_API_KEY) {
    const result = await mcpRequest('tools/call', {
      name: 'create_flashcard',
      arguments: { front: 'Q', back: 'A' },
    });
    if (!result.isError || !JSON.stringify(result.content).includes('CUELINGUA_API_KEY')) {
      throw new Error(`expected missing-key error, got: ${JSON.stringify(result)}`);
    }
    console.log('PASS tools/call create_flashcard without key → clean error');

    // get_due_flashcards is also key-gated (backend requires the key in prod).
    const dueResult = await mcpRequest('tools/call', {
      name: 'get_due_flashcards',
      arguments: {},
    });
    if (!dueResult.isError || !JSON.stringify(dueResult.content).includes('CUELINGUA_API_KEY')) {
      throw new Error(`expected missing-key error for get_due_flashcards, got: ${JSON.stringify(dueResult)}`);
    }
    console.log('PASS tools/call get_due_flashcards without key → clean error');

    // create_deck is also key-gated.
    const deckResult = await mcpRequest('tools/call', {
      name: 'create_deck',
      arguments: { name: 'D' },
    });
    if (!deckResult.isError || !JSON.stringify(deckResult.content).includes('CUELINGUA_API_KEY')) {
      throw new Error(`expected missing-key error for create_deck, got: ${JSON.stringify(deckResult)}`);
    }
    console.log('PASS tools/call create_deck without key → clean error');

    // attach_image is also key-gated.
    const imgResult = await mcpRequest('tools/call', {
      name: 'attach_image',
      arguments: { id: 'card-1', url: 'https://example.com/pic.jpg' },
    });
    if (!imgResult.isError || !JSON.stringify(imgResult.content).includes('CUELINGUA_API_KEY')) {
      throw new Error(`expected missing-key error for attach_image, got: ${JSON.stringify(imgResult)}`);
    }
    console.log('PASS tools/call attach_image without key → clean error');

    // start_review_session is also key-gated.
    const sessionResult = await mcpRequest('tools/call', {
      name: 'start_review_session',
      arguments: {},
    });
    if (!sessionResult.isError || !JSON.stringify(sessionResult.content).includes('CUELINGUA_API_KEY')) {
      throw new Error(`expected missing-key error for start_review_session, got: ${JSON.stringify(sessionResult)}`);
    }
    console.log('PASS tools/call start_review_session without key → clean error');

    // The whole-library tag tools are also key-gated (list is read-only;
    // rename/delete/merge mutate cards — none may attempt a live call
    // without a key).
    const tagCalls = [
      { name: 'list_tags', arguments: {} },
      { name: 'rename_tag', arguments: { from: 'a', to: 'b' } },
      { name: 'delete_tag', arguments: { name: 'a' } },
      { name: 'merge_tags', arguments: { from: 'a', to: 'b' } },
    ];
    for (const call of tagCalls) {
      const tagResult = await mcpRequest('tools/call', call);
      if (!tagResult.isError || !JSON.stringify(tagResult.content).includes('CUELINGUA_API_KEY')) {
        throw new Error(`expected missing-key error for ${call.name}, got: ${JSON.stringify(tagResult)}`);
      }
    }
    console.log('PASS tools/call list_tags/rename_tag/delete_tag/merge_tags without key → clean errors');
  } else {
    // Key present: verify validation rejects empty front without writing.
    const result = await mcpRequest('tools/call', {
      name: 'create_flashcard',
      arguments: { front: '', back: 'A' },
    });
    if (!result.isError) {
      throw new Error(`expected validation error, got: ${JSON.stringify(result)}`);
    }
    console.log('PASS tools/call create_flashcard empty front → clean validation error (no write)');

    // start_review_session never accepts a client limit (the queue is the
    // uncapped snapshot): the tool must reject it client-side (no write).
    const sessionLimitResult = await mcpRequest('tools/call', {
      name: 'start_review_session',
      arguments: { limit: 101 },
    });
    if (!sessionLimitResult.isError) {
      throw new Error(`expected validation error for start_review_session limit, got: ${JSON.stringify(sessionLimitResult)}`);
    }
    console.log('PASS tools/call start_review_session limit → clean validation error (no write)');
  }

  await bodyLimitSmoke();
  console.log('\nSMOKE OK');
  child.kill();
  await new Promise((resolve) => backend.close(resolve));
  process.exit(0);
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err.message);
  process.exit(1);
});
