/**
 * The startup backfill (embedHistoryEntry) must honour Settings -> embedding
 * scope 'smart_folders_only' exactly as the live analysis path does: a file
 * outside every smart folder is not put into the local vector index.
 * Uses the real embedding gate with stubbed settings.
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
jest.mock('../src/main/analysis/embeddingModelOptions', () => ({
  resolveEmbeddingModelOptions: jest.fn().mockResolvedValue({ embeddingModel: 'test-embed' })
}));
jest.mock('../src/shared/logger', () => {
  const l = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { logger: l, createLogger: () => l };
});
let mockSettings = {};
jest.mock('../src/main/services/ServiceContainer', () => ({
  container: {
    tryResolve: (id) => (id === 'SETTINGS' ? { load: async () => mockSettings } : null)
  },
  ServiceIds: { SETTINGS: 'SETTINGS' }
}));

const { embedHistoryEntry } = require('../src/main/ipc/files/embeddingSync');
const { shouldEmbed } = require('../src/main/services/embedding/embeddingGate');

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

describe('embedHistoryEntry embedding scope', () => {
  beforeEach(() => {
    mockEnqueue.mockClear();
    mockSettings = {
      embeddingTiming: 'during_analysis',
      defaultEmbeddingPolicy: 'embed',
      embeddingScope: 'smart_folders_only'
    };
  });

  test('a file outside every smart folder is not backfilled under smart_folders_only', async () => {
    // The live analysis path refuses this file.
    await expect(shouldEmbed({ stage: 'analysis', isInSmartFolder: false })).resolves.toMatchObject(
      { shouldEmbed: false }
    );

    const services = makeServices();
    const result = await embedHistoryEntry({
      entry,
      filePath: 'C:\\Users\\me\\Downloads\\q1.pdf',
      smartFolder: null,
      services
    });

    expect(result).toMatchObject({ action: 'skipped' });
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(services.folderMatchingService.embedText).not.toHaveBeenCalled();
  });

  test('a file inside a smart folder is still backfilled under smart_folders_only', async () => {
    const services = makeServices();
    const result = await embedHistoryEntry({
      entry,
      filePath: 'C:\\Library\\Finance\\q1.pdf',
      smartFolder: { name: 'Finance', path: 'C:\\Library\\Finance' },
      services
    });

    expect(result).toMatchObject({ action: 'enqueued' });
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  test('scope all_analyzed still backfills a file outside every smart folder', async () => {
    mockSettings.embeddingScope = 'all_analyzed';
    const services = makeServices();
    const result = await embedHistoryEntry({
      entry,
      filePath: 'C:\\Users\\me\\Downloads\\q1.pdf',
      smartFolder: null,
      services
    });

    expect(result).toMatchObject({ action: 'enqueued' });
  });
});
