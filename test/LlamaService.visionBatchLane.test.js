/**
 * Text requests and a running vision batch.
 *
 * From a review of the "one model family at a time" change: an image whose
 * vision pass failed took the OCR text fallback, and that text request waited
 * for the vision batch to end. The batch could not end until that image
 * finished, so every such image hung until its 300 s analysis timeout, and
 * Cancel did not free the waiter. A text request from outside the batch
 * waited 10 minutes twice (once under the load lock), then met the batch's
 * pinned vision runtime in the memory manager and failed on the budget.
 */

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })
}));
jest.mock('../src/main/services/DegradationManager', () => ({
  DegradationManager: jest.fn().mockImplementation(() => ({
    checkSystemReadiness: jest.fn().mockResolvedValue({ ready: true, issues: [], gpuInfo: {} }),
    handleError: jest.fn().mockResolvedValue({ action: 'none' })
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
    recordTextGeneration: jest.fn(),
    recordModelLoad: jest.fn(),
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
jest.mock('../src/main/services/LlamaResilience', () => ({
  withLlamaResilience: (fn) => fn({}),
  cleanupLlamaCircuits: jest.fn(),
  resetLlamaCircuit: jest.fn(),
  shouldFallbackToCPU: jest.fn()
}));
jest.mock('../src/main/services/PerformanceService', () => ({
  getRecommendedConcurrency: jest.fn().mockResolvedValue({
    maxConcurrent: 1,
    reason: 'test-mock',
    vramMB: 0,
    gpuName: null
  })
}));
const mockVision = {
  isAlive: jest.fn(() => true),
  isIdleKeepAliveEnabled: jest.fn(() => true),
  shutdown: jest.fn().mockResolvedValue(undefined)
};
jest.mock('../src/main/services/VisionService', () => ({
  getInstance: jest.fn(() => mockVision),
  confirmGpuBackend: jest.fn(),
  VISION_RUNTIME_MEMORY_TYPE: 'vision-runtime'
}));

const { LlamaService } = require('../src/main/services/LlamaService');
const { ModelMemoryManager } = require('../src/main/services/ModelMemoryManager');

const GiB = 1024 * 1024 * 1024;
const LOAD_REACHED = 'load-reached';

/** A memory manager that counts refs and stops every load with a sentinel. */
function createManager() {
  const refs = new Map();
  const manager = {
    refs,
    refsAtLoad: /** @type {Record<string, number | undefined>} */ ({}),
    acquireRef: jest.fn((type) => refs.set(type, (refs.get(type) || 0) + 1)),
    releaseRef: jest.fn((type) => refs.set(type, Math.max(0, (refs.get(type) || 0) - 1))),
    getLoadedContext: jest.fn(() => null),
    unloadModel: jest.fn().mockResolvedValue(true),
    unloadAll: jest.fn().mockResolvedValue(undefined),
    ensureModelLoaded: jest.fn(async (type) => {
      manager.refsAtLoad[type] = refs.get('vision-runtime') || 0;
      throw new Error(LOAD_REACHED);
    })
  };
  return manager;
}

function createService(manager) {
  const service = new LlamaService();
  service._initialized = true;
  service._modelMemoryManager = manager;
  service._degradationManager = {
    handleError: jest.fn().mockResolvedValue({ action: 'none' })
  };
  service._getEffectiveContextSize = jest.fn(() => 4096);
  service._releaseMemoryForVisionRuntime = jest.fn().mockResolvedValue(undefined);
  service._preloadTextAfterVisionRelease = jest.fn().mockResolvedValue(undefined);
  service._lanePollMs = 5;
  return service;
}

/** Resolve to 'settled' if `promise` settles within `ms`, else 'pending'. */
function settlesWithin(promise, ms) {
  return Promise.race([
    promise.then(
      () => 'settled',
      () => 'settled'
    ),
    new Promise((resolve) => setTimeout(() => resolve('pending'), ms))
  ]);
}

describe('LlamaService text requests during a vision batch', () => {
  let service;
  let manager;

  beforeEach(async () => {
    jest.clearAllMocks();
    manager = createManager();
    service = createService(manager);
    await service.enterVisionBatchMode();
  });

  afterEach(() => {
    // End any wait a failing test left behind.
    service._visionBatchMode = false;
    service._shutdownAbort.abort();
  });

  test("the batch's own text request loads at once, with the runtime free to be evicted", async () => {
    service._visionBatchIdleWaitMs = 5000;

    const request = service.runAsVisionBatchMember(() => service.generateText({ prompt: 'ocr' }));

    expect(await settlesWithin(request, 500)).toBe('settled');
    await expect(request).rejects.toThrow(LOAD_REACHED);
    expect(manager.ensureModelLoaded).toHaveBeenCalledWith('text', undefined);
    // The batch pin stood aside for the load and came back after it.
    expect(manager.refsAtLoad.text).toBe(0);
    expect(manager.refs.get('vision-runtime')).toBe(1);
    expect(service._textLoadDepth).toBe(0);
  });

  test('membership follows the async work, not the service', async () => {
    const inside = await service.runAsVisionBatchMember(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return service._isVisionBatchMember();
    });
    expect(inside).toBe(true);
    expect(service._isVisionBatchMember()).toBe(false);
  });

  test('a request from outside waits before it takes the inference slot', async () => {
    service._visionBatchIdleWaitMs = 5000;

    const request = service.generateText({ prompt: 'chat' });
    const outcome = request.catch((error) => error);

    expect(await settlesWithin(request, 100)).toBe('pending');
    // Holding the slot while waiting would block the batch's own text
    // fallback queued behind it.
    expect(service._coordinator.withModel).not.toHaveBeenCalled();
    expect(service._textLoadDepth).toBe(1);

    await service.exitVisionBatchMode();
    expect((await outcome).message).toBe(LOAD_REACHED);
    expect(service._coordinator.withModel).toHaveBeenCalledTimes(1);
  });

  test('cancelling a waiting request ends the wait at once and frees the text lane', async () => {
    service._visionBatchIdleWaitMs = 5000;
    const controller = new AbortController();

    const request = service.generateText({ prompt: 'doc', signal: controller.signal });
    setTimeout(() => controller.abort(), 20);

    expect(await settlesWithin(request, 500)).toBe('settled');
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(service._textLoadDepth).toBe(0);
    expect(manager.ensureModelLoaded).not.toHaveBeenCalled();
  });

  test('a request still blocked after the wait waits once, then the pin stands aside', async () => {
    service._visionBatchIdleWaitMs = 30;
    const waitSpy = jest.spyOn(service, '_waitUntil');

    await expect(service.generateText({ prompt: 'doc' })).rejects.toThrow(LOAD_REACHED);

    // One wait, not a second one under the load lock.
    expect(waitSpy).toHaveBeenCalledTimes(1);
    expect(manager.refsAtLoad.text).toBe(0);
    expect(manager.refs.get('vision-runtime')).toBe(1);
  });

  test('a warm-up or preload never loads text while a batch holds memory', async () => {
    service._visionBatchIdleWaitMs = 0;
    await expect(service._ensureModelLoaded('text', { speculative: true })).resolves.toBeNull();
    await expect(service._ensureModelLoaded('text')).resolves.toBeNull();
    expect(manager.ensureModelLoaded).not.toHaveBeenCalled();
  });
});

describe('LlamaService: a text load during a batch can take the pinned runtime’s memory', () => {
  // The batch's own request, or an outside one that already waited out the
  // batch once. Before, the pin kept the runtime, the manager waited for it,
  // then refused the load with MODEL_MEMORY_BUDGET_EXCEEDED.
  test('the memory manager evicts the idle runtime instead of refusing the load', async () => {
    const service = new LlamaService();
    service._initialized = true;
    service._degradationManager = {
      handleError: jest.fn().mockResolvedValue({ action: 'none' })
    };
    service._releaseMemoryForVisionRuntime = jest.fn().mockResolvedValue(undefined);
    service._preloadTextAfterVisionRelease = jest.fn().mockResolvedValue(undefined);
    service._loadModel = jest.fn().mockResolvedValue({ ctx: 'text' });
    service._visionBatchIdleWaitMs = 0;

    const manager = new ModelMemoryManager(service);
    jest.spyOn(manager, '_refreshMemoryBudget').mockImplementation(() => {});
    manager._maxMemoryUsage = 8 * GiB;
    manager._modelSizeEstimates.text = 4 * GiB;
    manager._pinnedResidentWaitMs = 0;
    const dispose = jest.fn().mockResolvedValue(undefined);
    manager.registerExternalConsumer({ type: 'vision-runtime', sizeBytes: 6 * GiB, dispose });
    service._modelMemoryManager = manager;

    await service.enterVisionBatchMode();
    try {
      await expect(
        service._ensureModelLoaded('text', { selfRef: false, forInference: true })
      ).resolves.toEqual({ ctx: 'text' });
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(manager._loadedModels.has('text')).toBe(true);
    } finally {
      await service.exitVisionBatchMode();
    }
  });
});

describe('LlamaService: the batch pin and the GPU embedding model', () => {
  let service;
  let manager;

  beforeEach(async () => {
    jest.clearAllMocks();
    manager = createManager();
    manager.ensureModelLoaded.mockImplementation(async () => ({ ctx: 'embedding' }));
    service = createService(manager);
  });

  test('a CPU embedding model still in use at batch exit is moved back on the next load', async () => {
    await service.enterVisionBatchMode();
    await service._ensureModelLoaded('embedding', { selfRef: true });
    expect(manager.ensureModelLoaded).toHaveBeenLastCalledWith(
      'embedding',
      expect.objectContaining({ gpuLayersOverride: 0, cpuByDesign: true })
    );

    // An embedding batch still holds the CPU model, so the exit cannot unload it.
    manager.unloadModel.mockResolvedValueOnce(false);
    await service.exitVisionBatchMode();
    expect(service._embeddingCpuForBatch).toBe(true);

    manager.unloadModel.mockClear();
    await service._ensureModelLoaded('embedding', { selfRef: true });
    expect(manager.unloadModel).toHaveBeenCalledWith('embedding', { allowedRefs: 1, waitMs: 0 });
    expect(manager.ensureModelLoaded).toHaveBeenLastCalledWith('embedding', undefined);
    expect(service._embeddingCpuForBatch).toBe(false);
  });

  test('a CPU load still in flight when the batch ends is moved back on the next load', async () => {
    await service.enterVisionBatchMode();
    let finishLoad;
    manager.ensureModelLoaded.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLoad = () => resolve({ ctx: 'cpu-embedding' });
        })
    );
    const inFlight = service._ensureModelLoaded('embedding', { selfRef: true });
    await new Promise((resolve) => setImmediate(resolve));

    // Nothing is registered yet, so this unload is a no-op that reports success.
    await service.exitVisionBatchMode();
    finishLoad();
    await inFlight;

    manager.unloadModel.mockClear();
    await service._ensureModelLoaded('embedding', { selfRef: true });
    expect(manager.unloadModel).toHaveBeenCalledWith('embedding', { allowedRefs: 1, waitMs: 0 });
  });

  test('a busy CPU model is served as is, without stalling the load', async () => {
    service._embeddingCpuForBatch = true;
    manager.unloadModel.mockResolvedValueOnce(false);

    await service._ensureModelLoaded('embedding', { selfRef: true });

    expect(manager.ensureModelLoaded).toHaveBeenCalledWith('embedding', undefined);
    expect(service._embeddingCpuForBatch).toBe(true);
  });
});

describe('LlamaService: the text preload after a batch', () => {
  let service;
  let manager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = createManager();
    service = createService(manager);
    // Use the real preload for these tests.
    delete service._preloadTextAfterVisionRelease;
    service._textLaneIdleWaitMs = 5000;
    // No vision server left over to tear down before the text load.
    mockVision.isAlive.mockReturnValue(false);
  });

  afterEach(() => {
    mockVision.isAlive.mockReturnValue(true);
    service._shutdownAbort.abort();
  });

  test('does not hold up the next batch while it loads', async () => {
    let finishLoad;
    manager.ensureModelLoaded.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLoad = () => resolve({ ctx: 'text' });
        })
    );
    const preload = service._preloadTextAfterVisionRelease(['embedding']);
    await new Promise((resolve) => setImmediate(resolve));
    expect(manager.ensureModelLoaded).toHaveBeenCalledWith('text', undefined);

    expect(await settlesWithin(service.enterVisionBatchMode(), 500)).toBe('settled');
    expect(service._visionBatchMode).toBe(true);

    // The load lands after the batch entered, so the preload undoes it.
    finishLoad();
    await preload;
    expect(manager.unloadModel).toHaveBeenCalledWith('text');
  });

  test('gives way to a batch that is on its way in', async () => {
    service._visionBatchEntriesPending = 1;

    await service._preloadTextAfterVisionRelease(['embedding']);

    expect(manager.ensureModelLoaded).not.toHaveBeenCalled();
  });
});

describe('ModelMemoryManager.unloadModel waitMs', () => {
  test('waitMs 0 gives up at once while the model is in use', async () => {
    const manager = new ModelMemoryManager({ _models: {}, _contexts: {} });
    manager._loadedModels.set('embedding', { context: {}, lastUsed: 0, sizeBytes: 1 });
    manager.acquireRef('embedding');
    manager.acquireRef('embedding');

    const started = Date.now();
    await expect(manager.unloadModel('embedding', { allowedRefs: 1, waitMs: 0 })).resolves.toBe(
      false
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(manager._loadedModels.has('embedding')).toBe(true);
  });
});
