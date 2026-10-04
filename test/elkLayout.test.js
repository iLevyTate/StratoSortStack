/**
 * Tests for elkLayout utilities: getLayoutBounds, radialLayout.
 * Imports from elkLayoutUtils (no import.meta) so we test the real implementation.
 * debouncedElkLayout/cancelPendingLayout are covered by UnifiedSearchModal integration.
 */

const {
  NODE_SIZES,
  getLayoutBounds,
  radialLayout
} = require('../src/renderer/utils/elkLayoutUtils');

describe('elkLayout', () => {
  const makeNodes = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: `n${i}`,
      type: 'fileNode',
      position: { x: 0, y: 0 }
    }));

  describe('getLayoutBounds', () => {
    test('returns empty bounds for empty nodes', () => {
      const bounds = getLayoutBounds([]);
      expect(bounds).toEqual({
        minX: 0,
        minY: 0,
        maxX: 0,
        maxY: 0,
        width: 0,
        height: 0
      });
    });

    test('returns empty bounds for null/undefined', () => {
      expect(getLayoutBounds(null)).toEqual({
        minX: 0,
        minY: 0,
        maxX: 0,
        maxY: 0,
        width: 0,
        height: 0
      });
      expect(getLayoutBounds(undefined)).toEqual({
        minX: 0,
        minY: 0,
        maxX: 0,
        maxY: 0,
        width: 0,
        height: 0
      });
    });

    test('computes bounding box for positioned nodes', () => {
      const nodes = [
        { id: 'a', position: { x: 10, y: 20 }, type: 'fileNode' },
        { id: 'b', position: { x: 100, y: 50 }, type: 'fileNode' }
      ];
      const bounds = getLayoutBounds(nodes);
      expect(bounds.minX).toBe(10);
      expect(bounds.minY).toBe(20);
      expect(bounds.maxX).toBe(100 + 240); // fileNode width 240
      expect(bounds.maxY).toBe(50 + 124); // fileNode height 124
      expect(bounds.width).toBe(330);
      expect(bounds.height).toBe(154);
    });

    test('uses default size for unknown node types', () => {
      const nodes = [{ id: 'x', position: { x: 0, y: 0 }, type: 'unknown' }];
      const bounds = getLayoutBounds(nodes);
      expect(bounds.width).toBe(230);
      expect(bounds.height).toBe(110);
    });
  });

  describe('radialLayout', () => {
    test('returns empty array for empty nodes', () => {
      const result = radialLayout(null, []);
      expect(result).toEqual([]);
    });

    test('returns empty for null/undefined nodes', () => {
      expect(radialLayout(null, null)).toEqual([]);
      expect(radialLayout(null, undefined)).toEqual([]);
    });

    test('positions nodes in radial pattern', () => {
      const nodes = makeNodes(3);
      const result = radialLayout(null, nodes, { radius: 100 });
      expect(result).toHaveLength(3);
      result.forEach((n) => {
        expect(n.position).toBeDefined();
        expect(typeof n.position.x).toBe('number');
        expect(typeof n.position.y).toBe('number');
      });
    });

    test('uses center node position when provided', () => {
      const center = { id: 'c', position: { x: 500, y: 300 } };
      const nodes = makeNodes(1);
      const result = radialLayout(center, nodes, { radius: 50 });
      // startAngle 0 => (cX + radius, cY)
      expect(result[0].position.x).toBeCloseTo(550, 0);
      expect(result[0].position.y).toBeCloseTo(300, 0);
    });

    test('uses centerX/centerY override when provided', () => {
      const nodes = makeNodes(1);
      const result = radialLayout(null, nodes, { radius: 100, centerX: 400, centerY: 300 });
      // startAngle 0 => (centerX + radius, centerY)
      expect(result[0].position.x).toBeCloseTo(500, 0);
      expect(result[0].position.y).toBeCloseTo(300, 0);
    });
  });

  describe('NODE_SIZES', () => {
    test('has expected node type sizes', () => {
      expect(NODE_SIZES.queryNode).toEqual({ width: 240, height: 92 });
      expect(NODE_SIZES.fileNode).toEqual({ width: 240, height: 124 });
      expect(NODE_SIZES.folderNode).toEqual({ width: 240, height: 96 });
      expect(NODE_SIZES.clusterNode).toEqual({ width: 190, height: 190 });
      expect(NODE_SIZES.default).toEqual({ width: 230, height: 110 });
    });
  });
});
