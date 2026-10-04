/**
 * `embedHistoryEntry` re-embeds a file from its STORED analysis (no LLM run):
 * the shared step behind the post-move re-embed and the startup backfill
 * (F-198). Same gate, same budget, same meta shape as a move.
 */
const mockEnqueue = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/main/analysis/embeddingQueue/stageQueues', () => ({
  organizeQueue: { enqueue: (...a) => mockEnqueue(...a), getStats: () => ({ capacityPercent: 0 }) },
  analysisQueue: { enqueue: jest.fn(), getStats: () => ({ capacityPercent: 0 }) }
}));
jest.mock('../src/main/analysis/embeddingQueue/queueManager', () => ({
  waitForOrganizeQueueCapacity: jest.fn().mockResolvedValue({ timedOut: false }),
  removeByFilePath: jest.fn(() => 0),
  removeByFilePaths: jest.fn(() => 0)
}));
const mockShouldEmbed = jest.fn();
jest.mock('../src/main/services/embedding/embeddingGate', () => ({
  shouldEmbed: (...a) => mockShouldEmbed(...a)
}));
jest.mock('../src/main/analysis/embeddingModelOptions', () => ({
  resolveEmbeddingModelOptions: jest.fn().mockResolvedValue({ embeddingModel: 'test-embed' })
}));
jest.mock('../src/shared/logger', () => {
  const l = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { logger: l, createLogger: () => l };
});

const { embedHistoryEntry } = require('../src/main/ipc/files/embeddingSync');
const { getSemanticFileId } = require('../src/shared/fileIdUtils');

function makeServices() {
  return {
    vectorDbService: null,
    folderMatchingService: {
      embedText: jest.fn().mockResolvedValue({ vector: [0.1, 0.2], model: 'test-embed' })
    },
    analysisHistoryService: { updateEmbeddingStateByPath: jest.fn().mockResolvedValue() },
    learningFeedbackService: null
  };
}

const entry = {
  fileSize: 123,
  analysis: { summary: 'Quarterly numbers', keywords: ['q1'], category: 'Finance' }
};

describe('embedHistoryEntry', () => {
  beforeEach(() => {
    mockEnqueue.mockClear();
    mockShouldEmbed.mockReset().mockResolvedValue({ shouldEmbed: true, timing: 'x', policy: 'y' });
  });

  test('embeds the stored analysis and enqueues it under the canonical file id', async () => {
    const services = makeServices();
    const result = await embedHistoryEntry({ entry, filePath: 'C:\\docs\\q1.pdf', services });

    expect(result).toEqual(expect.objectContaining({ action: 'enqueued' }));
    expect(services.folderMatchingService.embedText).toHaveBeenCalledWith(
      expect.stringContaining('Quarterly numbers')
    );
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const queued = mockEnqueue.mock.calls[0][0];
    expect(queued.id).toBe(getSemanticFileId('C:\\docs\\q1.pdf'));
    expect(queued.vector).toEqual([0.1, 0.2]);
    expect(queued.meta).toEqual(
      expect.objectContaining({ path: 'C:\\docs\\q1.pdf', category: 'Finance', fileSize: 123 })
    );
    expect(services.analysisHistoryService.updateEmbeddingStateByPath).toHaveBeenCalledWith(
      'C:\\docs\\q1.pdf',
      expect.objectContaining({ status: 'pending' })
    );
  });

  test('honors the embedding gate and records the skip', async () => {
    mockShouldEmbed.mockResolvedValue({ shouldEmbed: false, timing: 'manual', policy: 'skip' });
    const services = makeServices();
    const result = await embedHistoryEntry({ entry, filePath: 'C:\\docs\\q1.pdf', services });

    expect(result).toEqual({ action: 'skipped', reason: 'disabled:manual:skip' });
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(services.analysisHistoryService.updateEmbeddingStateByPath).toHaveBeenCalledWith(
      'C:\\docs\\q1.pdf',
      { status: 'skipped' }
    );
  });

  test('skips when there is nothing to embed or no embedder', async () => {
    const services = makeServices();
    await expect(
      embedHistoryEntry({ entry: { analysis: {} }, filePath: 'C:\\docs\\e.pdf', services })
    ).resolves.toEqual({ action: 'skipped', reason: 'empty-summary' });

    await expect(
      embedHistoryEntry({
        entry,
        filePath: 'C:\\docs\\q1.pdf',
        services: { ...services, folderMatchingService: null }
      })
    ).resolves.toEqual({ action: 'skipped', reason: 'matcher-unavailable' });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
