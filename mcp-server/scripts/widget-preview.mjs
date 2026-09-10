#!/usr/bin/env node
/**
 * Local browser preview for the review-session widget.
 *
 *   npm run preview          → build + serve at http://localhost:3333
 *   npm run preview:watch    → tsc --watch + serve + live-reload (one terminal)
 *
 * Edit CSS in src/widget.ts → tsc rebuilds dist/widget.js → page auto-refreshes.
 * Zero external dependencies; uses only Node built-ins + compiled widget.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST_WIDGET = join(ROOT, 'dist', 'widget.js');

// ── Sample bootstrap (representative review card) ──────────────────────
const BOOTSTRAP = {
  session: {
    id: 'preview-session',
    status: 'active',
    cardType: 'qa',
    modeTag: '[Spaced repetition review · 2 cards due]',
    cardIds: ['card-1', 'card-2'],
    currentIndex: 0,
    reviewedCount: 0,
    remainingCount: 2,
    limit: 100,
    ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 },
  },
  card: { id: 'card-1', deck: 'Preview', front: 'What is spaced repetition?', back: 'A learning technique that increases intervals between reviews of previously learned material.' },
  submitTool: 'submit_review',
  startTool: 'start_review_session',
  endTool: 'end_review_session',
  getTool: 'get_review_session',
};

// ── Live-reload snippet (SSE — no JS library) ──────────────────────────
const LIVE_RELOAD_SCRIPT = `
<script>
(function(){
  var src = new EventSource(location.pathname + '__lr');
  src.addEventListener('reload', function(){ location.reload(); });
  src.onerror = function(){ /* server gone, ignore */ };
})();
</script>`;

// ── Load & build widget HTML ────────────────────────────────────────────
async function buildHtml(injectLiveReload) {
  const fileUrl = pathToFileURL(DIST_WIDGET).href;
  const mod = await import(fileUrl + '?t=' + Date.now());
  let html = mod.buildReviewWidgetHtml(BOOTSTRAP);
  if (injectLiveReload) {
    html = html.replace('</body>', LIVE_RELOAD_SCRIPT + '\n</body>');
  }
  return html;
}

// ── SSE channels for live-reload ────────────────────────────────────────
const sseClients = new Set();

function notifyClients() {
  for (const res of sseClients) {
    res.write('event: reload\ndata: 1\n\n');
  }
}

// ── Server ──────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PREVIEW_PORT || '3333', 10);
const WATCH = process.argv.includes('--watch');

const server = createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // SSE endpoint for live-reload.
  if (url === '/__lr') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('event: connected\ndata: ok\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Vendored font files (./fonts/Inter-latin.woff2 etc.).
  if (url.startsWith('/fonts/')) {
    const FONTS = join(ROOT, 'fonts');
    const safeName = url.replace(/^\/fonts\//, '').replace(/[^a-zA-Z0-9._-]/g, '');
    const fontPath = join(FONTS, safeName);
    try {
      const data = readFileSync(fontPath);
      if (!data || data.length === 0) { res.writeHead(404); res.end('Empty'); return; }
      res.writeHead(200, { 'Content-Type': 'font/woff2', 'Content-Length': String(data.length), 'Cache-Control': 'public, max-age=86400' });
      res.write(data);
      res.end();
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  // Main widget page.
  if (url === '/' || url === '/index.html') {
    try {
      const html = await buildHtml(WATCH);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      const msg = `Build error:\n${err.stack || err}`;
      console.error(msg);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(msg);
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Widget preview: http://localhost:${PORT}\n`);
  if (WATCH) {
    startTscWatcher();
  } else {
    console.log('  Run with --watch for one-command live-reload.');
    console.log('  Or: npm run preview:watch');
  }
  console.log('  Ctrl+C to stop.\n');
});

// ── tsc --watch + dist polling ──────────────────────────────────────────
// Spawns `tsc --watch` so a single terminal does everything. Polls
// dist/widget.js mtime; on change reloads connected browsers.
function startTscWatcher() {
  console.log('  Starting tsc --watch…');

  // Resolve tsc entry point directly — avoids .bin/.cmd shell quirks on Windows.
  const tscEntry = join(ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js');
  const tsc = spawn(process.execPath, [tscEntry, '--watch', '--preserveWatchOutput'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  tsc.stdout.on('data', (d) => {
    const line = d.toString().trim();
    // tsc watch prints "Found 0 errors. Watching for file changes." on ready
    if (line.includes('Watching for file changes')) {
      console.log('  tsc ready — edit src/widget.ts and the browser will refresh.\n');
    }
  });

  tsc.stderr.on('data', (d) => process.stderr.write(`  [tsc] ${d}`));

  tsc.on('error', (err) => {
    console.error('  Failed to start tsc:', err.message);
    process.exit(1);
  });

  // Poll dist/widget.js for changes after tsc rebuilds.
  let lastMtime = 0;
  try { lastMtime = statSync(DIST_WIDGET).mtimeMs; } catch { /* not built yet */ }
  let debounce;

  const timer = setInterval(() => {
    try {
      const mtime = statSync(DIST_WIDGET).mtimeMs;
      if (mtime > lastMtime) {
        lastMtime = mtime;
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          console.log(`  [${new Date().toLocaleTimeString()}] dist/widget.js rebuilt → reloading browser`);
          notifyClients();
        }, 200);
      }
    } catch { /* file temporarily missing during build */ }
  }, 500);

  const shutdown = () => {
    clearInterval(timer);
    tsc.kill();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
