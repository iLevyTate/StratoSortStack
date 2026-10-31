/**
 * LlamaService Coverage Tests
 *
 * Tests untested paths: testConnection, config management, model change
 * subscriptions, analyzeText, health status, pin/unpin, embedding input
 * validation, and shutdown.
 *
 * Coverage target: main/services/LlamaService.js (was 40%)
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
  handleError: jest.fn().mockResolvedValue({ action: 'none' }),
  destroy: jest.fn()
};

jest.mock('../src/main/services/DegradationManager', () => ({
  DegradationManager: jest.fn().mockImplementation(() => mockDegradation)
}));

jest.mock('../src/main/services/ModelMemoryManager', () => ({
  ModelMemoryManager: jest.fn().mockImplementation(() => ({
    ensureModelLoaded: jest.fn().mockResolvedValue(true),
    unloadAll: jest.fn().mockResolvedValue(undefined),
    unloadModel: jest.fn().mockResolvedValue(undefined),
    getStatus: jest.fn(() => ({})),
    destroy: jest.fn()
  }))
}));

jest.mock('../src/main/services/ModelAccessCoordinator', () => ({
  ModelAccessCoordinator: jest.fn().mockImplementation(() => ({
    acquireLoadLock: jest.fn(async () => () => {}),
    withModel: jest.fn((_, fn) => fn()),
    destroy: jest.fn()
  }))
}));

jest.mock('../src/main/services/PerformanceMetrics', () => ({
  PerformanceMetrics: jest.fn().mockImplementation(() => ({
    recordEmbedding: jest.fn(),
    recordModelLoad: jest.fn(),
    getMetrics: jest.fn(() => ({})),
    destroy: jest.fn()
  }))
}));

jest.mock('../src/main/services/GPUMonitor', () => {
  const makeMonitor = () => ({
    getInfo: jest.fn(() => ({ vendor: 'test', vram: 8192 })),
    destroy: jest.fn()
  });
  return {
    GPUMonitor: jest.fn().mockImplementation(makeMonitor),
    getInstance: jest.fn(makeMonitor)
  };
});

// Mirrors the real SettingsService instance contract LlamaService uses
// (load() in _loadConfig, save() when persisting model fallbacks).
const mockSettings = {
  load: jest.fn().mockResolvedValue({}),
  save: jest.fn().mockResolvedValue(undefined)
};

jest.mock('../src/main/services/SettingsService', () => ({
  getInstance: jest.fn(() => mockSettings)
}));

const mockVisionService = {
  isAlive: jest.fn(() => false),
  isIdleKeepAliveEnabled: jest.fn(() => false),
  shutdown: jest.fn().mockResolvedValue(undefined)
};

jest.mock('../src/main/services/VisionService', () => ({
  getInstance: jest.fn(() => mockVisionService)
}));

jest.mock('../src/main/services/modelPathResolver', () => ({
  ensureResolvedModelsPath: jest.fn()
}));

jest.mock('../src/main/services/LlamaResilience', () => ({
  withLlamaResilience: (fn) => fn({}),
  cleanupLlamaCircuits: jest.fn(),
  resetLlamaCircuit: jest.fn(),
  shouldFallbackToCPU: jest.fn(() => false)
}));

// PerformanceService.getRecommendedConcurrency() spawns nvidia-smi / system
// probes with a 5s timeout per child process. _doInitialize() calls it via
// require(), which `analyzeText > returns error when not initialized` reaches
// through generateText -> _ensureModelLoaded -> initialize(). Mock it so the
// test never actually shells out and stays well under Jest's default timeout.
jest.mock('../src/main/services/PerformanceService', () => ({
  getRecommendedConcurrency: jest.fn().mockResolvedValue({
    maxConcurrent: 1,
    reason: 'test-mock',
    vramMB: 0,
    gpuName: null
  })
}));

const { LlamaService } = require('../src/main/services/LlamaService');
const { ERROR_CODES } = require('../src/shared/errorCodes');

describe('LlamaService - extended coverage', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LlamaService();
  });

  describe('constructor', () => {
    test('initializes all managers', () => {
      expect(service).toBeDefined();
      expect(service._initialized).toBe(false);
      expect(service._isShuttingDown).toBeFalsy();
    });

    test('extends EventEmitter', () => {
      const handler = jest.fn();
      service.on('test-event', handler);
      service.emit('test-event', 'data');
      expect(handler).toHaveBeenCalledWith('data');
    });
  });

  describe('getConfig', () => {
    test('returns current config when loaded', async () => {
      service._config = { textModel: 'test.gguf', contextSize: 4096 };
      service._configLoaded = true;

      const config = await service.getConfig();
      expect(config.textModel).toBe('test.gguf');
    });

    test('loads config from settings when not yet loaded', async () => {
      mockSettings.load.mockResolvedValue({
        textModel: 'from-settings.gguf',
        contextSize: 8192
      });
      service._configLoaded = false;
      service._ensureConfigLoaded = jest.fn(async () => {
        service._config = { textModel: 'from-settings.gguf', contextSize: 8192 };
        service._configLoaded = true;
      });

      const config = await service.getConfig();
      expect(config.textModel).toBe('from-settings.gguf');
    });
  });

  describe('testConnection', () => {
    test('returns healthy status when config is loaded', async () => {
      service._configLoaded = true;
      service._config = { textModel: 'test.gguf' };
      service._ensureConfigLoaded = jest.fn().mockResolvedValue();

      const result = await service.testConnection();
      expect(result.success).toBe(true);
    });
  });

  describe('onModelChange', () => {
    test('subscribes and returns unsubscribe function', () => {
      const callback = jest.fn();
      const unsubscribe = service.onModelChange(callback);
      expect(typeof unsubscribe).toBe('function');
    });

    test('unsubscribe removes callback from set', () => {
      const callback = jest.fn();
      const unsubscribe = service.onModelChange(callback);
      expect(service._modelChangeCallbacks.has(callback)).toBe(true);

      unsubscribe();
      expect(service._modelChangeCallbacks.has(callback)).toBe(false);
    });

    test('ignores non-function callbacks', () => {
      const unsub = service.onModelChange('not-a-function');
      expect(typeof unsub).toBe('function');
      // Should not throw when called
      unsub();
    });
  });

  describe('getHealthStatus', () => {
    test('returns comprehensive status object', () => {
      service._initialized = true;
      service._config = { textModel: 'test.gguf' };

      const status = service.getHealthStatus();
      expect(status).toHaveProperty('initialized');
      expect(status.initialized).toBe(true);
    });

    test('returns uninitialized status', () => {
      const status = service.getHealthStatus();
      expect(status.initialized).toBe(false);
    });
  });

  describe('pinModel / unpinModel', () => {
    test('pinModel delegates to memory manager acquireRef', () => {
      service._modelMemoryManager = { acquireRef: jest.fn(), releaseRef: jest.fn() };
      service.pinModel('text');
      expect(service._modelMemoryManager.acquireRef).toHaveBeenCalledWith('text');
    });

    test('unpinModel delegates to memory manager releaseRef', () => {
      service._modelMemoryManager = { acquireRef: jest.fn(), releaseRef: jest.fn() };
      service.unpinModel('text');
      expect(service._modelMemoryManager.releaseRef).toHaveBeenCalledWith('text');
    });

    test('pinModel is safe without memory manager', () => {
      service._modelMemoryManager = null;
      expect(() => service.pinModel('text')).not.toThrow();
    });

    test('unpinModel is safe without memory manager', () => {
      service._modelMemoryManager = null;
      expect(() => service.unpinModel('text')).not.toThrow();
    });
  });

  describe('normalizeEmbeddingInput validation', () => {
    test('rejects non-string input for generateEmbedding', async () => {
      service._initialized = true;
      service._ensureConfigLoaded = jest.fn().mockResolvedValue();
      service._config = { embeddingModel: 'embed.gguf' };

      await expect(service.generateEmbedding(123)).rejects.toThrow(/string/);
    });

    test('rejects empty string input for generateEmbedding', async () => {
      service._initialized = true;
      service._ensureConfigLoaded = jest.fn().mockResolvedValue();
      service._config = { embeddingModel: 'embed.gguf' };

      await expect(service.generateEmbedding('   ')).rejects.toThrow(/non-empty/);
    });
  });

  describe('analyzeText', () => {
    test('returns error when not initialized', async () => {
      service._initialized = false;
      service._ensureConfigLoaded = jest.fn().mockResolvedValue();
      service._initializePromise = null;
      service._llama = null;

      const result = await service.analyzeText('Test prompt');
      expect(result.success).toBe(false);
    });

    test('wraps generateText for convenience', async () => {
      service._initialized = true;
      service._config = { textModel: 'test.gguf' };
      service.generateText = jest.fn().mockResolvedValue({
        response: 'Analyzed result'
      });

      const result = await service.analyzeText('Test prompt');
      expect(result.success).toBe(true);
      expect(result.response).toBe('Analyzed result');
    });

    test('handles generateText failure gracefully', async () => {
      service._initialized = true;
      service._config = { textModel: 'test.gguf' };
      service.generateText = jest.fn().mockRejectedValue(new Error('Model not loaded'));

      const result = await service.analyzeText('Test prompt');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Model not loaded/);
    });
  });

  describe('_ensureModelLoaded — vision VRAM coordination', () => {
    beforeEach(() => {
      mockVisionService.isAlive.mockReturnValue(false);
      mockVisionService.isIdleKeepAliveEnabled.mockReturnValue(false);
      mockVisionService.shutdown.mockReset();
      // Realistic shutdown: in production, shutdown() nulls _process and
      // resolves _shutdownPromise, after which isAlive() returns false.
      // Modeling that here lets us assert how many DISTINCT teardowns
      // happened across the pre-lock and post-lock probes.
      mockVisionService.shutdown.mockImplementation(async () => {
        mockVisionService.isAlive.mockReturnValue(false);
      });
      // _modelMemoryManager is normally set inside _doInitialize(); these
      // tests skip init by setting _initialized = true, so wire a stub here.
      service._initialized = true;
      service._modelMemoryManager = {
        ensureModelLoaded: jest.fn().mockResolvedValue(true),
        unloadModel: jest.fn().mockResolvedValue(undefined)
      };
      service._coordinator = {
        acquireLoadLock: jest.fn(async () => () => {})
      };
      service._degradationManager = {
        handleError: jest.fn().mockResolvedValue({ action: 'none' })
      };
    });

    test('shuts down vision server before loading text when keep-alive is holding VRAM', async () => {
      // Reproduce the runtime-log scenario: vision finished ~30s ago, keep-alive
      // timer hasn't fired yet, vision server still owns ~4 GB VRAM. A text load
      // request must tear vision down rather than racing into busy VRAM.
      service._visionBatchMode = false;
      mockVisionService.isAlive.mockReturnValue(true);
      mockVisionService.isIdleKeepAliveEnabled.mockReturnValue(true);

      await service._ensureModelLoaded('text');

      // Pre-lock probe sees vision alive, calls shutdown() once.
      // Post-lock probe sees isAlive=false (mock now returns false) and
      // skips. Net: exactly one teardown.
      expect(mockVisionService.shutdown).toHaveBeenCalledTimes(1);
    });

    test('post-lock probe catches vision restart between pre-lock and lock acquisition', async () => {
      // Simulate the race: pre-lock probe sees vision down (no teardown),
      // but vision restarts while we wait for the load lock — the post-lock
      // probe must catch and tear it down before the actual load.
      service._visionBatchMode = false;
      mockVisionService.isIdleKeepAliveEnabled.mockReturnValue(true);

      // Pre-lock: vision is down. Then between probe and lock release, vision
      // gets started by a sibling code path. Implement by flipping isAlive
      // when acquireLoadLock is called (the lock acquisition is the race
      // window we're modelling).
      let probeCount = 0;
      mockVisionService.isAlive.mockImplementation(() => {
        probeCount += 1;
        // First call (pre-lock): vision is down. Second call (post-lock):
        // vision is alive — sibling code spawned it during lock wait.
        return probeCount >= 2;
      });

      await service._ensureModelLoaded('text');

      // The post-lock probe fired the teardown that the pre-lock probe missed.
      expect(mockVisionService.shutdown).toHaveBeenCalledTimes(1);
    });

    test('does not touch vision when loading the vision model itself', async () => {
      service._visionBatchMode = false;
      mockVisionService.isAlive.mockReturnValue(true);
      mockVisionService.isIdleKeepAliveEnabled.mockReturnValue(true);

      await service._ensureModelLoaded('vision');

      expect(mockVisionService.shutdown).not.toHaveBeenCalled();
    });

    test('does not touch vision in batch mode (caller manages lifecycle)', async () => {
      service._visionBatchMode = true;
      mockVisionService.isAlive.mockReturnValue(true);
      mockVisionService.isIdleKeepAliveEnabled.mockReturnValue(true);

      await service._ensureModelLoaded('text');

      expect(mockVisionService.shutdown).not.toHaveBeenCalled();
    });

    test('skips shutdown when vision process is already gone', async () => {
      service._visionBatchMode = false;
      mockVisionService.isAlive.mockReturnValue(false);
      mockVisionService.isIdleKeepAliveEnabled.mockReturnValue(true);

      await service._ensureModelLoaded('text');

      expect(mockVisionService.shutdown).not.toHaveBeenCalled();
    });

    test('tags error with _degradationAction when DegradationManager returns transient_load_failure', async () => {
      // When ensureModelLoaded fails and DegradationManager classifies it as
      // a transient load failure (generic "Failed to load model"), the
      // thrown error must carry _degradationAction='transient_load_failure'
      // so withLlamaResilience runs the one-retry recovery.
      service._visionBatchMode = false;
      const loadError = new Error('Failed to load model');
      service._modelMemoryManager.ensureModelLoaded.mockRejectedValueOnce(loadError);
      service._degradationManager.handleError.mockResolvedValueOnce({
        action: 'transient_load_failure',
        message: 'Model load failed; one retry queued.',
        shouldNotifyUser: false,
        originalError: loadError
      });

      await expect(service._ensureModelLoaded('text')).rejects.toMatchObject({
        message: 'Failed to load model',
        _degradationAction: 'transient_load_failure'
      });
    });
  });

  describe('shutdown', () => {
    test('completes and resets state', async () => {
      service._initialized = false;

      await service.shutdown();
      // _isShuttingDown is reset to false at end of shutdown for re-initialization
      expect(service._isShuttingDown).toBe(false);
      expect(service._initialized).toBe(false);
    });

    test('is safe to call multiple times (re-entrance guard)', async () => {
      await service.shutdown();
      await service.shutdown(); // Second call skips since _isShuttingDown resets
      // Should not throw
      expect(service._initialized).toBe(false);
    });

    // Regression: _isShuttingDown used to be reset inside the try body,
    // so an unexpected throw earlier in shutdown (e.g. the unwrapped
    // background-work drain) left the latch stuck true forever, turning
    // every later shutdown into a silent no-op. The reset now lives in a
    // finally, so the latch always clears.
    test('re-entrance latch clears even when shutdown throws', async () => {
      service._bgWork = {
        drain: jest.fn().mockRejectedValue(new Error('drain exploded')),
        track: jest.fn()
      };

      await expect(service.shutdown()).rejects.toThrow('drain exploded');
      expect(service._isShuttingDown).toBe(false);

      // A subsequent shutdown must run the full body, not hit the
      // "already in progress" early return: _initialized gets cleared.
      service._bgWork.drain.mockResolvedValue(undefined);
      service._initialized = true;
      await service.shutdown();
      expect(service._initialized).toBe(false);
      expect(service._isShuttingDown).toBe(false);
    });

    test('unloads models when memory manager and coordinator available', async () => {
      service._initialized = true;
      const unloadAll = jest.fn().mockResolvedValue();
      service._modelMemoryManager = { unloadAll, destroy: jest.fn() };
      service._metrics = { destroy: jest.fn() };
      // Need a coordinator that resolves idle check
      service._coordinator = {
        _waitForIdleOperations: jest.fn().mockResolvedValue(true)
      };
      service._waitForIdleOperations = jest.fn().mockResolvedValue(true);

      await service.shutdown();

      expect(unloadAll).toHaveBeenCalled();
    });
  });

  describe('acquireModelLoadLock', () => {
    test('returns release function from coordinator', async () => {
      const release = await service.acquireModelLoadLock('text');
      expect(typeof release).toBe('function');
    });
  });

  describe('listModels', () => {
    test('returns empty array when models path not configured', async () => {
      service._config = {};
      service._ensureConfigLoaded = jest.fn().mockResolvedValue();

      const models = await service.listModels();
      expect(Array.isArray(models)).toBe(true);
    });
  });

  describe('supportsVisionInput', () => {
    test('returns false when vision service unavailable', async () => {
      const result = await service.supportsVisionInput();
      expect(result).toBe(false);
    });
  });

  describe('batchGenerateEmbeddings', () => {
    test('rejects non-array input', async () => {
      service._initialized = true;
      service._ensureConfigLoaded = jest.fn().mockResolvedValue();
      service._config = { embeddingModel: 'embed.gguf' };

      await expect(service.batchGenerateEmbeddings('not-array')).rejects.toThrow();
    });

    test('returns empty result for empty array', async () => {
      service._initialized = true;
      service._ensureConfigLoaded = jest.fn().mockResolvedValue();
      service._config = { embeddingModel: 'embed.gguf' };

      const result = await service.batchGenerateEmbeddings([]);
      expect(result).toEqual({ embeddings: [], failedIndexes: [] });
    });
  });
});
