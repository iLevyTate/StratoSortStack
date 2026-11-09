/**
 * LlamaService: the native engine cannot load (node-llama-cpp throws
 * NoBinaryFoundError for every backend), as on a clean Windows install that
 * lacks the Microsoft Visual C++ Redistributable.
 *
 * Contract:
 * - runtime missing -> one ai.vc-runtime-missing flag with an "open download
 *   page" action, one clear warn line, and the thrown error carries the
 *   user-facing message;
 * - runtime present -> no flag, today's error log, original error rethrown;
 * - either way the failure is sticky: later initialize() calls rethrow without
 *   re-probing every backend or logging again (previously ~15 identical
 *   stacks per launch);
 * - unrelated init failures stay retryable;
 * - shutdown() clears the sticky failure.
 */

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};
jest.mock('../src/shared/logger', () => ({
  createLogger: () => mockLogger
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
  getRecommendedConcurrency: jest.fn().mockResolvedValue({ maxConcurrent: 1 })
}));

const mockTracker = { raise: jest.fn(), clear: jest.fn() };
jest.mock('../src/main/services/DegradedStateTracker', () => ({
  getInstance: jest.fn(() => mockTracker)
}));

// node-llama-cpp on a machine without the VC++ runtime: every backend, CPU
// included, fails with a plain Error whose message is "NoBinaryFoundError".
const mockGetLlama = jest.fn();
jest.mock('node-llama-cpp', () => ({
  getLlama: (...args) => mockGetLlama(...args),
  LlamaChatSession: jest.fn()
}));

const mockDetectVcRuntime = jest.fn();
jest.mock('../src/main/utils/vcRuntimeDetection', () => ({
  ...jest.requireActual('../src/main/utils/vcRuntimeDetection'),
  detectVcRuntime: (...args) => mockDetectVcRuntime(...args)
}));

const { LlamaService } = require('../src/main/services/LlamaService');

const MISSING = {
  applicable: true,
  present: false,
  missingDlls: ['msvcp140.dll', 'vcruntime140.dll'],
  systemDir: 'C:\\Windows\\System32',
  registryInstalled: null,
  archLabel: 'x64'
};
const PRESENT = {
  applicable: true,
  present: true,
  missingDlls: [],
  systemDir: 'C:\\Windows\\System32',
  registryInstalled: true,
  archLabel: 'x64'
};

function createService() {
  const service = new LlamaService();
  service._ensureConfigLoaded = jest.fn().mockResolvedValue(undefined);
  service._gpuMonitor = { detectGPU: jest.fn().mockResolvedValue({ type: 'none', name: null }) };
  service._createLlamaBackendCache = jest.fn().mockResolvedValue(undefined);
  return service;
}

const warnLines = () =>
  mockLogger.warn.mock.calls.filter(([msg]) => String(msg).includes('Local AI unavailable'));

describe('LlamaService native engine init failure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetLlama.mockImplementation(async () => {
      throw new Error('NoBinaryFoundError');
    });
  });

  test('VC++ runtime missing: raises one actionable flag, logs one warn line, rejects with the user-facing message', async () => {
    mockDetectVcRuntime.mockResolvedValue(MISSING);
    const service = createService();

    const first = await service.initialize().catch((e) => e);

    expect(first).toBeInstanceOf(Error);
    expect(first.message).toBe(
      "Local AI needs the Microsoft Visual C++ Redistributable (x64), which isn't installed on this PC. Install it from Microsoft, then restart StratoSort."
    );
    expect(first.code).toBe('AI_VC_RUNTIME_MISSING');
    expect(first.cause).toEqual(expect.objectContaining({ message: 'NoBinaryFoundError' }));

    expect(mockTracker.raise).toHaveBeenCalledTimes(1);
    expect(mockTracker.raise).toHaveBeenCalledWith({
      code: 'ai.vc-runtime-missing',
      subsystem: 'ai',
      severity: 'error',
      message: first.message,
      detail: expect.objectContaining({
        missingDlls: ['msvcp140.dll', 'vcruntime140.dll'],
        arch: 'x64',
        action: { code: 'ai.install-vc-runtime', label: 'Install now' },
        secondaryAction: { code: 'ai.open-vc-redist-download', label: 'Open download page' }
      })
    });
    expect(warnLines()).toHaveLength(1);
    expect(warnLines()[0][0]).toContain('missing msvcp140.dll, vcruntime140.dll');
    // No stack-trace error log for the expected, explained condition.
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(service._initialized).toBe(false);
  });

  test('failure is sticky: later calls rethrow the same error without re-probing, re-flagging or re-logging', async () => {
    mockDetectVcRuntime.mockResolvedValue(MISSING);
    const service = createService();

    const first = await service.initialize().catch((e) => e);
    const probesAfterFirst = mockGetLlama.mock.calls.length;
    expect(probesAfterFirst).toBeGreaterThan(0);

    const later = await Promise.all(
      Array.from({ length: 15 }, () => service.initialize().catch((e) => e))
    );

    expect(later.every((e) => e === first)).toBe(true);
    expect(mockGetLlama).toHaveBeenCalledTimes(probesAfterFirst);
    expect(mockDetectVcRuntime).toHaveBeenCalledTimes(1);
    expect(mockTracker.raise).toHaveBeenCalledTimes(1);
    expect(warnLines()).toHaveLength(1);
  });

  test('concurrent first callers share one attempt and one flag', async () => {
    mockDetectVcRuntime.mockResolvedValue(MISSING);
    const service = createService();

    const results = await Promise.all([
      service.initialize().catch((e) => e),
      service.initialize().catch((e) => e),
      service.initialize().catch((e) => e)
    ]);

    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
    expect(mockDetectVcRuntime).toHaveBeenCalledTimes(1);
    expect(mockTracker.raise).toHaveBeenCalledTimes(1);
  });

  test('VC++ runtime present: no flag, error logged once, original error rethrown and still sticky', async () => {
    mockDetectVcRuntime.mockResolvedValue(PRESENT);
    const service = createService();

    const first = await service.initialize().catch((e) => e);
    expect(first.message).toBe('NoBinaryFoundError');
    expect(mockTracker.raise).not.toHaveBeenCalled();
    expect(warnLines()).toHaveLength(0);
    expect(mockLogger.error).toHaveBeenCalledTimes(1);

    const probes = mockGetLlama.mock.calls.length;
    await expect(service.initialize()).rejects.toBe(first);
    expect(mockGetLlama).toHaveBeenCalledTimes(probes);
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });

  test('non-native init failures stay retryable (not sticky, no VC++ probe)', async () => {
    const service = createService();
    service._ensureConfigLoaded = jest
      .fn()
      .mockRejectedValueOnce(new Error('Settings file unreadable'))
      .mockResolvedValue(undefined);
    service._initializeLlama = jest.fn().mockResolvedValue(undefined);

    await expect(service.initialize()).rejects.toThrow('Settings file unreadable');
    await expect(service.initialize()).resolves.toBeUndefined();

    expect(service._initialized).toBe(true);
    expect(mockDetectVcRuntime).not.toHaveBeenCalled();
    expect(mockTracker.raise).not.toHaveBeenCalled();
  });

  test('shutdown() clears the sticky failure so a re-initialize tries again', async () => {
    mockDetectVcRuntime.mockResolvedValue(MISSING);
    const service = createService();

    await service.initialize().catch(() => {});
    expect(service._initFailure).not.toBeNull();

    await service.shutdown();
    expect(service._initFailure).toBeNull();
  });
});
