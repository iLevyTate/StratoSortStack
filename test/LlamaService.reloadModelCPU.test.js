/**
 * Real-coverage test for LlamaService._reloadModelCPU().
 *
 * Supersedes the inline "Section 4" theater that previously lived in
 * test/bugfix-round3.test.js, which reimplemented the warn-and-proceed flow
 * with local jest.fns (importing nothing from src/) and, worse, asserted a
 * pure tautology (`waitFn('cpu-fallback', 10000, …)` then asserted it was
 * called with 10000). This drives the REAL _reloadModelCPU() path: it
 * exercises the actual method's blocked-ops handling, the 10s (not 60s)
 * idle-wait timeout, the GPU-still-resident deferral branch, and the
 * release-lock finally — so a regression in any of those fails this suite.
 */

// Stable logger.warn reference so the warn-and-proceed branch is observable.
// createLogger() is called once at LlamaService module load, capturing this
// exact jest.fn, so logger.warn === mockLoggerWarn for the suite's lifetime.
const mockLoggerWarn = jest.fn();
jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: mockLoggerWarn,
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const mockModelMemoryManager = {
  ensureModelLoaded: jest.fn(),
  unloadModel: jest.fn(),
  unloadAll: jest.fn().mockResolvedValue(undefined),
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

jest.mock('../src/main/services/DegradationManager', () => ({
  DegradationManager: jest.fn().mockImplementation(() => ({
    checkSystemReadiness: jest.fn().mockResolvedValue({ ready: true, issues: [], gpuInfo: {} }),
    handleError: jest.fn().mockResolvedValue({ action: 'none' })
  }))
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

// _reloadModelCPU does `require('./LlamaResilience').resetLlamaCircuit(...)`
// inside the method, so the mock must expose it.
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

function createTestService() {
  const service = new LlamaService();
  service._initialized = true;
  service._modelsPath = '/mock/models';
  service._selectedModels = { text: 'text.gguf', vision: 'vision.gguf', embedding: 'embed.gguf' };
  service._config = { gpuLayers: -1, threads: 4 };
  service._gpuBackend = 'vulkan';
  // Inject the real method's collaborators. _modelMemoryManager and the
  // coordinator are the only external touchpoints; _beginModelReloadGate /
  // _endModelReloadGate / _staleModelTypes are the REAL constructor-built state.
  service._modelMemoryManager = mockModelMemoryManager;
  const releaseLock = jest.fn();
  service._coordinator = { acquireLoadLock: jest.fn(async () => releaseLock) };
  service._releaseLock = releaseLock; // expose for assertions
  return service;
}

describe('LlamaService._reloadModelCPU', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('proceeds with unload + CPU reload when idle-wait returns false, using a 10s timeout', async () => {
    const service = createTestService();
    // Stub the collaborator so the REAL _reloadModelCPU sees blocked ops.
    service._waitForIdleOperations = jest.fn().mockResolvedValue(false);
    mockModelMemoryManager.unloadModel.mockResolvedValue(true);
    mockModelMemoryManager.ensureModelLoaded.mockResolvedValue({ id: 'cpu-context' });

    const result = await service._reloadModelCPU('text', { operationId: 'op-1' });

    // 10s timeout (not the old 60s) is passed to the idle wait — kills the
    // former tautology test that asserted a local jest.fn against its own args.
    expect(service._waitForIdleOperations).toHaveBeenCalledWith(
      'cpu-fallback',
      10000,
      expect.objectContaining({ modelType: 'text', excludeOperationId: 'op-1' })
    );
    // The blocked-ops branch logged a warning and PROCEEDED (did not throw).
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('Proceeding with reload'),
      expect.objectContaining({ modelType: 'text', operationId: 'op-1' })
    );
    // Unload routed through the memory manager with allowedRefs: 1, then a
    // CPU-only (gpuLayersOverride: 0) reload whose context is returned.
    expect(mockModelMemoryManager.unloadModel).toHaveBeenCalledWith('text', { allowedRefs: 1 });
    expect(mockModelMemoryManager.ensureModelLoaded).toHaveBeenCalledWith('text', {
      gpuLayersOverride: 0
    });
    expect(result).toEqual({ id: 'cpu-context' });
    // finally released the load lock.
    expect(service._releaseLock).toHaveBeenCalledTimes(1);
  });

  test('throws MODEL_RELOAD_DEFERRED and marks the type stale when the GPU model stays resident', async () => {
    const service = createTestService();
    service._waitForIdleOperations = jest.fn().mockResolvedValue(true);
    // unloadModel returning false means the GPU model is still pinned.
    mockModelMemoryManager.unloadModel.mockResolvedValue(false);

    await expect(service._reloadModelCPU('text', { operationId: 'op-2' })).rejects.toMatchObject({
      code: 'MODEL_RELOAD_DEFERRED'
    });

    // The type is flagged stale so the next locked load swaps it.
    expect(service._staleModelTypes.has('text')).toBe(true);
    // Short-circuited before the CPU reload.
    expect(mockModelMemoryManager.ensureModelLoaded).not.toHaveBeenCalled();
    // finally still released the lock despite the throw.
    expect(service._releaseLock).toHaveBeenCalledTimes(1);
  });

  test('vision never reloads in-process: resets the breaker and returns null (ML-02)', async () => {
    const service = createTestService();
    service._waitForIdleOperations = jest.fn();
    const { resetLlamaCircuit } = require('../src/main/services/LlamaResilience');

    const result = await service._reloadModelCPU('vision', { operationId: 'op-v' });

    expect(result).toBeNull();
    expect(resetLlamaCircuit).toHaveBeenCalledWith('vision');
    // No in-process load, no unload, no lock: the llama-server child restarts
    // on the CPU backend from analyzeImage's forceCPU config instead.
    expect(mockModelMemoryManager.ensureModelLoaded).not.toHaveBeenCalled();
    expect(mockModelMemoryManager.unloadModel).not.toHaveBeenCalled();
    expect(service._waitForIdleOperations).not.toHaveBeenCalled();
    expect(service._coordinator.acquireLoadLock).not.toHaveBeenCalled();
  });

  test('reloads without the blocked-ops warning when operations are idle', async () => {
    const service = createTestService();
    service._waitForIdleOperations = jest.fn().mockResolvedValue(true);
    mockModelMemoryManager.unloadModel.mockResolvedValue(true);
    mockModelMemoryManager.ensureModelLoaded.mockResolvedValue({ id: 'cpu-context' });

    const result = await service._reloadModelCPU('embedding');

    expect(result).toEqual({ id: 'cpu-context' });
    expect(mockModelMemoryManager.ensureModelLoaded).toHaveBeenCalledWith('embedding', {
      gpuLayersOverride: 0
    });
    // The idle path must NOT emit the "Proceeding with reload" warning.
    expect(mockLoggerWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('Proceeding with reload'),
      expect.anything()
    );
  });
});
