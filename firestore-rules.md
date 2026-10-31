# Firestore Security Rules — deny-by-default

**Policy:** every Firestore collection used by this repo is locked down;
direct mobile/web client SDK reads and writes are refused. All data access
happens in `functions/` via the Firebase **Admin SDK**, which bypasses
security rules — so Cloud Functions are unaffected by this file.

**Multi-tenant ownership is enforced in the functions layer** (never in the
rules — the Admin SDK bypasses them): every user request carries a verified
Auth0 JWT whose `sub` becomes the `ownerId` scope for reads and the `ownerId`
stamped on writes (`flashcards`, `decks`, `reviewSessions` and their `queueChunks`
and private `requestClaims`, plus `reviewEvents`). `firestore.rules` stays
deny-by-default for every client path; the Admin SDK in functions is the only
data path, and it scopes every query/mutation by `ownerId`. Pre-multi-tenant
ownerless documents are quarantined (invisible to owner-scoped users) pending
an operator-only backfill — see the root README "Multi-tenant ownership (ownerId)".

Covered paths (all `allow read, write: if false`):

| Path | Notes |
| --- | --- |
| `apiKeys/{key}` | key verification is Admin-SDK-only (in Cloud Functions) |
| `flashcards/{cardId}` | |
| `decks/{deckId}` | functions-owned deck lookup/sync |
| `reviewSessions/{sessionId}` | session root |
| `reviewSessions/{sessionId}/queueChunks/{chunkIndex}` | bounded queue snapshot |
| `reviewSessions/{sessionId}/requestClaims/{requestIdHash}` | private request idempotency claims |
| `reviewEvents/{eventId}` | review history; never updated/deleted |

## What was removed (and why)

- `isDevEnvironment()` returned `request.resource == null || true` — always
  true, so it granted unrestricted production access.
- `isValidApiKey()` returned `request.auth != null` — satisfied by any
  Firebase Auth user; it never checked the API key. Real key verification is
  done in the functions layer (`verifyApiKey` in
  `functions/src/flashcards/service.ts`), which cannot be expressed in rules.
- The old `apiKeys` read rule compared `request.auth.token.email` to the key
  document's email — a leaky approximation of the Admin-SDK check.

There is **no** `request`-based signal that distinguishes a local emulator
client from a production client, so no rules-time dev escape hatch exists.

## Rules tests

`functions/src/firestore.rules.test.ts` is a deterministic emulator suite
(project `fsrs-rules-test`) that asserts every listed path denies
unauthenticated **and** Firebase-Auth-authenticated client reads/writes, and
that Admin-SDK-equivalent access (emulator rules bypass) still works.

Run it (needs `java` on PATH; firebase CLI downloads the Firestore emulator
jar on first use — no project/credentials required):

```bash
cd functions
npm run test:rules
```

This starts only the Firestore emulator on an ephemeral port, runs the rules
suite, and tears down that child process. It does not attach to or stop a
shared emulator.

## Real datastore regressions

`functions/src/flashcards/*.integration.test.ts` exercises the session,
enrollment, deck, image, pagination, and tag services against the Firebase
Admin SDK and real local Firestore (and, where needed, Storage) emulators.
These suites cover persisted queue arrays and retry claims, ownership/privacy,
enrollment chunk recovery, deck migration/projection, image lifecycle,
cursor validation, and transactional tag updates.

Run the full datastore group or the enrollment-only suite independently:

```bash
cd functions
npm run test:datastore
node scripts/run-firestore-emulator-tests.cjs enrollment
```

Each invocation runs a selected-root TypeScript preflight before starting its
own emulator on an ephemeral `127.0.0.1` port under the demo-only project
`demo-fsrs-datastore-test`, selects only the requested integration file(s),
and tears down its emulator. The suites fail closed unless the explicit demo
project guards and localhost emulator host are present; they never fall back
to a fake store or a production/default project. Plain `npm test` explicitly
excludes all `*.integration.test.ts` suites.
