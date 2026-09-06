# FSRS Review Widget — UI Vision

## 1. Product, Platform, Deliverable

| Field | Value |
|---|---|
| Product | FSRS MCP review widget (spaced-repetition flashcard review surface) |
| Platform | ChatGPT Apps SDK sandboxed iframe (`ui://review-session-v4`, MIME `text/html;profile=mcp-app`); desktop and mobile iframe widths |
| Deliverable | Redesign of the self-contained widget rendered by `mcp-server/src/widget.ts` (`buildReviewWidgetHtml`): inline HTML/CSS/JS, no new framework |
| Design artifacts | `design/ui-vision.md` (this file) + `design/inspiration/README.md` |
| Status | Direction APPROVED by the user (approved screenshot supplied); this document captures the approved target verbatim |

## 2. Approved Design Direction (verbatim target)

The approved screenshot is the source of truth. The redesigned widget must render exactly this composition:

1. **Airy white canvas** — a light, near-white page background with generous breathing room around every block; no dense or tinted page chrome.
2. **Compact rounded blue status pill at top-left** — small, fully rounded pill with a restrained near-white fill, a 1px blue border, and a blue dot + blue label showing the session mode ("Spaced repetition").
3. **Top-right reviewed/left counters** — a quiet, small counter line at the top-right ("N reviewed · M left") using tabular numerals.
4. **Centered deck pill** — the deck/session name in a small centered pill (white fill, hairline border), not a left-aligned label.
5. **Slim progress bar with status text above** — a small muted status caption ("active · N reviewed, M remaining") directly above a thin (≈4px) full-width bar; rounded track and a blue gradient fill.
6. **Large outlined white flashcard with subtle shadow and centered large answer text** — a large white panel with a visible outline/border, a very soft drop shadow, and large centered text (question on the front face, answer on the back face).
7. **Small flip hint with icon** — one line of muted helper text under the card with a small rotate/flip icon, telling the user to tap/space to flip.
8. **Full-width answer input** — a wide, comfortably padded text input for the typed answer ("Your answer…"), with a visible focus ring.
9. **Two equal outlined/blue action buttons with icons** — a pair of equal-width buttons beneath the input: "Reveal" (outlined/quiet) and "Check" (solid blue), each with a small inline icon.
10. **Four equal numbered rating tiles with tinted backgrounds** — four equal-width tiles (Again / Hard / Good / Easy) laid out in one row, each with a small numbered circle and a tinted background matching its semantic color.
11. **Centered quiet End Session control** — a small, muted, centered text button below the rating tiles ("End Session").
12. **Subtle inline feedback row** — a reserved, low-contrast status line at the bottom for inline feedback (correct / not quite / prompt messages), never a modal or toast.

## 3. Constraints (behavior is frozen)

This is a **visual redesign only**. The following behaviors MUST remain behaviorally identical; the inline script logic in `buildReviewWidgetHtml` is not altered except for pure presentation hooks:

- **Deterministic local answer check** — Check evaluates `evaluateLocalAnswer` fully in-widget (NFKC → lowercase → apostrophes/quotes→space → punctuation→space → whitespace collapse → trim), zero tool calls; outcomes: correct / incorrect / revealed / empty / no-answer.
- **True parallel submissions** — every rating dispatches immediately via `submitItem`; per-card `inflightByCard` guard prevents double-submitting the SAME card only; different cards submit concurrently; no single-flight gate.
- **Monotonic full-session queue** — preloads merge add/update-only; `seedQueueFromSession` rebuilds in authoritative `cardIds` order; a short/stale preload can never shrink the queue.
- **White-card prevention** — full cards cached by id (`cardCache`); id-only results resolve from the cache of the same id; `get_flashcard` fallback fills gaps; never a blank card, never a wrong card.
- **Flip handling** — 3D flip preserved on async re-render of the SAME card; a different card resets to front; Enter/Space keyboard flip.
- **Test mode / cloze presentation** — `cardType` qa/cloze presentation unchanged; cloze blanks the first `[answer]` marker; `modeTag` rendering unchanged.
- **Auth0/bridge behavior** — `window.openai` → `__MCP_HOST__` → postMessage JSON-RPC fallback chain, `ui/initialize` handshake, `ui/notifications/initialized`, tool-result notification handling, `toolOutput`/`toolResponseMetadata` hydration — all unchanged.
- **IDs/classes the script depends on** must keep their exact names: `app`, `modeTag`, `cardLabel`, `deckLabel`, `progress`, `progressFill`, `cardShell`, `cardInner`, `front`, `back`, `frontInner`, `backInner`, `hint`, `typed`, `typedPrompt`, `answerInput`, `revealBtn`, `checkBtn`, `ratings`, `endRow`, `endSessionBtn`, `done`, `doneTitle`, `finishBtn`, `continueBtn`, `status`, `bootstrap`, plus classes `hidden`, `flipped`, `disabled`, `cloze-blank` and `data-rating` values 1–4.

## 4. Design Principles (testable)

| # | Principle | Testable requirement |
|---|---|---|
| P1 | Airy white canvas | Page background is a near-white neutral (`#f8fafc` family); max content width ~560px with comfortable padding; no dense tinted panels |
| P2 | Clear hierarchy | Status pill (top-left) + counters (top-right) on one row; deck pill centered; progress bar; card; input; actions; ratings; end; feedback — in exactly that vertical order |
| P3 | Calm color system | Single blue accent for status/primary; semantic tinted tiles for ratings (red/amber/green/blue families); muted neutrals for helper text; all text/tile combinations meet WCAG AA contrast |
| P4 | Accessible by default | Native buttons/inputs; visible `:focus-visible` rings (buttons, input, card shell); labeled input (`label[for]`); `aria-live="polite"` feedback row; Enter/Space card flip; `prefers-reduced-motion` disables all transitions |
| P5 | Responsive | Layout adapts to current iframe widths: grid actions/tiles equal-width down to the narrowest supported iframe; large text uses fluid `clamp()` sizing; a ≤380px refinement step keeps the four tiles equal and tappable |
| P6 | Self-contained | Inline SVG icons only (no icon font/CDN); no new framework or runtime dependencies |

## 5. Component Spec

### 5.1 Header row
- `.top-row` flex, space-between.
- `.tag-pill`: restrained near-white fill `#f5f8ff`, 1px blue border `#c7d6f5`, blue text + blue dot, `border-radius:999px`, compact padding (≈4px 12px), 12px semibold, no fill shadow.
- `.counters` (`#cardLabel`): 12.5px semibold, muted, `font-variant-numeric:tabular-nums`.

### 5.2 Deck pill
- `.deck-row` centered; `.deck-label` (`#deckLabel`): white fill, 1px `--line` border, `border-radius:999px`, 12px semibold, subtle shadow.

### 5.3 Progress
- Status text (`#progress`) sits ABOVE the bar: 11.5px muted caption, `margin-bottom:6px`.
- `.progress-bar` below it: 4px track (`--line`-family), rounded; fill `linear-gradient(90deg,#60a5fa,#2563eb)`; width driven by the authoritative session snapshot (unchanged JS); `margin-bottom:18px`.

### 5.4 Flashcard
- `.card-shell` keeps `perspective:1200px`; `:focus-visible` ring on the shell.
- Card geometry matches the reference: at a 770px viewport the card is ≈644px wide and ≈208px tall. `.wrap` `max-width:680px` (with `padding:0 18px`) yields ≈644px content; `.card-inner` `min-height:208px`; ≤380px step reduces to 180px.
- `.card-face`: white fill, 1.5px `--line` border (the "outline"), `--radius:18px`, `box-shadow:0 12px 32px rgba(23,37,84,.09)` (the subtle shadow), centered flex, fluid large text `clamp(22px,4.5vw,30px)`, weight 650, `overflow-wrap:anywhere`.
- `.back-face`: same, slightly cool tint `#fbfdff` + `#dbe4f1` border.
- `.cloze-blank`: dotted blue underline, letter-spaced.

### 5.5 Hint
- `.hint`: centered flex row, 12.5px muted, inline rotate/flip SVG (aria-hidden) + text.

### 5.6 Answer row
- `#answerInput`: full width, 13px 14px padding, 1.5px border, `--radius-sm`, 15px font, focus ring 2px accent.
- `.typed-actions`: flex, 10px gap; both buttons `flex:1` (equal).
- `#revealBtn` `.ghost`: muted text, hairline border, eye icon.
- `#checkBtn` `.primary`: solid `--accent`, white text, check icon.

### 5.7 Rating tiles
- `.ratings`: `grid-template-columns:repeat(4,1fr)`, 9px gap.
- Each tile: column flex; `.num` 22px circle with `currentColor` border on a translucent white fill; `.label` 12.5px semibold; tinted background + tinted border per semantic class (`again` red, `hard` amber, `good` green, `easy` blue), hover deepens tint.

### 5.8 End Session
- `.end-row` centered; `#endSessionBtn` quiet: transparent, muted text, visible on hover with red tint.

### 5.9 Feedback row
- `#status`: 13px muted, `min-height:20px` reserved, `role="status" aria-live="polite"`.

### 5.10 Done panel
- White card, `--radius`, soft shadow; Finish (primary) + Continue review (hidden unless continuation available) — layout unchanged.

## 6. Accessibility Checklist

- [ ] All interactive elements are native (`button`, `input`) or keyboard-handled (`cardShell` Enter/Space).
- [ ] Visible `:focus-visible` outline (2px accent, 2px offset) on buttons, input, and card shell.
- [ ] `label[for="answerInput"]` binds the prompt to the input.
- [ ] Feedback row announces via `aria-live="polite"`.
- [ ] Contrast: muted text on canvas ≥ 4.5:1; tile text on tile tints ≥ 4.5:1; white on accent ≥ 4.5:1.
- [ ] `prefers-reduced-motion: reduce` kills flip, progress, and button transitions.
- [ ] SVGs are `aria-hidden="true"`; text labels carry meaning.

## 7. Non-Goals (explicitly out of scope)

- No behavior change to rating/submission/queue/sync/bridge logic.
- No new framework, icon library, or build tooling.
- No backend/schema/tool changes; `registerReviewWidget` contract unchanged.
- No theming/light-dark variants (single airy-white light theme).
- No new artwork/photography — iconography limited to the two action icons + flip icon.

## 8. Risks & Open Questions

| Risk | Mitigation |
|---|---|
| Iframe height clipping the taller card | Card content is fluid; `.wrap` bottom padding 40px; card min-height reduced via ≤380px media step |
| Host CSS leaking into the sandbox | Widget remains fully self-contained: explicit reset (`*{box-sizing}`), scoped classes, no external fonts |
| Test/runtime assertions pin old chrome strings | Update `widget.test.ts` + `check-widget-runtime.mjs` to assert the new observable structure (section 5) while preserving the behavior-contract assertions |
| Rating tiles too cramped at the narrowest width | 4 equal columns retained; ≤380px step shrinks gap/label to 11.5px |

## 9. Handoff Notes (for implementation)

- Single file: `mcp-server/src/widget.ts` — replace the `<style>` block and the static body markup inside the `buildReviewWidgetHtml` template literal; the `<script>` block is untouched.
- Keep the exact flip CSS tokens the tests assert: `perspective:1200px`, `transform-style:preserve-3d`, `backface-visibility:hidden`, `rotateY(180deg)`, `.card-face.back-face`, `.hidden { display:none !important; }`, `prefers-reduced-motion: reduce`, `class="tag-pill"`.
- The redesigned `.tag-pill` is the restrained near-white/blue-outline pill (NOT solid blue); `#progress` status text sits ABOVE `.progress-bar`; card geometry is ≈644px wide × 208px tall at 770px (`.wrap` 680px, `.card-inner` min-height 208px, 180px at ≤380px).
- Verification: `npm run build`, `npm test` (widget suite), `node scripts/check-widget-runtime.mjs`.
