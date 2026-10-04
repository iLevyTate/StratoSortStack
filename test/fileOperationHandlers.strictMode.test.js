/**
 * @jest-environment node
 *
 * Regression test for STRATOSORT_STRICT_FILE_OPS — optional strict mode
 * that ties file-operation IPC to user-selected smart-folder roots and
 * `userData`. When disabled (default), existing behaviour is preserved.
 */
const path = require('path');
const { IPC_CHANNELS } = require('../src/shared/constants');

jest.mock('fs', () => ({
  promises: {
    stat: jest.fn().mockResolvedValue({ size: 100 }),
    access: jest.fn().mockResolvedValue(),
    rename: jest.fn().mockResolvedValue(),
    copyFile: jest.fn().mockResolvedValue(),
    unlink: jest.fn().mockResolvedValue(),
    mkdir: jest.fn().mockResolvedValue(),
    lstat: jest.fn().mockResolvedValue({ isSymbolicLink: () => false }),
    realpath: jest.fn((p) => Promise.resolve(p))
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

// Real pathSanitization is used so we exercise the actual allowlist logic.
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
  crossDeviceMove: jest.fn()
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

jest.mock('../src/main/ipc/validationSchemas', () => ({
  z: {},
  schemas: {}
}));

// electron.app.getPath is consulted by the strict-mode allowlist builder
// so that userData is always in-scope even without smart folders.
jest.mock('electron', () => ({
  app: {
    getPath: jest.fn((key) => {
      if (key === 'userData') {
        return process.platform === 'win32' ? 'C:\\fake-userData' : '/fake-userData';
      }
      return '/tmp';
    })
  }
}));

function makeAbs(p) {
  return process.platform === 'win32' ? `C:\\${p.replace(/^\/+/, '').replace(/\//g, '\\')}` : p;
}

describe('File Operation Handlers — STRATOSORT_STRICT_FILE_OPS', () => {
  const ORIGINAL_STRICT_ENV = process.env.STRATOSORT_STRICT_FILE_OPS;
  let mockIpcMain;
  let mockLogger;
  let mockServiceIntegration;
  let safeHandle;
  let registerFileOperationHandlers;

  function bootstrap() {
    jest.resetModules();
    safeHandle = require('../src/main/ipc/ipcWrappers').safeHandle;
    mockLogger = require('../src/shared/logger').logger;

    mockIpcMain = { handle: jest.fn() };

    mockServiceIntegration = {
      undoRedo: { recordAction: jest.fn() },
      smartFolderWatcher: {
        watchedPaths: new Set([makeAbs('/allowed-root')])
      }
    };

    // Provide a no-op FilePathCoordinator so move/copy don't blow up.
    const { container } = require('../src/main/services/ServiceContainer');
    container.has.mockReturnValue(true);
    container.resolve.mockReturnValue({
      atomicPathUpdate: jest.fn().mockResolvedValue({ success: true }),
      handleFileCopy: jest.fn().mockResolvedValue({ success: true }),
      handleFileDeletion: jest.fn().mockResolvedValue({ success: true })
    });

    const { IpcServiceContext } = require('../src/main/ipc/IpcServiceContext');
    const context = new IpcServiceContext();
    context.setCore({ ipcMain: mockIpcMain, IPC_CHANNELS, logger: mockLogger });
    context.setElectron({
      getMainWindow: () => ({
        isDestroyed: () => false,
        webContents: { send: jest.fn() }
      })
    });
    context.setServiceIntegration(() => mockServiceIntegration);

    registerFileOperationHandlers =
      require('../src/main/ipc/files/fileOperationHandlers').registerFileOperationHandlers;
    registerFileOperationHandlers(context);
  }

  function getHandler(channel) {
    const call = safeHandle.mock.calls.find((c) => c[1] === channel);
    if (!call) throw new Error(`Handler for ${channel} not registered`);
    return call[2];
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL_STRICT_ENV === undefined) {
      delete process.env.STRATOSORT_STRICT_FILE_OPS;
    } else {
      process.env.STRATOSORT_STRICT_FILE_OPS = ORIGINAL_STRICT_ENV;
    }
  });

  test('when strict mode is OFF, a move outside any smart folder is allowed', async () => {
    delete process.env.STRATOSORT_STRICT_FILE_OPS;
    bootstrap();

    const handler = getHandler(IPC_CHANNELS.FILES.PERFORM_OPERATION);
    const result = await handler(
      {},
      {
        type: 'move',
        source: makeAbs('/elsewhere/doc.pdf'),
        destination: makeAbs('/elsewhere/renamed.pdf')
      }
    );

    // We don't care whether fs.rename actually "succeeded" (mocks stub it);
    // we only care that strict mode did NOT short-circuit with INVALID_PATH.
    expect(result?.errorCode).not.toBe('INVALID_PATH');
  });

  test('when strict mode is ON, a move outside smart folders + userData is REJECTED', async () => {
    process.env.STRATOSORT_STRICT_FILE_OPS = 'true';
    bootstrap();

    const handler = getHandler(IPC_CHANNELS.FILES.PERFORM_OPERATION);
    const result = await handler(
      {},
      {
        type: 'move',
        source: makeAbs('/elsewhere/doc.pdf'),
        destination: makeAbs('/allowed-root/renamed.pdf')
      }
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        errorCode: 'INVALID_PATH'
      })
    );
  });

  test('when strict mode is ON, a move INSIDE a configured smart-folder root is allowed', async () => {
    process.env.STRATOSORT_STRICT_FILE_OPS = 'true';
    bootstrap();

    const handler = getHandler(IPC_CHANNELS.FILES.PERFORM_OPERATION);
    const result = await handler(
      {},
      {
        type: 'move',
        source: makeAbs('/allowed-root/doc.pdf'),
        destination: makeAbs('/allowed-root/sub/renamed.pdf')
      }
    );

    expect(result?.errorCode).not.toBe('INVALID_PATH');
  });

  test('when strict mode is ON, a path under userData is allowed even without smart folders', async () => {
    process.env.STRATOSORT_STRICT_FILE_OPS = 'true';
    // Empty watched set — userData must still be allowed.
    bootstrap();
    mockServiceIntegration.smartFolderWatcher.watchedPaths = new Set();

    const userData = require('electron').app.getPath('userData');
    const handler = getHandler(IPC_CHANNELS.FILES.DELETE_FILE);
    const result = await handler({}, path.join(userData, 'cache', 'tmp.dat'));

    expect(result?.errorCode).not.toBe('INVALID_PATH');
  });

  test('delete outside strict-mode allowlist is REJECTED', async () => {
    process.env.STRATOSORT_STRICT_FILE_OPS = 'true';
    bootstrap();

    const handler = getHandler(IPC_CHANNELS.FILES.DELETE_FILE);
    const result = await handler({}, makeAbs('/elsewhere/leak.txt'));

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        errorCode: 'INVALID_PATH'
      })
    );
  });
});
