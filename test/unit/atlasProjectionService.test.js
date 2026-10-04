const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

// Jest hoists jest.mock() above these; names must be `mock`-prefixed to be
// referenceable inside the factories. The test fs is virtual (in-memory), so we
// use a static path and let the service's recursive mkdir create it.
const mockTmpDir = '/atlas-test-cache';
let mockMetaValue = { model: 'model-a', dims: 4, rebuildInProgress: false };
let mockFileEmbeddings = [];
let mockFolderEmbeddings = [];
const mockOrama = Object.assign(new EventEmitter(), {
  initialize: async () => {},
  getAllFileEmbeddings: async () => mockFileEmbeddings,
  getAllFolderEmbeddings: async () => mockFolderEmbeddings
});

jest.mock('electron', () => ({
  app: { getPath: () => mockTmpDir }
}));

jest.mock('../../src/main/services/vectorDb/embeddingIndexMetadata', () => ({
  readEmbeddingIndexMetadata: async () => mockMetaValue
}));

// Force the in-process UMAP fallback (no worker_threads) for deterministic,
// single-threaded test runs.
jest.mock('worker_threads', () => ({
  Worker: class {
    constructor() {
      throw new Error('worker disabled in test');
    }
  }
}));

jest.mock('../../src/main/services/OramaVectorService', () => ({
  getInstance: () => mockOrama
}));

const { getInstance, resetInstance } = require('../../src/main/services/AtlasProjectionService');

const makeVec = (seed, dim = 4) => Array.from({ length: dim }, (_, i) => Math.sin(seed * (i + 1)));
const makeFiles = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `f${i}`,
    embedding: makeVec(i + 1),
    filePath: `/docs/sub/f${i}.txt`,
    fileName: `f${i}.txt`,
    tags: ['t'],
    keywords: [],
    suggestedName: ''
  }));

describe('AtlasProjectionService', () => {
  beforeEach(() => {
    resetInstance();
    mockFileEmbeddings = [];
    mockFolderEmbeddings = [];
    mockMetaValue = { model: 'model-a', dims: 4, rebuildInProgress: false };
    fs.rmSync(path.join(mockTmpDir, 'atlas'), { recursive: true, force: true });
  });

  test('returns empty status when there are no embeddings', async () => {
    const page = await getInstance().getProjectionPage({});
    expect(page.status).toBe('empty');
    expect(page.total).toBe(0);
    expect(page.ids).toEqual([]);
  });

  test('projects files + folders to 2D and reports the full total', async () => {
    mockFileEmbeddings = makeFiles(20);
    mockFolderEmbeddings = [
      { id: 'g0', embedding: makeVec(99), folderPath: '/docs/sub', folderName: 'sub' }
    ];
    const page = await getInstance().getProjectionPage({ offset: 0, limit: 1000 });
    expect(page.status).toBe('ready');
    expect(page.total).toBe(21);
    expect(page.ids.length).toBe(21);
    expect(page.x.length).toBe(21);
    expect(page.y.length).toBe(21);
    expect(page.x.every((v) => Number.isFinite(v))).toBe(true);
    expect(page.kinds).toContain('folder');
  });

  test('paginates: a page never exceeds the requested limit but reports total', async () => {
    mockFileEmbeddings = makeFiles(12);
    const page = await getInstance().getProjectionPage({ offset: 0, limit: 5 });
    expect(page.status).toBe('ready');
    expect(page.total).toBe(12);
    expect(page.ids.length).toBe(5);
  });

  test('serves a rebuilding status while embeddings are rebuilding', async () => {
    mockMetaValue = { model: 'model-a', dims: 4, rebuildInProgress: true };
    mockFileEmbeddings = makeFiles(3);
    const page = await getInstance().getProjectionPage({});
    expect(page.status).toBe('rebuilding');
  });

  test('reuses the cached projection when the corpus is unchanged', async () => {
    mockFileEmbeddings = makeFiles(8);
    const svc = getInstance();
    const first = await svc.getProjectionPage({ offset: 0, limit: 1000 });
    const second = await svc.getProjectionPage({ offset: 0, limit: 1000 });
    // Identical coordinates prove no refit happened (UMAP would differ per run).
    expect(second.x).toEqual(first.x);
    expect(second.y).toEqual(first.y);
  });

  test('an embedding-model-change event invalidates the cache', async () => {
    mockFileEmbeddings = makeFiles(6);
    const svc = getInstance();
    await svc.getProjectionPage({});
    expect((await svc.getStatus()).hasCache).toBe(true);
    mockOrama.emit('embedding-model-change', {});
    expect((await svc.getStatus()).hasCache).toBe(false);
  });

  test('exposes categoryKeys from smart folder / category, defaulting to (uncategorized)', async () => {
    mockFileEmbeddings = [
      { ...makeFiles(1)[0], id: 'f0', smartFolder: 'Work', category: 'ignored-when-smart' },
      { ...makeFiles(1)[0], id: 'f1', smartFolder: '', category: 'Financial' },
      { ...makeFiles(1)[0], id: 'f2' } // neither -> (uncategorized)
    ];
    const page = await getInstance().getProjectionPage({ offset: 0, limit: 1000 });
    expect(page.status).toBe('ready');
    const byId = Object.fromEntries(page.ids.map((id, i) => [id, page.categoryKeys[i]]));
    expect(byId.f0).toBe('Work'); // smart folder wins over category
    expect(byId.f1).toBe('Financial'); // category fallback
    expect(byId.f2).toBe('(uncategorized)');
  });

  test('infers category from containing smart-folder path when metadata is stale', async () => {
    // After organize, files sit under the destination folder but Orama may still
    // carry empty/Uncategorized category fields — Atlas should trust the path.
    mockFileEmbeddings = [
      {
        id: 'moved',
        embedding: makeVec(1),
        filePath: '/home/docs/Research/paper.pdf',
        fileName: 'paper.pdf',
        tags: [],
        keywords: [],
        suggestedName: '',
        smartFolder: '',
        category: 'Uncategorized'
      }
    ];
    const svc = getInstance();
    svc._getSmartFolders = () => [{ name: 'Research', path: '/home/docs/Research' }];
    const page = await svc.getProjectionPage({ offset: 0, limit: 1000 });
    expect(page.status).toBe('ready');
    expect(page.categoryKeys[page.ids.indexOf('moved')]).toBe('Research');
  });

  test('a worker fit timeout/crash propagates instead of refitting synchronously on the main thread', async () => {
    const svc = getInstance();
    // Worker constructs fine, but the fit op times out (or the worker
    // crashes). The old behavior fell back to a synchronous in-process fit —
    // re-running work that just proved too slow, freezing the main process.
    svc._ensureWorker = () => ({});
    svc._runWorkerOp = async () => {
      throw new Error('UMAP fit timed out after 1ms');
    };
    const vectors = [makeVec(1), makeVec(2), makeVec(3), makeVec(4)];
    await expect(svc._fitAll(vectors)).rejects.toThrow('timed out');
  });

  test('a force call during an in-flight build queues a forced rebuild instead of being downgraded', async () => {
    const svc = getInstance();
    const calls = [];
    let releaseFirst;
    svc._init = async () => {};
    svc._doEnsure = jest.fn(({ force }) => {
      calls.push(force);
      if (calls.length === 1) {
        return new Promise((resolve) => {
          releaseFirst = () => resolve({ status: 'ready', meta: null });
        });
      }
      return Promise.resolve({ status: 'ready', meta: null });
    });
    const p1 = svc.ensureProjection({ force: false });
    // ensureProjection awaits _init before _doEnsure runs; give the async fn
    // its microtask hops so the first build is genuinely in flight.
    for (let i = 0; i < 20 && !releaseFirst; i++) await Promise.resolve();
    const p2 = svc.ensureProjection({ force: true });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    releaseFirst();
    await p1;
    await p2;
    // The forced rebuild ran as its own build after the in-flight one.
    expect(calls).toEqual([false, true]);
    // And the in-flight slot was released for the next caller.
    await svc.ensureProjection({});
    expect(calls).toEqual([false, true, false]);
  });

  test('falls back to an in-process fit only when the worker cannot be constructed', async () => {
    // The suite-level worker_threads mock throws in the constructor, so this
    // exercises the spawn-failure path end-to-end: the projection still builds.
    mockFileEmbeddings = makeFiles(5);
    const page = await getInstance().getProjectionPage({ offset: 0, limit: 1000 });
    expect(page.status).toBe('ready');
    expect(page.total).toBe(5);
  });

  test('refreshes categoryKeys when metadata changes without refitting coordinates', async () => {
    const base = makeFiles(8).map((f) => ({ ...f, smartFolder: 'Downloads' }));
    mockFileEmbeddings = base;
    const svc = getInstance();
    const first = await svc.getProjectionPage({ offset: 0, limit: 1000 });

    // Same id set (signature unchanged) but f0 was organized into "Work".
    mockFileEmbeddings = base.map((f) => (f.id === 'f0' ? { ...f, smartFolder: 'Work' } : f));
    const second = await svc.getProjectionPage({ offset: 0, limit: 1000 });

    // Coordinates are byte-identical -> the expensive UMAP fit was NOT re-run
    // (in-process UMAP is non-deterministic across fits for n=8).
    expect(second.x).toEqual(first.x);
    expect(second.y).toEqual(first.y);
    const idx = second.ids.indexOf('f0');
    expect(second.categoryKeys[idx]).toBe('Work');
  });

  test('follow-up pages serve from cache without re-exporting the corpus, and every page echoes the fit signature [F-155/F-161]', async () => {
    mockFileEmbeddings = makeFiles(8);
    const exportSpy = jest.spyOn(mockOrama, 'getAllFileEmbeddings');

    const page0 = await getInstance().getProjectionPage({ offset: 0, limit: 5 });
    expect(page0.status).toBe('ready');
    expect(typeof page0.signature).toBe('string');
    expect(page0.signature.length).toBeGreaterThan(0);
    const ensuresAfterPage0 = exportSpy.mock.calls.length;

    // Pre-fix, EVERY page re-ran ensureProjection -> a full corpus export per
    // page (O(pages x corpus)) and a possible mid-pagination refit that let
    // the renderer stitch two different UMAP fits.
    const page1 = await getInstance().getProjectionPage({ offset: 5, limit: 5 });
    expect(page1.status).toBe('ready');
    expect(exportSpy.mock.calls.length).toBe(ensuresAfterPage0);
    expect(page1.signature).toBe(page0.signature);
    expect(page1.ids).toHaveLength(3);
    exportSpy.mockRestore();
  });

  test('a corpus change between page-throughs yields a NEW signature on the next page-0 ensure [F-155]', async () => {
    mockFileEmbeddings = makeFiles(4);
    const first = await getInstance().getProjectionPage({ offset: 0, limit: 100 });
    mockFileEmbeddings = makeFiles(5);
    const second = await getInstance().getProjectionPage({ offset: 0, limit: 100 });
    expect(second.signature).not.toBe(first.signature);
  });

  test('rejects a persisted cache whose y array is missing or short [F-160]', async () => {
    // Corrupt-but-parseable cache: ids/x consistent, y truncated. Pre-fix the
    // load guard only validated ids/x, so every subsequent page threw on
    // this._cache.y.slice until a forced rebuild.
    const cacheDir = path.join(mockTmpDir, 'atlas');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, 'projection.json'),
      JSON.stringify({
        signature: 'model-a:4:corrupt',
        model: 'model-a',
        dim: 4,
        ids: ['f0', 'f1'],
        x: [0.1, 0.2],
        y: [0.1],
        folderKeys: ['sub', 'sub'],
        categoryKeys: ['c', 'c'],
        tagKeys: ['t', 't'],
        kinds: ['file', 'file'],
        builtAt: 123
      })
    );
    mockFileEmbeddings = makeFiles(2);

    // The corrupt cache must be ignored (fresh fit), not adopted and thrown on.
    const page = await getInstance().getProjectionPage({ offset: 0, limit: 100 });
    expect(page.status).toBe('ready');
    expect(page.ids).toHaveLength(2);
    expect(page.y).toHaveLength(2);
  });
});
