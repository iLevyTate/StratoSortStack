const {
  isGenericClusterLabel,
  deriveClusterDisplayLabel
} = require('../src/shared/clusterDisplayLabel');

describe('clusterDisplayLabel', () => {
  describe('isGenericClusterLabel', () => {
    test('treats Cluster N patterns as generic', () => {
      expect(isGenericClusterLabel('Cluster 3')).toBe(true);
      expect(isGenericClusterLabel('cluster 12')).toBe(true);
      expect(isGenericClusterLabel('Cluster #4')).toBe(true);
    });

    test('keeps descriptive labels', () => {
      expect(isGenericClusterLabel('Q4 Financial Reports')).toBe(false);
      expect(isGenericClusterLabel('Help, Issues & Https')).toBe(false);
    });
  });

  describe('deriveClusterDisplayLabel', () => {
    test('replaces generic stored label with top terms', () => {
      expect(
        deriveClusterDisplayLabel({
          label: 'Cluster 3',
          topTerms: ['help', 'https', 'issues']
        })
      ).toBe('Help, Https & Issues');
    });

    test('preserves user or LLM labels', () => {
      expect(
        deriveClusterDisplayLabel({
          label: 'Next.js Documentation',
          topTerms: ['next', 'docs']
        })
      ).toBe('Next.js Documentation');
    });

    test('falls back to dominant category then topic group', () => {
      expect(
        deriveClusterDisplayLabel({
          label: 'Cluster 1',
          dominantCategory: 'Finance'
        })
      ).toBe('Finance');

      expect(
        deriveClusterDisplayLabel({
          label: 'Cluster 2',
          clusterId: 1
        })
      ).toBe('Topic group 2');
    });
  });
});
