/**
 * scripts/packaged-launch-smoke.js judges a packaged launch from the app's own
 * JSONL logs. The fixtures below are the lines a signed x64 build wrote on a
 * GitHub Windows runner, whose Hyper-V virtual GPU cannot run the Vulkan
 * binary: the engine must be allowed to fall back to the CPU, while the CPU
 * floor failing (the clean-PC break of 5.1.2) must still fail the check.
 */
const { evaluateLogs } = require('../scripts/packaged-launch-smoke');

const line = (entry) => JSON.stringify({ level: 'info', context: 'LlamaService', ...entry });

const MARKERS = [
  line({ context: 'StartupManager', msg: '[STARTUP] Creating window' }),
  line({ context: 'StartupManager', msg: 'Coordinated startup completed successfully' }),
  line({ context: 'OcrService', msg: 'OCR pre-extraction successful' })
];
const VULKAN_FAILED = line({
  level: 'warn',
  backend: 'vulkan',
  durationMs: 411,
  error: 'NoBinaryFoundError',
  msg: '[LlamaService] Llama backend init failed'
});
const CPU_SELECTED = line({
  requested: false,
  actual: 'cpu',
  detectedGpu: 'Microsoft Hyper-V Video',
  attempted: [
    { backend: 'vulkan', success: false, durationMs: 411, error: 'NoBinaryFoundError' },
    { backend: false, success: true, actualBackend: 'cpu', durationMs: 45 }
  ],
  msg: '[LlamaService] Llama backend selected'
});
const INITIALIZED = line({ gpuBackend: 'cpu', msg: '[LlamaService] Initialized successfully' });

const logsOf = (...lines) => [...MARKERS, ...lines].join('\n');

describe('packaged launch smoke verdict', () => {
  test('a GPU backend that falls back to the CPU passes and is reported', () => {
    expect(evaluateLogs(logsOf(VULKAN_FAILED, CPU_SELECTED, INITIALIZED))).toEqual({
      missing: [],
      failures: [],
      aiBackend: 'cpu',
      gpuFallbacks: [{ backend: 'vulkan', loaded: 'cpu' }]
    });
  });

  test('the CPU floor failing is a failure', () => {
    const cpuFailed = line({
      level: 'error',
      backend: 'cpu',
      error: 'NoBinaryFoundError',
      msg: '[LlamaService] Llama backend init failed'
    });
    const result = evaluateLogs(logsOf(VULKAN_FAILED, cpuFailed));
    expect(result.missing).toEqual(['ai-engine-loaded']);
    expect(result.aiBackend).toBeNull();
    expect(result.failures).toHaveLength(2);
    expect(result.failures.every((f) => f.signature === '/NoBinaryFoundError/')).toBe(true);
  });

  test('a GPU failure with no backend selected afterwards is a failure', () => {
    const result = evaluateLogs(logsOf(VULKAN_FAILED, INITIALIZED));
    expect(result.gpuFallbacks).toEqual([]);
    expect(result.failures).toEqual([
      expect.objectContaining({ signature: '/NoBinaryFoundError/' })
    ]);
  });

  test('an unstructured NoBinaryFoundError line is never excused', () => {
    const result = evaluateLogs(
      logsOf(CPU_SELECTED, INITIALIZED, 'NoBinaryFoundError: no binary for win x64')
    );
    expect(result.failures).toEqual([
      expect.objectContaining({ line: 'NoBinaryFoundError: no binary for win x64' })
    ]);
  });

  test('the other failure signatures still fail the run', () => {
    const result = evaluateLogs(
      logsOf(CPU_SELECTED, INITIALIZED, line({ level: 'error', msg: 'Cannot find module x' }))
    );
    expect(result.failures).toEqual([
      expect.objectContaining({ signature: '/Cannot find module/' })
    ]);
  });
});
