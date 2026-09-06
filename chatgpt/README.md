# ChatGPT GPT Action — FSRS Flashcard Integration (SUPERSEDED)

> **This integration is superseded.** The primary ChatGPT integration is now
> the **MCP server** in [`mcp-server/`](../mcp-server/README.md) (ChatGPT Apps
> SDK platform, Streamable HTTP at `/mcp`). This directory is kept as a
> migration reference and fallback: the historical files document the
> original Custom GPT GPT-Action surface (OpenAPI schema, deployed backend
> routes, auth model, local mock/client tooling). The MCP server in
> [`mcp-server/`](../mcp-server/README.md) is the current integration and has
> since extended the contract (session presentation `cardType`/`name`,
> `preloaded` queue, `requestId`/`expectedCardId` idempotency, and a fully
> local in-widget answer check — the `evaluateSessionAnswerHandler` /
> `recordSessionEvaluationHandler` endpoints were removed from the backend;
> answer assessment is deterministic and local) — this directory is NOT kept
> in sync with those additions. See [`mcp-server/README.md`](../mcp-server/README.md) for
> the current setup, deployment, and ChatGPT connection instructions.


This directory contains the ChatGPT-facing integration for the FSRS flashcard
service in `D:/fsrs`. It lets ChatGPT **create (single or bulk), list, get
due, review with FSRS ratings, read, update (single or bulk), and delete
(single or bulk) flashcards** through a Custom GPT "GPT Action" that calls the
Firebase backend (`functions/`, built by the backend workstream).

## What this directory is (historical reference)

Legacy ChatGPT **Plugins** (`ai-plugin.json` + `x-openai-isConsequential`
OpenAPI schemas) were **retired in April 2024**. At the time this directory
was written, the supported way to let ChatGPT call an external API was a
**GPT Action**: an OpenAPI 3.1 schema pasted into a Custom GPT's **Actions**
section, with authentication configured in the GPT editor (None / API Key /
OAuth). That surface is now superseded by the MCP server in `mcp-server/` —
see the banner above. The files below document the GPT-Action-era
contract; the MCP server in `mcp-server/` is the current authority and
has since added session presentation config (`cardType`/`name`), the
`preloaded` queue, `requestId`/`expectedCardId` idempotency, and a fully
local in-widget answer check (`evaluateSessionAnswerHandler` /
`recordSessionEvaluationHandler` were removed from the backend) — this
directory is a migration reference only and is NOT kept in sync with those
additions.

| File | Purpose |
| --- | --- |
| `openapi.yaml` | The OpenAPI 3.1 schema to paste into the GPT Action. **The contract.** |
| `action.json` | Repo metadata: operations, auth, data model, integration notes. Not consumed by OpenAI. |
| `gpt-instructions.md` | Custom GPT **Instructions** to paste into the GPT builder. |
| `client.mjs` | Node CLI client to smoke-test the contract against a running server. |
| `mock-server.mjs` | Local server implementing the exact `openapi.yaml` contract for testing without Firebase. |
| `validate-schema.mjs` | Structural validation of `openapi.yaml` (`npm run validate`). |
| `package.json` | Scripts: `npm run mock`, `npm run client`, `npm run validate`. |

## API contract (GPT-Action era — see mcp-server/ for the current contract)

The backend (`functions/src/index.ts`) deploys **each handler as a separate
named Cloud Function** — there is **no `/api` router prefix**. Card ids are
appended to the function URL path. Auth: `X-API-Key` header, enforced by the
backend **only when `NODE_ENV=production`**; `health` is always public.

| Method | Path (function name) | OperationId | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | `checkHealth` | Service health check (public) |
| POST | `/createFlashcardHandler` | `createFlashcard` | Create a card (front/back, optional `deckId`/`deck`/tags) |
| POST | `/bulkCreateFlashcardsHandler` | `bulkCreateFlashcards` | Atomically create up to 100 cards (`{ cards: [...] }` → `201 { cards }`) |
| GET | `/listFlashcardsHandler` | `listFlashcards` | List (filters `deckId`/`deck`, `tags` ANY-of; pagination `pageSize`, `pageToken`) |
| GET | `/dueFlashcardsHandler` | `getDueFlashcards` | Active cards due for review now (new + scheduled; suspended cards excluded), earliest due first; optional `deckId`/`deck` + pagination |
| POST | `/startReviewSessionHandler` | `startReviewSession` | Start a persistent review session: snapshot EVERY matching card (the due queue, or optional `deckId`/`deck`/`tags`/`cardIds` selectors — never capped, earliest due first); reports mode/dueCount/remainingCount; returns session + first card |
| GET | `/getReviewSessionHandler/{sessionId}` | `getReviewSession` | Get a review session (any status) plus its current card; only the starting API key can read it (403 otherwise) |
| POST | `/submitSessionReviewHandler/{sessionId}` | `submitSessionReview` | Rate the session's expected current card (`{ rating, reviewAt? }`); atomically applies FSRS and advances the session; returns session + next card |
| POST | `/endReviewSessionHandler/{sessionId}` | `endReviewSession` | End an active review session without rating the rest (idempotent; status → `ended`) |
| GET | `/getFlashcardHandler/{id}` | `getFlashcard` | Get one card |
| PATCH | `/updateFlashcardHandler/{id}` | `updateFlashcard` | Update a card (partial; assign/move/detach deck via `deckId`/`deck`) |
| POST | `/bulkUpdateFlashcardsHandler` | `bulkUpdateFlashcards` | Atomically update up to 100 cards (`{ cards: [{ id, front?, back?, deckId?, deck?, tags? }] }` → `200 { cards }`; input order, missing ids omitted) |
| DELETE | `/deleteFlashcardHandler/{id}` | `deleteFlashcard` | Delete a card |
| POST | `/bulkDeleteFlashcardsHandler` | `bulkDeleteFlashcards` | Atomically delete up to 100 cards (`{ ids: [...] }` → `200 { deletedIds }`; only ids that existed) |
| POST | `/resetFlashcardsHandler` | `resetFlashcards` | Reset one or more cards to a brand-new state (`{ ids }`, ≤100 unique ids → `200 { ids, count, cards }`): New, due immediately, zeroed counters, empty reviewLog. Atomic; missing ids omitted |
| POST | `/setFlashcardDueDateHandler` | `setFlashcardDueDate` | Set the exact next-review time of one or more cards (`{ ids, due }` → `200 { ids, count, cards }`); `due` = ISO 8601 date-time or `YYYY-MM-DD` (UTC midnight). Only `due` changes — FSRS state preserved |
| POST | `/suspendFlashcardsHandler` | `suspendFlashcards` | Suspend one or more cards (`{ ids }` → `200 { ids, count, cards }`): `suspended: true`; content + scheduling kept |
| POST | `/unsuspendFlashcardsHandler` | `unsuspendFlashcards` | Unsuspend one or more cards (`{ ids }` → `200 { ids, count, cards }`): `suspended` field removed (absent = active) |
| POST | `/createDeckHandler` | `createDeck` | Create a deck (`{ name, description? }` → `201 { deck }`); names are unique |
| GET | `/listDecksHandler` | `listDecks` | List decks (pagination `pageSize`, `pageToken`) |
| GET | `/getDeckHandler/{id}` | `getDeck` | Get one deck |
| PATCH | `/updateDeckHandler/{id}` | `updateDeck` | Update a deck (name/description; rename rewrites the name on its cards) |
| POST | `/attachImageHandler/{cardId}` | `attachImage` | Attach an image to a card by URL (`{ url, alt?, mimeType? }` → `201 { card, image }`); validated http(s), allowed MIME/extension, ≤5 per card |
| POST | `/uploadImageHandler/{cardId}` | `uploadImage` | Upload an image (base64) to Firebase Storage (`{ data, fileName, contentType, alt? }` → `201 { card, image }`); ≤10 MiB, raster MIME only (no SVG), persists cloud metadata |
| GET | `/listImagesHandler/{cardId}` | `listImages` | List a card's image attachments (`200 { cardId, images }`; URL refs + cloud metadata: id, storagePath, downloadUrl, sizeBytes) |
| DELETE | `/removeImageHandler/{cardId}` | `removeImage` | Remove an image by its exact URL (`200 { cardId, removed }`; only the card's reference, not the hosted file) |

Validation limits (mirror `functions/src/flashcards/validators.ts`):
`front`/`back` 1–10000 chars; `deckId`/`deck` ≤100; `tags` ≤20 items, each 1–50
chars. Image attachments: URL 1–2048 chars, `http(s)` only, allowed MIME
`image/jpeg|png|gif|webp|avif|bmp|svg+xml` (declared or inferred from path
extension), at most **5 per card** (`MAX_CARD_IMAGES`). Uploads: decoded ≤ **10 MiB**, raster MIME only (jpeg/png/gif/webp/avif/bmp; SVG not accepted), fileName ≤255, base64 payload ≤ ~14 MiB. `listFlashcards` filters
tags with `array-contains-any` (ANY match) and pages via `pageToken` = last card
id of the previous page.

**Operation count:** `openapi.yaml` exposes **25 operations** — the 24 user-facing
endpoints plus `migrateDecks` (a maintenance route: backfill `deckId` from
legacy `deck` names; idempotent and paged, call repeatedly until `migrated: 0`).

**Review sessions** (`startReviewSession` → `submitSessionReview` → …) are
persistent: `startReviewSession` snapshots EVERY matching card id (ordered
earliest-due first, optional `deckId`/`deck`/`tags`/`cardIds` selectors) into
the session queue on the backend (`reviewSessions` collection) — the queue is
NEVER capped (a client-supplied `limit` is rejected) — so the same
session can be resumed across turns. Every session reports its `mode`
(`spaced_repetition`), the EXACT `dueCount` captured at start, and the full
`cardIds` snapshot (`limit` always equals `cardIds.length`; `truncated`/
`continuationAvailable` are only present on legacy pre-cap sessions). Each
`submitSessionReview` atomically
applies the FSRS scheduler to the session's **expected current card** AND
advances the session (currentIndex, reviewedCount, ratingCounts, status) in one
Firestore transaction — retries and concurrent submissions can never
double-apply a review or lose progress; cards deleted since the snapshot are
skipped automatically and the response always returns the next LIVE card
(never `card: null` while cards remain). The session exposes `status`
(`active`/`completed`/`ended`), `ratingCounts` (again/hard/good/easy + numeric
map), `reviewedCount`/`currentIndex`/`remainingCount`, `cardIds`, `dueCount`,
and timestamps; the response always includes the next card to review (null
when the queue is exhausted). Every session response leads with the
human-readable mode tag **"[Spaced repetition review · N cards due]"** (N =
the exact `dueCount`) plus progress ("X reviewed, Y remaining of N"). On
completion the client text says "Review session complete — choose Finish (all
due cards were reviewed)" (legacy sessions that started before the cap was
removed may still offer Continue via `continuationAvailable`).
Sessions are scoped to the API key that started them: `getReviewSession`,
`submitSessionReview`, and `endReviewSession` with a different key return 403.
Use `endReviewSession` (idempotent) to abandon an unfinished session. Sessions
snapshot every matching card — never capped.

### Bulk endpoints

The three bulk endpoints accept at most **100 items per request** (`BULK_LIMIT`
in `functions/src/flashcards/types.ts`, enforced by the `bulk*FlashcardsSchema`
validators), return `400 { error, issues }` on any validation failure, require
the same `X-API-Key` auth as every other endpoint, and commit **atomically**
(single Firestore batch/transaction — no partial silent success):

- `POST /bulkCreateFlashcardsHandler` — body `{ cards: FlashcardCreate[] }` →
  `201 { cards: Flashcard[] }`. Every card is validated before any write; the
  batch commits all-or-nothing. Ids are assigned server-side.
- `POST /bulkUpdateFlashcardsHandler` — body
  `{ cards: [{ id, front?, back?, deck?, tags? }] }` → `200 { cards:
  Flashcard[] }` (input order). Reads and writes run in one Firestore
  transaction; ids that do not exist are omitted and never written. Scheduling
  fields (`state`, `stability`, `difficulty`, `reps`, `lapses`, `due`,
  `reviewLog`) are not accepted — they remain backend-managed.
- `POST /bulkDeleteFlashcardsHandler` — body `{ ids: string[] }` →
  `200 { deletedIds: string[] }`. Existence is checked in one Firestore
  transaction; only ids that existed are deleted and returned.

**Decks are entities** in the `decks` collection; cards reference them by
stable `deckId` (the denormalized `deck` name is preserved for legacy/readable
filtering and stays coherent on rename). `deleteDeck` is destructive to the
deck only — every referencing card is DETACHED (deckId/deck fields removed,
cards and FSRS scheduling preserved) and the response reports `detachedCards`.
Detaches run in chunked batches (≤500 writes each); the deck document is
deleted only after all detach batches succeed. This is NOT a single atomic
transaction: if a batch fails partway, earlier detaches remain committed (the
deck is not deleted) and retrying the delete is safe. Cards created before
deck entities existed keep their legacy `deck` name;
`POST /migrateDecksHandler` (maintenance) backfills `deckId`.

Flashcard shape (Firestore `flashcards` collection): `{ id, front, back,
deckId?, deck?, tags[], createdAt, updatedAt, due, state, stability,
difficulty, reps, lapses, lastReview?, reviewLog[], images[] }` — `deckId` is
the stable reference to the `decks` collection; `deck` is the denormalized
name kept for legacy/readable filtering. The scheduling fields are FSRS state
maintained by the backend (`state` 0=New, 1=Learning, 2=Review, 3=Relearning;
`reviewLog` holds one entry per review, each with rating/state/review/due/
stability/difficulty/reps/lapses). Image attachments (`images[]`) are
**URL references only** — each is `{ url, alt?, mimeType?, addedAt }` and the
backend never stores image bytes; a card holds at most 5. Deck shape:
`{ id, name, description?, createdAt, updatedAt }`. The backend returns
Firestore Timestamps as-is, so on the wire they serialize to
`{ _seconds, _nanoseconds }` (protobuf style), NOT ISO 8601 — verified against
firebase-admin. List/due responses: `{ cards, nextPageToken }`. List decks:
`{ decks, nextPageToken }`. Review response: `{ card, reviewLogItem }`.
Session responses (`startReviewSession`, `getReviewSession`,
`submitSessionReview`): `{ session, card }` — `card` is the current card to
review or `null` when the queue is exhausted; `endReviewSession` returns the
session alone. Session shape: `{ id, apiKeyName, status, deckId?, limit,
cardIds, currentIndex, reviewedCount, truncated, ratingCounts {again, hard,
good, easy, ratingCounts}, startedAt, lastReviewedAt?, endedAt? }`. Delete
deck: `{ deleted, detachedCards }`. Attach image: `{ card, image }`.
List images: `{ cardId, images }`. Remove image: `{ cardId, removed }`. Errors:
`{ error, issues? }` (`issues` present on 400 validation failures). Health:
`{ status, timestamp }`.

## Local setup

Prerequisites: Node.js 18+ (tested with 22). Python 3.11+ only if you use the
extra YAML check below.

```bash
cd chatgpt

# 1. Validate the OpenAPI schema (dependency-free)
npm run validate          # or: node validate-schema.mjs

# 2. Start the local mock server (implements the exact contract)
npm run mock              # listens on http://127.0.0.1:8787
# Optional API-key auth for testing:  API_KEY=secret npm run mock

# 3. In another terminal, exercise the contract with the client
node client.mjs http://localhost:8787 health
node client.mjs http://localhost:8787 create --front "What is FSRS?" --back "Free Spaced Repetition Scheduler" --deck "spaced-repetition" --tags "algorithm,core"
node client.mjs http://localhost:8787 list --deck "spaced-repetition"
node client.mjs http://localhost:8787 due
node client.mjs http://localhost:8787 review <id> --rating 3
node client.mjs http://localhost:8787 get <id>
node client.mjs http://localhost:8787 update <id> --back "Free Spaced Repetition Scheduler — an algorithm for scheduling reviews"
node client.mjs http://localhost:8787 delete <id>

# Bulk examples (up to 100 items; atomic — all-or-nothing)
node client.mjs http://localhost:8787 bulk-create --front "Q1" --back "A1" --deck "python" --front2 "Q2" --back2 "A2"
node client.mjs http://localhost:8787 bulk-update --id <id1> --tags "reviewed" --id2 <id2> --deck "python"
node client.mjs http://localhost:8787 bulk-delete --id <id1> --id2 <id2>

# Deck examples
node client.mjs http://localhost:8787 create-deck --name "spanish-vocab" --description "Vocabulary"
node client.mjs http://localhost:8787 list-decks
node client.mjs http://localhost:8787 get-deck <deck-id>
node client.mjs http://localhost:8787 create --front "Hola" --back "Hello" --deck-id <deck-id>
node client.mjs http://localhost:8787 list --deck-id <deck-id>
node client.mjs http://localhost:8787 update-deck <deck-id> --name "espanol"
node client.mjs http://localhost:8787 delete-deck <deck-id>   # cards are detached, not deleted
node client.mjs http://localhost:8787 migrate-decks           # maintenance: backfill deckId from legacy names

# Review session examples (persistent; snapshots every matching card)
node client.mjs http://localhost:8787 start-session --deck-id <deck-id>
node client.mjs http://localhost:8787 get-session <session-id>
node client.mjs http://localhost:8787 submit-review <session-id> --rating 3
node client.mjs http://localhost:8787 end-session <session-id>
```

To confirm the schema itself parses as YAML:
`python -c "import yaml; yaml.safe_load(open('openapi.yaml'))"`

## Deployment URL substitution (REQUIRED before configuring the GPT)

`openapi.yaml` ships with two servers:

```yaml
servers:
  - url: https://us-central1-<project-id>.cloudfunctions.net
    description: Deployed Firebase Functions endpoint (us-central1)
  - url: http://127.0.0.1:5001/<project-id>/us-central1
    description: Local Firebase emulator (functions emulator, port 5001)
```

Replace every `<project-id>` with the real Firebase project id before
configuring the GPT Action (or keep only the deployed URL). The paths in the
schema are the **named function URLs** (`/createFlashcardHandler`, …), so
ChatGPT will call e.g.
`https://us-central1-<project-id>.cloudfunctions.net/createFlashcardHandler`.
The deployed URL must be publicly reachable.

## Configuring the Custom GPT

1. Open https://chatgpt.com/gpts/editor and **Create** a GPT.
2. **Name/Description**: e.g. "FSRS Flashcards" / "Creates and manages FSRS spaced-repetition flashcards."
3. **Instructions**: paste the full contents of `gpt-instructions.md`.
4. **Actions → Create new action**: paste the contents of `openapi.yaml`
   (after the URL substitution above). The editor should detect 25 actions
   (`checkHealth`, `createFlashcard`, `bulkCreateFlashcards`, `listFlashcards`,
   `getDueFlashcards`, `reviewFlashcard`, `getFlashcard`, `updateFlashcard`,
   `bulkUpdateFlashcards`, `deleteFlashcard`, `bulkDeleteFlashcards`,
   `createDeck`, `listDecks`, `getDeck`, `updateDeck`, `deleteDeck`,
   `migrateDecks`, `attachImage`, `uploadImage`, `listImages`, `removeImage`,
   `startReviewSession`, `getReviewSession`, `submitSessionReview`,
   `endReviewSession`).
5. **Authentication** (Actions → gear icon):
   - **None** — fine for local development / emulator (backend only enforces
     keys in production).
   - **API Key** — for production against the deployed backend:
     - Authentication type: `API Key`
     - Header: `X-API-Key`
     - Value: a key present in the backend's Firestore `apiKeys` collection
       (key = document id; `revoked: true` disables it). OpenAI encrypts
       stored keys.
6. **Test** each action from the Actions panel before publishing.

## Auth requirements

- **Backend (production)**: the Firebase Functions backend validates the
  `X-API-Key` header against the Firestore `apiKeys` collection **only when
  `NODE_ENV=production`**; missing/invalid keys get `401 { error }`. In local
  dev / emulator the API is open. Keys must exist before the GPT Action can
  authenticate in production.
- **GPT Action**: select `API Key` auth in the GPT editor and set header
  `X-API-Key` to a valid backend key.
- **Local dev**: run the mock with no `API_KEY` env (auth disabled) or with
  `API_KEY=secret` to simulate production enforcement.
- No OAuth is used; per-user identity is out of scope for this first phase.

## Example prompts (after configuration)

- "Create a flashcard: front 'What does FSRS stand for?', back 'Free Spaced
  Repetition Scheduler', deck 'spaced-repetition', tags algorithm, core."
- "Make three flashcards for the Python list methods I just described, in a
  deck called python." (uses `bulkCreateFlashcards` for multiple cards)
- "Show me my flashcards in the spanish-vocab deck."
- "What cards are due for review today?" (uses `getDueFlashcards`)
- "Let's review my spanish deck — start a session." (uses
  `startReviewSession` with `deckId`; then `submitSessionReview` per card with
  the user's rating, showing the next card each time; `endReviewSession` when
  the user stops early)
- "Find the card 'What is a closure?' and fix its answer to 'A function that
  retains access to its enclosing scope.'"
- "Delete the card I created about quantum entanglement."
- "Delete the entire spanish-vocab deck." (list by `deck` filter → explicit
  confirmation → `bulkDeleteFlashcards` in ≤100-id batches; there is no
  delete-deck endpoint)
- "Is the flashcard service working?" (uses `checkHealth`)

## Notes / limitations

- This is a **first-phase tool/integration test**, not a production launch. No
  secrets are committed; keys live in the Firebase backend / GPT editor only.
- **Blocking prerequisite for a live GPT Action**: a deployed Firebase
  Functions endpoint with a real `<project-id>` (and, for production auth,
  entries in the Firestore `apiKeys` collection). No deployment was performed
  and no credentials were invented in this phase. Until then, the mock server
  is the way to exercise the contract.
- The mock server is contract-only: it mirrors the backend's routes and
  validation (including the FSRS scheduling fields on cards, a simplified
  review scheduler, and the due/review endpoints) but does not implement the
  real FSRS algorithm (ts-fsrs) or Firestore persistence. It exists so the
  schema and client can be validated end-to-end without a deployment.
- Keep this schema in sync with `functions/src/index.ts`,
  `functions/src/flashcards/` (types/validators/service), and `firebase.json`
  (emulator ports: functions 5001, firestore 8080). The backend workstream
  owns those files; this directory is the consumer contract.
