# FSRS Flashcards — CueLingua

Spaced-repetition (FSRS) flashcard service: a Firebase Functions backend plus
ChatGPT integrations.

## Layout

| `functions/` | Firebase Functions backend: Flashcard CRUD (single + bulk, up to 100 items, atomic Firestore batch/transaction) + list + review/due + Deck entities (`decks` collection: create/list/get/update/delete; cards reference decks by stable `deckId`, legacy `deck` name preserved; deleting a deck detaches cards without deleting them) + card image attachments (URL references and Firebase Storage uploads, ≤5 per card, ≤10 MiB) + persistent review sessions (`reviewSessions` collection: snapshot every matching card ordered by due — no session cap, with optional deck/tag/card-id selectors that may include non-due cards — atomic rating submission via FSRS, persisted source metadata, end/abandon; NEW sessions use the bounded **v2 storage layout** — a metadata-only root plus sharded `queueChunks` child documents (200 positions each), so a session document never grows with its queue) + countFlashcards (aggregate count() statistics — total/new/learning/mature/due by deck/tags, no card fetches) + tag management (list/rename/delete/merge — distinct tags derived from card `tags` arrays, no tag collection; missing names are no-ops) + health over named Cloud Functions, Firestore persistence, API-key auth (`X-API-Key` against the `apiKeys` collection, enforced in production).  Review-event analytics (append-only immutable `reviewEvents` written transactionally with every non-test direct/session review; `getReviewHistoryHandler` actor-scoped cursor pagination; `getStudyStatsHandler` count()-aggregated retention/rating stats; `getTopLapsedCardsHandler` current all-time ranking; explicit operator `migrateReviewEventsHandler`)|
| `mcp-server/` | **Primary ChatGPT integration (new):** MCP server (ChatGPT Apps SDK platform) that bridges ChatGPT to the deployed Firebase API. Tools: `create_flashcard`, `bulk_create_flashcards`, `list_flashcards`, `get_due_flashcards`, `review_flashcard`, `reset_flashcards`, `set_due_date`, `suspend_flashcards`, `unsuspend_flashcards`, `get_flashcard`, `update_flashcard`, `bulk_update_flashcards`, `delete_flashcard`, `bulk_delete_flashcards`, `create_deck`, `list_decks`, `get_deck`, `update_deck`, `delete_deck`, `start_review_session`, `get_review_session`, `submit_review`, `end_review_session`, `import_apkg`, `export_apkg` (answer assessment is fully local in the widget — no ChatGPT answer evaluation), `count_flashcards` (lightweight deck statistics via count() aggregates — no card fetches; answers "how many cards are in Spanish?"), `attach_image`, `upload_image`, `list_card_images`, `remove_image`, `list_tags`, `rename_tag`, `delete_tag`, `merge_tags`, `get_review_history`, `get_study_stats`, `get_top_lapsed_cards`, `migrate_review_events` (explicit operator backfill), `health`. Streamable HTTP at `/mcp` + stdio. |
| `chatgpt/` | **Superseded** Custom GPT Action (OpenAPI schema + mock + client). Kept as a migration reference for the backend contract. |

## Current integration: Apps SDK / MCP server (`mcp-server/`)

The recommended way to connect ChatGPT to the flashcard service is the MCP
server in [`mcp-server/README.md`](mcp-server/README.md). It exposes the
flashcard operations as MCP tools and proxies each call to the deployed
Firebase Functions API with the `CUELINGUA_API_KEY` environment variable
(`X-API-Key` header). The Firebase API key lives **server-side only** — it is
never sent to ChatGPT, never committed, and never exposed through the tools.

**Auth0-protected `/mcp` is implemented and deployed.** The HTTP `/mcp`
endpoint enforces Auth0 RS256 Bearer JWTs (via `jose` against the tenant's
JWKS) and serves the RFC 9728 protected-resource metadata document — live at
`https://cuelingua-mcp-767542644824.us-central1.run.app/.well-known/oauth-protected-resource`,
advertising authorization server `https://andrewehab.eu.auth0.com/`.
Unauthenticated `/mcp` requests receive a `401` with an RFC 9728
`WWW-Authenticate` challenge pointing at that metadata URL.

**The live ChatGPT connector is registered in Auth0.** Dynamic Client
Registration (DCR) is enabled, and ChatGPT has registered a public OAuth client
using authorization-code + PKCE `S256` for the MCP API audience above. Auth0's
resource-parameter compatibility profile and default third-party application
permissions are enabled, so new connector registrations receive the
user-delegated API access they need. See `mcp-server/README.md` →
"Auth0-protected HTTP /mcp (RFC 9728)".

## Superseded: Custom GPT Action (`chatgpt/`)

The Custom GPT Action (OpenAPI schema in `chatgpt/openapi.yaml` pasted into a
Custom GPT's Actions section, `X-API-Key` auth configured in the GPT editor)
is **superseded** by the MCP server. It is kept for migration reference — the
OpenAPI file is the authoritative description of the deployed backend routes
and wire format, and `chatgpt/mock-server.mjs` / `chatgpt/client.mjs` remain
useful for contract testing without Firebase. Do not configure new Custom GPTs
from `chatgpt/`.

## Development

```bash
# Backend unit tests (no Firestore emulator required)
cd functions && npm install && npm test

# Safe local Functions development (demo project; required datastores emulated)
cd functions && npm run serve

# Interactive Functions shell with Firestore + Storage emulators (stdin remains interactive)
cd functions && npm run shell

# Firestore-backed regression tests (each invocation starts/stops its own localhost emulator)
# Full datastore integration run
cd functions && npm run test:datastore
# Isolated enrollment-only suite
cd functions && node scripts/run-firestore-emulator-tests.cjs enrollment
# Rules-only suite
cd functions && npm run test:rules

# MCP server (current ChatGPT integration)
cd mcp-server && npm install && cp .env.example .env
npm test          # unit tests (no live calls)
npm run smoke     # live server smoke test (no live writes)

# Legacy chatgpt tooling (superseded, reference only)
cd chatgpt && npm install && npm run mock
```

### Anki package import/export

Anki imports validate the ZIP directory and inflate only `collection.anki2`;
media members are ignored because the library stores image references, not
package media. Export fetches an image only over HTTPS after validating and
pinning every DNS answer to a public address, and revalidates every redirect
(at most three hops). One shared eight-second deadline covers DNS, connections,
redirects, and response-body reads. A shared 8 MiB maximum-body allowance
limits all unique-URL attempts, including failures; each file is capped at
4 MiB. Failed, unsafe, timed-out, or over-budget URLs are reported
in `mediaSkipped`. Successful images receive collision-safe package names and
are referenced from the card's answer/back field because `CardImage` has no
front/back placement metadata.
Anki HTML-to-text conversion respects quoted attribute values while finding a
tag's closing `>`, and leaves unterminated tags as literal text. Export escapes
literal U+001F in front/back as `&#31;` after ampersand escaping, so it cannot
split Anki's `flds` fields; literal `&#31;` input remains literal text.

Scheduling export is approximate rather than lossless: New/Learning/Review/
Relearning state, Anki queue, suspension, and due timing are preserved where
the source fields provide them; due dates remain overdue when appropriate.
Learning/relearning progress is mapped to Anki's configured remaining-step
count, and the emitted step delays come from the scheduler's actual FSRS
parameters. Legacy active-learning cards without a provable progress index
fail export with a typed reset-scheduling-state error rather than being
silently changed to Review. FSRS stability only approximates Anki review
intervals; review-log intervals use the next retained pre-review due time
(short-term steps in seconds, review intervals in days). Unknown or truncated
boundaries are zero, not inferred from stability. Reviewed cards use Anki's
default 2500‰ SM-2 ease because no Anki-compatible FSRS memory state or SM-2
ease is stored. Card/note IDs use source creation timestamps with
adjacent-millisecond tie resolution. Truncated review history and manual
due-date changes cannot be reconstructed.
Anki import keeps at most 20 product tags; Anki export requires each tag to be
a single whitespace-free token and returns a typed error otherwise.
The importer requires `col`, `notes`, and `cards` to be ordinary SQLite
tables, and bounds models/decks metadata (1 MiB each) and tags (64 KiB) before
returning strings to JavaScript. Note fields cross SQLite as one streamed raw
BLOB only for eligible single-card notes; the importer scans field separators
as bytes and decodes only selected fields after enforcing the 256 KiB UTF-8
limits. It avoids JSON-quoting/duplicating full field strings. GUID
deduplication and card-count aggregation are set-based, not per-note queries;
duplicate GUIDs keep the lowest note ID and no GUID/NID index is required.
`skippedOverLimit` counts otherwise-importable single-card notes beyond the
1,000-card import limit instead of stopping early.
Single-card native cloze notes without hints or nesting map the active Anki
ordinal to the existing product `[answer]` marker; other deletion ordinals
remain visible, and Back Extra is preserved. Multi-card notes remain counted
in `skippedNotes`. Hints, nested or malformed clozes, empty/whitespace-only
active deletions, and literal square brackets that the product marker syntax
cannot represent return a typed import error rather than silently falling back
to Basic.

Export media uses generated safe `image-N` filenames, retaining an image
extension when known MIME metadata or a recognized URL suffix provides one.
The byte/count/deadline check precedes URL refresh/signing; after exhaustion,
only already-embedded URLs found in owned card snapshots are reused and other
snapshot URLs are reported as skipped without further signing or fetching.
The complete serialized APKG JSON response body (import or export) is capped
at 32,000,000 bytes. Oversized responses fail with a typed error rather than
truncating data; import checks before deck/card writes. Reduce selected export
cards or image references, or reduce imported package/card content.

Firebase project: `cuelingua` (see `.firebaserc`); functions deploy to
`us-central1`; emulator ports: functions 5001, Firestore 8080, Storage 9199,
UI 4000.

### Deploy safeguards

- **Firestore rules/indexes predeploy guard.** `firebase.json` runs
  `node scripts/firestore-deploy-guard.cjs` before any `firestore` deploy.
  It fails the deploy if `firestore.rules` / `firestore.indexes.json` are
  missing (a missing file would otherwise silently delete the live rules /
  wipe the index list) or malformed (JSON validity, required top-level
  arrays, rules brace balance + `rules_version`). Read-only; no network.
- **Functions upload hygiene.** The Firebase Functions source archive omits `functions/.tmp/` audit artifacts via `firebase.json`; those local artifacts are also ignored by Git.
- **Wrong-project protection.** The default Firebase project is pinned in
  `.firebaserc` (`cuelingua`). Before deploying to any other project, verify
  with `firebase use` — there is no automated cross-project gate.
- **Node 22 runtime** is pinned in `firebase.json` and
  `functions/package.json` (Node 20 is deprecated on GCF).

### Backend API-key + Auth0 auth (fail-closed, multi-tenant)

Every Cloud Functions handler requires a valid `X-API-Key` header **AND** a
valid Auth0 RS256 Bearer JWT in production. "Production" means **any
non-emulator runtime**: Google Cloud Functions does not set `NODE_ENV`, so the
old `NODE_ENV === 'production'` gate never fired and deployed handlers
silently accepted unauthenticated requests. The backend now detects
production as `FUNCTIONS_EMULATOR !== 'true'` (firebase-tools exports
`FUNCTIONS_EMULATOR=true` only inside the emulator) and 401s requests that
lack either credential there — see `functions/src/environment.ts`,
`functions/src/identity.ts` and the shared gate in `functions/src/index.ts`.
`firebase.json` additionally deploys `NODE_ENV=production` for defense in
depth.

- **X-API-Key** remains the transport credential (the MCP server sends it
  from `CUELINGUA_API_KEY`, Secret Manager on Cloud Run). It is verified
  against the `apiKeys` collection (document id = the key value; fields:
  `name`, `revoked`, `email`).
- **Bearer JWT** must be a valid Auth0 RS256 token for the configured
  `AUTH0_ISSUER`/`AUTH0_AUDIENCE`; its verified `sub` becomes the request
  ownerId that scopes every read/write. An API-key-only production request is
  rejected with 401 (it would otherwise expose unowned data). The MCP server
  forwards the caller's verified token as `Authorization` per request.
- Emulator/local development stays unauthenticated under the emulator marker
  and is scoped to the fixed `'emulator'` owner — never global. Startup now
  fails before Admin SDK initialization unless Firestore and Storage endpoints
  are loopback host:port values and the Storage SDK override, when present,
  matches. Use `npm run serve` for all three emulators or `npm run shell` for
  the interactive Functions shell with Firestore/Storage; both pin the
  `demo-fsrs-local` project.
- Functions run on the **Node.js 22** runtime (`firebase.json` +
  `functions/package.json` `engines`); Node 20 is deprecated on GCF and was
  blocking deployments after 2026-10-30.

### Deploying functions: `.env` is production config

`firebase-tools` automatically loads `functions/.env` environment variables
into every `firebase deploy --only functions`. Treat that file as production
state: never leave temporary testing flags enabled in it. In particular
`REVIEW_TEST_MODE` (widget testing) must stay `false` — when true, review
sessions queue ALL cards and `submitSessionReview` skips the card FSRS
scheduling/event writes (real reviews would silently not be scheduled).

Search query arrays `tagsAny`, `tagsAll`, `tagsNot`, `decks`, and `deckNames`
use repeated query parameters (for example, `tagsAny=core&tagsAny=red,blue`).
Each value is exact: commas and leading/trailing whitespace are part of the
tag or deck name, not CSV separators. The OpenAPI contract uses form-style
arrays with `explode: true`; list/count `tags` keep their existing separate
contract.
`search_cards` (`/searchCardsHandler`) orders by `createdAt` DESC with an
explicit document-id ASC secondary sort (`orderBy(FieldPath.documentId())`)
so same-`createdAt` ties page deterministically (id ASC). That query shape
requires the composite index `(createdAt DESC, __name__ ASC)`, declared in
`firestore.indexes.json`. Deploy it with `firebase deploy --only
firestore:indexes` (the functions `predeploy` build does not create indexes);
`firestore.indexes.json` also declares the composites for every other
code-issued query shape (review-history DESC pages, study-stats count()
ranges, due/search/top-lapsed filters) plus the `fieldOverrides` exemptions.

### Multi-tenant ownership (ownerId)

Every user-facing backend operation is scoped to an **ownerId** = the
verified Auth0 JWT `sub` of the caller (see `functions/src/identity.ts`).
Writes stamp `ownerId` on flashcards, decks, review-session roots and their
`queueChunks` / private `requestClaims` children, and review events; reads/lists/search/counts/deck/tag/history/
session/export queries filter `ownerId`; id-based mutations verify the target
document's `ownerId` equals the caller's before touching it. A cross-owner
document (or a pre-multi-tenant ownerless document) reads as **missing/404**
— it is never leaked, listed, mutated, or rated by another owner, and an
API-key-only production request is rejected with 401 before any service call.

**Environment requirements (deployed functions):** `functions/.env` must set
`AUTH0_ISSUER`, `AUTH0_AUDIENCE`, and optionally `AUTH0_OPERATOR_SUBS`
(comma-separated exact subs allowed to run operator routes). Without issuer +
audience every production request fails closed with 401. The values must match
the mcp-server's Auth0 config (same audience) so the token the MCP server
forwards as `Authorization` verifies at the functions hop. In the emulator
(`FUNCTIONS_EMULATOR=true`) requests stay open but are scoped to the fixed
owner `'emulator'` — dev data is never global. Identity headers
(`X-User-Id`, forwarded identity) are NEVER accepted; the backend derives the
owner exclusively from the verified JWT `sub`.

**Indexes (ownerId-led).** `firestore.indexes.json` now declares the
ownerId-led composite indexes for every owner-scoped query shape alongside the
legacy actorId/global ones: `flashcards` (ownerId + createdAt/due/state/
lapses/name, with deckId/deck/tags array-contains variants and the
`__name__` pagination tie-breaks), `decks` (ownerId + name, ownerId +
createdAt DESC), and `reviewEvents` (ownerId + cardId/deckId/rating/
stateBefore + reviewedAt DESC/ASC + `__name__`). Deploy with
`firebase deploy --only firestore:indexes` — the functions predeploy build
does not create indexes.

**Legacy (pre-multi-tenant) data policy — quarantine, not silent exposure.**
Documents written before this change carry NO `ownerId`. Owner-scoped user
requests can never see or mutate them (they read as missing; writes that would
touch them are refused/omitted), so no user ever silently inherits another
tenant's or the shared-era data. The data is NOT deleted. Reclaiming it is an
explicit, operator-only decision:

- **Quarantine option (default, no migration):** leave ownerless documents in
  place. They are invisible to every owner-scoped user surface and only an
  operator (verified `sub` in `AUTH0_OPERATOR_SUBS`) can interact with them
  through the operator routes. If the shared-era data was a single user's,
  the recommended end state is a one-time operator backfill assigning that
  user's `sub` as `ownerId` (then the data appears for exactly that user).
- **Backfill/ownership migration (planned, NOT executed):** an operator-only
  paged migration (mirroring the existing `migrateDecksHandler` /
  `migrateReviewEventsHandler` operator gates) that pages ownerless documents
  per collection by document id and stamps the operator-supplied target
  owner's `sub` (or quarantines to a dedicated `legacy` bucket owner) with
  per-document existence/idempotency checks, bounded ≤500-write batches, and
  resumable cursors. Execution is a deliberate operator action; nothing runs
  automatically. Until it is implemented and run, ownerless data stays
  quarantined (invisible to users) — which is safe by default.
- **Operator routes are identity-gated:** `POST /migrateDecksHandler` and
  `POST /migrateReviewEventsHandler` return 403 unless the verified `sub` is
  in `AUTH0_OPERATOR_SUBS`. The review-events migration no longer accepts a
  caller-supplied `legacyActorId`; it records the verified operator identity
  as the event owner, so migrated entries never enter another tenant's
  history/stats scope.


## Review events, history & study statistics (reviewEvents)

**Immutable events.** Every successful NON-TEST direct review
(`reviewFlashcard`) and session review (`submitSessionReview`) appends ONE
immutable `reviewEvents` document IN THE SAME Firestore transaction that
applies the FSRS scheduling — the event log and the card state can never
diverge, and a failed transaction writes neither. Session events are keyed by
the owner/session/`requestId` tuple (hashed canonically), so retries are
session-scoped and cannot collide across owners or sessions. Existing events
remain immutable. Each event records: `cardId`, `ownerId` (the
verified identity) plus `actorId` (retained on the wire for back-compat),
`rating`, `stateBefore`, `dueBefore`,
`dueAfter`, `stabilityAfter`, `difficultyAfter`, `repsAfter`, `lapsesAfter`,
`reviewedAt` (the review instant) and `recordedAt` (server time), optional
`deckId`/`deckName`, a `cardFrontSnapshot` (≤300 chars), and — for session
reviews — `sessionId`/`requestId`.

**Session request idempotency.** Each new v2 session stores every committed
`requestId` claim in a private `reviewSessions/{sessionId}/requestClaims`
child document, keyed by a canonical hash of the owner and request id. The
claim is committed in the same transaction as the queue/root transition and
any card/event update, so delayed and post-completion retries are successful
no-ops; deleted-target skips are claimed too. These records are not analytics
events, and test-mode claims never write review events or card scheduling.

Legacy v2 roots without the claim-ledger readiness marker retain only bounded
recovery: a matching historical review event, queue-item request marker, or
most-recent root request id is recognized. If deleted/test-mode history makes
an unknown request id impossible to distinguish from a retry, the API returns
409 and asks for a new session rather than scanning the full queue or applying
a second rating.


**Events survive reset and deletion.** `reset_flashcards` clears the card's
scheduling state but deliberately does NOT touch `reviewEvents` (events are
immutable records of what happened). Deleting a card does not delete its
events. Only an explicit operator migration writes legacy entries, and events
are never updated or deleted (`firestore.rules` denies both).

**Embedded `reviewLog` is a bounded window.** A card keeps only its NEWEST
100 embedded reviewLog entries (older entries are trimmed on write but remain
recoverable from `reviewEvents`). Reviews performed BEFORE the event model
shipped exist only as embedded entries — the newest 100 per card — and are
backfilled ONLY by the explicit `POST /migrateReviewEventsHandler` (see
below); no automatic backfill runs, and trimmed entries older than the
embedded window are unrecoverable.

**Legacy FSRS learning progress.** `ts-fsrs` tracks an explicit short-term
learning/relearning step in addition to total review count. New reviews persist
`learningSteps` and each new `reviewLog` entry records `learningStepsAfter`.
Older Learning/Relearning cards may have only a bounded review-log tail; if
that retained history cannot establish the current step, review returns HTTP
409 and records neither a card update nor a review event. Deliberately reset
the affected card's scheduling state with `reset_flashcards` (or
`resetFlashcardsHandler`) before reviewing it again. This reset is an explicit
destructive action that clears the embedded scheduling log; it is never
performed automatically.

**Owner scoping.** The EVENT aggregates are owner-scoped:
`getReviewHistoryHandler` and `getStudyStatsHandler` filter by the caller's
verified `ownerId` — a user can never read another user's events (legacy
events written with only `actorId` are ownerless and quarantined).
`getTopLapsedCardsHandler` is likewise owner-scoped: a CURRENT library/
card-state ranking served by a bounded indexed query on the flashcards
collection (`ownerId` + `lapses > 0` orderBy desc, projected fields, ≤25
rows) — a user's ranking never includes another owner's cards, and the
optional `deckId` still filters it.

**Explicit time boundaries.** All `[from, to)` bounds are exact: `from` is
INCLUSIVE and `to` is EXCLUSIVE at millisecond precision (a date-only `to`
EXCLUDES the whole day it names — pass an ISO instant for a precise cut).
`YYYY-MM-DD` lower bounds mean UTC midnight of that day; the backend never
implicitly converts to the client's timezone.

**Retention / lapse definitions (study stats).** A review is SUCCESSFUL when
rated 2/3/4. `observedRetention` = successful ÷ totalReviews (null when 0
reviews). A review is MATURE when its pre-review state was Review (2) or
Relearning (3) (`stateBefore` in [2,3]); `matureRetention` = successful
mature ÷ matureReviews. LAPSE DEFINITION: `ratingCounts.again` counts EVERY
Again rating (Learning/New/Relearning included); the persisted card `lapses`
field counts ONLY FSRS MATURE FAILURES — Again ratings from the Review state
(2), the exact ts-fsrs lapse rule — so `topLapsedCards` ranks cards by their
CURRENT persisted `lapses` (read at request time; zero-lapse excluded;
indexed query, ≤25 rows) — a card's historical events never re-rank it.

**Migration (explicit, operator-invoked, resumable).**
`POST /migrateReviewEventsHandler` backfills `reviewEvents` from embedded
legacy `reviewLog` arrays. OPERATOR-ONLY (the verified `sub` must be in
`AUTH0_OPERATOR_SUBS`); there is NO caller-supplied `legacyActorId` — the
verified operator identity is recorded on migrated events as both `ownerId`
and `actorId`. Body: optional `pageSize` (1–100) and `resumeAfterCardId`.
It pages cards by document id ONLY (no `reviewLog` query predicate — see the
index exemption below), writes deterministic ids
`legacy-<cardId>-<reviewedAtMs>-<index>` with per-entry existence checks
(idempotent), and returns `{ cardsMigrated, eventsWritten, hasMore,
nextResumeAfterCardId }` — pass `nextResumeAfterCardId` as
`resumeAfterCardId` to continue exactly where the last call stopped.
`dueAfter` is derived from the next (newer) log entry when one exists, else
from the card's current `due` for its newest entry when available, else
omitted (never defaulted to the epoch). NEVER call automatically.

**Daily rollups deferred.** There is no pre-aggregated daily/rollup
collection; study stats are computed by Firestore count() aggregation at
read time over the actor's events within the requested window.

**Indexes.** `reviewEvents` composite indexes cover every supported query
shape — history pagination (actorId + optional cardId/deckId/ratings-in +
reviewedAt range, ordered reviewedAt DESC + __name__ ASC) and the stats
count() aggregations (actorId + optional deckId + stateBefore-in [2,3] +
optional rating equality + reviewedAt range; count() needs no order, so an
ASCENDING reviewedAt composite serves it). Each rating `in [...]` filter
rides the same index as a single equality. Keep only the shapes the code
actually issues (see the reviewEvents entries in `firestore.indexes.json`).
`firestore.indexes.json` `fieldOverrides` EXEMPT single-field indexes for
fields that are never filtered or sorted: `flashcards.reviewLog` (embedded
display/history data — the migration pages by `__name__` and skips empty logs
in memory), and `reviewEvents.cardFrontSnapshot` / `reviewEvents.deckName`
(display-only). Keep those exemptions when editing the file, and deploy with
`firebase deploy --only firestore:indexes`.
