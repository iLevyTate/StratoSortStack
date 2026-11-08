/**
 * @jest-environment node
 *
 * EMBEDDINGS.SEARCH threads the IPC abort signal (event.abortSignal, fired by
 * the preload's system.abortInvoke when the renderer supersedes a query) into
 * SearchService.hybridSearch. A cancelled search answers with the normal
 * failure shape plus `cancelled: true`, is not logged as an error, and takes
 * no BM25 fallback (that would be the same wasted work under a new name).
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

function abortError() {
  const err = new Error('Search aborted');
  err.name = 'AbortError';
  return err;
}

describe('Embeddings IPC (semantic.js) - SEARCH abort', () => {
  let handlerLogger;

  beforeEach(() => {
    ipcMain._handlers.clear();
    ipcMain.handle.mockClear();
    jest.resetModules();

    const { container, ServiceIds } = require('../src/main/services/ServiceContainer');
    const OramaVectorService = require('../src/main/services/OramaVectorService');
    const FolderMatchingService = require('../src/main/services/FolderMatchingService');
    const ParallelEmbeddingService = require('../src/main/services/ParallelEmbeddingService');
    const SearchService = require('../src/main/services/SearchService');

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
        default:
          return {};
      }
    });
    container.tryResolve = container.resolve;
    require('../src/main/core/ipcAbortRegistry')._reset();
  });

  function register() {
    const registerEmbeddingsIpc = require('../src/main/ipc/semantic');
    const { IPC_CHANNELS } = require('../src/shared/constants');
    handlerLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    registerEmbeddingsIpc({
      ipcMain,
      IPC_CHANNELS,
      logger: handlerLogger,
      getCustomFolders: jest.fn(() => []),
      setCustomFolders: jest.fn(),
      saveCustomFolders: jest.fn(),
      scanDirectory: jest.fn(),
      getServiceIntegration: jest.fn(() => ({
        analysisHistory: {},
        llamaService: null,
        relationshipIndex: null,
        settingsService: { load: jest.fn(async () => ({})) }
      }))
    });
    return { handler: ipcMain._handlers.get(IPC_CHANNELS.EMBEDDINGS.SEARCH) };
  }

  const makeEvent = () => ({ sender: { id: 1, getURL: () => 'file:///' } });
  const envelope = (requestId) => ({ __stratosortIpcMeta: { requestId } });

  test('forwards the IPC abort signal into hybridSearch', async () => {
    const { handler } = register();
    const svc = require('../src/main/services/SearchService').__svc;
    let seenSignal;
    svc.hybridSearch.mockImplementation(async (_q, opts) => {
      seenSignal = opts.signal;
      return { success: true, results: [], mode: 'bm25', meta: {} };
    });

    const res = await handler(
      makeEvent(),
      { query: 'project report', topK: 5, mode: 'bm25' },
      envelope('rq-search-1')
    );
    expect(res.success).toBe(true);
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal.aborted).toBe(false);
  });

  test('a renderer abort cancels the search quietly without a BM25 fallback', async () => {
    const { handler } = register();
    const svc = require('../src/main/services/SearchService').__svc;
    const abortRegistry = require('../src/main/core/ipcAbortRegistry');

    svc.hybridSearch.mockImplementation(
      (_q, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(abortError()), { once: true });
        })
    );

    const pending = handler(
      makeEvent(),
      { query: 'project report', topK: 5, mode: 'bm25' },
      envelope('rq-search-2')
    );
    await new Promise((r) => setImmediate(r));
    expect(abortRegistry.abort('rq-search-2', 'search-superseded')).toBe(true);

    const res = await pending;
    expect(res).toEqual(
      expect.objectContaining({ success: false, cancelled: true, error: 'Search cancelled' })
    );
    expect(svc.hybridSearch).toHaveBeenCalledTimes(1);
    expect(handlerLogger.error).not.toHaveBeenCalled();
  });

  test('a failed result after abort does not trigger the BM25 retry', async () => {
    const { handler } = register();
    const svc = require('../src/main/services/SearchService').__svc;
    const abortRegistry = require('../src/main/core/ipcAbortRegistry');

    svc.hybridSearch.mockImplementation(async () => {
      abortRegistry.abort('rq-search-3', 'search-superseded');
      return { success: false, error: 'vector failed' };
    });

    const res = await handler(
      makeEvent(),
      { query: 'project report', topK: 5, mode: 'hybrid' },
      envelope('rq-search-3')
    );
    expect(res).toEqual(expect.objectContaining({ success: false, cancelled: true }));
    expect(svc.hybridSearch).toHaveBeenCalledTimes(1);
  });

  test('without an envelope the handler behaves as before', async () => {
    const { handler } = register();
    const svc = require('../src/main/services/SearchService').__svc;
    svc.hybridSearch.mockResolvedValue({ success: true, results: [], mode: 'bm25', meta: {} });

    const res = await handler(null, { query: 'project report', topK: 5, mode: 'bm25' });
    expect(res.success).toBe(true);
    expect(svc.hybridSearch.mock.calls[0][1].signal).toBeUndefined();
  });
});
