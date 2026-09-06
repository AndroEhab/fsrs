# Inspiration Collection — FSRS Review Widget Redesign

Direction is approved from the user-supplied screenshot. This collection curates references that support the approved airy-white review surface, with explicit borrow/avoid notes mapped to the component spec in `../ui-vision.md`. Provenance: all references below are agent-curated public references (no user-supplied assets beyond the approved screenshot, which lives in the user's possession as the source of truth).

## Reference Set

### 1. Anki Desktop (review screen)
- Layout: question card, typed answer, four rating buttons (Again/Hard/Good/Easy), progress header.
- **Borrow:** the four-button semantic rating row and the card-first hierarchy; the calm, distraction-free canvas.
- **Avoid:** its dated beige/grey chrome, cramped buttons, and unlabeled progress text.

### 2. Duolingo (lesson/practice cards)
- Layout: single large task card, slim progress bar at top, quiet helper captions, tinted answer/action tiles.
- **Borrow:** the slim top progress bar with a small caption; rounded, tinted, icon-free answer tiles; short helper line under the card.
- **Avoid:** gamified accents (streak flames, confetti), oversized mascot imagery, multi-column task layouts.

### 3. Quizlet (flashcard study mode)
- Layout: large white flashcard centered on a light canvas, flip interaction, typed-answer check, counters.
- **Borrow:** the large centered flashcard with a visible border and soft shadow; the "N reviewed · M left" counter convention; the typed-answer check flow.
- **Avoid:** its denser card chrome, left-aligned cramped header, and cluttered footer links.

### 4. Linear (application chrome, status pill + empty states)
- Layout: compact status pill top-left, quiet numeric metadata top-right, generous whitespace, hairline separators.
- **Borrow:** the compact rounded status pill with white-on-blue fill; quiet tabular-numeral counters; the airy white canvas and hairline borders; subtle focus rings.
- **Avoid:** its keyboard-centric density and command palette — the widget is a single-purpose review surface.

### 5. Apple Health / iOS system components (visual rhythm)
- Layout: white cards on a light grey canvas, rounded corners, soft shadows, semantic tinted icon tiles.
- **Borrow:** the rounded-corner radius language (`18px` cards, `12px` controls, `999px` pills); the soft low-opacity shadows; the semantic tinting (red/amber/green/blue) used with restraint.
- **Avoid:** the frosted-glass translucency and heavy SF-weight typography (keep system-ui stack).

### 6. Feynman / spaced-repetition study apps (e.g. Anymemo, Mochi)
- Layout: full-width answer input beneath the card, reveal/check split actions, quiet end-session link.
- **Borrow:** the full-width answer input with a bound label; the equal-width Reveal/Check action pair; the muted centered "End Session" text link at the bottom.
- **Avoid:** their dense toolbars and multi-pane layouts — the widget stays single-column.

### 7. Stripe Dashboard (data captions, numeric rhythm)
- Layout: small muted captions, tabular numerals, single blue accent on a white canvas.
- **Borrow:** `font-variant-numeric:tabular-nums` counters; the single-accent color discipline; the low-contrast inline feedback line.
- **Avoid:** dashboard density, tables, and sidebar chrome.

### 8. Modern flashcard apps (e.g. AnkiMobile redesigns, Brainscape)
- Layout: numbered rating tiles with semantic tinting, flip hint with a small icon.
- **Borrow:** the numbered-circle rating tiles with tinted backgrounds; the one-line flip hint with a tiny rotate icon.
- **Avoid:** skeuomorphic 3D card edges and noisy tile gradients.

## Borrow / Avoid Summary

| Element | Borrow from | Avoid from |
|---|---|---|
| Canvas | Linear, Apple Health (airy white, hairline) | Anki's beige chrome |
| Status pill | Linear (compact blue pill) | — |
| Counters | Quizlet, Stripe (tabular, quiet) | Dense dashboards |
| Deck pill | Linear (hairline pill) | Left-aligned raw labels |
| Progress bar | Duolingo (slim top bar) | Thick multi-color bars |
| Flashcard | Quizlet (large outlined white card, soft shadow) | Skeuomorphic 3D edges |
| Flip hint | Brainscape (icon + caption) | — |
| Answer input | Mochi (full-width, labeled) | Multi-pane input rows |
| Actions | Mochi (equal Reveal/Check) | Stacked/unequal buttons |
| Rating tiles | Anki semantics + Brainscape numbering + Duolingo tinting | Icon-only tiles, gradients |
| End Session | Mochi (quiet centered link) | Toolbar buttons |
| Feedback | Stripe (subtle inline line) | Toasts/modals |

## Coverage Gaps

- No reference covers the exact combined composition; the approved screenshot is authoritative for the composition, and the references above justify each individual component.
- Motion language is intentionally minimal (0.5s card flip, 0.25s progress width); no reference introduces decorative animation.
