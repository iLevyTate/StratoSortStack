/**
 * SearchService.hybridSearch({ signal }): a superseded search must stop at the
 * next stage boundary instead of running embedding / vector query / rerank to
 * completion ahead of the live query. An aborted search rejects with an
 * AbortError, is not logged as an error, takes no BM25 fallback, and is never
 * cached as a result.
 */

jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };
  return { createLogger: () => logger, __logger: logger };
});

jest.mock('fs', () => ({
  promises: {
    access: jest.fn().mockResolvedValue(undefined)
  }
}));

const { __logger: mockLogger } = require('../src/shared/logger');
const { SearchService } = require('../src/main/services/SearchService');

const DIM = 768;
const QUERY = 'quarterly report';

function deferred() {
  /** @type {(v: any) => void} */
  let resolve = () => {};
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise((r) => setImmediate(r));

function vectorHit(id) {
  return { id, score: 0.9, metadata: { name: `${id}.pdf`, path: `/docs/${id}.pdf` } };
}

function makeService({ reRanker = null } = {}) {
  const vectorDbService = {
    initialize: jest.fn().mockResolvedValue(true),
    isOnline: true,
    getStats: jest.fn().mockResolvedValue({ files: 2, fileChunks: 0, folders: 0 }),
    getCollectionDimension: jest.fn().mockResolvedValue(DIM),
    querySimilarFiles: jest.fn().mockResolvedValue([vectorHit('a'), vectorHit('b')]),
    querySimilarChunks: jest.fn().mockResolvedValue([]),
    getChunksForFile: jest.fn().mockResolvedValue([]),
    peekFiles: jest.fn().mockResolvedValue({ ids: [], embeddings: [], metadatas: [] }),
    getFile: jest.fn().mockResolvedValue(null)
  };

  const embedding = {
    embedText: jest.fn().mockResolvedValue({ vector: new Array(DIM).fill(0.1) })
  };

  const service = new SearchService({
    vectorDbService,
    analysisHistoryService: {
      initialize: jest.fn().mockResolvedValue(undefined),
      analysisHistory: { metadata: { totalEntries: 0 }, entries: {} }
    },
    parallelEmbeddingService: embedding,
    reRankerService: reRanker,
    queryProcessor: null,
    relationshipIndexService: null
  });

  service._validateFileExistence = jest.fn(async (results) => ({
    validResults: results,
    ghostCount: 0
  }));
  service.isIndexStale = jest.fn(() => false);
  service.enrichResults = jest.fn();
  service.bm25Search = jest.fn().mockResolvedValue([]);

  return { service, embedding, vectorDbService };
}

describe('SearchService.hybridSearch abort signal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('a pre-aborted signal stops before embedding and vector query', async () => {
    const { service, embedding, vectorDbService } = makeService();
    const ac = new AbortController();
    ac.abort();

    await expect(
      service.hybridSearch(QUERY, { mode: 'hybrid', topK: 5, signal: ac.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(embedding.embedText).not.toHaveBeenCalled();
    expect(vectorDbService.querySimilarFiles).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  test('a successful signalled search still returns results', async () => {
    const { service } = makeService();
    const ac = new AbortController();

    const result = await service.hybridSearch(QUERY, {
      mode: 'hybrid',
      topK: 5,
      signal: ac.signal
    });
    expect(result.success).toBe(true);
    expect(result.results.map((r) => r.id)).toEqual(['a', 'b']);
  });

  test('the query embedding receives a signal that fires when the caller aborts', async () => {
    const { service, embedding } = makeService();
    const pendingEmbed = deferred();
    /** @type {AbortSignal | undefined} */
    let embedSignal;
    embedding.embedText.mockImplementationOnce((_text, opts) => {
      embedSignal = opts?.signal;
      return pendingEmbed.promise;
    });
    const ac = new AbortController();

    const p = service.hybridSearch(QUERY, { mode: 'hybrid', topK: 5, signal: ac.signal });
    await flush();
    expect(embedSignal).toBeInstanceOf(AbortSignal);
    expect(embedSignal.aborted).toBe(false);

    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(embedSignal.aborted).toBe(true);
    pendingEmbed.resolve({ vector: new Array(DIM).fill(0.1) });
  });

  test('aborting while the query embedding is queued rejects promptly and skips the vector query', async () => {
    const { service, embedding, vectorDbService } = makeService();
    const pendingEmbed = deferred();
    embedding.embedText.mockReturnValueOnce(pendingEmbed.promise);
    const ac = new AbortController();

    const p = service.hybridSearch(QUERY, { mode: 'hybrid', topK: 5, signal: ac.signal });
    await flush();
    expect(embedding.embedText).toHaveBeenCalledTimes(1);

    ac.abort();
    // Rejects without waiting for the (stale) embedding to finish.
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });

    pendingEmbed.resolve({ vector: new Array(DIM).fill(0.1) });
    await flush();
    expect(vectorDbService.querySimilarFiles).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
    // No BM25 fallback for a cancelled search (only the initial parallel leg).
    expect(service.bm25Search).toHaveBeenCalledTimes(1);
  });

  test('an abort that lands after the embedding finishes skips the vector query', async () => {
    const { service, embedding, vectorDbService } = makeService();
    const ac = new AbortController();
    embedding.embedText.mockImplementationOnce(async () => {
      ac.abort();
      return { vector: new Array(DIM).fill(0.1) };
    });

    await expect(
      service.hybridSearch(QUERY, { mode: 'hybrid', topK: 5, signal: ac.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(vectorDbService.querySimilarFiles).not.toHaveBeenCalled();
  });

  test('an abort during the vector query is not cached and does not fall back to BM25', async () => {
    const { service, embedding, vectorDbService } = makeService();
    const ac = new AbortController();
    vectorDbService.querySimilarFiles.mockImplementationOnce(async () => {
      ac.abort();
      return [vectorHit('a')];
    });

    await expect(
      service.hybridSearch(QUERY, { mode: 'hybrid', topK: 5, signal: ac.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(service.bm25Search).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).not.toHaveBeenCalled();

    // Next (live) search for the same query runs for real — nothing cached.
    const live = await service.hybridSearch(QUERY, { mode: 'hybrid', topK: 5 });
    expect(live.success).toBe(true);
    expect(embedding.embedText).toHaveBeenCalledTimes(2);
    expect(live.results.map((r) => r.id)).toEqual(['a', 'b']);
  });

  test('an abort before rerank skips the rerank call', async () => {
    const reRanker = {
      isAvailable: jest.fn(() => true),
      rerank: jest.fn(async (_q, results) => results)
    };
    const { service } = makeService({ reRanker });
    const ac = new AbortController();
    service._validateFileExistence = jest.fn(async (results) => {
      ac.abort();
      return { validResults: results, ghostCount: 0 };
    });

    await expect(
      service.hybridSearch(QUERY, { mode: 'hybrid', topK: 5, rerank: true, signal: ac.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(reRanker.rerank).not.toHaveBeenCalled();
  });

  test('bm25 mode honours an aborted signal too', async () => {
    const { service } = makeService();
    const ac = new AbortController();
    ac.abort();

    await expect(
      service.hybridSearch(QUERY, { mode: 'bm25', topK: 5, signal: ac.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(service.bm25Search).not.toHaveBeenCalled();
  });

  test('a caller joining an in-flight search survives the original caller aborting', async () => {
    const { service, embedding } = makeService();
    const pendingEmbed = deferred();
    embedding.embedText.mockReturnValueOnce(pendingEmbed.promise);
    const ac = new AbortController();

    const aborted = service.hybridSearch(QUERY, { mode: 'hybrid', topK: 5, signal: ac.signal });
    await flush();
    const joiner = service.hybridSearch(QUERY, { mode: 'hybrid', topK: 5 });
    await flush();

    ac.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    pendingEmbed.resolve({ vector: new Array(DIM).fill(0.1) });

    const result = await joiner;
    expect(result.success).toBe(true);
    expect(result.results.map((r) => r.id)).toEqual(['a', 'b']);
  });

  test('an aborted joiner rejects without cancelling the shared search', async () => {
    const { service, embedding } = makeService();
    const pendingEmbed = deferred();
    embedding.embedText.mockReturnValueOnce(pendingEmbed.promise);

    const owner = service.hybridSearch(QUERY, { mode: 'hybrid', topK: 5 });
    await flush();
    const ac = new AbortController();
    const joiner = service.hybridSearch(QUERY, { mode: 'hybrid', topK: 5, signal: ac.signal });
    await flush();

    ac.abort();
    await expect(joiner).rejects.toMatchObject({ name: 'AbortError' });
    pendingEmbed.resolve({ vector: new Array(DIM).fill(0.1) });
    await expect(owner).resolves.toMatchObject({ success: true });
  });
});
