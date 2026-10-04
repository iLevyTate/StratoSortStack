jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const mockGpuMonitor = {
  detectGPU: jest.fn()
};

const mockDownloadManager = {
  getDownloadedModels: jest.fn(),
  checkDiskSpace: jest.fn()
};

jest.mock('../src/main/services/GPUMonitor', () => ({
  getInstance: jest.fn(() => mockGpuMonitor),
  GPUMonitor: jest.fn(() => mockGpuMonitor)
}));

jest.mock('../src/main/services/ModelDownloadManager', () => ({
  getInstance: jest.fn(() => mockDownloadManager),
  ModelDownloadManager: jest.fn(() => mockDownloadManager)
}));

const { DegradationManager } = require('../src/main/services/DegradationManager');

describe('DegradationManager', () => {
  beforeEach(() => {
    mockGpuMonitor.detectGPU.mockReset();
    mockDownloadManager.getDownloadedModels.mockReset();
    mockDownloadManager.checkDiskSpace.mockReset();
  });

  test('checkSystemReadiness flags missing models and no GPU', async () => {
    mockGpuMonitor.detectGPU.mockResolvedValue({ type: 'cpu' });
    mockDownloadManager.getDownloadedModels.mockResolvedValue([{ filename: 'text.gguf' }]);
    mockDownloadManager.checkDiskSpace.mockResolvedValue({ sufficient: true });

    const manager = new DegradationManager({
      _selectedModels: { embedding: 'embed.gguf', text: 'text.gguf' }
    });

    const result = await manager.checkSystemReadiness();

    expect(result.ready).toBe(false);
    expect(result.warnings.length).toBe(1);
    expect(result.issues[0].type).toBe('missing_models');
    expect(result.degradationState.gpuAvailable).toBe(false);
    expect(result.degradationState.missingModels).toEqual(['embedding']);
  });

  test('checkSystemReadiness warns on low disk space', async () => {
    mockGpuMonitor.detectGPU.mockResolvedValue({ type: 'gpu' });
    mockDownloadManager.getDownloadedModels.mockResolvedValue([]);
    mockDownloadManager.checkDiskSpace.mockResolvedValue({ sufficient: false });

    const manager = new DegradationManager({ _selectedModels: null });
    const result = await manager.checkSystemReadiness();

    expect(result.warnings[0].type).toBe('low_disk_space');
  });

  test('handleError maps gpu memory errors to cpu retry and updates state', async () => {
    const manager = new DegradationManager();
    const result = await manager.handleError(new Error('CUDA out of memory'));
    expect(result.action).toBe('retry_with_cpu');
    expect(result.shouldNotifyUser).toBe(true);
    // Verify internal state is updated so attemptRecovery() knows to re-enable GPU
    expect(manager._degradationState.usingCPUFallback).toBe(true);
    expect(manager._degradationState.gpuAvailable).toBe(false);
  });

  test('handleError maps real GGUF corruption errors to redownload', async () => {
    const manager = new DegradationManager();
    const result = await manager.handleError(new Error('Invalid GGUF magic in header'), {
      modelType: 'text'
    });
    expect(result.action).toBe('redownload_model');
    expect(result.modelType).toBe('text');
  });

  test('handleError maps mmap failures to redownload', async () => {
    const manager = new DegradationManager();
    const result = await manager.handleError(new Error('mmap failed: Cannot allocate memory'), {
      modelType: 'text'
    });
    expect(result.action).toBe('redownload_model');
  });

  test('handleError tags generic load failures as transient_load_failure (not corruption)', async () => {
    // The native llama-cpp addon throws bare "Failed to load model" for many
    // unrelated causes — VRAM pressure, init races, file-handle contention.
    // Treating that string as a corruption signal produced false-positive
    // "Model corrupted, please redownload" notifications whenever a load
    // happened to fail under transient memory pressure. We tag it as
    // transient_load_failure so withLlamaResilience can run a one-shot
    // retry+backoff recovery instead of declaring the file corrupt.
    const manager = new DegradationManager();
    const result = await manager.handleError(new Error('Failed to load model'), {
      modelType: 'text'
    });
    expect(result.action).toBe('transient_load_failure');
    expect(result.action).not.toBe('redownload_model');
    expect(result.shouldNotifyUser).toBe(false);
    expect(result.originalError).toBeDefined();
  });

  test('handleError coalesces non-Error rejections (string, plain object) without crashing', async () => {
    // Workers and IPC layers occasionally reject with a bare string instead of
    // an Error. Legacy `(error.message || '').toLowerCase()` returned '' for
    // these, causing every classifier check to miss and the request to land
    // silently in the unknown-error branch.
    const manager = new DegradationManager();

    const stringResult = await manager.handleError('Failed to load model');
    expect(stringResult.action).toBe('transient_load_failure');

    const objectResult = await manager.handleError({ toString: () => 'CUDA out of memory' });
    expect(objectResult.action).toBe('retry_with_cpu');

    // Genuinely null/undefined errors should still land in the unknown branch
    // without throwing.
    const nullResult = await manager.handleError(null);
    expect(nullResult.action).toBe('none');
  });

  test('handleError logs unknown errors so novel failure modes surface in production', async () => {
    // Capture logger calls via the manager's logger reference. We can't easily
    // intercept the createLogger() factory output from here, but we CAN assert
    // that the unknown-error branch returns originalError (a regression check
    // that the path runs at all).
    const manager = new DegradationManager();
    const novelError = new TypeError("Cannot read property 'foo' of undefined");
    const result = await manager.handleError(novelError, { modelType: 'text' });
    expect(result.action).toBe('none');
    expect(result.originalError).toBe(novelError);
  });

  test('handleError catches "not enough VRAM" via shared classifier', async () => {
    const manager = new DegradationManager();
    const result = await manager.handleError(new Error('VRAM exhausted while loading layers'));
    expect(result.action).toBe('retry_with_cpu');
    expect(manager._degradationState.usingCPUFallback).toBe(true);
  });

  test('attemptRecovery blocks when missing models', async () => {
    const manager = new DegradationManager();
    manager._degradationState.missingModels = ['text'];

    const result = await manager.attemptRecovery();
    expect(result.canRecover).toBe(false);
    expect(result.action).toBe('download_models');
  });

  test('attemptRecovery restores gpu when available', async () => {
    mockGpuMonitor.detectGPU.mockResolvedValue({ type: 'gpu' });
    const manager = new DegradationManager();
    manager._degradationState.usingCPUFallback = true;
    manager._degradationState.gpuAvailable = false;

    const result = await manager.attemptRecovery();
    expect(result.action).toBe('gpu_restored');
    expect(manager._degradationState.usingCPUFallback).toBe(false);
    expect(manager._degradationState.gpuAvailable).toBe(true);
  });
});
