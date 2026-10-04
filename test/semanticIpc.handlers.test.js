/**
 * @jest-environment node
 */
const { IPC_CHANNELS, IPC_EVENTS } = require('../src/shared/constants');

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

jest.mock('fs', () => ({
  promises: {
    stat: jest.fn().mockResolvedValue({ size: 100 }),
    access: jest.fn().mockResolvedValue(),
    readFile: jest.fn().mockResolvedValue('content')
  }
}));

jest.mock('../src/main/ipc/ipcWrappers', () => ({
  createHandler: jest.fn(({ handler }) => handler),
  createErrorResponse: jest.fn((err) => ({ success: false, error: err.message })),
  safeHandle: jest.fn(),
  safeSend: jest.fn(),
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

jest.mock('../src/shared/pathSanitization', () => ({
  validateFileOperationPath: jest.fn((p) => p),
  normalizePathForIndex: jest.fn((p) => p),
  // Real containment is exercised in semanticIpc.rebuildFilesMonotonic.test.js;
  // this harness never passes excludePathPrefixes, so "nothing is excluded".
  isPathWithinAllowed: jest.fn(() => false)
}));

jest.mock('../src/main/services/OramaVectorService', () => ({
  getInstance: jest.fn()
}));

jest.mock('../src/main/services/FolderMatchingService', () => ({
  getInstance: jest.fn()
}));

jest.mock('../src/main/services/ParallelEmbeddingService', () => ({
  getInstance: jest.fn()
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
    getConfig: jest.fn().mockResolvedValue({}),
    listModels: jest
      .fn()
      .mockResolvedValue([
        { name: 'Mistral-7B-Instruct-v0.3-Q4_K_M.gguf' },
        { name: 'llava-v1.6-mistral-7b-Q4_K_M.gguf' },
        { name: 'nomic-embed-text-v1.5-Q8_0.gguf' }
      ])
  }))
}));

jest.mock('../src/shared/normalization', () => ({
  normalizeText: jest.fn((text) => text)
}));

describe('Semantic IPC (Handlers)', () => {
  let mockIpcMain;
  let mockSettingsService;
  let mockFoldersService;
  let mockServiceIntegration;
  let safeHandle;
  let OramaVectorService;
  let SearchService;
  let ParallelEmbeddingService;
  let ClusteringService;
  let mockSearchService;
  let mockLlamaService;
  let mockMainWindow;
  /** The freshly-required semantic module (carries the rebuild test seam). */
  let semanticModule;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    safeHandle = require('../src/main/ipc/ipcWrappers').safeHandle;
    OramaVectorService = require('../src/main/services/OramaVectorService');
    SearchService = require('../src/main/services/SearchService').SearchService;
    ParallelEmbeddingService = require('../src/main/services/ParallelEmbeddingService');
    ClusteringService = require('../src/main/services/ClusteringService').ClusteringService;

    const { container, ServiceIds } = require('../src/main/services/ServiceContainer');

    // Setup mocks
    const mockVectorDb = {
      initialize: jest.fn().mockResolvedValue(),
      rebuildIndex: jest.fn(),
      cleanup: jest.fn(),
      resetFiles: jest.fn(),
      batchUpsertFiles: jest.fn(),
      resetFileChunks: jest.fn(),
      resetAll: jest.fn(),
      resetFolders: jest.fn(), // Ensure this is present too
      getStats: jest.fn().mockResolvedValue({ files: 0, folders: 0 }) // For GET_STATS
    };

    const mockEmbeddingService = {
      reanalyzeAll: jest.fn()
    };

    const mockFolderMatcher = {
      initialize: jest.fn().mockResolvedValue(),
      embedText: jest.fn().mockResolvedValue({ vector: [], model: 'test' }),
      generateFolderId: jest.fn()
    };

    mockLlamaService = {
      getConfig: jest.fn().mockResolvedValue({}),
      listModels: jest
        .fn()
        .mockResolvedValue([
          { name: 'Mistral-7B-Instruct-v0.3-Q4_K_M.gguf' },
          { name: 'llava-v1.6-mistral-7b-Q4_K_M.gguf' },
          { name: 'nomic-embed-text-v1.5-Q8_0.gguf' }
        ])
    };

    // Mock container resolution
    container.resolve = jest.fn((id) => {
      switch (id) {
        case ServiceIds.ORAMA_VECTOR:
          return mockVectorDb;
        case ServiceIds.PARALLEL_EMBEDDING:
          return mockEmbeddingService;
        case ServiceIds.FOLDER_MATCHING:
          return mockFolderMatcher;
        case ServiceIds.LLAMA_SERVICE:
          return mockLlamaService;
        case ServiceIds.SEARCH_SERVICE:
          return mockSearchService;
        case ServiceIds.CLUSTERING:
          return {}; // Mock clustering service
        default:
          throw new Error(`Unexpected service resolution: ${id}`);
      }
    });
    container.tryResolve = container.resolve;

    // Also mock getInstance for test access
    OramaVectorService.getInstance.mockReturnValue(mockVectorDb);
    ParallelEmbeddingService.getInstance.mockReturnValue(mockEmbeddingService);
    require('../src/main/services/FolderMatchingService').getInstance.mockReturnValue(
      mockFolderMatcher
    );

    mockIpcMain = { handle: jest.fn() };
    mockSettingsService = {
      get: jest.fn(),
      load: jest.fn().mockResolvedValue({})
    };
    mockFoldersService = { getCustomFolders: jest.fn(() => []) };
    const mockLogger = require('../src/shared/logger').createLogger();

    // Mock SearchService instance
    mockSearchService = {
      hybridSearch: jest.fn(),
      diagnoseSearchIssues: jest.fn()
    };
    // SearchService constructor mock
    SearchService.mockImplementation(() => mockSearchService);

    mockServiceIntegration = {
      analysisHistory: {
        clear: jest.fn().mockResolvedValue(),
        getRecentAnalysis: jest.fn().mockResolvedValue([
          {
            id: 'file1',
            originalPath: 'C:\\test\\doc.pdf',
            analysis: {
              summary: 'test summary',
              extractedText: 'test text'
            }
          }
        ])
      },
      llamaService: {},
      searchService: mockSearchService,
      smartFolderWatcher: {
        start: jest.fn().mockResolvedValue(true),
        stop: jest.fn().mockResolvedValue()
      }
    };

    mockMainWindow = {
      isDestroyed: () => false,
      webContents: { send: jest.fn(), isDestroyed: () => false }
    };

    // Use plain object for legacy compatibility
    const context = {
      ipcMain: mockIpcMain,
      IPC_CHANNELS,
      settingsService: mockSettingsService,
      foldersService: mockFoldersService,
      getServiceIntegration: () => mockServiceIntegration,
      logger: mockLogger,
      getCustomFolders: mockFoldersService.getCustomFolders,
      getMainWindow: () => mockMainWindow
    };

    // Register the IPC handlers
    const registerEmbeddingsIpc = require('../src/main/ipc/semantic');
    registerEmbeddingsIpc(context);
    semanticModule = registerEmbeddingsIpc;
    // REANALYZE_ALL now arms a non-watched-file backfill on a deferred
    // immediate (D8). These suites are about the reanalyze handler itself, so
    // stub the rebuild rather than letting a real embedding run fire against
    // these mocks after the handler has already returned.
    semanticModule.__setRebuildFilesForTest(
      jest.fn().mockResolvedValue({ success: true, files: 0 })
    );
  });

  afterEach(() => {
    if (semanticModule) semanticModule.__setRebuildFilesForTest(null);
  });

  function getHandler(channel) {
    const call = safeHandle.mock.calls.find((c) => c[1] === channel);
    if (!call) throw new Error(`Handler for ${channel} not registered`);

    let handler = call[2];
    if (typeof handler !== 'function') {
      handler = call.find((arg) => typeof arg === 'function');
    }
    if (typeof handler !== 'function') throw new Error(`Handler for ${channel} is not a function`);
    return handler;
  }

  test('SEARCH performs hybrid search via SearchService', async () => {
    const handler = getHandler(IPC_CHANNELS.EMBEDDINGS.SEARCH);

    const query = 'test query';
    const options = { topK: 10 };

    // We need to ensure LlamaService returns available models for the verification check
    // This is already mocked in the module-level mock, but let's be sure

    // Also SearchService needs to return a valid result structure
    mockSearchService.hybridSearch.mockResolvedValue({
      success: true,
      results: [],
      meta: {},
      queryMeta: {}
    });

    const result = await handler({}, { query, ...options });

    expect(result.error).toBeUndefined();

    expect(mockSearchService.hybridSearch).toHaveBeenCalledWith(
      query,
      expect.objectContaining({
        topK: 10,
        mode: 'hybrid' // Default
      })
    );

    expect(result).toEqual(expect.objectContaining({ success: true, results: [] }));
  });

  test('REBUILD_FILES calls vectorDbService.rebuildIndex', async () => {
    const handler = getHandler(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES);
    const mockVectorDb = OramaVectorService.getInstance();
    mockVectorDb.rebuildIndex.mockResolvedValue({ count: 50 });
    mockVectorDb.batchUpsertFiles.mockResolvedValue({ count: 1 });
    mockVectorDb.batchUpsertFileChunks = jest.fn().mockResolvedValue(0);

    const { container, ServiceIds } = require('../src/main/services/ServiceContainer');
    const mockFolderMatcher = container.resolve(ServiceIds.FOLDER_MATCHING);
    mockFolderMatcher.embedText.mockResolvedValue({ vector: [0.1], model: 'test' });

    const result = await handler({}, {});

    expect(result.error).toBeUndefined();
    // D5: the rebuild is monotonic — it upserts over the live collection and
    // must NEVER clear it first (an interrupted run would empty the store).
    // FULL_REBUILD keeps its own reset; REBUILD_FILES no longer has one.
    expect(mockVectorDb.resetFiles).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ success: true }));
  });

  test('REBUILD_FILES fails when embedding model is unavailable (ignores empty model names)', async () => {
    const handler = getHandler(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES);
    const originalJestWorkerId = process.env.JEST_WORKER_ID;
    delete process.env.JEST_WORKER_ID;

    mockLlamaService.getConfig.mockResolvedValueOnce({
      embeddingModel: 'missing-embed.gguf'
    });
    mockLlamaService.listModels.mockResolvedValueOnce([{ filename: '' }, { name: '' }]);

    try {
      const result = await handler({}, {});
      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          errorCode: 'MODEL_NOT_AVAILABLE'
        })
      );
    } finally {
      process.env.JEST_WORKER_ID = originalJestWorkerId;
    }
  });

  test('REANALYZE_ALL calls smartFolderWatcher.forceReanalyzeAll', async () => {
    const handler = getHandler(IPC_CHANNELS.EMBEDDINGS.REANALYZE_ALL);

    // Mock the watcher method
    mockServiceIntegration.smartFolderWatcher.forceReanalyzeAll = jest.fn().mockResolvedValue({
      scanned: 20,
      queued: 10
    });
    // Mock the preview method (used for dry run check internally sometimes or if dryRun passed)
    mockServiceIntegration.smartFolderWatcher.previewReanalyzeAll = jest.fn().mockResolvedValue({
      scanned: 20,
      watchedFolders: []
    });

    // Mock ParallelEmbeddingService for reanalyze checks if needed, but the handler primarily uses smartFolderWatcher
    // The handler does check verifyReanalyzeModelsAvailable which uses LlamaService (already mocked)

    const result = await handler({}, { applyNaming: true });

    expect(result.error).toBeUndefined();
    expect(mockServiceIntegration.smartFolderWatcher.forceReanalyzeAll).toHaveBeenCalledWith({
      applyNaming: true
    });
    expect(result).toEqual(expect.objectContaining({ success: true, queued: 10 }));
  });

  // F-189 (K-01): reanalyze-all must not destroy the index before the
  // replacement exists. Each file's re-analysis overwrites its own history
  // entry (pathLookup re-points) and vector (upsert by id), so nothing is
  // cleared up front — a crash or quit mid-run leaves the old knowledge in
  // place instead of an empty store the health banner calls healthy.
  test('REANALYZE_ALL never clears history or resets the vector store up front', async () => {
    const handler = getHandler(IPC_CHANNELS.EMBEDDINGS.REANALYZE_ALL);
    const mockVectorDb = OramaVectorService.getInstance();
    mockServiceIntegration.smartFolderWatcher.forceReanalyzeAll = jest
      .fn()
      .mockResolvedValue({ scanned: 3, queued: 3 });

    const result = await handler({}, { applyNaming: false });

    expect(result).toEqual(expect.objectContaining({ success: true, queued: 3 }));
    expect(mockServiceIntegration.analysisHistory.clear).not.toHaveBeenCalled();
    expect(mockVectorDb.resetAll).not.toHaveBeenCalled();
    expect(mockVectorDb.resetFiles).not.toHaveBeenCalled();
    expect(mockVectorDb.resetFileChunks).not.toHaveBeenCalled();
  });

  test('REANALYZE_ALL progress poller emits OPERATION_PROGRESS via the context getMainWindow', async () => {
    jest.useFakeTimers();
    try {
      const { safeSend } = require('../src/main/ipc/ipcWrappers');
      const handler = getHandler(IPC_CHANNELS.EMBEDDINGS.REANALYZE_ALL);

      mockServiceIntegration.smartFolderWatcher.forceReanalyzeAll = jest.fn().mockResolvedValue({
        scanned: 20,
        queued: 10
      });
      mockServiceIntegration.smartFolderWatcher.isRunning = true;
      mockServiceIntegration.smartFolderWatcher.getStatus = jest.fn(() => ({
        queueLength: 5,
        processingCount: 0,
        pendingReanalyzeCount: 0
      }));

      const result = await handler({}, { applyNaming: false });
      expect(result.success).toBe(true);

      jest.advanceTimersByTime(1000);

      expect(safeSend).toHaveBeenCalledWith(
        mockMainWindow.webContents,
        IPC_EVENTS.OPERATION_PROGRESS,
        expect.objectContaining({
          type: 'batch_analyze',
          completed: 5,
          total: 10,
          percent: 50
        })
      );
    } finally {
      if (global.__reanalyzePollInterval) {
        clearInterval(global.__reanalyzePollInterval);
        global.__reanalyzePollInterval = null;
      }
      jest.useRealTimers();
    }
  });

  test('DIAGNOSE_SEARCH calls searchService.diagnoseSearchIssues', async () => {
    const handler = getHandler(IPC_CHANNELS.EMBEDDINGS.DIAGNOSE_SEARCH);

    const diagnoseService = mockServiceIntegration.searchService;
    diagnoseService.diagnoseSearchIssues.mockResolvedValue({ issues: [] });

    const result = await handler({}, { testQuery: 'foo' });

    expect(mockSearchService.diagnoseSearchIssues).toHaveBeenCalledWith('foo');
    expect(result).toEqual({ success: true, diagnostics: { issues: [] } });
  });

  // F-197 (K-02): index health used to fire only when the vector count was
  // ZERO. 11 vectors for 281 analyzed files reported "healthy". Coverage is
  // embedded ÷ embedding-eligible history; below 95% with ≥1 uncovered file
  // is a warning the UI must show.
  describe('GET_STATS embedding coverage [F-197]', () => {
    function armHistory(eligibleFiles) {
      mockServiceIntegration.analysisHistory.getQuickStats = jest.fn().mockResolvedValue({
        totalFiles: eligibleFiles + 5,
        embedding: { eligibleFiles, doneFiles: 0, pendingFiles: 0 }
      });
    }

    test('flags low coverage with the uncovered count, without demanding a full rebuild', async () => {
      const handler = getHandler(IPC_CHANNELS.EMBEDDINGS.GET_STATS);
      OramaVectorService.getInstance().getStats.mockResolvedValue({ files: 11, folders: 2 });
      armHistory(281);

      const result = await handler({});

      expect(result.success).toBe(true);
      expect(result.embeddingCoverage).toBeCloseTo(11 / 281, 3);
      expect(result.uncoveredFiles).toBe(270);
      expect(result.embeddingCoverageLow).toBe(true);
      expect(result.needsFileEmbeddingRebuild).toBe(false);
    });

    test('is quiet at full coverage and when nothing has been analyzed', async () => {
      const handler = getHandler(IPC_CHANNELS.EMBEDDINGS.GET_STATS);
      OramaVectorService.getInstance().getStats.mockResolvedValue({ files: 40, folders: 2 });
      armHistory(40);
      let result = await handler({});
      expect(result.embeddingCoverageLow).toBe(false);
      expect(result.uncoveredFiles).toBe(0);

      OramaVectorService.getInstance().getStats.mockResolvedValue({ files: 0, folders: 0 });
      armHistory(0);
      result = await handler({});
      expect(result.embeddingCoverageLow).toBe(false);
      expect(result.embeddingCoverage).toBeNull();
    });

    test('tolerates a small gap (one file short of 20 is still ≥ 95%)', async () => {
      const handler = getHandler(IPC_CHANNELS.EMBEDDINGS.GET_STATS);
      OramaVectorService.getInstance().getStats.mockResolvedValue({ files: 19, folders: 0 });
      armHistory(20);
      const result = await handler({});
      expect(result.uncoveredFiles).toBe(1);
      expect(result.embeddingCoverageLow).toBe(false);
    });
  });
});
