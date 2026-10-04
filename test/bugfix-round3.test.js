/**
 * Tests for Bug Fix Round 3:
 *
 * 1. GPUMonitor.detectGPU() caching
 * 2. ModelAccessCoordinator.acquireLoadLock timeout
 *
 * Two former sections were removed as test theater (they reimplemented the
 * fixed flow inline and asserted against their own copies, importing nothing
 * from src/). Their real coverage now lives in dedicated suites that drive the
 * actual LlamaService methods:
 *   - session disposal on sequence exhaustion -> test/LlamaService.sequenceExhaustion.test.js
 *   - _reloadModelCPU blocked-ops resilience  -> test/LlamaService.reloadModelCPU.test.js
 */

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

// ============================================================
// SECTION 1: GPUMonitor caching
// ============================================================

const mockExecFileAsync = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });

jest.mock('child_process', () => {
  const fn = function () {};
  fn[require('util').promisify.custom] = mockExecFileAsync;
  return { execFile: fn };
});

const { GPUMonitor } = require('../src/main/services/GPUMonitor');

describe('GPUMonitor caching', () => {
  beforeEach(() => {
    mockExecFileAsync.mockReset();
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
  });

  test('caches results after first call', async () => {
    const monitor = new GPUMonitor();
    monitor._platform = 'win32';
    mockExecFileAsync.mockResolvedValue({ stdout: 'RTX 4090, 24576', stderr: '' });

    const first = await monitor.detectGPU();
    expect(first.type).toBe('cuda');
    expect(first.vramMB).toBe(24576);

    // Reset mock to return different data
    mockExecFileAsync.mockResolvedValue({ stdout: 'RTX 3060, 12288', stderr: '' });

    // Second call should return cached result (same as first)
    const second = await monitor.detectGPU();
    expect(second).toBe(first); // Same object reference
    expect(second.vramMB).toBe(24576); // Original value, not 12288
  });

  test('force: true bypasses cache and re-detects', async () => {
    const monitor = new GPUMonitor();
    monitor._platform = 'win32';
    mockExecFileAsync.mockResolvedValue({ stdout: 'RTX 4090, 24576', stderr: '' });

    const first = await monitor.detectGPU();
    expect(first.vramMB).toBe(24576);

    // Return different data for force re-detection
    mockExecFileAsync.mockResolvedValue({ stdout: 'RTX 3060, 12288', stderr: '' });

    const forced = await monitor.detectGPU({ force: true });
    expect(forced.vramMB).toBe(12288); // New value after force
    expect(forced).not.toBe(first); // Different object
  });

  test('caches CPU fallback result too', async () => {
    const monitor = new GPUMonitor();
    monitor._platform = 'win32';
    // All detection methods fail
    mockExecFileAsync.mockRejectedValue(new Error('not found'));

    const first = await monitor.detectGPU();
    expect(first.type).toBe('cpu');

    // Should return cached CPU result without calling exec again
    const callsBefore = mockExecFileAsync.mock.calls.length;
    const second = await monitor.detectGPU();
    expect(second).toBe(first);
    expect(mockExecFileAsync.mock.calls.length).toBe(callsBefore); // No new calls
  });

  test('constructor does not pre-populate cache', () => {
    const monitor = new GPUMonitor();
    expect(monitor._gpuInfo).toBeNull();
  });
});

// ============================================================
// SECTION 2: ModelAccessCoordinator.acquireLoadLock timeout
// ============================================================

// We need a real PQueue-like implementation that supports concurrency: 1 blocking
jest.mock('p-queue', () => {
  class MockPQueue {
    constructor(opts = {}) {
      this.concurrency = opts.concurrency || 1;
      this.size = 0;
      this.pending = 0;
      this._queue = [];
      this._running = 0;
    }

    add(fn) {
      if (this._running < this.concurrency) {
        this._running++;
        this.pending++;
        const run = async () => {
          try {
            await fn();
          } finally {
            this._running--;
            this.pending = Math.max(0, this.pending - 1);
            this._tryNext();
          }
        };
        run();
      } else {
        this.size++;
        this._queue.push(fn);
      }
    }

    _tryNext() {
      if (this._queue.length > 0 && this._running < this.concurrency) {
        const next = this._queue.shift();
        this.size = Math.max(0, this.size - 1);
        this._running++;
        this.pending++;
        const run = async () => {
          try {
            await next();
          } finally {
            this._running--;
            this.pending = Math.max(0, this.pending - 1);
            this._tryNext();
          }
        };
        run();
      }
    }
  }
  return { default: MockPQueue };
});

// Re-require after p-queue mock is updated
jest.resetModules();
jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const { ModelAccessCoordinator } = require('../src/main/services/ModelAccessCoordinator');

describe('ModelAccessCoordinator.acquireLoadLock timeout', () => {
  test('acquireLoadLock succeeds when lock is available', async () => {
    const coordinator = new ModelAccessCoordinator();
    const release = await coordinator.acquireLoadLock('text');
    expect(typeof release).toBe('function');
    release();
  });

  test('acquireLoadLock times out when lock is held', async () => {
    const coordinator = new ModelAccessCoordinator();

    // Acquire first lock and hold it indefinitely
    const firstRelease = await coordinator.acquireLoadLock('text');

    // Try to acquire second lock with very short timeout — should time out
    await expect(coordinator.acquireLoadLock('text', { timeoutMs: 100 })).rejects.toThrow(
      /Load lock timeout/
    );

    // Clean up
    firstRelease();
  });

  test('timed-out lock error has correct code', async () => {
    const coordinator = new ModelAccessCoordinator();
    const firstRelease = await coordinator.acquireLoadLock('text');

    try {
      await coordinator.acquireLoadLock('text', { timeoutMs: 50 });
      // Should not reach here
      expect(true).toBe(false);
    } catch (error) {
      expect(error.code).toBe('LOAD_LOCK_TIMEOUT');
    }

    firstRelease();
  });

  test('acquireLoadLock rejects unknown model type', async () => {
    const coordinator = new ModelAccessCoordinator();
    await expect(coordinator.acquireLoadLock('unknown')).rejects.toThrow(/Unknown model type/);
  });

  test('inference slot tracks operations correctly', async () => {
    const coordinator = new ModelAccessCoordinator();
    const release = await coordinator.acquireInferenceSlot('op-test', 'text');
    const status = coordinator.getStatus();
    expect(status.activeOperations).toBe(1);
    expect(status.operations[0].id).toBe('op-test');
    release();
    expect(coordinator.getStatus().activeOperations).toBe(0);
  });
});

// SECTION 3 (LlamaService generateText session disposal on sequence
// exhaustion) and SECTION 4 (_reloadModelCPU blocked-ops resilience) were
// removed: both reimplemented the fixed flow inline and asserted against their
// own copies (importing nothing from src/). Real coverage of those production
// paths now lives in test/LlamaService.sequenceExhaustion.test.js and
// test/LlamaService.reloadModelCPU.test.js, which drive the actual methods.
