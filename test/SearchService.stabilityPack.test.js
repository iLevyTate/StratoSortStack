/**
 * Search stability regression pack
 *
 * Covers deterministic behavior for:
 * - result caching/in-flight de-dupe
 * - hybrid fallback semantics
 * - rerank + graph expansion defaults
 */

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const { EventEmitter } = require('events');
const { SearchService } = require('../src/main/services/SearchService');

function createService(overrides = {}) {
  const vectorDbService = Object.assign(new EventEmitter(), {
    initialize: jest.fn().mockResolvedValue(true),
    getStats: jest.fn().mockResolvedValue({ files: 0, fileChunks: 0, folders: 0 }),
    getChunksForFile: jest.fn().mockResolvedValue([]),
    peekFiles: jest.fn().mockResolvedValue({ ids: [], embeddings: [], metadatas: [] }),
    getFile: jest.fn().mockResolvedValue(null),
    getVectorHealth: jest.fn().mockReturnValue({ primaryHealthy: true, indexHealthy: true }),
    ...overrides.vectorDbService
  });

  const analysisHistoryService = {
    initialize: jest.fn().mockResolvedValue(undefined),
    analysisHistory: { metadata: { totalEntries: 0 }, entries: {} },
    ...overrides.analysisHistoryService
  };

  const parallelEmbeddingService = {
    embedText: jest.fn().mockResolvedValue({ vector: [0.2, 0.3, 0.4], model: 'test' }),
    ...overrides.parallelEmbeddingService
  };

  const service = new SearchService({
    vectorDbService,
    analysisHistoryService,
    parallelEmbeddingService,
    queryProcessor: null,
    reRankerService: null,
    relationshipIndexService: null
  });

  service._queryProcessorInitialized = true;
  service.queryProcessor = null;
  service._reRankerInitialized = true;
  service.reRanker = null;
  service.isIndexStale = jest.fn(() => false);
  service._enrichResults = jest.fn();
  service.enrichResults = jest.fn();

  return service;
}

describe('SearchService stability pack', () => {
  test('reuses cached result for identical hybrid query', async () => {
    const service = createService();
    service.bm25Search = jest
      .fn()
      .mockResolvedValue([
        { id: 'file:1', score: 0.9, metadata: { path: '/a' }, matchDetails: {} }
      ]);
    service._buildQueryEmbeddingWithTimeout = jest.fn().mockResolvedValue({
      embedding: { vector: [0.1, 0.2, 0.3] },
      timedOut: false
    });
    service._vectorSearchWithTimeout = jest.fn().mockResolvedValue({
      timedOut: false,
      results: [{ id: 'file:1', score: 0.85, metadata: { path: '/a' }, matchDetails: {} }]
    });
    service.chunkSearch = jest.fn().mockResolvedValue([]);
    service._applyGraphExpansion = jest.fn(async (results) => ({
      results,
      meta: { enabled: false, expanded: false }
    }));
    service._validateFileExistence = jest.fn(async (results) => ({
      validResults: results,
      ghostCount: 0
    }));

    const first = await service.hybridSearch('project update notes', { mode: 'hybrid', topK: 5 });
    const second = await service.hybridSearch('project update notes', { mode: 'hybrid', topK: 5 });

    expect(service.bm25Search).toHaveBeenCalledTimes(1);
    expect(service._vectorSearchWithTimeout).toHaveBeenCalledTimes(1);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.results).toEqual(first.results);
    // Cached response should be cloned, not the same object instance
    expect(second.results).not.toBe(first.results);
  });

  test('invalidates cached hybrid results when vector data mutates', async () => {
    const service = createService();
    service.bm25Search = jest
      .fn()
      .mockResolvedValue([
        { id: 'file:1', score: 0.9, metadata: { path: '/a' }, matchDetails: {} }
      ]);
    service._buildQueryEmbeddingWithTimeout = jest.fn().mockResolvedValue({
      embedding: { vector: [0.1, 0.2, 0.3] },
      timedOut: false
    });
    service._vectorSearchWithTimeout = jest.fn().mockResolvedValue({
      timedOut: false,
      results: [{ id: 'file:1', score: 0.85, metadata: { path: '/a' }, matchDetails: {} }]
    });
    service.chunkSearch = jest.fn().mockResolvedValue([]);
    service._applyGraphExpansion = jest.fn(async (results) => ({
      results,
      meta: { enabled: false, expanded: false }
    }));
    service._validateFileExistence = jest.fn(async (results) => ({
      validResults: results,
      ghostCount: 0
    }));

    await service.hybridSearch('project update notes', { mode: 'hybrid', topK: 5 });
    service.vectorDb.emit('search-data-mutated', { reason: 'files:upsert' });
    await service.hybridSearch('project update notes', { mode: 'hybrid', topK: 5 });

    expect(service.bm25Search).toHaveBeenCalledTimes(2);
    expect(service._vectorSearchWithTimeout).toHaveBeenCalledTimes(2);
  });

  test('does not reuse stale in-flight search after vector data mutates', async () => {
    const service = createService();
    let resolveFirstSearch;
    service._executeHybridSearchInternal = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveFirstSearch = resolve;
        })
    );

    const firstSearch = service.hybridSearch('project update notes', { mode: 'hybrid', topK: 5 });
    await Promise.resolve();

    service.vectorDb.emit('search-data-mutated', { reason: 'files:upsert' });

    const secondResult = {
      success: true,
      results: [{ id: 'fresh', score: 0.9, metadata: { path: '/fresh' } }],
      mode: 'hybrid',
      meta: {}
    };
    service._executeHybridSearchInternal.mockResolvedValueOnce(secondResult);

    const secondSearch = service.hybridSearch('project update notes', { mode: 'hybrid', topK: 5 });

    resolveFirstSearch({
      success: true,
      results: [{ id: 'stale', score: 0.5, metadata: { path: '/stale' } }],
      mode: 'hybrid',
      meta: {}
    });

    await expect(secondSearch).resolves.toEqual(secondResult);
    expect(service._executeHybridSearchInternal).toHaveBeenCalledTimes(2);
    await firstSearch;
  });

  test('older in-flight cleanup does not remove newer in-flight entry', async () => {
    const service = createService();
    let resolveFirstSearch;
    let resolveSecondSearch;
    service._executeHybridSearchInternal = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstSearch = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecondSearch = resolve;
          })
      );

    const firstSearch = service.hybridSearch('project update notes', { mode: 'hybrid', topK: 5 });
    await Promise.resolve();
    service.vectorDb.emit('search-data-mutated', { reason: 'files:upsert' });

    const secondSearch = service.hybridSearch('project update notes', { mode: 'hybrid', topK: 5 });
    await Promise.resolve();

    resolveFirstSearch({ success: true, results: [], mode: 'hybrid', meta: {} });
    await firstSearch;

    const thirdSearch = service.hybridSearch('project update notes', { mode: 'hybrid', topK: 5 });
    expect(service._executeHybridSearchInternal).toHaveBeenCalledTimes(2);

    resolveSecondSearch({ success: true, results: [], mode: 'hybrid', meta: {} });
    await expect(secondSearch).resolves.toEqual(expect.objectContaining({ success: true }));
    await expect(thirdSearch).resolves.toEqual(expect.objectContaining({ success: true }));
  });

  test('uses deterministic BM25 fallback when query embedding is unavailable', async () => {
    const service = createService();

    service.bm25Search = jest
      .fn()
      .mockResolvedValue([
        { id: 'doc-a', score: 0.88, metadata: { path: '/docs/a.txt' }, matchDetails: {} }
      ]);
    service._buildQueryEmbeddingWithTimeout = jest.fn().mockResolvedValue({
      embedding: null,
      timedOut: true,
      error: 'query embedding timeout'
    });
    service._validateFileExistence = jest.fn(async (results) => ({
      validResults: results,
      ghostCount: 0
    }));

    const result = await service.hybridSearch('financial planning report', {
      mode: 'hybrid',
      topK: 5,
      minScore: 0
    });

    expect(result.success).toBe(true);
    expect(result.mode).toBe('bm25-fallback');
    expect(result.meta).toEqual(
      expect.objectContaining({
        fallback: true,
        fallbackReason: 'query embedding timeout',
        vectorTimedOut: true
      })
    );
    expect(result.meta.warnings?.[0]?.type).toBe('QUERY_EMBEDDING_UNAVAILABLE');
  });

  test('applies stable defaults for rerank and graph expansion', async () => {
    const service = createService();
    service._executeHybridSearchInternal = jest.fn().mockResolvedValue({
      success: true,
      results: [],
      mode: 'hybrid',
      meta: {}
    });

    await service.hybridSearch('architecture proposal', { mode: 'hybrid', topK: 3 });

    expect(service._executeHybridSearchInternal).toHaveBeenCalledTimes(1);
    const call = service._executeHybridSearchInternal.mock.calls[0];
    const options = call[3];
    expect(options.rerank).toBe(false);
    expect(options.graphExpansion).toBe(false);
  });

  test('passes graph expansion flag through hybrid pipeline deterministically', async () => {
    const service = createService();

    service.bm25Search = jest
      .fn()
      .mockResolvedValue([
        { id: 'doc-bm25', score: 0.75, metadata: { path: '/a' }, matchDetails: {} }
      ]);
    service._buildQueryEmbeddingWithTimeout = jest.fn().mockResolvedValue({
      embedding: { vector: [0.1, 0.2, 0.3] },
      timedOut: false
    });
    service._vectorSearchWithTimeout = jest.fn().mockResolvedValue({
      timedOut: false,
      results: [{ id: 'doc-vec', score: 0.82, metadata: { path: '/b' }, matchDetails: {} }]
    });
    service.chunkSearch = jest.fn().mockResolvedValue([]);
    service._applyGraphExpansion = jest.fn(async (results, opts) => ({
      results,
      meta: { enabled: Boolean(opts.graphExpansion), expanded: false }
    }));
    service._validateFileExistence = jest.fn(async (results) => ({
      validResults: results,
      ghostCount: 0
    }));

    const result = await service.hybridSearch('quarterly plan', {
      mode: 'hybrid',
      topK: 5,
      chunkWeight: 0,
      minScore: 0
    });

    expect(service._applyGraphExpansion).toHaveBeenCalled();
    const graphOptions = service._applyGraphExpansion.mock.calls[0][1];
    expect(graphOptions.graphExpansion).toBe(false);
    expect(result.success).toBe(true);
    expect(result.meta?.graphExpansion?.enabled).toBe(false);
  });
});
