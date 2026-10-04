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
});
