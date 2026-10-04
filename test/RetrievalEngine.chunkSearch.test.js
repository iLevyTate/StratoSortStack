/**
 * @jest-environment node
 */

const { RetrievalEngine } = require('../src/main/services/chat/RetrievalEngine');

describe('RetrievalEngine chunkSearch skip (SW-63)', () => {
  function makeEngine(searchService) {
    return new RetrievalEngine({
      searchService,
      vectorDbService: null,
      embeddingService: null,
      settingsService: { getAll: async () => ({}) },
      defaults: { chunkTopK: 80, topK: 8, mode: 'hybrid' }
    });
  }

  test('does not call chunkSearch when hybrid results already have snippets', async () => {
    const searchService = {
      hybridSearch: jest.fn(async () => ({
        success: true,
        results: [
          {
            id: 'file:1',
            score: 0.9,
            metadata: { path: '/a.txt', summary: 'sum' },
            matchDetails: { bestSnippet: 'already here' }
          }
        ]
      })),
      chunkSearch: jest.fn(async () => {
        throw new Error('should not run');
      }),
      enrichResults: jest.fn()
    };
    const engine = makeEngine(searchService);
    const { sources } = await engine.retrieveSources('query', { topK: 5, mode: 'hybrid' });
    expect(searchService.chunkSearch).not.toHaveBeenCalled();
    expect(sources[0].snippet).toBe('already here');
  });

  test('falls back to chunkSearch when hybrid results have no snippets', async () => {
    const searchService = {
      hybridSearch: jest.fn(async () => ({
        success: true,
        results: [{ id: 'file:1', score: 0.9, metadata: { path: '/a.txt' }, matchDetails: {} }]
      })),
      chunkSearch: jest.fn(async () => [
        { id: 'file:1', matchDetails: { contextSnippet: 'from chunks' } }
      ]),
      enrichResults: jest.fn()
    };
    const engine = makeEngine(searchService);
    const { sources } = await engine.retrieveSources('query', { topK: 5, mode: 'hybrid' });
    expect(searchService.chunkSearch).toHaveBeenCalledTimes(1);
    expect(sources[0].snippet).toBe('from chunks');
  });
});
