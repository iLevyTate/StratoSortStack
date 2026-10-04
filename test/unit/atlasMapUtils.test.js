const { LIMITS } = require('../../src/shared/performanceConstants');
const {
  buildCategories,
  pickNextPointInDirection,
  ARROW_DIRECTIONS,
  ATLAS_PALETTE,
  ATLAS_OTHER_COLOR,
  ATLAS_KIND_COLORS,
  ATLAS_SEARCH_TOP_K,
  atlasIpcFailureMessage
} = require('../../src/renderer/components/search/atlasMapUtils');

describe('atlasMapUtils', () => {
  describe('buildCategories', () => {
    test('kind mode maps files and folders to the two kind colours', () => {
      const points = {
        kinds: ['file', 'folder', 'file'],
        folderKeys: ['a', 'b', 'a'],
        tagKeys: ['', '', '']
      };
      const { categoryIndex, palette, legend } = buildCategories(points, 'kind');
      expect(categoryIndex).toEqual([0, 1, 0]);
      expect(palette).toEqual(ATLAS_KIND_COLORS);
      expect(legend.map((l) => l.label)).toEqual(['Files', 'Folders']);
    });

    test('folder mode ranks frequent folders first and buckets the tail into Other', () => {
      const folderKeys = [
        ...Array(5).fill('big'),
        ...Array(ATLAS_PALETTE.length)
          .fill(0)
          .map((_, i) => `tail-${i}`),
        ...Array(3).fill('medium')
      ];
      const points = {
        kinds: folderKeys.map(() => 'file'),
        folderKeys,
        tagKeys: folderKeys.map(() => '')
      };
      const { categoryIndex, palette, legend } = buildCategories(points, 'folder');
      expect(legend[0].label).toBe('big');
      expect(legend[1].label).toBe('medium');
      expect(legend[legend.length - 1]).toEqual({ label: 'Other', color: ATLAS_OTHER_COLOR });
      expect(palette).toHaveLength(ATLAS_PALETTE.length + 1);
      // Every "big" point shares the top category index.
      expect(new Set(categoryIndex.slice(0, 5)).size).toBe(1);
    });

    test('tag mode reads tagKeys and maps empty tags to (none)', () => {
      const points = {
        kinds: ['file', 'file'],
        folderKeys: ['x', 'y'],
        tagKeys: ['', 'invoice']
      };
      const { legend } = buildCategories(points, 'tag');
      expect(legend.map((l) => l.label).sort()).toEqual(['(none)', 'invoice']);
    });

    test('category mode groups by categoryKeys (smart folder / AI category), not source folder', () => {
      const points = {
        kinds: ['file', 'file', 'file'],
        folderKeys: ['Downloads', 'TEMP', 'Downloads'],
        categoryKeys: ['Work', 'Work', 'Financial'],
        tagKeys: ['', '', '']
      };
      const { categoryIndex, legend } = buildCategories(points, 'category');
      // Buckets come from categoryKeys (Work x2, Financial x1), NOT the raw
      // source directories the user complained about.
      expect(legend.map((l) => l.label)).toEqual(['Work', 'Financial']);
      expect(categoryIndex[0]).toBe(categoryIndex[1]); // both Work
      expect(categoryIndex[2]).not.toBe(categoryIndex[0]); // Financial distinct
    });

    test('topics mode groups by clusterKeys', () => {
      const points = {
        kinds: ['file', 'file'],
        folderKeys: ['a', 'b'],
        categoryKeys: ['x', 'y'],
        clusterKeys: ['Trading algorithms', 'Trading algorithms'],
        tagKeys: ['', '']
      };
      const { categoryIndex, legend } = buildCategories(points, 'topics');
      expect(legend.map((l) => l.label)).toEqual(['Trading algorithms']);
      expect(categoryIndex[0]).toBe(categoryIndex[1]);
    });

    test('category mode falls back to source folders when categoryKeys is absent (old cache)', () => {
      const points = {
        kinds: ['file', 'file'],
        folderKeys: ['Downloads', 'Documents'],
        tagKeys: ['', '']
        // no categoryKeys — projection cached before the field existed
      };
      const { legend } = buildCategories(points, 'category');
      expect(legend.map((l) => l.label).sort()).toEqual(['Documents', 'Downloads']);
    });
  });

  describe('pickNextPointInDirection', () => {
    //    2 (0, 1)
    //    0 (0, 0)   1 (0.5, 0)        3 (1, 0)
    //    4 (0, -1)
    const pts = [
      [0, 0],
      [0.5, 0],
      [0, 1],
      [1, 0],
      [0, -1]
    ];

    test('moves to the nearest point in each arrow direction', () => {
      expect(pickNextPointInDirection(pts, 0, ARROW_DIRECTIONS.ArrowRight)).toBe(1);
      expect(pickNextPointInDirection(pts, 0, ARROW_DIRECTIONS.ArrowUp)).toBe(2);
      expect(pickNextPointInDirection(pts, 0, ARROW_DIRECTIONS.ArrowDown)).toBe(4);
      expect(pickNextPointInDirection(pts, 1, ARROW_DIRECTIONS.ArrowRight)).toBe(3);
    });

    test('ignores points behind the arrow direction', () => {
      expect(pickNextPointInDirection(pts, 3, ARROW_DIRECTIONS.ArrowRight)).toBe(-1);
      expect(pickNextPointInDirection(pts, 2, ARROW_DIRECTIONS.ArrowUp)).toBe(-1);
    });

    test('returns -1 when there is nowhere to go', () => {
      expect(pickNextPointInDirection([[0, 0]], 0, ARROW_DIRECTIONS.ArrowLeft)).toBe(-1);
    });

    test('prefers an aligned farther point over a nearer far-off-axis one', () => {
      // Index 1 is closer (0.36 vs 0.5) but ~74 degrees off the arrow; the
      // angular penalty makes the on-axis point 2 win.
      const drift = [
        [0, 0],
        [0.1, 0.35],
        [0.5, 0]
      ];
      expect(pickNextPointInDirection(drift, 0, ARROW_DIRECTIONS.ArrowRight)).toBe(2);
    });

    test('a lone off-axis point is still reachable (tolerance floor)', () => {
      const lone = [
        [0, 0],
        [0.05, 0.9]
      ];
      expect(pickNextPointInDirection(lone, 0, ARROW_DIRECTIONS.ArrowRight)).toBe(1);
    });
  });

  describe('ATLAS_SEARCH_TOP_K', () => {
    test('stays within the embeddings:search Zod cap', () => {
      expect(ATLAS_SEARCH_TOP_K).toBe(LIMITS.MAX_TOP_K);
      expect(ATLAS_SEARCH_TOP_K).toBeLessThanOrEqual(100);
    });
  });

  describe('atlasIpcFailureMessage', () => {
    test('formats a structured IPC error envelope instead of [object Object]', () => {
      const envelope = {
        success: false,
        error: { code: 'UNKNOWN_ERROR', message: 'Invalid input' }
      };
      expect(atlasIpcFailureMessage(envelope, 'Search')).toBe('Invalid input');
      expect(atlasIpcFailureMessage(envelope.error, 'Search')).toBe('Invalid input');
    });

    test('formats a bulk-tag error object as its message', () => {
      expect(atlasIpcFailureMessage({ code: 'TAG_FAILED', message: 'Tag too long' }, 'Tags')).toBe(
        'Tag too long'
      );
    });
  });
});
