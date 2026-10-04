/**
 * @jest-environment node
 */

const {
  buildNamingBm25Query,
  fetchNamingContextFromBm25
} = require('../../src/main/analysis/namingContextBm25');

describe('namingContextBm25', () => {
  describe('buildNamingBm25Query', () => {
    it('uses basename stem and snippet', () => {
      const q = buildNamingBm25Query('/data/foo/bar_Report_v2.pdf', 'alpha beta gamma');
      expect(q).toContain('Report_v2');
      expect(q).toContain('alpha beta gamma');
    });

    it('returns empty for empty inputs', () => {
      expect(buildNamingBm25Query('', '')).toBe('');
    });
  });

  describe('fetchNamingContextFromBm25', () => {
    it('returns [] when searchService missing', async () => {
      await expect(fetchNamingContextFromBm25(null, { fileName: 'a.pdf' })).resolves.toEqual([]);
    });

    it('maps hits to unique names excluding current file', async () => {
      const searchService = {
        isIndexStale: jest.fn().mockReturnValue(true),
        buildBM25Index: jest.fn().mockResolvedValue(undefined),
        bm25Search: jest
          .fn()
          .mockResolvedValue([
            { metadata: { name: 'current.pdf' } },
            { metadata: { name: 'Other_A.pdf' } },
            { metadata: { name: 'Other_B.pdf' } },
            { metadata: { name: 'Other_A.pdf' } }
          ])
      };
      const names = await fetchNamingContextFromBm25(searchService, {
        fileName: 'current.pdf',
        textSnippet: 'hello',
        topK: 2
      });
      expect(names).toEqual(['Other_A.pdf', 'Other_B.pdf']);
      expect(searchService.bm25Search).toHaveBeenCalled();
      expect(searchService.buildBM25Index).toHaveBeenCalled();
    });

    it('skips buildBM25Index when index is fresh', async () => {
      const searchService = {
        isIndexStale: jest.fn().mockReturnValue(false),
        bm25Index: {},
        buildBM25Index: jest.fn().mockResolvedValue(undefined),
        bm25Search: jest.fn().mockResolvedValue([{ metadata: { name: 'x.pdf' } }])
      };
      await fetchNamingContextFromBm25(searchService, { fileName: 'y.pdf', textSnippet: 'z' });
      expect(searchService.buildBM25Index).not.toHaveBeenCalled();
      expect(searchService.bm25Search).toHaveBeenCalled();
    });
  });
});
