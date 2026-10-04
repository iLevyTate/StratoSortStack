/**
 * @jest-environment node
 *
 * K-01/D5/D8 guardrail: EMBEDDINGS.REANALYZE_ALL must be monotonic AND complete.
 *
 * The handler used to clear analysis history and call resetAll() on the vector
 * store BEFORE queueing anything, then hand the work to the smart-folder
 * watcher — which only ever walks WATCHED folders. Every file analyzed outside
 * a smart folder therefore lost its vector permanently (223 -> 0 on the owner's
 * 2026-09-13 run, 136 of 281 files unreachable by the watcher path).
 *
 * It now deletes nothing, lets the watcher re-analyze what it owns, and
 * backfills everything else from analysis history via handleRebuildFiles with
 * the watched roots excluded.
 */
const { IPC_CHANNELS } = require('../src/shared/constants');

// Mock dependencies
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
  createErrorResponse: jest.fn((err) => ({ success: false, error: err.message })),
  safeHandle: jest.fn(),
  withErrorLogging: jest.fn((logger, handler) => {
    if (typeof logger === 'function') return logger;
    return handler;
  }),
  withVectorDbInit: jest.fn((arg) => {
    if (typeof arg === 'function') return arg;
    if (arg && typeof arg.handler === 'function') return arg.handler;
    return arg;
  }),
  z: (() => {
    const chainable = () => new Proxy({}, { get: () => chainable });
    return new Proxy({}, { get: () => chainable });
  })()
}));

jest.mock('../src/main/services/OramaVectorService', () => ({
  getInstance: jest.fn(() => ({
    initialize: jest.fn().mockResolvedValue(),
    getStats: jest.fn(),
    rebuildIndex: jest.fn()
  }))
}));

jest.mock('../src/main/services/FolderMatchingService', () => ({
  getInstance: jest.fn(() => ({
    initialize: jest.fn().mockResolvedValue(),
    rebuildIndex: jest.fn()
  }))
}));

jest.mock('../src/main/services/ParallelEmbeddingService', () => ({
  getInstance: jest.fn(() => ({}))
}));

jest.mock('../src/main/services/SearchService', () => ({
  SearchService: jest.fn()
}));

jest.mock('../src/main/services/ClusteringService', () => ({
  ClusteringService: jest.fn()
}));

jest.mock('../src/main/services/QueryProcessor', () => ({
  getInstance: jest.fn()
}));

jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: jest.fn(() => ({
    getConfig: jest.fn().mockResolvedValue({})
  }))
}));

// Real timers only: the handler arms the backfill with setImmediate, and
// immediates run FIFO, so a resolve queued behind it is guaranteed to observe
// the backfill call. Under fake timers this resolves nothing.
const flushImmediates = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

describe('EMBEDDINGS.REANALYZE_ALL (monotonic)', () => {
  let safeHandle;
  let OramaVectorService;
  let FolderMatchingService;
  let historyService;
  let mockFoldersService;
  /** Mutable so a test can swap in its own smartFolderWatcher. */
  let serviceIntegration;
  /** The freshly-required semantic module (carries the rebuild test seam). */
  let semanticModule;

  const invoke = async (channel, payload) => {
    const call = safeHandle.mock.calls.find((c) => c[1] === channel);
    if (!call) throw new Error(`${channel} handler not registered`);
    const handler =
      typeof call[2] === 'function' ? call[2] : call.find((arg) => typeof arg === 'function');
    if (typeof handler !== 'function') throw new Error(`${channel} handler is not a function`);
    return handler({}, payload);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    safeHandle = require('../src/main/ipc/ipcWrappers').safeHandle;
    OramaVectorService = require('../src/main/services/OramaVectorService');
    FolderMatchingService = require('../src/main/services/FolderMatchingService');

    const { container, ServiceIds } = require('../src/main/services/ServiceContainer');

    const mockVectorDbInstance = {
      initialize: jest.fn().mockResolvedValue(),
      getStats: jest.fn(),
      rebuildIndex: jest.fn(),
      resetAll: jest.fn(),
      resetFolders: jest.fn(),
      resetFiles: jest.fn(),
      resetFileChunks: jest.fn(),
      batchUpsertFolders: jest.fn().mockResolvedValue(0),
      batchUpsertFiles: jest.fn().mockResolvedValue({ count: 0 }),
      hasUsableVector: jest.fn().mockResolvedValue(false)
    };

    const mockFolderMatcherInstance = {
      initialize: jest.fn().mockResolvedValue(),
      rebuildIndex: jest.fn(),
      embedText: jest.fn().mockResolvedValue({ vector: [0.1, 0.2], model: 'm' }),
      generateFolderId: jest.fn(() => 'folder-1')
    };

    const mockLlamaService = {
      getConfig: jest.fn().mockResolvedValue({})
    };

    container.resolve = jest.fn((id) => {
      switch (id) {
        case ServiceIds.ORAMA_VECTOR:
          return mockVectorDbInstance;
        case ServiceIds.FOLDER_MATCHING:
          return mockFolderMatcherInstance;
        case ServiceIds.LLAMA_SERVICE:
          return mockLlamaService;
        case ServiceIds.PARALLEL_EMBEDDING:
          return { embedText: jest.fn().mockResolvedValue({ vector: [0.1, 0.2], model: 'm' }) };
        default:
          return null;
      }
    });
    container.tryResolve = container.resolve;

    OramaVectorService.getInstance.mockReturnValue(mockVectorDbInstance);
    FolderMatchingService.getInstance.mockReturnValue(mockFolderMatcherInstance);

    historyService = { getRecentAnalysis: jest.fn().mockResolvedValue([]) };
    mockFoldersService = { getCustomFolders: jest.fn(() => []) };
    serviceIntegration = { analysisHistory: historyService };

    const mockLogger = require('../src/shared/logger').createLogger();
    const context = {
      ipcMain: { handle: jest.fn() },
      IPC_CHANNELS,
      settingsService: { get: jest.fn() },
      foldersService: mockFoldersService,
      getServiceIntegration: () => serviceIntegration,
      logger: mockLogger,
      getCustomFolders: mockFoldersService.getCustomFolders
    };

    semanticModule = require('../src/main/ipc/semantic');
    semanticModule(context);
  });

  afterEach(() => {
    semanticModule.__setRebuildFilesForTest(null);
    // Step 8 arms a 1s UI-progress poll on the success path; don't leak it.
    const poll = /** @type {any} */ (global).__reanalyzePollInterval;
    if (poll) {
      clearInterval(poll);
      /** @type {any} */ (global).__reanalyzePollInterval = null;
    }
  });

  test('does not clear history or reset the vector store, and backfills non-watched files', async () => {
    const orama = OramaVectorService.getInstance();
    orama.resetAll = jest.fn();
    orama.batchUpsertFolders = jest.fn().mockResolvedValue(6);
    historyService.clear = jest.fn();
    const watcher = {
      isRunning: true,
      start: jest.fn().mockResolvedValue(true),
      watchedPaths: ['C:\\watched'],
      getStatus: jest.fn(() => ({ queueLength: 0, processingCount: 0 })),
      forceReanalyzeAll: jest.fn().mockResolvedValue({ scanned: 3, queued: 3 })
    };
    serviceIntegration.smartFolderWatcher = watcher;
    const rebuildSpy = jest.fn().mockResolvedValue({ success: true, files: 0 });
    semanticModule.__setRebuildFilesForTest(rebuildSpy);

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REANALYZE_ALL, {});
    await flushImmediates();

    expect(result.success).toBe(true);
    expect(historyService.clear).not.toHaveBeenCalled();
    expect(orama.resetAll).not.toHaveBeenCalled();
    expect(watcher.forceReanalyzeAll).toHaveBeenCalledTimes(1);
    expect(rebuildSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ onlyMissing: false, excludePathPrefixes: ['C:\\watched'] }),
      // Its own lock label, so a competing Full rebuild names the backfill.
      expect.objectContaining({ lockLabel: 'REANALYZE_ALL_BACKFILL' })
    );
  });

  test('a Set of watched paths becomes the exclude list (SmartFolderWatcher stores a Set)', async () => {
    const watcher = {
      isRunning: true,
      watchedPaths: new Set(['C:\\watched', 'C:\\other']),
      getStatus: jest.fn(() => ({ queueLength: 0, processingCount: 0 })),
      forceReanalyzeAll: jest.fn().mockResolvedValue({ scanned: 1, queued: 1 })
    };
    serviceIntegration.smartFolderWatcher = watcher;
    const rebuildSpy = jest.fn().mockResolvedValue({ success: true, files: 0 });
    semanticModule.__setRebuildFilesForTest(rebuildSpy);

    await invoke(IPC_CHANNELS.EMBEDDINGS.REANALYZE_ALL, {});

    await flushImmediates();

    expect(rebuildSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ excludePathPrefixes: ['C:\\watched', 'C:\\other'] }),
      expect.any(Object)
    );
  });

  test('a watcher with no watchedPaths backfills everything (empty exclude list)', async () => {
    const watcher = {
      isRunning: true,
      getStatus: jest.fn(() => ({ queueLength: 0, processingCount: 0 })),
      forceReanalyzeAll: jest.fn().mockResolvedValue({ scanned: 1, queued: 1 })
    };
    serviceIntegration.smartFolderWatcher = watcher;
    const rebuildSpy = jest.fn().mockResolvedValue({ success: true, files: 0 });
    semanticModule.__setRebuildFilesForTest(rebuildSpy);

    await invoke(IPC_CHANNELS.EMBEDDINGS.REANALYZE_ALL, {});

    await flushImmediates();

    expect(rebuildSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ excludePathPrefixes: [] }),
      expect.any(Object)
    );
  });

  test('no watcher means no queue and no backfill', async () => {
    // The backfill is armed only on the success path: an early return must not
    // kick off a rebuild the user never asked for.
    serviceIntegration.smartFolderWatcher = null;
    const rebuildSpy = jest.fn();
    semanticModule.__setRebuildFilesForTest(rebuildSpy);

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REANALYZE_ALL, {});

    await flushImmediates();

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('WATCHER_NOT_AVAILABLE');
    expect(rebuildSpy).not.toHaveBeenCalled();
  });

  test('the backfill runs after the rebuild lock is released, not against it', async () => {
    // handleRebuildFiles takes the SAME module-global rebuild lock, so a
    // backfill fired while REANALYZE_ALL still holds it would bounce off
    // REBUILD_IN_PROGRESS and silently leave the non-watched files unembedded.
    const { acquireRebuildLock, releaseRebuildLock } = semanticModule;
    const watcher = {
      isRunning: true,
      watchedPaths: ['C:\\watched'],
      getStatus: jest.fn(() => ({ queueLength: 0, processingCount: 0 })),
      forceReanalyzeAll: jest.fn().mockResolvedValue({ scanned: 1, queued: 1 })
    };
    serviceIntegration.smartFolderWatcher = watcher;

    let lockFreeAtBackfill = null;
    semanticModule.__setRebuildFilesForTest(
      jest.fn(async () => {
        const probe = acquireRebuildLock('PROBE');
        lockFreeAtBackfill = probe.acquired;
        if (probe.acquired) releaseRebuildLock(probe.token);
        return { success: true, files: 0 };
      })
    );

    await invoke(IPC_CHANNELS.EMBEDDINGS.REANALYZE_ALL, {});

    await flushImmediates();

    expect(lockFreeAtBackfill).toBe(true);
  });

  test('dry run still previews without touching the store', async () => {
    const orama = OramaVectorService.getInstance();
    orama.resetAll = jest.fn();
    const watcher = {
      isRunning: true,
      watchedPaths: ['C:\\watched'],
      previewReanalyzeAll: jest
        .fn()
        .mockResolvedValue({ scanned: 7, watchedFolders: ['C:\\watched'] }),
      forceReanalyzeAll: jest.fn()
    };
    serviceIntegration.smartFolderWatcher = watcher;
    const rebuildSpy = jest.fn();
    semanticModule.__setRebuildFilesForTest(rebuildSpy);

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REANALYZE_ALL, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.scanned).toBe(7);
    expect(orama.resetAll).not.toHaveBeenCalled();
    expect(watcher.forceReanalyzeAll).not.toHaveBeenCalled();
    expect(rebuildSpy).not.toHaveBeenCalled();
  });
});
