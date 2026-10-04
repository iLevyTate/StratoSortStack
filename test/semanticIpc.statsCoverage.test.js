/**
 * @jest-environment node
 *
 * D6 guardrail: EMBEDDINGS.GET_STATS health must flip on coverage, not on zero.
 *
 * The handler used to only warn when the vector count was exactly zero or a
 * rebuild had been interrupted, so 11 vectors for 281 analyzed files still
 * read as "healthy". It now compares fileCount against the eligible-file
 * total and sets embeddingCoverageLow whenever coverage drops below 95%.
 * needsFileEmbeddingRebuild keeps its narrower meaning (index empty or
 * rebuild interrupted), because the banner words that state as "empty".
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

// Keep the rebuild off the real embedding-index metadata file (userData write).
jest.mock('../src/main/services/vectorDb/embeddingIndexMetadata', () => ({
  readEmbeddingIndexMetadata: jest.fn().mockResolvedValue(null),
  writeEmbeddingIndexMetadata: jest.fn().mockResolvedValue(undefined),
  updateEmbeddingIndexMetadata: jest.fn().mockResolvedValue(undefined),
  markRebuildInProgress: jest.fn().mockResolvedValue(undefined),
  clearRebuildInProgress: jest.fn().mockResolvedValue(undefined)
}));

// CP-11 resolver is exercised by its own suite; here it only needs to resolve.
jest.mock('../src/main/analysis/embeddingModelOptions', () => ({
  resolveEmbeddingModelOptions: jest.fn().mockResolvedValue({})
}));

// isEmbeddingPipelineBusy() reads this module directly (not through the
// service container), so it needs its own mock to drive the "busy" branch.
jest.mock('../src/main/analysis/embeddingQueue/queueManager', () => ({
  getStats: jest.fn(() => ({ analysis: null, organize: null }))
}));

describe('EMBEDDINGS.GET_STATS coverage health (D6)', () => {
  let safeHandle;
  let OramaVectorService;
  let FolderMatchingService;
  let embeddingQueueManager;
  let historyService;
  /** Mutable so a test can point serviceIntegration.analysisHistory elsewhere. */
  let serviceIntegration;

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
    embeddingQueueManager = require('../src/main/analysis/embeddingQueue/queueManager');

    const { container, ServiceIds } = require('../src/main/services/ServiceContainer');

    // GET_STATS itself only calls getOramaService().getStats() and
    // getLlamaService().getConfig(). FOLDER_MATCHING still needs a working
    // initialize() because ensureInitialized() (the safeEnsureInit() gate
    // every handler runs first) always initializes both the vector store and
    // the folder matcher, regardless of which handler is being tested.
    const mockVectorDbInstance = {
      initialize: jest.fn().mockResolvedValue(),
      getStats: jest.fn()
    };

    const mockFolderMatcherInstance = {
      initialize: jest.fn().mockResolvedValue()
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
        default:
          return null;
      }
    });
    container.tryResolve = container.resolve;

    OramaVectorService.getInstance.mockReturnValue(mockVectorDbInstance);
    FolderMatchingService.getInstance.mockReturnValue(mockFolderMatcherInstance);

    historyService = {};
    serviceIntegration = { analysisHistory: historyService };

    const mockLogger = require('../src/shared/logger').createLogger();
    const context = {
      ipcMain: { handle: jest.fn() },
      IPC_CHANNELS,
      getServiceIntegration: () => serviceIntegration,
      logger: mockLogger,
      getCustomFolders: jest.fn(() => [])
    };

    const registerEmbeddingsIpc = require('../src/main/ipc/semantic');
    registerEmbeddingsIpc(context);
  });

  test('flags low coverage when fewer than 95% of eligible files have vectors', async () => {
    const orama = OramaVectorService.getInstance();
    orama.getStats = jest.fn().mockResolvedValue({ files: 11, fileChunks: 21, folders: 6 });
    historyService.getQuickStats = jest.fn().mockResolvedValue({
      totalFiles: 281,
      embedding: { eligibleFiles: 281 }
    });

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.GET_STATS, {});

    expect(result.success).toBe(true);
    expect(result.embeddingCoverage).toBeCloseTo(11 / 281, 3);
    expect(result.embeddingCoverageLow).toBe(true);
    expect(result.uncoveredFiles).toBe(270);
    // 11 files ARE indexed: the "index is empty" state must stay off, or the
    // banner tells the user their search index is empty when it is not.
    expect(result.needsFileEmbeddingRebuild).toBe(false);
  });

  test('recommends a full rebuild only when the file index is empty', async () => {
    const orama = OramaVectorService.getInstance();
    orama.getStats = jest.fn().mockResolvedValue({ files: 0, fileChunks: 0, folders: 6 });
    historyService.getQuickStats = jest.fn().mockResolvedValue({
      totalFiles: 281,
      embedding: { eligibleFiles: 281 }
    });

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.GET_STATS, {});

    expect(result.needsFileEmbeddingRebuild).toBe(true);
    expect(result.embeddingCoverageLow).toBe(true);
    expect(result.uncoveredFiles).toBe(281);
  });

  test('does not recommend a rebuild at full coverage', async () => {
    const orama = OramaVectorService.getInstance();
    orama.getStats = jest.fn().mockResolvedValue({ files: 281, fileChunks: 0, folders: 6 });
    historyService.getQuickStats = jest.fn().mockResolvedValue({
      totalFiles: 281,
      embedding: { eligibleFiles: 281 }
    });

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.GET_STATS, {});

    expect(result.needsFileEmbeddingRebuild).toBe(false);
    expect(result.embeddingCoverageLow).toBe(false);
    expect(result.uncoveredFiles).toBe(0);
  });

  test('does not recommend a rebuild while an embedding build is in progress', async () => {
    // isEmbeddingPipelineBusy() (module-local in semantic.js) treats a flushing
    // stage queue as "busy" regardless of coverage. Drive that branch directly
    // through the queueManager mock rather than the service container.
    const orama = OramaVectorService.getInstance();
    orama.getStats = jest.fn().mockResolvedValue({ files: 11, fileChunks: 21, folders: 6 });
    historyService.getQuickStats = jest.fn().mockResolvedValue({
      totalFiles: 281,
      embedding: { eligibleFiles: 281 }
    });
    embeddingQueueManager.getStats.mockReturnValue({
      analysis: { isFlushing: true, queueLength: 0 },
      organize: null
    });

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.GET_STATS, {});

    expect(result.success).toBe(true);
    expect(result.embeddingBuildInProgress).toBe(true);
    // Coverage is 11/281 (well below the 95% threshold) but the in-progress
    // build must suppress both warnings regardless.
    expect(result.needsFileEmbeddingRebuild).toBe(false);
    expect(result.embeddingCoverageLow).toBe(false);
  });

  test('does not flag coverage at 96.1% (above the 95% threshold)', async () => {
    const orama = OramaVectorService.getInstance();
    orama.getStats = jest.fn().mockResolvedValue({ files: 270, fileChunks: 0, folders: 6 });
    historyService.getQuickStats = jest.fn().mockResolvedValue({
      totalFiles: 281,
      embedding: { eligibleFiles: 281 }
    });

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.GET_STATS, {});

    expect(result.embeddingCoverage).toBeCloseTo(270 / 281, 3);
    expect(result.embeddingCoverageLow).toBe(false);
  });

  test('flags coverage at 94.7% (below the 95% threshold)', async () => {
    const orama = OramaVectorService.getInstance();
    orama.getStats = jest.fn().mockResolvedValue({ files: 266, fileChunks: 0, folders: 6 });
    historyService.getQuickStats = jest.fn().mockResolvedValue({
      totalFiles: 281,
      embedding: { eligibleFiles: 281 }
    });

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.GET_STATS, {});

    expect(result.embeddingCoverage).toBeCloseTo(266 / 281, 3);
    expect(result.embeddingCoverageLow).toBe(true);
  });
});
