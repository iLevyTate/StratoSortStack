const {
  buildEmbeddingData,
  nearestPointIndex,
  indicesInLasso,
  DIM_ALPHA_HEX
} = require('../../src/renderer/components/search/atlasEmbeddingData');

const mkPoints = () => ({
  ids: ['a', 'b', 'c', 'd'],
  x: [0, 10, 10, 0],
  y: [0, 0, 10, 10],
  folderKeys: ['Docs', 'Docs', 'Pics', 'Pics'],
  tagKeys: ['', '', '', ''],
  kinds: ['file', 'file', 'file', 'folder'],
  count: 4
});

describe('buildEmbeddingData', () => {
  test('maps projection state to typed arrays with categories and palette', () => {
    const d = buildEmbeddingData(mkPoints(), 'folder', null);
    expect(d.x).toBeInstanceOf(Float32Array);
    expect(d.y).toBeInstanceOf(Float32Array);
    expect(d.category).toBeInstanceOf(Uint8Array);
    expect(d.x.length).toBe(4);
    expect(Array.isArray(d.categoryColors)).toBe(true);
    expect(d.categoryColors.length).toBeGreaterThan(0);
    expect(d.hasEmphasis).toBe(false);
    // tuples preserved for keyboard-traversal geometry: [x, y, cat, emphasized]
    expect(d.pts[1]).toEqual([10, 0, d.category[1], 1]);
  });

  test('encodes emphasis by doubling the palette with dimmed variants', () => {
    const emphasis = new Set(['a']); // only 'a' emphasized
    const d = buildEmbeddingData(mkPoints(), 'folder', emphasis);
    expect(d.hasEmphasis).toBe(true);
    const base = d.categoryColors.length / 2;
    expect(Number.isInteger(base)).toBe(true);
    // non-emphasized points land in the dimmed half
    expect(d.category[1]).toBeGreaterThanOrEqual(base);
    // emphasized point stays in the bright half
    expect(d.category[0]).toBeLessThan(base);
    // dimmed colors are the base colors with the alpha suffix
    expect(d.categoryColors[base + (d.category[1] - base)]).toBe(
      `${d.categoryColors[d.category[1] - base]}${DIM_ALPHA_HEX}`
    );
    expect(d.pts[1][3]).toBe(0);
  });

  test('returns null for empty projections', () => {
    expect(buildEmbeddingData(null, 'folder', null)).toBeNull();
    expect(buildEmbeddingData({ count: 0 }, 'folder', null)).toBeNull();
  });
});

describe('nearestPointIndex', () => {
  const x = new Float32Array([0, 10, 10, 0]);
  const y = new Float32Array([0, 0, 10, 10]);
  test('finds the closest point within the threshold', () => {
    expect(nearestPointIndex(9.4, 0.4, x, y, 2)).toBe(1);
  });
  test('returns -1 when nothing is within the threshold', () => {
    expect(nearestPointIndex(5, 5, x, y, 1)).toBe(-1);
  });
});

describe('indicesInLasso', () => {
  const x = new Float32Array([0, 10, 10, 0, 5]);
  const y = new Float32Array([0, 0, 10, 10, 5]);
  test('rectangle fast path', () => {
    expect(indicesInLasso({ xMin: 4, yMin: 4, xMax: 11, yMax: 11 }, x, y)).toEqual([2, 4]);
  });
  test('polygon ray-casting', () => {
    const tri = [
      { x: -1, y: -1 },
      { x: 12, y: -1 },
      { x: -1, y: 12 }
    ];
    expect(indicesInLasso(tri, x, y)).toEqual([0, 1, 3, 4]);
  });
  test('empty/invalid input yields empty', () => {
    expect(indicesInLasso(null, x, y)).toEqual([]);
    expect(indicesInLasso([], x, y)).toEqual([]);
  });
});
