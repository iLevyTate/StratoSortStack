/**
 * @jest-environment node
 *
 * Organize must not teach itself the Uncategorized fallback: accepting the
 * catch-all suggestion learns nothing, but picking Uncategorized over a
 * different suggestion is a real choice and is learned.
 */
const { handleBatchOrganize } = require('../src/main/ipc/files/batchOrganizeHandler');

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
  // Minimal Semaphore for tests. Like the real one, a waiter given a queue
  // timeout is rejected when it runs out, so a batch that queued its moves
  // behind one again would fail the long-batch test below.
  class MockSemaphore {
    constructor(max, _maxQueue, queueTimeoutMs) {
      this.max = max;
      this.queueTimeoutMs = queueTimeoutMs;
      this.active = 0;
      this.queue = [];
    }
    async acquire() {
      if (this.active < this.max) {
        this.active++;
        return;
      }
      await new Promise((resolve, reject) => {
        const waiter = { resolve, timeout: undefined };
        if (this.queueTimeoutMs > 0) {
          waiter.timeout = setTimeout(() => {
            this.queue.splice(this.queue.indexOf(waiter), 1);
            reject(new Error('Request queue timeout'));
          }, this.queueTimeoutMs);
        }
        this.queue.push(waiter);
      });
    }
    release() {
      if (this.queue.length > 0) {
        const waiter = this.queue.shift();
        clearTimeout(waiter.timeout);
        waiter.resolve();
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

describe('organize learning into the Uncategorized folder', () => {
  const learning = require('../src/main/services/organization/learningFeedback');
  const { container } = require('../src/main/services/ServiceContainer');
  let params;
  let mockLearning;
  let restore;

  beforeEach(() => {
    jest.clearAllMocks();
    const fs = require('fs').promises;
    fs.access.mockImplementation(async (p) => {
      if (p.includes('dest')) return;
      if (p.includes('src')) throw { code: 'ENOENT' };
      return;
    });
    fs.stat.mockReset().mockResolvedValue({ size: 100 });
    mockCoordinator.batchPathUpdate.mockReset().mockResolvedValue({ success: true, summary: {} });

    mockLearning = {
      getSmartFolders: () => [
        { name: 'Uncategorized', category: 'uncategorized', path: '/dest' },
        { name: 'Finance', path: '/library/Finance' }
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

    const mockLogger = require('../src/shared/logger').logger;
    params = {
      operation: { operations: [] },
      logger: mockLogger,
      getServiceIntegration: jest.fn(() => ({
        processingState: {
          createOrLoadOrganizeBatch: jest.fn((id, ops) => ({ operations: ops })),
          markOrganizeOpStarted: jest.fn(),
          markOrganizeOpDone: jest.fn(),
          markOrganizeOpError: jest.fn(),
          completeOrganizeBatch: jest.fn()
        },
        undoRedo: { recordAction: jest.fn() }
      })),
      getMainWindow: jest.fn()
    };
  });
  afterEach(() => restore());

  function moveInto(suggestion) {
    params.operation.operations = [
      {
        source: '/src/sheet.xlsx',
        destination: '/dest/sheet.xlsx',
        type: 'move',
        ...(suggestion ? { suggestion } : {})
      }
    ];
  }

  test('accepting the Uncategorized fallback learns nothing', async () => {
    moveInto({ folder: 'Uncategorized', source: 'default' });

    const result = await handleBatchOrganize(params);

    expect(result.success).toBe(true);
    expect(mockLearning.recordFileMove).not.toHaveBeenCalled();
    expect(mockLearning.recordCorrection).not.toHaveBeenCalled();
  });

  test('a move into Uncategorized with no suggestion learns nothing', async () => {
    moveInto(null);

    const result = await handleBatchOrganize(params);

    expect(result.success).toBe(true);
    expect(mockLearning.recordFileMove).not.toHaveBeenCalled();
  });

  test('choosing Uncategorized over a different suggestion is still learned', async () => {
    moveInto({ folder: 'Finance', source: 'engine' });

    const result = await handleBatchOrganize(params);

    expect(result.success).toBe(true);
    expect(mockLearning.recordFileMove).toHaveBeenCalledTimes(1);
    expect(mockLearning.recordCorrection).toHaveBeenCalledWith(
      expect.objectContaining({ wrongFolder: 'Finance', correctFolder: 'Uncategorized' })
    );
  });
});
