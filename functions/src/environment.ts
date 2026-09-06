/**
 * Runtime-environment detection for the Cloud Functions backend.
 *
 * Google Cloud Functions (v2) does NOT set `process.env.NODE_ENV`, so any
 * auth gate keyed on `NODE_ENV === 'production'` silently FAILS OPEN on the
 * deployed backend (every handler would accept unauthenticated requests).
 *
 * The only reliable production signal is the Firebase emulator marker:
 * firebase-tools exports `FUNCTIONS_EMULATOR=true` inside the emulator
 * runtime, and a deployed function never sees it. This module therefore
 * treats EVERY non-emulator runtime as production-like and enforces the API
 * key there. Local/emulator development (where `X-API-Key` is optional and
 * the service layer runs without an authenticated key) stays open because
 * the emulator sets the marker.
 */
export function isProductionRuntime(): boolean {
  return process.env.FUNCTIONS_EMULATOR !== 'true';
}

/**
 * The shared API-key gate used by every HTTP handler in index.ts: enforcement
 * is required when the runtime is production-like AND the request carried no
 * valid key. Kept here (not in index.ts) so the gate logic is unit-testable
 * without initializing firebase-admin.
 */
export function authRequiredAndMissing(apiKeyName: string | null): boolean {
  return isProductionRuntime() && apiKeyName === null;
}
