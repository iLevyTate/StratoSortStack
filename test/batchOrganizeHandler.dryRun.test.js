/**
 * @jest-environment node
 *
 * Dry-run preview tests for batchOrganizeHandler.previewBatchOrganize and
 * the handleBatchOrganize early-return path triggered by operation.dryRun.
 *
 * Mocks fs.access to simulate source/destination existence; we never want
 * the real filesystem touched in this suite. The simulated layout uses an
 * in-memory Set of "existing paths"; helpers check membership and the
 * mocked fs.access throws ENOENT for paths not in the set.
 */

const path = require('path');

// In-memory simulated filesystem. Tests populate this set; mocked fs.access
// resolves for members and rejects with ENOENT otherwise.
const mockExistingPaths = new Set();

jest.mock('fs', () => ({
  promises: {
    access: jest.fn(async (p) => {
      if (mockExistingPaths.has(p)) return undefined;
      const err = new Error(`ENOENT: ${p}`);
      err.code = 'ENOENT';
      throw err;
    }),
    rename: jest.fn(),
    mkdir: jest.fn(),
    unlink: jest.fn(),
    stat: jest.fn()
  }
}));

jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  };
  return {
    createLogger: jest.fn(() => logger),
    logger
  };
});

jest.mock('../src/main/ipc/files/batchLockManager', () => ({
  acquireBatchLock: jest.fn().mockResolvedValue(true),
  renewBatchLock: jest.fn().mockReturnValue(true),
  releaseBatchLock: jest.fn()
}));

jest.mock('../src/main/ipc/files/batchValidator', () => ({
  validateBatchOperation: jest.fn(() => null),
  MAX_BATCH_SIZE: 1000
}));

jest.mock('../src/main/ipc/files/batchRollback', () => ({
  executeRollback: jest.fn()
}));

jest.mock('../src/main/ipc/files/batchProgressReporter', () => ({
  sendOperationProgress: jest.fn(),
  sendChunkedResults: jest.fn()
}));

jest.mock('../src/shared/fileOperationTracker', () => ({
  getInstance: jest.fn(() => ({ recordOperation: jest.fn() }))
}));

const {
  previewBatchOrganize,
  handleBatchOrganize
} = require('../src/main/ipc/files/batchOrganizeHandler');
const { acquireBatchLock } = require('../src/main/ipc/files/batchLockManager');

beforeEach(() => {
  mockExistingPaths.clear();
  jest.clearAllMocks();
});

describe('previewBatchOrganize', () => {
  test('happy path: no collisions, all sources exist', async () => {
    mockExistingPaths.add('/in/a.pdf');
    mockExistingPaths.add('/in/b.pdf');
    mockExistingPaths.add('/out'); // dest dir exists

    const operation = {
      operations: [
        { source: '/in/a.pdf', destination: '/out/a.pdf' },
        { source: '/in/b.pdf', destination: '/out/b.pdf' }
      ]
    };
    const result = await previewBatchOrganize({ operation });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.total).toBe(2);
    expect(result.wouldMove).toHaveLength(2);
    expect(result.skipped).toEqual([]);
    expect(result.conflicts).toBe(0);
    expect(result.wouldCreateFolders).toEqual([]);
    expect(result.wouldMove[0]).toEqual({
      source: '/in/a.pdf',
      destination: '/out/a.pdf',
      originalDestination: '/out/a.pdf',
      collision: false
    });
  });

  test('flags missing sources as skipped (no plan entry)', async () => {
    mockExistingPaths.add('/in/exists.pdf');
    mockExistingPaths.add('/out');

    const operation = {
      operations: [
        { source: '/in/exists.pdf', destination: '/out/exists.pdf' },
        { source: '/in/missing.pdf', destination: '/out/missing.pdf' }
      ]
    };
    const result = await previewBatchOrganize({ operation });

    expect(result.wouldMove).toHaveLength(1);
    expect(result.skipped).toEqual([
      {
        source: '/in/missing.pdf',
        destination: '/out/missing.pdf',
        reason: 'source-missing'
      }
    ]);
  });

  test('detects collisions and computes the next available numeric suffix', async () => {
    mockExistingPaths.add('/in/a.pdf');
    mockExistingPaths.add('/out');
    mockExistingPaths.add('/out/a.pdf'); // collision
    mockExistingPaths.add('/out/a_1.pdf'); // also taken
    // /out/a_2.pdf is NOT in the set → that's the resolved name. The suffix
    // shape (`_N`) MUST match what performFileMove produces — see
    // formatNumberedCollisionCandidate. Tests guarding the old `(N)` shape
    // were the canary for the post-2.0.9 preview drift.

    const operation = {
      operations: [{ source: '/in/a.pdf', destination: '/out/a.pdf' }]
    };
    const result = await previewBatchOrganize({ operation });

    expect(result.conflicts).toBe(1);
    expect(result.wouldMove[0]).toMatchObject({
      source: '/in/a.pdf',
      destination: '/out/a_2.pdf',
      originalDestination: '/out/a.pdf',
      collision: true
    });
  });

  test('extension is preserved when adding numeric suffixes', async () => {
    mockExistingPaths.add('/in/report.tar.gz');
    mockExistingPaths.add('/out');
    mockExistingPaths.add('/out/report.tar.gz'); // collision
    // path.extname returns the LAST .ext, so '.gz' here. Mirrors real handler.

    const operation = {
      operations: [{ source: '/in/report.tar.gz', destination: '/out/report.tar.gz' }]
    };
    const result = await previewBatchOrganize({ operation });

    expect(result.wouldMove[0].destination).toBe('/out/report.tar_1.gz');
  });

  test('falls back to UUID label when numeric suffixes are exhausted', async () => {
    mockExistingPaths.add('/in/a.pdf');
    mockExistingPaths.add('/out');
    mockExistingPaths.add('/out/a.pdf');
    // Exhaust all preview attempts using the same suffix shape the executor
    // produces (`_N`) so we land on the UUID-fallback branch.
    const { PREVIEW_MAX_NUMERIC_ATTEMPTS } = require('../src/main/ipc/files/batchOrganizeHandler');
    for (let i = 1; i <= PREVIEW_MAX_NUMERIC_ATTEMPTS; i += 1) {
      mockExistingPaths.add(`/out/a_${i}.pdf`);
    }

    const operation = {
      operations: [{ source: '/in/a.pdf', destination: '/out/a.pdf' }]
    };
    const result = await previewBatchOrganize({ operation });

    expect(result.wouldMove[0].destination).toBe('/out/a_uuid.pdf');
    expect(result.wouldMove[0].collision).toBe(true);
  });

  test('records folders that would need to be created', async () => {
    mockExistingPaths.add('/in/a.pdf');
    // /out is NOT in the set → would-create
    // /existing-out IS in the set → not in would-create
    mockExistingPaths.add('/existing-out');
    mockExistingPaths.add('/in/b.pdf');

    const operation = {
      operations: [
        { source: '/in/a.pdf', destination: '/out/a.pdf' },
        { source: '/in/b.pdf', destination: '/existing-out/b.pdf' }
      ]
    };
    const result = await previewBatchOrganize({ operation });

    expect(result.wouldCreateFolders).toEqual(['/out']);
  });

  test('rejects malformed operations (missing source or destination)', async () => {
    const operation = {
      operations: [
        { source: '/in/a.pdf' }, // no destination
        { destination: '/out/b.pdf' }, // no source
        null
      ]
    };
    const result = await previewBatchOrganize({ operation });

    expect(result.skipped).toHaveLength(3);
    for (const entry of result.skipped) {
      expect(entry.reason).toBe('invalid-operation');
    }
    expect(result.wouldMove).toEqual([]);
  });

  test('empty operations array returns an empty plan', async () => {
    const result = await previewBatchOrganize({ operation: { operations: [] } });
    expect(result).toEqual({
      success: true,
      dryRun: true,
      total: 0,
      wouldMove: [],
      skipped: [],
      wouldCreateFolders: [],
      conflicts: 0
    });
  });
});

describe('handleBatchOrganize — dryRun routing', () => {
  test('operation.dryRun=true short-circuits to preview without acquiring the lock', async () => {
    mockExistingPaths.add('/in/a.pdf');
    mockExistingPaths.add('/out');

    const operation = {
      type: 'batch_organize',
      dryRun: true,
      operations: [{ source: '/in/a.pdf', destination: '/out/a.pdf' }]
    };
    const result = await handleBatchOrganize({
      operation,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      getServiceIntegration: () => null,
      getMainWindow: () => null
    });

    expect(result.dryRun).toBe(true);
    expect(result.wouldMove).toHaveLength(1);
    // Critical safety property: the batch lock is NEVER acquired in dry-run.
    expect(acquireBatchLock).not.toHaveBeenCalled();
  });

  test('operation.dryRun=false (default) does not divert into preview', async () => {
    // Provide a non-trivial operations list so the real handler attempts
    // to acquire the lock; we only need to assert that it did, not that
    // the full flow completes (it'll bail without service integration).
    const operation = {
      type: 'batch_organize',
      operations: [{ source: '/in/a.pdf', destination: '/out/a.pdf' }]
    };
    await handleBatchOrganize({
      operation,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      getServiceIntegration: () => null,
      getMainWindow: () => null
    }).catch(() => {
      /* downstream will throw without a real service integration; that's OK */
    });
    expect(acquireBatchLock).toHaveBeenCalled();
  });
});
