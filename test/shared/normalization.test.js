const {
  normalizeText,
  normalizeKeywords,
  normalizeError,
  normalizeEmbeddingMetadata
} = require('../../src/shared/normalization');
const { embeddingMetaSchema, validateSchema } = require('../../src/shared/normalization/schemas');

describe('shared normalization', () => {
  test('normalizeText trims, collapses whitespace, and removes null bytes', () => {
    const input = '  hello\u0000   world \n';
    const output = normalizeText(input);
    expect(output).toBe('hello world');
  });

  test('normalizeText respects maxLength', () => {
    const input = 'abcde';
    const output = normalizeText(input, { maxLength: 3 });
    expect(output).toBe('abc');
  });

  test('normalizeKeywords deduplicates and trims', () => {
    const output = normalizeKeywords(['  Foo ', 'foo', 'Bar', '', 'Bar '], { max: 5 });
    expect(output).toEqual(['Foo', 'Bar']);
  });

  test('normalizeError classifies timeout errors', () => {
    const result = normalizeError(new Error('Request timed out'));
    expect(result.errorType).toBe('TIMEOUT');
    expect(result.isRetryable).toBe(true);
  });

  test('normalizeEmbeddingMetadata sanitizes and preserves path', () => {
    const meta = normalizeEmbeddingMetadata({
      path: 'C:\\Temp\\file.txt',
      name: 'file.txt',
      tags: ['one', 'one', 'two']
    });
    expect(meta.path).toBeTruthy();
    expect(meta.name).toBe('file.txt');
    expect(meta.tags).toContain('one');
  });

  test('embedding metadata schema validation handles optional fields', () => {
    const meta = { path: 'C:\\Temp\\file.txt', name: 'file.txt' };
    const result = validateSchema(embeddingMetaSchema, meta);
    expect(result.valid).toBe(true);
  });
});
