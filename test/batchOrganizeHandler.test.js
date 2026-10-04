/**
 * @jest-environment node
 */
const { handleBatchOrganize } = require('../src/main/ipc/files/batchOrganizeHandler');
const { ERROR_CODES } = require('../src/shared/errorHandlingUtils');
const { validateFileOperationPath } = require('../src/shared/pathSanitization');

// Mock all dependencies
jest.mock('fs', () => ({
  promises: {
    access: jest.fn().mockResolvedValue(),
    rename: jest.fn().mockResolvedValue(),
    mkdir: jest.fn().mockResolvedValue(),
    unlink: jest.fn().mockResolvedValue(),
    stat: jest.fn().mockResolvedValue({ size: 100 })
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
    logger: logger
  };
});

jest.mock('../src/main/ipc/files/batchLockManager', () => ({
  acquireBatchLock: jest.fn().mockResolvedValue(true),
  renewBatchLock: jest.fn().mockReturnValue(true),
  releaseBatchLock: jest.fn()
}));

// FilePathCoordinator drives `pathIndexUpdated`; per-op persistence is only
// journaled when the coordinator reports success, so give the handler a
// controllable one instead of the real container (which has none in tests).
const mockCoordinator = {
  batchPathUpdate: jest.fn().mockResolvedValue({ success: true, summary: {} })
};
jest.mock('../src/main/services/ServiceContainer', () => ({
  container: {
    has: jest.fn((id) => id === 'filePathCoordinator'),
    resolve: jest.fn(() => mockCoordinator),
    tryResolve: jest.fn(() => null)
  },
  ServiceIds: {
    FILE_PATH_COORDINATOR: 'filePathCoordinator',
    LEARNING_FEEDBACK: 'learningFeedback'
  }
}));

// The learning block requires FolderMatchingService lazily; the real module
// cannot load under this suite's fs mock, which made that block fail silently.
jest.mock('../src/main/services/FolderMatchingService', () => ({
  matchCategoryToFolder: jest.fn(() => null)
}));

jest.mock('../src/main/ipc/files/batchValidator', () => ({
  validateBatchOperation: jest.fn(() => null), // Returns null on success
  MAX_BATCH_SIZE: 1000
}));

jest.mock('../src/main/ipc/files/batchRollback', () => ({
  executeRollback: jest.fn().mockResolvedValue({ success: false, rolledBack: true })
}));

jest.mock('../src/main/ipc/files/batchProgressReporter', () => ({
  sendFileOperationBatchComplete: jest.fn(),
  sendOperationProgress: jest.fn(),
  sendChunkedResults: jest.fn().mockResolvedValue({ sent: true })
}));

jest.mock('../src/shared/fileOperationTracker', () => ({
  getInstance: jest.fn(() => ({
    recordOperation: jest.fn()
  }))
}));

jest.mock('../src/main/ipc/files/embeddingSync', () => ({
  syncEmbeddingForMove: jest.fn(),
  removeEmbeddingsForPathBestEffort: jest.fn()
}));

jest.mock('../src/main/utils/fileDedup', () => ({
  computeFileChecksum: jest.fn().mockResolvedValue('checksum123'),
  handleDuplicateMove: jest.fn().mockResolvedValue(null) // Return null means no duplicate handled, proceed with move
}));

jest.mock('../src/shared/atomicFileOperations', () => ({
  crossDeviceMove: jest.fn(),
  // Delegate to the suite's fs.rename mock so tests keep driving collision
  // behavior by seeding fs.rename rejections. Real no-replace semantics
  // (occupancy preflight -> synthetic EEXIST) are covered by
  // atomicFileOperations.test.js and analyzeNameOrganize.e2e.test.js.
  renameNoReplace: jest.fn((src, dest) => require('fs').promises.rename(src, dest))
}));

jest.mock('../src/shared/pathSanitization', () => ({
  validateFileOperationPath: jest.fn((p) => ({ valid: true, normalizedPath: p })),
  // Reached by the smart-folder lookup once a batch has smart folders.
  normalizePathForIndex: jest.fn((p) => String(p).replace(/\\/g, '/'))
}));

jest.mock('../src/shared/promiseUtils', () => {
  // Minimal Semaphore for tests (no timeout/queue-limit overhead)
  class MockSemaphore {
    constructor(max) {
      this.max = max;
      this.active = 0;
      this.queue = [];
    }
    async acquire() {
      if (this.active < this.max) {
        this.active++;
        return;
      }
      await new Promise((resolve) => this.queue.push(resolve));
    }
    release() {
      if (this.queue.length > 0) {
        this.queue.shift()();
      } else if (this.active > 0) {
        this.active--;
      }
    }
  }
  return {
    withTimeout: jest.fn((promise) => promise),
    batchProcess: jest.fn().mockResolvedValue(),
    withAbortableTimeout: jest.fn((fn) => fn({ signal: {} })),
    delay: jest.fn().mockResolvedValue(),
    Semaphore: MockSemaphore,
    createBackgroundWorkTracker: jest.fn(() => ({
      track: jest.fn((p) => p),
      drain: jest.fn(),
      get size() {
        return 0;
      }
    })),
    createInitGuard: jest.fn(() => ({
      isInitialized: () => false,
      initialize: jest.fn(async (fn) => fn()),
      reset: jest.fn(),
      requireInitialized: jest.fn()
    }))
  };
});

jest.mock('../src/shared/correlationId', () => ({
  withCorrelationId: jest.fn((fn) => fn())
}));

// Mock semantic service (needed for rebuild check)
// Destination policy: real module with the decision points wrapped so one
// test can refuse a landing folder; otherwise the global electron mock's
// dialog approves, as it does for every pre-existing test here.
jest.mock('../src/main/ipc/files/destinationPolicy', () => {
  const actual = jest.requireActual('../src/main/ipc/files/destinationPolicy');
  return {
    ...actual,
    authorizeDestination: jest.fn(actual.authorizeDestination),
    authorizeDestinations: jest.fn(actual.authorizeDestinations)
  };
});

jest.mock('../src/main/ipc/semantic', () => ({
  getSearchServiceInstance: jest.fn(() => ({
    invalidateAndRebuild: jest.fn().mockResolvedValue()
  }))
}));

describe('Batch Organize Handler', () => {
  let params;
  let mockLogger;
  let fs;
  let batchLockManager;
  let fileDedup;

  beforeEach(() => {
    jest.clearAllMocks();

    fs = require('fs').promises;
    batchLockManager = require('../src/main/ipc/files/batchLockManager');
    fileDedup = require('../src/main/utils/fileDedup');
    mockLogger = require('../src/shared/logger').logger;

    // Fix fs.access mock to handle verifyMoveCompletion correctly
    // It verifies destination exists (resolve) and source is gone (reject ENOENT)
    fs.access.mockImplementation(async (p) => {
      if (p.includes('dest')) return;
      if (p.includes('src')) throw { code: 'ENOENT' };
      return;
    });
    // Re-seed: clearAllMocks keeps implementations, so per-test stat overrides
    // would otherwise bleed into later tests.
    fs.stat.mockReset().mockResolvedValue({ size: 100 });
    mockCoordinator.batchPathUpdate.mockReset().mockResolvedValue({ success: true, summary: {} });

    params = {
      operation: {
        operations: [
          { source: '/src/doc1.pdf', destination: '/dest/doc1.pdf', type: 'move' },
          { source: '/src/doc2.pdf', destination: '/dest/doc2.pdf', type: 'move' }
        ]
      },
      logger: mockLogger,
      getServiceIntegration: jest.fn(() => ({
        processingState: {
          createOrLoadOrganizeBatch: jest.fn((id, ops) => ({ operations: ops })),
          markOrganizeOpStarted: jest.fn(),
          markOrganizeOpDone: jest.fn(),
          markOrganizeOpError: jest.fn(),
          completeOrganizeBatch: jest.fn()
        },
        undoRedo: {
          recordAction: jest.fn()
        }
      })),
      getMainWindow: jest.fn()
    };
  });

  test('successfully processes a batch of moves', async () => {
    const result = await handleBatchOrganize(params);

    expect(result.success).toBe(true);
    expect(result.successCount).toBe(2);
    expect(fs.rename).toHaveBeenCalledTimes(2);
    expect(batchLockManager.acquireBatchLock).toHaveBeenCalled();
    expect(batchLockManager.releaseBatchLock).toHaveBeenCalled();
  });

  test('decides every landing folder once, before the lock, and moves nothing into a refused one', async () => {
    const policy = require('../src/main/ipc/files/destinationPolicy');
    policy.authorizeDestinations.mockResolvedValueOnce(new Map());
    policy.authorizeDestination.mockResolvedValue({
      allowed: false,
      reason: 'declined',
      errorCode: 'DESTINATION_NOT_ALLOWED',
      error: 'Destination folder was not approved: /dest'
    });
    try {
      const result = await handleBatchOrganize(params);

      expect(policy.authorizeDestinations).toHaveBeenCalledWith(
        params.operation.operations,
        expect.objectContaining({ getMainWindow: params.getMainWindow })
      );
      expect(policy.authorizeDestinations.mock.invocationCallOrder[0]).toBeLessThan(
        batchLockManager.acquireBatchLock.mock.invocationCallOrder[0]
      );
      expect(result.success).toBe(false);
      expect(fs.rename).not.toHaveBeenCalled();
    } finally {
      policy.authorizeDestination.mockReset();
      policy.authorizeDestination.mockImplementation(
        jest.requireActual('../src/main/ipc/files/destinationPolicy').authorizeDestination
      );
    }
  });

  test('a folder the batch decision refused fails every file in it with the policy code, asking nobody twice', async () => {
    const policy = require('../src/main/ipc/files/destinationPolicy');
    const actual = jest.requireActual('../src/main/ipc/files/destinationPolicy');
    // Earlier tests approved /dest through the global dialog mock, and an
    // approval lasts the session.
    actual._resetDestinationPolicyForTests();
    const declining = { showMessageBox: jest.fn(async () => ({ response: 1 })) };
    // A real batch decision: one dialog for /dest, declined.
    const refused = await actual.authorizeDestinations(params.operation.operations, {
      dialog: declining,
      app: { isPackaged: true, getPath: () => '/nowhere/app' },
      home: '/nowhere/home',
      env: {},
      getServiceIntegration: () => ({})
    });
    expect(declining.showMessageBox).toHaveBeenCalledTimes(1);
    policy.authorizeDestinations.mockResolvedValueOnce(refused);
    policy.authorizeDestination.mockClear();

    const result = await handleBatchOrganize(params);

    expect(result.success).toBe(false);
    expect(fs.rename).not.toHaveBeenCalled();
    // The per-folder decision is reused per operation; no second prompt.
    expect(policy.authorizeDestination).not.toHaveBeenCalled();
    expect(result.results).toHaveLength(2);
    for (const r of result.results) {
      expect(r).toEqual(
        expect.objectContaining({ success: false, errorCode: 'DESTINATION_NOT_ALLOWED' })
      );
      expect(r.error).toMatch(/not approved/);
    }
  });

  // The learning branch had no coverage. It must record the file's category
  // (the analysis label when it diverged from the destination), or the
  // pattern is stored as `<ext>:unknown:<folder>` and never matches again.
  test('records learning with the analysis category for moves into a smart folder', async () => {
    const { container } = require('../src/main/services/ServiceContainer');
    const learning = require('../src/main/services/organization/learningFeedback');
    const mockLearning = {
      getSmartFolders: () => [{ name: 'Finance', path: '/dest' }],
      recordFileMove: jest.fn().mockResolvedValue(true),
      recordCorrection: jest.fn().mockResolvedValue(false)
    };
    const hasImpl = container.has.getMockImplementation();
    const resolveImpl = container.resolve.getMockImplementation();
    container.has.mockImplementation(
      (id) => id === 'filePathCoordinator' || id === 'learningFeedback'
    );
    container.resolve.mockImplementation((id) =>
      id === 'learningFeedback' ? mockLearning : mockCoordinator
    );
    const spy = jest.spyOn(learning, 'getInstance').mockReturnValue(mockLearning);
    mockCoordinator.batchPathUpdate.mockResolvedValueOnce({
      success: true,
      summary: {},
      divergences: [{ filePath: '/dest/doc1.pdf', oldCategory: 'Invoices', newCategory: 'Finance' }]
    });

    try {
      const result = await handleBatchOrganize(params);

      expect(result.success).toBe(true);
      expect(mockLearning.recordFileMove).toHaveBeenCalledWith(
        '/src/doc1.pdf',
        '/dest/doc1.pdf',
        { category: 'Invoices' },
        learning.FEEDBACK_SOURCES.AUTO_ORGANIZE_CONFIRMED
      );
      expect(mockLearning.recordFileMove).toHaveBeenCalledWith(
        '/src/doc2.pdf',
        '/dest/doc2.pdf',
        { category: 'Finance' },
        learning.FEEDBACK_SOURCES.AUTO_ORGANIZE_CONFIRMED
      );
    } finally {
      spy.mockRestore();
      container.has.mockImplementation(hasImpl);
      container.resolve.mockImplementation(resolveImpl);
    }
  });

  // D1: Organize sends what it suggested with each op. The suggestion, not
  // the LLM label, is the reference for a correction.
  describe('corrections against the per-op suggestion', () => {
    const learning = require('../src/main/services/organization/learningFeedback');
    const { container } = require('../src/main/services/ServiceContainer');
    let mockLearning;
    let restore;

    beforeEach(() => {
      mockLearning = {
        // Receipts exists, so the old label-based rule would name it wrong.
        getSmartFolders: () => [
          { name: 'Finance', path: '/dest' },
          { name: 'Receipts', path: '/library/Receipts' }
        ],
        recordFileMove: jest.fn().mockResolvedValue(true),
        recordCorrection: jest.fn().mockResolvedValue(true)
      };
      const hasImpl = container.has.getMockImplementation();
      const resolveImpl = container.resolve.getMockImplementation();
      container.has.mockImplementation(
        (id) => id === 'filePathCoordinator' || id === 'learningFeedback'
      );
      container.resolve.mockImplementation((id) =>
        id === 'learningFeedback' ? mockLearning : mockCoordinator
      );
      const spy = jest.spyOn(learning, 'getInstance').mockReturnValue(mockLearning);
      restore = () => {
        spy.mockRestore();
        container.has.mockImplementation(hasImpl);
        container.resolve.mockImplementation(resolveImpl);
      };
    });
    afterEach(() => restore());

    test('a file the user sent away from the suggested folder records a correction against it', async () => {
      params.operation.operations = [
        {
          source: '/src/doc1.pdf',
          destination: '/dest/doc1.pdf',
          type: 'move',
          suggestion: { folder: 'Receipts', source: 'engine' }
        }
      ];

      const result = await handleBatchOrganize(params);

      expect(result.success).toBe(true);
      expect(mockLearning.recordCorrection).toHaveBeenCalledTimes(1);
      expect(mockLearning.recordCorrection).toHaveBeenCalledWith({
        filePath: '/dest/doc1.pdf',
        wrongFolder: 'Receipts',
        correctFolder: 'Finance',
        oldCategory: null
      });
    });

    test('accepting the suggestion records no correction even when the LLM label differed', async () => {
      params.operation.operations = [
        {
          source: '/src/doc1.pdf',
          destination: '/dest/doc1.pdf',
          type: 'move',
          suggestion: { folder: 'Finance', source: 'engine' }
        }
      ];
      mockCoordinator.batchPathUpdate.mockResolvedValueOnce({
        success: true,
        summary: {},
        divergences: [
          { filePath: '/dest/doc1.pdf', oldCategory: 'Receipts', newCategory: 'Finance' }
        ]
      });

      // The label-based rule maps 'Receipts' to its folder and, without a
      // suggestion on the op, would penalize it.
      const FolderMatchingService = require('../src/main/services/FolderMatchingService');
      FolderMatchingService.matchCategoryToFolder.mockReturnValueOnce('Receipts');

      const result = await handleBatchOrganize(params);

      expect(result.success).toBe(true);
      expect(mockLearning.recordFileMove).toHaveBeenCalledTimes(1);
      expect(mockLearning.recordCorrection).not.toHaveBeenCalled();
    });

    test('a generic-bucket suggestion is never recorded as a wrong folder', async () => {
      params.operation.operations = [
        {
          source: '/src/doc1.pdf',
          destination: '/dest/doc1.pdf',
          type: 'move',
          suggestion: { folder: 'Uncategorized', source: 'name' }
        }
      ];

      await handleBatchOrganize(params);

      expect(mockLearning.recordCorrection).not.toHaveBeenCalled();
    });
  });

  test('persists the source size+mtime through markOrganizeOpStarted before moving', async () => {
    // OrganizeResumeService compares these against the destination occupant
    // after a crash between rename and markOrganizeOpDone; without them every
    // such op was marked errored and dropped from undo/path updates.
    fs.stat.mockImplementation(async (p) => ({
      size: p.includes('doc1') ? 111 : 222,
      mtimeMs: p.includes('doc1') ? 1_700_000_000_000 : 1_700_000_001_000
    }));
    const svc = params.getServiceIntegration();
    params.getServiceIntegration = jest.fn(() => svc);

    const result = await handleBatchOrganize(params);

    expect(result.success).toBe(true);
    expect(svc.processingState.markOrganizeOpStarted).toHaveBeenCalledWith(expect.any(String), 0, {
      sourceSize: 111,
      sourceMtime: 1_700_000_000_000
    });
    expect(svc.processingState.markOrganizeOpStarted).toHaveBeenCalledWith(expect.any(String), 1, {
      sourceSize: 222,
      sourceMtime: 1_700_000_001_000
    });
    // The stat must observe the source BEFORE the rename removes it.
    const statOrder = fs.stat.mock.invocationCallOrder[0];
    const renameOrder = fs.rename.mock.invocationCallOrder[0];
    expect(statOrder).toBeLessThan(renameOrder);
  });

  test('still marks the op started when the source cannot be stat-ed', async () => {
    fs.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const svc = params.getServiceIntegration();
    params.getServiceIntegration = jest.fn(() => svc);

    await handleBatchOrganize(params);

    expect(svc.processingState.markOrganizeOpStarted).toHaveBeenCalledWith(
      expect.any(String),
      0,
      null
    );
  });

  test('does not leave ghost cleanup deferred when setup throws before the outer try [L2]', async () => {
    const { isGhostCleanupDeferred } = require('../src/shared/ghostCleanupGuard');
    const explodingSignal = {
      aborted: false,
      addEventListener: () => {
        throw new Error('signal wiring failed');
      }
    };

    await expect(handleBatchOrganize({ ...params, abortSignal: explodingSignal })).rejects.toThrow(
      'signal wiring failed'
    );

    expect(isGhostCleanupDeferred()).toBe(false);
    expect(fs.rename).not.toHaveBeenCalled();
    // The batch lock is acquired immediately before the outer try, so a
    // throw during abort wiring must never leave it held until restart.
    expect(batchLockManager.acquireBatchLock).not.toHaveBeenCalled();
    expect(batchLockManager.releaseBatchLock).not.toHaveBeenCalled();
  });

  test('releases the ghost cleanup latch after a completed batch', async () => {
    const { isGhostCleanupDeferred } = require('../src/shared/ghostCleanupGuard');

    await handleBatchOrganize(params);

    expect(isGhostCleanupDeferred()).toBe(false);
  });

  test('emits one batch-level FILE_OPERATION_COMPLETE with the move pairs on success [F-152]', async () => {
    // Pre-fix, only single-file performOperation moves emitted the event —
    // batch organize (the organize phase's commit path) never did, so the
    // renderer's graph/timeline remap listeners went stale after organizing.
    const {
      sendFileOperationBatchComplete
    } = require('../src/main/ipc/files/batchProgressReporter');

    const result = await handleBatchOrganize(params);

    expect(result.success).toBe(true);
    expect(sendFileOperationBatchComplete).toHaveBeenCalledTimes(1);
    const [getMainWindowArg, payload] = sendFileOperationBatchComplete.mock.calls[0];
    expect(getMainWindowArg).toBe(params.getMainWindow);
    expect(payload.operation).toBe('move');
    expect(payload.files).toEqual(expect.arrayContaining(['/src/doc1.pdf', '/src/doc2.pdf']));
    expect(payload.destinations).toEqual(
      expect.arrayContaining(['/dest/doc1.pdf', '/dest/doc2.pdf'])
    );
    expect(payload.files.length).toBe(payload.destinations.length);
  });

  test('does not emit FILE_OPERATION_COMPLETE for a rolled-back batch [F-152]', async () => {
    const {
      sendFileOperationBatchComplete
    } = require('../src/main/ipc/files/batchProgressReporter');
    fs.rename
      .mockResolvedValueOnce()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) =>
            setTimeout(() => reject({ code: 'ENOSPC', message: 'Disk full' }), 50)
          )
      );

    const result = await handleBatchOrganize(params);

    expect(result.rolledBack).toBe(true);
    // Rollback restored the disk state — a remap event would point the
    // renderer at destinations that no longer exist.
    expect(sendFileOperationBatchComplete).not.toHaveBeenCalled();
  });

  test('returns a defined BATCH_LOCK_TIMEOUT errorCode when the batch lock cannot be acquired', async () => {
    batchLockManager.acquireBatchLock.mockResolvedValueOnce(false);

    const result = await handleBatchOrganize(params);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('BATCH_LOCK_TIMEOUT');
    expect(ERROR_CODES.BATCH_LOCK_TIMEOUT).toBe('BATCH_LOCK_TIMEOUT');
    expect(batchLockManager.releaseBatchLock).not.toHaveBeenCalled();
  });

  test('handles duplicates by renaming (via performFileMove loop logic)', async () => {
    // Mock rename to fail with EEXIST once, then succeed
    fs.rename
      .mockRejectedValueOnce({ code: 'EEXIST' }) // First file rename fails
      .mockResolvedValueOnce() // First file retry succeeds (with suffix)
      .mockResolvedValueOnce(); // Second file succeeds immediately

    const result = await handleBatchOrganize(params);

    expect(result.success).toBe(true);
    // Find the result for the first file (doc1.pdf) which triggered the duplicate handling
    const doc1Result = result.results.find((r) => r.source === '/src/doc1.pdf');
    expect(doc1Result.destination).toMatch(/_\d+\.pdf$/); // Should have suffix
  });

  test('handles source file disappearing (ENOENT)', async () => {
    fs.rename.mockRejectedValueOnce({ code: 'ENOENT' }); // First file gone

    const result = await handleBatchOrganize(params);

    expect(result.success).toBe(true); // Partial success is still success: true with failure counts
    expect(result.failCount).toBe(1);
    expect(result.successCount).toBe(1);
    // Partial failure is indicated by failCount > 0, not necessarily a partialFailure flag in all return paths
  });

  test('returns success: false (not true) when an UNEXPECTED error fires the outer catch with some operations already moved', async () => {
    // Round-3 audit fix regression guard: pre-fix, an unexpected exception
    // that escaped the per-operation try/catch (e.g. processingState adapter
    // crash, analytics fault, post-move bookkeeping failure) AFTER one or
    // more operations had successfully moved files would return:
    //   { success: true, partialFailure: true, successCount: N, error: '...' }
    // Renderers that branched on `result.success` entered the happy path and
    // may have rendered "organized" while N other files were left in source.
    // Now the response is `success: false, partialFailure: true` so the
    // renderer's error path fires while `successCount + partialFailure`
    // preserves the nuance that some operations did succeed.
    //
    // We trigger the outer catch by making `completeOrganizeBatch` throw —
    // it runs AFTER all per-op processing, so both ops have already moved
    // when the throw fires.
    const throwingServiceIntegration = jest.fn(() => ({
      processingState: {
        createOrLoadOrganizeBatch: jest.fn((id, ops) => ({ operations: ops })),
        markOrganizeOpStarted: jest.fn(),
        markOrganizeOpDone: jest.fn(),
        markOrganizeOpError: jest.fn(),
        completeOrganizeBatch: jest.fn(() => {
          throw new Error('simulated processingState crash');
        })
      },
      undoRedo: {
        recordAction: jest.fn()
      }
    }));

    const result = await handleBatchOrganize({
      ...params,
      getServiceIntegration: throwingServiceIntegration
    });

    expect(result.success).toBe(false); // ← the fix
    expect(result.partialFailure).toBe(true);
    expect(result.successCount).toBe(2); // both ops moved before the crash
    expect(result.error).toMatch(/simulated processingState crash/);
    expect(result.errorCode).toBe(ERROR_CODES.PARTIAL_FAILURE);
  });

  test('triggers rollback on critical error', async () => {
    // We need one success and one critical failure to trigger rollback
    // Use a delay for the failure to ensure the first operation has time to complete/start
    // Since pLimit runs them concurrently, we want:
    // Op 1: Success (fast)
    // Op 2: Failure (delayed slightly so Op 1 might finish pushing to completedOperations,
    //       OR if Op 2 fails fast, we need to ensure Op 1 finishes.
    // Actually, if Op 2 fails immediately, it triggers abort.
    // Op 1 checks abort signal.
    // So we want Op 1 to finish BEFORE Op 2 fails.

    fs.rename
      .mockResolvedValueOnce() // First file succeeds immediately
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) =>
            setTimeout(() => reject({ code: 'ENOSPC', message: 'Disk full' }), 50)
          )
      ); // Second file fails with critical non-retryable error

    const result = await handleBatchOrganize(params);

    // The handler calls executeRollback, which we mocked to return { success: false, rolledBack: true }
    // Actually handleBatchOrganize returns whatever executeRollback returns
    expect(result.rolledBack).toBe(true);
    // Actually handleBatchOrganize returns whatever executeRollback returns
    expect(result.rolledBack).toBe(true);

    const { executeRollback } = require('../src/main/ipc/files/batchRollback');
    expect(executeRollback).toHaveBeenCalled();
  });

  test('tracks duplicate-skipped source deletion for rollback when a later critical error occurs', async () => {
    fileDedup.handleDuplicateMove.mockResolvedValueOnce({
      skipped: true,
      destination: '/dest/existing-doc1.pdf',
      reason: 'duplicate'
    });

    fs.rename.mockImplementationOnce(
      () =>
        new Promise((_, reject) =>
          setTimeout(() => reject({ code: 'ENOSPC', message: 'Disk full' }), 50)
        )
    );

    await handleBatchOrganize(params);

    const { executeRollback } = require('../src/main/ipc/files/batchRollback');
    expect(executeRollback).toHaveBeenCalled();

    const [completedOperations] = executeRollback.mock.calls[0];
    expect(completedOperations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: '/src/doc1.pdf',
          destination: '/dest/existing-doc1.pdf'
        })
      ])
    );
  });

  test('handles non-Error thrown values without crashing', async () => {
    validateFileOperationPath.mockImplementationOnce(() => {
      throw 'path-validation-failed';
    });

    const result = await handleBatchOrganize(params);

    expect(result).toBeTruthy();
    expect(result.failCount).toBeGreaterThan(0);
    expect(Array.isArray(result.results)).toBe(true);
    expect(
      result.results.some((entry) => String(entry?.error).includes('path-validation-failed'))
    ).toBe(true);
  });

  // UX-4 hard cancel: user abort must stop new moves, report skipped ops as
  // cancelled (not silent), keep completed moves undoable, and never trigger
  // rollback. Serial execution is forced via path overlap (op1.source ===
  // op0.destination) so "abort after op 0" is deterministic.
  // Stable service object: the handler calls getServiceIntegration more
  // than once (start + undo recording), and the default params factory
  // returns fresh mocks per call, which breaks call-count assertions.
  function makeStableSvc() {
    return {
      processingState: {
        createOrLoadOrganizeBatch: jest.fn((id, ops) => ({ operations: ops })),
        markOrganizeOpStarted: jest.fn(),
        markOrganizeOpDone: jest.fn(),
        markOrganizeOpError: jest.fn(),
        markOrganizeOpsPersisted: jest.fn(),
        markOrganizeBatchPaused: jest.fn(),
        clearOrganizeBatchPaused: jest.fn(),
        completeOrganizeBatch: jest.fn()
      },
      undoRedo: {
        recordAction: jest.fn(),
        hasBatchAction: jest.fn().mockResolvedValue(false)
      }
    };
  }

  describe('user cancel (hard abort)', () => {
    function makeSerialCancelParams(controller, svc) {
      return {
        ...params,
        abortSignal: controller.signal,
        getServiceIntegration: jest.fn(() => svc),
        operation: {
          operations: [
            { source: '/src/doc1.pdf', destination: '/dest/doc1.pdf', type: 'move' },
            // Overlap forces serial execution (dest of op0 is source of op1)
            { source: '/dest/doc1.pdf', destination: '/dest/doc2.pdf', type: 'move' }
          ]
        }
      };
    }

    test('abort after op 0 cancels queued ops: no further renames, cancelled entries, undo kept', async () => {
      const controller = new AbortController();
      const svc = makeStableSvc();
      const cancelParams = makeSerialCancelParams(controller, svc);

      fs.rename.mockImplementationOnce(async () => {
        controller.abort('user-cancel-organize');
      });

      const result = await handleBatchOrganize(cancelParams);

      // Only op 0's rename ran
      expect(fs.rename).toHaveBeenCalledTimes(1);
      expect(result.cancelled).toBe(true);
      expect(result.successCount).toBe(1);
      expect(result.cancelledCount).toBe(1);
      expect(result.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: '/src/doc1.pdf', success: true }),
          expect.objectContaining({ source: '/dest/doc1.pdf', cancelled: true, success: false })
        ])
      );

      // Cancel is NOT rollback: completed move stands and is undoable
      const { executeRollback } = require('../src/main/ipc/files/batchRollback');
      expect(executeRollback).not.toHaveBeenCalled();
      expect(svc.undoRedo.recordAction).toHaveBeenCalled();
      const [, undoPayload] = svc.undoRedo.recordAction.mock.calls[0];
      expect(undoPayload.operations).toEqual([
        { type: 'move', originalPath: '/src/doc1.pdf', newPath: '/dest/doc1.pdf' }
      ]);
      expect(svc.processingState.completeOrganizeBatch).toHaveBeenCalled();
    });

    test('abort landing during post-move verification still records the completed op', async () => {
      const controller = new AbortController();
      const svc = makeStableSvc();
      const cancelParams = {
        ...params,
        abortSignal: controller.signal,
        getServiceIntegration: jest.fn(() => svc),
        operation: {
          operations: [{ source: '/src/doc1.pdf', destination: '/dest/doc1.pdf', type: 'move' }]
        }
      };

      // verifyMoveCompletion checks destination exists via fs.access — abort
      // exactly in that window (move already happened on disk).
      fs.access.mockImplementation(async (p) => {
        if (p.includes('dest')) {
          controller.abort('user-cancel-organize');
          return;
        }
        if (p.includes('src')) throw { code: 'ENOENT' };
        return;
      });

      const result = await handleBatchOrganize(cancelParams);

      // The move happened — it MUST be reported and journaled, or the
      // renderer's paths go stale and the journal replays it next launch.
      expect(result.successCount).toBe(1);
      expect(result.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: '/src/doc1.pdf', success: true })
        ])
      );
      expect(svc.processingState.markOrganizeOpDone).toHaveBeenCalledWith(
        expect.any(String),
        0,
        expect.objectContaining({ destination: '/dest/doc1.pdf' })
      );
      expect(svc.undoRedo.recordAction).toHaveBeenCalled();
    });

    test('rollback abort (critical error) keeps old semantics: no cancelled flag', async () => {
      fs.rename.mockRejectedValueOnce({ code: 'ENOSPC', message: 'Disk full' });

      const result = await handleBatchOrganize(params);

      // Critical error path: rollback, not cancellation
      expect(result.cancelled).toBeFalsy();
      const { executeRollback } = require('../src/main/ipc/files/batchRollback');
      // Rollback only fires when completedOperations is non-empty; either way
      // the result must not claim cancellation.
      expect(result.cancelledCount || 0).toBe(0);
    });

    test('rollback receives processingState so it can close the journal batch', async () => {
      // Regression guard for the rolled-back-batch auto-replay bug: the
      // handler must hand executeRollback the processingState adapter, whose
      // markOrganizeBatchRolledBack/completeOrganizeBatch stamps keep the
      // batch out of getIncompleteOrganizeBatches at next launch.
      const svc = makeStableSvc();
      fs.rename
        .mockResolvedValueOnce() // First file succeeds
        .mockImplementationOnce(
          () =>
            new Promise((_, reject) =>
              setTimeout(() => reject({ code: 'ENOSPC', message: 'Disk full' }), 50)
            )
        ); // Second file fails critically after the first completed

      await handleBatchOrganize({ ...params, getServiceIntegration: jest.fn(() => svc) });

      const { executeRollback } = require('../src/main/ipc/files/batchRollback');
      expect(executeRollback).toHaveBeenCalled();
      expect(executeRollback.mock.calls[0][6]).toBe(svc.processingState);
    });
  });

  // Non-user aborts (ipc-timeout, shutdown abortAll, registry-cap-evict) are
  // interruptions, not cancellations: the user didn't ask to stop, and the
  // skipped ops stay pending in the journal for resume at next launch.
  describe('non-user abort (interruption)', () => {
    test('ipc-timeout abort reports interrupted (not cancelled) and leaves the journal batch open', async () => {
      const controller = new AbortController();
      const svc = makeStableSvc();
      const interruptParams = {
        ...params,
        abortSignal: controller.signal,
        getServiceIntegration: jest.fn(() => svc),
        operation: {
          operations: [
            { source: '/src/doc1.pdf', destination: '/dest/doc1.pdf', type: 'move' },
            // Overlap forces serial execution so "abort after op 0" is deterministic
            { source: '/dest/doc1.pdf', destination: '/dest/doc2.pdf', type: 'move' }
          ]
        }
      };

      fs.rename.mockImplementationOnce(async () => {
        controller.abort('ipc-timeout');
      });

      const result = await handleBatchOrganize(interruptParams);

      expect(result.cancelled).toBe(false);
      expect(result.cancelledCount).toBe(0);
      expect(result.interrupted).toBe(true);
      expect(result.interruptedCount).toBe(1);
      expect(result.abortReason).toBe('ipc-timeout');
      expect(result.successCount).toBe(1);
      expect(result.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: '/src/doc1.pdf', success: true }),
          expect.objectContaining({ source: '/dest/doc1.pdf', interrupted: true, success: false })
        ])
      );

      // The journal batch stays OPEN (no completedAt) so OrganizeResumeService
      // replays the remaining ops at next launch — crash-equivalent semantics.
      expect(svc.processingState.completeOrganizeBatch).not.toHaveBeenCalled();
      // The completed move is still finalized now (undo + persistence), and
      // ONLY that op is journaled as persisted — the interrupted one must stay
      // uncovered so the resume pass persists it after replaying the move.
      expect(svc.undoRedo.recordAction).toHaveBeenCalled();
      expect(svc.processingState.markOrganizeOpsPersisted).toHaveBeenCalledWith(
        expect.any(String),
        [0]
      );
      const { executeRollback } = require('../src/main/ipc/files/batchRollback');
      expect(executeRollback).not.toHaveBeenCalled();
    });
  });

  // UX-4 pause/resume: pause = graceful stop that finalizes completed moves
  // (undo + persistence) but leaves the journal batch open (pausedAt, no
  // completedAt); resume = a fresh invoke carrying resumeBatchId that loads
  // the same journal batch and skips done ops.
  describe('pause and resume', () => {
    const RESUME_ID = 'batch_1234567890_abcdef12';

    test('pause abort finalizes partial run as paused: undo recorded, batch left open, pausedAt set', async () => {
      const controller = new AbortController();
      const svc = makeStableSvc();
      const pauseParams = {
        ...params,
        abortSignal: controller.signal,
        getServiceIntegration: jest.fn(() => svc),
        operation: {
          operations: [
            { source: '/src/doc1.pdf', destination: '/dest/doc1.pdf', type: 'move' },
            // Overlap forces serial execution so "pause after op 0" is deterministic
            { source: '/dest/doc1.pdf', destination: '/dest/doc2.pdf', type: 'move' }
          ]
        }
      };

      fs.rename.mockImplementationOnce(async () => {
        controller.abort('user-pause-organize');
      });

      const result = await handleBatchOrganize(pauseParams);

      expect(result.paused).toBe(true);
      expect(typeof result.batchId).toBe('string');
      expect(result.successCount).toBe(1);

      // Completed move is undoable NOW (not deferred to resume/restart)
      expect(svc.undoRedo.recordAction).toHaveBeenCalled();
      const [, undoPayload] = svc.undoRedo.recordAction.mock.calls[0];
      expect(undoPayload.operations).toEqual([
        { type: 'move', originalPath: '/src/doc1.pdf', newPath: '/dest/doc1.pdf' }
      ]);
      expect(svc.processingState.markOrganizeOpsPersisted).toHaveBeenCalledWith(
        result.batchId,
        [0]
      );
      expect(svc.processingState.markOrganizeBatchPaused).toHaveBeenCalledWith(result.batchId);
      // The batch journal stays open so resume can pick it up
      expect(svc.processingState.completeOrganizeBatch).not.toHaveBeenCalled();
      const { executeRollback } = require('../src/main/ipc/files/batchRollback');
      expect(executeRollback).not.toHaveBeenCalled();
    });

    test('pausing a large batch chunks results instead of returning them inline', async () => {
      // The pause reply must go through the same MAX_RESULTS_PER_CHUNK guard
      // as normal completion — pre-fix it returned every result object in a
      // single IPC reply, so pausing a large batch shipped thousands of
      // entries at once.
      const controller = new AbortController();
      const svc = makeStableSvc();
      const operations = Array.from({ length: 150 }, (_, i) => ({
        source: `/src/f${i}.pdf`,
        destination: `/dest/f${i}.pdf`,
        type: 'move'
      }));
      const largePauseParams = {
        ...params,
        abortSignal: controller.signal,
        getServiceIntegration: jest.fn(() => svc),
        operation: { operations }
      };

      // Once: later renames (in-flight ops past their abort check) fall back
      // to the module mock's resolved default, and no implementation leaks
      // into subsequent tests (this file has no resetMocks).
      fs.rename.mockImplementationOnce(async () => {
        controller.abort('user-pause-organize');
      });

      const { sendChunkedResults } = require('../src/main/ipc/files/batchProgressReporter');
      sendChunkedResults.mockResolvedValueOnce({ sent: true, totalChunks: 2 });

      const result = await handleBatchOrganize(largePauseParams);

      expect(result.paused).toBe(true);
      expect(result.chunkedResults).toBe(true);
      expect(result.totalChunks).toBe(2);
      expect(result.results).toBeUndefined();
      expect(sendChunkedResults).toHaveBeenCalledWith(
        expect.any(Function),
        result.batchId,
        expect.any(Array),
        100
      );
      expect(svc.processingState.markOrganizeBatchPaused).toHaveBeenCalledWith(result.batchId);
    });

    test('resumeBatchId loads the journal batch: done ops skip disk, undo scoped to new moves', async () => {
      const svc = makeStableSvc();
      svc.processingState.createOrLoadOrganizeBatch = jest.fn((id, ops) => ({
        operations: [
          { ...ops[0], status: 'done' },
          { ...ops[1], status: 'pending' }
        ]
      }));
      const resumeParams = {
        ...params,
        getServiceIntegration: jest.fn(() => svc),
        operation: {
          resumeBatchId: RESUME_ID,
          operations: [
            { source: '/src/doc1.pdf', destination: '/dest/doc1.pdf', type: 'move' },
            { source: '/src/doc2.pdf', destination: '/dest/doc2.pdf', type: 'move' }
          ]
        }
      };

      const result = await handleBatchOrganize(resumeParams);

      expect(result.batchId).toBe(RESUME_ID);
      expect(result.success).toBe(true);
      // Done op did not touch disk; only the pending op moved
      expect(fs.rename).toHaveBeenCalledTimes(1);
      expect(result.results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: '/src/doc1.pdf', resumed: true, success: true }),
          expect.objectContaining({ source: '/src/doc2.pdf', success: true })
        ])
      );
      expect(result.successCount).toBe(2);

      // Resume clears the paused marker and completes the batch
      expect(svc.processingState.clearOrganizeBatchPaused).toHaveBeenCalledWith(RESUME_ID);
      expect(svc.processingState.completeOrganizeBatch).toHaveBeenCalledWith(RESUME_ID);

      // Undo for the resumed run is scoped to THIS run's moves under a
      // distinct undo id, so it cannot collide with the pre-pause entry.
      expect(svc.undoRedo.recordAction).toHaveBeenCalledTimes(1);
      const [, undoPayload] = svc.undoRedo.recordAction.mock.calls[0];
      expect(undoPayload.batchId).toMatch(new RegExp(`^${RESUME_ID}:r\\d+$`));
      expect(undoPayload.operations).toEqual([
        { type: 'move', originalPath: '/src/doc2.pdf', newPath: '/dest/doc2.pdf' }
      ]);
    });

    test('rejects a malformed resumeBatchId instead of silently starting a new batch', async () => {
      const resumeParams = {
        ...params,
        operation: {
          resumeBatchId: '../../evil/path',
          operations: [{ source: '/src/doc1.pdf', destination: '/dest/doc1.pdf', type: 'move' }]
        }
      };

      const result = await handleBatchOrganize(resumeParams);

      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/resumeBatchId/i);
      expect(fs.rename).not.toHaveBeenCalled();
    });
  });

  describe('isCriticalFileError', () => {
    const { isCriticalFileError } = require('../src/main/ipc/files/batchOrganizeHandler');

    test('treats metadata.originalCode as critical', () => {
      expect(
        isCriticalFileError({
          code: 'WRAPPED',
          metadata: { originalCode: 'ENOSPC' }
        })
      ).toBe(true);
    });

    test('treats mapped DISK_FULL as critical', () => {
      expect(isCriticalFileError({ code: 'DISK_FULL', message: 'no space' })).toBe(true);
    });

    test('treats PATH_TOO_LONG as a per-file failure, not a batch-wide critical error [H1]', () => {
      // Thrown only by the collision-suffix loop for one destination; rolling
      // back the whole batch would punish every other file for it.
      expect(
        isCriticalFileError({
          code: 'PATH_TOO_LONG',
          message: 'Destination path exceeds platform limit (270 > 260)'
        })
      ).toBe(false);
    });
  });

  describe('recordUndoAndUpdateDatabase', () => {
    const { recordUndoAndUpdateDatabase } = require('../src/main/ipc/files/batchOrganizeHandler');

    test('omits duplicate-skip and skipped ops from undo and path updates', async () => {
      const recordAction = jest.fn().mockResolvedValue(undefined);
      const batchPathUpdate = jest.fn().mockResolvedValue(undefined);
      const getServiceIntegration = () => ({
        undoRedo: { recordAction, hasBatchAction: jest.fn().mockResolvedValue(false) },
        filePathCoordinator: { batchPathUpdate }
      });
      const log = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
      const completed = [
        { index: 0, source: '/a.pdf', destination: '/dest/a.pdf' },
        {
          index: 1,
          source: '/dup.pdf',
          destination: '/dest/dup.pdf',
          rollbackAction: 'restore_duplicate_source'
        },
        { index: 2, source: '/skip.pdf', destination: '/dest/skip.pdf', skipped: true }
      ];

      await recordUndoAndUpdateDatabase(
        { operations: completed },
        [],
        1,
        'batch_1',
        getServiceIntegration,
        log,
        null,
        completed
      );

      expect(recordAction).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          operations: [{ type: 'move', originalPath: '/a.pdf', newPath: '/dest/a.pdf' }]
        })
      );
    });

    test('resume skips the undo record when the live run already recorded the batch (UR-08)', async () => {
      // Live runs record under the batch id; resume derives `<id>:p<op>`. The
      // exact-id check never matched, so a crash between recordAction and the
      // persistedAt marker produced two undo entries for one organize.
      const recordAction = jest.fn().mockResolvedValue(undefined);
      const hasBatchAction = jest.fn().mockResolvedValue(false);
      const recordedOps = [{ type: 'move', originalPath: '/a.pdf', newPath: '/dest/a.pdf' }];
      const uncoveredBatchOperations = jest.fn(async (id, ops, opts) =>
        id === 'batch_9_cafef00d' && Boolean(opts?.includeDerived)
          ? ops.filter(
              (op) =>
                !recordedOps.some(
                  (r) => r.originalPath === op.originalPath && r.newPath === op.newPath
                )
            )
          : [...ops]
      );
      const getServiceIntegration = () => ({
        undoRedo: { recordAction, hasBatchAction, uncoveredBatchOperations }
      });
      const log = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
      const completed = [{ index: 0, source: '/a.pdf', destination: '/dest/a.pdf' }];

      const meta = await recordUndoAndUpdateDatabase(
        { id: 'batch_9_cafef00d', operations: completed },
        [],
        1,
        'batch_9_cafef00d:p0',
        getServiceIntegration,
        log,
        null,
        completed
      );

      expect(recordAction).not.toHaveBeenCalled();
      expect(meta.undoRecorded).toBe(true);
      expect(hasBatchAction).toHaveBeenCalledWith('batch_9_cafef00d:p0');
      expect(uncoveredBatchOperations).toHaveBeenCalledWith(
        'batch_9_cafef00d',
        [{ type: 'move', originalPath: '/a.pdf', newPath: '/dest/a.pdf' }],
        { includeDerived: true }
      );
      // Only the undo record was already covered; the path index step still ran.
      expect(meta.pathIndexUpdated).toBe(true);
    });

    test('a resumed run records the undo entry for the moves it made even though the pre-pause run recorded the batch', async () => {
      // The derived-id dedup matched the live entry (`<id>`) for a resume
      // recording under `<id>:r<ts>`, so the resumed moves never got an undo
      // entry and were then stamped persisted. Coverage is per move.
      const recordAction = jest.fn().mockResolvedValue(undefined);
      const liveOps = [
        { type: 'move', originalPath: '/a.pdf', newPath: '/dest/a.pdf' },
        { type: 'move', originalPath: '/b.pdf', newPath: '/dest/b.pdf' }
      ];
      // History holds the live entry under `batch_9_cafef00d`, nothing under
      // the resume's own id: a batch-id-only dedup would wrongly skip here.
      const hasBatchAction = jest.fn(
        async (id, opts) => id === 'batch_9_cafef00d' && Boolean(opts?.includeDerived)
      );
      const uncoveredBatchOperations = jest.fn(async (id, ops) =>
        ops.filter((op) => !liveOps.some((r) => r.newPath === op.newPath))
      );
      const getServiceIntegration = () => ({
        undoRedo: { recordAction, hasBatchAction, uncoveredBatchOperations }
      });
      const log = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
      const resumed = [
        { index: 2, source: '/c.pdf', destination: '/dest/c.pdf' },
        { index: 3, source: '/d.pdf', destination: '/dest/d.pdf' }
      ];

      const meta = await recordUndoAndUpdateDatabase(
        { id: 'batch_9_cafef00d', operations: [] },
        [],
        2,
        'batch_9_cafef00d:r1700000000000',
        getServiceIntegration,
        log,
        null,
        resumed
      );

      expect(meta.undoRecorded).toBe(true);
      expect(recordAction).toHaveBeenCalledTimes(1);
      expect(recordAction.mock.calls[0][1]).toEqual({
        batchId: 'batch_9_cafef00d:r1700000000000',
        operations: [
          { type: 'move', originalPath: '/c.pdf', newPath: '/dest/c.pdf' },
          { type: 'move', originalPath: '/d.pdf', newPath: '/dest/d.pdf' }
        ]
      });
    });

    test('a resume replaying the union of done ops records only the moves no entry lists yet', async () => {
      // The live run recorded ops 0-1 and crashed before stamping them
      // persisted; the startup resume then replays 2-3 and persists all four
      // under `<id>:p0`. Coverage is partial, so the remainder (2-3) gets the
      // one new entry; re-recording 0-1 would hand the user two undo steps
      // that both reverse the same moves.
      const recordAction = jest.fn().mockResolvedValue(undefined);
      const op = (n) => ({ type: 'move', originalPath: `/${n}.pdf`, newPath: `/dest/${n}.pdf` });
      const recordedOps = [op('a'), op('b')];
      const hasBatchAction = jest.fn(
        async (id, opts) => id === 'batch_9_cafef00d' && Boolean(opts?.includeDerived)
      );
      const uncoveredBatchOperations = jest.fn(async (id, ops, opts) =>
        id === 'batch_9_cafef00d' && Boolean(opts?.includeDerived)
          ? ops.filter(
              (candidate) =>
                !recordedOps.some(
                  (r) =>
                    r.originalPath === candidate.originalPath && r.newPath === candidate.newPath
                )
            )
          : [...ops]
      );
      const getServiceIntegration = () => ({
        undoRedo: { recordAction, hasBatchAction, uncoveredBatchOperations }
      });
      const log = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
      const completed = ['a', 'b', 'c', 'd'].map((n, index) => ({
        index,
        source: `/${n}.pdf`,
        destination: `/dest/${n}.pdf`
      }));

      const meta = await recordUndoAndUpdateDatabase(
        { id: 'batch_9_cafef00d', operations: completed },
        [],
        4,
        'batch_9_cafef00d:p0',
        getServiceIntegration,
        log,
        null,
        completed
      );

      expect(meta.undoRecorded).toBe(true);
      expect(recordAction).toHaveBeenCalledTimes(1);
      expect(recordAction.mock.calls[0][1]).toEqual({
        batchId: 'batch_9_cafef00d:p0',
        operations: [op('c'), op('d')]
      });
    });
  });

  // Per-op persistence journaling: the resume pass relies on
  // persistedOpIndices to know which done ops still need undo + path-index
  // work, so the handler may only stamp indices whose persistence FULLY
  // succeeded. A batch-wide stamp on partial success left every later
  // replayed op without an undo entry.
  describe('per-op persistence journaling', () => {
    test('stamps every completed op index when undo and path index both succeeded', async () => {
      const svc = makeStableSvc();
      const result = await handleBatchOrganize({
        ...params,
        getServiceIntegration: jest.fn(() => svc)
      });

      expect(result.successCount).toBe(2);
      expect(svc.processingState.markOrganizeOpsPersisted).toHaveBeenCalledTimes(1);
      expect(svc.processingState.markOrganizeOpsPersisted).toHaveBeenCalledWith(
        result.batchId,
        expect.arrayContaining([0, 1])
      );
      expect(svc.processingState.markOrganizeOpsPersisted.mock.calls[0][1]).toHaveLength(2);
    });

    test('does not stamp when the path-index update failed', async () => {
      mockCoordinator.batchPathUpdate.mockRejectedValueOnce(new Error('coordinator down'));
      const svc = makeStableSvc();

      const result = await handleBatchOrganize({
        ...params,
        getServiceIntegration: jest.fn(() => svc)
      });

      expect(result.pathIndexUpdated).toBe(false);
      expect(svc.processingState.markOrganizeOpsPersisted).not.toHaveBeenCalled();
    });

    test('does not stamp when the undo entry could not be recorded', async () => {
      const svc = makeStableSvc();
      svc.undoRedo.recordAction.mockRejectedValueOnce(new Error('undo store closed'));

      const result = await handleBatchOrganize({
        ...params,
        getServiceIntegration: jest.fn(() => svc)
      });

      expect(result.undoRecorded).toBe(false);
      expect(svc.processingState.markOrganizeOpsPersisted).not.toHaveBeenCalled();
    });
  });

  // The batch lock's TTL is only a crash backstop; a live batch must keep
  // its lease fresh so a long run is never force-released mid-move.
  test('renews the batch lock after each completed operation', async () => {
    const result = await handleBatchOrganize(params);

    expect(result.successCount).toBe(2);
    expect(batchLockManager.renewBatchLock).toHaveBeenCalledTimes(2);
    expect(batchLockManager.renewBatchLock).toHaveBeenCalledWith(result.batchId);
  });

  // Overlap detection folds case wherever the default filesystem does. On
  // darwin (APFS/HFS+ are case-insensitive by default) two destinations that
  // differ only by case are the SAME file: run in parallel, both
  // renameNoReplace probes see "free" and the loser replaces the winner.
  describe('path overlap detection on case-insensitive filesystems', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const caseVariantOps = {
      operations: [
        { source: '/src/x.pdf', destination: '/dest/Report.pdf', type: 'move' },
        { source: '/src/y.pdf', destination: '/dest/report.pdf', type: 'move' }
      ]
    };
    const overlapWarning = expect.stringContaining('Batch has path overlap');

    afterEach(() => {
      Object.defineProperty(process, 'platform', originalPlatform);
    });

    test.each(['darwin', 'win32'])(
      'forces serial execution for case-variant destinations on %s',
      async (platform) => {
        Object.defineProperty(process, 'platform', { value: platform, configurable: true });

        await handleBatchOrganize({ ...params, operation: caseVariantOps });

        expect(mockLogger.warn).toHaveBeenCalledWith(overlapWarning, expect.any(Object));
      }
    );

    test('treats case-variant destinations as distinct on linux', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      await handleBatchOrganize({ ...params, operation: caseVariantOps });

      expect(mockLogger.warn).not.toHaveBeenCalledWith(overlapWarning, expect.any(Object));
    });
  });
});
