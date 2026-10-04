/**
 * Regression tests for OramaVectorService._paginatedSearch.
 *
 * Replaces the hard `limit: 10000` scans scattered across orphan cleanup,
 * chunk cascade-delete, getAllFolders, and related paths. Verifies the
 * iteration covers >10k rows, handles partial final pages, supports an
 * `onHit` callback that can stop iteration early, and defends against a
 * mis-behaving backend that returns overlapping pages.
 */

jest.mock('electron', () => ({ app: { getPath: jest.fn() } }));

jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };
  return { createLogger: () => logger };
});

jest.mock('../src/shared/singletonFactory', () => ({
  createSingletonHelpers: () => ({
    getInstance: jest.fn(),
    createInstance: jest.fn(),
    registerWithContainer: jest.fn(),
    resetInstance: jest.fn()
  })
}));

jest.mock('@orama/plugin-data-persistence', () => ({
  persist: jest.fn(async () => '{}'),
  restore: jest.fn(async () => {
    throw new Error('restore not available in test');
  })
}));

jest.mock('../src/main/llamaUtils', () => ({
  getEmbeddingModel: jest.fn(() => 'nomic-embed-text-v1.5-Q8_0.gguf'),
  loadLlamaConfig: jest.fn().mockResolvedValue({
    selectedEmbeddingModel: 'nomic-embed-text-v1.5-Q8_0.gguf'
  })
}));

// Mock @orama/orama.search with a deterministic, offset-driven backend so
// the helper's pagination logic is the sole subject under test. Jest's
// `jest.mock` factory can only reference variables whose names start with
// `mock`, hence the `mockSearch` prefix.
jest.mock('@orama/orama', () => {
  const mockSearch = jest.fn();
  return {
    create: jest.fn(async () => ({})),
    insert: jest.fn(async () => {}),
    search: mockSearch,
    remove: jest.fn(async () => {}),
    update: jest.fn(async () => {}),
    count: jest.fn(async () => 0),
    getByID: jest.fn(async () => null),
    __mockSearch: mockSearch
  };
});

const { OramaVectorService } = require('../src/main/services/OramaVectorService');
const _mockSearch = require('@orama/orama').__mockSearch;

function makeDocs(total) {
  const docs = new Array(total);
  for (let i = 0; i < total; i++) {
    docs[i] = { id: `doc-${i}`, fileId: `file-${i % 100}` };
  }
  return docs;
}

function wireBackend(docs) {
  _mockSearch.mockImplementation(async (_db, params) => {
    const offset = Number.isFinite(params?.offset) ? params.offset : 0;
    const limit = Number.isFinite(params?.limit) ? params.limit : docs.length;
    const slice = docs.slice(offset, offset + limit);
    return { hits: slice.map((document) => ({ document })) };
  });
}

describe('OramaVectorService._paginatedSearch', () => {
  let service;

  beforeEach(() => {
    _mockSearch.mockReset();
    service = new OramaVectorService();
  });

  test('returns exactly the requested rows past the historical 10k cap', async () => {
    const docs = makeDocs(10500);
    wireBackend(docs);

    const fakeDb = {};
    const hits = await service._paginatedSearch(
      fakeDb,
      { term: '' },
      {
        pageSize: 500,
        label: 'test-large-scan'
      }
    );

    expect(hits).toHaveLength(10500);
    // 10500 / 500 = 21 full pages. Because the last page comes back full the
    // loop must peek one extra time to observe EOF, so 22 calls total.
    expect(_mockSearch).toHaveBeenCalledTimes(22);
    const firstIds = hits.slice(0, 3).map((h) => h.document.id);
    const lastIds = hits.slice(-3).map((h) => h.document.id);
    expect(firstIds).toEqual(['doc-0', 'doc-1', 'doc-2']);
    expect(lastIds).toEqual(['doc-10497', 'doc-10498', 'doc-10499']);
  });

  test('stops at end-of-data when the final page is partial', async () => {
    const docs = makeDocs(2750);
    wireBackend(docs);

    const hits = await service._paginatedSearch({}, { term: '' }, { pageSize: 1000 });

    expect(hits).toHaveLength(2750);
    // ceil(2750 / 1000) = 3
    expect(_mockSearch).toHaveBeenCalledTimes(3);
  });

  test('onHit callback lets callers stream-process without buffering', async () => {
    const docs = makeDocs(3001);
    wireBackend(docs);

    const seen = [];
    const collected = await service._paginatedSearch(
      {},
      { term: '' },
      {
        pageSize: 500,
        onHit: (hit) => {
          seen.push(hit.document.id);
        }
      }
    );

    expect(collected).toEqual([]);
    expect(seen).toHaveLength(3001);
    expect(seen[0]).toBe('doc-0');
    expect(seen[seen.length - 1]).toBe('doc-3000');
  });

  test('onHit returning false halts iteration immediately', async () => {
    const docs = makeDocs(5000);
    wireBackend(docs);

    const seen = [];
    await service._paginatedSearch(
      {},
      { term: '' },
      {
        pageSize: 250,
        onHit: (hit) => {
          seen.push(hit.document.id);
          if (seen.length >= 10) return false;
          return true;
        }
      }
    );

    expect(seen).toHaveLength(10);
    // Exactly one page worth of data should have been fetched.
    expect(_mockSearch).toHaveBeenCalledTimes(1);
  });

  test('maxResults caps the total hits yielded', async () => {
    const docs = makeDocs(5000);
    wireBackend(docs);

    const hits = await service._paginatedSearch(
      {},
      { term: '' },
      { pageSize: 1000, maxResults: 1234 }
    );

    expect(hits).toHaveLength(1234);
  });

  test('detects and bails on repeating page fingerprints (loop guard)', async () => {
    // A misbehaving backend always returns the same 5 docs on every page.
    _mockSearch.mockResolvedValue({
      hits: [
        { document: { id: 'doc-0' } },
        { document: { id: 'doc-1' } },
        { document: { id: 'doc-2' } },
        { document: { id: 'doc-3' } },
        { document: { id: 'doc-4' } }
      ]
    });

    const hits = await service._paginatedSearch({}, { term: '' }, { pageSize: 5 });

    // One full page + one retry that triggers the guard; guard breaks before
    // adding a third page, so we get exactly pageSize * 2 hits.
    expect(hits.length).toBeLessThanOrEqual(10);
    expect(_mockSearch.mock.calls.length).toBeLessThanOrEqual(3);
  });

  test('returns empty array when db is null instead of throwing', async () => {
    const hits = await service._paginatedSearch(null, { term: '' });
    expect(hits).toEqual([]);
    expect(_mockSearch).not.toHaveBeenCalled();
  });
});
