/**
 * A vision batch keeps its runtime up across images.
 *
 * From a real run on a 6 GB GPU: after every image, folder matching and the
 * embedding queue loaded the 236 MB embedding model. The memory manager's
 * budget (about 5 GB) was already exceeded by the 6.2 GB vision runtime, and
 * between images the runtime had no request in flight, so it was evicted:
 * shut down, then restarted (about 3.5 s) for the next image. Every image.
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

function managerWithVisionRuntime({ pinned }) {
  const llamaService = {
    _models: { text: null, vision: null, embedding: null },
    _contexts: { text: null, vision: null, embedding: null },
    _loadModel: jest.fn().mockResolvedValue({ ctx: 'embedding' })
  };
  const manager = new ModelMemoryManager(llamaService);
  manager._maxMemoryUsage = 5 * GiB;
  jest.spyOn(manager, '_refreshMemoryBudget').mockImplementation(() => {});
  const dispose = jest.fn().mockResolvedValue(undefined);
  manager.registerExternalConsumer({ type: 'vision-runtime', sizeBytes: 6190 * MiB, dispose });
  if (pinned) manager.acquireRef('vision-runtime');
  manager._modelSizeEstimates.embedding = 236 * MiB;
  manager._pinnedResidentWaitMs = 0;
  return { manager, llamaService, dispose };
}

describe('ModelMemoryManager: a CPU-only load beside a pinned resident', () => {
  test('loads the embedding model without evicting the pinned vision runtime', async () => {
    const { manager, llamaService, dispose } = managerWithVisionRuntime({ pinned: true });

    await manager.ensureModelLoaded('embedding', {
      gpuLayersOverride: 0,
      besideResident: 'vision-runtime'
    });

    expect(dispose).not.toHaveBeenCalled();
    expect(manager._loadedModels.has('vision-runtime')).toBe(true);
    expect(llamaService._loadModel).toHaveBeenCalledWith(
      'embedding',
      expect.objectContaining({ gpuLayersOverride: 0 })
    );
  });

  test('the old path: an unpinned runtime is evicted for the embedding load', async () => {
    const { manager, dispose } = managerWithVisionRuntime({ pinned: false });
    await manager.ensureModelLoaded('embedding');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test('a GPU load is not exempt: it still may not stack on a pinned runtime', async () => {
    const { manager, dispose } = managerWithVisionRuntime({ pinned: true });
    await expect(
      manager.ensureModelLoaded('embedding', { besideResident: 'vision-runtime' })
    ).rejects.toMatchObject({ code: 'MODEL_MEMORY_BUDGET_EXCEEDED' });
    expect(dispose).not.toHaveBeenCalled();
  });

  test('besideResident has no effect when that resident is not pinned', async () => {
    const { manager, dispose } = managerWithVisionRuntime({ pinned: false });
    await manager.ensureModelLoaded('embedding', {
      gpuLayersOverride: 0,
      besideResident: 'vision-runtime'
    });
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
