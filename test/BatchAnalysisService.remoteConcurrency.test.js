/**
 * Documents analyzed by a cloud provider are not limited by local VRAM: a
 * reanalysis through a cloud model ran one file at a time because the local
 * hardware recommended a concurrency of 1. Queue pressure on the local
 * models (embeddings, vision) still applies.
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

jest.mock('../src/shared/config/index', () => ({
  get: jest.fn((key, defaultValue) => defaultValue)
}));

jest.mock('../src/main/utils/llmOptimization', () => ({
  globalBatchProcessor: { concurrencyLimit: 3, processBatch: jest.fn(), getStats: jest.fn() },
  BatchProcessor: jest.fn().mockImplementation(() => ({
    concurrencyLimit: 3,
    processBatch: jest.fn(),
    getStats: jest.fn()
  }))
}));

// The local hardware can take one model call at a time.
jest.mock('../src/main/services/PerformanceService', () => ({
  getRecommendedConcurrency: jest.fn().mockResolvedValue({
    maxConcurrent: 1,
    reason: 'low VRAM',
    vramMB: 4000
  })
}));

const mockQueueStats = {
  text: { queued: 0, pending: 0 },
  vision: { queued: 0, pending: 0 },
  embedding: { queued: 0, pending: 0 }
};
jest.mock('../src/main/services/ModelAccessCoordinator', () => ({
  getInstance: jest.fn(() => ({ getQueueStats: jest.fn(() => mockQueueStats) }))
}));

jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: jest.fn(() => ({
    enterVisionBatchMode: jest.fn(),
    exitVisionBatchMode: jest.fn()
  }))
}));
jest.mock('../src/main/analysis/documentAnalysis', () => ({
  analyzeDocumentFile: jest.fn(),
  flushAllEmbeddings: jest.fn()
}));
jest.mock('../src/main/analysis/imageAnalysis', () => ({
  analyzeImageFile: jest.fn(),
  flushAllEmbeddings: jest.fn()
}));
jest.mock('../src/main/services/ParallelEmbeddingService', () => ({
  getInstance: jest.fn(() => ({
    concurrencyLimit: 5,
    getStats: jest.fn(() => ({})),
    setConcurrencyLimit: jest.fn()
  }))
}));
jest.mock('../src/main/analysis/embeddingQueue/stageQueues', () => ({
  analysisQueue: {
    getStats: jest.fn(() => ({})),
    onProgress: jest.fn(() => () => {}),
    forceFlush: jest.fn(),
    shutdown: jest.fn()
  }
}));
jest.mock('../src/main/analysis/embeddingQueue/queueManager', () => ({
  forceFlush: jest.fn(),
  shutdown: jest.fn()
}));

const mockPreviewChoiceId = jest.fn();
jest.mock('../src/main/ipc/aiProvider', () => ({
  getActiveAiRouter: jest.fn(() => ({ previewChoiceId: mockPreviewChoiceId }))
}));

const BatchAnalysisService = require('../src/main/services/BatchAnalysisService');

describe('batch concurrency when documents go to a cloud provider', () => {
  let service;

  beforeEach(() => {
    mockPreviewChoiceId.mockReset();
    Object.assign(mockQueueStats.embedding, { queued: 0, pending: 0 });
    service = new BatchAnalysisService();
  });

  test('the local hardware cap still applies to local work', async () => {
    await expect(service._getAdaptiveConcurrency(4, true)).resolves.toBe(1);
  });

  test('cloud work keeps the requested concurrency', async () => {
    await expect(service._getAdaptiveConcurrency(4, true, { remote: true })).resolves.toBe(4);
  });

  test('queue pressure on the local models still limits cloud work', async () => {
    Object.assign(mockQueueStats.embedding, { queued: 3, pending: 1 });
    await expect(service._getAdaptiveConcurrency(4, true, { remote: true })).resolves.toBe(2);
  });

  test('document analysis counts as remote only when the router picks a cloud provider', () => {
    mockPreviewChoiceId.mockReturnValue('anthropic');
    expect(service._isDocumentAnalysisRemote()).toBe(true);
    expect(mockPreviewChoiceId).toHaveBeenCalledWith({ operation: 'analyze' });

    mockPreviewChoiceId.mockReturnValue('local');
    expect(service._isDocumentAnalysisRemote()).toBe(false);

    mockPreviewChoiceId.mockReturnValue(null);
    expect(service._isDocumentAnalysisRemote()).toBe(false);

    mockPreviewChoiceId.mockImplementation(() => {
      throw new Error('router not ready');
    });
    expect(service._isDocumentAnalysisRemote()).toBe(false);
  });
});
