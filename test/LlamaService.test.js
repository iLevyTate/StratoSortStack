/**
 * Tests for LlamaService
 * Focus: initialization flow and configuration loading.
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

jest.mock('../src/main/services/ModelMemoryManager', () => ({
  ModelMemoryManager: jest.fn().mockImplementation(() => ({
    ensureModelLoaded: jest.fn().mockResolvedValue(true),
    unloadAll: jest.fn().mockResolvedValue(undefined)
  }))
}));

jest.mock('../src/main/services/ModelAccessCoordinator', () => ({
  ModelAccessCoordinator: jest.fn().mockImplementation(() => ({
    acquireLoadLock: jest.fn(async () => () => {}),
    withModel: jest.fn((_, fn) => fn())
  }))
}));

jest.mock('../src/main/services/PerformanceMetrics', () => ({
  PerformanceMetrics: jest.fn().mockImplementation(() => ({
    recordEmbedding: jest.fn(),
    recordModelLoad: jest.fn(),
    destroy: jest.fn()
  }))
}));

jest.mock('../src/main/services/GPUMonitor', () => ({
  GPUMonitor: jest.fn().mockImplementation(() => ({})),
  getInstance: jest.fn(() => ({}))
}));

// Mirrors the real SettingsService instance contract LlamaService uses
// (load() in _loadConfig, save() when persisting model fallbacks).
const mockSettings = {
  load: jest.fn().mockResolvedValue({}),
  save: jest.fn().mockResolvedValue(undefined)
};

jest.mock('../src/main/services/SettingsService', () => ({
  getInstance: jest.fn(() => mockSettings)
}));

jest.mock('../src/main/services/LlamaResilience', () => ({
  withLlamaResilience: (fn) => fn({}),
  cleanupLlamaCircuits: jest.fn(),
  resetLlamaCircuit: jest.fn(),
  shouldFallbackToCPU: jest.fn()
}));

// PerformanceService.getRecommendedConcurrency() spawns nvidia-smi / system
// probes with a 5s timeout per child process. Without this mock the init test
// flakes past Jest's default 5s testTimeout under any system load. Mock with a
// fast resolved value so init stays in pure-JS land.
jest.mock('../src/main/services/PerformanceService', () => ({
  getRecommendedConcurrency: jest.fn().mockResolvedValue({
    maxConcurrent: 1,
    reason: 'test-mock',
    vramMB: 0,
    gpuName: null
  })
}));

const { LlamaService } = require('../src/main/services/LlamaService');
const { AI_DEFAULTS } = require('../src/shared/constants');
const { ERROR_CODES } = require('../src/shared/errorCodes');
const fs = require('fs').promises;
const path = require('path');

describe('LlamaService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('initialize', () => {
    test('sets initialized and emits event', async () => {
      const service = new LlamaService();
      service._ensureConfigLoaded = jest.fn().mockResolvedValue(undefined);
      service._initializeLlama = jest.fn().mockResolvedValue(undefined);

      const onInit = jest.fn();
      service.on('initialized', onInit);

      await service.initialize();

      expect(service._initialized).toBe(true);
      expect(service._initializeLlama).toHaveBeenCalled();
      expect(onInit).toHaveBeenCalledWith(
        expect.objectContaining({ gpuBackend: service._gpuBackend })
      );
    });
  });

  describe('GPU backend cache wiring', () => {
    const { app } = require('electron');
    const selector = require('../src/main/utils/llamaBackendSelector');
    const { BACKEND_CACHE_FILENAME } = require('../src/main/utils/llamaBackendCache');
    const expectedRecordPath = path.join(app.getPath('userData'), BACKEND_CACHE_FILENAME);

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('builds the record under userData, fingerprinted by versions and the detected GPU', async () => {
      const service = new LlamaService();
      service._detectedGpu = { type: 'cuda', name: 'NVIDIA GeForce RTX 4070' };

      const cache = await service._createLlamaBackendCache({
        getModuleVersion: jest.fn().mockResolvedValue('3.22.2')
      });

      expect(cache.filePath).toBe(expectedRecordPath);
      expect(cache.fingerprint).toEqual({
        platform: process.platform,
        arch: process.arch,
        appVersion: app.getVersion(),
        nodeLlamaVersion: '3.22.2',
        gpuType: 'cuda',
        gpuName: 'NVIDIA GeForce RTX 4070',
        driverVersion: null
      });
    });

    test('carries a null node-llama-cpp version when the module cannot report one', async () => {
      const service = new LlamaService();

      const withoutHelper = await service._createLlamaBackendCache({});
      const withFailingHelper = await service._createLlamaBackendCache({
        getModuleVersion: jest.fn().mockRejectedValue(new Error('package.json unreadable'))
      });

      expect(withoutHelper.fingerprint.nodeLlamaVersion).toBeNull();
      expect(withFailingHelper.fingerprint.nodeLlamaVersion).toBeNull();
    });

    test('returns no cache when userData cannot be resolved', async () => {
      const service = new LlamaService();
      app.getPath.mockImplementationOnce(() => {
        throw new Error('userData not ready');
      });

      await expect(service._createLlamaBackendCache({})).resolves.toBeUndefined();
    });

    test('_initializeLlama hands the cache to the backend selector', async () => {
      const service = new LlamaService();
      service._gpuMonitor = {
        detectGPU: jest.fn().mockResolvedValue({ type: 'cuda', name: 'NVIDIA GeForce RTX 4070' })
      };
      const initSpy = jest.spyOn(selector, 'initLlamaWithBackend').mockResolvedValue({
        llama: { gpu: false },
        backend: 'cpu',
        selection: { attempted: [], selected: 'cpu', requested: 'auto', detectedGpu: null }
      });

      await service._initializeLlama();

      expect(initSpy).toHaveBeenCalledTimes(1);
      const { backendCache } = initSpy.mock.calls[0][0];
      expect(backendCache).toEqual(
        expect.objectContaining({
          filePath: expectedRecordPath,
          read: expect.any(Function),
          write: expect.any(Function),
          clear: expect.any(Function)
        })
      );
      expect(backendCache.fingerprint).toEqual(
        expect.objectContaining({ gpuType: 'cuda', gpuName: 'NVIDIA GeForce RTX 4070' })
      );
    });
  });

  describe('_loadConfig', () => {
    test('uses settings when available', async () => {
      const service = new LlamaService();
      mockSettings.load.mockResolvedValue({
        textModel: 'text.gguf',
        visionModel: 'vision.gguf',
        embeddingModel: 'embed.gguf',
        llamaGpuLayers: 12
      });

      await service._loadConfig();

      expect(service._selectedModels.text).toBe('text.gguf');
      expect(service._selectedModels.vision).toBe('vision.gguf');
      expect(service._selectedModels.embedding).toBe('embed.gguf');
      expect(service._config.gpuLayers).toBe(12);
    });

    test('falls back to defaults on error', async () => {
      const service = new LlamaService();
      mockSettings.load.mockRejectedValue(new Error('boom'));

      await service._loadConfig();

      expect(service._selectedModels.text).toBe(AI_DEFAULTS.TEXT.MODEL);
      expect(service._selectedModels.vision).toBe(AI_DEFAULTS.IMAGE.MODEL);
      expect(service._selectedModels.embedding).toBe(AI_DEFAULTS.EMBEDDING.MODEL);
    });
  });

  describe('isModelReady', () => {
    test('true when a model of the type is already resident', () => {
      const service = new LlamaService();
      service._models.text = { dispose: jest.fn() };
      expect(service.isModelReady('text')).toBe(true);
    });

    test('true when a model of the type is selected (lazy-load path)', () => {
      const service = new LlamaService();
      service._models.text = null;
      service._selectedModels.text = AI_DEFAULTS.TEXT.MODEL;
      expect(service.isModelReady('text')).toBe(true);
    });

    test('false and kicks off config load before config is loaded', () => {
      const service = new LlamaService();
      service._models = { text: null, vision: null, embedding: null };
      service._selectedModels = { text: null, vision: null, embedding: null };
      service._configLoaded = false;
      service._configLoadPromise = null;
      const ensureSpy = jest.spyOn(service, '_ensureConfigLoaded').mockResolvedValue(undefined);

      expect(service.isModelReady('text')).toBe(false);
      expect(ensureSpy).toHaveBeenCalled();
    });

    test('defaults to text and normalizes unknown types', () => {
      const service = new LlamaService();
      service._selectedModels.text = AI_DEFAULTS.TEXT.MODEL;
      expect(service.isModelReady()).toBe(true);
      expect(service.isModelReady('bogus')).toBe(true);
    });

    test('vision/embedding readiness is independent of text', () => {
      const service = new LlamaService();
      service._models = { text: null, vision: null, embedding: null };
      service._selectedModels = { text: AI_DEFAULTS.TEXT.MODEL, vision: null, embedding: null };
      service._configLoaded = true;
      expect(service.isModelReady('vision')).toBe(false);
      expect(service.isModelReady('embedding')).toBe(false);
    });
  });

  describe('testConnection', () => {
    test('returns healthy status when listModels succeeds', async () => {
      const service = new LlamaService();
      service._ensureConfigLoaded = jest.fn().mockResolvedValue(undefined);
      service.listModels = jest.fn().mockResolvedValue([{ name: 'model' }]);
      service._gpuBackend = 'cpu';

      const result = await service.testConnection();

      expect(result.success).toBe(true);
      expect(result.status).toBe('healthy');
      expect(result.modelCount).toBe(1);
    });

    test('returns unhealthy status when listModels fails', async () => {
      const service = new LlamaService();
      service._ensureConfigLoaded = jest.fn().mockResolvedValue(undefined);
      service.listModels = jest.fn().mockRejectedValue(new Error('fail'));

      const result = await service.testConnection();

      expect(result.success).toBe(false);
      expect(result.status).toBe('unhealthy');
    });
  });

  describe('supportsVisionInput', () => {
    test('rechecks negative vision support after ttl expires', async () => {
      const service = new LlamaService();
      service._ensureConfigLoaded = jest.fn().mockResolvedValue(undefined);
      service._selectedModels.vision = 'vision.gguf';
      service._config = { visionModel: 'vision.gguf' };
      service._ensureVisionAssets = jest
        .fn()
        .mockRejectedValueOnce(new Error('warming up'))
        .mockResolvedValueOnce(undefined);
      service._visionProjectorStatus = { required: false, available: true };

      const nowSpy = jest
        .spyOn(Date, 'now')
        .mockReturnValueOnce(1_000)
        .mockReturnValueOnce(2_000)
        .mockReturnValueOnce(20_000)
        .mockReturnValueOnce(21_000);

      try {
        await expect(service.supportsVisionInput()).resolves.toBe(false);
        await expect(service.supportsVisionInput()).resolves.toBe(false);
        await expect(service.supportsVisionInput()).resolves.toBe(true);
        expect(service._ensureVisionAssets).toHaveBeenCalledTimes(2);
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  describe('updateConfig', () => {
    test('an unchanged contextSize leaves the hardware-aware preferences alone; a change re-derives them', async () => {
      // Every settings save forwards llamaContextSize. Nulling the
      // preferences on an unchanged value left the effective text context
      // at the configured 8192 while the resident context was the CPU
      // ceiling of 2048.
      const service = new LlamaService();
      service._ensureConfigLoaded = jest.fn().mockResolvedValue(undefined);
      service._gpuBackend = 'cpu';
      service._detectedGpu = null;
      service._config = { ...service._config, contextSize: 8192 };
      service._applyContextSizing();
      expect(service._preferredContextSize.text).toBe(2048);
      const visionBefore = service._visionContextSize;

      await service.updateConfig({ contextSize: 8192 }, { skipSave: true });

      expect(service._preferredContextSize.text).toBe(2048);
      expect(service._preferredContextSequences.text).toBe(1);
      expect(service._visionContextSize).toBe(visionBefore);
      expect(service._getEffectiveContextSize('text')).toBe(2048);

      await service.updateConfig({ llamaContextSize: 4096 }, { skipSave: true });

      expect(service._config.contextSize).toBe(4096);
      // Re-derived for the new ceiling, not nulled.
      expect(service._preferredContextSize.text).toBe(2048);
      expect(Number.isFinite(service._visionContextSize)).toBe(true);
    });

    test('the memory budget follows the backend: no VRAM budget on the CPU backend or with gpuLayers 0', async () => {
      // A 24 GB card the engine cannot use is not where the weights go: with
      // the budget still VRAM-sized, text, vision and whisper were all
      // admitted into 16 GB of system RAM.
      const service = new LlamaService();
      service._ensureConfigLoaded = jest.fn().mockResolvedValue(undefined);
      service._detectedGpu = { type: 'nvidia', name: 'RTX 3090', vramMB: 24576 };
      service._gpuBackend = 'cuda';
      service._config = { ...service._config, gpuLayers: 999 };
      expect(service._memoryBudgetGpuInfo()).toEqual(service._detectedGpu);

      service._gpuBackend = 'cpu';
      expect(service._memoryBudgetGpuInfo()).toBeNull();

      service._gpuBackend = 'cuda';
      const setGpuInfo = jest.fn();
      service._modelMemoryManager = { setGpuInfo, getMemoryStatus: () => ({ loadedModels: [] }) };
      await service.updateConfig({ gpuLayers: 0 }, { skipSave: true });
      expect(setGpuInfo).toHaveBeenLastCalledWith(null);
      await service.updateConfig({ gpuLayers: 999 }, { skipSave: true });
      expect(setGpuInfo).toHaveBeenLastCalledWith(service._detectedGpu);
      // Unchanged layers do not touch the budget.
      setGpuInfo.mockClear();
      await service.updateConfig({ gpuLayers: 999 }, { skipSave: true });
      expect(setGpuInfo).not.toHaveBeenCalled();
    });

    test('an unchanged textModel keeps the substitution notice; a different model clears it', async () => {
      const { getInstance } = require('../src/main/services/DegradedStateTracker');
      const tracker = getInstance();
      tracker.clear('llama.text-model-substituted');
      const service = new LlamaService();
      service._ensureConfigLoaded = jest.fn().mockResolvedValue(undefined);
      service._selectedModels.text = 'fallback-3b.gguf';
      const flagged = () =>
        tracker.list().some((flag) => flag.code === 'llama.text-model-substituted');

      tracker.raise({
        code: 'llama.text-model-substituted',
        subsystem: 'llama',
        severity: 'warning',
        message: 'substituted'
      });
      expect(flagged()).toBe(true);

      // What every settings save, import and restore forwards: the stored
      // (substituted) name, unchanged.
      await service.updateConfig({ textModel: 'fallback-3b.gguf' }, { skipSave: true });
      expect(flagged()).toBe(true);

      await service.updateConfig({ textModel: 'chosen-7b.gguf' }, { skipSave: true });
      expect(flagged()).toBe(false);
      tracker.clear('llama.text-model-substituted');
    });

    test('accepts unrecognized embedding model with warning (no downgrade)', async () => {
      const service = new LlamaService();
      service._ensureConfigLoaded = jest.fn().mockResolvedValue(undefined);

      const res = await service.updateConfig(
        { embeddingModel: 'not-a-real-text-model.gguf' },
        { skipSave: true }
      );

      expect(res.success).toBe(true);
      // Source code was updated to accept unrecognized models instead of downgrading
      expect(res.modelDowngraded).toBeFalsy();
      expect(service._selectedModels.embedding).toBe('not-a-real-text-model.gguf');
    });

    test('emits model-change events for changed model types', async () => {
      const service = new LlamaService();
      service._ensureConfigLoaded = jest.fn().mockResolvedValue(undefined);
      service._selectedModels.embedding = AI_DEFAULTS.EMBEDDING.MODEL;

      const onChange = jest.fn();
      service.on('model-change', onChange);

      await service.updateConfig(
        { embeddingModel: 'mxbai-embed-large-v1-f16.gguf' },
        { skipSave: true }
      );

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'embedding',
          previousModel: AI_DEFAULTS.EMBEDDING.MODEL,
          newModel: 'mxbai-embed-large-v1-f16.gguf'
        })
      );
    });

    test('marks resident models stale when GPU layers or context size change (ST-04)', async () => {
      const service = new LlamaService();
      service._ensureConfigLoaded = jest.fn().mockResolvedValue(undefined);
      service._config.gpuLayers = -1;
      service._config.contextSize = 8192;
      service._modelMemoryManager = {
        unloadAll: jest.fn(),
        getMemoryStatus: jest.fn(() => ({ loadedModels: ['text', 'embedding'] }))
      };

      await service.updateConfig(
        { llamaGpuLayers: 20, llamaContextSize: 4096 },
        { skipSave: true }
      );

      expect(service._config.gpuLayers).toBe(20);
      expect(service._config.contextSize).toBe(4096);
      expect([...service._staleModelTypes].sort()).toEqual(['embedding', 'text']);
      // Tuning alone does not unload anything; the swap happens on next use.
      expect(service._modelMemoryManager.unloadAll).not.toHaveBeenCalled();

      service._staleModelTypes.clear();
      await service.updateConfig(
        { llamaGpuLayers: 20, llamaContextSize: 4096 },
        { skipSave: true }
      );
      expect(service._staleModelTypes.size).toBe(0);
    });

    test('serializes concurrent calls — gate is not released mid-teardown', async () => {
      const service = new LlamaService();
      service._ensureConfigLoaded = jest.fn().mockResolvedValue(undefined);
      service._waitForIdleOperations = jest.fn().mockResolvedValue(true);
      service._coordinator = null;

      const order = [];
      let releaseFirstUnload;
      const firstUnloadGate = new Promise((resolve) => {
        releaseFirstUnload = resolve;
      });
      let unloadCalls = 0;
      service._modelMemoryManager = {
        unloadAll: jest.fn(async () => {
          unloadCalls += 1;
          order.push(`unload-start-${unloadCalls}`);
          if (unloadCalls === 1) await firstUnloadGate;
          order.push(`unload-end-${unloadCalls}`);
        }),
        getMemoryStatus: jest.fn(() => ({ loadedModels: [] }))
      };

      const a = service.updateConfig({ textModel: 'model-a.gguf' }, { skipSave: true });
      const b = service.updateConfig({ textModel: 'model-b.gguf' }, { skipSave: true });

      await new Promise((resolve) => setTimeout(resolve, 20));
      // A is mid-teardown: B must not have started its own teardown, and the
      // config-change gate (which blocks inference) must still be held.
      expect(order).toEqual(['unload-start-1']);
      expect(service._configChangeGate).not.toBeNull();

      releaseFirstUnload();
      await a;
      await b;

      expect(order).toEqual(['unload-start-1', 'unload-end-1', 'unload-start-2', 'unload-end-2']);
      expect(service._selectedModels.text).toBe('model-b.gguf');
      expect(service._configChangeGate).toBeNull();
    });

    test('accepts legacy llama* keys for gpu/context settings', async () => {
      const service = new LlamaService();
      service._ensureConfigLoaded = jest.fn().mockResolvedValue(undefined);

      await service.updateConfig(
        {
          llamaGpuLayers: 21,
          llamaContextSize: 12288
        },
        { skipSave: true }
      );

      expect(service._config.gpuLayers).toBe(21);
      expect(service._config.contextSize).toBe(12288);
    });
  });

  describe('_resolveGpuLayersForVisionServer', () => {
    function visionGpuService(opts = {}) {
      const gpuLayers = Object.prototype.hasOwnProperty.call(opts, 'gpuLayers')
        ? opts.gpuLayers
        : 'auto';
      const strategyResult = Object.prototype.hasOwnProperty.call(opts, 'strategyResult')
        ? opts.strategyResult
        : 42;
      const detectedGpu = Object.prototype.hasOwnProperty.call(opts, 'detectedGpu')
        ? opts.detectedGpu
        : undefined;

      const service = new LlamaService();
      const modelsPath = path.join('__vision_gpu_test__', 'models');
      service._modelsPath = modelsPath;
      service._config = { gpuLayers };
      service._detectedGpu = detectedGpu;
      service._resolveGpuLayerStrategy = jest.fn().mockResolvedValue(strategyResult);
      return { service, modelsPath, modelName: 'vision.gguf' };
    }

    test('returns 0 when forceCpuVision is true (ignores numeric gpuLayers)', async () => {
      const { service, modelName } = visionGpuService({ gpuLayers: 99 });
      await expect(service._resolveGpuLayersForVisionServer(modelName, true)).resolves.toBe(0);
      expect(service._resolveGpuLayerStrategy).not.toHaveBeenCalled();
    });

    test('returns configured finite gpuLayers without calling strategy', async () => {
      const { service, modelName } = visionGpuService({ gpuLayers: 24 });
      await expect(service._resolveGpuLayersForVisionServer(modelName, false)).resolves.toBe(24);
      expect(service._resolveGpuLayerStrategy).not.toHaveBeenCalled();
    });

    test('returns 0 when gpuLayers config is 0', async () => {
      const { service, modelName } = visionGpuService({ gpuLayers: 0 });
      await expect(service._resolveGpuLayersForVisionServer(modelName, false)).resolves.toBe(0);
      expect(service._resolveGpuLayerStrategy).not.toHaveBeenCalled();
    });

    test('delegates to strategy when gpuLayers is non-numeric (e.g. auto string)', async () => {
      const { service, modelsPath, modelName } = visionGpuService({
        gpuLayers: 'auto',
        strategyResult: 17
      });
      await expect(service._resolveGpuLayersForVisionServer(modelName, false)).resolves.toBe(17);
      expect(service._resolveGpuLayerStrategy).toHaveBeenCalledWith(
        path.join(modelsPath, modelName),
        'vision'
      );
    });

    test('returns 999 when strategy is non-finite and VRAM telemetry is missing', async () => {
      const { service, modelName } = visionGpuService({
        gpuLayers: undefined,
        strategyResult: undefined,
        detectedGpu: undefined
      });
      await expect(service._resolveGpuLayersForVisionServer(modelName, false)).resolves.toBe(999);
    });

    test('returns 999 when strategy is non-finite and vramMB is 0', async () => {
      const { service, modelName } = visionGpuService({
        strategyResult: undefined,
        detectedGpu: { vramMB: 0 }
      });
      await expect(service._resolveGpuLayersForVisionServer(modelName, false)).resolves.toBe(999);
    });

    test('tight VRAM (6 GB, 5 GB model): returns explicit reduced layer count', async () => {
      const { service, modelName } = visionGpuService({
        strategyResult: undefined,
        detectedGpu: { vramMB: 6141 }
      });
      service._safeStatMB = jest.fn().mockResolvedValue(4994);
      service._visionContextSize = 4608;
      service._visionProjectorStatus = { projectorSizeMB: 596 };

      const layers = await service._resolveGpuLayersForVisionServer(modelName, false);
      // ~(6141 - 596 - 1152 - 600) / ceil(4994/33) ≈ 3793 / 152 ≈ 24 layers.
      // Exact number depends on per-layer rounding; assert "partial offload"
      // shape (1 <= layers < total) rather than pinning the literal so the
      // test survives small adjustments to the overhead constant.
      expect(typeof layers).toBe('number');
      expect(layers).toBeGreaterThanOrEqual(1);
      expect(layers).toBeLessThan(33);
    });

    test('very tight VRAM (2 GB) — returns 0 (CPU)', async () => {
      const { service, modelName } = visionGpuService({
        strategyResult: undefined,
        detectedGpu: { vramMB: 2048 }
      });
      service._safeStatMB = jest.fn().mockResolvedValue(4994);
      service._visionContextSize = 4608;
      service._visionProjectorStatus = { projectorSizeMB: 596 };

      await expect(service._resolveGpuLayersForVisionServer(modelName, false)).resolves.toBe(0);
    });

    test('comfortable VRAM (24 GB): strategy returns 999, passes through unchanged', async () => {
      const { service, modelName } = visionGpuService({
        strategyResult: 999,
        detectedGpu: { vramMB: 24576 }
      });
      await expect(service._resolveGpuLayersForVisionServer(modelName, false)).resolves.toBe(999);
    });

    test('non-finite numeric strategy (NaN): falls through to explicit-layer branch', async () => {
      const { service, modelName } = visionGpuService({
        strategyResult: NaN,
        detectedGpu: { vramMB: 8192 }
      });
      service._safeStatMB = jest.fn().mockResolvedValue(4994);
      service._visionContextSize = 4608;
      service._visionProjectorStatus = { projectorSizeMB: 596 };

      const layers = await service._resolveGpuLayersForVisionServer(modelName, false);
      expect(typeof layers).toBe('number');
      expect(layers).toBeGreaterThanOrEqual(1);
    });
  });

  describe('enterVisionBatchMode', () => {
    test('evicts audio (whisper) in addition to text and embedding', async () => {
      const service = new LlamaService();
      const unloadModel = jest.fn().mockResolvedValue(true);
      service._modelMemoryManager = {
        unloadModel,
        registerExternalConsumer: jest.fn(),
        unregisterExternalConsumer: jest.fn()
      };
      service._bgWork = { track: jest.fn() };

      await service.enterVisionBatchMode();

      const types = unloadModel.mock.calls.map((args) => args[0]);
      expect(types).toEqual(expect.arrayContaining(['text', 'embedding', 'audio']));
      // text and embedding must come before audio since audio is "best effort"
      // and we don't want a slow whisper drain to delay the primary unloads.
      expect(types.indexOf('text')).toBeLessThan(types.indexOf('audio'));
      expect(types.indexOf('embedding')).toBeLessThan(types.indexOf('audio'));
    });

    test('refuses batch mode when pinned residents leave no room for the vision runtime (ML-01)', async () => {
      const service = new LlamaService();
      service._estimateVisionRuntimeBytes = jest.fn().mockResolvedValue(5 * 1024 ** 3);
      service._modelMemoryManager = {
        unloadModel: jest.fn().mockResolvedValue(false),
        canFitExternalLoad: jest.fn(() => false),
        getMemoryStatus: jest.fn(() => ({
          loadedModels: ['text'],
          maxMemoryMB: 7168,
          currentUsageMB: 4096
        })),
        registerExternalConsumer: jest.fn(),
        unregisterExternalConsumer: jest.fn()
      };
      service._bgWork = { track: jest.fn() };

      await expect(service.enterVisionBatchMode()).rejects.toMatchObject({
        code: 'MODEL_MEMORY_BUDGET_EXCEEDED'
      });
      // Batch mode did not stick: the next caller starts clean.
      expect(service._visionBatchMode).toBe(false);
      expect(service._visionBatchModeRefs).toBe(0);
    });

    test('audio unload failure does not break batch mode entry', async () => {
      const service = new LlamaService();
      service._modelMemoryManager = {
        unloadModel: jest.fn().mockImplementation((type) => {
          if (type === 'audio') return Promise.reject(new Error('no audio consumer'));
          return Promise.resolve(true);
        }),
        registerExternalConsumer: jest.fn(),
        unregisterExternalConsumer: jest.fn()
      };
      service._bgWork = { track: jest.fn() };

      await expect(service.enterVisionBatchMode()).resolves.toBeUndefined();
      expect(service._visionBatchMode).toBe(true);
      expect(service._visionBatchModeRefs).toBe(1);
    });
  });

  describe('generateEmbedding', () => {
    test('throws INVALID_INPUT for non-string input', async () => {
      const service = new LlamaService();
      service._initialized = true;
      service._ensureConfigLoaded = jest.fn().mockResolvedValue(undefined);
      service._metrics = { recordEmbedding: jest.fn() };
      service._coordinator = { withModel: (_type, fn) => fn() };

      await expect(service.generateEmbedding({ text: 'nope' })).rejects.toEqual(
        expect.objectContaining({ code: ERROR_CODES.INVALID_INPUT })
      );
    });

    test('throws with LLAMA_INFERENCE_FAILED code when embedding fails', async () => {
      const service = new LlamaService();
      service._initialized = true;
      service._ensureConfigLoaded = jest.fn().mockResolvedValue(undefined);
      service._metrics = { recordEmbedding: jest.fn() };
      service._coordinator = { withModel: (_type, fn) => fn() };

      const err = new Error('failure');
      const context = { getEmbeddingFor: jest.fn().mockRejectedValue(err) };
      service._ensureModelLoaded = jest.fn().mockResolvedValue(context);

      try {
        await service.generateEmbedding('hello');
        throw new Error('Expected generateEmbedding to throw');
      } catch (e) {
        expect(e).toBe(err);
        expect(e.code).toBe(ERROR_CODES.LLAMA_INFERENCE_FAILED);
      }
    });

    test('throws with LLAMA_OOM code when error indicates out of memory', async () => {
      const service = new LlamaService();
      service._initialized = true;
      service._ensureConfigLoaded = jest.fn().mockResolvedValue(undefined);
      service._metrics = { recordEmbedding: jest.fn() };
      service._coordinator = { withModel: (_type, fn) => fn() };

      const err = new Error('CUDA out of memory');
      const context = { getEmbeddingFor: jest.fn().mockRejectedValue(err) };
      service._ensureModelLoaded = jest.fn().mockResolvedValue(context);

      await expect(service.generateEmbedding('hello')).rejects.toEqual(
        expect.objectContaining({ code: ERROR_CODES.LLAMA_OOM })
      );
    });
  });

  describe('embedding fallback chain', () => {
    function createServiceForFallback(primaryModel = 'missing-embed.gguf') {
      const service = new LlamaService();
      service._initialized = true;
      service._ensureConfigLoaded = jest.fn().mockResolvedValue(undefined);
      service._metrics = { recordEmbedding: jest.fn() };
      service._coordinator = { withModel: (_type, fn) => fn() };
      service._modelMemoryManager = {
        acquireRef: jest.fn(),
        releaseRef: jest.fn(),
        unloadModel: jest.fn().mockResolvedValue(undefined)
      };
      service._selectedModels = { embedding: primaryModel };
      return service;
    }

    test('tries fallback models when primary fails with MODEL_NOT_FOUND', async () => {
      const service = createServiceForFallback('missing-embed.gguf');

      const notFoundErr = new Error('Model not found: missing-embed.gguf');
      notFoundErr.code = ERROR_CODES.LLAMA_MODEL_NOT_FOUND;

      service._executeEmbeddingInference = jest.fn().mockRejectedValue(notFoundErr);
      service._executeEmbeddingInferenceWithModel = jest.fn().mockResolvedValue({
        embedding: [1, 2, 3],
        model: AI_DEFAULTS.EMBEDDING.FALLBACK_MODELS[0]
      });

      const result = await service.generateEmbedding('hello');

      expect(result.embedding).toEqual([1, 2, 3]);
      expect(result.model).toBe(AI_DEFAULTS.EMBEDDING.FALLBACK_MODELS[0]);
      expect(service._selectedModels.embedding).toBe('missing-embed.gguf');
      expect(service._modelMemoryManager.unloadModel).not.toHaveBeenCalled();
    });

    test('tries fallback on MODEL_LOAD_FAILED', async () => {
      const service = createServiceForFallback('corrupt-embed.gguf');

      const loadFailErr = new Error('Model corrupted');
      loadFailErr.code = ERROR_CODES.LLAMA_MODEL_LOAD_FAILED;

      service._executeEmbeddingInference = jest.fn().mockRejectedValue(loadFailErr);
      service._executeEmbeddingInferenceWithModel = jest
        .fn()
        .mockResolvedValue({ embedding: [4, 5], model: AI_DEFAULTS.EMBEDDING.FALLBACK_MODELS[0] });

      const result = await service.generateEmbedding('world');

      expect(result.embedding).toEqual([4, 5]);
      expect(service._selectedModels.embedding).toBe('corrupt-embed.gguf');
    });

    test('does not trigger fallback for LLAMA_INFERENCE_FAILED', async () => {
      const service = createServiceForFallback(AI_DEFAULTS.EMBEDDING.MODEL);

      const inferenceErr = new Error('inference blew up');
      inferenceErr.code = ERROR_CODES.LLAMA_INFERENCE_FAILED;
      service._executeEmbeddingInference = jest.fn().mockRejectedValue(inferenceErr);

      await expect(service.generateEmbedding('hello')).rejects.toEqual(
        expect.objectContaining({ code: ERROR_CODES.LLAMA_INFERENCE_FAILED })
      );
      expect(service._modelMemoryManager.unloadModel).not.toHaveBeenCalled();
    });

    test('does not trigger fallback for OOM', async () => {
      const service = createServiceForFallback(AI_DEFAULTS.EMBEDDING.MODEL);

      const oomErr = new Error('out of memory');
      oomErr.code = ERROR_CODES.LLAMA_OOM;
      service._executeEmbeddingInference = jest.fn().mockRejectedValue(oomErr);

      await expect(service.generateEmbedding('hello')).rejects.toEqual(
        expect.objectContaining({ code: ERROR_CODES.LLAMA_OOM })
      );
      expect(service._modelMemoryManager.unloadModel).not.toHaveBeenCalled();
    });

    test('restores original model name when all fallbacks fail', async () => {
      const primaryModel = 'custom-embed.gguf';
      const service = createServiceForFallback(primaryModel);

      const notFoundErr = new Error('Model not found');
      notFoundErr.code = ERROR_CODES.LLAMA_MODEL_NOT_FOUND;

      service._executeEmbeddingInference = jest.fn().mockRejectedValue(notFoundErr);
      service._executeEmbeddingInferenceWithModel = jest.fn().mockRejectedValue(notFoundErr);

      await expect(service.generateEmbedding('hello')).rejects.toBe(notFoundErr);
      expect(service._selectedModels.embedding).toBe(primaryModel);
    });

    test('skips fallback models that match the primary model', async () => {
      // Primary is the first fallback model — should skip it and try the second
      const originalFallbacks = [...AI_DEFAULTS.EMBEDDING.FALLBACK_MODELS];
      AI_DEFAULTS.EMBEDDING.FALLBACK_MODELS = [
        'nomic-embed-text-v1.5-Q4_K_M.gguf',
        'nomic-embed-text-v1.5-Q8_0.gguf'
      ];

      try {
        const service = createServiceForFallback(AI_DEFAULTS.EMBEDDING.FALLBACK_MODELS[0]);

        const notFoundErr = new Error('Model not found');
        notFoundErr.code = ERROR_CODES.LLAMA_MODEL_NOT_FOUND;

        service._executeEmbeddingInference = jest.fn().mockRejectedValue(notFoundErr);
        service._executeEmbeddingInferenceWithModel = jest.fn().mockResolvedValue({
          embedding: [7, 8],
          model: AI_DEFAULTS.EMBEDDING.FALLBACK_MODELS[1]
        });

        const result = await service.generateEmbedding('hello');

        expect(result.model).toBe(AI_DEFAULTS.EMBEDDING.FALLBACK_MODELS[1]);
      } finally {
        AI_DEFAULTS.EMBEDDING.FALLBACK_MODELS = originalFallbacks;
      }
    });

    test('handles wrapped errors from resilience layer via originalError.code', async () => {
      const service = createServiceForFallback('missing-embed.gguf');

      // In production, withLlamaResilience wraps the error AFTER the inner catch.
      // The wrapped error has no .code but .originalError has the real code.
      // Mock _executeEmbeddingInference directly to simulate this.
      const innerErr = new Error('Model not found: missing-embed.gguf');
      innerErr.code = ERROR_CODES.LLAMA_MODEL_NOT_FOUND;
      const wrappedErr = new Error(`Llama operation failed: ${innerErr.message}`);
      wrappedErr.originalError = innerErr;

      service._executeEmbeddingInference = jest.fn().mockRejectedValue(wrappedErr);
      service._executeEmbeddingInferenceWithModel = jest
        .fn()
        .mockResolvedValue({ embedding: [9], model: AI_DEFAULTS.EMBEDDING.FALLBACK_MODELS[0] });

      const result = await service.generateEmbedding('hello');

      expect(result.embedding).toEqual([9]);
      expect(service._selectedModels.embedding).toBe('missing-embed.gguf');
    });

    test('retries fallback model on CPU when initial GPU load fails', async () => {
      const { shouldFallbackToCPU } = require('../src/main/services/LlamaResilience');
      shouldFallbackToCPU.mockImplementation((error) => /gpu/i.test(error?.message || ''));

      const service = createServiceForFallback('missing-embed.gguf');
      service._modelsPath = '/mock/models';
      service._llama = {
        loadModel: jest
          .fn()
          .mockRejectedValueOnce(new Error('GPU allocation failed'))
          .mockResolvedValueOnce({
            createEmbeddingContext: jest.fn().mockResolvedValue({
              getEmbeddingFor: jest.fn().mockResolvedValue({
                vector: Float32Array.from([0.1, 0.2, 0.3])
              }),
              dispose: jest.fn().mockResolvedValue(undefined)
            }),
            dispose: jest.fn().mockResolvedValue(undefined)
          })
      };
      service._config.gpuLayers = 24;
      const accessSpy = jest.spyOn(fs, 'access').mockResolvedValue(undefined);

      try {
        const result = await service._executeEmbeddingInferenceWithModel(
          'hello world',
          'nomic-embed-text-v1.5-Q8_0.gguf'
        );

        expect(result.embedding).toHaveLength(3);
        expect(result.embedding[0]).toBeCloseTo(0.1, 5);
        expect(result.embedding[1]).toBeCloseTo(0.2, 5);
        expect(result.embedding[2]).toBeCloseTo(0.3, 5);
        expect(service._llama.loadModel).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            gpuLayers: 24
          })
        );
        expect(service._llama.loadModel).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            gpuLayers: 0
          })
        );
      } finally {
        accessSpy.mockRestore();
      }
    });
  });

  describe('shutdown', () => {
    test('skips unload/dispose when operations are still active', async () => {
      const service = new LlamaService();
      service._metrics = { destroy: jest.fn() };
      service._modelMemoryManager = { unloadAll: jest.fn() };
      const llama = { dispose: jest.fn() };
      service._llama = llama;
      service._waitForIdleOperations = jest.fn().mockResolvedValue(false);

      await service.shutdown();

      expect(service._modelMemoryManager.unloadAll).not.toHaveBeenCalled();
      expect(llama.dispose).not.toHaveBeenCalled();
    });

    test('unloads and disposes when idle', async () => {
      const service = new LlamaService();
      service._metrics = { destroy: jest.fn() };
      service._modelMemoryManager = { unloadAll: jest.fn() };
      const llama = { dispose: jest.fn() };
      service._llama = llama;
      service._waitForIdleOperations = jest.fn().mockResolvedValue(true);

      await service.shutdown();

      expect(service._modelMemoryManager.unloadAll).toHaveBeenCalled();
      expect(llama.dispose).toHaveBeenCalled();
    });

    test('waits for existing config-change gate before unloading', async () => {
      const service = new LlamaService();
      service._metrics = { destroy: jest.fn() };
      service._modelMemoryManager = { unloadAll: jest.fn() };
      const llama = { dispose: jest.fn() };
      service._llama = llama;
      service._waitForIdleOperations = jest.fn().mockResolvedValue(true);

      let resolveGate;
      const gatePromise = new Promise((resolve) => {
        resolveGate = resolve;
      });
      service._configChangeGate = { promise: gatePromise, resolve: resolveGate };

      const shutdownPromise = service.shutdown();
      await Promise.resolve();

      expect(service._modelMemoryManager.unloadAll).not.toHaveBeenCalled();

      resolveGate();
      await shutdownPromise;

      expect(service._modelMemoryManager.unloadAll).toHaveBeenCalled();
    });

    test('clears stale model reload gates during shutdown', async () => {
      const service = new LlamaService();
      service._metrics = { destroy: jest.fn() };
      service._modelMemoryManager = { unloadAll: jest.fn() };
      service._llama = { dispose: jest.fn() };
      service._waitForIdleOperations = jest.fn().mockResolvedValue(true);

      service._beginModelReloadGate('text');
      service._beginModelReloadGate('vision');
      expect(service._modelReloadGates.size).toBe(2);

      await service.shutdown();

      expect(service._modelReloadGates.size).toBe(0);
    }, 15000);
  });

  describe('_applyContextSizing (hardware-aware context bias)', () => {
    function sizingService({ backend, vramMB, contextSize = 8192 }) {
      const service = new LlamaService();
      service._gpuBackend = backend;
      service._detectedGpu = vramMB == null ? null : { vramMB };
      service._config = { ...service._config, contextSize };
      return service;
    }

    test('CPU biases first-attempt text context down to 2048 with a single sequence', () => {
      const service = sizingService({ backend: 'cpu', vramMB: 0 });
      service._applyContextSizing();
      expect(service._preferredContextSize.text).toBe(2048);
      expect(service._preferredContextSequences.text).toBe(1);
      // Configured ceiling is never mutated.
      expect(service._config.contextSize).toBe(8192);
    });

    test('low-VRAM GPU (6GB) biases text context to 4096 with a single sequence', () => {
      const service = sizingService({ backend: 'vulkan', vramMB: 6144 });
      service._applyContextSizing();
      expect(service._preferredContextSize.text).toBe(4096);
      expect(service._preferredContextSequences.text).toBe(1);
      expect(service._config.contextSize).toBe(8192);
    });

    test('mid-VRAM GPU (10GB) biases text context to 6144 but keeps default sequences', () => {
      const service = sizingService({ backend: 'cuda', vramMB: 10240 });
      service._applyContextSizing();
      expect(service._preferredContextSize.text).toBe(6144);
      expect(service._preferredContextSequences.text).toBeNull();
      expect(service._config.contextSize).toBe(8192);
    });

    test('high-VRAM GPU (24GB) applies no cap and uses the configured size', () => {
      const service = sizingService({ backend: 'cuda', vramMB: 24576 });
      service._applyContextSizing();
      expect(service._preferredContextSize.text).toBeNull();
      expect(service._preferredContextSequences.text).toBeNull();
    });

    test('GPU with unknown VRAM applies no first-attempt cap', () => {
      const service = sizingService({ backend: 'vulkan', vramMB: 0 });
      service._applyContextSizing();
      expect(service._preferredContextSize.text).toBeNull();
    });

    test('never raises the first-attempt context above a smaller configured ceiling', () => {
      const service = sizingService({ backend: 'cpu', vramMB: 0, contextSize: 1536 });
      service._applyContextSizing();
      // CPU ceiling (2048) exceeds the configured 1536, so no bias is applied.
      expect(service._preferredContextSize.text).toBeNull();
      expect(service._config.contextSize).toBe(1536);
    });
  });
});
