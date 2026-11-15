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

describe('QueryProcessor spell correction checks the indexed vocabulary', () => {
  let processor;

  beforeEach(() => {
    resetInstance();
    processor = new QueryProcessor();
  });

  afterEach(() => {
    processor.cleanup();
    resetInstance();
  });

  test('does not correct a word that occurs in the indexed files', async () => {
    // "budgen" is one edit from the domain word "budget" and is not English,
    // but here it is a surname in the user's files.
    const isIndexedTerm = (word) => word === 'budgen';
    expect(processor._correctSpelling('budgen', isIndexedTerm)).toBe('budgen');

    const result = await processor.processQuery('Budgen projekt', {
      expandSynonyms: false,
      correctSpelling: true,
      isIndexedTerm: (word) => word === 'budgen' || word === 'projekt'
    });
    expect(result.corrections).toEqual([]);
    expect(result.corrected).toBe('Budgen projekt');
  });

  test('prefers a correction that occurs in the indexed files', () => {
    processor.domainWords.add('marker');
    processor.domainWords.add('market');

    expect(processor._correctSpelling('markex')).toBe('marker');
    expect(processor._correctSpelling('markex', (word) => word === 'market')).toBe('market');
  });

  test('keeps the index-free behavior when the index cannot answer', () => {
    expect(processor._correctSpelling('budgen', () => null)).toBe('budget');
    expect(
      processor._correctSpelling('budgen', () => {
        throw new Error('index not ready');
      })
    ).toBe('budget');
  });
});
