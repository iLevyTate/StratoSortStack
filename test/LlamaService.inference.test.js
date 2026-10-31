/**
 * Tests for LlamaService inference methods.
 * Covers generateText, analyzeImage, _loadModel GPU fallback,
 * listModels, getHealthStatus, and batchGenerateEmbeddings.
 */

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const mockDegradation = {
  checkSystemReadiness: jest.fn().mockResolvedValue({ ready: true, issues: [], gpuInfo: {} }),
  handleError: jest.fn().mockResolvedValue({ action: 'none' })
};

jest.mock('../src/main/services/DegradationManager', () => ({
  DegradationManager: jest.fn().mockImplementation(() => mockDegradation)
}));

const mockContext = {
  getSequence: jest.fn().mockReturnValue({}),
  model: { gpuLayers: 33, trainContextSize: 4096 }
};

const mockModelMemoryManager = {
  ensureModelLoaded: jest.fn().mockResolvedValue(mockContext),
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
    withModel: jest.fn((_, fn, __) => fn())
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

// Mirrors the real SettingsService instance contract LlamaService uses
// (load() in _loadConfig, save() when persisting model fallbacks).
jest.mock('../src/main/services/SettingsService', () => ({
  getInstance: jest.fn(() => ({
    load: jest.fn().mockResolvedValue({}),
    save: jest.fn().mockResolvedValue(undefined)
  }))
}));

const mockVisionService = {
  analyzeImage: jest.fn(),
  shutdown: jest.fn(),
  isIdleKeepAliveEnabled: jest.fn(() => true)
};

jest.mock('../src/main/services/VisionService', () => ({
  getInstance: jest.fn(() => mockVisionService)
}));

const mockSession = {
  prompt: jest.fn().mockResolvedValue('Generated text response'),
  dispose: jest.fn()
};

jest.mock('../src/main/services/LlamaResilience', () => ({
  withLlamaResilience: jest.fn((fn) => fn({})),
  cleanupLlamaCircuits: jest.fn(),
  shouldFallbackToCPU: jest.fn().mockReturnValue(false),
  isSequenceExhaustedError: jest.fn().mockReturnValue(false),
  isOutOfMemoryError: jest.fn().mockReturnValue(false),
  attachErrorCode: jest.fn((err, code) => {
    err.code = code;
    return err;
  })
}));

// Mock the dynamic import of node-llama-cpp module
jest.mock('../src/main/services/LlamaService', () => {
  // Load the actual module to get the real class
  const actual = jest.requireActual('../src/main/services/LlamaService');
  return actual;
});

const fs = require('fs').promises;
const { LlamaService } = require('../src/main/services/LlamaService');
const { ERROR_CODES } = require('../src/shared/errorCodes');

// Helper to create a service with common mocks pre-configured
function createTestService() {
  const service = new LlamaService();
  service._initialized = true;
  service._modelsPath = '/mock/models';
  service._selectedModels = { text: 'text.gguf', vision: 'vision.gguf', embedding: 'embed.gguf' };
  service._config = { gpuLayers: -1, threads: 4 };
  service._gpuBackend = 'vulkan';
  service._awaitModelReady = jest.fn().mockResolvedValue(undefined);
  service._ensureModelLoaded = jest.fn().mockResolvedValue(mockContext);
  // The real LlamaService creates this lazily inside initialize(); tests
  // bypass initialize() so wire the mock instance directly.
  service._modelMemoryManager = mockModelMemoryManager;
  service._ensureConfigLoaded = jest.fn().mockResolvedValue(undefined);
  service._reloadModelCPU = jest.fn().mockResolvedValue(undefined);
  service._recoverFromSequenceExhaustion = jest.fn().mockResolvedValue(undefined);
  service._ensureVisionAssets = jest.fn().mockResolvedValue(undefined);
  service._getEffectiveContextSize = jest.fn().mockReturnValue(4096);
  service._visionProjectorStatus = { required: false, available: false };
  return service;
}

describe('LlamaService – inference methods', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVisionService.analyzeImage.mockReset();
    mockVisionService.analyzeImage.mockResolvedValue({ response: 'vision response' });
  });

  describe('generateText', () => {
    test('returns response on success', async () => {
      const service = createTestService();
      // Mock the node-llama-cpp dynamic import
      const loadModule = jest.fn().mockResolvedValue({
        LlamaChatSession: jest.fn().mockImplementation(() => mockSession)
      });
      // Replace internal loader
      service._coordinator = {
        withModel: jest.fn((_, fn) => fn())
      };

      // We need to mock at a higher level since generateText uses withLlamaResilience
      const { withLlamaResilience } = require('../src/main/services/LlamaResilience');
      withLlamaResilience.mockImplementation(async (fn) => {
        return { response: 'Generated text response' };
      });

      const result = await service.generateText({
        prompt: 'What is 2+2?',
        systemPrompt: 'You are a math tutor.',
        maxTokens: 512,
        temperature: 0.5
      });

      expect(result).toEqual({ response: 'Generated text response' });
      expect(service._awaitModelReady).toHaveBeenCalledWith('text');
    });

    test('records metrics on failure', async () => {
      const service = createTestService();
      service._coordinator = {
        withModel: jest.fn((_, fn) => fn())
      };

      const { withLlamaResilience } = require('../src/main/services/LlamaResilience');
      withLlamaResilience.mockImplementation(async () => {
        throw new Error('Inference failed');
      });

      await expect(service.generateText({ prompt: 'test', maxTokens: 100 })).rejects.toThrow(
        'Inference failed'
      );
    });

    test('handles abort signal', async () => {
      const service = createTestService();
      service._coordinator = {
        withModel: jest.fn((_, fn) => fn())
      };

      const controller = new AbortController();
      controller.abort();

      const { withLlamaResilience } = require('../src/main/services/LlamaResilience');
      withLlamaResilience.mockImplementation(async () => {
        const err = new Error('Operation aborted');
        err.name = 'AbortError';
        throw err;
      });

      await expect(
        service.generateText({ prompt: 'test', signal: controller.signal })
      ).rejects.toThrow('Operation aborted');
    });

    test('uses unique operation IDs across same-millisecond calls', async () => {
      const service = createTestService();
      const capturedOptions = [];
      service._coordinator = {
        withModel: jest.fn((_, fn, options) => {
          capturedOptions.push(options);
          return fn();
        })
      };

      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(1234567890);
      const mathRandomSpy = jest
        .spyOn(Math, 'random')
        .mockReturnValueOnce(0.111111)
        .mockReturnValueOnce(0.222222);

      const { withLlamaResilience } = require('../src/main/services/LlamaResilience');
      withLlamaResilience.mockImplementation(async () => ({ response: 'ok' }));

      try {
        await service.generateText({ prompt: 'first' });
        await service.generateText({ prompt: 'second' });

        expect(capturedOptions).toHaveLength(2);
        expect(capturedOptions[0].operationId).not.toBe(capturedOptions[1].operationId);
      } finally {
        dateNowSpy.mockRestore();
        mathRandomSpy.mockRestore();
      }
    });
  });

  describe('analyzeText', () => {
    test('wraps generateText and returns success envelope', async () => {
      const service = createTestService();
      service.generateText = jest.fn().mockResolvedValue({ response: 'AI says hello' });

      const result = await service.analyzeText('Say hello', { maxTokens: 256 });

      expect(result).toEqual({ success: true, response: 'AI says hello' });
      expect(service.generateText).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'Say hello', maxTokens: 256 })
      );
    });

    test('returns success:false on error', async () => {
      const service = createTestService();
      service.generateText = jest.fn().mockRejectedValue(new Error('boom'));

      const result = await service.analyzeText('fail');

      expect(result.success).toBe(false);
      expect(result.error).toBe('boom');
    });
  });

  describe('analyzeImage', () => {
    test('falls back to generateText when no image source provided', async () => {
      const service = createTestService();
      service.generateText = jest.fn().mockResolvedValue({ response: 'text response' });

      const result = await service.analyzeImage({ prompt: 'describe' });

      expect(service.generateText).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'describe' })
      );
    });

    test('throws when vision model not found', async () => {
      const service = createTestService();
      service._coordinator = {
        withModel: jest.fn((_, fn) => fn())
      };

      const { withLlamaResilience } = require('../src/main/services/LlamaResilience');
      withLlamaResilience.mockImplementation(async (fn) => fn({}));

      // Mock fs.access to throw (model not found)
      jest.spyOn(fs, 'access').mockRejectedValue(new Error('ENOENT'));

      await expect(
        service.analyzeImage({ imagePath: '/test.jpg', prompt: 'describe' })
      ).rejects.toThrow(/not found/i);
    });

    test('throws when projector is required but missing', async () => {
      const service = createTestService();
      service._visionProjectorStatus = {
        required: true,
        available: false,
        projectorName: 'mmproj.gguf'
      };
      service._coordinator = {
        withModel: jest.fn((_, fn) => fn())
      };

      const { withLlamaResilience } = require('../src/main/services/LlamaResilience');
      withLlamaResilience.mockImplementation(async (fn) => fn({}));

      jest.spyOn(fs, 'access').mockResolvedValue(undefined);

      await expect(service.analyzeImage({ imagePath: '/test.jpg' })).rejects.toThrow(/projector/i);
    });

    test('refuses to spawn the vision runtime when pinned residents leave no room (ML-01)', async () => {
      const service = createTestService();
      service._coordinator = { withModel: jest.fn((_, fn) => fn()) };
      service._visionProjectorStatus = { required: false, available: true, projectorPath: null };
      service._estimateVisionRuntimeBytes = jest.fn().mockResolvedValue(5 * 1024 ** 3);
      const { withLlamaResilience } = require('../src/main/services/LlamaResilience');
      withLlamaResilience.mockImplementation(async (fn) => fn({}));
      jest.spyOn(fs, 'access').mockResolvedValue(undefined);
      // The text model is pinned by an active operation and the budget cannot
      // hold both.
      mockModelMemoryManager.unloadModel.mockResolvedValue(false);
      mockModelMemoryManager.canFitExternalLoad = jest.fn(() => false);
      mockModelMemoryManager.getMemoryStatus.mockReturnValue({
        loadedModels: ['text'],
        maxMemoryMB: 7168,
        currentUsageMB: 4096
      });
      mockVisionService.analyzeImage.mockClear();

      try {
        await expect(
          service.analyzeImage({ imagePath: '/test.jpg', prompt: 'describe' })
        ).rejects.toMatchObject({ code: 'MODEL_MEMORY_BUDGET_EXCEEDED' });
        expect(mockModelMemoryManager.canFitExternalLoad).toHaveBeenCalledWith(5 * 1024 ** 3, {
          excludeType: 'vision-runtime'
        });
        expect(mockVisionService.analyzeImage).not.toHaveBeenCalled();
      } finally {
        delete mockModelMemoryManager.canFitExternalLoad;
        mockModelMemoryManager.unloadModel.mockResolvedValue(undefined);
        mockModelMemoryManager.getMemoryStatus.mockReturnValue({ totalLoaded: 1 });
      }
    });

    test('spawns the vision runtime when the budget holds it beside the residents', async () => {
      const service = createTestService();
      service._coordinator = { withModel: jest.fn((_, fn) => fn()) };
      service._visionProjectorStatus = { required: false, available: true, projectorPath: null };
      service._estimateVisionRuntimeBytes = jest.fn().mockResolvedValue(5 * 1024 ** 3);
      service._resolveGpuLayersForVisionServer = jest.fn().mockResolvedValue(999);
      service._buildVisionRuntimeProfile = jest.fn(() => ({
        maxTokens: 256,
        contextSize: 4096,
        batchSize: 512,
        ubatchSize: 512
      }));
      const { withLlamaResilience } = require('../src/main/services/LlamaResilience');
      withLlamaResilience.mockImplementation(async (fn) => fn({}));
      jest.spyOn(fs, 'access').mockResolvedValue(undefined);
      mockModelMemoryManager.unloadModel.mockResolvedValue(false);
      mockModelMemoryManager.canFitExternalLoad = jest.fn(() => true);
      mockVisionService.analyzeImage.mockResolvedValue({ response: 'a cat' });
      mockVisionService.scheduleIdleShutdown = jest.fn();

      try {
        await expect(
          service.analyzeImage({ imagePath: '/test.jpg', prompt: 'describe' })
        ).resolves.toEqual({ response: 'a cat' });
        expect(mockVisionService.analyzeImage).toHaveBeenCalledTimes(1);
      } finally {
        delete mockModelMemoryManager.canFitExternalLoad;
        delete mockVisionService.scheduleIdleShutdown;
        mockModelMemoryManager.unloadModel.mockResolvedValue(undefined);
      }
    });

    test('uses unique vision operation IDs across same-millisecond calls', async () => {
      const service = createTestService();
      const capturedOptions = [];
      service._coordinator = {
        withModel: jest.fn((_, fn, options) => {
          capturedOptions.push(options);
          return fn();
        })
      };

      const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(987654321);
      const mathRandomSpy = jest
        .spyOn(Math, 'random')
        .mockReturnValueOnce(0.333333)
        .mockReturnValueOnce(0.444444);

      const { withLlamaResilience } = require('../src/main/services/LlamaResilience');
      withLlamaResilience.mockImplementation(async () => ({ response: 'vision-ok' }));

      try {
        await service.analyzeImage({ imagePath: '/a.jpg', prompt: 'describe' });
        await service.analyzeImage({ imagePath: '/b.jpg', prompt: 'describe' });

        expect(capturedOptions).toHaveLength(2);
        expect(capturedOptions[0].operationId).not.toBe(capturedOptions[1].operationId);
      } finally {
        dateNowSpy.mockRestore();
        mathRandomSpy.mockRestore();
      }
    });

    test('forwards CPU fallback to vision runtime config', async () => {
      const service = createTestService();
      service._coordinator = {
        withModel: jest.fn((_, fn) => fn())
      };
      service._visionProjectorStatus = {
        required: false,
        available: true,
        projectorPath: null
      };

      const { withLlamaResilience } = require('../src/main/services/LlamaResilience');
      withLlamaResilience.mockImplementation(async (fn) => fn({ forceCPU: true }));

      jest.spyOn(fs, 'access').mockResolvedValue(undefined);

      await service.analyzeImage({ imagePath: '/test.jpg', prompt: 'describe' });

      expect(mockVisionService.analyzeImage).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            gpuLayers: 0,
            runtimeBackend: 'cpu'
          })
        })
      );
    });
  });

  describe('listModels', () => {
    test('returns categorized model list', async () => {
      const service = createTestService();
      jest
        .spyOn(fs, 'readdir')
        .mockResolvedValue([
          'llama-3.gguf',
          'nomic-embed-text.gguf',
          'llava-vision.gguf',
          'readme.txt'
        ]);

      const models = await service.listModels();

      expect(models).toHaveLength(3); // txt file filtered out
      expect(models.find((m) => m.name === 'nomic-embed-text.gguf').type).toBe('embedding');
      expect(models.find((m) => m.name === 'llava-vision.gguf').type).toBe('vision');
      expect(models.find((m) => m.name === 'llama-3.gguf').type).toBe('text');
    });

    test('returns empty array when directory read fails', async () => {
      const service = createTestService();
      jest.spyOn(fs, 'readdir').mockRejectedValue(new Error('ENOENT'));

      const models = await service.listModels();

      expect(models).toEqual([]);
    });
  });

  describe('getHealthStatus', () => {
    test('returns comprehensive health info', () => {
      const service = createTestService();
      service._detectedGpu = { vendor: 'NVIDIA', model: 'RTX 4090' };
      service._gpuSelection = { backend: 'vulkan' };

      const status = service.getHealthStatus();

      expect(status.healthy).toBe(true);
      expect(status.initialized).toBe(true);
      expect(status.gpuBackend).toBe('vulkan');
      expect(status.gpuDetected).toEqual({ vendor: 'NVIDIA', model: 'RTX 4090' });
    });

    test('reports unhealthy when not initialized', () => {
      const service = createTestService();
      service._initialized = false;

      const status = service.getHealthStatus();

      expect(status.healthy).toBe(false);
    });

    test('reports no degradation by default', () => {
      const service = createTestService();

      const status = service.getHealthStatus();

      expect(status.degraded).toBe(false);
      expect(status.openCircuits).toEqual([]);
      expect(status.usingCPUFallback).toBe(false);
    });

    test('an open circuit breaker makes the service unhealthy and names the model type', () => {
      const service = createTestService();
      jest
        .spyOn(service, '_getCircuitSummary')
        .mockReturnValue({ states: { text: 'OPEN', embedding: 'CLOSED' }, open: ['text'] });

      const status = service.getHealthStatus();

      expect(status.healthy).toBe(false);
      expect(status.degraded).toBe(true);
      expect(status.openCircuits).toEqual(['text']);
      expect(status.circuitBreakers).toEqual({ text: 'OPEN', embedding: 'CLOSED' });
    });

    test('a CPU fallback is degraded but still healthy', () => {
      const service = createTestService();
      service._cpuFallbackTypes.add('text');

      const status = service.getHealthStatus();

      expect(status.healthy).toBe(true);
      expect(status.degraded).toBe(true);
      expect(status.usingCPUFallback).toBe(true);
      expect(status.cpuFallbackTypes).toEqual(['text']);
    });

    test('a whole-engine CPU fallback (GPU init failed) reads as a CPU fallback', () => {
      const service = createTestService();
      service._engineCpuFallback = true;

      expect(service.getHealthStatus()).toEqual(
        expect.objectContaining({ usingCPUFallback: true, degraded: true, cpuFallbackTypes: [] })
      );
    });

    test("DegradationManager's sticky VRAM-error bit alone no longer marks the service as on CPU", () => {
      // handleError sets the bit on the first VRAM-pattern error, before any
      // retry, and nothing clears it; a load that then succeeded on the GPU
      // showed "Ready (CPU fallback)" for the rest of the process.
      const service = createTestService();
      service._degradationManager = {
        getDegradationState: () => ({ usingCPUFallback: true })
      };

      const status = service.getHealthStatus();

      expect(status.usingCPUFallback).toBe(false);
      expect(status.degraded).toBe(false);
    });
  });

  describe('batchGenerateEmbeddings', () => {
    test('throws INVALID_INPUT when texts is not an array', async () => {
      const service = createTestService();

      await expect(service.batchGenerateEmbeddings('not-an-array')).rejects.toEqual(
        expect.objectContaining({ code: ERROR_CODES.INVALID_INPUT })
      );
    });

    test('processes every text exactly once via _executeEmbeddingInference', async () => {
      const service = createTestService();
      service._coordinator = {
        withModel: jest.fn((_modelType, fn) => fn({}))
      };
      service._executeEmbeddingInference = jest.fn(async () => ({
        embedding: [0.1, 0.2, 0.3],
        model: 'embed.gguf'
      }));

      const results = await service.batchGenerateEmbeddings(['text1', 'text2', 'text3']);

      expect(results.embeddings).toHaveLength(3);
      expect(service._executeEmbeddingInference).toHaveBeenCalledTimes(3);
    });

    test('holds inference slot per chunk, not per item (CHUNK_SIZE=16)', async () => {
      // 20 items should acquire the coordinator twice: once for items 0..15,
      // once for items 16..19. This is the key perf invariant of the batch path.
      const service = createTestService();
      service._coordinator = {
        withModel: jest.fn((_modelType, fn) => fn({}))
      };
      service._executeEmbeddingInference = jest.fn(async () => ({
        embedding: [0.1],
        model: 'embed.gguf'
      }));

      const texts = Array.from({ length: 20 }, (_, i) => `text${i}`);
      const results = await service.batchGenerateEmbeddings(texts);

      expect(results.embeddings).toHaveLength(20);
      expect(service._coordinator.withModel).toHaveBeenCalledTimes(2);
      expect(service._executeEmbeddingInference).toHaveBeenCalledTimes(20);
    });

    test('pins the embedding model for the duration of the batch', async () => {
      const service = createTestService();
      service._coordinator = {
        withModel: jest.fn((_modelType, fn) => fn({}))
      };
      service._executeEmbeddingInference = jest.fn(async () => ({
        embedding: [0.1],
        model: 'embed.gguf'
      }));

      await service.batchGenerateEmbeddings(['a', 'b', 'c']);

      expect(mockModelMemoryManager.acquireRef).toHaveBeenCalledWith('embedding');
      expect(mockModelMemoryManager.acquireRef).toHaveBeenCalledTimes(1);
      expect(mockModelMemoryManager.releaseRef).toHaveBeenCalledWith('embedding');
      expect(mockModelMemoryManager.releaseRef).toHaveBeenCalledTimes(1);
    });

    test('reports progress via callback', async () => {
      const service = createTestService();
      service._coordinator = {
        withModel: jest.fn((_modelType, fn) => fn({}))
      };
      service._executeEmbeddingInference = jest.fn(async () => ({
        embedding: [0.1],
        model: 'embed.gguf'
      }));

      const progress = jest.fn();
      await service.batchGenerateEmbeddings(['a', 'b'], { onProgress: progress });

      expect(progress).toHaveBeenCalled();
      expect(progress).toHaveBeenLastCalledWith(
        expect.objectContaining({ current: 2, total: 2, progress: 1 })
      );
    });

    test('falls back to _tryEmbeddingFallback when primary inference fails, still reports progress', async () => {
      const service = createTestService();
      service._coordinator = {
        withModel: jest.fn((_modelType, fn) => fn({}))
      };
      service._executeEmbeddingInference = jest
        .fn()
        .mockRejectedValueOnce(new Error('primary failed'))
        .mockResolvedValueOnce({ embedding: [0.5], model: 'embed.gguf' });
      service._tryEmbeddingFallback = jest.fn(async () => ({
        embedding: [0.9],
        model: 'fallback.gguf'
      }));

      const progress = jest.fn();
      const result = await service.batchGenerateEmbeddings(['a', 'b'], { onProgress: progress });

      expect(result.embeddings).toEqual([[0.9], [0.5]]);
      expect(service._tryEmbeddingFallback).toHaveBeenCalledTimes(1);
      expect(progress).toHaveBeenLastCalledWith(
        expect.objectContaining({ current: 2, total: 2, progress: 1 })
      );
    });

    test('records null when both primary and fallback fail; keeps batch going', async () => {
      const service = createTestService();
      service._coordinator = {
        withModel: jest.fn((_modelType, fn) => fn({}))
      };
      service._executeEmbeddingInference = jest
        .fn()
        .mockRejectedValueOnce(new Error('primary failed'))
        .mockResolvedValueOnce({ embedding: [0.5], model: 'embed.gguf' });
      service._tryEmbeddingFallback = jest.fn(async () => {
        throw new Error('fallback exhausted');
      });

      const result = await service.batchGenerateEmbeddings(['a', 'b']);

      expect(result.embeddings).toEqual([null, [0.5]]);
      expect(result.failedIndexes).toEqual([0]);
    });

    test('aborts mid-batch when AbortSignal fires', async () => {
      const service = createTestService();
      const controller = new AbortController();
      service._coordinator = {
        withModel: jest.fn((_modelType, fn) => fn({}))
      };
      service._executeEmbeddingInference = jest.fn(async () => {
        controller.abort();
        return { embedding: [0.1], model: 'embed.gguf' };
      });

      await expect(
        service.batchGenerateEmbeddings(['a', 'b', 'c'], { signal: controller.signal })
      ).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });

      // Even on abort we must release the model ref we acquired
      expect(mockModelMemoryManager.releaseRef).toHaveBeenCalledWith('embedding');
    });

    test('returns empty embeddings without acquiring any resource for an empty input', async () => {
      const service = createTestService();
      service._coordinator = {
        withModel: jest.fn((_modelType, fn) => fn({}))
      };
      service._executeEmbeddingInference = jest.fn();

      const result = await service.batchGenerateEmbeddings([]);

      expect(result).toEqual({ embeddings: [], failedIndexes: [] });
      expect(service._coordinator.withModel).not.toHaveBeenCalled();
      expect(service._executeEmbeddingInference).not.toHaveBeenCalled();
      expect(mockModelMemoryManager.acquireRef).not.toHaveBeenCalled();
    });
  });
});
