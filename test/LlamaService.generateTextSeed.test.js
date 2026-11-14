/**
 * generateText forwards an integer `seed` to node-llama-cpp so the document
 * classification call answers the same way for the same prompt. Calls that
 * pass no seed (chat and the rest) keep sampling as before.
 */

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../src/shared/logger', () => ({
  createLogger: () => mockLog
}));

jest.mock('../src/main/services/DegradationManager', () => ({
  DegradationManager: jest.fn().mockImplementation(() => ({
    checkSystemReadiness: jest.fn().mockResolvedValue({ ready: true, issues: [], gpuInfo: {} }),
    handleError: jest.fn().mockResolvedValue({ action: 'none' })
  }))
}));

const mockModelMemoryManager = {
  ensureModelLoaded: jest.fn(),
  unloadAll: jest.fn().mockResolvedValue(undefined),
  unloadModel: jest.fn().mockResolvedValue(undefined),
  acquireRef: jest.fn(),
  releaseRef: jest.fn(),
  getMemoryStatus: jest.fn().mockReturnValue({ totalLoaded: 1 })
};

jest.mock('../src/main/services/ModelMemoryManager', () => ({
  ModelMemoryManager: jest.fn().mockImplementation(() => mockModelMemoryManager)
}));

jest.mock('../src/main/services/ModelAccessCoordinator', () => ({
  ModelAccessCoordinator: jest.fn().mockImplementation(() => ({
    acquireLoadLock: jest.fn(async () => () => {}),
    withModel: jest.fn((_modelType, fn) => fn())
  }))
}));

jest.mock('../src/main/services/PerformanceMetrics', () => ({
  PerformanceMetrics: jest.fn().mockImplementation(() => ({
    recordEmbedding: jest.fn(),
    recordTextGeneration: jest.fn(),
    recordModelLoad: jest.fn(),
    getMetrics: jest.fn().mockReturnValue({}),
    destroy: jest.fn()
  }))
}));

jest.mock('../src/main/services/GPUMonitor', () => ({
  GPUMonitor: jest.fn().mockImplementation(() => ({})),
  getInstance: jest.fn(() => ({}))
}));

jest.mock('../src/main/services/SettingsService', () => ({
  getInstance: jest.fn(() => ({
    load: jest.fn().mockResolvedValue({}),
    save: jest.fn().mockResolvedValue(undefined)
  }))
}));

jest.mock('../src/main/services/VisionService', () => ({
  getInstance: jest.fn(() => ({
    analyzeImage: jest.fn(),
    shutdown: jest.fn(),
    isIdleKeepAliveEnabled: jest.fn(() => true)
  }))
}));

// Only `withLlamaResilience` is exercised on this path; have it invoke the
// resilience function directly (retryOptions = {}, so no forceCPU reload).
// `isSequenceExhaustedError` / `isOutOfMemoryError` are LOCAL helpers in
// LlamaService.js, not imported from here, so the real ones run.
jest.mock('../src/main/services/LlamaResilience', () => ({
  withLlamaResilience: jest.fn((fn) => fn({})),
  cleanupLlamaCircuits: jest.fn(),
  shouldFallbackToCPU: jest.fn().mockReturnValue(false)
}));

// Each session answers through promptWithMeta (the node-llama-cpp v3 API that
// prompt() wraps) with the stopReason queued for it.
const mockLlama = { sessions: [], results: [] };

jest.mock('node-llama-cpp', () => ({
  getLlama: jest.fn(),
  LlamaChatSession: jest.fn().mockImplementation(() => {
    const index = mockLlama.sessions.length;
    const session = {
      dispose: jest.fn(),
      prompt: jest.fn(async () => mockLlama.results[index]?.responseText ?? 'mock-response'),
      promptWithMeta: jest.fn(async (_prompt, options) => {
        const result = mockLlama.results[index] || {
          responseText: 'mock-response',
          stopReason: 'eogToken'
        };
        if (typeof options?.onTextChunk === 'function') options.onTextChunk(result.responseText);
        return { response: [result.responseText], ...result };
      })
    };
    mockLlama.sessions.push(session);
    return session;
  })
}));

const { LlamaService } = require('../src/main/services/LlamaService');

function createTestService() {
  const service = new LlamaService();
  service._initialized = true;
  service._modelsPath = '/mock/models';
  service._selectedModels = { text: 'text.gguf', vision: 'vision.gguf', embedding: 'embed.gguf' };
  service._config = { gpuLayers: -1, threads: 4 };
  service._gpuBackend = 'vulkan';
  service._awaitModelReady = jest.fn().mockResolvedValue(undefined);
  service._ensureModelLoaded = jest.fn().mockResolvedValue({
    getSequence: jest.fn().mockReturnValue({}),
    model: { gpuLayers: 33, trainContextSize: 4096 }
  });
  service._modelMemoryManager = mockModelMemoryManager;
  service._ensureConfigLoaded = jest.fn().mockResolvedValue(undefined);
  service._reloadModelCPU = jest.fn().mockResolvedValue(undefined);
  service._recoverFromSequenceExhaustion = jest.fn().mockResolvedValue(undefined);
  service._getEffectiveContextSize = jest.fn().mockReturnValue(4096);
  return service;
}

describe('LlamaService.generateText seed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLlama.sessions = [];
    mockLlama.results = [];
  });

  test('passes an integer seed to promptWithMeta and logs it', async () => {
    const service = createTestService();
    await service.generateText({ prompt: 'x', temperature: 0.2, seed: 42 });
    const options = mockLlama.sessions[0].promptWithMeta.mock.calls[0][1];
    expect(options).toEqual(expect.objectContaining({ seed: 42, temperature: 0.2 }));
    expect(mockLog.info).toHaveBeenCalledWith(
      '[LlamaService] Text inference complete',
      expect.objectContaining({ seed: 42 })
    );
  });

  test('sends no seed key when none is given', async () => {
    const service = createTestService();
    await service.generateText({ prompt: 'x' });
    const options = mockLlama.sessions[0].promptWithMeta.mock.calls[0][1];
    expect(options).not.toHaveProperty('seed');
  });

  test('ignores a seed that is not an integer', async () => {
    const service = createTestService();
    await service.generateText({ prompt: 'x', seed: 1.5 });
    const options = mockLlama.sessions[0].promptWithMeta.mock.calls[0][1];
    expect(options).not.toHaveProperty('seed');
  });
});
