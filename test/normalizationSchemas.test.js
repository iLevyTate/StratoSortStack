const {
  analysisResultSchema,
  embeddingMetaSchema,
  chunkMetaSchema,
  validateSchema
} = require('../src/shared/normalization/schemas');

describe('normalization/schemas', () => {
  test('validateSchema returns valid for null schema', () => {
    const result = validateSchema(null, { a: 1 });
    expect(result.valid).toBe(true);
  });

  test('analysisResultSchema accepts optional fields', () => {
    const result = validateSchema(analysisResultSchema, { category: 'docs', confidence: 0.5 });
    expect(result.valid).toBe(true);
  });

  test('embeddingMetaSchema allows extra keys', () => {
    const result = validateSchema(embeddingMetaSchema, { path: 'x', extra: 'y' });
    expect(result.valid).toBe(true);
  });

  test('chunkMetaSchema validates fileId', () => {
    const result = validateSchema(chunkMetaSchema, { fileId: 'file-1', chunkIndex: 1 });
    expect(result.valid).toBe(true);
  });

  // F-203 (K-29): the history writer reads these from the validated result;
  // an undeclared key is stripped by Zod, so they silently became null.
  test('analysisResultSchema keeps the organization/provenance fields the history writer reads', () => {
    const input = {
      category: 'docs',
      suggestedPath: 'C:/out/a.pdf',
      actualPath: 'C:/out/a.pdf',
      errorCount: 2,
      warnings: ['w1'],
      embeddingModel: 'nomic',
      provisional: true,
      provisionalRetries: 1,
      fallbackReason: 'model missing'
    };
    const result = validateSchema(analysisResultSchema, input);
    expect(result.valid).toBe(true);
    expect(result.data).toEqual(expect.objectContaining(input));
  });
});
