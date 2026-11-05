/**
 * Vision batch mode pins the vision runtime and embeds on the CPU beside it.
 * See test/visionBatch.staysLoaded.test.js for the memory-manager half.
 */

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })
}));

const mockManager = {
  ensureModelLoaded: jest.fn().mockResolvedValue({ ctx: true }),
  unloadAll: jest.fn().mockResolvedValue(undefined),
  unloadModel: jest.fn().mockResolvedValue(true),
  acquireRef: jest.fn(),
  releaseRef: jest.fn(),
  getLoadedContext: jest.fn(() => null)
};

jest.mock('../src/main/services/DegradationManager', () => ({
  DegradationManager: jest.fn().mockImplementation(() => ({
    checkSystemReadiness: jest.fn().mockResolvedValue({ ready: true, issues: [], gpuInfo: {} }),
    handleError: jest.fn().mockResolvedValue({ action: 'none' })
  }))
}));
jest.mock('../src/main/services/ModelMemoryManager', () => ({
  ModelMemoryManager: jest.fn().mockImplementation(() => mockManager)
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
  shutdown: jest.fn().mockResolvedValue(undefined)
};
jest.mock('../src/main/services/VisionService', () => ({
  getInstance: jest.fn(() => mockVision),
  confirmGpuBackend: jest.fn(),
  VISION_RUNTIME_MEMORY_TYPE: 'vision-runtime'
}));

const { LlamaService } = require('../src/main/services/LlamaService');

describe('LlamaService vision batch keeps the runtime', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    mockManager.getLoadedContext.mockReturnValue(null);
    service = new LlamaService();
    service._modelMemoryManager = mockManager;
    service._releaseMemoryForVisionRuntime = jest.fn().mockResolvedValue(undefined);
    service._preloadTextAfterVisionRelease = jest.fn().mockResolvedValue(undefined);
  });

  test('entering pins the vision runtime once, however many owners join', async () => {
    await service.enterVisionBatchMode();
    await service.enterVisionBatchMode();
    expect(mockManager.acquireRef).toHaveBeenCalledTimes(1);
    expect(mockManager.acquireRef).toHaveBeenCalledWith('vision-runtime');
  });

  test('an embedding load during the batch is CPU-only beside the runtime', async () => {
    await service.enterVisionBatchMode();
    expect(service._loadOptionsBesideVisionBatch('embedding')).toEqual({
      gpuLayersOverride: 0,
      besideResident: 'vision-runtime',
      cpuByDesign: true
    });
    // Not for other model types, and not once an embedding model is resident.
    expect(service._loadOptionsBesideVisionBatch('text')).toBeUndefined();
    mockManager.getLoadedContext.mockReturnValue({ ctx: true });
    expect(service._loadOptionsBesideVisionBatch('embedding')).toBeUndefined();
  });

  test('outside a batch an embedding load gets no special options', () => {
    expect(service._loadOptionsBesideVisionBatch('embedding')).toBeUndefined();
  });

  test('the last owner leaving releases the pin and unloads the CPU embedding model', async () => {
    await service.enterVisionBatchMode();
    await service.enterVisionBatchMode();
    service._loadOptionsBesideVisionBatch('embedding');

    await service.exitVisionBatchMode();
    expect(mockManager.releaseRef).not.toHaveBeenCalled();

    await service.exitVisionBatchMode();
    expect(mockManager.releaseRef).toHaveBeenCalledWith('vision-runtime');
    expect(mockManager.unloadModel).toHaveBeenCalledWith('embedding');
    expect(mockVision.shutdown).toHaveBeenCalledTimes(1);
  });

  test('a batch with no embedding load does not unload anything extra', async () => {
    await service.enterVisionBatchMode();
    await service.exitVisionBatchMode();
    expect(mockManager.releaseRef).toHaveBeenCalledWith('vision-runtime');
    expect(mockManager.unloadModel).not.toHaveBeenCalled();
  });
});
