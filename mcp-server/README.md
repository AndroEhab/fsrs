# FSRS Flashcard MCP Server (ChatGPT Apps SDK)

MCP server that lets ChatGPT **create, bulk-create, list, get, update,
bulk-update, delete, bulk-delete, review, retrieve-due** FSRS flashcards,
**manage decks** (create/list/get/update/delete), **manage tags**
(list/rename/delete/merge — whole-library derived-tag operations),
**attach/list/remove card images by URL**, and **import/export Anki .apkg
packages** through the Model Context Protocol (MCP) — the Apps SDK platform
surface. It is a **pure bridge**: every MCP tool calls the already-deployed
Firebase Functions HTTP API in `functions/`
(`https://us-central1-cuelingua.cloudfunctions.net`) using the same contract
as `chatgpt/openapi.yaml`, authenticating with the `X-API-Key` header, and —
for authenticated HTTP `/mcp` requests — forwarding the caller's **verified
Auth0 Bearer token** as `Authorization` so the backend scopes the operation
to that user (identity propagation, request-scoped).

This is the **primary** ChatGPT integration. The Custom GPT Action in
`chatgpt/` is **superseded** — see `chatgpt/README.md`.

## Tools

| Tool | Backend call | Purpose |
| --- | --- | --- |
| `health` | `GET /health` | Service reachability (public, no API key) |
| `create_flashcard` | `POST /createFlashcardHandler` | Create a card (front/back, optional deckId/deck/tags) |
| `bulk_create_flashcards` | `POST /bulkCreateFlashcardsHandler` | Atomically create up to 100 cards in one request (single Firestore batch, all-or-nothing) |
| `list_flashcards` | `GET /listFlashcardsHandler` | List with `deckId`/`deck`/`tags` (ANY-of) filters + `pageSize`/`pageToken` pagination |
| `get_due_flashcards` | `GET /dueFlashcardsHandler` | Cards due for review now (new + scheduled), earliest due first, optional `deckId`/`deck` + pagination |
| `search_cards` | `GET /searchCardsHandler` | Rich query: combined filters (AND across families) — `search` (topic/front/back, case-insensitive), `tagsAny`/`tagsAll`/`tagsNot` (one of three), `review` (due/notDue/new/reviewed), `decks` + `deckNames` (ANY-of union), `suspended`, `createdFrom`/`createdTo`/`updatedFrom`/`updatedTo` (inclusive date bounds) — ordered createdAt desc (id asc ties), opaque cursor `pageToken`/`nextPageToken` (must pair with identical filters). Cards carry optional `topic` (label) and `suspended` (default false) fields set via create/update/bulk |
| `count_flashcards` | `GET /countFlashcardsHandler` | Lightweight deck statistics — counts WITHOUT fetching card records (Firestore count() aggregations): `total`/`new`/`learning`/`mature`/`due`, optional `deckId`/`deck`/`tags` filters (AND; deckId wins over the legacy `deck` name, answers "how many cards are in Spanish?"), or a standalone whole-library `groupBy=deck` breakdown (per deck entity + deck-less remainder; cannot be combined with the filters) |
| `start_review_session` | `POST /startReviewSessionHandler` | Start a persistent review session: the backend snapshots EVERY matching card into the session queue (never capped — v2 storage pages the snapshot into bounded `queueChunks` documents, 200 positions per chunk). **NO selectors → the standard DUE queue** (new + scheduled, earliest due first). Optional selectors (any combination): `deckId` (stable id) and/or `deck` (legacy name; `deckId` wins), `tags` (ANY-of), `cardIds` (explicit allowlist, deduped, every id must exist; combined with deck/tags by INTERSECTION). Selector-defined sessions may include NON-due cards; REVIEW_TEST_MODE only widens the DEFAULT due filter, never an explicit selection. Persists the session `source` metadata (`due` / `deck` name / `custom` — v2 provenance never carries card ids) + `cardType`/`name` (presentation-only); reports mode, dueCount, remainingCount, and the bounded `currentPosition`/`queueWindow` (v2 roots never carry a full `cardIds` snapshot); a client-supplied `limit` is rejected |
| `get_review_session` | `GET /getReviewSessionHandler/{sessionId}` | Resume/read a session (any status) plus its current card (null when exhausted) and a BOUNDED `preloaded` window (up to SESSION_PRELOAD upcoming cards, each with its stable queue position) plus `currentPosition`/`queueWindow`; carries the session `cardType`/`name`; only the starting API key can read it |
| `submit_review` | `POST /submitSessionReviewHandler/{sessionId}` | Rate the session's expected current card (1–4, optional `reviewAt`); optional `requestId` (idempotency key — same-key retries are no-ops) and `expectedCardId` (mismatch/already-rated → 409); atomically applies FSRS and advances the session — returns the updated session, next card, `requestId` echo, and an EMPTY `preloaded` array (the widget already holds the full monotonic buffer) |
| `end_review_session` | `POST /endReviewSessionHandler/{sessionId}` | Abandon an active session without rating the rest (idempotent; status → `ended`) |
| `get_flashcard` | `GET /getFlashcardHandler/{id}` | Read one card |
| `update_flashcard` | `PATCH /updateFlashcardHandler/{id}` | Partial update (assign/move/detach deck via deckId/deck) |
| `bulk_update_flashcards` | `POST /bulkUpdateFlashcardsHandler` | Atomically update up to 100 existing cards by id (single Firestore transaction, all-or-nothing) |
| `delete_flashcard` | `DELETE /deleteFlashcardHandler/{id}` | Delete a card |
| `bulk_delete_flashcards` | `POST /bulkDeleteFlashcardsHandler` | Atomically delete up to 100 cards by id (single Firestore transaction, all-or-nothing) |
| `reset_flashcards` | `POST /resetFlashcardsHandler` | Reset one or more cards to a brand-new state (`{ ids }`, ≤100 unique ids → `{ ids, count, cards }`): state New, due immediately, zeroed stability/difficulty/reps/lapses, empty reviewLog, no lastReview. Content/suspension untouched; atomic (missing ids omitted) |
| `set_due_date` | `POST /setFlashcardDueDateHandler` | Set the exact next-review time of one or more cards (`{ ids, due }` → `{ ids, count, cards }`); `due` = ISO 8601 date-time or `YYYY-MM-DD` (UTC midnight). ONLY `due` changes — FSRS state preserved. Atomic (missing ids omitted) |
| `suspend_flashcards` | `POST /suspendFlashcardsHandler` | Suspend one or more cards (`{ ids }` → `{ ids, count, cards }`): sets `suspended: true`; content + scheduling kept; selectable via `search_cards` `suspended: true` (never matches its review facet). Atomic (missing ids omitted) |
| `unsuspend_flashcards` | `POST /unsuspendFlashcardsHandler` | Unsuspend one or more cards (`{ ids }` → `{ ids, count, cards }`): removes the `suspended` field (absent = active). Atomic (missing ids omitted) |
| `create_deck` | `POST /createDeckHandler` | Create a deck (name, optional description); names are unique |
| `list_decks` | `GET /listDecksHandler` | List decks with `pageSize`/`pageToken` pagination |
| `get_deck` | `GET /getDeckHandler/{id}` | Read one deck |
| `update_deck` | `PATCH /updateDeckHandler/{id}` | Rename/describe a deck; rename rewrites the name on its cards |
| `delete_deck` | `DELETE /deleteDeckHandler/{id}` | Delete a deck — destructive to the deck but NOT its cards (cards are detached, preserved) |
| `attach_image` | `POST /attachImageHandler/{cardId}` | Attach an image to a card by URL (validated http(s), allowed MIME/extension, ≤5 per card) |
| `upload_image` | `POST /uploadImageHandler/{cardId}` | Upload an image (base64) to Firebase Storage; persists cloud metadata (id/storagePath/downloadUrl/contentType/sizeBytes), ≤10 MiB, raster MIME only (no SVG) |
| `list_card_images` | `GET /listImagesHandler/{cardId}` | List a card's image attachments (URL refs and cloud metadata: id, storagePath, downloadUrl, sizeBytes) |
| `remove_image` | `DELETE /removeImageHandler/{cardId}` | Remove an image attachment by its URL (removes only the card's reference, not the external file) |
| `list_tags` | `GET /listTagsHandler` | List the DISTINCT tags in the whole library (exact, case-sensitive names derived from cards — no tag collection), each with its card count, sorted by name ascending, `pageSize`/`pageToken` pagination (token = last tag name of the page). Read-only |
| `rename_tag` | `POST /renameTagHandler` | Rename a tag whole-library: replace `from` with `to` on every card carrying `from` (exact, case-sensitive; dedup when `to` already present; `from`/`to` must differ, 1–50 chars, spaces allowed). Missing `from` → no-op (`affectedCards: 0`); returns `{ affectedCards }` |
| `delete_tag` | `POST /deleteTagHandler` | Delete a tag whole-library: remove `name` from every card carrying it (exact, case-sensitive) — cards themselves untouched. **Destructive/irreversible**; missing name → no-op (`affectedCards: 0`); returns `{ affectedCards }` |
| `merge_tags` | `POST /mergeTagsHandler` | Merge a tag whole-library (UNION): remove `from` and ensure `to` on every card carrying `from` (deduped). `from` disappears; missing `from` → no-op (`affectedCards: 0`); returns `{ affectedCards }` |

| `get_review_history` | `GET /getReviewHistoryHandler` | Read the CURRENT API KEY's review-event history (actor-scoped), newest first: each event = id, cardId, actorId, rating, stateBefore, reviewedAt/recordedAt (ISO), stabilityAfter/difficultyAfter/repsAfter/lapsesAfter, dueBefore/dueAfter (ISO), deckId/deckName, cardFrontSnapshot (≤300), sessionId. Filters `from` (inclusive) / `to` (EXCLUSIVE — `[from, to)`) / `cardId` / `deckId` / `ratings` (array of 1=Again..4=Easy, ANY-of), `pageSize` (1–100, default 50), opaque `pageToken` (must pair with the same filters). Read-only |
| `get_study_stats` | `GET /getStudyStatsHandler` | FLAT read-time study statistics for the current API key within a REQUIRED reviewedAt window `from`/`to` (`[from, to)`, from inclusive, to exclusive; ISO 8601 or YYYY-MM-DD), optional `deckId`, optional `topLimit` (1–25, default 10): from, to, totalReviews, ratingCounts + ratingPercentages (again/hard/good/easy), observedRetention (successful 2/3/4 ÷ total), matureReviews (pre-state Review/Relearning), matureRatingCounts, matureRetention, topLapsedCards. LAPSE DEFINITION: ratingCounts.again counts EVERY Again; persisted `lapses`/topLapsedCards count only FSRS mature failures (Again from Review state). Read-only |
| `get_top_lapsed_cards` | `GET /getTopLapsedCardsHandler` | Rank the library's cards by CURRENT all-time lapse count: persisted `lapses` counts ONLY FSRS mature failures (Again from the Review state, the ts-fsrs rule — Learning/New/Relearning Agains never increment it), read at request time; zero-lapse excluded; indexed query; `limit` 1–25, default 10; optional `deckId`): cardId, lapses, reps, front, deckId/deckName, lastReview. Read-only |
| `migrate_review_events` | `POST /migrateReviewEventsHandler` | EXPLICIT operator maintenance migration: backfill `reviewEvents` from pre-event card-embedded reviewLog (newest-100 window; older trimmed entries unrecoverable). Requires `legacyActorId` (operator-supplied; never hardcoded); optional `pageSize`, `resumeAfterCardId`. Idempotent (deterministic ids + existence checks); returns `nextResumeAfterCardId` — pass it as `resumeAfterCardId` to continue exactly. NEVER automatic |
| `import_apkg` | `POST /importApkgHandler` | Import a standard Anki `.apkg` (base64-encoded ZIP containing a SQLite `collection.anki2`): each note → one flashcard (Front/Back or Cloze fields HTML→plain text, tags ≤30, deck found-or-created, nested names like `Spanish::Verbs` supported). `package` ≤ 20 MiB decoded, ≤ 1000 cards imported; malformed packages are rejected with NO partial writes (≤500 cards commit in one atomic batch); 0/2+ card notes and empty-field notes are skipped and reported (`skippedNotes`/`skippedEmpty`); optional `deckPath` overrides every card's deck. Returns imported cards + skip counts + `atomic`/`batchCount` |
| `export_apkg` | `POST /exportApkgHandler` | Export flashcards to a valid Anki `.apkg`: response `package` is the base64 .apkg (decode + save as `*.apkg`). No args → newest 1000 cards; `deck` (exact name/path) or `cardIds` (≤1000, deduped; missing ids omitted → `filteredCards`) select a subset (mutually exclusive). Review cards carry scheduling where Anki-compatible (type/queue/due day-ordinal, reps/lapses, FSRS reviewLog → revlog); cloze fronts (`[answer]`) export as Anki cloze notes; stored images are embedded only from PUBLIC https URLs (server fetches are DNS-pinned to public addresses, refuse private/link-local/metadata/loopback targets and plaintext http, and never auto-follow a redirect to them), bounded (4 MiB/file, 100 files, 8 MiB total) else reported in `mediaSkipped` with reasons. Content round-trips as TEXT (formatting is not preserved) |



## Review widget (`ui://review-session-v5`)

The server also registers a self-contained **Apps SDK review widget** as the
resource `ui://review-session-v5` (MIME `text/html;profile=mcp-app`): an
Anki-like card UI — front visible, tap to flip, then
**Again / Hard / Good / Easy** buttons wired to `submit_review` — with the
session's `modeTag` (e.g. `[Spaced repetition review · 12 cards due]`),
progress, and the **Finish / Continue review** choice when the session's
queue is exhausted (sessions are unlimited — the cap was removed; Continue
starts a NEW spaced-repetition session that replays the same snapshot). The
widget is a pure resource addition: hosts that cannot render `ui://`
resources keep the existing textual tool output. **Only `start_review_session`
advertises the UI linkage** (`_meta.ui.resourceUri` + the legacy
`openai/outputTemplate` alias) so the widget mounts exactly once;
`get_review_session` and `submit_review` are DATA-ONLY — their results carry
the hidden `_meta['ui/widgetState']` (never `ui.resourceUri`) so the
already-mounted widget hydrates from their direct calls without causing a
second mount. All dynamic data (front/back, session state) is JSON-serialized
into a `application/json` script block with `<` escaped — no string
interpolation reaches the HTML, so crafted card content cannot inject markup.

**Session source & per-card deck display.** Every session persists its
`source` metadata: `due` (no selectors), `deck` (deck-only selection, with
the deck name), or `custom` (any tags/card-ids/mixed selection, with the
selector details). The widget shows the source as a pill next to the deck
label — "Due cards", the deck name, or "Custom" — and the deck label ALWAYS
shows the CURRENT CARD's own deck name (falling back to the session `name`),
so a session name/source can never hide which deck a card belongs to, even
in mixed-deck custom/tag sessions. Continue on a **v2** session passes
`repeatSessionId` — the backend COPIES the finished session's chunked queue
verbatim (exact snapshot replay, never a fresh query that could differ from
what was reviewed); **legacy v1/no-version** sessions replay their selector
provenance (deck/tags/cardType/name), never widening to a plain due queue.

**Typed / cloze presentation (session-only, never stored).** Sessions accept
an optional `cardType` (`"qa"` or `"cloze"`) at start; it is persisted on the
session and carried by every get/submit/continue response so the presentation
mode resumes. For `cloze`, the first `[answer]` marker in the card `front` is
rendered as a blank input; for `qa`, the typed input evaluates against the
card `back`. Typed answers are checked **fully locally inside the widget**
(exact/normalized comparison with Unicode NFKC normalization, mirroring the
backend's `evaluateTypedAnswer` exactly): the normalized answer is compared
immediately against the stored card answer and the widget always shows
instant deterministic feedback — `correct` on an exact normalized match,
`incorrect` (with the expected answer) on any non-exact answer, `revealed`
when the user revealed instead of typing, `empty` when nothing was typed,
and `no-answer` when the card has no comparable expected answer (including
an expected answer that normalizes to empty, e.g. punctuation only). **No
ChatGPT/assistant call is ever made for answer assessment** — there is no
`evaluate_answer` or `record_answer_evaluation` tool, no `sendFollowUpMessage`
follow-up, and no evaluation polling; Check performs ZERO tool calls. The
user's FSRS rating (Again/Hard/Good/Easy) is chosen separately and never
coupled to correctness.

**Quiet session tools.** Session tool responses (`start_review_session`,
`get_review_session`, `submit_review`) use a MINIMAL model-facing output
schema — session `{ id, status, mode, currentIndex, reviewedCount,
remainingCount }` + card `{ id }` — and NEUTRAL text (session id, status,
current card id), so the assistant cannot narrate the session or current
card's front/back/progress; their descriptions instruct the model not to
speak about widget-driven session actions unless the user asks. The FULL
widget state (session, card front/back, preloaded) rides in the hidden Apps
SDK `_meta['ui/widgetState']` consumed by the widget (with
`_meta.ui.resourceUri` linkage and `openai/widgetDescription` on the resource
contents `_meta`). Text-only hosts
can still use `get_flashcard`/`get_review_session` for explicit
explanations. The session's persisted `cardType` is the sole
presentation config: a caller cannot change the mode per answer. This is a
**presentation** feature: the stored card `front`/`back` are never modified.

**Optimistic preloaded queue.** Every session response carries the next-card
`preloaded` window — up to SESSION_PRELOAD upcoming cards after the current
one (the SESSION queue itself is uncapped; each `submit` response also
returns the exact next card, so long sessions advance past the bounded
window). `start` builds it DIRECTLY from the already-fetched snapshot docs
(zero extra reads); `get` batch-fetches the remaining refs in one parallel
round. The widget renders the next card immediately after a rating, BEFORE
the submit round-trip resolves, and keeps the buffer MONOTONIC — a stale or
short response can never regress it, and the widget only shows completion
when every session card is locally accounted for. The widget keeps this as a MONOTONIC local queue: async
responses only ADD/update cards (merged by id, ordered by the session's
`cardIds`) and never replace or shrink it, so a stale/short response can
never regress the buffer. `submit` responses return an EMPTY `preloaded`
array on purpose (additive — the widget already holds the full buffer), so
concurrent ratings never trigger a full-queue reload (up to 99 serial reads
per rating in the old implementation). The in-flight server response (next
card + counters) is applied when it lands and ALWAYS wins, so the displayed
card is never the wrong one. Submissions are parallel per displayed card: a
rapid double-click on the SAME card is a no-op (never double-applies) and a
stale/already-rated `expectedCardId` is rejected (409, never rates the wrong
card). A failed submit re-syncs via `get_review_session` with the same
`requestId`/`expectedCardId`. The widget never exposes backend work to the
user: no 'Submitting' / request wording, no spinner, no disabled card from
other in-flight requests — each newly displayed card stays fully interactive,
and when the last locally-known card is rated while submits are still in
flight it shows a clean optimistic completion that reconciles to the
authoritative terminal state.

**Apps SDK bridge.** The inline script feature-detects `window.openai`, then
falls back to the standard iframe bridge: `window.parent.postMessage`
JSON-RPC where the VIEW
initiates the MCP Apps lifecycle handshake (`ui/initialize` with appInfo +
protocolVersion `2026-01-26`, then `ui/notifications/initialized` after the
host result; an inbound host-initiated `ui/initialize` is also answered), and
`tools/call` uses per-request ids with a `ui/notifications/tool-result`
listener. An UNSOLICITED initial `tool-result` notification (the host seeding
an empty bootstrap with the session tool's structuredContent) is applied so
the widget renders instead of staying blank; async `tools/call` responses
resolve through the same listener. Typed-answer Check is entirely local and
deterministic (see above) — the widget never sends the host's assistant any
answer-evaluation request. `scripts/check-widget-runtime.mjs` (part of
`npm run smoke`) boots the generated HTML in jsdom with a simulated host and
asserts zero startup errors + seeding + the waiter path + fully-local Check.

**v2 bounded session storage.** New review sessions (storageVersion 2) keep a
BOUNDED root document — no `cardIds`/`reviewedCardIds`/`processedRequestIds`
arrays — and shard the queue into `queueChunks` child documents (200 positions
per chunk). Session responses carry the bounded `queueWindow`
(`currentPosition` + the current card id and up to SESSION_PRELOAD upcoming
ids) plus persisted counters (`limit`, `remainingQueueCount`, `deletedCount`),
so the widget renders and rates WITHOUT the full queue: it submits by
`expectedPosition` (the current card's stable position) instead of needing the
whole id array, and `submit_review` responses echo the advanced position.
Legacy v1/no-version documents (full in-root arrays) keep the previous wire
shape and widget path unchanged; the widget detects the layout per session.

**Connector refresh is required after server changes.** Remove and re-add the
MCP connector so ChatGPT refreshes `tools/list`, the
`io.modelcontextprotocol/ui` capability, and the `ui://` resource metadata. If
the model can call `start_review_session` but no widget appears, the MCP call
path is working but the connector is using stale UI metadata; reconnect before
debugging the review backend. Confirm that `tools/list` exposes
`_meta.ui.resourceUri` for `start_review_session` and that `resources/read`
returns `text/html;profile=mcp-app`.

The widget resource URI is **versioned and bumped on every widget release**
(currently `ui://review-session-v5`, with NO alias on `…-v4`): because the
connector caches the widget code by URI, a bump forces ChatGPT to fetch the new
widget. **If you see TWO review widgets after a session action**, the connector
is still holding the cached tool schema from before the single-widget
decoupling (only `start_review_session` may mount the widget;
`get_review_session`/`submit_review` are data-only): remove the connector,
re-add it, and confirm `tools/list` shows the updated metadata.


## v2 review-session storage (bounded roots + queueChunks)

All NEW review sessions use storage layout **version 2**: a BOUNDED root
document (metadata only — never `cardIds`/`reviewedCardIds`/
`processedRequestIds`) plus a `queueChunks` subcollection that owns the queue
(≤200 positions per chunk document). Legacy v1/no-version documents (full
in-root arrays) keep their old storage and are read/advanced unchanged.

**Costs and limits**
- Session build: O(N) paged reads (due ASC, document-id ASC, `.select('due')`
  projection, ≤500 rows/page) and **ceil(N/200) chunk writes**, streamed as
  chunks fill (bounded memory — at most one partial chunk in RAM). Exact total
  comes from the build itself (no `count()` query). Explicit `cardIds`
  allowlists are validated against a documented hard bound
  (SESSION_MAX_ALLOWLIST_IDS = 5000; an oversized selection is rejected with a
  clear 400 — never truncated) and are fetched in bounded sequential batches
  (≤500 at a time), accumulating only compact (id, due) rows — never all card
  documents resident. Ordering is deterministic due ASC then document-id ASC
  in both paths; a missing allowlist id fails the request exactly.
- Session root: O(1) fields regardless of queue size.
- Responses (start/get/submit): O(1) root + a bounded window read of at most
  the ACTIVE + NEXT chunk — the current card plus up to SESSION_PRELOAD (100)
  upcoming cards, each with its REQUIRED stable `position`. Never the full
  queue; never a root array.
- Submit: one transaction (session root + target chunk + card reads + writes);
  claims never scan past the active/next chunk; deleted cards encountered
  while advancing are persisted as skips in the same transaction.
- Chunk doc size: ≤200 items (typically ≪ 1 MiB).

**Build lifecycle & cleanup**
- The root is written FIRST with `buildStatus:'building'` (status active,
  counts 0, NOT reviewable); chunks are then written; the root is finalized to
  `buildStatus:'ready'` with exact `totalCount`/`chunkCount`/`remainingCount`.
- A failed build marks the SAME root `buildStatus:'failed'` + `status:'failed'`
  (`buildFailed`/`buildError`) — get/submit throw a typed 409-style error.
- Cleanup is MANUAL (no automatic deletion/TTL by design): delete
  `reviewSessions/{id}` including its `queueChunks` subcollection for
  building/failed/completed sessions you no longer need. Completed sessions
  may be kept for history/Continue; a Continue (`repeatSessionId`) start COPIES
  the referenced session's chunks into a fresh session (items reset to
  pending) so the original stays untouched.

**Rollout order (per environment)**
1. Deploy Firestore indexes (`firestore.indexes.json`) — the paged builder
   needs the `due + __name__` composite set.
2. Deploy the backend functions.
3. Deploy/restart the MCP server.
4. Reconnect the widget host (the widget URI is bumped per release; cached
   clients must re-fetch `ui://review-session-v5`).

**Rollback**
- Only LEGACY (v1/no-version) sessions are readable/advanceable by the
  pre-v2 code path — roll back the backend to the previous release and legacy
  documents keep working exactly as before. NEW v2 sessions created under this
  release cannot be served by the pre-v2 backend without a data migration
  (chunks → in-root arrays), which is NOT provided; rolling forward again is
  safe because v2 reads tolerate the bounded layout only. There is NO
  production migration or deploy included in this change.

## Output contract

Matching the tool's output schema. Backend Firestore timestamps
(`{ _seconds, _nanoseconds }` wire format) are normalized to ISO 8601 in tool
outputs. Validation limits mirror the backend: `front`/`back` 1–10000 chars,
`deckId`/`deck` ≤100, `tags` ≤20 items each 1–50 chars, `rating` 1–4, and every
bulk operation is bounded at **100 items** (`BULK_LIMIT` in
`functions/src/flashcards/types.ts`).

**Card topic & suspension.** Cards carry two optional lifecycle fields settable through `create_flashcard`, `update_flashcard`, and the bulk tools: `topic` (a free-form subject-area label, up to 200 chars; `null` on update clears it) and `suspended` (boolean, default false; legacy cards without the field read as false). These are PERSISTED, FILTERABLE attributes only: the existing `list_flashcards`/`get_due_flashcards`/review-session endpoints never read them and behave exactly as before. They are queried exclusively through `search_cards` — `suspended: true|false` selects by state, and suspended cards never match its `review` facet (query them with `suspended: true`).

**Explicit scheduling management (reset / set-due / suspend / unsuspend).** Four dedicated tools mutate card lifecycle/scheduling state by explicit card id (`{ ids }`, 1–100 unique ids per call — the same cap as the bulk APIs; duplicate ids are rejected). They all commit atomically in one Firestore transaction and OMIT ids that do not exist from the result (never an error — the established bulk convention): the response is `{ ids, count, cards }` with the changed cards in input order.
- `reset_flashcards` — resets FSRS scheduling to a brand-new state: New, due immediately (server now), zeroed stability/difficulty/reps/lapses, empty `reviewLog`, `lastReview` removed. Content, deck, tags, topic, images and suspension are untouched. The card reads as new/due everywhere (due queues, review sessions, search facets, counts). Scheduling history is cleared, not archived.
- `set_due_date` — writes the exact `due` instant (`due` = full ISO 8601 date-time or `YYYY-MM-DD` → UTC midnight). ONLY `due` changes: the FSRS state fields and reviewLog are preserved, so the next `review_flashcard` schedules from the persisted state with the new due time.
- `suspend_flashcards` / `unsuspend_flashcards` — set / remove the persisted `suspended` flag. Suspension keeps content + scheduling untouched and is honored ONLY by `search_cards` (`suspended: true|false`; suspended cards never match its `review` facet) — `list_flashcards`/`get_due_flashcards`/review sessions do not read the flag and behave exactly as before.

**Card images come in two forms.** (1) External URL references: the backend
stores validated metadata (`url`, optional `alt`/`mimeType`, `addedAt`) —
never the image bytes; the URL must be `http(s)` and either declare an allowed
MIME type or end in a matching extension. (2) Cloud uploads via `upload_image`
(base64): bytes go to Firebase Storage under a card-scoped path and the card
stores `id`, `storagePath`, `downloadUrl` (signed URL), `contentType`,
`sizeBytes`, `alt`, `addedAt` — up to **10 MiB** decoded, raster MIME only
(jpeg/png/gif/webp/avif/bmp; SVG is not accepted for upload). A card holds at
most **5 images** (`MAX_CARD_IMAGES`). `remove_image` matches by URL and
removes only the card's reference (for cloud images the Storage object is
deleted); the externally hosted file is untouched.

**Count semantics (`count_flashcards`).** The backend counts with Firestore
`count()` aggregations — it never fetches a single flashcard document, so the
endpoint stays light regardless of library size. The `count()` aggregation is
REQUIRED: if the runtime lacks it the request fails cleanly rather than
falling back to reading card documents (the count contract is
aggregate-only). Buckets follow the persisted FSRS scheduling state:
`new` = never reviewed (FSRS state New, derived as
`total - learning - mature` so legacy documents without a persisted `state`
— which the backend reads as New — still count as new), `learning` = state
Learning (1), `mature` = states Review (2) + Relearning (3) (so
`new + learning + mature == total`), and `due` = `due <= now` — the exact
dueFlashcards/review-session due filter (new cards are due immediately, so
`due` overlaps the state buckets). Deck/tag FILTERS (`deckId`/`deck`/`tags`)
combine by AND and answer "how many cards are in Spanish?" / "…tagged verb?"; when both `deckId` and `deck` are given, `deckId` wins (the list/due convention).
`groupBy=deck` is a separate, WHOLE-LIBRARY breakdown: it is mutually
exclusive with those filters (a filtered per-deck breakdown is not expressible
with aggregates) and returns one entry per deck ENTITY (deck id + current
name; the deck-entity documents are the only non-flashcard reads) plus a final
`deckId`/`deck`-null entry for cards belonging to no deck entity (deck-less
cards plus unmigrated legacy cards whose `deck` string has no deck entity).
Legacy name-only cards are attributed to their deck via the `deck`-name
equality, so a deck never splits across entries. There is no tag-grouping
mode: tags exist only on card documents, so a per-tag histogram cannot be
produced without reading cards — tags are scoped via the `tags` filter
instead.

**Deck transformations are explicit batch/bulk operations, never silent
rewrites.** `update_deck` rename rewrites the denormalized `deck` name on
referencing cards (chunked batches); `delete_deck` detaches cards in chunked
batches and reports `detachedCards`; `bulk_update_flashcards` /
`bulk_delete_flashcards` commit atomically (single transaction). The stored `front`/`back` of cards are NEVER modified by any session or
widget feature — typed/cloze presentation and answer evaluation derive
everything at review time and leave the stored originals unchanged.

**Tag management is whole-library derived-tag rewrites.** Tags are NOT an
entity collection: every tag operation reads the stored `tags` arrays of the
flashcards themselves. `list_tags` scans the whole library (paged by document
id, aggregated in memory) and returns the DISTINCT tags with per-tag card
counts, sorted by name ASCENDING and paginated with the listDecks convention
(`nextPageToken` = the last tag name of the page — pass it back to resume
strictly after). Matching for all operations is EXACT and CASE-SENSITIVE:
the backend never normalizes, lowercases, or trims tag names, so the tools do
not either (a name differing by whitespace is a different, valid tag — use
`list_tags` to see the exact stored names). Each name is 1–50 characters and
may contain spaces; rename/merge require `from`/`to` to differ. Every
mutation returns `{ affectedCards }` — the number of CARD documents whose
`tags` array was rewritten — and commits in chunked batches (≤500 writes),
refreshing `updatedAt` on each rewritten card while preserving everything
else (content, deck, topic, images, suspension, FSRS scheduling). A tag name
that no card carries is a SUCCESSFUL NO-OP (`affectedCards: 0`), never an
error. `rename_tag` replaces `from` with `to` per card (deduped when `to`
already present — the outcome equals `merge_tags` for that card);
`delete_tag` removes `name` everywhere (**destructive and irreversible**,
annotated `destructiveHint`, and cards keep an empty `tags` array when that
was their only tag); `merge_tags` unions `from` into `to` (remove `from`,
ensure `to`, deduped) so `from` disappears library-wide.

## Architecture

```
ChatGPT (Apps SDK / MCP connector)
        │  MCP (Streamable HTTP at /mcp, or stdio)
        ▼
mcp-server/  (this package)
  src/config.ts    — env config (secrets from environment only)
  src/bridge.ts    — FirebaseBridge: HTTP client for the deployed functions
  src/tools.ts     — tool registration (zod schemas + handlers)
  src/index.ts     — transports: Streamable HTTP (/mcp) + stdio
        │  HTTPS: X-API-Key header (CUELINGUA_API_KEY)
        │  + Authorization: Bearer <verified Auth0 token> per request
        ▼
Firebase Functions (functions/) — named handlers, e.g.
  /createFlashcardHandler, /bulkCreateFlashcardsHandler, /listFlashcardsHandler,
  /dueFlashcardsHandler, /reviewFlashcardHandler/{id}, /getFlashcardHandler/{id},
  /updateFlashcardHandler/{id}, /deleteFlashcardHandler/{id},
  /bulkUpdateFlashcardsHandler, /bulkDeleteFlashcardsHandler,
  /createDeckHandler, /listDecksHandler, /getDeckHandler/{id},
  /updateDeckHandler/{id}, /deleteDeckHandler/{id}, /migrateDecksHandler,
  /listTagsHandler, /renameTagHandler, /deleteTagHandler, /mergeTagsHandler, …
        ▼
Cloud Firestore (flashcards + decks collections)
```

No state lives in the MCP server: each request is stateless and proxied to the
backend. The server never stores, logs, or prints the API key.

## Requirements

- Node.js **20.9+** (tested on 22)
- `CUELINGUA_API_KEY` — the API key for the deployed backend, from the
  environment only. The backend enforces it in production (missing/invalid →
  `401`); keys live in the Firestore `apiKeys` collection (see
  `functions/src/flashcards/service.ts`). "Production" = any non-emulator
  runtime (`FUNCTIONS_EMULATOR !== 'true'` — GCF does not set `NODE_ENV`, so
  the historical `NODE_ENV === 'production'` gate failed open; see
  `functions/src/environment.ts`). Rotate a key by adding a new document in
  `apiKeys` (doc id = key value, `revoked: false`), switching this server to
  the new key (update the Cloud Run `cuelingua-api-key` secret), then
  deleting / revoking the old document.
- A reachable backend. Default `FSRS_API_BASE_URL`:
  `https://us-central1-cuelingua.cloudfunctions.net`. For local development
  point it at the emulator (`http://127.0.0.1:5001/cuelingua/us-central1`) or
  the chatgpt mock (`http://127.0.0.1:8787`).

## Local setup

```powershell
Set-Location mcp-server
npm install

# Configure (copy to .env — gitignored — and fill in CUELINGUA_API_KEY).
Copy-Item .env.example .env

# Build once, then choose a transport.
npm run build
npm run start:http:local    # Streamable HTTP on http://127.0.0.1:8787/mcp
# npm run start:stdio       # MCP stdio
```

`start:http:local` binds only to loopback and disables the production Auth0
settings from `.env`, so it is suitable for a local desktop connector. The
server still uses the deployed Firebase Functions API unless
`FSRS_API_BASE_URL` points at an emulator or mock.

The equivalent direct commands, useful in a desktop MCP configuration, are:

```powershell
node --env-file-if-exists=.env scripts/launch-local.mjs http
node --env-file-if-exists=.env scripts/launch-local.mjs stdio
```

### Verify locally

```bash
npm test           # unit tests: bridge URL/headers/errors + tool definitions
                   # (no live HTTP; fetch is mocked)
npm run smoke      # starts the server, drives it over Streamable HTTP:
                   # tools/list, health, missing-key and validation errors
                   # (no live writes)
```

You can also use the official MCP Inspector:

```bash
npm run inspect    # npx @modelcontextprotocol/inspector@latest
# connect to http://localhost:8787/mcp (Streamable HTTP)
```

## Connecting to ChatGPT desktop

### STDIO

In **Connect to a custom MCP**, use these values:

| Field | Value |
| --- | --- |
| Name | `FSRS Flashcards (Local)` |
| Type | `STDIO` |
| Command to launch | `node` |
| Argument 1 | `--env-file-if-exists=.env` |
| Argument 2 | `scripts/launch-local.mjs` |
| Argument 3 | `stdio` |
| Working directory | `D:\fsrs\mcp-server` |

No environment variables are required; the launcher reads `.env` and selects
the stdio transport. The equivalent terminal command is:

```powershell
Set-Location mcp-server
node --env-file-if-exists=.env scripts/launch-local.mjs stdio
```

### Streamable HTTP

Start the local HTTP process:

```powershell
Set-Location mcp-server
node --env-file-if-exists=.env scripts/launch-local.mjs http
```

In the desktop form, select **Streamable HTTP** and use:

```text
http://127.0.0.1:8787/mcp
```

Do not run both transports under the same connector. STDIO is the simplest
local test; Streamable HTTP is useful for exercising the HTTP connector and
metadata path. Keep the HTTP server bound to `127.0.0.1` for local testing.

## Deploying the MCP server to a public HTTPS endpoint

For a hosted/web connector, use a **public HTTPS URL ending in `/mcp`**. The
local desktop connector can use the loopback URL above. The server is plain
Node (no framework), so it runs anywhere that can host Node 20.9+.

1. **Cloud Run (recommended)**: build a container image (Dockerfile below),
   push to Artifact Registry, deploy with `PORT` set by Cloud Run and
   `CUELINGUA_API_KEY` as a Secret Manager reference. Result:
   `https://<service>-<hash>.a.run.app/mcp`.
2. **Vercel / Render / Fly.io**: Node service, set
   `CUELINGUA_API_KEY`, `MCP_PORT`/`PORT`.
3. **Tunnel for local dev**: `ngrok http 8787` → connect
   `https://<subdomain>.ngrok.app/mcp` in ChatGPT's developer-mode connector.

```dockerfile
# mcp-server/Dockerfile — build with Node 20, run as non-root
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
```

```bash
# Cloud Run quick reference (adjust for your project/region)
gcloud builds submit --tag gcr.io/<project-id>/fsrs-mcp-server
gcloud run deploy fsrs-mcp-server --image gcr.io/<project-id>/fsrs-mcp-server \
  --region us-central1 --allow-unauthenticated --port 8080 \
  --set-secrets=CUELINGUA_API_KEY=cuelingua-api-key:latest
```

## Connecting to ChatGPT

1. Open ChatGPT → **Settings → Security and login → Developer mode**.
2. Go to [ChatGPT Plugins](https://chatgpt.com/plugins), select **+**.
3. Paste the public HTTPS URL **with `/mcp`** (e.g.
   `https://<service>-<hash>.a.run.app/mcp`), name it, describe it, **Create**.
4. Open a new chat, pick the plugin from the **More** menu, and prompt e.g.
   "Create a flashcard: front 'What is FSRS?', back 'Free Spaced Repetition
   Scheduler', deck 'spaced-repetition'".

Refresh the plugin connection after changing tools/metadata.

## Auth0-protected HTTP /mcp (RFC 9728)

When **both** `AUTH0_ISSUER` and `AUTH0_AUDIENCE` are set, the HTTP `/mcp`
endpoint enforces Auth0 RS256 JWT validation (via `jose` against the tenant's
JWKS). Unauthorized requests receive an RFC 9728 `WWW-Authenticate` challenge:

```
WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp"
```

The protected-resource metadata document is served at **both**:

- `GET /.well-known/oauth-protected-resource` (root-level path the ChatGPT MCP
  connector queries)
- `GET /.well-known/oauth-protected-resource/mcp` (the challenge target)

```json
{
  "resource": "https://cuelingua-mcp-767542644824.us-central1.run.app/mcp",
  "authorization_servers": ["https://andrewehab.eu.auth0.com/"]
}
```

The **stdio transport is unaffected** and remains usable without Auth0 —
local tools and debugging do not require any Auth0 configuration.

### Deploy-time auth guard (fail-closed)

An HTTP server whose backend is a REMOTE origin (the default
`https://us-central1-cuelingua.cloudfunctions.net`, or any non-loopback
`FSRS_API_BASE_URL`) **refuses to start without an authentication
mechanism**: Auth0 (`AUTH0_ISSUER` + `AUTH0_AUDIENCE`) or the static
`MCP_AUTH_TOKEN` bearer gate. This prevents an accidental public deployment
from exposing the server-held backend key (`CUELINGUA_API_KEY`) with no
authentication. Loopback-only development, stdio, and the local emulator/mock
backends never require auth. The explicit local override is
`MCP_AUTH_OPT_OUT=true` (also silences the startup warning) — use it only for
local desktop connectors / tunnels, never for a public deployment. The
launcher (`scripts/launch-local.mjs http`) sets this override automatically
because it binds to 127.0.0.1.

### Auth0 tenant prerequisites

The ChatGPT Apps SDK connector does **not** support machine-to-machine
(client-credentials) grants: it acts as an OAuth 2.1 **public client on the
user's behalf**, so the tenant must be configured for **user-delegated**
OAuth (authorization-code + PKCE `S256`). All options below share the same
API and server configuration:

1. Create an **API** (Audience) with the identifier:
   `https://cuelingua-mcp-767542644824.us-central1.run.app/mcp`
2. Ensure the tenant's JWKS is reachable at
   `https://andrewehab.eu.auth0.com/.well-known/jwks.json` (default).
3. Configure the MCP server with:
   - `AUTH0_ISSUER=https://andrewehab.eu.auth0.com/`
   - `AUTH0_AUDIENCE=https://cuelingua-mcp-767542644824.us-central1.run.app/mcp`
   - `MCP_RESOURCE_URL=https://cuelingua-mcp-767542644824.us-central1.run.app/mcp`

Then register the OAuth client with **user-delegated access** to that API.
The MCP server only validates `iss`, `aud`, signature, and expiration — grant
whatever scopes your users need (`openid` and `email` are recommended for
ChatGPT). Choose one of:

- **Dynamic Client Registration (DCR)** — ChatGPT's connector registers its
  OAuth client at add-time via the authorization server's
  `registration_endpoint` (`/oidc/register`). On this tenant DCR is
  **enabled**, but the tenant has exhausted its **application/entity quota**:
  every registration now returns `403 {"errorCode":"too_many_entities"}`,
  which surfaces in ChatGPT as *"An error occurred while adding the connector
  link"* BEFORE any MCP call. **Fix (tenant-side, no code change):** delete
  the stale `tpc_`-prefixed DCR applications created by failed connector
  attempts (Auth0 Dashboard → Applications), or raise the tenant's entity
  quota via Auth0 Support; then reconnect the connector once. Also enable
  **Resource Parameter Compatibility Profile** (Settings → Advanced) so the
  RFC 9728 `resource` parameter is honored, and authorize **Default
  Permissions for Third-Party Applications** on the API above so DCR clients
  get user-delegated access.
- **Regular Web App** — create a Regular Web Application (not M2M) in the
  tenant, allowlist ChatGPT's redirect URI (the callback-ID-specific
  `https://chatgpt.com/connector/oauth/{callback_id}`, or the stable
  `https://chatgpt.com/connector_platform_oauth_redirect` once the tenant
  enables "Include Issuer in Authorization Responses" / RFC 9207), and grant
  it **user-delegated access** to the API.
- **Client ID Metadata Document (CIMD)** — Auth0's recommended option for
  production MCP and the cleanest way around the DCR quota. Enable **Client
  ID Metadata Document Registration** in Settings → Advanced (this advertises
  `client_id_metadata_document_supported: true` in discovery, which ChatGPT's
  connector currently does NOT see), then import ChatGPT's client metadata
  URL (from the Apps SDK app management page) via Applications → Create
  Application → **Import from URL**, and grant user-delegated access to the
  API. Until CIMD is enabled, the connector must rely on DCR — which is
  currently blocked by the entity quota.

After the client is registered, ChatGPT runs the authorization-code + PKCE
flow and presents the access token as `Authorization: Bearer <token>` on
`/mcp` requests.

### Identity propagation (per-request, never stored)

The verified access token is **request-scoped and forwarded to the backend**:
after `gateRequest` validates the JWT, the raw token is handed to a
per-request `FirebaseBridge` instance (see `src/index.ts` →
`createAppServer(bearerToken)` and `FirebaseBridge.scoped()` in
`src/bridge.ts`), and every backend call that request makes sends it as the
`Authorization: Bearer <token>` header alongside the existing `X-API-Key`.
The deployed Firebase Functions backend then verifies the JWT again and scopes
the operation to the caller's verified `sub` (multi-tenant ownership).

- **Request-scoped, never global**: the token lives only on the one bridge
  instance created for that `/mcp` request. It is never written to the shared
  `ServerConfig`, never logged, and never reused for another request. stdio
  transports, the public `health` tool, and requests that bypass Auth0 (local
  emulator / `MCP_AUTH_OPT_OUT`) send **no** `Authorization` header — those
  paths keep talking to the backend with `X-API-Key` only (emulator-open
  behavior preserved).
- The backend is the single authority: it re-verifies issuer/audience/signature
  and derives the owner from the verified `sub`, so a caller can never spoof
  another user's identity by choosing headers.
- **Deploy requirement:** the deployed Firebase Functions backend must be
  configured with the SAME `AUTH0_ISSUER`/`AUTH0_AUDIENCE` (see
  `functions/.env` in the repo root — firebase-tools loads it on every
  functions deploy) plus `AUTH0_OPERATOR_SUBS` for operator routes. If the
  functions are not configured, every proxied backend call 401s — the token
  still propagates, but the backend fails closed.

## Configuration reference

| Env var | Default | Purpose |
| --- | --- | --- |
| `CUELINGUA_API_KEY` | *(none)* | Backend API key → `X-API-Key` header. **Never committed.** The verified incoming Auth0 token is forwarded automatically as `Authorization` per request (no env var needed). |
| `FSRS_API_BASE_URL` | `https://us-central1-cuelingua.cloudfunctions.net` | Deployed backend base URL |
| `MCP_PORT` | `8787` | HTTP port (falls back to `PORT`) |
| `MCP_HOST` | `0.0.0.0` | HTTP bind host |
| `MCP_TRANSPORT` | `http` | `http` (Streamable HTTP `/mcp`) or `stdio` |
| `MCP_AUTH_TOKEN` | *(none)* | Optional static `Bearer` gate on `/mcp` (defense in depth behind a tunnel). Counts as an auth mechanism for the deploy-time guard. |
| `MCP_AUTH_OPT_OUT` | *(unset)* | Explicit override allowing an HTTP server to run with NO auth against a REMOTE backend. Local tunnels / desktop connectors only (`scripts/launch-local.mjs` sets it). Never set on a public deployment. |
| `FSRS_REQUEST_TIMEOUT_MS` | `15000` | Fetch timeout to the backend |
| `AUTH0_ISSUER` | *(none)* | Auth0 tenant URL (e.g. `https://andrewehab.eu.auth0.com/`). **Required for Auth0 enforcement on HTTP /mcp.** |
| `AUTH0_AUDIENCE` | *(none)* | Expected audience (the MCP resource URI, e.g. `https://cuelingua-mcp-767542644824.us-central1.run.app/mcp`). **Required for Auth0 enforcement.** |
| `MCP_RESOURCE_URL` | `https://cuelingua-mcp-767542644824.us-central1.run.app/mcp` | Public HTTPS URL of this MCP server's `/mcp` endpoint. Used in RFC 9728 protected-resource metadata and `WWW-Authenticate` challenge. |
| `REVIEW_TEST_MODE` | *(unset)* | **Temporary widget-testing mode.** Must mirror the backend flag. When `true`: sessions queue ALL cards (not only due — a query override, no card mutations) and `submit_review` advances the session but SKIPS the card FSRS scheduling/reviewLog write. Session results carry `testMode: true` / `_meta['review/testMode']`. **Disable by unsetting/`false` on BOTH the Firebase function and the MCP server, then redeploy.** Never enable it by editing `functions/.env` — firebase-tools loads that file into every functions deploy, so a stale `true` silently deploys the non-mutating mode. Toggle it with explicit `gcloud functions deploy --set-env-vars` / `--remove-env-vars` instead, and keep `functions/.env` at `false`. |

## REVIEW_TEST_MODE (widget testing) — toggle procedure

**What it does (backend-authoritative, functions env `REVIEW_TEST_MODE=true`):**
- `startReviewSession` queues ALL cards when NO selectors are given — the `due <= now` filter is dropped (a query override; card `due` fields are NEVER mutated), and the session document PERSISTS `testMode: true` at start. When ANY selector is present, the selector query is authoritative — test mode never widens an explicit selection.
- `submitSessionReview` advances the session (currentIndex/reviewedCount/ratingCounts/status) but does NOT write FSRS scheduling or `reviewLog` to any card. The skip is gated by `session.testMode === true || env REVIEW_TEST_MODE` — a session started in test mode stays non-mutating even if the env flag is disabled mid-session; sessions started normally remain normal.
- `review_flashcard` and `dueFlashcards` behavior is unchanged (normal scheduling still applies outside review sessions).

**Enable:**
1. Firebase: `gcloud functions deploy startReviewSessionHandler submitSessionReviewHandler --set-env-vars REVIEW_TEST_MODE=true` (or via Firebase config).
2. MCP: set `REVIEW_TEST_MODE=true` on the Cloud Run service: `gcloud run services update cuelingua-mcp --update-env-vars REVIEW_TEST_MODE=true`, then deploy/rollout.
3. ChatGPT: refresh/reconnect the MCP connector (Settings → Developer mode → Plugins → remove and re-add) so the updated `description` (TEST MODE ACTIVE) is fetched.

**Disable (restore normal behavior):**
1. Firebase: remove/set `false` in `functions/.env` (the shipped default — the file must read `REVIEW_TEST_MODE=false`), then `firebase deploy --only functions:startReviewSessionHandler,functions:submitSessionReviewHandler` (or `gcloud functions deploy … --remove-env-vars REVIEW_TEST_MODE`).
2. MCP: `gcloud run services update cuelingua-mcp --remove-env-vars REVIEW_TEST_MODE`, then deploy/rollout.
3. Refresh the connector again. Cards are untouched throughout — no data was mutated, so no repair is needed. NOTE: any session that was STARTED while the flag was on keeps `testMode: true` persisted and will continue skipping card writes until it ends — that is intentional (no mid-session mutation switch).

## Notes / limitations

- Scheduling is implemented with the FSRS algorithm (via `ts-fsrs` in the
  backend): new cards are due immediately, and `review_flashcard` ratings
  (Again/Hard/Good/Easy) advance each card's due time through the FSRS
  scheduler. Card summaries include the scheduling state (`state`,
  `stability`, `difficulty`, `reps`, `lapses`, `lastReview`, `reviewLog`).
- The package registers a self-contained review widget as the `ui://review-session-v5`
  resource (Apps SDK `ui://`); hosts that cannot render resources keep the
  textual tool output. Tool schemas are unchanged by the widget.
- Keep the tool contract in sync with `functions/src/index.ts`,
  `functions/src/flashcards/` (validators/service), and `chatgpt/openapi.yaml`.
