/**
 * ModelMemoryManager — residents that take nothing from the budget.
 *
 * A text model larger than the budget (Qwen2.5-7B, 5.8 GiB, against 4.8 GiB
 * on a 6 GB card) never fits, so its load evicted every idle resident. Two
 * of them hold no GPU memory: the embedding model that was loaded on the CPU
 * beside the text model or the vision runtime, and Whisper running on the
 * CPU (registered at 0 bytes). Unloading them freed nothing, and the next
 * file loaded them again.
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

function makeManager() {
  const llamaService = {
    _models: { text: null, vision: null, embedding: null },
    _contexts: { text: null, vision: null, embedding: null },
    _loadModel: jest.fn(async (type) => ({ ctx: type }))
  };
  const manager = new ModelMemoryManager(llamaService);
  manager._maxMemoryUsage = 4.8 * GiB;
  manager._modelSizeEstimates.text = 5.8 * GiB;
  manager._modelSizeEstimates.embedding = 0.2 * GiB;
  manager._pinnedResidentWaitMs = 0;
  jest.spyOn(manager, '_refreshMemoryBudget').mockImplementation(() => {});
  jest.spyOn(manager, '_disposeModelFn').mockResolvedValue(undefined);
  return { manager, llamaService };
}

/** The embedding model on the CPU beside a text load that then failed. */
async function withCpuEmbedding(manager) {
  const endTextLoad = manager.reserveLoad('text', 5.8 * GiB);
  await manager.ensureModelLoaded('embedding', {
    gpuLayersOverride: 0,
    besideResident: 'text',
    keepBeside: true
  });
  endTextLoad();
}

function registerCpuWhisper(manager) {
  const dispose = jest.fn().mockResolvedValue(undefined);
  manager.registerExternalConsumer({ type: 'audio', sizeBytes: 0, dispose });
  return dispose;
}

describe('a model loaded on the CPU beside another', () => {
  test('takes nothing from the budget and says where it runs', async () => {
    const { manager } = makeManager();
    await withCpuEmbedding(manager);

    expect(manager._currentMemoryUsage).toBe(0);
    expect(manager.isOnCpuBeside('embedding')).toBe(true);
  });

  test('a model loaded on the GPU is counted in full', async () => {
    const { manager } = makeManager();
    await manager.ensureModelLoaded('embedding');

    expect(manager._currentMemoryUsage).toBe(0.2 * GiB);
    expect(manager.isOnCpuBeside('embedding')).toBe(false);
    expect(manager.isOnCpuBeside('text')).toBe(false);
  });

  test('unloading it leaves the budget where it was', async () => {
    const { manager } = makeManager();
    await withCpuEmbedding(manager);

    await expect(manager.unloadModel('embedding')).resolves.toBe(true);

    expect(manager._currentMemoryUsage).toBe(0);
    expect(manager.isOnCpuBeside('embedding')).toBe(false);
  });
});

describe('a text model larger than the budget', () => {
  test('does not unload the embedding model that runs on the CPU', async () => {
    const { manager, llamaService } = makeManager();
    await withCpuEmbedding(manager);

    await manager.ensureModelLoaded('text');

    expect(llamaService._loadModel).toHaveBeenCalledWith('text', expect.anything());
    expect(manager._loadedModels.has('embedding')).toBe(true);
    expect(manager._disposeModelFn).not.toHaveBeenCalled();
  });

  test('does not unload Whisper running on the CPU', async () => {
    const { manager } = makeManager();
    const dispose = registerCpuWhisper(manager);

    await manager.ensureModelLoaded('text');

    expect(dispose).not.toHaveBeenCalled();
    expect(manager._loadedModels.has('audio')).toBe(true);
    expect(manager._loadedModels.has('text')).toBe(true);
  });

  test('loads at once beside a CPU model that is in use', async () => {
    const { manager, llamaService } = makeManager();
    manager._pinnedResidentWaitMs = 5000;
    await withCpuEmbedding(manager);
    manager.acquireRef('embedding');

    const startedAt = Date.now();
    await manager.ensureModelLoaded('text');

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(llamaService._loadModel).toHaveBeenCalledWith('text', expect.anything());
  });

  test('still unloads an idle model that holds GPU memory', async () => {
    const { manager } = makeManager();
    await manager.ensureModelLoaded('embedding');
    registerCpuWhisper(manager);

    await manager.ensureModelLoaded('text');

    expect(manager._loadedModels.has('embedding')).toBe(false);
    expect(manager._loadedModels.has('audio')).toBe(true);
  });

  test('is still refused while a model that holds GPU memory is in use', async () => {
    const { manager, llamaService } = makeManager();
    await manager.ensureModelLoaded('embedding');
    manager.acquireRef('embedding');

    await expect(manager.ensureModelLoaded('text')).rejects.toMatchObject({
      code: 'MODEL_MEMORY_BUDGET_EXCEEDED'
    });
    expect(llamaService._loadModel).not.toHaveBeenCalledWith('text', expect.anything());
  });

  test('optional work may use it while only CPU models sit beside it', async () => {
    const { manager } = makeManager();
    await withCpuEmbedding(manager);
    await manager.ensureModelLoaded('text');

    expect(manager.canRunOptionalLoad('text')).toBe(true);
  });
});

describe('an external load (the vision runtime) larger than the budget', () => {
  test('fits beside residents that take nothing from the budget', async () => {
    const { manager } = makeManager();
    await withCpuEmbedding(manager);
    registerCpuWhisper(manager);

    expect(manager.canFitExternalLoad(6 * GiB)).toBe(true);
  });

  test('making room for it leaves them loaded', async () => {
    const { manager } = makeManager();
    await withCpuEmbedding(manager);
    const dispose = registerCpuWhisper(manager);
    await manager.ensureModelLoaded('text');

    await expect(manager.makeRoomForExternalLoad(6 * GiB)).resolves.toBe(true);

    expect(manager._loadedModels.has('text')).toBe(false);
    expect(manager._loadedModels.has('embedding')).toBe(true);
    expect(dispose).not.toHaveBeenCalled();
  });
});
