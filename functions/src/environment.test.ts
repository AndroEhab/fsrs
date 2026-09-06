import { authRequiredAndMissing, isProductionRuntime } from './environment';

describe('isProductionRuntime (auth fail-closed detection)', () => {
  const original = process.env.FUNCTIONS_EMULATOR;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.FUNCTIONS_EMULATOR;
    } else {
      process.env.FUNCTIONS_EMULATOR = original;
    }
  });

  it('returns true when FUNCTIONS_EMULATOR is unset (deployed GCF runtime)', () => {
    // GCF v2 does not set NODE_ENV and never exports FUNCTIONS_EMULATOR;
    // this is exactly the deployed production condition that the old
    // `NODE_ENV === 'production'` gate failed to detect (it was undefined,
    // so every handler accepted unauthenticated requests).
    delete process.env.FUNCTIONS_EMULATOR;
    expect(isProductionRuntime()).toBe(true);
  });

  it('returns true when NODE_ENV is unset (no implicit production signal)', () => {
    const nodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    delete process.env.FUNCTIONS_EMULATOR;
    try {
      expect(isProductionRuntime()).toBe(true);
    } finally {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
    }
  });

  it('returns false inside the emulator (FUNCTIONS_EMULATOR=true)', () => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    expect(isProductionRuntime()).toBe(false);
  });

  it('treats an explicit NODE_ENV=production runtime as production (defense in depth)', () => {
    const nodeEnv = process.env.NODE_ENV;
    delete process.env.FUNCTIONS_EMULATOR;
    process.env.NODE_ENV = 'production';
    try {
      expect(isProductionRuntime()).toBe(true);
    } finally {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
    }
  });
});

describe('authRequiredAndMissing (handler auth gate)', () => {
  const original = process.env.FUNCTIONS_EMULATOR;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.FUNCTIONS_EMULATOR;
    } else {
      process.env.FUNCTIONS_EMULATOR = original;
    }
  });

  it('rejects a missing key on the deployed runtime (no emulator marker) — the fail-closed fix', () => {
    delete process.env.FUNCTIONS_EMULATOR;
    expect(authRequiredAndMissing(null)).toBe(true);
  });

  it('accepts a valid key on the deployed runtime', () => {
    delete process.env.FUNCTIONS_EMULATOR;
    expect(authRequiredAndMissing('Key A')).toBe(false);
  });

  it('stays open without a key inside the emulator (dev compatibility preserved)', () => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    expect(authRequiredAndMissing(null)).toBe(false);
  });
});
