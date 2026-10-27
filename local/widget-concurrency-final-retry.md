# Widget Concurrency Defect — Final Report

## Verification Commands

| Command | Result |
|---------|--------|
| `npm --prefix mcp-server run build` | ✅ Clean (tsc, ~4s) |
| `npm --prefix mcp-server test -- --testPathPattern='widget\.test'` | ✅ 70/70 passed |
| `node mcp-server/scripts/check-widget-runtime.mjs` | ✅ WIDGET RUNTIME OK (25 PASS) |

## Changed Symbols

### `mcp-server/src/widget.ts` (embedded client script)
- **New vars**: `pendingSubmits` (FIFO queue), `submitInFlight` (serial gate), `maxOptimisticReviewed` (monotonic floor)
- **`rate()`**: Enqueues via `pendingSubmits.push(item); processNextSubmit();` instead of calling `submitItem()` directly. Removed `disableControls()`.
- **New `processNextSubmit()`**: FIFO drain — fires one submit at a time.
- **`submitItem()`**: Removed duplicate `clearInflightItem(item)` on success path. Added `submitInFlight = false; processNextSubmit();` on success + error paths. Error path sets `item.recovery = true` before `syncAfterSubmit()`.
- **`syncAfterSubmit(gen, recovery)`**: New `recovery` param forwarded to `adoptServerState()`.
- **`adoptServerState(session, card, preloaded, recovery)`**: New `recovery` param. Stale-snapshot guards (index, reviewedCount, maxOptimisticReviewed) bypassed when `recovery` is true.
- **`render()`**: Reviewed count uses `Math.max(maxOptimisticReviewed, reviewedCount + optimistic)` — monotonic floor prevents regressions.
- **`requestEnd()` / `adoptEndResult()`**: Clear `pendingSubmits = []`.

### `mcp-server/src/widget.test.ts`
- Updated 6 test expectations to match FIFO queue pattern (`pendingSubmits`, `processNextSubmit`, `recovery` flag, relaxed `adoptServerState` signature assertions).

### `mcp-server/scripts/check-widget-runtime.mjs`
- **4d2**: Rewritten from parallel-concurrent to FIFO-serial: 3 rapid clicks → 1 initial submit, drain in c1→c2→c3 order, reviewed=3 optimistic pre-ack, stale snapshot cannot regress.
- **4d1b**: Updated progress assertion to expect `1 reviewed` (optimistic delta now included in reviewed count).
- **4d1c**: Updated long-session (12 cards) for FIFO: 1 initial submit, sequential drain, FIFO order verified.

## Acceptance Criteria
1. ✅ FIFO queue: at most one `submit_review` in flight.
2. ✅ UI responsive: every click optimistically advances card, reviewed, remaining, progress (no button disabling).
3. ✅ Stale snapshots never decrease reviewed or increase remaining (`maxOptimisticReviewed` monotonic floor + existing guards).
4. ✅ Failure recovery retains queued work via `recovery` flag bypass + `pendingSubmits` preserved.
5. ✅ Runtime regressions: 4d2 tests 3+ rapid ratings create 1 initial request, drain in click order, reviewed=3 optimistic, stale snapshot cannot regress.

## Unresolved Risk
- The `recovery` flag bypasses ALL stale guards for sync-after-failure responses. If a sync response is itself stale (e.g., the backend processed a different submit first), the recovery could adopt a wrong state. Mitigated by FIFO serial drain — only one submit is in flight at a time, so the sync response is always authoritative for that specific card.
