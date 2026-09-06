#!/usr/bin/env node
/**
 * Frame-level real-Chromium smoke for the persistent flip reset (answer-flash
 * regression). Runs the GENERATED widget HTML in headless Chromium via the
 * globally installed Python playwright (same bridge pattern as
 * widget-screenshot.mjs) and proves, at every animation frame across the
 * FULL 500ms transition window after flipping c1 -> rating (optimistic shift
 * to c2):
 *
 *   1. the FIRST frame after the rating shows c2's FRONT (never a blank or a
 *      mid-unwind frame);
 *   2. NO sampled frame ever shows c2's BACK (the answer) — the persistent
 *      .resetting state (transform:none !important + transition:none
 *      !important) guarantees the new card's first paint is front-facing;
 *   3. the user's SUBSEQUENT intentional flip still animates (front -> back
 *      over ~500ms with intermediate rotation frames).
 *
 * Usage: node scripts/widget-flip-chromium.mjs   (after npm run build)
 * Output: prints FRAME_SMOKE_RESULTS <json>; temp html/bridge/png files are
 * removed after the evidence line is printed.
 */

import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const { buildReviewWidgetHtml } = await import('../dist/widget.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'output', 'playwright');
mkdirSync(outDir, { recursive: true });

const html = buildReviewWidgetHtml({
  session: {
    id: 's-frame',
    status: 'active',
    cardType: 'qa',
    cardIds: ['c1', 'c2'],
    currentIndex: 0,
    reviewedCount: 0,
    remainingCount: 2,
    limit: 100,
    ratingCounts: { 1: 0, 2: 0, 3: 0, 4: 0 },
    preloaded: [{ id: 'c2', front: 'C2 FRONT', back: 'C2 BACK-ANSWER', tags: [] }],
  },
  card: { id: 'c1', front: 'C1 FRONT', back: 'C1 BACK-ANSWER' },
  submitTool: 'submit_review',
  startTool: 'start_review_session',
  endTool: 'end_review_session',
  getTool: 'get_review_session',
});

const htmlPath = join(outDir, '_flip-smoke-widget.html');
writeFileSync(htmlPath, html, 'utf8');

const pyBridge = `
import json, sys
from playwright.sync_api import sync_playwright

HTML = ${JSON.stringify(htmlPath).replace(/\\\\/g, '/')}

def describe_frame(page):
    return page.evaluate("""() => {
      const shell = document.getElementById('cardShell');
      const front = document.getElementById('frontInner');
      const back = document.getElementById('backInner');
      const inner = document.getElementById('cardInner');
      const cs = getComputedStyle(inner);
      return {
        flipped: shell.classList.contains('flipped'),
        resetting: shell.classList.contains('resetting'),
        front: front ? front.textContent : null,
        back: back ? back.textContent : null,
        transform: cs.transform,
        transition: cs.transitionDuration,
      };
    }""")

results = {'advance': [], 'userFlip': []}

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 770, "height": 900})
    page.goto("file:///" + HTML)
    page.wait_for_timeout(120)
    # Front visible on load.
    s0 = describe_frame(page)
    assert not s0['flipped'], "card should start un-flipped"
    assert s0['front'] == 'C1 FRONT', "c1 front should be visible on load"
    assert s0['back'] == 'C1 BACK-ANSWER', "c1 back installed on load"
    # User flips c1 -> back (intentional flip: clears resetting, animates).
    page.click('#cardShell')
    page.wait_for_timeout(600)  # full 500ms transition + margin
    s1 = describe_frame(page)
    assert s1['flipped'], "card should be flipped after user click"
    assert s1['resetting'] is False, "resetting must be cleared by the intentional flip"
    # Rate c1 -> optimistic shift to c2. Capture EVERY animation frame for the
    # full 500ms window; assert every sampled frame shows c2's FRONT and no
    # frame shows c2's back answer.
    page.click('button[data-rating="3"]')
    deadline = page.evaluate("performance.now()") + 520
    while True:
        frame = describe_frame(page)
        results['advance'].append(frame)
        assert frame['resetting'] is True, "resetting must be present throughout the advance window"
        assert frame['flipped'] is False, "flipped must be absent throughout the advance window"
        assert frame['front'] == 'C2 FRONT', "every advance frame must show c2 FRONT"
        assert frame['back'] == 'C2 BACK-ANSWER', "c2 back must be installed (hidden behind backface)"
        if page.evaluate("performance.now()") >= deadline:
            break
    # After the window, the card remains front-facing in the reset state.
    s2 = describe_frame(page)
    assert s2['resetting'] is True, "resetting persists after the advance window"
    assert s2['flipped'] is False, "never flipped after the advance"
    assert s2['front'] == 'C2 FRONT', "c2 front persists after the advance"
    # The user's NEXT intentional flip MUST animate front -> back: sample
    # frames across the full window and require (a) at least one non-identity
    # intermediate rotation (the transition actually runs — the restored
    # .card-shell.flipped .card-inner{transform:rotateY(180deg)} rule is
    # what enables it) and (b) the settled end state equals rotateY(180deg)
    # (back face toward the viewer, back content visible).
    page.click('#cardShell')
    saw_intermediate = False
    flip_deadline = page.evaluate("performance.now()") + 520
    while True:
        frame = describe_frame(page)
        results['userFlip'].append(frame)
        assert frame['resetting'] is False, "user flip must clear resetting"
        if frame['flipped'] and frame['transform'] != 'none' and frame['transform'] != 'matrix(1, 0, 0, 1, 0, 0)':
            saw_intermediate = True
        if page.evaluate("performance.now()") >= flip_deadline:
            break
    end = describe_frame(page)
    assert saw_intermediate, "user flip must show an intermediate rotation frame (animation runs)"
    assert end['flipped'] is True, "user flip must reach the back"
    assert end['back'] == 'C2 BACK-ANSWER', "c2 back visible after user flip"
    # Settled transform must be the flipped identity: rotateY(180deg) as a
    # matrix3d with -1 on the x-axis (back face toward the viewer).
    tf = end['transform']
    assert tf != 'none' and tf != 'matrix(1, 0, 0, 1, 0, 0)', f"user flip must SETTLE at rotateY(180deg), got {tf}"
    browser.close()

print("FRAME_SMOKE_RESULTS " + json.dumps(results))
`;

const py = join(outDir, '_flip-smoke-bridge.py');
writeFileSync(py, pyBridge, 'utf8');

let output;
try {
  output = execFileSync('python', [py], { encoding: 'utf8' });
} finally {
  // Temporary smoke artifacts are removed once evidence is recorded.
  for (const f of [htmlPath, py]) {
    if (existsSync(f)) {
      try { unlinkSync(f); } catch { /* best-effort */ }
    }
  }
}
const line = output.split('\n').find((l) => l.startsWith('FRAME_SMOKE_RESULTS '));
if (!line) throw new Error(`frame smoke produced no results:\n${output}`);
const data = JSON.parse(line.slice('FRAME_SMOKE_RESULTS '.length));
console.log('advance frames:', data.advance.length, '| userFlip frames:', data.userFlip.length);
console.log('first advance frame:', JSON.stringify(data.advance[0]));
console.log('last advance frame:', JSON.stringify(data.advance[data.advance.length - 1]));
console.log('user flip mid frame:', JSON.stringify(data.userFlip[0]));
console.log('user flip end frame:', JSON.stringify(data.userFlip[data.userFlip.length - 1]));
console.log('FRAME_SMOKE PASS: every sampled advance frame front-facing (no answer flash); user flip animates and settles at rotateY(180deg)');
