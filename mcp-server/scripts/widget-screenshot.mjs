#!/usr/bin/env node
/**
 * Renders the GENERATED review widget HTML in a real headless Chromium at
 * desktop and narrow viewports and saves screenshots + measured top insets
 * (distance from the sandbox top edge to the first UI row — the mode pill).
 *
 * Run: node scripts/widget-screenshot.mjs   (after npm run build)
 *
 * Uses the globally installed Python playwright (chromium) via a tiny Python
 * bridge: the widget HTML is written to a temp file and opened with
 * file:// — no server needed. Outputs:
 *   output/playwright/widget-top-spacing-desktop.png  (770px wide)
 *   output/playwright/widget-top-spacing-narrow.png   (360px wide)
 * plus a printed JSON line with the measured insets at both widths.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { buildReviewWidgetHtml } = await import('../dist/widget.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'output', 'playwright');
mkdirSync(outDir, { recursive: true });

const html = buildReviewWidgetHtml({
  session: {
    id: 's1',
    status: 'active',
    cardType: 'qa',
    modeTag: '[Spaced repetition review · 2 cards due]',
    cardIds: ['c1', 'c2'],
    currentIndex: 0,
    reviewedCount: 0,
    remainingCount: 2,
    limit: 100,
    ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 },
  },
  card: { id: 'c1', front: 'What is the capital of France?', back: 'Paris' },
  submitTool: 'submit_review',
  startTool: 'start_review_session',
  endTool: 'end_review_session',
  getTool: 'get_review_session',
});

const htmlPath = join(outDir, '_top-spacing-widget.html');
writeFileSync(htmlPath, html, 'utf8');

const pyBridge = `
import json, sys
from playwright.sync_api import sync_playwright

targets = [
    {"name": "desktop", "width": 770, "height": 900, "file": ${JSON.stringify(join(outDir, 'widget-top-spacing-desktop.png'))}},
    {"name": "narrow", "width": 360, "height": 800, "file": ${JSON.stringify(join(outDir, 'widget-top-spacing-narrow.png'))}},
]

results = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    for t in targets:
        page = browser.new_page(viewport={"width": t["width"], "height": t["height"]})
        page.goto("file:///" + ${JSON.stringify(htmlPath)}.replace("\\\\", "/"))
        page.wait_for_timeout(120)
        page.screenshot(path=t["file"], full_page=False)
        inset = page.evaluate("""() => {
          const pill = document.querySelector('.tag-pill');
          const rect = pill.getBoundingClientRect();
          const style = getComputedStyle(document.getElementById('app'));
          return {
            pillTop: Math.round(rect.top),
            wrapPaddingTop: style.paddingTop,
            wrapMarginTop: style.marginTop,
          };
        }""")
        results.append({"name": t["name"], "width": t["width"], **inset})
        page.close()
    browser.close()

print("SCREENSHOT_RESULTS " + json.dumps(results))
`;

const py = join(outDir, '_top-spacing-bridge.py');
writeFileSync(py, pyBridge, 'utf8');

const output = execFileSync('python', [py], { encoding: 'utf8' });
const line = output.split('\n').find((l) => l.startsWith('SCREENSHOT_RESULTS '));
if (!line) throw new Error(`screenshot bridge produced no results:\n${output}`);
console.log(line.slice('SCREENSHOT_RESULTS '.length));
console.log(`saved: ${htmlPath}`);
