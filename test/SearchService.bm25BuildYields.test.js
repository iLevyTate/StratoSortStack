/**
 * @jest-environment node
 */
/**
 * The BM25 index build runs on the Electron main process. Orama's
 * insertMultiple is fully synchronous (its `timeout` option is a busy-wait),
 * so a single call over the whole analysis history blocks every IPC handler,
 * progress event and window for the duration of the build. The build must
 * yield to the event loop between slices so the main process stays responsive.
 */

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const { SearchService } = require('../src/main/services/SearchService');

const WORDS = [
  'invoice',
  'mortgage',
  'contract',
  'quarterly',
  'report',
  'receipt',
  'payment',
  'insurance',
  'statement',
  'project',
  'budget',
  'meeting',
  'summary',
  'renewal',
  'policy',
  'account'
];

function makeText(seed, length) {
  const out = [];
  let size = 0;
  let i = seed;
  while (size < length) {
    const w = `${WORDS[i % WORDS.length]}${i % 97}`;
    out.push(w);
    size += w.length + 1;
    i = (i * 31 + 7) % 100003;
  }
  return out.join(' ');
}

function makeHistory(count) {
  const entries = {};
  const base = Date.parse('2026-01-01T00:00:00Z');
  for (let i = 0; i < count; i += 1) {
    entries[`analysis-${i}`] = {
      id: `analysis-${i}`,
      fileName: `document-${i}.pdf`,
      originalPath: `/library/docs/document-${i}.pdf`,
      mimeType: 'application/pdf',
      timestamp: new Date(base + i * 1000).toISOString(),
      analysis: {
        subject: `Subject ${i}`,
        summary: makeText(i + 1, 200),
        tags: ['finance', `tag${i % 13}`],
        category: 'Finance',
        extractedText: makeText(i + 3, 5000)
      }
    };
  }
  return {
    initialize: jest.fn().mockResolvedValue(undefined),
    analysisHistory: { metadata: { totalEntries: count }, entries }
  };
}

function createService(historyService) {
  return new SearchService({
    vectorDbService: {
      initialize: jest.fn().mockResolvedValue(true),
      getStats: jest.fn().mockResolvedValue({ files: 0, fileChunks: 0 })
    },
    analysisHistoryService: historyService,
    parallelEmbeddingService: { embedText: jest.fn() }
  });
}

/** Measures the longest stretch during which no macrotask could run. */
function startEventLoopProbe() {
  let last = performance.now();
  let maxGap = 0;
  let ticks = 0;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks += 1;
    setImmediate(tick);
  };
  setImmediate(tick);
  return () => {
    stopped = true;
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    return { maxGap, ticks };
  };
}

describe('SearchService BM25 build responsiveness', () => {
  test('a 3000-document build yields to the event loop instead of blocking for the whole build', async () => {
    const service = createService(makeHistory(3000));

    const started = performance.now();
    const stopProbe = startEventLoopProbe();
    const result = await service.buildBM25Index();
    const totalMs = performance.now() - started;
    const { maxGap, ticks } = stopProbe();

    expect(result).toEqual({ success: true, indexed: 3000 });
    // The build is cooperative: the event loop got many turns during it ...
    expect(ticks).toBeGreaterThan(20);
    // ... and no single slice monopolised the thread for most of the build.
    expect(maxGap).toBeLessThan(Math.max(250, totalMs / 4));

    // The resulting index is complete and searchable.
    const hits = await service.bm25Search('document-2999', 5);
    expect(hits.map((h) => h.id).some((id) => String(id).includes('document-2999'))).toBe(true);
  }, 120000);

  test('enrichment metadata from the previous build stays available while a rebuild is in progress', async () => {
    const service = createService(makeHistory(600));
    await service.buildBM25Index();
    const knownId = [...service.documentMap.keys()][0];
    expect(knownId).toBeTruthy();

    const seenDuringBuild = [];
    let building = true;
    const sample = () => {
      if (!building) return;
      seenDuringBuild.push(service.documentMap.has(knownId));
      setImmediate(sample);
    };
    service.invalidateIndex({ reason: 'test' });
    const rebuild = service.buildBM25Index();
    setImmediate(sample);
    await rebuild;
    building = false;

    expect(seenDuringBuild.length).toBeGreaterThan(0);
    expect(seenDuringBuild.every(Boolean)).toBe(true);
    expect(service.documentMap.has(knownId)).toBe(true);
  }, 120000);
});

describe('SearchService BM25 build and concurrent invalidation', () => {
  const nextMacrotask = () => new Promise((resolve) => setImmediate(resolve));

  function addEntry(history, id, word) {
    history.analysisHistory.entries[id] = {
      id,
      fileName: `${word}.pdf`,
      originalPath: `/library/docs/${word}.pdf`,
      mimeType: 'application/pdf',
      timestamp: new Date().toISOString(),
      analysis: { subject: word, summary: word, tags: [], category: 'Finance' }
    };
    history.analysisHistory.metadata.totalEntries += 1;
  }

  test('an invalidation that lands while a build is in progress leaves the built index stale', async () => {
    const history = makeHistory(3000);
    const service = createService(history);

    const build = service.buildBM25Index();
    // Let the build snapshot the history and start yielding.
    for (let i = 0; i < 3; i += 1) await nextMacrotask();
    expect(service._indexBuildPromise).toBeTruthy();

    // What analysisUtils does after recording a new analysis.
    addEntry(history, 'analysis-new', 'zebrafinance');
    service.invalidateIndex({ reason: 'analysis-recorded' });

    await build;
    expect(service.isIndexStale()).toBe(true);
  }, 120000);

  test('a build requested after a mid-build invalidation includes the new entry', async () => {
    const history = makeHistory(3000);
    const service = createService(history);

    const firstBuild = service.buildBM25Index();
    for (let i = 0; i < 3; i += 1) await nextMacrotask();
    expect(service._indexBuildPromise).toBeTruthy();

    addEntry(history, 'analysis-new', 'zebrafinance');
    service.invalidateIndex({ reason: 'analysis-recorded' });
    // e.g. the debounced invalidateAndRebuild timer firing mid-build.
    const secondBuild = service.buildBM25Index();

    await firstBuild;
    const result = await secondBuild;
    expect(result).toEqual({ success: true, indexed: 3001 });
    expect(service.isIndexStale()).toBe(false);
    const hits = await service.bm25Search('zebrafinance', 5);
    expect(hits.some((h) => String(h.id).includes('zebrafinance'))).toBe(true);
  }, 120000);

  test('callers that join a build with no invalidation since it started share its result', async () => {
    const service = createService(makeHistory(600));
    const first = service.buildBM25Index();
    for (let i = 0; i < 2; i += 1) await nextMacrotask();
    const second = service.buildBM25Index();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ success: true, indexed: 600 });
    expect(b).toBe(a);
    expect(service.history.initialize).toHaveBeenCalledTimes(1);
  }, 120000);
});
