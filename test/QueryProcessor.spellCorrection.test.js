/**
 * Spell correction must not replace correctly spelled words.
 *
 * Uses the real wink-nlp English model (QueryProcessor.test.js mocks it) so
 * the lexicon check runs against the shipped vocabulary.
 */

jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

const { QueryProcessor, resetInstance } = require('../src/main/services/QueryProcessor');

describe('QueryProcessor spell correction keeps real words', () => {
  let processor;

  beforeEach(() => {
    resetInstance();
    processor = new QueryProcessor();
  });

  afterEach(() => {
    processor.cleanup();
    resetInstance();
  });

  test.each([
    ['audit', 'audio'],
    ['protect', 'project'],
    ['personality', 'presentation']
  ])('does not correct the English word "%s" to "%s"', (word) => {
    expect(processor._correctSpelling(word)).toBe(word);
  });

  test('still corrects a real typo', () => {
    expect(processor._correctSpelling('vacaton')).toBe('vacation');
  });

  test('a typo the model has already read is still a typo', async () => {
    // Reading text adds its unknown words to wink's runtime lexicon; those
    // must not count as English.
    await processor._getSynonyms('vacaton');
    expect(processor._correctSpelling('vacaton')).toBe('vacation');
  });

  test('a Soundex match alone does not correct a word', () => {
    // Without the lexicon only the edit-distance gate is left: "personality"
    // shares Soundex P625 with "presentation" but is far more than 2 edits away.
    processor._getNlp = () => null;
    expect(processor._soundex('personality')).toBe(processor._soundex('presentation'));
    expect(processor._correctSpelling('personality')).toBe('personality');
  });

  test('a search for an English word sends it unchanged', async () => {
    const result = await processor.processQuery('protect audit', {
      expandSynonyms: false,
      correctSpelling: true
    });

    expect(result.corrections).toEqual([]);
    expect(result.corrected).toBe('protect audit');
    expect(result.expanded.split(' ')).toEqual(['protect', 'audit']);
  });

  test('the keyword query keeps the typed term next to its correction', async () => {
    const result = await processor.processQuery('vacaton', {
      expandSynonyms: false,
      correctSpelling: true
    });

    expect(result.corrected).toBe('vacation');
    expect(result.expanded.split(' ')).toEqual(expect.arrayContaining(['vacaton', 'vacation']));
  });
});
