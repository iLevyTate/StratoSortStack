/**
 * A text request from outside a running vision batch waits for the batch to
 * end, then (if it is still running) takes memory at the next image boundary.
 * That wait must end well inside the per-document analysis budget
 * (TIMEOUTS.GLOBAL_ANALYSIS) the smart-folder watcher and Discover apply,
 * otherwise the caller times out first and the document fails (and is
 * retried into the same wait) for as long as the batch runs.
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

const { TIMEOUTS } = require('../src/shared/performanceConstants');

describe('LlamaService vision-batch wait vs the analysis budget', () => {
  test('the default wait leaves most of the analysis budget for the document', () => {
    const service = new LlamaService();
    expect(service._visionBatchIdleWaitMs).toBeGreaterThan(0);
    // Extraction runs before the wait and inference after it, both inside
    // the same budget; the next image boundary can take minutes too.
    expect(service._visionBatchIdleWaitMs).toBeLessThanOrEqual(TIMEOUTS.GLOBAL_ANALYSIS / 2);
  });

  test('a document under the analysis timeout gets its text load before the timeout fires', async () => {
    const manager = createManager();
    const service = createService(manager);
    service._visionBatchIdleWaitMs = new LlamaService()._visionBatchIdleWaitMs;
    service._lanePollMs = 1000;
    await service.enterVisionBatchMode();
    jest.useFakeTimers();
    try {
      // The watcher starts its timeout before extraction; model the
      // remaining budget as the full GLOBAL_ANALYSIS window.
      const controller = new AbortController();
      setTimeout(() => controller.abort(), TIMEOUTS.GLOBAL_ANALYSIS - 1);
      const outcome = service
        .generateText({ prompt: 'doc', signal: controller.signal })
        .catch((error) => error);
      await jest.advanceTimersByTimeAsync(TIMEOUTS.GLOBAL_ANALYSIS);
      const error = await outcome;
      // LOAD_REACHED means the request left the wait and reached the
      // model load; AbortError means the caller's timeout won.
      expect(error.name).not.toBe('AbortError');
      expect(error.message).toBe(LOAD_REACHED);
    } finally {
      service._visionBatchMode = false;
      service._shutdownAbort.abort();
      jest.useRealTimers();
    }
  });
});
