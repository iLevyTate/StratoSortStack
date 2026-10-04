/**
 * Resilience-focused tests for SearchService
 * Focus: vector timeout fallback, reranker failure tolerance, and timer safety.
 */

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('fs', () => ({
  promises: {
    access: jest.fn().mockResolvedValue(undefined)
  }
}));

const { SearchService } = require('../src/main/services/SearchService');

describe('SearchService (resilience)', () => {
  const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const advance = async (ms) => {
    if (typeof jest.advanceTimersByTimeAsync === 'function') {
      await jest.advanceTimersByTimeAsync(ms);
      return;
    }
    jest.advanceTimersByTime(ms);
    await flushMicrotasks();
  };

  function makeService(overrides = {}) {
    const vectorDbService = {
      initialize: jest.fn().mockResolvedValue(true),
      isOnline: true,
      getStats: jest.fn().mockResolvedValue({ files: 0, fileChunks: 0, folders: 0 }),
      getChunksForFile: jest.fn().mockResolvedValue([]),
      peekFiles: jest.fn().mockResolvedValue({ ids: [], embeddings: [], metadatas: [] }),
      getFile: jest.fn().mockResolvedValue(null),
      batchDeleteFileEmbeddings: jest.fn().mockResolvedValue(undefined),
      ...overrides.vectorDbService
    };

    const history = {
      initialize: jest.fn().mockResolvedValue(undefined),
      analysisHistory: { metadata: { totalEntries: 0 }, entries: {} },
      ...overrides.analysisHistoryService
    };

    const embedding = {
      embedText: jest.fn().mockResolvedValue({ vector: [0.1, 0.2, 0.3] }),
      ...overrides.parallelEmbeddingService
    };

    const service = new SearchService({
      vectorDbService,
      analysisHistoryService: history,
      parallelEmbeddingService: embedding,
      reRankerService: overrides.reRankerService || null,
      queryProcessor: null,
      relationshipIndexService: null
    });

    // Avoid side enrichment dependencies in these tests
    service._enrichResults = jest.fn();
    service._applyGraphExpansion = jest.fn(async (results) => ({
      results,
      meta: { enabled: false }
    }));
    service._validateFileExistence = jest.fn(async (results) => ({
      validResults: results,
      ghostCount: 0
    }));
    service.isIndexStale = jest.fn(() => false);
    service.buildBM25Index = jest.fn().mockResolvedValue({ success: true, indexed: 0 });
    service.chunkSearch = jest.fn().mockResolvedValue([]);

    // prevent query processor creation attempts
    service._queryProcessorInitialized = true;
    service.queryProcessor = null;

    return { service, vectorDbService };
  }

  test('_vectorSearchWithTimeout returns timedOut=true when vectorSearch hangs', async () => {
    jest.useFakeTimers();
    const { service } = makeService();
    service.vectorSearch = jest.fn(() => new Promise(() => {}));

    const p = service._vectorSearchWithTimeout('hello', 5, 50);
    const assertion = expect(p).resolves.toEqual({ results: [], timedOut: true });

    await flushMicrotasks();
    await advance(60);
    await assertion;

    jest.useRealTimers();
  });

  test('_vectorSearchWithTimeout returns empty results with error when vectorSearch rejects', async () => {
    const { service } = makeService();
    service.vectorSearch = jest.fn().mockRejectedValue(new Error('db fail'));

    await expect(service._vectorSearchWithTimeout('hello', 5, 50)).resolves.toEqual(
      expect.objectContaining({ results: [], timedOut: false, error: 'db fail' })
    );
  });

  test('hybridSearch falls back to BM25-only when vector search times out', async () => {
    const { service } = makeService();

    service.bm25Search = jest
      .fn()
      .mockResolvedValue([
        { id: 'a', score: 0.9, metadata: { path: 'C:\\a.txt' }, matchDetails: {} }
      ]);
    service._vectorSearchWithTimeout = jest.fn().mockResolvedValue({ results: [], timedOut: true });

    const res = await service.hybridSearch('hello', {
      topK: 5,
      minScore: 0,
      mode: 'hybrid',
      chunkWeight: 0
    });
    expect(res.success).toBe(true);
    expect(res.mode).toBe('bm25-fallback');
    expect(res.meta).toEqual(expect.objectContaining({ vectorTimedOut: true, fallback: true }));
    expect(service._validateFileExistence).toHaveBeenCalled();
  });

  test('hybridSearch validates BM25 fallback when query embedding is unavailable', async () => {
    const { service } = makeService();

    service.bm25Search = jest
      .fn()
      .mockResolvedValue([
        { id: 'a', score: 0.9, metadata: { path: 'C:\\a.txt' }, matchDetails: {} }
      ]);
    service._buildQueryEmbeddingWithTimeout = jest.fn().mockResolvedValue({
      embedding: null,
      timedOut: false,
      error: 'embedding unavailable'
    });

    const res = await service.hybridSearch('hello', {
      topK: 5,
      minScore: 0,
      mode: 'hybrid',
      chunkWeight: 0
    });

    expect(res.success).toBe(true);
    expect(res.mode).toBe('bm25-fallback');
    expect(service._validateFileExistence).toHaveBeenCalled();
  });

  test('hybridSearch degrades to bm25-fallback when the vector leg hard-errors (parity with timeout)', async () => {
    // Regression: a thrown vector error used to be swallowed to [] while
    // fusion continued as mode 'hybrid', capping combined scores at the BM25
    // weight so hits below normalized ~0.6 fell under minScore and vanished.
    // A vector-leg ERROR must degrade identically to a vector-leg TIMEOUT.
    const { service } = makeService();

    service.bm25Search = jest.fn().mockResolvedValue([
      { id: 'a', score: 0.9, metadata: { path: 'C:\\a.txt' }, matchDetails: {} },
      { id: 'b', score: 0.4, metadata: { path: 'C:\\b.txt' }, matchDetails: {} }
    ]);
    // Real _vectorSearchWithTimeout, underlying vectorSearch throws.
    service.vectorSearch = jest.fn().mockRejectedValue(new Error('orama query failed'));

    const res = await service.hybridSearch('hello', {
      topK: 5,
      minScore: 0.15,
      mode: 'hybrid',
      chunkWeight: 0
    });

    expect(res.success).toBe(true);
    expect(res.mode).toBe('bm25-fallback');
    expect(res.meta).toEqual(
      expect.objectContaining({
        fallback: true,
        vectorTimedOut: false,
        vectorError: 'orama query failed',
        fallbackReason: expect.stringContaining('orama query failed')
      })
    );
    // Both BM25 hits survive at their raw scores instead of being crushed
    // under the hybrid BM25 weight and dropped by minScore.
    expect(res.results.map((r) => r.id)).toEqual(['a', 'b']);
  });

  // F-207 (K-26): an EMPTY vector leg (nothing embedded yet, or an index that
  // shrank to a handful of rows) is not an error, so it never triggered the
  // fallback — fusion ran anyway and every BM25 hit was crushed under the
  // BM25 weight and dropped by minScore. Search "returned nothing" for files
  // that were right there in the keyword index.
  test('hybridSearch degrades to bm25-fallback when the vector leg is empty but BM25 has hits', async () => {
    const { service } = makeService();

    service.bm25Search = jest.fn().mockResolvedValue([
      { id: 'a', score: 0.9, metadata: { path: 'C:\\a.txt' }, matchDetails: {} },
      { id: 'b', score: 0.4, metadata: { path: 'C:\\b.txt' }, matchDetails: {} }
    ]);
    service.vectorSearch = jest.fn().mockResolvedValue([]);

    const res = await service.hybridSearch('hello', {
      topK: 5,
      minScore: 0.15,
      mode: 'hybrid',
      chunkWeight: 0
    });

    expect(res.success).toBe(true);
    expect(res.mode).toBe('bm25-fallback');
    expect(res.meta).toEqual(
      expect.objectContaining({ fallback: true, fallbackReason: expect.stringMatching(/empty/i) })
    );
    expect(res.results.map((r) => r.id)).toEqual(['a', 'b']);
  });

  test('vectorSearch rethrows to the caller when propagateErrors is set (hybrid), swallows otherwise', async () => {
    const { service, vectorDbService } = makeService();
    vectorDbService.querySimilarFiles = jest.fn().mockRejectedValue(new Error('index corrupt'));
    service._normalizeQueryVector = jest.fn().mockResolvedValue([0.1, 0.2, 0.3]);

    // Default path (e.g. mode:'vector'): error swallowed to [] as before.
    await expect(service.vectorSearch('hello', 5)).resolves.toEqual([]);

    // Hybrid's timeout wrapper opts into propagation so the error reaches
    // the bm25-fallback branch instead of fusing an empty vector leg.
    await expect(service.vectorSearch('hello', 5, { propagateErrors: true })).rejects.toThrow(
      'index corrupt'
    );
  });

  test('hybridSearch tolerates reranker failure and still returns results', async () => {
    const reRanker = {
      isAvailable: () => true,
      rerank: jest.fn().mockRejectedValue(new Error('rerank broke'))
    };

    const { service } = makeService({
      reRankerService: reRanker
    });

    // Force reranker to be used
    service._getReRanker = jest.fn(() => reRanker);

    service.bm25Search = jest.fn().mockResolvedValue([
      { id: 'a', score: 0.1, metadata: { path: 'C:\\a.txt' }, matchDetails: {} },
      { id: 'b', score: 0.05, metadata: { path: 'C:\\b.txt' }, matchDetails: {} }
    ]);
    service._vectorSearchWithTimeout = jest.fn().mockResolvedValue({
      timedOut: false,
      results: [
        { id: 'a', score: 0.9, metadata: { path: 'C:\\a.txt' }, matchDetails: {} },
        { id: 'b', score: 0.8, metadata: { path: 'C:\\b.txt' }, matchDetails: {} }
      ]
    });

    const res = await service.hybridSearch('hello', {
      topK: 5,
      minScore: 0,
      mode: 'hybrid',
      rerank: true,
      rerankTopN: 5,
      chunkWeight: 0
    });

    expect(res.success).toBe(true);
    // rerank failure means mode stays hybrid (not hybrid-reranked)
    expect(res.mode).toBe('hybrid');
    expect(reRanker.rerank).toHaveBeenCalled();
    expect(res.results.length).toBeGreaterThanOrEqual(2);
  });

  // F-187 (K-10): a stale path must MARK the entry orphaned, never delete it.
  // Search already filters `isOrphaned: false`, so the row drops out of
  // results, but the vector survives a moved/unmounted/transiently-missing
  // file and can be restored by the next successful re-index.
  test('_validateFileExistence filters out ghost entries and marks them orphaned (never deletes)', async () => {
    const fs = require('fs').promises;
    const { service, vectorDbService } = makeService();
    // Restore real implementation (makeService stubs this by default)
    service._validateFileExistence = SearchService.prototype._validateFileExistence.bind(service);

    // Clear default mock to avoid prior state leaking
    fs.access.mockReset();

    // One file exists, one does not
    const enoentError = new Error('ENOENT: no such file or directory');
    enoentError.code = 'ENOENT';
    fs.access.mockResolvedValueOnce(undefined).mockRejectedValueOnce(enoentError);

    vectorDbService.markEmbeddingsOrphaned = jest.fn().mockResolvedValue({ marked: 1, failed: 0 });
    vectorDbService.batchDeleteFileEmbeddings = jest.fn().mockResolvedValue(undefined);
    vectorDbService.markEmbeddingsOrphaned = jest.fn().mockResolvedValue({ marked: 1, failed: 0 });
    service.vectorDb = vectorDbService;

    const results = [
      { id: 'file:ok', metadata: { path: 'C:\\ok.txt' }, score: 1 },
      { id: 'file:ghost', metadata: { path: 'C:\\ghost.txt' }, score: 0.9 }
    ];

    const { validResults, ghostCount } = await service._validateFileExistence(results, {
      triggerCleanup: true
    });

    expect(ghostCount).toBe(1);
    expect(validResults.map((r) => r.id)).toEqual(['file:ok']);

    // cleanup runs in setImmediate; flush it
    await new Promise((r) => setImmediate(r));
    expect(vectorDbService.markEmbeddingsOrphaned).toHaveBeenCalledWith(['file:ghost']);
    expect(vectorDbService.batchDeleteFileEmbeddings).not.toHaveBeenCalled();
  });

  test('hybridSearch falls back to BM25-only when hybrid throws (hard failure fallback)', async () => {
    const { service } = makeService();

    service.bm25Search = jest
      .fn()
      .mockResolvedValue([
        { id: 'a', score: 0.9, metadata: { path: 'C:\\a.txt' }, matchDetails: {} }
      ]);
    // Force an exception in hybrid path
    service._vectorSearchWithTimeout = jest.fn().mockRejectedValue(new Error('vector exploded'));

    const res = await service.hybridSearch('hello', { topK: 5, minScore: 0, mode: 'hybrid' });
    expect(res.success).toBe(true);
    expect(res.mode).toBe('bm25-fallback');
    expect(res.meta).toEqual(
      expect.objectContaining({ fallback: true, fallbackReason: 'hybrid search error' })
    );
  });

  test('validates ghosts before the topK slice so pages are not left short', async () => {
    const { service } = makeService();
    const candidates = [
      { id: 'ghost', score: 0.99, metadata: { path: 'C:\\ghost.txt' }, matchDetails: {} },
      { id: 'keep', score: 0.8, metadata: { path: 'C:\\keep.txt' }, matchDetails: {} }
    ];
    service._filterByScore = jest.fn(() => candidates);
    service._validateFileExistence = jest.fn(async (results) => ({
      validResults: results.filter((r) => r.id !== 'ghost'),
      ghostCount: 1
    }));
    service._applyGraphExpansion = jest.fn(async (results) => ({
      results,
      meta: { enabled: false, expanded: false }
    }));
    service.bm25Search = jest.fn().mockResolvedValue(candidates);
    service._buildQueryEmbeddingWithTimeout = jest.fn().mockResolvedValue({
      embedding: { vector: [0.1] },
      timedOut: false
    });
    service._vectorSearchWithTimeout = jest.fn().mockResolvedValue({
      timedOut: false,
      results: candidates
    });
    service.chunkSearch = jest.fn().mockResolvedValue([]);
    service._getReRanker = jest.fn(() => null);

    const res = await service.hybridSearch('hello', { topK: 1, minScore: 0, mode: 'hybrid' });
    expect(service._validateFileExistence).toHaveBeenCalled();
    const validatedInput = service._validateFileExistence.mock.calls[0][0];
    expect(validatedInput.length).toBeGreaterThan(1);
    expect(res.results).toHaveLength(1);
    expect(res.results[0].id).toBe('keep');
  });

  describe('_validateTopCandidates (L1: bounded existence checks)', () => {
    const makeCandidates = (count, ghostIds = new Set()) =>
      Array.from({ length: count }, (_, i) => ({
        id: `c${i}`,
        score: 1 - i / count,
        metadata: { path: `C:\\c${i}.txt` },
        ghost: ghostIds.has(`c${i}`)
      }));

    test('validates only a topK*2 window when nothing is missing', async () => {
      const { service } = makeService();
      const candidates = makeCandidates(500);

      const results = await service._validateTopCandidates(candidates, 5);

      expect(service._validateFileExistence).toHaveBeenCalledTimes(1);
      expect(service._validateFileExistence.mock.calls[0][0]).toHaveLength(10);
      expect(results.map((r) => r.id)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    });

    test('extends the window while ghosts leave the page short and still fills topK', async () => {
      const { service } = makeService();
      const ghosts = new Set(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
      const candidates = makeCandidates(10, ghosts);
      service._validateFileExistence = jest.fn(async (results) => {
        const validResults = results.filter((r) => !r.ghost);
        return { validResults, ghostCount: results.length - validResults.length };
      });

      const results = await service._validateTopCandidates(candidates, 2);

      expect(service._validateFileExistence.mock.calls.map((c) => c[0].length)).toEqual([4, 4, 2]);
      expect(results.map((r) => r.id)).toEqual(['c8', 'c9']);
    });

    test('returns fewer than topK when the candidates run out and never over-fills', async () => {
      const { service } = makeService();
      const candidates = makeCandidates(3, new Set(['c1']));
      service._validateFileExistence = jest.fn(async (results) => {
        const validResults = results.filter((r) => !r.ghost);
        return { validResults, ghostCount: results.length - validResults.length };
      });

      await expect(service._validateTopCandidates(candidates, 5)).resolves.toHaveLength(2);
      await expect(service._validateTopCandidates(makeCandidates(20), 3)).resolves.toHaveLength(3);
    });

    test('degrades to the unvalidated window when the existence check throws', async () => {
      const { service } = makeService();
      service._validateFileExistence = jest.fn().mockRejectedValue(new Error('fs exploded'));

      const results = await service._validateTopCandidates(makeCandidates(10), 3);

      expect(results.map((r) => r.id)).toEqual(['c0', 'c1', 'c2']);
    });
  });
});
