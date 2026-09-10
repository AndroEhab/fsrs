/**
 * Regression tests for Firestore trigger resource configurations.
 *
 * These guard against accidental configuration drift that caused the
 * production OOM incident (2026-09-09): the enrollment chunk trigger
 * defaulted to 256 MiB with no concurrency/maxInstances limits, allowing
 * 10 simultaneous chunk invocations to OOM a single Cloud Run instance.
 */

// ---------------------------------------------------------------------------
// Mock firebase-admin to avoid requiring real credentials at import time.
// ---------------------------------------------------------------------------

jest.mock('firebase-admin/app', () => ({
  initializeApp: jest.fn(),
}));

jest.mock('firebase-admin/firestore', () => {
  const firestoreInstance = {
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn(),
        set: jest.fn(),
        update: jest.fn(),
      })),
    })),
    batch: jest.fn(() => ({
      set: jest.fn(),
      commit: jest.fn(),
    })),
    runTransaction: jest.fn(),
  };
  return {
    getFirestore: jest.fn(() => firestoreInstance),
    Firestore: jest.fn(),
    Timestamp: { now: jest.fn(() => ({ seconds: 0, nanoseconds: 0 })) },
    FieldValue: { increment: jest.fn() },
  };
});

jest.mock('firebase-admin/storage', () => ({
  getStorage: jest.fn(() => ({ bucket: jest.fn(() => ({})) })),
}));

// ---------------------------------------------------------------------------
// Capture the trigger options passed to onDocumentWritten by spying on it
// before the module under test loads.
// ---------------------------------------------------------------------------

const triggerConfigs: Array<{
  pathOrOpts: unknown;
  handler: unknown;
}> = [];

jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentWritten: jest.fn((pathOrOpts: unknown, handler: unknown) => {
    triggerConfigs.push({ pathOrOpts, handler });
    // Return a minimal callable shape so the module export doesn't blow up.
    return Object.assign(jest.fn(), { __trigger: true });
  }),
}));

// Import after mocks — this triggers onDocumentWritten calls.
import './index';

describe('trigger resource configurations', () => {
  it('onEnrollmentChunkWrittenTrigger has 512 MiB memory, concurrency 1, maxInstances 2', () => {
    const enrollmentTrigger = triggerConfigs.find((t) => {
      const opts = t.pathOrOpts as Record<string, unknown> | undefined;
      return (
        typeof opts === 'object' &&
        opts !== null &&
        'document' in opts &&
        (opts.document as string).includes('chunks')
      );
    });

    expect(enrollmentTrigger).toBeDefined();

    const opts = enrollmentTrigger!.pathOrOpts as Record<string, unknown>;
    expect(opts.document).toBe(
      'bulkEnrollmentJobs/{jobId}/chunks/{chunkIndex}',
    );
    expect(opts.memory).toBe('512MiB');
    expect(opts.concurrency).toBe(1);
    expect(opts.maxInstances).toBe(2);
  });
});
