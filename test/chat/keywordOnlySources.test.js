/**
 * Keyword-only chat sources (BM25 fallback when the embedding model is
 * unavailable, or a hybrid hit no vector leg found) have no semantic score.
 * They used to be stamped semanticScore 0, so the prompt told the model the
 * source was "(semantic relevance: 0%)" and withheld its text. They must be
 * labelled as keyword matches, carry their text under the extract gate, and
 * never get a made-up semantic score.
 */
jest.mock('../../src/shared/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })
}));

const { RetrievalEngine } = require('../../src/main/services/chat/RetrievalEngine');
const { buildPrompt } = require('../../src/main/services/chat/PromptBuilder');

function engineReturning(searchResult) {
  const searchService = {
    hybridSearch: jest.fn(async () => ({ success: true, ...searchResult })),
    chunkSearch: jest.fn(async () => [])
  };
  return new RetrievalEngine({
    searchService,
    vectorDbService: null,
    embeddingService: null,
    settingsService: null,
    defaults: { topK: 5, chunkTopK: 6, contextFileLimit: 200 }
  });
}

async function promptFor(searchResult) {
  const engine = engineReturning(searchResult);
  const { sources } = await engine.retrieveSources('total income 2024', {
    topK: 5,
    mode: 'hybrid',
    chunkTopK: 6
  });
  const { prompt } = buildPrompt({ query: 'total income 2024', history: '', sources });
  return { sources, prompt };
}

const TAX_TEXT = 'Form 1040 Total income 84,210';

describe('keyword-only chat sources', () => {
  test('bm25-fallback hits are keyword matches with their text in the prompt', async () => {
    const { sources, prompt } = await promptFor({
      mode: 'bm25-fallback',
      meta: { fallback: true, fallbackReason: 'query embedding unavailable' },
      results: [
        {
          id: 'f1',
          score: 7.8,
          source: 'bm25',
          metadata: { name: 'tax.pdf', extractedText: TAX_TEXT }
        },
        { id: 'f2', score: 3.9, source: 'bm25', metadata: { name: 'notes.txt' } }
      ]
    });

    expect(sources[0].semanticScore).toBeNull();
    expect(sources[0].keywordRelevance).toBe(1);
    expect(sources[1].keywordRelevance).toBeCloseTo(0.5);
    expect(prompt).not.toMatch(/semantic relevance: 0%/);
    expect(prompt).toMatch(/\[doc-1\] tax\.pdf \(Document\) {2}\(keyword match: 100%\)/);
    expect(prompt).toContain(TAX_TEXT);
  });

  test('hybrid hits found only by keyword use the normalized keyword score', async () => {
    const { sources, prompt } = await promptFor({
      mode: 'hybrid',
      results: [
        {
          id: 'f1',
          score: 0.8,
          metadata: { name: 'tax.pdf', extractedText: TAX_TEXT },
          matchDetails: {
            sources: ['bm25'],
            hybrid: { keywordScore: 0.8, keywordOnly: true, bm25RawScore: 6.1 }
          }
        }
      ]
    });

    expect(sources[0].semanticScore).toBeNull();
    expect(sources[0].keywordRelevance).toBe(0.8);
    expect(prompt).toMatch(/\(keyword match: 80%\)/);
    expect(prompt).not.toMatch(/semantic relevance: 0%/);
    expect(prompt).toContain(TAX_TEXT);
  });

  test('a weak keyword hit keeps metadata only', async () => {
    const { prompt } = await promptFor({
      mode: 'hybrid',
      results: [
        {
          id: 'f1',
          score: 0.35,
          metadata: { name: 'tax.pdf', extractedText: TAX_TEXT },
          matchDetails: { sources: ['bm25'], hybrid: { keywordScore: 0.35 } }
        }
      ]
    });
    expect(prompt).toMatch(/\(keyword match: 35%\)/);
    expect(prompt).not.toContain(TAX_TEXT);
  });

  test('semantic hits keep their raw cosine score and label', async () => {
    const { sources, prompt } = await promptFor({
      mode: 'hybrid',
      results: [
        {
          id: 'f1',
          score: 1,
          metadata: { name: 'tax.pdf', extractedText: TAX_TEXT },
          matchDetails: {
            sources: ['vector', 'bm25'],
            hybrid: { vectorRawScore: 0.72, keywordScore: 1 }
          }
        }
      ]
    });
    expect(sources[0].semanticScore).toBe(0.72);
    expect(sources[0].keywordRelevance).toBeNull();
    expect(prompt).toMatch(/\(semantic relevance: 72%\)/);
    expect(prompt).toContain(TAX_TEXT);
  });
});
