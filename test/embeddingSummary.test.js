jest.mock('../src/main/utils/embeddingInput', () => ({
  capEmbeddingInput: jest.fn((text) => text),
  getEmbeddingTokenLimit: jest.fn(() => 512)
}));

jest.mock('../src/main/analysis/semanticExtensionMap', () => ({
  enrichFileTextForEmbedding: jest.fn((text, ext) => `${text}::${ext}`)
}));

const { buildEmbeddingSummary } = require('../src/main/analysis/embeddingSummary');

describe('embeddingSummary', () => {
  test('buildEmbeddingSummary combines analysis and extracted text', () => {
    const analysis = {
      summary: 'Summary',
      keywords: ['a', 'b'],
      keyEntities: ['x']
    };
    const result = buildEmbeddingSummary(analysis, 'Extracted text', '.pdf', 'document');
    expect(result).toContain('Summary');
    expect(result).toContain('a b');
    expect(result).toContain('Extracted text');
  });

  // History rows store the live `keywords` as `tags`. Rebuild, move and
  // backfill embed from history, so the builder must read either, or a rebuilt
  // vector silently loses every keyword the live one had (CP-14).
  test('a history row (tags) embeds the same text as the live analysis (keywords)', () => {
    const shared = { summary: 'Lease renewal terms', entity: 'Acme Properties' };
    const live = buildEmbeddingSummary(
      { ...shared, keywords: ['lease', 'renewal', 'rent'] },
      'Body text',
      '.pdf',
      'document'
    );
    const fromHistory = buildEmbeddingSummary(
      { ...shared, tags: ['lease', 'renewal', 'rent'] },
      'Body text',
      '.pdf',
      'document'
    );
    expect(fromHistory).toEqual(live);
    expect(fromHistory).toContain('lease renewal rent');
  });
});
