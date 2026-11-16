/**
 * Spell correction checks query words against the BM25 index vocabulary:
 * a word the user's files contain (a surname, a project name) is never
 * "corrected" away.
 *
 * Uses a real Orama index and the real QueryProcessor (with the shipped
 * wink-nlp model) so the lookup runs against the same tokens BM25 matches.
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

const { SearchService } = require('../src/main/services/SearchService');
const { QueryProcessor, resetInstance } = require('../src/main/services/QueryProcessor');

function createService(queryProcessor) {
  const analysisHistoryService = {
    initialize: jest.fn().mockResolvedValue(undefined),
    analysisHistory: {
      metadata: { totalEntries: 1 },
      entries: {
        e1: {
          id: 'e1',
          originalPath: '/docs/letter.pdf',
          fileName: 'letter.pdf',
          timestamp: '2026-01-01T00:00:00.000Z',
          analysis: {
            subject: 'Letter from Budgen',
            summary: 'Budgen asks about the Kubernetes rollout',
            tags: ['correspondence'],
            extractedText: 'Dear team, Budgen here about the Kubernetes rollout.'
          }
        }
      }
    }
  };
  const service = new SearchService({
    vectorDbService: { getStats: jest.fn().mockResolvedValue({ files: 0, fileChunks: 0 }) },
    analysisHistoryService,
    parallelEmbeddingService: { embedText: jest.fn() },
    queryProcessor
  });
  service._validateFileExistence = jest.fn(async (results) => ({
    validResults: results,
    ghostCount: 0
  }));
  return service;
}

describe('SearchService spell correction uses the index vocabulary', () => {
  let processor;

  beforeEach(() => {
    resetInstance();
    processor = new QueryProcessor();
  });

  afterEach(() => {
    processor.cleanup();
    resetInstance();
  });

  test('isIndexedTerm answers from the BM25 index and is null before it is built', async () => {
    const service = createService(processor);
    expect(service.isIndexedTerm('budgen')).toBeNull();

    await service.buildBM25Index();

    expect(service.isIndexedTerm('Budgen')).toBe(true);
    expect(service.isIndexedTerm('kubernetes')).toBe(true);
    expect(service.isIndexedTerm('budget')).toBe(false);
  });

  test('a word that occurs in the indexed files is not corrected', async () => {
    const service = createService(processor);
    await service.buildBM25Index();

    // Without the index check "budgen" is corrected to the domain word "budget".
    expect(processor._correctSpelling('budgen')).toBe('budget');

    const result = await service.hybridSearch('budgen', {
      mode: 'bm25',
      correctSpelling: true,
      expandSynonyms: false
    });

    expect(result.success).toBe(true);
    expect(result.queryMeta.corrections).toEqual([]);
    expect(result.queryMeta.corrected).toBe('budgen');
    expect(result.results.map((r) => r.id)).toHaveLength(1);
  });
});
