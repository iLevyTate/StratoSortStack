/**
 * updateConfig must not hold the load lock while it waits for in-flight
 * operations. An op that already holds an inference slot loads through
 * acquireLoadLock, so waiting for it under the lock was a circular wait that
 * stalled settings saves (and the whole analysis lane) for the full 60 s
 * idle-wait timeout. These tests drive the real ModelAccessCoordinator.
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

// The shared p-queue mock runs every task at once. The coordinator's load
// lock and inference slots are concurrency-1 queues, so these tests need a
// queue that actually enforces its limit.
jest.mock('p-queue', () => {
  class PQueue {
    constructor(opts = {}) {
      this.concurrency = opts.concurrency || Infinity;
      this.pending = 0;
      this._waiting = [];
    }

    get size() {
      return this._waiting.length;
    }

    add(fn) {
      return new Promise((resolve, reject) => {
        this._waiting.push({ fn, resolve, reject });
        this._next();
      });
    }

    _next() {
      while (this.pending < this.concurrency && this._waiting.length > 0) {
        const { fn, resolve, reject } = this._waiting.shift();
        this.pending += 1;
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            this.pending -= 1;
            this._next();
          });
      }
    }
  }
  return { default: PQueue };
});

const { LlamaService } = require('../src/main/services/LlamaService');
const { ModelAccessCoordinator } = require('../src/main/services/ModelAccessCoordinator');

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Mirrors an inference call: take a slot, then load through the load lock
 * (as _ensureModelLoaded always does), then run.
 */
function runTextOp(coordinator, id, work) {
  return coordinator.withModel(
    'text',
    async () => {
      const release = await coordinator.acquireLoadLock('text');
      release();
      await work;
    },
    { operationId: id }
  );
}

function buildService(loadedModels) {
  const service = new LlamaService();
  service._ensureConfigLoaded = jest.fn().mockResolvedValue(undefined);
  service._coordinator = new ModelAccessCoordinator({ inferenceSlots: 1 });
  service._modelMemoryManager = {
    unloadAll: jest.fn().mockResolvedValue(undefined),
    getMemoryStatus: jest.fn(() => ({ loadedModels }))
  };
  return service;
}

describe('LlamaService.updateConfig drain before load lock', () => {
  test('a model change with a queued request finishes promptly and unloads', async () => {
    const service = buildService([]);
    const coordinator = service._coordinator;

    const firstWork = deferred();
    const op1 = runTextOp(coordinator, 'op-1', firstWork.promise);
    // op-2 is queued for the single text slot; when it gets the slot it
    // needs the load lock.
    const op2 = runTextOp(coordinator, 'op-2', Promise.resolve());
    await new Promise((r) => setTimeout(r, 20));

    const started = Date.now();
    const update = service.updateConfig({ textModel: 'new-model.gguf' }, { skipSave: true });
    await new Promise((r) => setTimeout(r, 50));
    firstWork.resolve();

    await update;
    await Promise.all([op1, op2]);

    // Before the fix this waited out the full 60 s idle timeout.
    expect(Date.now() - started).toBeLessThan(5000);
    expect(service._modelMemoryManager.unloadAll).toHaveBeenCalledTimes(1);
    expect(service._staleModelTypes.has('text')).toBe(false);
    expect(service._configChangeGate).toBeNull();
  }, 15000);

  test('an op that takes a slot after the drain only costs a short re-check, then the swap is deferred', async () => {
    const service = buildService(['text']);
    const coordinator = service._coordinator;

    const realAcquire = coordinator.acquireLoadLock.bind(coordinator);
    /** @type {Promise<any> | null} */
    let lateOp = null;
    coordinator.acquireLoadLock = async (type, options) => {
      const release = await realAcquire(type, options);
      // updateConfig passes onForceRelease; the simulated ops do not. Once
      // updateConfig holds the lock, start an op that will block on it.
      if (options?.onForceRelease && !lateOp) {
        lateOp = runTextOp(coordinator, 'late-op', Promise.resolve());
        await new Promise((r) => setTimeout(r, 20));
      }
      return release;
    };

    const started = Date.now();
    await service.updateConfig({ textModel: 'new-model.gguf' }, { skipSave: true });

    expect(Date.now() - started).toBeLessThan(10000);
    // The late op was still active, so unloading was skipped and the old
    // model is marked stale for the next locked load to swap.
    expect(service._modelMemoryManager.unloadAll).not.toHaveBeenCalled();
    expect(service._staleModelTypes.has('text')).toBe(true);

    // Releasing the lock lets the late op finish.
    await lateOp;
  }, 15000);
});
