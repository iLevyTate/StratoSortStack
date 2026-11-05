/**
 * Startup knowledge repair (F-198 backfill + F-221 orphan restore).
 *
 * Walks every history entry that still exists on disk and makes the vector
 * store agree with it: an orphan-marked row is restored (its vector is
 * intact), a row with no vector — or no row at all — is re-embedded from the
 * stored analysis without running the LLM again. Fallback-only analyses are
 * left alone (they have nothing meaningful to embed; F-195 owns them).
 */
jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })
}));

const { repairKnowledge } = require('../src/main/services/embedding/knowledgeRepair');

function makeDeps({ docs = {}, existing = new Set(), embedResult = { action: 'enqueued' } } = {}) {
  const vectorDb = {
    getFile: jest.fn(async (id) => docs[id] || null),
    restoreOrphanedEmbeddings: jest.fn(async (ids) => ({
      restored: ids.length,
      failed: 0,
      missing: 0
    }))
  };
  const embedEntry = jest.fn(async () => embedResult);
  const fileExists = jest.fn(async (p) => existing.has(p));
  return { vectorDb, embedEntry, fileExists };
}

const entry = (path, extra = {}) => ({ originalPath: path, analysis: { summary: 's' }, ...extra });

describe('repairKnowledge', () => {
  test('restores orphan-marked rows whose file exists, without re-embedding', async () => {
    const deps = makeDeps({
      docs: { 'file:/docs/a.pdf': { id: 'file:/docs/a.pdf', isOrphaned: true, hasVector: true } },
      existing: new Set(['/docs/a.pdf'])
    });
    const result = await repairKnowledge({ entries: { e1: entry('/docs/a.pdf') }, ...deps });

    expect(deps.vectorDb.restoreOrphanedEmbeddings).toHaveBeenCalledWith(['file:/docs/a.pdf']);
    expect(deps.embedEntry).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ checked: 1, restored: 1, embedded: 0 }));
  });

  test('re-embeds entries with no vector row, and rows whose vector is a placeholder', async () => {
    const deps = makeDeps({
      docs: { 'file:/docs/b.pdf': { id: 'file:/docs/b.pdf', isOrphaned: false, hasVector: false } },
      existing: new Set(['/docs/a.pdf', '/docs/b.pdf'])
    });
    const result = await repairKnowledge({
      entries: { e1: entry('/docs/a.pdf'), e2: entry('/docs/b.pdf') },
      ...deps
    });

    expect(deps.embedEntry).toHaveBeenCalledTimes(2);
    expect(deps.embedEntry.mock.calls.map(([args]) => args.filePath).sort()).toEqual([
      '/docs/a.pdf',
      '/docs/b.pdf'
    ]);
    expect(deps.vectorDb.restoreOrphanedEmbeddings).not.toHaveBeenCalled();
    expect(result.embedded).toBe(2);
  });

  test('leaves healthy rows alone', async () => {
    const deps = makeDeps({
      docs: { 'file:/docs/a.pdf': { id: 'file:/docs/a.pdf', isOrphaned: false, hasVector: true } },
      existing: new Set(['/docs/a.pdf'])
    });
    const result = await repairKnowledge({ entries: { e1: entry('/docs/a.pdf') }, ...deps });
    expect(deps.embedEntry).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ checked: 1, healthy: 1 }));
  });

  test('skips files that are gone, fallback-only analyses, and duplicate rows for one path', async () => {
    const deps = makeDeps({ existing: new Set(['/docs/a.pdf', '/docs/fb.pdf', '/docs/err.pdf']) });
    const result = await repairKnowledge({
      entries: {
        gone: entry('/gone/x.pdf'),
        fb: entry('/docs/fb.pdf', { analysis: { extractionMethod: 'filename_fallback' } }),
        flagged: entry('/docs/err.pdf', { analysis: { _isFallback: true, category: 'error' } }),
        a1: entry('/docs/a.pdf'),
        a2: entry('/docs/a.pdf'),
        moved: {
          originalPath: '/old/a.pdf',
          organization: { actual: '/docs/a.pdf' },
          analysis: {}
        },
        empty: { originalPath: null }
      },
      ...deps
    });

    expect(deps.embedEntry).toHaveBeenCalledTimes(1);
    expect(deps.embedEntry.mock.calls[0][0].filePath).toBe('/docs/a.pdf');
    expect(result).toEqual(
      expect.objectContaining({ embedded: 1, skippedMissing: 1, skippedFallback: 2 })
    );
  });

  test('uses the moved path (organization.actual) over the original one', async () => {
    const deps = makeDeps({ existing: new Set(['/new/a.pdf']) });
    await repairKnowledge({
      entries: {
        m: { originalPath: '/old/a.pdf', organization: { actual: '/new/a.pdf' }, analysis: {} }
      },
      ...deps
    });
    expect(deps.fileExists).toHaveBeenCalledWith('/new/a.pdf');
    expect(deps.embedEntry.mock.calls[0][0].filePath).toBe('/new/a.pdf');
  });

  test('caps the number of re-embeds per run and stops when asked', async () => {
    const paths = ['/d/1.pdf', '/d/2.pdf', '/d/3.pdf', '/d/4.pdf'];
    const deps = makeDeps({ existing: new Set(paths) });
    const entries = Object.fromEntries(paths.map((p, i) => [`e${i}`, entry(p)]));

    const capped = await repairKnowledge({ entries, ...deps, maxEmbeds: 2 });
    expect(capped.embedded).toBe(2);
    expect(capped.deferred).toBe(2);

    deps.embedEntry.mockClear();
    let calls = 0;
    const stopped = await repairKnowledge({
      entries,
      ...deps,
      shouldStop: () => calls++ >= 1
    });
    expect(stopped.embedded).toBeLessThan(4);
    expect(stopped.stopped).toBe(true);
  });

  test('an embed failure is counted, not thrown', async () => {
    const deps = makeDeps({ existing: new Set(['/docs/a.pdf', '/docs/b.pdf']) });
    deps.embedEntry.mockRejectedValueOnce(new Error('model busy')).mockResolvedValueOnce({
      action: 'enqueued'
    });
    const result = await repairKnowledge({
      entries: { a: entry('/docs/a.pdf'), b: entry('/docs/b.pdf') },
      ...deps
    });
    expect(result.embedded).toBe(1);
    expect(result.failed).toBe(1);
  });

  test('does nothing without entries or without a vector store', async () => {
    const deps = makeDeps();
    await expect(repairKnowledge({ entries: null, ...deps })).resolves.toEqual(
      expect.objectContaining({ checked: 0 })
    );
    await expect(
      repairKnowledge({ entries: { a: entry('/x') }, ...deps, vectorDb: null })
    ).resolves.toEqual(expect.objectContaining({ checked: 0 }));
  });

  test('fills empty passages from stored text and leaves the file vector in place', async () => {
    const deps = makeDeps({
      docs: { 'file:/docs/a.pdf': { id: 'file:/docs/a.pdf', hasVector: true } },
      existing: new Set(['/docs/a.pdf'])
    });
    deps.vectorDb.hasUsableVector = jest.fn(async () => true);
    deps.vectorDb.describeFileChunks = jest.fn(async () => ({
      count: 4,
      placeholderCount: 4,
      missingVectorCount: 0
    }));
    const repairPassages = jest.fn(async () => ({ action: 'repaired' }));
    const result = await repairKnowledge({
      entries: {
        e1: entry('/docs/a.pdf', { analysis: { summary: 's', extractedText: 'x'.repeat(200) } })
      },
      ...deps,
      repairPassages
    });

    expect(deps.embedEntry).not.toHaveBeenCalled();
    expect(repairPassages).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ passages: 1, healthy: 0, embedded: 0 }));
  });

  test('builds passages that were never created', async () => {
    const deps = makeDeps({
      docs: { 'file:/docs/a.pdf': { id: 'file:/docs/a.pdf', hasVector: true } },
      existing: new Set(['/docs/a.pdf'])
    });
    deps.vectorDb.hasUsableVector = jest.fn(async () => true);
    deps.vectorDb.describeFileChunks = jest.fn(async () => ({
      count: 0,
      placeholderCount: 0,
      missingVectorCount: 0
    }));
    const repairPassages = jest.fn(async () => ({ action: 'repaired' }));
    const result = await repairKnowledge({
      entries: {
        e1: entry('/docs/a.pdf', { analysis: { summary: 's', extractedText: 'y'.repeat(240) } })
      },
      ...deps,
      repairPassages
    });

    expect(result.passages).toBe(1);
    expect(deps.embedEntry).not.toHaveBeenCalled();
  });

  test('leaves a file alone when its passages already hold real vectors', async () => {
    const deps = makeDeps({
      docs: { 'file:/docs/a.pdf': { id: 'file:/docs/a.pdf', hasVector: true } },
      existing: new Set(['/docs/a.pdf'])
    });
    deps.vectorDb.hasUsableVector = jest.fn(async () => true);
    deps.vectorDb.describeFileChunks = jest.fn(async () => ({
      count: 3,
      placeholderCount: 0,
      missingVectorCount: 0
    }));
    const repairPassages = jest.fn(async () => ({ action: 'repaired' }));
    const result = await repairKnowledge({
      entries: {
        e1: entry('/docs/a.pdf', { analysis: { summary: 's', extractedText: 'z'.repeat(240) } })
      },
      ...deps,
      repairPassages
    });

    expect(repairPassages).not.toHaveBeenCalled();
    expect(deps.embedEntry).not.toHaveBeenCalled();
    expect(result.healthy).toBe(1);
  });

  test('does not invent passages for short text or when passage repair is off', async () => {
    const deps = makeDeps({
      docs: {
        'file:/docs/a.pdf': { id: 'file:/docs/a.pdf', hasVector: true },
        'file:/docs/b.pdf': { id: 'file:/docs/b.pdf', hasVector: true }
      },
      existing: new Set(['/docs/a.pdf', '/docs/b.pdf'])
    });
    deps.vectorDb.describeFileChunks = jest.fn(async () => ({
      count: 0,
      placeholderCount: 0,
      missingVectorCount: 0
    }));
    const repairPassages = jest.fn(async () => ({ action: 'repaired' }));

    const short = await repairKnowledge({
      entries: { short: entry('/docs/a.pdf', { analysis: { extractedText: 'too short' } }) },
      ...deps,
      repairPassages
    });
    expect(deps.vectorDb.describeFileChunks).not.toHaveBeenCalled();
    expect(short.healthy).toBe(1);

    await repairKnowledge({
      entries: { off: entry('/docs/b.pdf', { analysis: { extractedText: 'q'.repeat(400) } }) },
      ...deps,
      repairPassages,
      checkPassages: false
    });
    expect(repairPassages).not.toHaveBeenCalled();
  });

  test('re-embeds a file whose stored vector is only zeros', async () => {
    const deps = makeDeps({
      docs: { 'file:/docs/a.pdf': { id: 'file:/docs/a.pdf', hasVector: true } },
      existing: new Set(['/docs/a.pdf'])
    });
    deps.vectorDb.hasUsableVector = jest.fn(async () => false);
    const result = await repairKnowledge({
      entries: { e1: entry('/docs/a.pdf') },
      ...deps
    });

    expect(deps.embedEntry).toHaveBeenCalledTimes(1);
    expect(result.embedded).toBe(1);
    expect(result.healthy).toBe(0);
  });

  test('defers passage repair once the launch cap is spent', async () => {
    const deps = makeDeps({
      docs: {
        'file:/docs/a.pdf': { hasVector: true },
        'file:/docs/b.pdf': { hasVector: true }
      },
      existing: new Set(['/docs/a.pdf', '/docs/b.pdf'])
    });
    deps.vectorDb.hasUsableVector = jest.fn(async () => true);
    deps.vectorDb.describeFileChunks = jest.fn(async () => ({
      count: 2,
      placeholderCount: 2,
      missingVectorCount: 0
    }));
    const repairPassages = jest.fn(async () => ({ action: 'repaired' }));
    const result = await repairKnowledge({
      entries: {
        a: entry('/docs/a.pdf', { analysis: { extractedText: 'a'.repeat(220) } }),
        b: entry('/docs/b.pdf', { analysis: { extractedText: 'b'.repeat(220) } })
      },
      ...deps,
      repairPassages,
      maxEmbeds: 1
    });

    expect(repairPassages).toHaveBeenCalledTimes(1);
    expect(result.passages).toBe(1);
    expect(result.deferred).toBe(1);
  });

  test('a launch where every row is healthy never checks the disk or calls the embedder', async () => {
    const paths = ['/docs/a.pdf', '/docs/b.pdf', '/docs/c.pdf'];
    const deps = makeDeps({
      docs: Object.fromEntries(
        paths.map((p) => [`file:${p}`, { id: `file:${p}`, isOrphaned: false, hasVector: true }])
      ),
      existing: new Set(paths)
    });
    const repairPassages = jest.fn(async () => ({ action: 'repaired' }));
    const result = await repairKnowledge({
      entries: Object.fromEntries(paths.map((p, i) => [`e${i}`, entry(p)])),
      ...deps,
      repairPassages
    });

    expect(deps.fileExists).not.toHaveBeenCalled();
    expect(deps.embedEntry).not.toHaveBeenCalled();
    expect(repairPassages).not.toHaveBeenCalled();
    expect(deps.vectorDb.restoreOrphanedEmbeddings).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ checked: 3, healthy: 3, skippedMissing: 0 }));
  });

  test('only the rows that need work are checked on disk, and a missing one is left alone', async () => {
    const deps = makeDeps({
      docs: {
        'file:/docs/ok.pdf': { id: 'file:/docs/ok.pdf', isOrphaned: false, hasVector: true },
        'file:/gone/orphan.pdf': { id: 'file:/gone/orphan.pdf', isOrphaned: true, hasVector: true }
      },
      existing: new Set(['/docs/ok.pdf', '/docs/new.pdf'])
    });
    const result = await repairKnowledge({
      entries: {
        ok: entry('/docs/ok.pdf'),
        orphan: entry('/gone/orphan.pdf'),
        unembedded: entry('/docs/new.pdf'),
        unembeddedGone: entry('/gone/x.pdf')
      },
      ...deps
    });

    expect(deps.fileExists.mock.calls.map(([p]) => p).sort()).toEqual([
      '/docs/new.pdf',
      '/gone/orphan.pdf',
      '/gone/x.pdf'
    ]);
    expect(deps.embedEntry).toHaveBeenCalledTimes(1);
    expect(deps.embedEntry.mock.calls[0][0].filePath).toBe('/docs/new.pdf');
    expect(deps.vectorDb.restoreOrphanedEmbeddings).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ healthy: 1, embedded: 1, skippedMissing: 2, checked: 2 })
    );
  });
});

describe('scheduleStartupKnowledgeRepair', () => {
  const mockResolveServices = jest.fn(() => ({
    vectorDbService: null,
    analysisHistoryService: null,
    folderMatchingService: null,
    learningFeedbackService: null
  }));
  const mockEmbedHistoryEntry = jest.fn(async () => ({ action: 'enqueued' }));

  beforeAll(() => {
    jest.doMock('../src/main/ipc/files/embeddingSync', () => ({
      resolveServices: mockResolveServices,
      embedHistoryEntry: mockEmbedHistoryEntry,
      getSmartFolderForPath: jest.fn(() => null)
    }));
    jest.doMock('../src/main/services/SettingsService', () => ({
      getInstance: () => ({ load: async () => ({}) })
    }));
  });

  afterAll(() => {
    jest.dontMock('../src/main/ipc/files/embeddingSync');
    jest.dontMock('../src/main/services/SettingsService');
  });

  beforeEach(() => {
    mockResolveServices.mockClear();
    mockEmbedHistoryEntry.mockClear();
  });

  function schedule(docs, entries) {
    const {
      scheduleStartupKnowledgeRepair
    } = require('../src/main/services/embedding/knowledgeRepair');
    const vectorDb = {
      getFile: jest.fn(async (id) => docs[id] || null),
      hasUsableVector: jest.fn(async (id) => Boolean(docs[id]?.hasVector)),
      restoreOrphanedEmbeddings: jest.fn(async () => ({ restored: 0 }))
    };
    return scheduleStartupKnowledgeRepair({
      vectorDb,
      analysisHistory: { analysisHistory: { entries } },
      delayMs: 0
    });
  }

  test('a healthy index does not stat files or wire up the embedder', async () => {
    const statSpy = jest.spyOn(require('fs').promises, 'stat');
    try {
      const summary = await schedule(
        { 'file:/docs/a.pdf': { id: 'file:/docs/a.pdf', hasVector: true } },
        { e1: entry('/docs/a.pdf') }
      );
      expect(summary).toEqual(expect.objectContaining({ healthy: 1, embedded: 0 }));
      expect(statSpy).not.toHaveBeenCalled();
      expect(mockResolveServices).not.toHaveBeenCalled();
      expect(mockEmbedHistoryEntry).not.toHaveBeenCalled();
    } finally {
      statSpy.mockRestore();
    }
  });

  test('a row with no vector still gets the embedder', async () => {
    const statSpy = jest
      .spyOn(require('fs').promises, 'stat')
      .mockResolvedValue({ isDirectory: () => false });
    try {
      const summary = await schedule({}, { e1: entry('/docs/a.pdf') });
      expect(statSpy).toHaveBeenCalledWith('/docs/a.pdf');
      expect(mockResolveServices).toHaveBeenCalled();
      expect(mockEmbedHistoryEntry).toHaveBeenCalledTimes(1);
      expect(summary.embedded).toBe(1);
    } finally {
      statSpy.mockRestore();
    }
  });
});
