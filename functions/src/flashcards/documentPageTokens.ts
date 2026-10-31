import { createHash } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';

export type DocumentPageKind = 'listDecks' | 'listFlashcards' | 'dueFlashcards';
const MIN_TIMESTAMP_SECONDS = -62_135_596_800;
const MAX_TIMESTAMP_SECONDS = 253_402_300_799;


export interface DocumentPageCursor {
  kind: DocumentPageKind;
  scopeKey: string;
  seconds: number;
  nanoseconds: number;
  id: string;
}

export class InvalidPageTokenError extends Error {
  constructor(message = 'Invalid pageToken') {
    super(message);
    this.name = 'InvalidPageTokenError';
  }
}

export function isValidFirestoreDocumentId(id: unknown): id is string {
  return typeof id === 'string'
    && id.length > 0
    && id !== '.'
    && id !== '..'
    && !id.includes('/')
    && !/^__.*__$/.test(id)
    && Buffer.byteLength(id, 'utf8') <= 1500;
}
export function isValidFirestoreTimestamp(seconds: unknown, nanoseconds: unknown): boolean {
  return typeof seconds === 'number'
    && Number.isSafeInteger(seconds)
    && seconds >= MIN_TIMESTAMP_SECONDS
    && seconds <= MAX_TIMESTAMP_SECONDS
    && typeof nanoseconds === 'number'
    && Number.isInteger(nanoseconds)
    && nanoseconds >= 0
    && nanoseconds < 1_000_000_000;
}


export function canonicalScopeFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function pageScopeKey(kind: DocumentPageKind, ownerId: string, filters: unknown): string {
  return canonicalScopeFingerprint([kind, ownerId, filters]);
}

export function makeDocumentPageToken(
  kind: DocumentPageKind,
  ownerId: string,
  filters: unknown,
  timestamp: Timestamp,
  id: string,
): string {
  const cursor: DocumentPageCursor = {
    kind,
    scopeKey: pageScopeKey(kind, ownerId, filters),
    seconds: timestamp.seconds,
    nanoseconds: timestamp.nanoseconds,
    id,
  };
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function readDocumentPageToken(token: string): DocumentPageCursor | null {
  if (token.length > 3000) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Partial<DocumentPageCursor>;
    if (
      (parsed.kind !== 'listDecks' && parsed.kind !== 'listFlashcards' && parsed.kind !== 'dueFlashcards')
      || typeof parsed.scopeKey !== 'string'
      || !/^[0-9a-f]{64}$/.test(parsed.scopeKey)
      || !isValidFirestoreTimestamp(parsed.seconds, parsed.nanoseconds)
      || !isValidFirestoreDocumentId(parsed.id)
    ) {
      return null;
    }
    return parsed as DocumentPageCursor;
  } catch {
    return null;
  }
}

export function validateDocumentPageToken(
  token: string,
  kind: DocumentPageKind,
  ownerId: string,
  filters: unknown,
): DocumentPageCursor {
  const cursor = readDocumentPageToken(token);
  if (!cursor || cursor.kind !== kind || cursor.scopeKey !== pageScopeKey(kind, ownerId, filters)) {
    throw new InvalidPageTokenError('pageToken does not match the current owner, query, or cursor type');
  }
  return cursor;
}

export function timestampFromDocumentPageCursor(cursor: DocumentPageCursor): Timestamp {
  return new Timestamp(cursor.seconds, cursor.nanoseconds);
}
