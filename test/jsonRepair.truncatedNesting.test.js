/**
 * A model answer cut off at the output-token cap ends inside nested
 * structures. repairJSON must close them innermost-first, or the repaired
 * text never parses and chat shows the raw JSON fragment to the user.
 */
jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })
}));

const { extractAndParseJSON, repairJSON } = require('../src/main/utils/jsonRepair');
const { parseResponse } = require('../src/main/services/chat/CitationExtractor');

describe('repairJSON closes truncated nesting innermost-first', () => {
  test('cut inside a string inside an object inside an array', () => {
    const cut = '{"documentAnswer":[],"modelAnswer":[{"text":"The lease allows one cat and';
    expect(JSON.parse(repairJSON(cut))).toEqual({
      documentAnswer: [],
      modelAnswer: [{ text: 'The lease allows one cat and' }]
    });
  });

  test('cut right after a complete array item keeps the complete items', () => {
    const cut = '{"modelAnswer":[{"text":"first"},{"text":"second"},';
    expect(JSON.parse(repairJSON(cut))).toEqual({
      modelAnswer: [{ text: 'first' }, { text: 'second' }]
    });
  });

  test('cut after a dangling object key drops the key', () => {
    const cut = '{"modelAnswer":[{"text":"first"},{"text":';
    expect(extractAndParseJSON(cut)).toEqual({ modelAnswer: [{ text: 'first' }, {}] });
  });

  test('cut in the middle of an object key drops the partial key', () => {
    const cut = '{"modelAnswer":[{"text":"first"}],"follo';
    expect(extractAndParseJSON(cut)).toEqual({ modelAnswer: [{ text: 'first' }] });
  });

  test('a cut-off string value in an array is kept', () => {
    const cut = '{"followUps":["What about dogs?","And bir';
    expect(extractAndParseJSON(cut)).toEqual({ followUps: ['What about dogs?', 'And bir'] });
  });

  test('balanced JSON is unchanged', () => {
    const ok = '{"a":[{"b":"c"}],"d":{"e":[1,2]}}';
    expect(repairJSON(ok)).toBe(ok);
  });
});

describe('CitationExtractor.parseResponse on a cut-off local answer', () => {
  test('shows the answer text, not the raw JSON fragment', () => {
    const cut =
      '{"documentAnswer":[{"text":"Pets are limited [doc-1].","citations":["doc-1"]}],"modelAnswer":[{"text":"The lease allows one cat and';
    const parsed = parseResponse(cut, [{ id: 'doc-1' }]);
    expect(parsed.documentAnswer).toEqual([
      { text: 'Pets are limited [doc-1].', citations: ['doc-1'] }
    ]);
    expect(parsed.modelAnswer).toEqual([{ text: 'The lease allows one cat and' }]);
  });
});
