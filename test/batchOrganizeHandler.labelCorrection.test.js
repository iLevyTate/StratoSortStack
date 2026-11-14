/**
 * @jest-environment node
 *
 * A correction is counted under the label the analysis gave the file
 * (findLearnedCorrection). When the label already named the folder the user
 * chose but the engine ranked another first, the history records no
 * divergence, so the label has to come with the op: without it the
 * correction was stored with no label and never counted.
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

describe('organize corrections carry the analysis label', () => {
  const learning = require('../src/main/services/organization/learningFeedback');
  const {
    findLearnedCorrection
  } = require('../src/main/services/organization/feedbackMemoryUtils');
  const { container } = require('../src/main/services/ServiceContainer');
  const FOLDERS = [
    { id: 'gsc', name: 'GSC exports', path: '/dest/GSC exports' },
    { id: 'bing', name: 'Bing exports', path: '/dest/Bing exports' }
  ];
  let params;
  let memories;
  let learner;
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
    // The history label equals the destination: no divergence.
    mockCoordinator.batchPathUpdate.mockReset().mockResolvedValue({ success: true, summary: {} });

    // The real learning service, with the memory store reduced to a list
    // shaped like the one recordFeedbackNote writes.
    memories = [];
    learner = new learning.LearningFeedbackService({
      suggestionService: {
        recordFeedbackNote: jest.fn(async (_file, suggestion, accepted, note, extra) => {
          const entry = {
            text: note,
            source: accepted ? 'feedback_accept' : 'feedback_reject',
            targetFolder: suggestion?.folder || null,
            ...(extra?.filePath ? { filePath: extra.filePath } : {}),
            ...(extra?.correction ? { correction: extra.correction } : {})
          };
          memories.push(entry);
          return entry;
        })
      },
      getSmartFolders: () => FOLDERS
    });
    jest.spyOn(learner, 'recordFileMove').mockResolvedValue(true);
    jest.spyOn(learner, 'recordCorrection');

    const hasImpl = container.has.getMockImplementation();
    const resolveImpl = container.resolve.getMockImplementation();
    container.has.mockImplementation(
      (id) => id === 'filePathCoordinator' || id === 'learningFeedback'
    );
    container.resolve.mockImplementation((id) =>
      id === 'learningFeedback' ? learner : mockCoordinator
    );
    const spy = jest.spyOn(learning, 'getInstance').mockReturnValue(learner);
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

  /** The card suggested Bing exports; the user sent the file to GSC exports. */
  async function moveToGscOverBing(name, extra = {}) {
    params.operation.operations = [
      {
        source: `/src/${name}`,
        destination: `/dest/GSC exports/${name}`,
        type: 'move',
        suggestion: { folder: 'Bing exports', source: 'engine' },
        ...extra
      }
    ];
    const result = await handleBatchOrganize(params);
    expect(result.success).toBe(true);
  }

  test('with no divergence the correction is stored under the label the op carries', async () => {
    await moveToGscOverBing('queries.xlsx', { analysisLabel: 'GSC exports' });

    expect(learner.recordCorrection).toHaveBeenCalledWith(
      expect.objectContaining({
        wrongFolder: 'Bing exports',
        correctFolder: 'GSC exports',
        oldCategory: 'GSC exports'
      })
    );
    expect(memories).toHaveLength(1);
    expect(memories[0].correction).toEqual(
      expect.objectContaining({ extension: 'xlsx', category: 'gsc exports' })
    );
  });

  test('two different files corrected that way make the corrected folder the learned one', async () => {
    await moveToGscOverBing('pages.xlsx', { analysisLabel: 'GSC exports' });
    await moveToGscOverBing('queries.xlsx', { analysisLabel: 'GSC exports' });

    const learned = findLearnedCorrection({
      memories,
      extension: 'xlsx',
      category: 'GSC exports',
      fromFolder: 'Bing exports',
      smartFolders: FOLDERS
    });
    expect(learned).toEqual({ folder: FOLDERS[0], files: 2 });
  });

  test("a divergence's label still wins over the op's", async () => {
    mockCoordinator.batchPathUpdate.mockResolvedValue({
      success: true,
      summary: {},
      divergences: [
        {
          filePath: '/dest/GSC exports/sheet.xlsx',
          oldCategory: 'Reports',
          newCategory: 'GSC exports'
        }
      ]
    });
    await moveToGscOverBing('sheet.xlsx', { analysisLabel: 'GSC exports' });

    expect(learner.recordCorrection).toHaveBeenCalledWith(
      expect.objectContaining({ oldCategory: 'Reports' })
    );
  });
});
