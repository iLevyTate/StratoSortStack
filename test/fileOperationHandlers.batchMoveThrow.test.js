/**
 * @jest-environment node
 */
const { IPC_CHANNELS } = require('../src/shared/constants');

// Mock dependencies
jest.mock('fs', () => ({
  promises: {
    stat: jest.fn().mockResolvedValue({ size: 100 }),
    access: jest.fn().mockResolvedValue(),
    rename: jest.fn().mockResolvedValue(),
    copyFile: jest.fn().mockResolvedValue(),
    unlink: jest.fn().mockResolvedValue(),
    mkdir: jest.fn().mockResolvedValue()
  },
  constants: { COPYFILE_EXCL: 1 }
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

jest.mock('../src/main/ipc/ipcWrappers', () => ({
  createHandler: jest.fn(({ handler }) => handler),
  safeHandle: jest.fn(),
  withErrorLogging: jest.fn((logger, handler) => handler),
  withValidation: jest.fn((logger, schema, handler) => handler),
  safeSend: jest.fn()
}));

jest.mock('../src/main/ipc/files/batchOrganizeHandler', () => ({
  handleBatchOrganize: jest.fn().mockResolvedValue({ success: true, count: 1 })
}));

jest.mock('../src/shared/pathSanitization', () => ({
  validateFileOperationPath: jest.fn((p) => ({ valid: true, normalizedPath: p }))
}));

jest.mock('../src/shared/pathTraceLogger', () => ({
  traceMoveStart: jest.fn(),
  traceMoveComplete: jest.fn(),
  traceCopyStart: jest.fn(),
  traceCopyComplete: jest.fn(),
  traceDeleteStart: jest.fn(),
  traceDeleteComplete: jest.fn(),
  traceDbUpdate: jest.fn(),
  PathChangeReason: { USER_MOVE: 'user_move' }
}));

jest.mock('../src/main/services/organization/learningFeedback', () => ({
  getInstance: jest.fn(),
  FEEDBACK_SOURCES: { MANUAL_MOVE: 'manual_move' }
}));

jest.mock('../src/main/ipc/files/embeddingSync', () => ({
  syncEmbeddingForMove: jest.fn().mockResolvedValue()
}));

jest.mock('../src/shared/promiseUtils', () => ({
  withTimeout: jest.fn((p) => p),
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
}));

jest.mock('../src/shared/atomicFileOperations', () => ({
  crossDeviceMove: jest.fn(),
  // Delegate to the suite's fs.rename mock; tests drive occupied-destination
  // behavior by seeding renameNoReplace rejections. Real no-replace semantics
  // are covered by atomicFileOperations.test.js.
  renameNoReplace: jest.fn((src, dest) => require('fs').promises.rename(src, dest))
}));

jest.mock('../src/main/utils/fileDedup', () => ({
  handleDuplicateMove: jest.fn().mockResolvedValue(null)
}));

jest.mock('../src/main/ipc/semantic', () => ({
  getSearchServiceInstance: jest.fn(),
  getClusteringServiceInstance: jest.fn()
}));

jest.mock('../src/main/services/ServiceContainer', () => ({
  container: {
    has: jest.fn(),
    resolve: jest.fn()
  },
  ServiceIds: {
    FILE_PATH_COORDINATOR: 'filePathCoordinator',
    ANALYSIS_HISTORY: 'analysisHistory'
  }
}));

// Mock validation schemas to avoid Zod issues
jest.mock('../src/main/ipc/validationSchemas', () => ({
  z: {},
  schemas: {}
}));

// Destination policy: real module, with the decision points wrapped so one
// test can refuse a destination. Elsewhere the global electron mock's dialog
// approves, as it does for every pre-existing test here.
jest.mock('../src/main/ipc/files/destinationPolicy', () => {
  const actual = jest.requireActual('../src/main/ipc/files/destinationPolicy');
  return {
    ...actual,
    authorizeDestination: jest.fn(actual.authorizeDestination),
    authorizeDestinations: jest.fn(actual.authorizeDestinations)
  };
});

// batch_move: a move that THROWS (EBUSY/EPERM on a locked file, a failed
// cross-device copy) must not abort the whole selection. Before the fix the
// throw escaped the loop: the earlier moves stayed at their new paths with no
// MOVE_BATCH undo entry, later files were never tried, and no `results` came
// back, so the renderer counted every file as failed.
describe('batch_move when one move throws', () => {
  let fs;
  let safeHandle;
  let mockServiceIntegration;
  let mockFilePathCoordinator;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    fs = require('fs').promises;
    safeHandle = require('../src/main/ipc/ipcWrappers').safeHandle;
    const mockLogger = require('../src/shared/logger').logger;
    require('../src/main/utils/fileDedup').handleDuplicateMove.mockResolvedValue(null);

    mockServiceIntegration = {
      undoRedo: { recordAction: jest.fn(), recordBatch: jest.fn() }
    };
    require('../src/main/ipc/semantic').getSearchServiceInstance.mockReturnValue({
      invalidateAndRebuild: jest.fn().mockResolvedValue()
    });
    require('../src/main/ipc/semantic').getClusteringServiceInstance.mockReturnValue({
      invalidateClusters: jest.fn()
    });
    mockFilePathCoordinator = {
      atomicPathUpdate: jest.fn().mockResolvedValue({ success: true }),
      handleFileCopy: jest.fn().mockResolvedValue({ success: true }),
      handleFileDeletion: jest.fn().mockResolvedValue({ success: true })
    };
    const { container } = require('../src/main/services/ServiceContainer');
    container.has.mockReturnValue(true);
    container.resolve.mockReturnValue(mockFilePathCoordinator);

    const { IpcServiceContext } = require('../src/main/ipc/IpcServiceContext');
    const context = new IpcServiceContext();
    context.setCore({ ipcMain: { handle: jest.fn() }, IPC_CHANNELS, logger: mockLogger });
    context.setElectron({
      getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: jest.fn() } })
    });
    context.setServiceIntegration(() => mockServiceIntegration);

    require('../src/main/ipc/files/fileOperationHandlers').registerFileOperationHandlers(context);
  });

  function getPerformHandler() {
    const call = safeHandle.mock.calls.find((c) => c[1] === IPC_CHANNELS.FILES.PERFORM_OPERATION);
    if (!call) throw new Error('PERFORM_OPERATION handler not registered');
    return call[2];
  }

  const operations = [
    { source: '/src/a.pdf', destination: '/dest/a.pdf' },
    { source: '/src/locked.pdf', destination: '/dest/locked.pdf' },
    { source: '/src/c.pdf', destination: '/dest/c.pdf' }
  ];

  test('keeps going, returns per-file results and records the moves that happened', async () => {
    fs.rename.mockImplementation(async (src) => {
      if (src === '/src/locked.pdf') {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      }
    });

    const result = await getPerformHandler()({}, { type: 'batch_move', operations });

    expect(result.success).toBe(false);
    expect(result.moved).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.results).toHaveLength(3);
    expect(result.results[1]).toEqual(
      expect.objectContaining({
        success: false,
        source: '/src/locked.pdf',
        destination: '/dest/locked.pdf',
        errorCode: 'EPERM',
        error: 'operation not permitted'
      })
    );
    // The file after the failing one was still attempted.
    expect(fs.rename).toHaveBeenCalledWith('/src/c.pdf', '/dest/c.pdf');
    expect(mockServiceIntegration.undoRedo.recordBatch).toHaveBeenCalledTimes(1);
    expect(mockServiceIntegration.undoRedo.recordBatch).toHaveBeenCalledWith(
      'MOVE_BATCH',
      [
        { type: 'move', originalPath: '/src/a.pdf', newPath: '/dest/a.pdf' },
        { type: 'move', originalPath: '/src/c.pdf', newPath: '/dest/c.pdf' }
      ],
      { summary: { label: 'Move files', source: 'manual_batch_move' } }
    );
  });

  test('a thrown error without a code is reported as MOVE_FAILED', async () => {
    fs.rename.mockImplementation(async (src) => {
      if (src === '/src/locked.pdf') throw new Error('boom');
    });

    const result = await getPerformHandler()({}, { type: 'batch_move', operations });

    expect(result.moved).toBe(2);
    expect(result.results[1]).toEqual(
      expect.objectContaining({ success: false, errorCode: 'MOVE_FAILED', error: 'boom' })
    );
  });
});
