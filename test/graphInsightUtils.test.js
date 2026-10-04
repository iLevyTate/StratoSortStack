const {
  scoreBridgeConnection,
  scoreClusterForInsight,
  compareClustersForInsight,
  isCrossClusterSurprise,
  rankCrossClusterConnections,
  sortClustersForInsight,
  pickSurpriseConnections
} = require('../src/renderer/components/search/utils/graphInsightUtils');

describe('graphInsightUtils', () => {
  test('scoreBridgeConnection prefers bridge files and surprise', () => {
    const plain = scoreBridgeConnection({ similarity: 0.8, bridgeFiles: [], sharedTerms: [] });
    const rich = scoreBridgeConnection({
      similarity: 0.8,
      bridgeFiles: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      sharedTerms: ['edi'],
      isSurprise: true
    });
    expect(rich).toBeGreaterThan(plain);
  });

  test('scoreClusterForInsight boosts clusters without dominant folder', () => {
    const mapped = scoreClusterForInsight({ data: { memberCount: 5, dominantFolderName: 'Docs' } });
    const scattered = scoreClusterForInsight({ data: { memberCount: 5, dominantFolderName: '' } });
    expect(scattered).toBeGreaterThan(mapped);
  });

  test('compareClustersForInsight sorts by score descending', () => {
    const nodes = [
      { id: 'a', data: { memberCount: 2 } },
      { id: 'b', data: { memberCount: 10 } }
    ];
    const sorted = [...nodes].sort(compareClustersForInsight);
    expect(sorted[0].id).toBe('b');
  });

  test('isCrossClusterSurprise detects folder mismatch', () => {
    const clustersById = new Map([
      ['c1', { data: { dominantFolderName: 'Printing' } }],
      ['c2', { data: { dominantFolderName: 'EDI' } }]
    ]);
    const edge = { source: 'c1', target: 'c2', data: { similarity: 0.9 } };
    expect(isCrossClusterSurprise(edge, clustersById)).toBe(true);
  });

  test('rankCrossClusterConnections sorts by bridge score', () => {
    const clustersById = new Map();
    const crossEdges = [
      { id: 'e1', source: 'a', target: 'b', data: { similarity: 0.7, bridgeFiles: [] } },
      {
        id: 'e2',
        source: 'c',
        target: 'd',
        data: { similarity: 0.75, bridgeFiles: [{ id: 'f1' }, { id: 'f2' }] }
      }
    ];
    const ranked = rankCrossClusterConnections(crossEdges, clustersById, (e) => ({
      id: e.id,
      similarity: e.data.similarity,
      bridgeFiles: e.data.bridgeFiles || [],
      sharedTerms: []
    }));
    expect(ranked[0].id).toBe('e2');
    expect(ranked[0].isSurprise).toBe(false);
  });

  test('pickSurpriseConnections filters surprise rows', () => {
    const rows = [
      { id: '1', isSurprise: false },
      { id: '2', isSurprise: true },
      { id: '3', isSurprise: true }
    ];
    expect(pickSurpriseConnections(rows, 1)).toEqual([{ id: '2', isSurprise: true }]);
  });

  test('sortClustersForInsight respects limit', () => {
    const nodes = Array.from({ length: 10 }, (_, i) => ({
      id: `n${i}`,
      data: { memberCount: i }
    }));
    expect(sortClustersForInsight(nodes, 3)).toHaveLength(3);
  });
});
