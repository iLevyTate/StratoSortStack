/**
 * Tag and category keys come from model keywords and user tags. The index maps
 * are plain objects, so a key such as "constructor" used to resolve to an
 * inherited Object.prototype member and `.push` / `.filter` / `.map` threw,
 * leaving the entry half-indexed.
 */
const indexManager = require('../src/main/services/analysisHistory/indexManager');
const queries = require('../src/main/services/analysisHistory/queries');

const PROTOTYPE_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];

function makeEntry(id, tags, category) {
  return {
    id,
    fileHash: `hash-${id}`,
    originalPath: `/docs/${id}.js`,
    timestamp: '2026-11-14T10:00:00.000Z',
    fileSize: 2048,
    analysis: { tags, category }
  };
}

function freshIndex() {
  // Same shape as an index loaded with JSON.parse: plain objects.
  return JSON.parse(JSON.stringify(indexManager.createEmptyIndex('2.0')));
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

describe('indexManager with Object.prototype key names', () => {
  test('updateIndexes indexes prototype-named tags and categories', () => {
    const index = freshIndex();
    const entry = makeEntry('e1', ['class', ...PROTOTYPE_KEYS], 'constructor');

    expect(() => indexManager.updateIndexes(index, entry)).not.toThrow();

    for (const tag of PROTOTYPE_KEYS) {
      expect(hasOwn(index.tagIndex, tag)).toBe(true);
      expect(index.tagIndex[tag]).toEqual(['e1']);
    }
    expect(index.categoryIndex.constructor).toEqual(['e1']);
    // The later indexes were still written (the throw used to stop before them).
    expect(index.dateIndex['2026-11']).toEqual(['e1']);
    expect(index.sizeIndex.small).toEqual(['e1']);
    // A "__proto__" tag must not replace the map's prototype.
    expect(Object.getPrototypeOf(index.tagIndex)).toBe(Object.prototype);
  });

  test('a second entry appends to the same prototype-named bucket', () => {
    const index = freshIndex();
    indexManager.updateIndexes(index, makeEntry('e1', ['constructor'], 'toString'));
    indexManager.updateIndexes(index, makeEntry('e2', ['constructor'], 'toString'));

    expect(index.tagIndex.constructor).toEqual(['e1', 'e2']);
    expect(index.categoryIndex.toString).toEqual(['e1', 'e2']);
  });

  test('removeFromIndexes handles prototype-named keys, indexed or not', () => {
    const index = freshIndex();
    const indexed = makeEntry('e1', ['constructor', '__proto__'], 'valueOf');
    indexManager.updateIndexes(index, indexed);

    expect(() => indexManager.removeFromIndexes(index, indexed)).not.toThrow();
    expect(hasOwn(index.tagIndex, 'constructor')).toBe(false);
    expect(hasOwn(index.tagIndex, '__proto__')).toBe(false);
    expect(hasOwn(index.categoryIndex, 'valueOf')).toBe(false);

    // An entry whose tags were never indexed (e.g. a half-indexed row).
    const neverIndexed = makeEntry('e2', ['toString'], 'hasOwnProperty');
    expect(() => indexManager.removeFromIndexes(index, neverIndexed)).not.toThrow();
    expect(Object.keys(index.tagIndex)).toEqual([]);
    expect(Object.keys(index.categoryIndex)).toEqual([]);
  });

  test('removeFromIndexes keeps the other ids in a prototype-named bucket', () => {
    const index = freshIndex();
    const first = makeEntry('e1', ['constructor'], 'code');
    indexManager.updateIndexes(index, first);
    indexManager.updateIndexes(index, makeEntry('e2', ['constructor'], 'code'));

    indexManager.removeFromIndexes(index, first);
    expect(index.tagIndex.constructor).toEqual(['e2']);
  });
});

describe('queries with Object.prototype key names', () => {
  function makeCache() {
    return { tagResults: new Map(), categoryResults: new Map() };
  }

  test('getAnalysisByTag returns the indexed entries for a prototype-named tag', () => {
    const index = freshIndex();
    const entry = makeEntry('e1', ['constructor'], 'code');
    indexManager.updateIndexes(index, entry);
    const history = { entries: { e1: entry } };

    const result = queries.getAnalysisByTag(history, index, makeCache(), 1000, 'constructor');
    expect(result.results.map((e) => e.id)).toEqual(['e1']);
  });

  test('tag and category queries return nothing for an unindexed prototype key', () => {
    const index = freshIndex();
    const history = { entries: {} };

    for (const key of PROTOTYPE_KEYS) {
      expect(queries.getAnalysisByTag(history, index, makeCache(), 1000, key).total).toBe(0);
      expect(queries.getAnalysisByCategory(history, index, makeCache(), 1000, key).total).toBe(0);
    }
  });
});
