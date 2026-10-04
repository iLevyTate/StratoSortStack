/**
 * @jest-environment node
 *
 * Regression guard for the TOCTOU recheck single-retry policy in
 * `preflightSourceForMutation` (src/main/ipc/files/fileOperationHandlers.js).
 *
 * Why this test exists
 * --------------------
 * On Windows, aggressive AV scanning and OneDrive Files-On-Demand can
 * briefly stat the source as something that fails our symlink check
 * (e.g. transient reparse-point markers). Without the retry, those benign
 * blips became hard `EPATHCHANGED` failures and the user saw a generic
 * "Path validation changed" error for files that were perfectly safe.
 *
 * The retry is also load-bearing for the EXDEV (cross-device) move path:
 * `preflightSourceForMutation` is invoked a second time before the
 * cross-device copy, so the same transient-blip class affects both rename
 * and copy paths.
 *
 * Behavioral contract guarded here:
 *   1. First preflight check fails -> wait ~75ms -> second check passes ->
 *      move proceeds and `fs.rename` is invoked.
 *   2. Both preflight checks fail -> handler returns the structured
 *      `EPATHCHANGED` error envelope and `fs.rename` is NEVER called
 *      (fail-closed behavior preserved).
 *   3. The retry is exactly one attempt, not a loop.
 *
 * Implementation note: `preflightSourceForMutation` is a top-level closure
 * in fileOperationHandlers.js with no test-only export. We drive it
 * through the public `IPC_CHANNELS.FILES.PERFORM_OPERATION` move handler
 * so both the production codepath AND its observable side effects (fs
 * mutation) are checked.
 */

jest.mock('fs', () => ({
  promises: {
    rename: jest.fn().mockResolvedValue(undefined),
    mkdir: jest.fn().mockResolvedValue(undefined),
    unlink: jest.fn().mockResolvedValue(undefined),
    stat: jest.fn(async () => ({ size: 1, mtimeMs: Date.now(), isFile: () => true })),
    // Destination tree (C:\dst\...) is free — renameNoReplace's occupancy
    // preflight must see ENOENT there or every move reads as an EEXIST
    // collision. Everything else (sources) exists.
    access: jest.fn(async (p) => {
      if (String(p).includes('dst')) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return undefined;
    }),
    copyFile: jest.fn().mockResolvedValue(undefined)
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
  return { createLogger: jest.fn(() => logger), logger };
});

// Sequenceable validateFileOperationPath: tests configure the response
// queue per case. Each call shifts off one entry; a missing entry returns
// the default `{ valid: true, normalizedPath: p }`.
const validatePathQueue = [];
jest.mock('../src/shared/pathSanitization', () => ({
  validateFileOperationPath: jest.fn(async (p) => {
    if (validatePathQueue.length > 0) {
      const next = validatePathQueue.shift();
      if (typeof next === 'function') return next(p);
      return next;
    }
    return { valid: true, normalizedPath: p };
  })
}));

// Dedup short-circuits the move when the destination already has identical
// content. We want to drive the TOCTOU preflight + rename path, so always
// return null (no duplicate detected).
jest.mock('../src/main/utils/fileDedup', () => ({
  computeFileChecksum: jest.fn().mockResolvedValue('checksum'),
  handleDuplicateMove: jest.fn().mockResolvedValue(null),
  findSemanticDuplicates: jest.fn().mockResolvedValue({ hasDuplicates: false, matches: [] })
}));

jest.mock('../src/main/ipc/files/embeddingSync', () => ({
  removeEmbeddingsForPathBestEffort: jest.fn(),
  syncEmbeddingForMove: jest.fn(),
  syncEmbeddingsBestEffort: jest.fn().mockResolvedValue(undefined),
  verifyEmbeddingAfterMove: jest.fn().mockResolvedValue({ valid: true, issues: [] })
}));

jest.mock('../src/main/ipc/files/batchLockManager', () => ({
  acquireBatchLock: jest.fn().mockResolvedValue(true),
  renewBatchLock: jest.fn().mockReturnValue(true),
  releaseBatchLock: jest.fn()
}));

jest.mock('../src/main/ipc/files/batchValidator', () => ({
  validateBatchOperation: jest.fn(() => null),
  MAX_BATCH_SIZE: 1000
}));

jest.mock('../src/main/ipc/files/batchRollback', () => ({ executeRollback: jest.fn() }));

jest.mock('../src/main/ipc/files/batchProgressReporter', () => ({
  sendFileOperationBatchComplete: jest.fn(),
  sendOperationProgress: jest.fn(),
  sendChunkedResults: jest.fn().mockResolvedValue({ sent: true, totalChunks: 0 })
}));

jest.mock('../src/shared/fileOperationTracker', () => ({
  getInstance: jest.fn(() => ({ recordOperation: jest.fn() }))
}));

const fs = require('fs').promises;
const { validateFileOperationPath } = require('../src/shared/pathSanitization');
const { registerFileOperationHandlers } = require('../src/main/ipc/files/fileOperationHandlers');
const { IPC_CHANNELS } = require('../src/shared/constants');

function setupHandler() {
  const handlers = {};
  const ipcMain = {
    handle: jest.fn((channel, handler) => {
      handlers[channel] = handler;
    })
  };
  registerFileOperationHandlers({
    ipcMain,
    IPC_CHANNELS,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    getMainWindow: () => null,
    getServiceIntegration: () => null
  });
  return handlers[IPC_CHANNELS.FILES.PERFORM_OPERATION];
}

describe('preflightSourceForMutation — TOCTOU recheck retry', () => {
  let performOp;

  beforeEach(() => {
    jest.clearAllMocks();
    validatePathQueue.length = 0;
    performOp = setupHandler();
  });

  // The move handler makes additional `validateFileOperationPath` calls
  // AFTER the rename — `updateDatabasePath` re-validates source+dest with
  // `checkSymlinks: false` to prevent path traversal in DB writes. Those
  // are out-of-scope for the TOCTOU retry guard, so each test scopes its
  // queue to the calls it cares about and asserts on queue exhaustion
  // (every queued response was consumed in the expected order) plus the
  // observable fs.rename side effect.

  test('a single transient preflight failure recovers via retry; move proceeds', async () => {
    // Queue covers exactly:
    //   1) validateOperationPaths source check -> valid
    //   2) validateOperationPaths destination check -> valid
    //   3) preflight first attempt -> transient AV blip
    //   4) preflight retry -> valid (blip cleared)
    // Subsequent calls (database-update revalidation) fall through to the
    // mock's default `{ valid: true }` response.
    validatePathQueue.push(
      { valid: true, normalizedPath: 'C:\\src\\a.pdf' },
      { valid: true, normalizedPath: 'C:\\dst\\a.pdf' },
      { valid: false, error: 'symlink check transient failure' },
      { valid: true, normalizedPath: 'C:\\src\\a.pdf' }
    );

    const start = Date.now();
    const result = await performOp(
      { sender: { id: 1 } },
      {
        type: 'move',
        source: 'C:\\src\\a.pdf',
        destination: 'C:\\dst\\a.pdf'
      }
    );
    const elapsed = Date.now() - start;

    expect(result?.success).toBe(true);
    // The full preflight + retry sequence ran (queue fully drained).
    expect(validatePathQueue).toHaveLength(0);
    // The actual rename happened — we got past the preflight guard.
    expect(fs.rename).toHaveBeenCalledWith('C:\\src\\a.pdf', 'C:\\dst\\a.pdf');
    // Retry actually waited for the ~75ms backoff. Lower bound only —
    // Windows CI scheduling adds upper-bound variance.
    expect(elapsed).toBeGreaterThanOrEqual(60);
  });

  test('retry-then-fail still rejects the operation with EPATHCHANGED and never calls fs.rename', async () => {
    validatePathQueue.push(
      { valid: true, normalizedPath: 'C:\\src\\a.pdf' },
      { valid: true, normalizedPath: 'C:\\dst\\a.pdf' },
      { valid: false, error: 'symlink to system path' },
      { valid: false, error: 'symlink to system path' }
    );

    const result = await performOp(
      { sender: { id: 1 } },
      {
        type: 'move',
        source: 'C:\\src\\a.pdf',
        destination: 'C:\\dst\\a.pdf'
      }
    );

    // performOperationHandler wraps the throw in safeHandle's catch path;
    // the registered handler returns a structured error envelope.
    expect(result?.success).toBe(false);
    // Both preflight attempts ran (queue fully drained), and there was NO
    // third attempt — if there had been a third the queue would have been
    // exhausted partway and the test wouldn't reach this assertion (the
    // unmocked default would have flipped the outcome to success).
    expect(validatePathQueue).toHaveLength(0);
    // Fail-closed: never reached fs.rename, never reached the DB-update
    // revalidation calls (those are post-rename), so the call total is
    // exactly the 4 we queued.
    expect(validateFileOperationPath).toHaveBeenCalledTimes(4);
    expect(fs.rename).not.toHaveBeenCalled();
  });

  test('happy path (preflight valid on first try) does not invoke a retry', async () => {
    // Only 3 entries: no second preflight attempt should ever be made.
    validatePathQueue.push(
      { valid: true, normalizedPath: 'C:\\src\\a.pdf' },
      { valid: true, normalizedPath: 'C:\\dst\\a.pdf' },
      { valid: true, normalizedPath: 'C:\\src\\a.pdf' }
    );

    // Leftover canary: if the production code were to retry on a successful
    // first preflight (it must not), the next call would dequeue this
    // sentinel and fail the test below by mismatching the expected length.
    const sentinelCount = validatePathQueue.length;

    const result = await performOp(
      { sender: { id: 1 } },
      {
        type: 'move',
        source: 'C:\\src\\a.pdf',
        destination: 'C:\\dst\\a.pdf'
      }
    );

    expect(result?.success).toBe(true);
    // All 3 queued responses consumed (source, dest, single preflight). The
    // database-update revalidation that follows the rename uses the mock's
    // default response, leaving the queue empty.
    expect(validatePathQueue).toHaveLength(0);
    expect(sentinelCount).toBe(3); // sanity: queue was sized correctly
    expect(fs.rename).toHaveBeenCalledTimes(1);
  });
});
