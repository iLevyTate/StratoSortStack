/**
 * @jest-environment node
 *
 * The smart-folder IPC layer and the watcher's lifecycle:
 * - watcher-stop reports the watcher's state after stop() settles, and a
 *   failed stop is reported (not dropped as an unhandled rejection);
 * - adding a folder while the watcher is not running starts it (start()
 *   scans every folder itself) instead of queueing files into a watcher
 *   that has no queue processor.
 */
const { IPC_CHANNELS } = require('../src/shared/constants');

// Mock dependencies
jest.mock('fs', () => ({
  promises: {
    stat: jest.fn(),
    mkdir: jest.fn(),
    writeFile: jest.fn(),
    unlink: jest.fn(),
    rm: jest.fn(),
    rename: jest.fn(),
    readdir: jest.fn()
  }
}));

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn((name) => {
      if (name === 'documents') return 'C:\\Users\\Test\\Documents';
      if (name === 'downloads') return 'C:\\Users\\Test\\Downloads';
      return '';
    })
  },
  BrowserWindow: {
    getAllWindows: jest.fn(() => [{ isDestroyed: () => false, webContents: { send: jest.fn() } }])
  }
}));

const mockAuthorizeSmartFolderRoot = jest.fn(async () => ({ allowed: true, reason: 'test' }));
jest.mock('../src/main/ipc/files/destinationPolicy', () => ({
  ...jest.requireActual('../src/main/ipc/files/destinationPolicy'),
  authorizeSmartFolderRoot: (...args) => mockAuthorizeSmartFolderRoot(...args)
}));

jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  };
  return { createLogger: jest.fn(() => logger) };
});

jest.mock('../src/main/ipc/ipcWrappers', () => ({
  createHandler: jest.fn(({ handler }) => handler),
  safeHandle: jest.fn(),
  safeSend: jest.fn(),
  withErrorLogging: jest.fn((logger, handler) => {
    // If handler is passed as second arg, return it (wrapped)
    // If called with just logger, return a wrapper function
    if (typeof handler === 'function') {
      return async (...args) => {
        try {
          return await handler(...args);
        } catch (e) {
          // If logger.error is mocked, we can verify it's called
          logger.error(e);
          throw e; // Re-throw to let test see it or safeHandle catch it
        }
      };
    }
    return (fn) => fn;
  })
}));

jest.mock('../src/main/services/FolderMatchingService', () => ({
  getInstance: jest.fn()
}));

jest.mock('../src/main/services/ParallelEmbeddingService', () => ({
  getInstance: jest.fn()
}));

jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: jest.fn()
}));

jest.mock('../src/main/services/SmartFoldersLLMService', () => ({
  enhanceSmartFolderWithLLM: jest.fn()
}));

jest.mock('../src/main/utils/jsonRepair', () => ({
  extractAndParseJSON: jest.fn((json) => JSON.parse(json))
}));

jest.mock('../src/shared/pathSanitization', () => ({
  validateFileOperationPathSync: jest.fn((p) => ({ valid: true, normalizedPath: p }))
}));

jest.mock('../src/shared/crossPlatformUtils', () => ({
  ...jest.requireActual('../src/shared/crossPlatformUtils'),
  isUNCPath: jest.fn(() => false),
  isWindowsDeviceNamespacePath: jest.fn(() => false)
}));

jest.mock('../src/main/analysis/semanticExtensionMap', () => ({
  enrichFolderTextForEmbedding: jest.fn((name, desc) => `${name} ${desc || ''}`),
  enrichFileTextForEmbedding: jest.fn((text) => text)
}));

describe('Smart Folders IPC and the watcher lifecycle', () => {
  let mockIpcMain;
  let mockFoldersService;
  let mockServiceIntegration;
  let mockFolderMatcher;
  let mockParallelEmbedding;
  let mockLlamaService;
  let mockSmartFolderWatcher;
  let safeHandle;
  let registerSmartFoldersIpc;
  let fs;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    fs = require('fs').promises;
    safeHandle = require('../src/main/ipc/ipcWrappers').safeHandle;
    const FolderMatchingService = require('../src/main/services/FolderMatchingService');
    const ParallelEmbeddingService = require('../src/main/services/ParallelEmbeddingService');
    const LlamaService = require('../src/main/services/LlamaService');

    // Mock folder matcher
    mockFolderMatcher = {
      initialize: jest.fn().mockResolvedValue(),
      embedText: jest.fn().mockResolvedValue({ vector: [0.1, 0.2, 0.3], model: 'test-model' }),
      generateFolderId: jest.fn(() => 'test-id')
    };
    FolderMatchingService.getInstance.mockReturnValue(mockFolderMatcher);

    mockParallelEmbedding = {
      batchEmbedTexts: jest.fn().mockImplementation(async (items) => ({
        results: items.map((item, idx) => ({
          id: item.id,
          success: true,
          vector: idx === 0 ? [0.9, 0, 0] : [0.1, 0, 0],
          model: 'test-model'
        })),
        errors: [],
        stats: {}
      }))
    };
    ParallelEmbeddingService.getInstance.mockReturnValue(mockParallelEmbedding);

    // Mock Llama Service
    mockLlamaService = {
      initialize: jest.fn().mockResolvedValue(),
      generateText: jest.fn().mockResolvedValue({ response: '{"index": 1, "reason": "match"}' }),
      getConfig: jest.fn().mockResolvedValue({})
    };
    LlamaService.getInstance.mockReturnValue(mockLlamaService);

    // Mock folders service
    mockFoldersService = {
      getCustomFolders: jest.fn(() => [
        {
          id: '1',
          name: 'Work',
          path: 'C:\\Users\\Test\\Documents\\Work',
          description: 'Work stuff'
        },
        {
          id: 'default-uncategorized',
          name: 'Uncategorized',
          isDefault: true,
          path: 'C:\\Users\\Test\\Documents\\Uncategorized'
        }
      ]),
      setCustomFolders: jest.fn(),
      saveCustomFolders: jest.fn().mockResolvedValue(),
      scanDirectory: jest.fn().mockResolvedValue([])
    };

    // Mock smart folder watcher
    mockSmartFolderWatcher = {
      start: jest.fn().mockResolvedValue(true),
      stop: jest.fn(),
      getStatus: jest.fn().mockReturnValue({ isRunning: true, watchedCount: 5 }),
      isRunning: true,
      scanForUnanalyzedFiles: jest.fn().mockResolvedValue({ scanned: 10, queued: 5 }),
      updateWatchedFolders: jest.fn().mockResolvedValue(undefined),
      scanFolderForUnanalyzedFiles: jest.fn().mockResolvedValue({ scanned: 0, queued: 0 })
    };

    mockServiceIntegration = {
      smartFolderWatcher: mockSmartFolderWatcher
    };

    mockIpcMain = { handle: jest.fn() };
    const mockLogger = require('../src/shared/logger').createLogger();

    const context = {
      ipcMain: mockIpcMain,
      IPC_CHANNELS,
      // Spread folders service methods for createFromLegacyParams
      ...mockFoldersService,
      foldersService: mockFoldersService,
      getServiceIntegration: () => mockServiceIntegration,
      logger: mockLogger,
      // Include direct references expected by createFromLegacyParams if passed as object
      core: { ipcMain: mockIpcMain, IPC_CHANNELS, logger: mockLogger },
      folders: mockFoldersService
    };

    registerSmartFoldersIpc = require('../src/main/ipc/smartFolders');
    registerSmartFoldersIpc(context);
  });

  function getHandler(channel) {
    const call = safeHandle.mock.calls.find((c) => c[1] === channel);
    if (!call) throw new Error(`Handler for ${channel} not registered`);
    return call[2];
  }

  function primeAddFilesystem() {
    const { enhanceSmartFolderWithLLM } = require('../src/main/services/SmartFoldersLLMService');
    enhanceSmartFolderWithLLM.mockResolvedValue(null);
    fs.stat
      .mockResolvedValueOnce({ isDirectory: () => true })
      .mockRejectedValueOnce({ code: 'ENOENT' })
      .mockResolvedValueOnce({ isDirectory: () => true });
    fs.mkdir.mockResolvedValue();
    fs.writeFile.mockResolvedValue();
    fs.unlink.mockResolvedValue();
  }

  async function flushMicrotasks() {
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  describe('watcher-stop', () => {
    test('reports the stopped state once stop() has finished', async () => {
      mockSmartFolderWatcher.getStatus.mockImplementation(() => ({
        isRunning: mockSmartFolderWatcher.isRunning
      }));
      mockSmartFolderWatcher.stop.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => {
              mockSmartFolderWatcher.isRunning = false;
              resolve();
            }, 20);
          })
      );

      const result = await getHandler(IPC_CHANNELS.SMART_FOLDERS.WATCHER_STOP)({});

      expect(result.success).toBe(true);
      expect(result.status.isRunning).toBe(false);
    });

    test('a stop() that rejects is reported as a failure and logged', async () => {
      const logger = require('../src/shared/logger').createLogger();
      mockSmartFolderWatcher.stop.mockRejectedValue(new Error('stop boom'));

      const result = await getHandler(IPC_CHANNELS.SMART_FOLDERS.WATCHER_STOP)({});

      expect(result.success).toBe(false);
      expect(result.error).toBe('stop boom');
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('watcher-stop that outlasts the reply window', () => {
    test('replies "stopping" before the renderer invoke timeout and logs a late failure', async () => {
      jest.useFakeTimers();
      try {
        const logger = require('../src/shared/logger').createLogger();
        let rejectStop;
        mockSmartFolderWatcher.stop.mockImplementation(
          () =>
            new Promise((_resolve, reject) => {
              rejectStop = reject;
            })
        );

        const pending = getHandler(IPC_CHANNELS.SMART_FOLDERS.WATCHER_STOP)({});
        await jest.advanceTimersByTimeAsync(25_000);
        const result = await pending;

        expect(result).toEqual(expect.objectContaining({ success: true, stopping: true }));
        expect(logger.error).not.toHaveBeenCalled();
        rejectStop(new Error('late boom'));
        await jest.advanceTimersByTimeAsync(0);
        expect(logger.error).toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('adding a folder while the watcher is stopped', () => {
    const PROJECTS_PATH = 'C:\\Users\\Test\\Documents\\Projects';

    test('starts the watcher instead of scanning into a stopped queue', async () => {
      mockSmartFolderWatcher.isRunning = false;
      primeAddFilesystem();

      const result = await getHandler(IPC_CHANNELS.SMART_FOLDERS.ADD)(
        {},
        { name: 'Projects', path: PROJECTS_PATH }
      );
      await flushMicrotasks();

      expect(result).toEqual(expect.objectContaining({ success: true }));
      expect(mockSmartFolderWatcher.start).toHaveBeenCalledTimes(1);
      expect(mockSmartFolderWatcher.scanFolderForUnanalyzedFiles).not.toHaveBeenCalled();
    });

    test('a running watcher is refreshed and scans the new folder as before', async () => {
      primeAddFilesystem();

      await getHandler(IPC_CHANNELS.SMART_FOLDERS.ADD)(
        {},
        { name: 'Projects', path: PROJECTS_PATH }
      );
      await flushMicrotasks();

      expect(mockSmartFolderWatcher.start).not.toHaveBeenCalled();
      expect(mockSmartFolderWatcher.updateWatchedFolders).toHaveBeenCalled();
      expect(mockSmartFolderWatcher.scanFolderForUnanalyzedFiles).toHaveBeenCalledWith(
        PROJECTS_PATH
      );
    });

    test('a watcher that is shutting down is not restarted', async () => {
      mockSmartFolderWatcher.isRunning = false;
      mockSmartFolderWatcher._isStopping = true;
      primeAddFilesystem();

      await getHandler(IPC_CHANNELS.SMART_FOLDERS.ADD)(
        {},
        { name: 'Projects', path: PROJECTS_PATH }
      );
      await flushMicrotasks();

      expect(mockSmartFolderWatcher.start).not.toHaveBeenCalled();
      expect(mockSmartFolderWatcher.scanFolderForUnanalyzedFiles).not.toHaveBeenCalled();
    });
  });
});
