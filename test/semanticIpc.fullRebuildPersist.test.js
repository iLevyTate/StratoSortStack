/**
 * @jest-environment node
 *
 * G2 caller: EMBEDDINGS.FULL_REBUILD must not tell the renderer a rebuild
 * fully succeeded when the cleared index never reached disk.
 *
 * resetAll() does not reject when its save fails; it resolves
 * `{ persisted: false }`. The handler used to ignore that, so a rebuild whose
 * reset (and whole rebuilt index) lived only in memory was reported as a plain
 * success, and the old index came back after a restart.
 */
const { IPC_CHANNELS } = require('../src/shared/constants');

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
  isPathWithinAllowed: jest.fn(() => false)
}));

jest.mock('../src/main/services/vectorDb/embeddingIndexMetadata', () => ({
  readEmbeddingIndexMetadata: jest.fn().mockResolvedValue(null),
  writeEmbeddingIndexMetadata: jest.fn().mockResolvedValue(),
  updateEmbeddingIndexMetadata: jest.fn().mockResolvedValue(),
  markRebuildInProgress: jest.fn().mockResolvedValue(),
  clearRebuildInProgress: jest.fn().mockResolvedValue()
}));

jest.mock('../src/main/analysis/embeddingModelOptions', () => ({
  resolveEmbeddingModelOptions: jest.fn().mockResolvedValue({
    embeddingModel: 'nomic-embed-text-v1.5-Q8_0.gguf',
    embeddingContextSize: undefined
  })
}));

jest.mock('../src/main/services/OramaVectorService', () => ({ getInstance: jest.fn() }));
jest.mock('../src/main/services/FolderMatchingService', () => ({ getInstance: jest.fn() }));
jest.mock('../src/main/services/ParallelEmbeddingService', () => ({ getInstance: jest.fn() }));
jest.mock('../src/main/services/SearchService', () => ({ SearchService: jest.fn() }));
jest.mock('../src/main/services/ClusteringService', () => ({ ClusteringService: jest.fn() }));
jest.mock('../src/main/services/QueryProcessor', () => ({ getInstance: jest.fn() }));
jest.mock('../src/main/services/LlamaService', () => ({ getInstance: jest.fn() }));
jest.mock('../src/shared/normalization', () => ({ normalizeText: jest.fn((text) => text) }));

describe('FULL_REBUILD reports whether the rebuilt index reached disk', () => {
  let safeHandle;
  let vectorDb;
  let metadata;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    safeHandle = require('../src/main/ipc/ipcWrappers').safeHandle;
    metadata = require('../src/main/services/vectorDb/embeddingIndexMetadata');
    const { container, ServiceIds } = require('../src/main/services/ServiceContainer');

    vectorDb = {
      initialize: jest.fn().mockResolvedValue(),
      resetAll: jest.fn().mockResolvedValue({ persisted: true }),
      persistAll: jest.fn().mockResolvedValue({ success: true }),
      batchUpsertFolders: jest.fn().mockResolvedValue({ count: 0 }),
      batchUpsertFiles: jest.fn().mockResolvedValue({ count: 1 }),
      batchUpsertFileChunks: jest.fn().mockResolvedValue(0),
      getStats: jest.fn().mockResolvedValue({ files: 0, folders: 0 })
    };
    const embeddingService = {
      embedText: jest.fn().mockResolvedValue({ vector: [0.1, 0.2, 0.3], model: 'm' })
    };
    const llama = {
      getConfig: jest.fn().mockResolvedValue({}),
      initialize: jest.fn().mockResolvedValue(),
      listModels: jest.fn().mockResolvedValue([])
    };
    const searchService = { buildBM25Index: jest.fn().mockResolvedValue() };
    const folderMatcher = {
      initialize: jest.fn().mockResolvedValue(),
      embedText: jest.fn().mockResolvedValue({ vector: [0.1], model: 'm' }),
      generateFolderId: jest.fn(() => 'folder-id')
    };

    container.resolve = jest.fn((id) => {
      switch (id) {
        case ServiceIds.ORAMA_VECTOR:
          return vectorDb;
        case ServiceIds.PARALLEL_EMBEDDING:
          return embeddingService;
        case ServiceIds.FOLDER_MATCHING:
          return folderMatcher;
        case ServiceIds.LLAMA_SERVICE:
          return llama;
        case ServiceIds.SEARCH_SERVICE:
          return searchService;
        default:
          return null;
      }
    });
    container.tryResolve = container.resolve;
    require('../src/main/services/OramaVectorService').getInstance.mockReturnValue(vectorDb);
    require('../src/main/services/ParallelEmbeddingService').getInstance.mockReturnValue(
      embeddingService
    );
    require('../src/main/services/LlamaService').getInstance.mockReturnValue(llama);
    require('../src/main/services/FolderMatchingService').getInstance.mockReturnValue(
      folderMatcher
    );

    const registerEmbeddingsIpc = require('../src/main/ipc/semantic');
    registerEmbeddingsIpc({
      ipcMain: { handle: jest.fn() },
      IPC_CHANNELS,
      settingsService: { get: jest.fn(), load: jest.fn().mockResolvedValue({}) },
      foldersService: { getCustomFolders: jest.fn(() => []) },
      getServiceIntegration: () => ({
        analysisHistory: {
          getRecentAnalysis: jest.fn().mockResolvedValue([
            {
              id: 'file1',
              originalPath: 'C:\\test\\doc.pdf',
              analysis: { summary: 'quarterly report', subject: 'finance' }
            }
          ])
        },
        searchService
      }),
      logger: require('../src/shared/logger').createLogger(),
      getCustomFolders: () => [],
      getMainWindow: () => null
    });
  });

  function fullRebuildHandler() {
    const call = safeHandle.mock.calls.find((c) => c[1] === IPC_CHANNELS.EMBEDDINGS.FULL_REBUILD);
    if (!call) throw new Error('FULL_REBUILD handler not registered');
    return call.find((arg) => typeof arg === 'function');
  }

  test('a reset that was saved is reported persisted, with no extra save', async () => {
    const result = await fullRebuildHandler()({}, {});

    expect(result).toEqual(expect.objectContaining({ success: true, persisted: true }));
    expect(result.warning).toBeUndefined();
    expect(vectorDb.resetAll).toHaveBeenCalledTimes(1);
    expect(vectorDb.persistAll).not.toHaveBeenCalled();
  });

  test('a reset save that failed and a final save that failed: persisted false + warning', async () => {
    vectorDb.resetAll.mockResolvedValue({ persisted: false, error: new Error('ENOSPC') });
    vectorDb.persistAll.mockResolvedValue({ success: false, error: new Error('ENOSPC') });

    const result = await fullRebuildHandler()({}, {});

    expect(result.success).toBe(true);
    expect(result.persisted).toBe(false);
    expect(result.warning).toMatch(/could not be saved to disk/);
    expect(result.message).toMatch(/not saved to disk/);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'persist', error: 'ENOSPC' })])
    );
    expect(vectorDb.persistAll).toHaveBeenCalledTimes(1);
  });

  test('an index that never reached disk keeps the rebuildInProgress marker and raises a flag', async () => {
    vectorDb.resetAll.mockResolvedValue({ persisted: false, error: new Error('ENOSPC') });
    vectorDb.persistAll.mockResolvedValue({ success: false, error: new Error('ENOSPC') });

    const result = await fullRebuildHandler()({}, {});

    expect(result.persisted).toBe(false);
    // The disk still holds the OLD index; the marker is the only durable
    // signal that makes startup ask for a rebuild instead of trusting it.
    expect(metadata.clearRebuildInProgress).not.toHaveBeenCalled();
    const flags = require('../src/main/services/DegradedStateTracker').getInstance().list();
    expect(flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'embeddings.rebuild-not-persisted',
          subsystem: 'vector-db'
        })
      ])
    );
  });

  test('a later rebuild that reaches disk clears the not-persisted flag', async () => {
    const tracker = require('../src/main/services/DegradedStateTracker').getInstance();
    tracker.raise({
      code: 'embeddings.rebuild-not-persisted',
      subsystem: 'vector-db',
      severity: 'warning',
      message: 'stale'
    });

    const result = await fullRebuildHandler()({}, {});

    expect(result.persisted).toBe(true);
    expect(metadata.clearRebuildInProgress).toHaveBeenCalled();
    expect(tracker.list().map((f) => f.code)).not.toContain('embeddings.rebuild-not-persisted');
  });

  test('a reset save that failed is retried once the index is rebuilt', async () => {
    vectorDb.resetAll.mockResolvedValue({ persisted: false, error: new Error('EBUSY') });
    vectorDb.persistAll.mockResolvedValue({ success: true });

    const result = await fullRebuildHandler()({}, {});

    expect(result).toEqual(expect.objectContaining({ success: true, persisted: true }));
    expect(result.warning).toBeUndefined();
    expect(vectorDb.persistAll).toHaveBeenCalledTimes(1);
    // The retry runs after the rebuilt rows are in, not before.
    expect(vectorDb.persistAll.mock.invocationCallOrder[0]).toBeGreaterThan(
      vectorDb.batchUpsertFiles.mock.invocationCallOrder[0]
    );
    expect(metadata.clearRebuildInProgress).toHaveBeenCalled();
  });
  test('a final save that skipped a rebuilt collection as too large is not reported persisted', async () => {
    vectorDb.resetAll.mockResolvedValue({ persisted: false, error: new Error('EBUSY') });
    vectorDb.persistAll.mockResolvedValue({ success: true, tooLargeToSave: ['fileChunks'] });

    const result = await fullRebuildHandler()({}, {});

    expect(result.persisted).toBe(false);
    expect(metadata.clearRebuildInProgress).not.toHaveBeenCalled();
  });
});
