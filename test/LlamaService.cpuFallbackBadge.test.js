/**
 * Real-coverage tests for the per-type CPU-fallback badge recorded by
 * LlamaService._loadModel() (audit row C7).
 *
 * These drive the REAL _loadModel(): the only stubs are the collaborators it
 * reaches out to (fs, the memory manager, the coordinator) and the
 * node-llama-cpp `Llama` handle, whose `loadModel()` returns a model object
 * shaped exactly like node-llama-cpp 3.21.1's `LlamaModel` for the one
 * property under test — `model.gpuLayers`, documented there as "Number of
 * layers offloaded to the GPU. If GPU support is disabled, this will always
 * be 0" and set from the count `resolveModelGpuLayersV2` resolves for the
 * load (not from what the caller requested; it is recomputed even for an
 * explicit numeric request, and resolved just before the native load rather
 * than read back from llama.cpp afterwards).
 *
 * The defect: the recording block keyed off the *requested* `gpuLayers`,
 * which is `undefined` on both auto paths, and `undefined !== 0` cleared the
 * record — so a model that node-llama-cpp placed entirely on the CPU under
 * tight VRAM reported as back on the GPU and the Settings badge went green.
 */

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const mockFsPromises = {
  access: jest.fn().mockResolvedValue(undefined),
  stat: jest.fn().mockResolvedValue({ size: 4.4 * 1024 * 1024 * 1024 }),
  readdir: jest.fn().mockResolvedValue([]),
  readFile: jest.fn().mockResolvedValue('{}'),
  writeFile: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
  rename: jest.fn().mockResolvedValue(undefined)
};

jest.mock('fs', () => ({
  promises: mockFsPromises,
  existsSync: jest.fn().mockReturnValue(true)
}));

const mockModelMemoryManager = {
  ensureModelLoaded: jest.fn(),
  unloadModel: jest.fn(),
  unloadAll: jest.fn().mockResolvedValue(undefined),
  acquireRef: jest.fn(),
  releaseRef: jest.fn(),
  updateModelSizeEstimate: jest.fn(),
  getMemoryStatus: jest.fn().mockReturnValue({ totalLoaded: 1 })
};

jest.mock('../src/main/services/ModelMemoryManager', () => ({
  ModelMemoryManager: jest.fn().mockImplementation(() => mockModelMemoryManager)
}));

jest.mock('../src/main/services/ModelAccessCoordinator', () => ({
  ModelAccessCoordinator: jest.fn().mockImplementation(() => ({
    acquireLoadLock: jest.fn(async () => () => {}),
    withModel: jest.fn((_modelType, fn) => fn()),
    getStatus: jest.fn(() => ({ operations: [] }))
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

jest.mock('../src/main/services/DegradationManager', () => ({
  DegradationManager: jest.fn().mockImplementation(() => ({
    checkSystemReadiness: jest.fn().mockResolvedValue({ ready: true, issues: [], gpuInfo: {} }),
    handleError: jest.fn().mockResolvedValue({ action: 'none' })
  }))
}));

jest.mock('../src/main/services/DegradedStateTracker', () => ({
  getInstance: jest.fn(() => ({ raise: jest.fn(), clear: jest.fn() }))
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
  })),
  confirmGpuBackend: jest.fn()
}));

jest.mock('../src/main/services/LlamaResilience', () => ({
  withLlamaResilience: jest.fn((fn) => fn({})),
  cleanupLlamaCircuits: jest.fn(),
  resetLlamaCircuit: jest.fn(),
  shouldFallbackToCPU: jest.fn().mockReturnValue(false)
}));

jest.mock('node-llama-cpp', () => ({
  getLlama: jest.fn(),
  LlamaChatSession: jest.fn()
}));

const { LlamaService } = require('../src/main/services/LlamaService');

/**
 * @param {{ realizedGpuLayers?: number|undefined, gpuBackend?: string, configGpuLayers?: any }} [opts]
 */
function createTestService(opts = {}) {
  const service = new LlamaService();
  service._initialized = true;
  service._modelsPath = '/mock/models';
  service._selectedModels = { text: 'text.gguf', vision: 'vision.gguf', embedding: 'embed.gguf' };
  service._config = {
    gpuLayers: 'configGpuLayers' in opts ? opts.configGpuLayers : 'auto',
    threads: 4,
    contextSize: 2048
  };
  service._gpuBackend = opts.gpuBackend || 'vulkan';
  // 6 GB laptop GPU: a 4.4 GB model is above the 60% safe threshold, so
  // _resolveGpuLayerStrategy answers `undefined` (auto) and _loadModel omits
  // gpuLayers from the load options entirely.
  service._detectedGpu = { vramMB: 6144 };
  service._modelMemoryManager = mockModelMemoryManager;

  const model = {
    createContext: jest.fn(async ({ contextSize }) => ({ contextSize, dispose: jest.fn() })),
    createEmbeddingContext: jest.fn(async () => ({ contextSize: 512 })),
    dispose: jest.fn()
  };
  if ('realizedGpuLayers' in opts) {
    model.gpuLayers = opts.realizedGpuLayers;
  }
  service._llama = { loadModel: jest.fn(async () => model) };
  return service;
}

describe('LlamaService._loadModel — per-type CPU-fallback record', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFsPromises.access.mockResolvedValue(undefined);
    mockFsPromises.stat.mockResolvedValue({ size: 4.4 * 1024 * 1024 * 1024 });
  });

  test('the auto path really is the auto path (no gpuLayers forwarded)', async () => {
    const service = createTestService({ realizedGpuLayers: 0 });

    await expect(service._resolveGpuLayerStrategy('/mock/models/text.gguf', 'text')).resolves.toBe(
      undefined
    );
    await service._loadModel('text');

    // Proves the premise of the other cases: on this VRAM/model pairing the
    // requested value is `undefined`, so only the model can say what loaded.
    expect(service._llama.loadModel).toHaveBeenCalledWith({ modelPath: expect.any(String) });
    expect(service._llama.loadModel.mock.calls[0][0]).not.toHaveProperty('gpuLayers');
  });

  test('an auto load that offloaded zero layers is recorded as a CPU fallback', async () => {
    const service = createTestService({ realizedGpuLayers: 0 });

    await service._loadModel('text');

    expect([...service._cpuFallbackTypes]).toEqual(['text']);
    expect(service.getHealthStatus()).toEqual(
      expect.objectContaining({
        usingCPUFallback: true,
        cpuFallbackTypes: ['text'],
        degraded: true
      })
    );
  });

  test('an auto load that offloaded zero layers does NOT clear an existing record', async () => {
    // The C7 regression: the previous code cleared on `gpuLayers !== 0`, and
    // the requested value is `undefined` here, so a prior real fallback was
    // wiped and the badge went green while text inference ran on the CPU.
    const service = createTestService({ realizedGpuLayers: 0 });
    service._cpuFallbackTypes.add('text');

    await service._loadModel('text');

    expect([...service._cpuFallbackTypes]).toEqual(['text']);
    expect(service.getHealthStatus().usingCPUFallback).toBe(true);
  });

  test('an auto load that did offload layers clears the record', async () => {
    const service = createTestService({ realizedGpuLayers: 20 });
    service._cpuFallbackTypes.add('text');

    await service._loadModel('text');

    expect([...service._cpuFallbackTypes]).toEqual([]);
    expect(service.getHealthStatus().usingCPUFallback).toBe(false);
  });

  test('a forced CPU reload (gpuLayersOverride 0) is recorded on a GPU backend', async () => {
    const service = createTestService({ realizedGpuLayers: 0 });

    await service._loadModel('text', { gpuLayersOverride: 0, _cpuFallbackTried: true });

    expect([...service._cpuFallbackTypes]).toEqual(['text']);
  });

  test('a forced CPU reload is still recorded when the binding reports no layer count', async () => {
    // Defensive: an older/stubbed binding with no `gpuLayers` getter must not
    // make the record unobtainable — the request itself proves CPU-only.
    const service = createTestService({});

    await service._loadModel('text', { gpuLayersOverride: 0, _cpuFallbackTried: true });

    expect([...service._cpuFallbackTypes]).toEqual(['text']);
  });

  test('a load with no reported layer count never clears an existing record', async () => {
    const service = createTestService({});
    service._cpuFallbackTypes.add('text');

    await service._loadModel('text');

    expect([...service._cpuFallbackTypes]).toEqual(['text']);
  });

  test('CPU-only by user configuration is not reported as a fallback', async () => {
    // `gpuLayers: 0` in settings is a deliberate choice, not the GPU letting
    // the user down; the badge must not say "GPU unavailable".
    const service = createTestService({ realizedGpuLayers: 0, configGpuLayers: 0 });

    await service._loadModel('text');

    expect([...service._cpuFallbackTypes]).toEqual([]);
    expect(service.getHealthStatus().usingCPUFallback).toBe(false);
  });

  test('switching to CPU by configuration clears an earlier fallback record', async () => {
    // The record used to be left as-is here, so a genuine tier-3 fallback
    // from before the user chose CPU survived every reload and the badge kept
    // reporting a GPU failure for a run the user configured deliberately.
    const service = createTestService({ realizedGpuLayers: 0, configGpuLayers: 0 });
    service._cpuFallbackTypes.add('text');

    await service._loadModel('text');

    expect([...service._cpuFallbackTypes]).toEqual([]);
    expect(service.getHealthStatus()).toEqual(
      expect.objectContaining({ usingCPUFallback: false, degraded: false })
    );
  });

  test('on a CPU-only engine the per-type record stays empty', async () => {
    // _engineCpuFallback already reports a whole-engine CPU run; duplicating
    // it per type would name every model in the badge for no new information.
    const service = createTestService({ realizedGpuLayers: 0, gpuBackend: 'cpu' });

    await service._loadModel('text');

    expect([...service._cpuFallbackTypes]).toEqual([]);
  });
});

describe('LlamaService CPU-fallback badge after an unload with no reload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFsPromises.access.mockResolvedValue(undefined);
    mockFsPromises.stat.mockResolvedValue({ size: 4.4 * 1024 * 1024 * 1024 });
  });

  test('a model change drops the record for the unloaded type before anything reloads', async () => {
    // The real manager, so unloadAll really disposes the handle the way it
    // does in production. The next _loadModel is lazy (driven by the next
    // analysis), so between the Settings change and that analysis the
    // badge used to keep naming a model that was no longer resident.
    const { ModelMemoryManager: RealModelMemoryManager } = jest.requireActual(
      '../src/main/services/ModelMemoryManager'
    );
    const service = createTestService({ realizedGpuLayers: 0 });
    service._configLoaded = true;
    service._modelMemoryManager = new RealModelMemoryManager(service, {
      gpuInfo: { vramMB: 6144 }
    });

    await service._modelMemoryManager.ensureModelLoaded('text');
    expect(service.getHealthStatus()).toEqual(
      expect.objectContaining({ usingCPUFallback: true, cpuFallbackTypes: ['text'] })
    );

    await service.updateConfig({ textModel: 'small-text.gguf' }, { skipSave: true });

    expect(service._llama.loadModel).toHaveBeenCalledTimes(1);
    expect(service._models.text).toBeNull();
    expect(service.getHealthStatus()).toEqual(
      expect.objectContaining({ usingCPUFallback: false, cpuFallbackTypes: [], degraded: false })
    );
  });
});
