/**
 * @jest-environment node
 *
 * The analysis -> watcher hand-off: its flags describe one run, so what an
 * analysis cache stores must not carry them.
 */

const { getEmbeddingHandoff, forAnalysisCache } = require('../src/main/analysis/embeddingHandoff');

describe('embeddingHandoff', () => {
  test('finds the hand-off on a flat or a nested analysis result', () => {
    const handoff = { wasEnqueued: true };
    expect(getEmbeddingHandoff({ _embeddingForPersistence: handoff })).toBe(handoff);
    expect(getEmbeddingHandoff({ analysis: { _embeddingForPersistence: handoff } })).toBe(handoff);
    expect(getEmbeddingHandoff({ analysis: {} })).toBeNull();
    expect(getEmbeddingHandoff(null)).toBeNull();
  });

  test('the cached copy keeps the vector but drops the this-run flags', () => {
    const live = {
      category: 'Docs',
      _embeddingForPersistence: {
        vector: [0.1, 0.2],
        model: 'm',
        meta: { path: '/a.pdf' },
        wasEnqueued: true,
        chunksEmbedded: true
      }
    };

    const cached = forAnalysisCache(live);

    expect(cached).toEqual({
      category: 'Docs',
      _embeddingForPersistence: {
        vector: [0.1, 0.2],
        model: 'm',
        meta: { path: '/a.pdf' },
        wasEnqueued: false,
        chunksEmbedded: false
      }
    });
    // The caller still holds the live result and reads the flags from it.
    expect(live._embeddingForPersistence.wasEnqueued).toBe(true);
    expect(live._embeddingForPersistence.chunksEmbedded).toBe(true);
  });

  test('results without a hand-off are cached as they are', () => {
    const plain = { category: 'Docs' };
    expect(forAnalysisCache(plain)).toBe(plain);
    expect(forAnalysisCache(null)).toBeNull();
  });
});
