'use strict';

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/tmp/userData') }
}));

jest.mock('node:fs', () => {
  const real = jest.requireActual('node:fs');
  const mockFiles = new Map();
  return {
    ...real,
    promises: {
      ...real.promises,
      mkdir: jest.fn(async () => undefined),
      readFile: jest.fn(async (p) => {
        if (mockFiles.has(p)) return mockFiles.get(p);
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }),
      writeFile: jest.fn(async (p, data) => {
        mockFiles.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data));
      }),
      open: jest.fn(async (p) => ({
        writeFile: jest.fn(async (data) => {
          mockFiles.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data));
        }),
        sync: jest.fn(async () => undefined),
        close: jest.fn(async () => undefined)
      })),
      rename: jest.fn(async (oldPath, newPath) => {
        if (!mockFiles.has(oldPath)) {
          const e = new Error('ENOENT');
          e.code = 'ENOENT';
          throw e;
        }
        mockFiles.set(newPath, mockFiles.get(oldPath));
        mockFiles.delete(oldPath);
      }),
      unlink: jest.fn(async (p) => {
        mockFiles.delete(p);
      })
    },
    __mockFiles: mockFiles
  };
});

const fs = require('node:fs');
const { CostTracker } = require('../../../src/main/services/ai/costTracker');
const { AIProviderError } = require('../../../src/main/services/ai/errors');

const FIXED_NOW = new Date('2026-04-15T12:00:00Z');

function makeTracker(overrides = {}) {
  return new CostTracker({
    filePath: '/tmp/userData/ai-cost-tracker.json',
    getSettings: () => ({
      providers: {
        local: { enabled: true },
        anthropic: { enabled: true, model: 'claude-opus-4-7' },
        openaiCompatible: { enabled: true, model: 'gpt-4o' }
      },
      routing: { default: 'local', perFolder: {} }
    }),
    now: () => FIXED_NOW,
    ...overrides
  });
}

describe('CostTracker', () => {
  beforeEach(() => {
    fs.__mockFiles.clear();
    jest.clearAllMocks();
  });

  describe('estimateCost', () => {
    test('claude-opus-4-7: $15/1M input + $75/1M output', () => {
      const cost = CostTracker.estimateCost({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000
      });
      expect(cost).toBeCloseTo(15 + 75, 4);
    });

    test('claude-sonnet-4-6: $3/1M input + $15/1M output', () => {
      const cost = CostTracker.estimateCost({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000
      });
      expect(cost).toBeCloseTo(3 + 15, 4);
    });

    test('gpt-4o: $2.50/1M input + $10/1M output', () => {
      const cost = CostTracker.estimateCost({
        provider: 'openaiCompatible',
        model: 'gpt-4o',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000
      });
      expect(cost).toBeCloseTo(2.5 + 10, 4);
    });

    test('local provider always costs $0', () => {
      const cost = CostTracker.estimateCost({
        provider: 'local',
        model: 'llama-3-8b',
        inputTokens: 5_000_000,
        outputTokens: 5_000_000
      });
      expect(cost).toBe(0);
    });

    test('unknown model falls back to a conservative high estimate, not zero', () => {
      const cost = CostTracker.estimateCost({
        provider: 'anthropic',
        model: 'claude-experimental-x',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000
      });
      // Unknown models must NOT silently estimate $0 — that would mask spend cap breaches.
      // Falls back to opus pricing (highest in the supported set) as a conservative ceiling.
      expect(cost).toBeGreaterThan(0);
    });
  });

  describe('recordUsage', () => {
    test('first record creates the month bucket and sums tokens', async () => {
      const t = makeTracker();
      await t.recordUsage({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        inputTokens: 100,
        outputTokens: 50
      });

      const usage = t.getMonthlyUsage();
      expect(usage['2026-04'].anthropic.inputTokens).toBe(100);
      expect(usage['2026-04'].anthropic.outputTokens).toBe(50);
      expect(usage['2026-04'].anthropic.estCostUsd).toBeCloseTo(
        (100 / 1_000_000) * 15 + (50 / 1_000_000) * 75,
        6
      );
    });

    test('subsequent records accumulate within the same month', async () => {
      const t = makeTracker();
      await t.recordUsage({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        inputTokens: 100,
        outputTokens: 50
      });
      await t.recordUsage({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        inputTokens: 200,
        outputTokens: 100
      });

      const usage = t.getMonthlyUsage();
      expect(usage['2026-04'].anthropic.inputTokens).toBe(300);
      expect(usage['2026-04'].anthropic.outputTokens).toBe(150);
    });

    test('records for different providers stay separate within the same month', async () => {
      const t = makeTracker();
      await t.recordUsage({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        inputTokens: 100,
        outputTokens: 50
      });
      await t.recordUsage({
        provider: 'openaiCompatible',
        model: 'gpt-4o',
        inputTokens: 200,
        outputTokens: 100
      });

      const usage = t.getMonthlyUsage();
      expect(usage['2026-04'].anthropic.inputTokens).toBe(100);
      expect(usage['2026-04'].openaiCompatible.inputTokens).toBe(200);
    });

    test('local provider usage is not recorded (privacy / no cost)', async () => {
      const t = makeTracker();
      await t.recordUsage({
        provider: 'local',
        model: 'llama-3-8b',
        inputTokens: 1000,
        outputTokens: 500
      });
      const usage = t.getMonthlyUsage();
      expect(usage['2026-04']?.local).toBeUndefined();
    });

    test('persists to disk on each record (atomic write)', async () => {
      const t = makeTracker();
      await t.recordUsage({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        inputTokens: 100,
        outputTokens: 50
      });

      // File exists in the mock FS
      const stored = fs.__mockFiles.get('/tmp/userData/ai-cost-tracker.json');
      expect(stored).toBeDefined();
      const parsed = JSON.parse(stored.toString());
      expect(parsed['2026-04'].anthropic.inputTokens).toBe(100);
    });

    test('survives across instances by re-loading from disk', async () => {
      const t1 = makeTracker();
      await t1.recordUsage({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        inputTokens: 100,
        outputTokens: 50
      });

      const t2 = makeTracker();
      await t2.load();
      const usage = t2.getMonthlyUsage();
      expect(usage['2026-04'].anthropic.inputTokens).toBe(100);
    });

    test('rolls into a new month bucket when the calendar month changes', async () => {
      let now = new Date('2026-04-30T23:50:00Z');
      const t = new CostTracker({
        filePath: '/tmp/userData/ai-cost-tracker.json',
        getSettings: () => ({ providers: {} }),
        now: () => now
      });

      await t.recordUsage({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        inputTokens: 100,
        outputTokens: 50
      });

      now = new Date('2026-05-01T00:10:00Z');

      await t.recordUsage({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        inputTokens: 200,
        outputTokens: 100
      });

      const usage = t.getMonthlyUsage();
      expect(usage['2026-04'].anthropic.inputTokens).toBe(100);
      expect(usage['2026-05'].anthropic.inputTokens).toBe(200);
    });
  });

  describe('enforceCap', () => {
    test('no-op when no cap is configured', async () => {
      const t = makeTracker();
      expect(() => t.enforceCap({ provider: 'anthropic' })).not.toThrow();
    });

    test('throws BUDGET_EXCEEDED when monthly spend already meets or exceeds cap', async () => {
      const t = makeTracker({
        getSettings: () => ({
          providers: {
            anthropic: { enabled: true, model: 'claude-opus-4-7', spendCapMonthlyUsd: 0.01 }
          }
        })
      });

      // Push usage over the $0.01 cap: 1000 input + 1000 output of opus is
      // 1000/1e6 * 15 + 1000/1e6 * 75 = 0.015 + 0.075 = $0.09
      await t.recordUsage({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        inputTokens: 1000,
        outputTokens: 1000
      });

      let err;
      try {
        t.enforceCap({ provider: 'anthropic' });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AIProviderError);
      expect(err.code).toBe('BUDGET_EXCEEDED');
    });

    test('does not throw when monthly spend is below the cap', async () => {
      const t = makeTracker({
        getSettings: () => ({
          providers: {
            anthropic: { enabled: true, model: 'claude-opus-4-7', spendCapMonthlyUsd: 100 }
          }
        })
      });
      await t.recordUsage({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        inputTokens: 1000,
        outputTokens: 1000
      });
      expect(() => t.enforceCap({ provider: 'anthropic' })).not.toThrow();
    });

    test('cap is per-provider (anthropic cap does not affect openaiCompatible)', async () => {
      const t = makeTracker({
        getSettings: () => ({
          providers: {
            anthropic: { enabled: true, model: 'claude-opus-4-7', spendCapMonthlyUsd: 0.01 },
            openaiCompatible: { enabled: true, model: 'gpt-4o' }
          }
        })
      });
      await t.recordUsage({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        inputTokens: 1000,
        outputTokens: 1000
      });

      // Anthropic should be capped, openaiCompatible should not.
      let anthropicErr;
      try {
        t.enforceCap({ provider: 'anthropic' });
      } catch (e) {
        anthropicErr = e;
      }
      expect(anthropicErr?.code).toBe('BUDGET_EXCEEDED');
      expect(() => t.enforceCap({ provider: 'openaiCompatible' })).not.toThrow();
    });

    test('local provider is never capped even if a cap is set', async () => {
      const t = makeTracker({
        getSettings: () => ({
          providers: { local: { enabled: true, spendCapMonthlyUsd: 0 } }
        })
      });
      expect(() => t.enforceCap({ provider: 'local' })).not.toThrow();
    });
  });

  describe('enforceCapAtomic', () => {
    test('returns a Promise', () => {
      const t = makeTracker();
      const result = t.enforceCapAtomic({ provider: 'anthropic' });
      expect(result).toBeInstanceOf(Promise);
      return result; // settle so we don't leak
    });

    test('no-op for local provider', async () => {
      const t = makeTracker();
      await expect(t.enforceCapAtomic({ provider: 'local' })).resolves.toBeUndefined();
    });

    test('throws BUDGET_EXCEEDED when spend already exceeds cap', async () => {
      const t = makeTracker({
        getSettings: () => ({
          providers: {
            anthropic: { enabled: true, model: 'claude-opus-4-7', spendCapMonthlyUsd: 0.01 }
          }
        })
      });
      await t.recordUsage({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        inputTokens: 1000,
        outputTokens: 1000
      });
      await expect(t.enforceCapAtomic({ provider: 'anthropic' })).rejects.toMatchObject({
        code: 'BUDGET_EXCEEDED'
      });
    });

    test('observes committed recordUsage from a prior chained call', async () => {
      // The race the sync enforceCap had: parallel callers both pre-check
      // BEFORE either's recordUsage commits, so both pass the check and one
      // pushes spend past the cap. The atomic variant queues through the
      // same chain — when called AFTER a recordUsage, it sees that record's
      // contribution to monthly spend.
      const t = makeTracker({
        getSettings: () => ({
          providers: {
            anthropic: { enabled: true, model: 'claude-opus-4-7', spendCapMonthlyUsd: 0.05 }
          }
        })
      });
      // Queue a recordUsage that pushes spend to $0.09 (over the $0.05 cap),
      // then atomically enforce. The chain serialization makes the enforce
      // run AFTER the record completes, so it sees the over-cap spend.
      const recordPromise = t.recordUsage({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        inputTokens: 1000,
        outputTokens: 1000
      });
      const enforcePromise = t.enforceCapAtomic({ provider: 'anthropic' });
      await recordPromise;
      await expect(enforcePromise).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    });

    test('a rejected atomic enforce does not poison the chain', async () => {
      const t = makeTracker({
        getSettings: () => ({
          providers: {
            anthropic: { enabled: true, model: 'claude-opus-4-7', spendCapMonthlyUsd: 0.01 }
          }
        })
      });
      await t.recordUsage({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        inputTokens: 1000,
        outputTokens: 1000
      });
      // First atomic check rejects (over cap).
      await expect(t.enforceCapAtomic({ provider: 'anthropic' })).rejects.toBeDefined();
      // Subsequent operations on the chain must still work.
      await expect(
        t.recordUsage({
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          inputTokens: 100,
          outputTokens: 100
        })
      ).resolves.toBeUndefined();
    });

    test('atomic serialization: enforce after parallel records sees combined spend', async () => {
      // This is the canonical race. With sync enforceCap, both parallel
      // recordUsage calls would race on the read-modify-write. With atomic
      // enforce queued AFTER them, the enforce observes the combined total.
      const t = makeTracker({
        getSettings: () => ({
          providers: {
            anthropic: { enabled: true, model: 'claude-opus-4-7', spendCapMonthlyUsd: 0.05 }
          }
        })
      });
      // 100 input + 100 output of opus = 100/1e6*15 + 100/1e6*75 = $0.009
      // Three parallel calls = ~$0.027 — under the $0.05 cap, so enforce
      // should resolve.
      await Promise.all([
        t.recordUsage({
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          inputTokens: 100,
          outputTokens: 100
        }),
        t.recordUsage({
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          inputTokens: 100,
          outputTokens: 100
        }),
        t.recordUsage({
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          inputTokens: 100,
          outputTokens: 100
        })
      ]);
      await expect(t.enforceCapAtomic({ provider: 'anthropic' })).resolves.toBeUndefined();

      // Now add one more record that would push past the cap, then atomic
      // enforce — chain serialization guarantees the enforce runs after.
      await t.recordUsage({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        inputTokens: 1000,
        outputTokens: 1000
      });
      await expect(t.enforceCapAtomic({ provider: 'anthropic' })).rejects.toMatchObject({
        code: 'BUDGET_EXCEEDED'
      });
    });
  });

  describe('concurrency and resilience', () => {
    test('concurrent recordUsage calls are serialized — no lost writes', async () => {
      // Without the single-flight chain, two parallel calls would each read
      // the same pre-call totals, increment locally, and the second persist
      // would overwrite the first. With the mutex, totals must reflect both.
      const t = makeTracker();
      await Promise.all([
        t.recordUsage({
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          inputTokens: 100,
          outputTokens: 50
        }),
        t.recordUsage({
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          inputTokens: 200,
          outputTokens: 100
        }),
        t.recordUsage({
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          inputTokens: 300,
          outputTokens: 150
        })
      ]);
      const usage = t.getMonthlyUsage();
      const month = usage['2026-04']?.anthropic;
      expect(month.inputTokens).toBe(600);
      expect(month.outputTokens).toBe(300);
    });

    test('persist failure rolls back the in-memory increment', async () => {
      const t = makeTracker();
      // Seed an existing entry first.
      await t.recordUsage({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        inputTokens: 100,
        outputTokens: 50
      });

      // Now fail the next persist. The in-memory counter must NOT retain
      // the failed increment — otherwise the retry would double-count it.
      const originalRename = fs.promises.rename;
      fs.promises.rename = jest.fn(async () => {
        throw new Error('ENOSPC: simulated disk full');
      });

      let caught;
      try {
        await t.recordUsage({
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          inputTokens: 999,
          outputTokens: 999
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();

      // Rollback: in-memory counters should reflect ONLY the first call.
      const month = t.getMonthlyUsage()['2026-04']?.anthropic;
      expect(month.inputTokens).toBe(100);
      expect(month.outputTokens).toBe(50);

      // Restore rename and retry: should now succeed and write the correct
      // total (100 + 999 = 1099, NOT 100 + 999 + 999 = double-counted).
      fs.promises.rename = originalRename;
      await t.recordUsage({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        inputTokens: 999,
        outputTokens: 999
      });
      const finalMonth = t.getMonthlyUsage()['2026-04']?.anthropic;
      expect(finalMonth.inputTokens).toBe(1099);
      expect(finalMonth.outputTokens).toBe(1049);
    });

    test('load throws on non-ENOENT failure (not silent fresh-start)', async () => {
      // Inject a corrupted file so readFile resolves but JSON.parse fails.
      fs.__mockFiles.set('/tmp/userData/ai-cost-tracker.json', Buffer.from('not valid json'));
      const t = makeTracker();
      await expect(t.load()).rejects.toThrow();
      // _loaded must remain false so subsequent recordUsage calls retry the
      // load instead of starting from empty data and overwriting on persist.
      expect(t._loaded).toBe(false);
    });
  });
});
