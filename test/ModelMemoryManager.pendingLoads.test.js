/**
 * ModelMemoryManager — memory a load in progress is about to take.
 *
 * A model was added to the budget only after it had finished loading, and the
 * vision runtime only after its health check passed (about a minute on a
 * laptop GPU). Anything that asked "does this fit?" in between was told the
 * memory was free: a 5.8 GB text model and a 6 GB vision runtime were started
 * half a second apart on a 6 GB card.
 */

jest.mock('os', () => ({
  totalmem: jest.fn(() => 16 * 1024 * 1024 * 1024),
  freemem: jest.fn(() => 8 * 1024 * 1024 * 1024)
}));

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const { ModelMemoryManager } = require('../src/main/services/ModelMemoryManager');

const GiB = 1024 * 1024 * 1024;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeManager({ budgetBytes = 7 * GiB } = {}) {
  const llamaService = {
    _models: { text: null, vision: null, embedding: null },
    _contexts: { text: null, vision: null, embedding: null },
    _loadModel: jest.fn(async () => ({}))
  };
  const manager = new ModelMemoryManager(llamaService);
  manager._maxMemoryUsage = budgetBytes;
  manager._modelSizeEstimates.text = 4 * GiB;
  manager._modelSizeEstimates.embedding = 1 * GiB;
  manager._pinnedResidentWaitMs = 500;
  manager._pinnedResidentPollMs = 10;
  jest.spyOn(manager, '_refreshMemoryBudget').mockImplementation(() => {});
  jest.spyOn(manager, '_disposeModelFn').mockResolvedValue(undefined);
  return { manager, llamaService };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a model load in progress', () => {
  test('counts against an external load that asks while it is loading', async () => {
    const { manager, llamaService } = makeManager();
    const gate = deferred();
    llamaService._loadModel.mockImplementation(() => gate.promise);

    const loading = manager.ensureModelLoaded('text');
    await tick();

    expect(manager.canFitExternalLoad(5 * GiB)).toBe(false);
    expect(manager.getMemoryStatus().pendingLoads).toEqual(['text']);

    gate.resolve({});
    await loading;
    expect(manager.getMemoryStatus().pendingLoads).toEqual([]);
    expect(manager._currentMemoryUsage).toBe(4 * GiB);
  });

  test('an external load waits for it, then takes its place when it is idle', async () => {
    const { manager, llamaService } = makeManager();
    const gate = deferred();
    llamaService._loadModel.mockImplementation(() => gate.promise);
    const loading = manager.ensureModelLoaded('text');
    await tick();

    let answer = null;
    const room = manager.makeRoomForExternalLoad(5 * GiB).then((fits) => {
      answer = fits;
    });
    await tick(20);
    expect(answer).toBeNull();

    gate.resolve({});
    await loading;
    await room;
    expect(answer).toBe(true);
    expect(manager._loadedModels.has('text')).toBe(false);
  });

  test('an external load is refused when the model that finished loading is in use', async () => {
    const { manager, llamaService } = makeManager();
    const gate = deferred();
    llamaService._loadModel.mockImplementation(async () => {
      await gate.promise;
      manager.acquireRef('text');
      return {};
    });
    const loading = manager.ensureModelLoaded('text');
    await tick();
    const room = manager.makeRoomForExternalLoad(5 * GiB);

    gate.resolve();
    await loading;

    await expect(room).resolves.toBe(false);
    expect(manager._loadedModels.has('text')).toBe(true);
  });

  test('a second model does not load beside it', async () => {
    const { manager, llamaService } = makeManager({ budgetBytes: 4.5 * GiB });
    const gate = deferred();
    llamaService._loadModel.mockImplementation((type) =>
      type === 'text' ? gate.promise : Promise.resolve({})
    );
    const loadingText = manager.ensureModelLoaded('text');
    await tick();

    const loadingEmbedding = manager.ensureModelLoaded('embedding');
    await tick(40);
    expect(llamaService._loadModel).toHaveBeenCalledTimes(1);

    gate.resolve({});
    await loadingText;
    await loadingEmbedding;
    // The text model is idle once loaded, so the embedding load takes its place.
    expect(llamaService._loadModel).toHaveBeenCalledTimes(2);
    expect(manager._currentMemoryUsage).toBe(1 * GiB);
  });

  test('two callers for the same model share one load', async () => {
    const { manager, llamaService } = makeManager();
    const gate = deferred();
    const context = { id: 'text-context' };
    llamaService._loadModel.mockImplementation(() => gate.promise);

    const first = manager.ensureModelLoaded('text');
    const second = manager.ensureModelLoaded('text');
    await tick();
    gate.resolve(context);

    await expect(first).resolves.toBe(context);
    await expect(second).resolves.toBe(context);
    expect(llamaService._loadModel).toHaveBeenCalledTimes(1);
    expect(manager._currentMemoryUsage).toBe(4 * GiB);
  });

  test('a caller that joined a load which failed tries its own', async () => {
    const { manager, llamaService } = makeManager();
    const gate = deferred();
    llamaService._loadModel
      .mockImplementationOnce(() => gate.promise)
      .mockImplementationOnce(async () => ({ id: 'second-try' }));

    const first = manager.ensureModelLoaded('text');
    const second = manager.ensureModelLoaded('text');
    await tick();
    gate.reject(new Error('load failed'));

    await expect(first).rejects.toThrow('load failed');
    await expect(second).resolves.toEqual({ id: 'second-try' });
  });

  test('a failed load gives its memory back', async () => {
    const { manager, llamaService } = makeManager();
    llamaService._loadModel.mockRejectedValue(new Error('load failed'));

    await expect(manager.ensureModelLoaded('text')).rejects.toThrow('load failed');

    expect(manager.getMemoryStatus().pendingLoads).toEqual([]);
    expect(manager.canFitExternalLoad(5 * GiB)).toBe(true);
  });
});

describe('reserveLoad — an external load in progress (the vision runtime starting)', () => {
  test('a model load waits for it and loads when the start fails', async () => {
    const { manager, llamaService } = makeManager();
    const release = manager.reserveLoad('vision-runtime', 5 * GiB);

    const loading = manager.ensureModelLoaded('text');
    await tick(40);
    expect(llamaService._loadModel).not.toHaveBeenCalled();

    release();
    await loading;
    expect(llamaService._loadModel).toHaveBeenCalledTimes(1);
  });

  test('a model load is refused when the reservation outlasts the wait', async () => {
    const { manager, llamaService } = makeManager();
    manager._pinnedResidentWaitMs = 60;
    manager.reserveLoad('vision-runtime', 5 * GiB);

    await expect(manager.ensureModelLoaded('text')).rejects.toMatchObject({
      code: 'MODEL_MEMORY_BUDGET_EXCEEDED'
    });
    expect(llamaService._loadModel).not.toHaveBeenCalled();
  });

  test('a model load waits through the start and the request that pins the runtime', async () => {
    const { manager, llamaService } = makeManager();
    const release = manager.reserveLoad('vision-runtime', 5 * GiB);
    const dispose = jest.fn().mockResolvedValue(undefined);

    const loading = manager.ensureModelLoaded('text');
    await tick(30);
    // The runtime came up: it registers, a request pins it, the reservation ends.
    manager.registerExternalConsumer({ type: 'vision-runtime', sizeBytes: 5 * GiB, dispose });
    manager.acquireRef('vision-runtime');
    release();
    await tick(40);
    expect(llamaService._loadModel).not.toHaveBeenCalled();

    manager.releaseRef('vision-runtime');
    await loading;
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(llamaService._loadModel).toHaveBeenCalledTimes(1);
  });

  test('memory that is both reserved and registered is counted once', () => {
    const { manager } = makeManager();
    const release = manager.reserveLoad('vision-runtime', 5 * GiB);
    manager.registerExternalConsumer({
      type: 'vision-runtime',
      sizeBytes: 5 * GiB,
      dispose: jest.fn()
    });

    expect(manager.canLoadModel('embedding')).toBe(true);
    release();
    expect(manager.canLoadModel('embedding')).toBe(true);
  });

  test('excludeType leaves the reservation of the caller itself out of the sum', () => {
    const { manager } = makeManager();
    manager.reserveLoad('vision-runtime', 5 * GiB);

    expect(manager.canFitExternalLoad(5 * GiB)).toBe(false);
    expect(manager.canFitExternalLoad(5 * GiB, { excludeType: 'vision-runtime' })).toBe(true);
  });

  test('ending a reservation twice, or after a newer one replaced it, changes nothing', () => {
    const { manager } = makeManager();
    const first = manager.reserveLoad('vision-runtime', 5 * GiB);
    const second = manager.reserveLoad('vision-runtime', 3 * GiB);

    first();
    first();
    expect(manager.getMemoryStatus().pendingLoads).toEqual(['vision-runtime']);
    expect(manager.canFitExternalLoad(4.5 * GiB)).toBe(false);

    second();
    expect(manager.getMemoryStatus().pendingLoads).toEqual([]);
  });

  test('optional background work does not start on memory that is spoken for', () => {
    const { manager } = makeManager();
    expect(manager.canRunOptionalLoad('text')).toBe(true);
    manager.reserveLoad('vision-runtime', 5 * GiB);
    expect(manager.canRunOptionalLoad('text')).toBe(false);
  });
});

describe('a model whose own estimate is larger than the budget', () => {
  // A 7B model on a 6 GB card: 5.8 GiB against a 4.8 GiB budget. No amount
  // of eviction makes it fit, so it loads once nothing else holds memory.
  function oversized() {
    const made = makeManager({ budgetBytes: 4.8 * GiB });
    made.manager._modelSizeEstimates.text = 5.8 * GiB;
    made.manager._modelSizeEstimates.embedding = 0.2 * GiB;
    return made;
  }

  test('loads as soon as the model that was in use is gone, not when the wait runs out', async () => {
    const { manager, llamaService } = oversized();
    manager._pinnedResidentWaitMs = 5000;
    await manager.ensureModelLoaded('embedding');
    manager.acquireRef('embedding');

    const startedAt = Date.now();
    const loading = manager.ensureModelLoaded('text');
    await tick(30);
    manager.releaseRef('embedding');
    await loading;

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(manager._loadedModels.has('embedding')).toBe(false);
    expect(llamaService._loadModel).toHaveBeenCalledWith('text', expect.anything());
  });

  test('optional work may use it once it is the only thing in memory', async () => {
    const { manager } = oversized();
    await manager.ensureModelLoaded('text');

    expect(manager.canRunOptionalLoad('text')).toBe(true);

    manager.reserveLoad('vision-runtime', 5 * GiB);
    expect(manager.canRunOptionalLoad('text')).toBe(false);
  });

  test('a load in progress is counted at the size found in the model file', async () => {
    const { manager, llamaService } = makeManager({ budgetBytes: 4.8 * GiB });
    manager._modelSizeEstimates.embedding = 0.2 * GiB;
    const gate = deferred();
    llamaService._loadModel.mockImplementation(async () => {
      // LlamaService._loadModel does this right after it stats the file.
      manager.updateModelSizeEstimate('text', (5.8 * GiB) / 1.3);
      await gate.promise;
      return {};
    });

    const loading = manager.ensureModelLoaded('text');
    await tick();
    // 4 GiB (the default) + 0.2 would have fitted in 4.8.
    expect(manager.canLoadModel('embedding')).toBe(false);

    gate.resolve();
    await loading;
  });
});
