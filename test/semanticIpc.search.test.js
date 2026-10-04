/**
 * @jest-environment node
 */
const { ipcMain } = require('./mocks/electron');

jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

jest.mock('../src/main/services/OramaVectorService', () => ({
  getInstance: jest.fn(() => ({
    initialize: jest.fn().mockResolvedValue(undefined)
  }))
}));

jest.mock('../src/main/services/FolderMatchingService', () => ({
  getInstance: jest.fn(() => ({
    initialize: jest.fn().mockResolvedValue(undefined)
  }))
}));

jest.mock('../src/main/services/ParallelEmbeddingService', () => ({
  getInstance: jest.fn(() => ({}))
}));

jest.mock('../src/main/services/QueryProcessor', () => ({
  getInstance: jest.fn(() => ({
    extendVocabulary: jest.fn().mockResolvedValue(undefined)
  }))
}));

jest.mock('../src/main/services/SearchService', () => {
  const svc = {
    warmUp: jest.fn().mockResolvedValue(undefined),
    rebuildIndex: jest.fn().mockResolvedValue({ success: true }),
    hybridSearch: jest.fn()
  };
  return {
    SearchService: jest.fn(() => svc),
    __svc: svc
  };
});

describe('Embeddings IPC (semantic.js) - SEARCH', () => {
  beforeEach(() => {
    ipcMain._handlers.clear();
    ipcMain.handle.mockClear();
    jest.resetModules();

    // Mock container.resolve to return the mocked services
    const { container, ServiceIds } = require('../src/main/services/ServiceContainer');
    const OramaVectorService = require('../src/main/services/OramaVectorService');
    const FolderMatchingService = require('../src/main/services/FolderMatchingService');
    const ParallelEmbeddingService = require('../src/main/services/ParallelEmbeddingService');
    const SearchService = require('../src/main/services/SearchService');
    const QueryProcessor = require('../src/main/services/QueryProcessor');

    container.resolve = jest.fn((id) => {
      switch (id) {
        case ServiceIds.ORAMA_VECTOR:
          return OramaVectorService.getInstance();
        case ServiceIds.FOLDER_MATCHING:
          return FolderMatchingService.getInstance();
        case ServiceIds.PARALLEL_EMBEDDING:
          return ParallelEmbeddingService.getInstance();
        case ServiceIds.SEARCH_SERVICE:
          return SearchService.__svc;
        case ServiceIds.LLAMA_SERVICE:
          return {
            getConfig: jest.fn().mockResolvedValue({}),
            listModels: jest.fn().mockResolvedValue([])
          };
        case ServiceIds.CLUSTERING:
          return {};
        default:
          return {};
      }
    });
    container.tryResolve = container.resolve;
  });

  function register({ settingsService } = {}) {
    const registerEmbeddingsIpc = require('../src/main/ipc/semantic');
    const { IPC_CHANNELS } = require('../src/shared/constants');
    const effectiveSettingsService = settingsService || {
      load: jest.fn(async () => ({
        graphExpansionEnabled: true,
        graphExpansionWeight: 0.2,
        graphExpansionMaxNeighbors: 120,
        chunkContextEnabled: true,
        chunkContextMaxNeighbors: 1
      }))
    };

    registerEmbeddingsIpc({
      ipcMain,
      IPC_CHANNELS,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      getCustomFolders: jest.fn(() => []),
      setCustomFolders: jest.fn(),
      saveCustomFolders: jest.fn(),
      scanDirectory: jest.fn(),
      getServiceIntegration: jest.fn(() => ({
        analysisHistory: {}, // required for SearchService init
        llamaService: null,
        relationshipIndex: null,
        settingsService: effectiveSettingsService
      }))
    });

    return { IPC_CHANNELS };
  }

  test('rejects missing/short query and invalid topK', async () => {
    const { IPC_CHANNELS } = register();
    const handler = ipcMain._handlers.get(IPC_CHANNELS.EMBEDDINGS.SEARCH);

    // Zod schema rejects empty/short queries and invalid topK at the validation layer
    await expect(handler(null, { query: '' })).resolves.toEqual(
      expect.objectContaining({ success: false })
    );
    await expect(handler(null, { query: 'a' })).resolves.toEqual(
      expect.objectContaining({ success: false })
    );
    await expect(handler(null, { query: 'ok', topK: 0 })).resolves.toEqual(
      expect.objectContaining({ success: false })
    );
  });

  test('calls SearchService.hybridSearch with normalized query + options', async () => {
    const { IPC_CHANNELS } = register();
    const svcModule = require('../src/main/services/SearchService');

    svcModule.__svc.hybridSearch.mockResolvedValue({
      success: true,
      results: [{ id: 'file:x', score: 0.9 }],
      mode: 'hybrid',
      meta: { bm25Built: true }
    });

    const handler = ipcMain._handlers.get(IPC_CHANNELS.EMBEDDINGS.SEARCH);

    // Pull text from a real test fixture (filename only; we just use a few keywords)
    const query = 'Stratosort AI Integration milestones';
    const res = await handler(null, { query, topK: 5, mode: 'hybrid', rerank: false });

    expect(res).toEqual(
      expect.objectContaining({
        success: true,
        mode: 'hybrid',
        results: expect.any(Array)
      })
    );
    expect(svcModule.__svc.hybridSearch).toHaveBeenCalledWith(
      query,
      expect.objectContaining({
        topK: 5,
        mode: 'hybrid',
        rerank: false,
        expandSynonyms: true
      })
    );
  });

  test('falls back to BM25 when hybridSearch fails in non-bm25 modes', async () => {
    const { IPC_CHANNELS } = register();
    const svcModule = require('../src/main/services/SearchService');

    svcModule.__svc.hybridSearch
      .mockResolvedValueOnce({ success: false, error: 'vector failed' })
      .mockResolvedValueOnce({ success: true, results: [{ id: 'file:y', score: 1 }], meta: {} });

    const handler = ipcMain._handlers.get(IPC_CHANNELS.EMBEDDINGS.SEARCH);
    const res = await handler(null, { query: 'project report', topK: 3, mode: 'hybrid' });

    expect(res).toEqual(
      expect.objectContaining({
        success: true,
        mode: 'bm25',
        meta: expect.objectContaining({ fallback: true, originalMode: 'hybrid' })
      })
    );
    expect(svcModule.__svc.hybridSearch).toHaveBeenNthCalledWith(
      2,
      'project report',
      expect.objectContaining({ mode: 'bm25' })
    );
  });

  test('loads settings service via integration and applies search options', async () => {
    const settingsLoad = jest.fn(async () => ({
      graphExpansionEnabled: true,
      graphExpansionWeight: 0.33,
      graphExpansionMaxNeighbors: 88,
      chunkContextEnabled: true,
      chunkContextMaxNeighbors: 2
    }));
    const { IPC_CHANNELS } = register({ settingsService: { load: settingsLoad } });
    const svcModule = require('../src/main/services/SearchService');
    svcModule.__svc.hybridSearch.mockResolvedValue({
      success: true,
      results: [{ id: 'file:z', score: 0.7 }],
      mode: 'hybrid',
      meta: {}
    });
    const handler = ipcMain._handlers.get(IPC_CHANNELS.EMBEDDINGS.SEARCH);

    await handler(null, { query: 'test semantic settings', topK: 5, mode: 'hybrid' });

    expect(settingsLoad).toHaveBeenCalledTimes(1);
    expect(svcModule.__svc.hybridSearch).toHaveBeenCalledWith(
      'test semantic settings',
      expect.objectContaining({
        graphExpansion: true,
        graphExpansionWeight: 0.33,
        graphExpansionMaxNeighbors: 88,
        chunkContext: true,
        chunkContextMaxNeighbors: 2
      })
    );
  });

  test('uses deterministic defaults when optional settings are absent', async () => {
    const settingsLoad = jest.fn(async () => ({}));
    const { IPC_CHANNELS } = register({ settingsService: { load: settingsLoad } });
    const svcModule = require('../src/main/services/SearchService');
    svcModule.__svc.hybridSearch.mockResolvedValue({
      success: true,
      results: [{ id: 'file:default', score: 0.7 }],
      mode: 'hybrid',
      meta: {}
    });

    const handler = ipcMain._handlers.get(IPC_CHANNELS.EMBEDDINGS.SEARCH);
    await handler(null, { query: 'default option check', topK: 5, mode: 'hybrid' });

    expect(settingsLoad).toHaveBeenCalledTimes(1);
    const [, options] = svcModule.__svc.hybridSearch.mock.calls.at(-1);
    expect(options.rerank).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(options, 'graphExpansion')).toBe(false);
  });

  // Pre-fix this test asserted that Simple mode forcibly overrode any
  // graph/chunk toggle to `false` at the IPC layer. Policy reverted in
  // 2026-04 (see SIMPLE_MODE_ENFORCED_VALUES in experienceMode.js):
  // both modes ship with graph + chunk expansion ON by default; the mode
  // field only gates which knobs the Settings UI exposes. The IPC layer
  // must honor the explicit user setting, otherwise the toggles in
  // GraphRetrievalSection have no observable effect for Simple-mode users.
  test('honors persisted graph/chunk settings in simple mode (no forced override)', async () => {
    const settingsLoad = jest.fn(async () => ({
      experienceMode: 'simple',
      graphExpansionEnabled: false,
      graphExpansionWeight: 0.2,
      graphExpansionMaxNeighbors: 120,
      chunkContextEnabled: false,
      chunkContextMaxNeighbors: 1
    }));
    const { IPC_CHANNELS } = register({ settingsService: { load: settingsLoad } });
    const svcModule = require('../src/main/services/SearchService');
    svcModule.__svc.hybridSearch.mockResolvedValue({
      success: true,
      results: [{ id: 'file:simple', score: 0.6 }],
      mode: 'hybrid',
      meta: {}
    });

    const handler = ipcMain._handlers.get(IPC_CHANNELS.EMBEDDINGS.SEARCH);
    // No runtime override — settings file says false; we expect false.
    await handler(null, {
      query: 'simple mode persisted off',
      topK: 5,
      mode: 'hybrid'
    });

    const [, options] = svcModule.__svc.hybridSearch.mock.calls.at(-1);
    expect(options.graphExpansion).toBe(false);
    expect(options.chunkContext).toBe(false);
  });

  test('runtime graph/chunk overrides win over persisted settings in simple mode', async () => {
    const settingsLoad = jest.fn(async () => ({
      experienceMode: 'simple',
      graphExpansionEnabled: false,
      chunkContextEnabled: false
    }));
    const { IPC_CHANNELS } = register({ settingsService: { load: settingsLoad } });
    const svcModule = require('../src/main/services/SearchService');
    svcModule.__svc.hybridSearch.mockResolvedValue({
      success: true,
      results: [{ id: 'file:simple', score: 0.6 }],
      mode: 'hybrid',
      meta: {}
    });

    const handler = ipcMain._handlers.get(IPC_CHANNELS.EMBEDDINGS.SEARCH);
    await handler(null, {
      query: 'simple mode runtime override',
      topK: 5,
      mode: 'hybrid',
      graphExpansion: true,
      chunkContext: true
    });

    const [, options] = svcModule.__svc.hybridSearch.mock.calls.at(-1);
    expect(options.graphExpansion).toBe(true);
    expect(options.chunkContext).toBe(true);
  });
});
