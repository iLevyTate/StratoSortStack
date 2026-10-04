const { buildTimelineItems } = require('../src/main/services/analysisHistory/queries');

describe('buildTimelineItems', () => {
  const mkEntry = (id, timestamp, documentDate, extra = {}) => ({
    id,
    timestamp,
    originalPath: `C:/files/${id}.pdf`,
    fileName: `${id}.pdf`,
    fileExtension: '.pdf',
    analysis: { category: 'Docs', documentDate, mediaKind: null, subject: `s-${id}` },
    ...extra
  });

  const history = {
    entries: {
      a: mkEntry('a', '2026-01-05T10:00:00.000Z', '2019-06-14'),
      b: mkEntry('b', '2026-02-01T10:00:00.000Z', null),
      c: mkEntry('c', '2026-03-01T10:00:00.000Z', '2024-12-25T08:00:00.000Z'),
      d: { id: 'd', timestamp: 'not-a-date', analysis: {} }
    }
  };

  test('maps lean items with effectiveDate = documentDate || timestamp and dateSource flag', () => {
    const { items, total } = buildTimelineItems(history, { limit: 10, offset: 0 });
    expect(total).toBe(4);
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(byId.a).toMatchObject({
      fileName: 'a.pdf',
      filePath: 'C:/files/a.pdf',
      category: 'Docs',
      effectiveDate: '2019-06-14',
      dateSource: 'content'
    });
    expect(byId.b.dateSource).toBe('analyzed');
    expect(byId.b.effectiveDate).toBe('2026-02-01T10:00:00.000Z');
  });

  test('sorts by effectiveDate descending and paginates with hasMore', () => {
    const page1 = buildTimelineItems(history, { limit: 2, offset: 0 });
    expect(page1.items.map((i) => i.id)).toEqual(['b', 'c']);
    expect(page1.hasMore).toBe(true);
    const page2 = buildTimelineItems(history, { limit: 2, offset: 2 });
    expect(page2.items.map((i) => i.id)).toEqual(['a', 'd']);
    expect(page2.hasMore).toBe(false);
  });

  test('invalid dates sort last', () => {
    const { items } = buildTimelineItems(history, { limit: 10, offset: 0 });
    expect(items[items.length - 1].id).toBe('d');
  });

  test('implausible content years fall back to the analyzed timestamp [F-158]', () => {
    // Pre-fix, a hallucinated "2103-01-01" was trusted as the sort key and
    // pinned that entry to the top of the timeline permanently.
    const poisoned = {
      entries: {
        a: mkEntry('a', '2026-01-05T10:00:00.000Z', '2103-01-01'),
        b: mkEntry('b', '2026-02-01T10:00:00.000Z', null),
        c: mkEntry('c', '2026-03-01T10:00:00.000Z', '0201-05-03')
      }
    };
    const { items } = buildTimelineItems(poisoned, { limit: 10, offset: 0 });
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    // Both poisoned entries downgrade to their analyzed-at date, honestly.
    expect(byId.a.effectiveDate).toBe('2026-01-05T10:00:00.000Z');
    expect(byId.a.dateSource).toBe('analyzed');
    expect(byId.c.effectiveDate).toBe('2026-03-01T10:00:00.000Z');
    expect(byId.c.dateSource).toBe('analyzed');
    // Sort order follows the analyzed timestamps, not the year-2103 pin.
    expect(items.map((i) => i.id)).toEqual(['c', 'b', 'a']);
  });

  test('serves follow-up pages from the sorted snapshot and rebuilds on updatedAt change [F-166]', () => {
    const store = {
      updatedAt: '2026-01-01T00:00:00.000Z',
      entries: {
        a: mkEntry('a', '2026-01-05T10:00:00.000Z', null),
        b: mkEntry('b', '2026-02-01T10:00:00.000Z', null)
      }
    };
    const page1 = buildTimelineItems(store, { limit: 1, offset: 0 });
    // In-place mutation WITHOUT an updatedAt stamp: the snapshot (same key,
    // within TTL) still serves — this is the documented staleness bound.
    store.entries.b.fileName = 'renamed.pdf';
    const page2 = buildTimelineItems(store, { limit: 1, offset: 1 });
    expect(page1.items[0].id).toBe('b');
    expect(page1.items[0].fileName).toBe('b.pdf');
    expect(page2.items[0].id).toBe('a');

    // A stamped mutation invalidates immediately.
    store.updatedAt = '2026-01-01T00:00:01.000Z';
    const fresh = buildTimelineItems(store, { limit: 1, offset: 0 });
    expect(fresh.items[0].fileName).toBe('renamed.pdf');
  });

  test('tolerates empty/missing stores', () => {
    expect(buildTimelineItems(null, {})).toEqual({ items: [], total: 0, hasMore: false });
    expect(buildTimelineItems({ entries: {} }, {})).toEqual({
      items: [],
      total: 0,
      hasMore: false
    });
  });
});
