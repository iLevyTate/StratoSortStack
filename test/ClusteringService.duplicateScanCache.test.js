/**
 * The duplicate scan behind the graph tab's badge compares every vector with
 * every other one. It is re-asked whenever the index stats tick, so:
 *  - an unchanged index must get the previous answer without the comparison,
 *  - any change to the vectors, metadata, options or a store write must not,
 *  - the comparison must hand the event loop back so abort and IPC get in.
 */
const { EventEmitter } = require('events');

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

jest.mock('../src/main/llamaUtils', () => ({
  getTextModel: jest.fn(() => 'qwen3:0.6b')
}));

const mockCosine = jest.fn();
jest.mock('../src/shared/vectorMath', () => {
  const actual = jest.requireActual('../src/shared/vectorMath');
  return {
    ...actual,
    cosineSimilarity: (...args) => {
      mockCosine();
      return actual.cosineSimilarity(...args);
    }
  };
});

const { ClusteringService } = require('../src/main/services/ClusteringService');

const vec = (seed) => new Array(16).fill(0).map((_, i) => Math.cos(i / 10 + seed));

function makePeek() {
  const a = vec(0);
  return {
    ids: ['f1', 'f2', 'f3', 'f4'],
    embeddings: [a, a.map((v) => v + 0.0005), vec(0.3), vec(5)],
    metadatas: [
      { path: '/a.pdf', fileHash: 'h1' },
      { path: '/b.pdf', fileHash: 'h2' },
      { path: '/c.pdf', fileHash: 'h3' },
      { path: '/d.pdf', fileHash: 'h4' }
    ]
  };
}

function makeService(peek = makePeek()) {
  const vectorDb = Object.assign(new EventEmitter(), {
    initialize: jest.fn().mockResolvedValue(undefined),
    getStats: jest.fn(async () => ({ files: peek.ids.length })),
    peekFiles: jest.fn(async () => peek)
  });
  const service = new ClusteringService({ vectorDbService: vectorDb, llamaService: null });
  return { service, vectorDb, peek };
}

describe('findNearDuplicates result reuse', () => {
  beforeEach(() => {
    mockCosine.mockClear();
  });

  test('an unchanged index returns the same answer without comparing again', async () => {
    const { service } = makeService();
    const first = await service.findNearDuplicates({ threshold: 0.9, maxResults: 20 });
    const comparisons = mockCosine.mock.calls.length;
    expect(comparisons).toBeGreaterThan(0);

    const second = await service.findNearDuplicates({ threshold: 0.9, maxResults: 20 });
    expect(mockCosine.mock.calls.length).toBe(comparisons);
    expect(second).toEqual(first);
    expect(second.totalDuplicates).toBeGreaterThan(0);
  });

  test('a caller editing the returned members does not change the next answer', async () => {
    const { service } = makeService();
    const first = await service.findNearDuplicates({ threshold: 0.9 });
    const pristine = JSON.parse(JSON.stringify(first));
    first.groups[0].members[0].size = 12345;

    const second = await service.findNearDuplicates({ threshold: 0.9 });
    expect(second).toEqual(pristine);
    expect(second.groups[0].members[0].size).toBeUndefined();
  });

  test('different options, a new vector, or changed metadata scan again', async () => {
    const { service, peek } = makeService();
    await service.findNearDuplicates({ threshold: 0.9, maxResults: 20 });
    let count = mockCosine.mock.calls.length;

    await service.findNearDuplicates({ threshold: 0.9, maxResults: 5 });
    expect(mockCosine.mock.calls.length).toBeGreaterThan(count);
    count = mockCosine.mock.calls.length;

    peek.embeddings[3] = vec(0.0001);
    const afterVector = await service.findNearDuplicates({ threshold: 0.9, maxResults: 5 });
    expect(mockCosine.mock.calls.length).toBeGreaterThan(count);
    count = mockCosine.mock.calls.length;

    peek.metadatas[0] = { ...peek.metadatas[0], fileHash: 'h2' };
    peek.metadatas[1] = { ...peek.metadatas[1], fileHash: 'h2' };
    const afterHash = await service.findNearDuplicates({ threshold: 0.9, maxResults: 5 });
    expect(mockCosine.mock.calls.length).toBeGreaterThan(count);
    expect(afterHash.tiers.exact).toHaveLength(1);
    expect(afterHash).not.toEqual(afterVector);
  });

  test('a write to the vector store forces a fresh scan', async () => {
    const { service, vectorDb } = makeService();
    await service.findNearDuplicates({ threshold: 0.9 });
    const count = mockCosine.mock.calls.length;

    vectorDb.emit('search-data-mutated', { collection: 'files', operation: 'upsert' });
    await service.findNearDuplicates({ threshold: 0.9 });
    expect(mockCosine.mock.calls.length).toBeGreaterThan(count);
  });

  test('cleanup stops listening to the vector store', () => {
    const { service, vectorDb } = makeService();
    expect(vectorDb.listenerCount('search-data-mutated')).toBe(1);
    service.cleanup();
    expect(vectorDb.listenerCount('search-data-mutated')).toBe(0);
  });
});

describe('findNearDuplicates yields while comparing', () => {
  // 300 distinct vectors → 44,850 pairs, enough to cross the yield cadence.
  function bigPeek() {
    const ids = [];
    const embeddings = [];
    const metadatas = [];
    for (let i = 0; i < 300; i++) {
      ids.push(`f${i}`);
      embeddings.push(new Array(16).fill(0).map((_, d) => Math.sin(i * 7.3 + d * 1.1)));
      metadatas.push({ path: `/f${i}.pdf` });
    }
    return { ids, embeddings, metadatas };
  }

  test('other work runs before the comparison finishes', async () => {
    const { service } = makeService(bigPeek());
    let latest = null;
    let seenByOtherWork = 'not-run';
    setImmediate(() => {
      seenByOtherWork = latest;
    });

    const result = await service.findNearDuplicates({
      threshold: 0.9,
      onProgress: (p) => {
        latest = p;
      }
    });

    expect(result.success).toBe(true);
    expect(seenByOtherWork).not.toBe('not-run');
    expect(seenByOtherWork?.done).not.toBe(true);
  });

  test('an abort raised mid-scan stops it before the comparison completes', async () => {
    const { service } = makeService(bigPeek());
    const controller = new AbortController();
    const progress = [];
    setImmediate(() => controller.abort());

    const result = await service.findNearDuplicates({
      threshold: 0.9,
      signal: controller.signal,
      onProgress: (p) => progress.push(p)
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/aborted/);
    expect(progress.some((p) => p.done === true)).toBe(false);
  });
});
