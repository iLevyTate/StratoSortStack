/**
 * analyzeImage must hand the caller's AbortSignal to the model-access
 * coordinator (like generateText does) so a cancelled or timed-out image
 * request leaves the vision queue instead of waiting for its slot and then
 * releasing memory / starting the vision runtime for nothing.
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

describe('LlamaService.analyzeImage abort signal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVisionService.analyzeImage.mockReset();
    mockVisionService.analyzeImage.mockResolvedValue({ response: 'vision response' });
    jest.spyOn(fs, 'access').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('passes the caller signal to the coordinator queue', async () => {
    const service = createTestService();
    let receivedOptions;
    service._coordinator = {
      withModel: jest.fn((_type, fn, options) => {
        receivedOptions = options;
        return fn({ signal: options?.signal });
      })
    };
    const controller = new AbortController();

    await service.analyzeImage({ imagePath: '/test.jpg', signal: controller.signal });

    expect(service._coordinator.withModel).toHaveBeenCalledWith(
      'vision',
      expect.any(Function),
      expect.objectContaining({ signal: controller.signal })
    );
    expect(receivedOptions.operationId).toEqual(expect.any(String));
  });

  test('a request aborted while queued does not prepare the vision runtime', async () => {
    const service = createTestService();
    service._releaseMemoryForVisionRuntime = jest.fn().mockResolvedValue(undefined);
    const controller = new AbortController();
    service._coordinator = {
      // Simulate the slot arriving after the caller already gave up.
      withModel: jest.fn((_type, fn) => {
        controller.abort();
        return fn({});
      })
    };

    await expect(
      service.analyzeImage({ imagePath: '/test.jpg', signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(service._ensureVisionAssets).not.toHaveBeenCalled();
    expect(service._releaseMemoryForVisionRuntime).not.toHaveBeenCalled();
    expect(mockVisionService.analyzeImage).not.toHaveBeenCalled();
  });
});
