/**
 * Startup repair asks the gate "would this file be embedded at all?", not
 * "may I embed at the final stage?". The file-vector backfill asked the
 * latter, which is false under the default 'during_analysis' timing, so
 * missing vectors were never rebuilt and the file was marked skipped.
 */

jest.mock('../src/shared/logger', () => {
  const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { logger, createLogger: jest.fn(() => logger) };
});

function gateWith(settings) {
  jest.resetModules();
  jest.doMock('../src/main/services/ServiceContainer', () => ({
    container: { tryResolve: () => ({ load: async () => settings }) },
    ServiceIds: { SETTINGS: 'SETTINGS' }
  }));
  return require('../src/main/services/embedding/embeddingGate');
}

describe('embeddingGate.shouldEmbedForRepair', () => {
  test.each([
    ['during_analysis', true],
    ['after_organize', true],
    ['manual', false]
  ])('timing %s -> %s', async (timing, expected) => {
    const { shouldEmbedForRepair } = gateWith({
      embeddingTiming: timing,
      defaultEmbeddingPolicy: 'embed'
    });
    await expect(shouldEmbedForRepair({})).resolves.toMatchObject({ shouldEmbed: expected });
  });

  test.each(['skip', 'web_only'])('a file whose policy is %s is never repaired', async (policy) => {
    const { shouldEmbedForRepair } = gateWith({
      embeddingTiming: 'during_analysis',
      defaultEmbeddingPolicy: 'embed'
    });
    await expect(shouldEmbedForRepair({ policyOverride: policy })).resolves.toMatchObject({
      shouldEmbed: false
    });
  });
});

describe('embedHistoryEntry under the default timing (real gate)', () => {
  test('the startup file-vector backfill embeds instead of marking the file skipped', async () => {
    gateWith({ embeddingTiming: 'during_analysis', defaultEmbeddingPolicy: 'embed' });
    const enqueue = jest.fn().mockResolvedValue(undefined);
    jest.doMock('../src/main/analysis/embeddingQueue/stageQueues', () => ({
      organizeQueue: { enqueue, getStats: () => ({ capacityPercent: 0 }) },
      analysisQueue: { enqueue: jest.fn(), getStats: () => ({ capacityPercent: 0 }) }
    }));
    jest.doMock('../src/main/analysis/embeddingQueue/queueManager', () => ({
      waitForOrganizeQueueCapacity: jest.fn().mockResolvedValue({ timedOut: false }),
      removeByFilePath: jest.fn(() => 0),
      removeByFilePaths: jest.fn(() => 0)
    }));
    jest.doMock('../src/main/analysis/embeddingModelOptions', () => ({
      resolveEmbeddingModelOptions: jest.fn().mockResolvedValue({ embeddingModel: 'test-embed' })
    }));
    const { embedHistoryEntry } = require('../src/main/ipc/files/embeddingSync');
    const services = {
      vectorDbService: null,
      folderMatchingService: {
        embedText: jest.fn().mockResolvedValue({ vector: [0.1, 0.2], model: 'test-embed' })
      },
      analysisHistoryService: { updateEmbeddingStateByPath: jest.fn().mockResolvedValue() },
      learningFeedbackService: null
    };

    const result = await embedHistoryEntry({
      entry: { fileSize: 1, analysis: { summary: 'Quarterly numbers', category: 'Finance' } },
      filePath: '/docs/q1.pdf',
      services
    });

    expect(result).toEqual(expect.objectContaining({ action: 'enqueued' }));
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(services.analysisHistoryService.updateEmbeddingStateByPath).not.toHaveBeenCalledWith(
      '/docs/q1.pdf',
      expect.objectContaining({ status: 'skipped' })
    );
  });
});
