/**
 * @jest-environment node
 *
 * Extended tests for ModelMemoryManager covering:
 *  - LRU eviction skipping models with active refs
 *  - VRAM-aware budget calculation via setGpuInfo()
 *  - unloadAll() correctness
 *  - getLoadedContext() fast path
 *  - acquireRef/releaseRef lifecycle
 *  - ensureModelLoaded eviction loop protection
 *  - getMemoryStatus()
 */

jest.mock('os', () => ({
  totalmem: jest.fn(() => 16 * 1024 * 1024 * 1024), // 16 GB
  freemem: jest.fn(() => 8 * 1024 * 1024 * 1024), // 8 GB
  cpus: jest.fn(() => Array(8).fill({ model: 'Test CPU' }))
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

function createMockLlamaService() {
  const models = {};
  const contexts = {};
  return {
    _models: models,
    _contexts: contexts,
    _loadModel: jest.fn(async (type) => {
      const ctx = { dispose: jest.fn().mockResolvedValue() };
      models[type] = ctx;
      contexts[type] = ctx;
      return ctx;
    })
  };
}

describe('ModelMemoryManager – extended', () => {
  // ─── LRU eviction with active refs ─────────────────────────

  test('LRU eviction skips models with active refs', async () => {
    const llamaService = createMockLlamaService();
    const mgr = new ModelMemoryManager(llamaService);

    // Give enough budget for 1 model but not 2
    mgr._maxMemoryUsage = mgr._modelSizeEstimates.embedding + 100;

    // Load embedding model
    await mgr.ensureModelLoaded('embedding');
    expect(mgr._loadedModels.has('embedding')).toBe(true);

    // Acquire a ref (simulating in-flight inference)
    mgr.acquireRef('embedding');

    // Now try to load text model — should trigger eviction attempt
    // But embedding has an active ref, so it can't be evicted
    mgr._modelSizeEstimates.text = mgr._modelSizeEstimates.embedding; // Same size
    await mgr.ensureModelLoaded('text');

    // Both models should be loaded (budget exceeded but load proceeds anyway)
    expect(mgr._loadedModels.has('embedding')).toBe(true);
    expect(mgr._loadedModels.has('text')).toBe(true);
  });

  test('LRU eviction removes oldest unreferenced model', async () => {
    const llamaService = createMockLlamaService();
    const mgr = new ModelMemoryManager(llamaService);

    // Budget for exactly 2 models — force eviction on the 3rd
    const modelSize = 100 * 1024 * 1024; // 100MB each
    mgr._modelSizeEstimates.embedding = modelSize;
    mgr._modelSizeEstimates.text = modelSize;
    mgr._modelSizeEstimates.vision = modelSize;
    // Set budget so 2 models fit but 3 don't, and lock it from being recalculated
    mgr._maxMemoryUsage = modelSize * 2 + 50;
    // Override _refreshMemoryBudget to prevent recalculation during ensureModelLoaded
    mgr._refreshMemoryBudget = () => {};

    // Load embedding first, then text
    await mgr.ensureModelLoaded('embedding');
    // Small delay to ensure different lastUsed timestamps
    await new Promise((r) => setTimeout(r, 10));
    await mgr.ensureModelLoaded('text');

    // Now load vision — should evict embedding (oldest, no refs)
    await mgr.ensureModelLoaded('vision');

    expect(mgr._loadedModels.has('embedding')).toBe(false); // Evicted
    expect(mgr._loadedModels.has('text')).toBe(true);
    expect(mgr._loadedModels.has('vision')).toBe(true);
  });

  // ─── VRAM-aware budget ─────────────────────────────────────

  test('setGpuInfo updates memory budget with VRAM', () => {
    const llamaService = createMockLlamaService();
    const mgr = new ModelMemoryManager(llamaService);
    const budgetBefore = mgr._maxMemoryUsage;

    // Simulate a GPU with 12GB VRAM
    mgr.setGpuInfo({ vramMB: 12 * 1024 });

    // 80% of 12GB VRAM = 9.6GB, should be larger than 70% of 8GB free RAM = 5.6GB
    expect(mgr._maxMemoryUsage).toBeGreaterThan(budgetBefore);
  });

  test('unified memory caps the GPU share at total RAM minus the system reserve', () => {
    const os = require('os');
    const GiB = 1024 * 1024 * 1024;
    const {
      UNIFIED_MEMORY_SYSTEM_RESERVE_BYTES
    } = require('../src/main/services/ModelMemoryManager');
    os.totalmem.mockReturnValue(8 * GiB);
    os.freemem.mockReturnValue(2 * GiB);
    try {
      const mgr = new ModelMemoryManager(createMockLlamaService());
      // GPUMonitor reports Apple Silicon VRAM as 75% of RAM: 6 GiB -> 80% = 4.8 GiB.
      mgr.setGpuInfo({ vramMB: 6 * 1024, isAppleSilicon: true });

      expect(UNIFIED_MEMORY_SYSTEM_RESERVE_BYTES).toBe(4 * GiB);
      // Capped at 8 GiB - 4 GiB reserve; the 1.4 GiB RAM budget is smaller.
      expect(mgr._maxMemoryUsage).toBe(4 * GiB);
    } finally {
      os.totalmem.mockReturnValue(16 * GiB);
      os.freemem.mockReturnValue(8 * GiB);
    }
  });

  test('a discrete GPU keeps the full VRAM share even when free RAM is low', () => {
    const os = require('os');
    const GiB = 1024 * 1024 * 1024;
    os.freemem.mockReturnValue(2 * GiB);
    try {
      const mgr = new ModelMemoryManager(createMockLlamaService());
      mgr.setGpuInfo({ vramMB: 12 * 1024, isAppleSilicon: false });

      expect(mgr._maxMemoryUsage).toBe(Math.floor(12 * GiB * 0.8));
    } finally {
      os.freemem.mockReturnValue(8 * GiB);
    }
  });

  test('budget uses RAM fallback when no GPU info', () => {
    const llamaService = createMockLlamaService();
    const mgr = new ModelMemoryManager(llamaService);

    // No GPU info — should use 70% of free RAM (8GB) = ~5.6GB
    const expectedBudget = Math.min(8 * 1024 * 1024 * 1024 * 0.7, 16 * 1024 * 1024 * 1024);
    // Use closeTo for floating point precision
    expect(mgr._maxMemoryUsage).toBeCloseTo(expectedBudget, -1);
  });

  // ─── unloadAll ──────────────────────────────────────────────

  test('unloadAll disposes all loaded models', async () => {
    const llamaService = createMockLlamaService();
    const mgr = new ModelMemoryManager(llamaService);
    mgr._maxMemoryUsage = 20 * 1024 * 1024 * 1024; // Large budget

    await mgr.ensureModelLoaded('embedding');
    await mgr.ensureModelLoaded('text');

    expect(mgr._loadedModels.size).toBe(2);

    await mgr.unloadAll();

    expect(mgr._loadedModels.size).toBe(0);
    expect(mgr._currentMemoryUsage).toBe(0);
  });

  // ─── getLoadedContext fast path ─────────────────────────────

  test('getLoadedContext returns context for loaded model', async () => {
    const llamaService = createMockLlamaService();
    const mgr = new ModelMemoryManager(llamaService);
    mgr._maxMemoryUsage = 20 * 1024 * 1024 * 1024;

    const ctx = await mgr.ensureModelLoaded('embedding');

    expect(mgr.getLoadedContext('embedding')).toBe(ctx);
  });

  test('getLoadedContext returns null for unloaded model', () => {
    const llamaService = createMockLlamaService();
    const mgr = new ModelMemoryManager(llamaService);

    expect(mgr.getLoadedContext('embedding')).toBeNull();
  });

  test('getLoadedContext updates lastUsed timestamp', async () => {
    const llamaService = createMockLlamaService();
    const mgr = new ModelMemoryManager(llamaService);
    mgr._maxMemoryUsage = 20 * 1024 * 1024 * 1024;

    await mgr.ensureModelLoaded('embedding');
    const entry = mgr._loadedModels.get('embedding');
    const oldLastUsed = entry.lastUsed;

    await new Promise((r) => setTimeout(r, 10));
    mgr.getLoadedContext('embedding');

    expect(mgr._loadedModels.get('embedding').lastUsed).toBeGreaterThan(oldLastUsed);
  });

  // ─── acquireRef / releaseRef ────────────────────────────────

  test('acquireRef and releaseRef track reference counts', () => {
    const llamaService = createMockLlamaService();
    const mgr = new ModelMemoryManager(llamaService);

    expect(mgr._activeRefs.has('text')).toBe(false);

    mgr.acquireRef('text');
    expect(mgr._activeRefs.get('text')).toBe(1);

    mgr.acquireRef('text');
    expect(mgr._activeRefs.get('text')).toBe(2);

    mgr.releaseRef('text');
    expect(mgr._activeRefs.get('text')).toBe(1);

    mgr.releaseRef('text');
    expect(mgr._activeRefs.has('text')).toBe(false);
  });

  test('releaseRef handles releasing non-existent ref gracefully', () => {
    const llamaService = createMockLlamaService();
    const mgr = new ModelMemoryManager(llamaService);

    // Should not throw
    mgr.releaseRef('nonexistent');
    expect(mgr._activeRefs.has('nonexistent')).toBe(false);
  });

  // ─── getMemoryStatus ───────────────────────────────────────

  test('getMemoryStatus returns current state', async () => {
    const llamaService = createMockLlamaService();
    const mgr = new ModelMemoryManager(llamaService);
    mgr._maxMemoryUsage = 20 * 1024 * 1024 * 1024;

    await mgr.ensureModelLoaded('embedding');

    const status = mgr.getMemoryStatus();
    expect(status.loadedModels).toContain('embedding');
    expect(status.currentUsageMB).toBeGreaterThan(0);
    expect(status.maxMemoryMB).toBeGreaterThan(0);
    expect(typeof status.systemFreeMemoryMB).toBe('number');
  });

  // ─── _unloadModel error resilience ─────────────────────────

  test('_unloadModel keeps entry tracked when dispose fails', async () => {
    const llamaService = createMockLlamaService();
    const mgr = new ModelMemoryManager(llamaService);
    mgr._maxMemoryUsage = 20 * 1024 * 1024 * 1024;

    await mgr.ensureModelLoaded('embedding');
    const usageBefore = mgr._currentMemoryUsage;

    // Make dispose throw
    llamaService._models.embedding.dispose = jest
      .fn()
      .mockRejectedValue(new Error('dispose failed'));

    // Should not throw — but the entry must STAY tracked: the native side
    // most likely still holds the memory, and dropping the bookkeeping
    // would let "within budget" loads native-OOM the process.
    const result = await mgr._unloadModel('embedding');
    expect(result).toBe(false);
    expect(mgr._loadedModels.has('embedding')).toBe(true);
    expect(mgr._currentMemoryUsage).toBe(usageBefore);
  });

  test('_unloadModel reports success for a model that is not loaded', async () => {
    const llamaService = createMockLlamaService();
    const mgr = new ModelMemoryManager(llamaService);
    const usageBefore = mgr._currentMemoryUsage;

    // Nothing to release is a successful unload (same contract as a real
    // dispose), so eviction loops treat it as progress rather than failure.
    await expect(mgr._unloadModel('nonexistent')).resolves.toBe(true);
    expect(mgr._loadedModels.has('nonexistent')).toBe(false);
    expect(mgr._currentMemoryUsage).toBe(usageBefore);
  });
});
