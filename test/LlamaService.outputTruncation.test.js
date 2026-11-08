/**
 * The local model stops at an output-token cap that LlamaService clamps to the
 * free context. generateText / generateTextStreaming / analyzeText must report
 * that stop (node-llama-cpp promptWithMeta stopReason 'maxTokens') so chat can
 * tell the user the answer was cut short instead of showing a raw JSON fragment.
 */

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
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

const CUT = '{"modelAnswer":[{"text":"The lease allows one cat and';

describe('LlamaService reports a local output-token stop', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLlama.sessions = [];
    mockLlama.results = [];
  });

  test('generateTextStreaming returns truncated: true on a maxTokens stop', async () => {
    mockLlama.results = [{ responseText: CUT, stopReason: 'maxTokens' }];
    const tokens = [];
    const result = await createTestService().generateTextStreaming({
      prompt: 'q',
      maxTokens: 64,
      onToken: (t) => tokens.push(t)
    });
    expect(result).toEqual({ response: CUT, truncated: true });
    expect(tokens.join('')).toBe(CUT);
  });

  test('generateTextStreaming returns truncated: false on a normal end of generation', async () => {
    mockLlama.results = [{ responseText: 'done', stopReason: 'eogToken' }];
    const result = await createTestService().generateTextStreaming({ prompt: 'q' });
    expect(result).toEqual({ response: 'done', truncated: false });
  });

  test('generateText returns truncated: true on a maxTokens stop', async () => {
    mockLlama.results = [{ responseText: CUT, stopReason: 'maxTokens' }];
    const result = await createTestService().generateText({ prompt: 'q', maxTokens: 64 });
    expect(result).toEqual({ response: CUT, truncated: true });
  });

  test('analyzeText carries the flag through its envelope', async () => {
    mockLlama.results = [{ responseText: CUT, stopReason: 'maxTokens' }];
    const result = await createTestService().analyzeText('q', { maxTokens: 64 });
    expect(result).toEqual({ success: true, response: CUT, truncated: true });
  });
});
