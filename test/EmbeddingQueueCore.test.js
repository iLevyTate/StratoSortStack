/**
 * Tests for EmbeddingQueueCore
 * Focus: mutex timeout safety, enqueue validation/backpressure, and offline DB handling.
 */

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => 'C:\\user-data')
  }
}));

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('../src/shared/config/index', () => ({
  get: jest.fn((_key, fallback) => fallback)
}));

jest.mock('../src/shared/pathSanitization', () => ({
  normalizePathForIndex: (p) => String(p).replace(/\\/g, '/')
}));

jest.mock('../src/shared/pathTraceLogger', () => ({
  traceQueueUpdate: jest.fn()
}));

jest.mock('../src/shared/performanceConstants', () => ({
  BATCH: { EMBEDDING_FLUSH_DELAY_MS: 10 },
  LIMITS: { MAX_QUEUE_SIZE: 2, MAX_DEAD_LETTER_SIZE: 100 },
  THRESHOLDS: { QUEUE_HIGH_WATERMARK: 0.8, QUEUE_CRITICAL_WATERMARK: 0.9 },
  RETRY: { BACKOFF_BASE_MS: 10, BACKOFF_MAX_MS: 1000 },
  CONCURRENCY: { EMBEDDING_FLUSH: 2 },
  TIMEOUTS: { MUTEX_ACQUIRE: 50 }
}));

jest.mock('../src/shared/errorCodes', () => ({
  ERROR_CODES: { TIMEOUT: 'GEN_001' }
}));

jest.mock('../src/main/analysis/embeddingQueue/persistence', () => ({
  loadPersistedData: jest.fn().mockResolvedValue(undefined),
  persistQueueData: jest.fn().mockResolvedValue(undefined)
}));

const mockFailedHandler = {
  failedItems: new Map(),
  deadLetterQueue: [],
  trackFailedItem: jest.fn(),
  retryFailedItems: jest.fn().mockResolvedValue(undefined),
  setDeadLetterQueue: jest.fn()
};

jest.mock('../src/main/analysis/embeddingQueue/failedItemHandler', () => ({
  createFailedItemHandler: jest.fn(() => mockFailedHandler)
}));

const mockProgressTracker = {
  onProgress: jest.fn(() => () => {}),
  notify: jest.fn(),
  clear: jest.fn()
};

jest.mock('../src/main/analysis/embeddingQueue/progress', () => ({
  createProgressTracker: jest.fn(() => mockProgressTracker)
}));

jest.mock('../src/main/analysis/embeddingQueue/parallelProcessor', () => ({
  processItemsInParallel: jest.fn(async ({ items, startProcessedCount, onProgress }) => {
    const completed = startProcessedCount + items.length;
    onProgress({
      phase: 'processing',
      total: items.length,
      completed,
      percent: 100
    });
    return completed;
  })
}));

const mockContainer = {
  resolve: jest.fn()
};

jest.mock('../src/main/services/ServiceContainer', () => ({
  container: mockContainer,
  ServiceIds: { ORAMA_VECTOR: 'ORAMA_VECTOR' }
}));

describe('EmbeddingQueueCore', () => {
  const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const advance = async (ms) => {
    if (typeof jest.advanceTimersByTimeAsync === 'function') {
      await jest.advanceTimersByTimeAsync(ms);
      return;
    }
    jest.advanceTimersByTime(ms);
    await flushMicrotasks();
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockFailedHandler.failedItems = new Map();
    mockFailedHandler.deadLetterQueue = [];
  });

  test('enqueue rejects when shutdown in progress', async () => {
    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');
    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    q._isShuttingDown = true;

    await expect(q.enqueue({ id: 'file:a', vector: [1] })).resolves.toEqual({
      success: false,
      reason: 'shutting_down'
    });
  });

  test('enqueue sanitizes minor NaN corruption (<=5%) but rejects major corruption (>5%)', async () => {
    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');
    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    q.initialized = true;

    // Minor corruption: 1 NaN in 384 dims (0.26%) — should be sanitized to 0
    const minorCorrupt = new Array(384).fill(1);
    minorCorrupt[100] = Number.NaN;
    const res = await q.enqueue({ id: 'file:minor', vector: minorCorrupt });
    expect(res).toEqual({ success: true, warnings: ['vector_sanitized'] });
    expect(q.queue[0].vector[100]).toBe(0);

    // Major corruption: 1 NaN in 3 dims (33%) — should be rejected
    const res2 = await q.enqueue({ id: 'file:major', vector: [1, Number.NaN, 2] });
    expect(res2.success).toBe(false);
    expect(res2.reason).toBe('invalid_vector_values');
  });

  test('enqueue applies backpressure when queue is full (diverts to failed queue)', async () => {
    jest.useFakeTimers();

    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');
    const { persistQueueData } = require('../src/main/analysis/embeddingQueue/persistence');

    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    q.initialized = true;
    q.MAX_QUEUE_SIZE = 1;
    q.queue = [{ id: 'file:existing', vector: [1] }];

    const res = await q.enqueue({ id: 'file:overflow', vector: [1] });
    expect(res.success).toBe(false);
    expect(res.reason).toBe('queue_overflow');
    expect(mockFailedHandler.trackFailedItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'file:overflow' }),
      'queue_overflow'
    );
    expect(persistQueueData).toHaveBeenCalled();

    jest.useRealTimers();
  });

  test('_acquireFlushMutex times out without force-release; chain heals when the holder resolves', async () => {
    jest.useFakeTimers();

    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');
    const q = new EmbeddingQueue();

    let resolveStuck;
    const stuck = new Promise((resolve) => {
      resolveStuck = resolve;
    });
    q._flushMutex = stuck;

    const p1 = q._acquireFlushMutex(30);
    const assertion = expect(p1).rejects.toEqual(expect.objectContaining({ code: 'GEN_001' }));
    await flushMicrotasks();
    await advance(40);

    await assertion;

    // The tail is NOT reverted to the stuck holder: the timed-out waiter's
    // link stays in the chain (later waiters may be parked on it) and it
    // self-releases when its turn arrives. Reverting the tail is exactly what
    // wedged the queue when two waiters timed out (see the two-waiter test).
    expect(q._flushMutex).not.toBe(stuck);

    resolveStuck();
    await flushMicrotasks();
    await flushMicrotasks();

    await expect(q._acquireFlushMutex(5000)).resolves.toEqual(expect.any(Function));

    jest.useRealTimers();
  });

  test('two timed-out waiters behind a slow holder do not permanently wedge the mutex chain', async () => {
    jest.useFakeTimers();

    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');
    const q = new EmbeddingQueue();

    // A: slow flush holder that genuinely owns the mutex.
    const releaseHolder = await q._acquireFlushMutex(1000);

    // B and C chain behind the slow holder and both time out. Pre-fix, B's
    // timeout reverted the tail to A's link and C's timeout then reverted the
    // tail to B's never-resolving link — permanently wedging every later
    // acquisition (each would wait the full timeout and throw).
    const pB = q._acquireFlushMutex(30);
    const pC = q._acquireFlushMutex(30);
    const aB = expect(pB).rejects.toEqual(expect.objectContaining({ code: 'GEN_001' }));
    const aC = expect(pC).rejects.toEqual(expect.objectContaining({ code: 'GEN_001' }));
    await flushMicrotasks();
    await advance(40);
    await aB;
    await aC;

    // The slow holder finishes.
    releaseHolder();
    await advance(1);

    // A subsequent acquisition must succeed promptly via microtasks alone —
    // ownership passes straight through both timed-out links. No timer
    // advancement toward its 30ms timeout is needed.
    let acquired = false;
    const pD = q._acquireFlushMutex(30).then((release) => {
      acquired = true;
      release();
    });
    await advance(1);
    expect(acquired).toBe(true);
    await pD;

    jest.useRealTimers();
  });

  test('flush recovers promptly after concurrent flush callers time out behind a slow flush', async () => {
    jest.useFakeTimers();

    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');
    const {
      processItemsInParallel
    } = require('../src/main/analysis/embeddingQueue/parallelProcessor');

    // Slow holder: the first flush parks inside the parallel processor.
    let releaseWork;
    const workGate = new Promise((resolve) => {
      releaseWork = resolve;
    });
    processItemsInParallel.mockReset();
    processItemsInParallel.mockImplementation(async ({ items, startProcessedCount }) => {
      await workGate;
      return startProcessedCount + items.length;
    });
    mockContainer.resolve.mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      isOnline: true
    });
    mockFailedHandler.persistAll = jest.fn().mockResolvedValue(undefined);

    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    q.queue = [{ id: 'file:a', vector: [1], meta: { path: 'C:\\a.pdf' } }];

    const holder = q.flush();
    await flushMicrotasks();
    expect(q.isFlushing).toBe(true);

    // Two concurrent flush callers park on the mutex and time out
    // (TIMEOUTS.MUTEX_ACQUIRE is mocked to 50ms).
    const w1 = q.flush();
    const w2 = q.flush();
    const a1 = expect(w1).rejects.toEqual(expect.objectContaining({ code: 'GEN_001' }));
    const a2 = expect(w2).rejects.toEqual(expect.objectContaining({ code: 'GEN_001' }));
    await advance(60);
    await a1;
    await a2;

    // The slow holder completes and releases the mutex.
    releaseWork();
    await holder;

    // A subsequent flush must acquire the mutex promptly (microtasks only —
    // pre-fix this await would hang until the 50ms mutex timeout and throw,
    // re-wedging on every retry) and actually process the queue.
    q.queue = [{ id: 'file:b', vector: [1], meta: { path: 'C:\\b.pdf' } }];
    await q.flush();
    expect(q.queue).toHaveLength(0);

    jest.useRealTimers();
  });

  test('flush handles vector DB resolve error as offline and moves items to failed after max retries', async () => {
    jest.useFakeTimers();

    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');
    const { persistQueueData } = require('../src/main/analysis/embeddingQueue/persistence');

    mockContainer.resolve.mockImplementation(() => {
      throw new Error('no service');
    });

    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    q.initialized = true;
    q.MAX_RETRY_COUNT = 1;
    q.queue = [{ id: 'file:a', vector: [1, 2, 3] }];

    await q.flush();

    expect(mockFailedHandler.trackFailedItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'file:a' }),
      'Database offline'
    );
    expect(q.queue).toHaveLength(0);
    expect(persistQueueData).toHaveBeenCalled();

    // progress should include offline then fatal_error
    const phases = mockProgressTracker.notify.mock.calls.map((c) => c[0]?.phase).filter(Boolean);
    expect(phases).toEqual(expect.arrayContaining(['offline', 'fatal_error']));

    jest.useRealTimers();
  });

  test('_handleOfflineDatabase removes only batch items when queue mutates', async () => {
    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');

    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    q.initialized = true;
    q.MAX_RETRY_COUNT = 1;

    q.queue = [
      { id: 'file:C:\\a.pdf', vector: [1], meta: { path: 'C:\\a.pdf' } },
      { id: 'file:C:\\b.pdf', vector: [1], meta: { path: 'C:\\b.pdf' } },
      { id: 'file:C:\\c.pdf', vector: [1], meta: { path: 'C:\\c.pdf' } }
    ];

    const batch = q.queue.slice(0, 2);

    // Simulate concurrent removal while a flush is in progress
    q.removeByFilePath('C:\\a.pdf');

    await q._handleOfflineDatabase(batch, batch.length);

    expect(q.queue.map((item) => item.id)).toEqual(['file:C:\\c.pdf']);
  });

  test('offline retry budget is independent of inflated generic retryCount (F-052)', async () => {
    jest.useFakeTimers();

    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');

    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    q.initialized = true;
    q.MAX_RETRY_COUNT = 3;

    // Simulate prior generic (non-offline) flush errors inflating the shared
    // generic counter, with no intervening successful online flush to reset it.
    q.retryCount = 5;

    const batch = [{ id: 'file:a', vector: [1], meta: { path: 'C:\\a.pdf' } }];
    q.queue = [...batch];

    await q._handleOfflineDatabase(batch, batch.length);

    // One offline transition = 1 of 3 — must reschedule, NOT dump to the failed
    // queue prematurely just because the generic retryCount was already high.
    expect(mockFailedHandler.trackFailedItem).not.toHaveBeenCalled();
    expect(q.queue).toHaveLength(1);
    expect(q._offlineRetryCount).toBe(1);
    // The generic counter is left untouched by the offline path.
    expect(q.retryCount).toBe(5);

    jest.useRealTimers();
  });

  test('removeByFilePath defers removal while flush is active', async () => {
    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');
    const {
      processItemsInParallel
    } = require('../src/main/analysis/embeddingQueue/parallelProcessor');

    processItemsInParallel.mockImplementationOnce(
      async ({ items, startProcessedCount, onProgress }) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const completed = startProcessedCount + items.length;
        onProgress({
          phase: 'processing',
          total: items.length,
          completed,
          percent: 100
        });
        return completed;
      }
    );

    mockContainer.resolve.mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      isOnline: true
    });

    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    q.initialized = true;
    q.queue = [{ id: 'file:C:\\a.pdf', vector: [1], meta: { path: 'C:\\a.pdf' } }];

    const flushPromise = q.flush();
    await Promise.resolve();

    const removed = q.removeByFilePath('C:\\a.pdf');
    expect(removed).toBe(1);

    await flushPromise;
    expect(q.queue).toHaveLength(0);
  });

  test('updateByFilePath updates queued + failed IDs and persists both', async () => {
    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');
    const { persistQueueData } = require('../src/main/analysis/embeddingQueue/persistence');

    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    q.initialized = true;
    q.queue = [
      { id: 'file:C:\\Old\\a.pdf', vector: [1], meta: { path: 'C:\\Old\\a.pdf', name: 'a.pdf' } }
    ];
    mockFailedHandler.failedItems.set('file:C:\\Old\\a.pdf', {
      item: {
        id: 'file:C:\\Old\\a.pdf',
        vector: [1],
        meta: { path: 'C:\\Old\\a.pdf', name: 'a.pdf' }
      },
      retryCount: 1,
      lastAttempt: Date.now(),
      error: 'x'
    });
    mockFailedHandler.persistAll = jest.fn().mockResolvedValue(undefined);

    const updated = q.updateByFilePath('C:\\Old\\a.pdf', 'C:\\New\\b.pdf');
    expect(updated).toBe(1);
    // buildPathUpdatePairs normalizes destination IDs to canonical form (forward slashes)
    expect(q.queue[0].id).toBe('file:C:/New/b.pdf');
    expect(q.queue[0].meta.path).toBe('C:\\New\\b.pdf');
    expect(q.queue[0].meta.name).toBe('b.pdf');
    expect(mockFailedHandler.failedItems.has('file:C:/New/b.pdf')).toBe(true);
    expect(mockFailedHandler.failedItems.has('file:C:\\Old\\a.pdf')).toBe(false);

    // Persistence is scheduled async; allow microtasks to run
    await flushMicrotasks();
    expect(persistQueueData).toHaveBeenCalled();
    expect(mockFailedHandler.persistAll).toHaveBeenCalled();
  });

  test('updateByFilePaths batches persistence once and updates multiple entries', async () => {
    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');
    const { persistQueueData } = require('../src/main/analysis/embeddingQueue/persistence');

    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    q.initialized = true;
    q.queue = [
      { id: 'file:C:\\Old\\a.pdf', vector: [1], meta: { path: 'C:\\Old\\a.pdf', name: 'a.pdf' } },
      { id: 'file:C:\\Old\\c.pdf', vector: [1], meta: { path: 'C:\\Old\\c.pdf', name: 'c.pdf' } }
    ];
    mockFailedHandler.failedItems.clear();
    mockFailedHandler.persistAll = jest.fn().mockResolvedValue(undefined);

    const count = q.updateByFilePaths([
      { oldPath: 'C:\\Old\\a.pdf', newPath: 'C:\\New\\a.pdf' },
      { oldPath: 'C:\\Old\\c.pdf', newPath: 'C:\\New\\c.pdf' }
    ]);

    expect(count).toBe(2);
    // buildPathUpdatePairs normalizes destination IDs to canonical form (forward slashes)
    expect(q.queue.map((i) => i.id)).toEqual(['file:C:/New/a.pdf', 'file:C:/New/c.pdf']);
    await flushMicrotasks();
    expect(persistQueueData).toHaveBeenCalledTimes(1);
    expect(mockFailedHandler.persistAll).not.toHaveBeenCalled(); // no failed items updated
  });

  test('forceFlush waits pending flush up to timeout then persists only', async () => {
    jest.useFakeTimers();
    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');
    const { persistQueueData } = require('../src/main/analysis/embeddingQueue/persistence');

    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    q.initialized = true;
    q.queue = [{ id: 'file:a', vector: [1] }];
    q.isFlushing = true;
    q._activeFlush = new Promise(() => {}); // in-flight worker, never resolves
    mockFailedHandler.persistAll = jest.fn().mockResolvedValue(undefined);

    const p = q.forceFlush();
    const assertion = expect(p).resolves.toBeUndefined();
    await flushMicrotasks();
    await advance(30050);
    await assertion;

    expect(persistQueueData).toHaveBeenCalled();
    expect(mockFailedHandler.persistAll).toHaveBeenCalled();
    jest.useRealTimers();
  });

  test('forceFlush awaits the in-flight flush worker (_activeFlush), not a stale _pendingFlush', async () => {
    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');
    const { persistQueueData } = require('../src/main/analysis/embeddingQueue/persistence');

    // Drain the entire pending microtask queue, regardless of chain depth.
    const drainMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    q.initialized = true;
    q.queue = []; // empty so forceFlush does not start a fresh post-await flush
    mockFailedHandler.persistAll = jest.fn().mockResolvedValue(undefined);

    // A genuinely in-flight worker: isFlushing set, _activeFlush still pending.
    let resolveActive;
    q.isFlushing = true;
    q._activeFlush = new Promise((resolve) => {
      resolveActive = resolve;
    });
    // A stale handle from a parked/early-returned scheduled flush that already
    // settled. The pre-fix code awaited THIS and would reach persistence early.
    q._pendingFlush = Promise.resolve();

    let settled = false;
    const p = q.forceFlush().then(() => {
      settled = true;
    });

    // Fully drain microtasks. The stale _pendingFlush is already resolved, so
    // the pre-fix code would have run persistQueue()/persistAll() and resolved
    // by now. The fix keeps forceFlush parked on the still-in-flight worker, so
    // neither persistence nor resolution has happened yet.
    await drainMicrotasks();
    expect(settled).toBe(false);
    expect(persistQueueData).not.toHaveBeenCalled();
    expect(mockFailedHandler.persistAll).not.toHaveBeenCalled();

    // Once the real worker drains, forceFlush proceeds to persistence.
    resolveActive();
    await p;
    expect(settled).toBe(true);
    expect(persistQueueData).toHaveBeenCalled();
    expect(mockFailedHandler.persistAll).toHaveBeenCalled();
  });

  test('shutdown waits for a scheduled flush that is in progress', async () => {
    jest.useFakeTimers();
    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');

    const q = new EmbeddingQueue({ flushDelayMs: 10 });
    q.initialized = true;
    q.queue = [{ id: 'file:a', vector: [1] }];

    let resolveFlush;
    const flushPromise = new Promise((resolve) => {
      resolveFlush = resolve;
    });
    const flushSpy = jest.spyOn(q, 'flush').mockImplementation(() => flushPromise);
    mockFailedHandler.persistAll = jest.fn().mockResolvedValue(undefined);

    q.scheduleFlush();
    await advance(15);
    expect(flushSpy).toHaveBeenCalled();
    expect(q._pendingFlush).toBeTruthy();

    const shutdownP = q.shutdown();
    await flushMicrotasks();
    let settled = false;
    shutdownP.finally(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);

    resolveFlush();
    await flushMicrotasks();
    await expect(shutdownP).resolves.toBeUndefined();

    jest.useRealTimers();
  });

  test('shutdown drains outstanding persistence promises and rejects further enqueues', async () => {
    jest.useFakeTimers();
    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');
    const { persistQueueData } = require('../src/main/analysis/embeddingQueue/persistence');

    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    q.initialized = true;
    mockFailedHandler.persistAll = jest.fn().mockResolvedValue(undefined);

    // create an outstanding persistence promise
    let resolveOutstanding;
    const outstanding = new Promise((r) => {
      resolveOutstanding = r;
    });
    q._outstandingPersistence.add(outstanding);

    const shutdownP = q.shutdown();
    await flushMicrotasks();

    // still waiting on outstanding promise
    let settled = false;
    shutdownP.finally(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);

    resolveOutstanding();
    await flushMicrotasks();
    await expect(shutdownP).resolves.toBeUndefined();

    expect(q._isShuttingDown).toBe(true);
    await expect(q.enqueue({ id: 'file:x', vector: [1] })).resolves.toEqual({
      success: false,
      reason: 'shutting_down'
    });

    expect(persistQueueData).toHaveBeenCalled();
    expect(mockFailedHandler.persistAll).toHaveBeenCalled();

    jest.useRealTimers();
  });

  test('flush persists just-failed items durably before the queue persist that excludes them [F-049]', async () => {
    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');
    const { persistQueueData } = require('../src/main/analysis/embeddingQueue/persistence');
    const {
      processItemsInParallel
    } = require('../src/main/analysis/embeddingQueue/parallelProcessor');

    // Record the durable-write order across both persistence sinks.
    const callOrder = [];
    persistQueueData.mockImplementationOnce(async () => {
      callOrder.push('queue');
    });
    mockFailedHandler.persistAll = jest.fn(async () => {
      callOrder.push('failed');
    });

    // One file item fails inside the parallel processor: it records the id in
    // the shared failedItemIds set and invokes onItemFailed (-> trackFailedItem),
    // exactly as the real processor does on a per-item embed failure. mockReset
    // first to drain any leftover once-impl (an earlier test can leave one queued
    // when its flush skips processItemsInParallel) so this impl is what runs.
    processItemsInParallel.mockReset();
    processItemsInParallel.mockImplementation(
      async ({ items, failedItemIds, startProcessedCount, onItemFailed, onProgress }) => {
        for (const item of items) {
          failedItemIds.add(item.id);
          onItemFailed(item, 'embed failed');
        }
        onProgress({
          phase: 'processing',
          total: items.length,
          completed: startProcessedCount,
          percent: 100
        });
        return startProcessedCount;
      }
    );

    mockContainer.resolve.mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      isOnline: true
    });

    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    q.initialized = true;
    q.queue = [{ id: 'file:C:\\fail.pdf', vector: [1], meta: { path: 'C:\\fail.pdf' } }];

    await q.flush();

    // RED before the fix: persistAll only ran when clearedFailed > 0, never on a
    // pure new-failure batch, so the failed items' sole durable record was the
    // fire-and-forget write inside trackFailedItem.
    expect(mockFailedHandler.persistAll).toHaveBeenCalled();
    // The failed-items write must be durable BEFORE the queue persist that drops
    // those items, so a crash between the two cannot lose them from both files.
    expect(callOrder).toEqual(['failed', 'queue']);
  });

  test('flush does not pay the failed-items persist when no batch item failed [F-049]', async () => {
    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');
    const {
      processItemsInParallel
    } = require('../src/main/analysis/embeddingQueue/parallelProcessor');

    mockFailedHandler.persistAll = jest.fn().mockResolvedValue(undefined);
    // Succeeds every item, populates no failedItemIds. mockReset first to drain
    // any leftover once-impl queued by an earlier test.
    processItemsInParallel.mockReset();
    processItemsInParallel.mockImplementation(
      async ({ items, startProcessedCount, onProgress }) => {
        const completed = startProcessedCount + items.length;
        onProgress({ phase: 'processing', total: items.length, completed, percent: 100 });
        return completed;
      }
    );

    mockContainer.resolve.mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      isOnline: true
    });

    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    q.initialized = true;
    q.queue = [{ id: 'file:C:\\ok.pdf', vector: [1], meta: { path: 'C:\\ok.pdf' } }];

    await q.flush();

    // No failure + no prior-failed cleanup (clearedFailed === 0) => no extra write.
    expect(mockFailedHandler.persistAll).not.toHaveBeenCalled();
    expect(q.queue).toHaveLength(0);
  });

  test('_persistPendingRemovals registers its promise in _outstandingPersistence so shutdown awaits it', async () => {
    // Regression guard: previously _persistPendingRemovals was fire-and-
    // forget — its persist promise wasn't tracked anywhere, so a shutdown
    // racing with a removal could exit while the on-disk pending-removals
    // file was still being written, re-leaking removed items into the
    // queue on next boot. The fix registers the promise into the same
    // _outstandingPersistence set the existing shutdown drain loop already
    // awaits.
    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');
    const persistenceMod = require('../src/main/analysis/embeddingQueue/persistence');

    // Make persistQueueData return a never-resolving promise so the
    // tracking-set membership is observable. Use mockImplementation on the
    // shared mock (NOT `persistenceMod.persistQueueData = jest.fn(...)`) —
    // EmbeddingQueueCore destructured the export at module load, so replacing
    // the export property would fork this test's reference away from the fn
    // the core actually calls, breaking later tests in this file.
    let resolvePersist;
    const blockedPersist = new Promise((r) => {
      resolvePersist = r;
    });
    persistenceMod.persistQueueData.mockImplementation(() => blockedPersist);

    try {
      const q = new EmbeddingQueue({ flushDelayMs: 0 });
      q._pendingRemovals = new Set(['file:a', 'file:b']);

      const sizeBefore = q._outstandingPersistence.size;
      q._persistPendingRemovals();

      // Right after invocation, the persist promise must be in the tracking set.
      expect(q._outstandingPersistence.size).toBe(sizeBefore + 1);

      // Once the persist resolves, the promise auto-deregisters via its .finally
      // hook so the set doesn't grow without bound across many removals.
      resolvePersist();
      await flushMicrotasks();
      await flushMicrotasks();
      expect(q._outstandingPersistence.size).toBe(sizeBefore);
    } finally {
      persistenceMod.persistQueueData.mockImplementation(async () => undefined);
    }
  });

  test('enqueue does not stack concurrent flushes once the queue reaches BATCH_SIZE', async () => {
    jest.useFakeTimers();
    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');

    const q = new EmbeddingQueue({ flushDelayMs: 10, batchSize: 1 });
    q.MAX_QUEUE_SIZE = 100; // avoid the mocked LIMITS.MAX_QUEUE_SIZE=2 overflow path

    let releaseFlush;
    const flushGate = new Promise((resolve) => {
      releaseFlush = resolve;
    });
    const flushSpy = jest.spyOn(q, 'flush').mockImplementation(() => flushGate);

    await q.enqueue({ id: 'file:1', vector: [1] });
    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(q._pendingFlush).toBeTruthy();

    // While the first flush is still in flight, further batch-size enqueues
    // must NOT kick additional flush() calls (pre-fix: one per enqueue, each
    // parking up to TIMEOUTS.MUTEX_ACQUIRE on the mutex).
    await q.enqueue({ id: 'file:2', vector: [1] });
    await q.enqueue({ id: 'file:3', vector: [1] });
    expect(flushSpy).toHaveBeenCalledTimes(1);
    // The gated enqueues fall back to the delayed-flush timer instead, so the
    // remaining items are never stranded.
    expect(q.flushTimer).toBeTruthy();

    releaseFlush();
    await flushMicrotasks();
    expect(q._pendingFlush).toBeNull();

    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('enqueue-triggered flush honors a pending error-backoff window', async () => {
    jest.useFakeTimers();
    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');

    const q = new EmbeddingQueue({ flushDelayMs: 10, batchSize: 1 });
    q.MAX_QUEUE_SIZE = 100;
    const flushSpy = jest.spyOn(q, 'flush').mockResolvedValue(undefined);

    // A previous flush failure scheduled an exponential-backoff retry.
    q._scheduleRetry(5000);

    await q.enqueue({ id: 'file:1', vector: [1] });
    // Pre-fix: enqueue fired flush() immediately, defeating the backoff.
    expect(flushSpy).not.toHaveBeenCalled();

    // Once the backoff window elapses, the retry path performs the flush.
    await advance(5000); // retry timer -> scheduleFlush()
    await advance(10); // flush delay
    expect(flushSpy).toHaveBeenCalledTimes(1);

    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('failed initialize() blocks destructive persists so on-disk data is not clobbered', async () => {
    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');
    const {
      loadPersistedData,
      persistQueueData
    } = require('../src/main/analysis/embeddingQueue/persistence');

    // Disk read fails: the persisted queue never makes it into memory.
    loadPersistedData.mockRejectedValueOnce(new Error('EIO: read failed'));

    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    await q.initialize();

    // Still marks initialized (no permanent init deadlock)...
    expect(q.initialized).toBe(true);
    // ...but the persist latch is set.
    expect(q._persistBlocked).toBe(true);

    // Pre-fix: this overwrote the persisted queue key with an empty array,
    // silently losing every pending embedding recorded on disk.
    await q.persistQueue();
    expect(persistQueueData).not.toHaveBeenCalled();

    // The pending-removals persist is latched too.
    q._pendingRemovals = new Set(['file:x']);
    q._persistPendingRemovals();
    expect(persistQueueData).not.toHaveBeenCalled();
  });

  test('successful initialize() leaves persists enabled', async () => {
    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');
    const { persistQueueData } = require('../src/main/analysis/embeddingQueue/persistence');

    const q = new EmbeddingQueue({ flushDelayMs: 0 });
    await q.initialize();

    expect(q._persistBlocked).toBe(false);
    await q.persistQueue();
    expect(persistQueueData).toHaveBeenCalledTimes(1);
  });

  test('enqueue initializes BEFORE invalid-vector tracking so trackFailedItem cannot run against unloaded state', async () => {
    const EmbeddingQueue = require('../src/main/analysis/embeddingQueue/EmbeddingQueueCore');
    const { loadPersistedData } = require('../src/main/analysis/embeddingQueue/persistence');

    const order = [];
    loadPersistedData.mockImplementation(async () => {
      order.push('load');
    });
    mockFailedHandler.trackFailedItem.mockImplementation(() => {
      order.push('track');
    });

    try {
      const q = new EmbeddingQueue({ flushDelayMs: 0 });

      // Pre-fix: trackFailedItem ran before initialize(), and its fire-and-
      // forget persist could replace the whole persisted failedItems key with
      // a one-entry map before the on-disk map had been loaded.
      const res = await q.enqueue({ id: 'file:bad', vector: [] });
      expect(res).toEqual({ success: false, reason: 'invalid_vector_format' });

      expect(order).toContain('track');
      expect(order).toContain('load');
      expect(order.indexOf('track')).toBeGreaterThan(order.lastIndexOf('load'));
      expect(q.initialized).toBe(true);
    } finally {
      // Restore implementations for subsequent tests (clearAllMocks in
      // beforeEach clears calls, not implementations).
      loadPersistedData.mockImplementation(async () => undefined);
      mockFailedHandler.trackFailedItem.mockImplementation(() => undefined);
    }
  });
});
