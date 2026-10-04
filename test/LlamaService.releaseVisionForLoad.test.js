/**
 * Tests for LlamaService._releaseVisionForLoad — the pre-load vision teardown
 * used to free VRAM before non-vision model loads.
 *
 * Covers the production race where a teardown fired during the vision
 * runtime's startup window (VisionService assigns _port at spawn time,
 * BEFORE the health check) SIGTERM'd the mid-startup child:
 * "Vision runtime exited during startup (code=null, signal=SIGTERM)".
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
  GPUMonitor: jest.fn().mockImplementation(() => ({}))
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

// Controllable vision singleton consumed by _releaseVisionForLoad via
// getVisionService(). Reconfigured per test.
const mockVision = {};
jest.mock('../src/main/services/VisionService', () => ({
  getInstance: jest.fn(() => mockVision),
  confirmGpuBackend: jest.fn()
}));

const { LlamaService } = require('../src/main/services/LlamaService');

function configureVision({ startPromise, port, isReady, alive = true, keepAlive = true }) {
  for (const key of Object.keys(mockVision)) delete mockVision[key];
  mockVision._startPromise = startPromise;
  mockVision._port = port;
  mockVision._isReady = isReady;
  mockVision.isAlive = jest.fn(() => alive);
  mockVision.isIdleKeepAliveEnabled = jest.fn(() => keepAlive);
  mockVision.shutdown = jest.fn().mockResolvedValue(undefined);
}

describe('LlamaService._releaseVisionForLoad', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LlamaService();
  });

  test('waits for a mid-startup vision server to become ready, then evicts it', async () => {
    // Mid-startup (_port assigned at spawn, _isReady still false). We must NOT
    // SIGTERM the starting child, but we also must not let a text load barrel
    // into the VRAM it is allocating. New behavior: await startup, then
    // gracefully shut it down so the text load doesn't race the allocation.
    configureVision({
      startPromise: Promise.resolve(), // startup settles
      port: 12345,
      isReady: false,
      alive: true,
      keepAlive: true
    });

    await service._releaseVisionForLoad('text', 'pre-lock');

    expect(mockVision.shutdown).toHaveBeenCalledTimes(1);
  });

  test('does NOT evict when a mid-startup vision server fails to start', async () => {
    // Startup rejects → the child is gone; there is nothing (and nothing alive)
    // to tear down, so we must not call shutdown.
    const failingStart = Promise.reject(new Error('startup failed'));
    failingStart.catch(() => {}); // pre-handle to avoid unhandled-rejection noise
    configureVision({
      startPromise: failingStart,
      port: null,
      isReady: false,
      alive: false
    });

    await service._releaseVisionForLoad('text', 'pre-lock');

    expect(mockVision.shutdown).not.toHaveBeenCalled();
  });

  test('skips teardown if a mid-startup vision server never settles within the wait cap', async () => {
    // Liveness guard: a pathologically hung startup must not stall the text
    // load forever. After the wait cap we skip teardown (the pre-change safe
    // behavior) so the load proceeds and its own degradation net can act.
    jest.useFakeTimers();
    try {
      configureVision({
        startPromise: new Promise(() => {}), // never settles
        port: 12345,
        isReady: false,
        alive: true
      });

      const pending = service._releaseVisionForLoad('text', 'pre-lock');
      await jest.advanceTimersByTimeAsync(20001); // past MID_STARTUP_WAIT_CAP_MS
      await pending;

      expect(mockVision.shutdown).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('tears down a ready, idle-keepalive vision runtime before a text load', async () => {
    configureVision({ startPromise: null, port: 12345, isReady: true });

    await service._releaseVisionForLoad('text', 'post-lock');

    expect(mockVision.shutdown).toHaveBeenCalledTimes(1);
  });

  test('waits for an in-flight vision request to finish, then tears down (ML-05)', async () => {
    configureVision({ startPromise: null, port: 12345, isReady: true });
    let inFlight = true;
    mockVision.hasInFlightRequests = jest.fn(() => inFlight);
    mockVision.waitForIdle = jest.fn(async () => {
      inFlight = false;
      return true;
    });

    await service._releaseVisionForLoad('text', 'pre-lock');

    expect(mockVision.waitForIdle).toHaveBeenCalledWith(15000);
    expect(mockVision.shutdown).toHaveBeenCalledTimes(1);
  });

  test('keeps the server when an in-flight request does not finish within the cap (ML-05)', async () => {
    configureVision({ startPromise: null, port: 12345, isReady: true });
    mockVision.hasInFlightRequests = jest.fn(() => true);
    mockVision.waitForIdle = jest.fn(async () => false);

    await service._releaseVisionForLoad('text', 'pre-lock');

    expect(mockVision.shutdown).not.toHaveBeenCalled();
  });

  test('does NOT tear down vision for an embedding load (200MB model coexists with vision)', async () => {
    // The production ping-pong: each analyzed image's result is embedded,
    // and the embedding load evicted the ~5GB vision runtime — forcing a
    // full 10-30s llama-server restart per image. Embedding + vision already
    // coexist inside vision batch mode; the same must hold outside it.
    configureVision({ startPromise: null, port: 12345, isReady: true });

    await service._releaseVisionForLoad('embedding', 'pre-lock');

    expect(mockVision.shutdown).not.toHaveBeenCalled();
  });

  test('skips teardown entirely for vision loads', async () => {
    configureVision({ startPromise: null, port: 12345, isReady: true });

    await service._releaseVisionForLoad('vision', 'pre-lock');

    expect(mockVision.shutdown).not.toHaveBeenCalled();
  });

  test('skips teardown while vision batch mode is active', async () => {
    configureVision({ startPromise: null, port: 12345, isReady: true });
    service._visionBatchMode = true;

    await service._releaseVisionForLoad('text', 'pre-lock');

    expect(mockVision.shutdown).not.toHaveBeenCalled();
  });

  test('skips teardown when the runtime is not alive', async () => {
    configureVision({ startPromise: null, port: null, isReady: false, alive: false });

    await service._releaseVisionForLoad('text', 'pre-lock');

    expect(mockVision.shutdown).not.toHaveBeenCalled();
  });
});

describe('LlamaService.warmTextModel (VRAM guard)', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LlamaService();
  });

  test('skips the text warm-up while vision batch mode is active', async () => {
    service._visionBatchMode = true;
    const spy = jest.spyOn(service, '_ensureModelLoaded').mockResolvedValue({});

    const res = await service.warmTextModel();

    expect(spy).not.toHaveBeenCalled();
    expect(res).toEqual({ success: false, skipped: true });
  });

  test('skips the text warm-up while the vision server is resident', async () => {
    configureVision({ startPromise: null, port: 12345, isReady: true, alive: true });
    const spy = jest.spyOn(service, '_ensureModelLoaded').mockResolvedValue({});

    const res = await service.warmTextModel();

    expect(spy).not.toHaveBeenCalled();
    expect(res).toEqual({ success: false, skipped: true });
  });

  test('warms the text model when no vision runtime is resident', async () => {
    configureVision({ startPromise: null, port: null, isReady: false, alive: false });
    const spy = jest.spyOn(service, '_ensureModelLoaded').mockResolvedValue({});

    const res = await service.warmTextModel();

    expect(spy).toHaveBeenCalledWith('text');
    expect(res).toEqual({ success: true });
  });
});

describe('LlamaService._preloadTextAfterVisionRelease (batch-mode re-entrancy guard)', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LlamaService();
  });

  test('skips the preload when vision batch mode is already active', async () => {
    service._visionBatchMode = true;
    const ensureSpy = jest.spyOn(service, '_ensureModelLoaded').mockResolvedValue({});

    await service._preloadTextAfterVisionRelease(['embedding']);

    expect(ensureSpy).not.toHaveBeenCalled();
  });

  test('unloads the just-loaded text model if batch mode is re-entered mid-load', async () => {
    // enterVisionBatchMode() flips the flag true while our load is awaited.
    jest.spyOn(service, '_ensureModelLoaded').mockImplementation(async () => {
      service._visionBatchMode = true;
      return {};
    });
    service._modelMemoryManager = { unloadModel: jest.fn().mockResolvedValue(true) };
    const { resetLlamaCircuit } = require('../src/main/services/LlamaResilience');

    await service._preloadTextAfterVisionRelease(['embedding']);

    expect(service._modelMemoryManager.unloadModel).toHaveBeenCalledWith('text');
    expect(resetLlamaCircuit).not.toHaveBeenCalled();
  });

  test('loads text and resets the given circuits on the clean path', async () => {
    service._visionBatchMode = false;
    jest.spyOn(service, '_ensureModelLoaded').mockResolvedValue({});
    service._modelMemoryManager = { unloadModel: jest.fn() };
    const { resetLlamaCircuit } = require('../src/main/services/LlamaResilience');

    await service._preloadTextAfterVisionRelease(['text', 'embedding']);

    expect(service._modelMemoryManager.unloadModel).not.toHaveBeenCalled();
    expect(resetLlamaCircuit).toHaveBeenCalledWith('text');
    expect(resetLlamaCircuit).toHaveBeenCalledWith('embedding');
  });
});

describe('LlamaService._releaseMemoryForVisionRuntime (budget before a vision spawn)', () => {
  // `fits` answers the bare budget check; `makesRoom` answers the eviction
  // pass, which is what the spawn path must consult.
  function managerWith({ fits, makesRoom = fits, loaded = ['audio'] }) {
    return {
      unloadModel: jest.fn().mockResolvedValue(true),
      canFitExternalLoad: jest.fn(() => fits),
      makeRoomForExternalLoad: jest.fn().mockResolvedValue(makesRoom),
      getMemoryStatus: jest.fn(() => ({
        loadedModels: loaded,
        maxMemoryMB: 4096,
        currentUsageMB: 190
      }))
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    configureVision({ alive: false });
  });

  test('the single-image path unloads whisper too and asks the manager to make room', async () => {
    // Whisper has no idle unload; after one voice memo it blocked every
    // single-image vision spawn on 8 GB machines until the app restarted.
    const service = new LlamaService();
    const manager = managerWith({ fits: true });
    service._modelMemoryManager = manager;
    service._estimateVisionRuntimeBytes = jest.fn().mockResolvedValue(6 * 1024 ** 3);

    await expect(service._releaseMemoryForVisionRuntime('single')).resolves.toBeUndefined();

    expect(manager.unloadModel).toHaveBeenCalledWith('text');
    expect(manager.unloadModel).toHaveBeenCalledWith('embedding');
    expect(manager.unloadModel).toHaveBeenCalledWith('audio');
    expect(manager.makeRoomForExternalLoad).toHaveBeenCalledWith(6 * 1024 ** 3, {
      excludeType: expect.any(String)
    });
  });

  test('an idle resident is evicted to make room, so the spawn proceeds', async () => {
    // The bare budget check says no, but an idle resident can go: the
    // manager evicts it, as it already does for a model load, and the vision
    // runtime starts instead of being refused.
    const service = new LlamaService();
    const manager = managerWith({ fits: false, makesRoom: true });
    service._modelMemoryManager = manager;
    service._estimateVisionRuntimeBytes = jest.fn().mockResolvedValue(6 * 1024 ** 3);

    await expect(service._releaseMemoryForVisionRuntime('batch')).resolves.toBeUndefined();

    expect(manager.makeRoomForExternalLoad).toHaveBeenCalledWith(6 * 1024 ** 3, {
      excludeType: expect.any(String)
    });
    expect(manager.canFitExternalLoad).not.toHaveBeenCalled();
  });

  test('refuses only when residents pinned by in-flight work keep the budget taken', async () => {
    const service = new LlamaService();
    const manager = managerWith({ fits: false, makesRoom: false });
    service._modelMemoryManager = manager;
    service._estimateVisionRuntimeBytes = jest.fn().mockResolvedValue(6 * 1024 ** 3);

    await expect(service._releaseMemoryForVisionRuntime('batch')).rejects.toMatchObject({
      code: 'MODEL_MEMORY_BUDGET_EXCEEDED'
    });
    expect(manager.unloadModel).toHaveBeenCalledWith('audio');
    // The refusal comes after an eviction pass, not a bare budget check.
    expect(manager.makeRoomForExternalLoad).toHaveBeenCalledWith(6 * 1024 ** 3, {
      excludeType: expect.any(String)
    });
    expect(manager.canFitExternalLoad).not.toHaveBeenCalled();
  });
});
