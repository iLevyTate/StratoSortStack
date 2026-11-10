/**
 * On a GPU too small for both models (Qwen2.5-7B, about 5.8 GB, on a 6 GB
 * RTX 4050 with a 5 GB budget), every file used to evict the text model to
 * load the embedding model and then reload the text model: about 4-5 s of
 * churn per file in a live run. The embedding model now loads on the CPU
 * beside the resident text model.
 */
jest.mock('os', () => ({
  totalmem: jest.fn(() => 16 * 1024 * 1024 * 1024),
  freemem: jest.fn(() => 8 * 1024 * 1024 * 1024)
}));
jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })
}));

const { ModelMemoryManager } = require('../src/main/services/ModelMemoryManager');

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function managerWithIdleText() {
  const llamaService = {
    _models: { text: null, vision: null, embedding: null },
    _contexts: { text: null, vision: null, embedding: null },
    _loadModel: jest.fn().mockResolvedValue({ ctx: 'embedding' }),
    _unloadModel: jest.fn().mockResolvedValue(undefined)
  };
  const manager = new ModelMemoryManager(llamaService);
  manager._maxMemoryUsage = 5 * GiB;
  jest.spyOn(manager, '_refreshMemoryBudget').mockImplementation(() => {});
  manager._modelSizeEstimates.embedding = 181 * MiB;
  manager._pinnedResidentWaitMs = 0;
  // The text model is resident and idle between files (no active refs).
  manager._loadedModels.set('text', {
    context: { ctx: 'text' },
    lastUsed: 1,
    sizeBytes: 5806 * MiB
  });
  manager._currentMemoryUsage = 5806 * MiB;
  const unloadSpy = jest.spyOn(manager, 'unloadModel');
  return { manager, llamaService, unloadSpy };
}

describe('ModelMemoryManager: keepBeside', () => {
  test('a CPU embedding load with keepBeside leaves the idle text model resident', async () => {
    const { manager, llamaService, unloadSpy } = managerWithIdleText();
    await manager.ensureModelLoaded('embedding', {
      gpuLayersOverride: 0,
      besideResident: 'text',
      keepBeside: true
    });
    expect(manager._loadedModels.has('text')).toBe(true);
    expect(unloadSpy).not.toHaveBeenCalledWith('text', expect.anything());
    expect(llamaService._loadModel).toHaveBeenCalledWith(
      'embedding',
      expect.objectContaining({ gpuLayersOverride: 0 })
    );
  });

  test('without keepBeside the idle text model is still evicted (unchanged rule)', async () => {
    const { manager } = managerWithIdleText();
    await manager.ensureModelLoaded('embedding', { gpuLayersOverride: 0, besideResident: 'text' });
    expect(manager._loadedModels.has('text')).toBe(false);
  });

  test('keepBeside does not exempt a GPU load', async () => {
    const { manager } = managerWithIdleText();
    await manager.ensureModelLoaded('embedding', { besideResident: 'text', keepBeside: true });
    expect(manager._loadedModels.has('text')).toBe(false);
  });
});

describe('LlamaService._loadOptionsBesideText', () => {
  const LlamaServiceModule = require('../src/main/services/LlamaService');
  const LlamaService = LlamaServiceModule.LlamaService || LlamaServiceModule;
  const pick = LlamaService.prototype._loadOptionsBesideText;

  const service = ({
    backend = 'cuda',
    text = true,
    textLoading = false,
    embedding = false,
    fits = false
  } = {}) => ({
    _gpuBackend: backend,
    _modelMemoryManager: {
      getLoadedContext: (type) =>
        (type === 'text' && text) || (type === 'embedding' && embedding) ? {} : null,
      isLoadedOrLoading: (type) =>
        (type === 'text' && (text || textLoading)) || (type === 'embedding' && embedding),
      canLoadModel: () => fits
    }
  });

  test('embedding beside a GPU-filling text model goes to the CPU, without the warning', () => {
    expect(pick.call(service(), 'embedding')).toEqual({
      gpuLayersOverride: 0,
      besideResident: 'text',
      keepBeside: true,
      cpuByDesign: true
    });
  });

  test.each([
    ['both fit on the GPU', { fits: true }],
    ['no text model resident', { text: false }],
    ['embedding already loaded', { embedding: true }],
    ['CPU backend', { backend: 'cpu' }],
    ['backend not chosen yet', { backend: null }]
  ])('no override when %s', (_name, opts) => {
    expect(pick.call(service(opts), 'embedding')).toBeUndefined();
  });

  test('only the embedding model is affected', () => {
    expect(pick.call(service(), 'text')).toBeUndefined();
  });

  describe('while the text model is still loading', () => {
    // The first document's text load takes several seconds. An embedding
    // request in that window was offered no CPU option, because only a text
    // model already in memory counted: it waited for the text model to go
    // idle and then evicted it.
    function managerLoadingText() {
      const llamaService = {
        _models: { text: null, vision: null, embedding: null },
        _contexts: { text: null, vision: null, embedding: null },
        _loadModel: jest.fn().mockResolvedValue({ ctx: 'embedding' }),
        _unloadModel: jest.fn().mockResolvedValue(undefined)
      };
      const manager = new ModelMemoryManager(llamaService);
      manager._maxMemoryUsage = 5 * GiB;
      jest.spyOn(manager, '_refreshMemoryBudget').mockImplementation(() => {});
      manager._modelSizeEstimates.embedding = 181 * MiB;
      manager._pinnedResidentWaitMs = 0;
      const endTextLoad = manager.reserveLoad('text', 5806 * MiB);
      return { manager, llamaService, endTextLoad };
    }

    test('a text load in progress counts as the text model holding the GPU', () => {
      expect(pick.call(service({ text: false, textLoading: true }), 'embedding')).toEqual({
        gpuLayersOverride: 0,
        besideResident: 'text',
        keepBeside: true,
        cpuByDesign: true
      });
    });

    test('the embedding model loads on the CPU beside it, without waiting for it', async () => {
      const { manager, llamaService } = managerLoadingText();

      const options = pick.call({ _gpuBackend: 'cuda', _modelMemoryManager: manager }, 'embedding');
      await manager.ensureModelLoaded('embedding', options);

      expect(llamaService._loadModel).toHaveBeenCalledWith(
        'embedding',
        expect.objectContaining({ gpuLayersOverride: 0 })
      );
      // The text load is still in progress and was not disturbed.
      expect(manager.getMemoryStatus().pendingLoads).toContain('text');
      expect(llamaService._unloadModel).not.toHaveBeenCalled();
    });

    test('once the text load failed, the embedding model loads on the GPU as usual', () => {
      const { manager, endTextLoad } = managerLoadingText();
      endTextLoad();

      expect(
        pick.call({ _gpuBackend: 'cuda', _modelMemoryManager: manager }, 'embedding')
      ).toBeUndefined();
    });
  });
});

describe('ModelMemoryManager.isLoadedOrLoading', () => {
  function emptyManager() {
    const manager = new ModelMemoryManager({
      _models: {},
      _contexts: {},
      _loadModel: jest.fn(),
      _unloadModel: jest.fn()
    });
    jest.spyOn(manager, '_refreshMemoryBudget').mockImplementation(() => {});
    return manager;
  }

  test('false for a model that is neither in memory nor being loaded', () => {
    expect(emptyManager().isLoadedOrLoading('text')).toBe(false);
  });

  test('true for a model in memory, without marking it as used', () => {
    const manager = emptyManager();
    manager._loadedModels.set('text', { context: {}, lastUsed: 1, sizeBytes: GiB });

    expect(manager.isLoadedOrLoading('text')).toBe(true);
    expect(manager._loadedModels.get('text').lastUsed).toBe(1);
  });

  test('true while a load is in progress, false once it ended without a model', () => {
    const manager = emptyManager();
    const endLoad = manager.reserveLoad('text', GiB);

    expect(manager.isLoadedOrLoading('text')).toBe(true);
    endLoad();
    expect(manager.isLoadedOrLoading('text')).toBe(false);
  });

  test('false for a model that is being unloaded', () => {
    const manager = emptyManager();
    manager._loadedModels.set('text', {
      context: {},
      lastUsed: 1,
      sizeBytes: GiB,
      disposing: true
    });

    expect(manager.isLoadedOrLoading('text')).toBe(false);
  });
});
