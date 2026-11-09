/**
 * scripts/packaged-launch-smoke.js judges a packaged launch from the app's own
 * JSONL logs. The fixtures below are the lines a signed x64 build wrote on a
 * GitHub Windows runner, whose Hyper-V virtual GPU cannot run the Vulkan
 * binary: the engine must be allowed to fall back to the CPU, while the CPU
 * floor failing (the clean-PC break of 5.1.2) must still fail the check.
 */
const path = require('path');
const fs = require('fs');
const {
  evaluateLogs,
  buildSeedCollection,
  seedVectorIndex,
  RESTORE_WORKER_MIN_BYTES
} = require('../scripts/packaged-launch-smoke');
const { loadPersistedCollection } = require('../src/main/workers/oramaRestoreLoader');

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
      gpuFallbacks: [{ backend: 'vulkan', loaded: 'cpu' }],
      restore: null
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

describe('seeded search index for the restore worker', () => {
  const restored = (fields) =>
    line({ msg: '[OramaVectorService] Restored fileChunks database', ...fields });
  const seed = { collection: 'fileChunks', docCount: 900 };
  const base = [VULKAN_FAILED, CPU_SELECTED, INITIALIZED];

  test('the seed is the app compact form, deterministic, with 384-dim vectors', () => {
    const text = buildSeedCollection({ docCount: 3 });
    expect(buildSeedCollection({ docCount: 3 })).toBe(text);
    const parsed = JSON.parse(text);
    expect(parsed.docs.count).toBe(3);
    const docs = Object.values(parsed.docs.docs);
    expect(docs.map((d) => d.id)).toEqual(['smoke-chunk-0', 'smoke-chunk-1', 'smoke-chunk-2']);
    expect(docs.every((d) => d.embedding.length === 384)).toBe(true);
  });

  test('the written file is past the worker threshold and the app loader reads every doc', async () => {
    // The suite's fs is the in-memory mock; the seed and the app loader both use it.
    fs.mkdirSync(require('os').tmpdir(), { recursive: true });
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'strato-seed-'));
    try {
      const written = seedVectorIndex(dir);
      expect(written.file).toBe(path.join(dir, 'vector-db', 'fileChunks.json.lz4'));
      expect(fs.statSync(written.file).size).toBe(written.bytes);
      expect(written.bytes).toBeGreaterThanOrEqual(RESTORE_WORKER_MIN_BYTES);
      const load = await loadPersistedCollection(written.file, {
        decompress: true,
        keepText: false
      });
      expect(load.status).toBe('ok');
      expect(load.docList).toHaveLength(written.docCount);
      expect(load.docList[0].embedding).toHaveLength(384);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses to seed when the LZ4 binding does not load', () => {
    expect(() => seedVectorIndex('unused', { lz4: { isLz4BindingAvailable: false } })).toThrow(
      /lz4-napi does not load/
    );
  });

  test('a restore in the worker with every document passes', () => {
    const result = evaluateLogs(
      logsOf(...base, restored({ parsedIn: 'worker', total: 900, inserted: 900, failed: 0 })),
      { seed }
    );
    expect(result.missing).toEqual([]);
    expect(result.restore).toEqual({ parsedIn: 'worker', total: 900, inserted: 900, failed: 0 });
  });

  test('a restore that fell back to the main thread fails', () => {
    const result = evaluateLogs(
      logsOf(...base, restored({ parsedIn: 'main', total: 900, inserted: 900, failed: 0 })),
      { seed }
    );
    expect(result.missing).toEqual(['restore-worker (parsed in main, not the worker)']);
  });

  test('a missing or partial restore fails', () => {
    expect(evaluateLogs(logsOf(...base), { seed }).missing).toEqual([
      'restore-worker (no "[OramaVectorService] Restored fileChunks database" line)'
    ]);
    expect(
      evaluateLogs(
        logsOf(...base, restored({ parsedIn: 'worker', total: 900, inserted: 899, failed: 1 })),
        { seed }
      ).missing
    ).toEqual(['restore-worker (not every seeded document was restored)']);
  });
});
