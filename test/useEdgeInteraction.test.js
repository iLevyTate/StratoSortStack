/**
 * Tests for useEdgeInteraction: buildElkPath handles missing/malformed elkSections
 */

const { buildElkPath } = require('../src/renderer/components/search/useEdgeInteraction');

describe('buildElkPath', () => {
  test('returns null for undefined elkSections', () => {
    expect(buildElkPath(undefined)).toBeNull();
  });

  test('returns null for empty elkSections', () => {
    expect(buildElkPath([])).toBeNull();
  });

  test('returns null for null elkSections', () => {
    expect(buildElkPath(null)).toBeNull();
  });

  test('returns null when all sections are malformed (missing startPoint/endPoint)', () => {
    const malformed = [{ startPoint: null, endPoint: null }];
    expect(buildElkPath(malformed)).toBeNull();
  });

  test('returns null when sections have invalid point structure', () => {
    const invalid = [{ startPoint: {}, endPoint: {} }];
    expect(buildElkPath(invalid)).toBeNull();
  });

  test('filters out malformed sections and builds path from valid ones', () => {
    const mixed = [
      { startPoint: { x: 0, y: 0 }, endPoint: { x: 100, y: 0 } },
      { startPoint: null, endPoint: null },
      { startPoint: { x: 100, y: 0 }, endPoint: { x: 100, y: 100 } }
    ];
    const result = buildElkPath(mixed);
    expect(result).not.toBeNull();
    expect(typeof result).toBe('string');
    expect(result).toMatch(/^M \d+,\d+/);
  });

  test('builds valid SVG path for proper ELK sections', () => {
    const sections = [
      {
        startPoint: { x: 0, y: 0 },
        endPoint: { x: 100, y: 0 },
        bendPoints: []
      }
    ];
    const result = buildElkPath(sections);
    expect(result).not.toBeNull();
    expect(result).toMatch(/^M \d+,\d+ L \d+,\d+$/);
  });
});
