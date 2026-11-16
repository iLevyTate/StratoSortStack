/**
 * @jest-environment node
 *
 * The chat IPC schema and the renderer allow 1000 scoped documents, but
 * context scoring used to stop at 200, so in Strict scope files 201+ were
 * never searched.
 */

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};
jest.mock('../src/shared/logger', () => ({
  createLogger: () => mockLogger
}));

const ChatService = require('../src/main/services/ChatService');

function makeService() {
  const vectorDbService = {
    initialize: jest.fn(async () => undefined),
    getCollectionDimension: jest.fn(async () => 2),
    // Only the last selected file is on topic.
    getFile: jest.fn(async (id) => ({
      filePath: `/${id}.txt`,
      fileName: `${id}.txt`,
      embedding: id === 'f1000' ? [1, 0] : [0, 1]
    }))
  };
  const embeddingService = { embedText: jest.fn(async () => ({ vector: [1, 0] })) };
  const service = new ChatService({
    searchService: { hybridSearch: jest.fn() },
    vectorDbService,
    embeddingService,
    chatHistoryStore: null
  });
  return { service, vectorDbService };
}

const ids = (n) => Array.from({ length: n }, (_, i) => `f${i + 1}`);

describe('ChatService context-file limit', () => {
  beforeEach(() => jest.clearAllMocks());

  test('scores all 1000 files the IPC schema allows', async () => {
    const { service, vectorDbService } = makeService();

    const scored = await service._retrieval.scoreContextFiles('pets', ids(1000));

    expect(vectorDbService.getFile).toHaveBeenCalledTimes(1000);
    expect(scored.find((r) => r.id === 'f1000')?.score).toBeCloseTo(1);
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('over the limit'),
      expect.anything()
    );
  });

  test('logs when a scope over the limit is truncated', async () => {
    const { service, vectorDbService } = makeService();

    await service._retrieval.scoreContextFiles('pets', ids(1005));

    expect(vectorDbService.getFile).toHaveBeenCalledTimes(1000);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('over the limit'),
      expect.objectContaining({ requested: 1005, limit: 1000 })
    );
  });
});
