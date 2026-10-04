/**
 * IPC Enforcement Tests (audit item #2)
 *
 * The shared module centralises the EVENT_ONLY and CONCURRENCY_LIMITED sets
 * that were previously hand-maintained in preload.js. The whole point of the
 * refactor is to make drift between `src/shared/constants.js` and these sets
 * structurally impossible: every entry is resolved against IPC_CHANNELS at
 * require-time, so a typo or stale entry throws synchronously.
 *
 * These tests assert that runtime invariant fires.
 */

describe('ipcEnforcement', () => {
  let ipcEnforcement;
  let IPC_CHANNELS;

  beforeAll(() => {
    jest.resetModules();
    ipcEnforcement = require('../src/shared/ipcEnforcement');
    IPC_CHANNELS = require('../src/shared/constants').IPC_CHANNELS;
  });

  describe('self-validation at module load', () => {
    test('every EVENT_ONLY entry resolves to a real IPC_CHANNELS value', () => {
      const realChannels = new Set(
        Object.values(IPC_CHANNELS)
          .flatMap((cat) => Object.values(cat || {}))
          .filter((v) => typeof v === 'string')
      );
      for (const channel of ipcEnforcement.EVENT_ONLY_CHANNELS) {
        expect(realChannels.has(channel)).toBe(true);
      }
    });

    test('every CONCURRENCY_LIMITED entry resolves to a real IPC_CHANNELS value', () => {
      const realChannels = new Set(
        Object.values(IPC_CHANNELS)
          .flatMap((cat) => Object.values(cat || {}))
          .filter((v) => typeof v === 'string')
      );
      for (const channel of ipcEnforcement.CONCURRENCY_LIMITED_CHANNELS) {
        expect(realChannels.has(channel)).toBe(true);
      }
    });

    test('every DOWNLOADS_TRIAGE_MUTATION entry resolves to a real IPC_CHANNELS value', () => {
      const realChannels = new Set(
        Object.values(IPC_CHANNELS)
          .flatMap((cat) => Object.values(cat || {}))
          .filter((v) => typeof v === 'string')
      );
      for (const channel of ipcEnforcement.DOWNLOADS_TRIAGE_MUTATION_CHANNELS) {
        expect(realChannels.has(channel)).toBe(true);
      }
    });

    test('throws if a ref points to a non-existent channel', () => {
      // Simulate the drift case: a future contributor adds a category/endpoint
      // pair that does not exist in constants.js. The module must throw at
      // require-time, not silently accept undefined.
      jest.isolateModules(() => {
        jest.doMock('../src/shared/constants', () => ({
          IPC_CHANNELS: {
            EMBEDDINGS: {
              // Note: FULL_REBUILD intentionally MISSING from this mocked shape.
            }
          }
        }));
        expect(() => {
          // Re-require with the broken IPC_CHANNELS shape — should throw.
          require('../src/shared/ipcEnforcement');
        }).toThrow(/not a registered channel/i);
      });
    });
  });

  describe('resolveConcurrencyLockKey', () => {
    test('returns shared key for triage-mutation channels', () => {
      const triageStart = IPC_CHANNELS.DOWNLOADS.TRIAGE_START;
      const triageDeep = IPC_CHANNELS.DOWNLOADS.TRIAGE_DEEP_SCAN;
      const triageAct = IPC_CHANNELS.DOWNLOADS.TRIAGE_ACT;
      expect(ipcEnforcement.resolveConcurrencyLockKey(triageStart)).toBe(
        'downloads:triage:mutation'
      );
      expect(ipcEnforcement.resolveConcurrencyLockKey(triageDeep)).toBe(
        'downloads:triage:mutation'
      );
      expect(ipcEnforcement.resolveConcurrencyLockKey(triageAct)).toBe('downloads:triage:mutation');
    });

    test('returns the channel name for any other channel', () => {
      const fullRebuild = IPC_CHANNELS.EMBEDDINGS.FULL_REBUILD;
      expect(ipcEnforcement.resolveConcurrencyLockKey(fullRebuild)).toBe(fullRebuild);
    });

    test('returns the channel name for a channel that is not concurrency-limited', () => {
      const select = IPC_CHANNELS.FILES.SELECT;
      expect(ipcEnforcement.resolveConcurrencyLockKey(select)).toBe(select);
    });
  });

  describe('isConcurrencyLimited', () => {
    test('returns true for CONCURRENCY_LIMITED members', () => {
      expect(ipcEnforcement.isConcurrencyLimited(IPC_CHANNELS.EMBEDDINGS.FULL_REBUILD)).toBe(true);
    });

    test('returns true for triage-mutation members', () => {
      expect(ipcEnforcement.isConcurrencyLimited(IPC_CHANNELS.DOWNLOADS.TRIAGE_ACT)).toBe(true);
    });

    test('returns false for non-limited channels', () => {
      expect(ipcEnforcement.isConcurrencyLimited(IPC_CHANNELS.FILES.SELECT)).toBe(false);
    });
  });

  describe('contract — counts match preload.js historical sets', () => {
    // Regression guard: the refactor of audit item #2 must not silently shrink
    // any of these sets. The original preload.js EVENT_ONLY set had 8 entries,
    // CONCURRENCY_LIMITED had 21, and triage-mutation had 3. If anyone removes
    // an entry without justification, this test catches it. The concurrency set
    // grew to 23 when ORGANIZE.AUTO/BATCH were added (F-032) — a justified
    // addition. It shrank to 22 when the dead/redundant EMBEDDINGS.CLEAR_STORE
    // bridge was retired (F-019) — a justified removal, so the pinned count was
    // bumped down to match.
    test('EVENT_ONLY_CHANNELS has 8 entries', () => {
      expect(ipcEnforcement.EVENT_ONLY_CHANNELS.size).toBe(8);
    });

    test('CONCURRENCY_LIMITED_CHANNELS has 22 entries', () => {
      expect(ipcEnforcement.CONCURRENCY_LIMITED_CHANNELS.size).toBe(22);
    });

    test('DOWNLOADS_TRIAGE_MUTATION_CHANNELS has 3 entries', () => {
      expect(ipcEnforcement.DOWNLOADS_TRIAGE_MUTATION_CHANNELS.size).toBe(3);
    });
  });
});
