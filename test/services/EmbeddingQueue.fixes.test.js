/**
 * @jest-environment node
 *
 * EmbeddingQueueCore is a main-process service. The node environment gives real
 * Node `Timeout` objects (with `unref`/`hasRef`), faithfully reproducing the
 * production timer type that the unref parity fix (F-061) depends on — jsdom's
 * numeric timer handles silently no-op the guard.
 */
const EmbeddingQueue = require('../../src/main/analysis/embeddingQueue/EmbeddingQueueCore');
const { createLogger } = require('../../src/shared/logger');
const { container, ServiceIds } = require('../../src/main/services/ServiceContainer');
const { persistQueueData } = require('../../src/main/analysis/embeddingQueue/persistence');

// Mock dependencies
jest.mock('electron', () => ({
  app: {
    getPath: jest.fn().mockReturnValue('/tmp/userData')
  }
}));

jest.mock('../../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('../../src/main/services/ServiceContainer', () => ({
  container: {
    resolve: jest.fn(),
    tryResolve: jest.fn()
  },
  ServiceIds: {
    ORAMA_VECTOR: 'ORAMA_VECTOR'
  }
}));

jest.mock('../../src/main/analysis/embeddingQueue/persistence', () => ({
  loadPersistedData: jest.fn(),
  persistQueueData: jest.fn().mockResolvedValue(true),
  persistFailedItems: jest.fn().mockResolvedValue(true),
  persistDeadLetterQueue: jest.fn().mockResolvedValue(true)
}));

describe('EmbeddingQueueCore Fixes', () => {
  let queue;
  let mockVectorDb;

  // The queue is constructed with real timers (flushDelayMs: 50). A test that
  // enqueues a valid item arms scheduleFlush()'s setTimeout; without explicit
  // cleanup the live handle leaks into jest's worker and can surface as the
  // "worker exits 1 right after a clean pass" flake (feedback_windows_ci_jest_flake).
  const clearQueueTimers = () => {
    if (queue.flushTimer) clearTimeout(queue.flushTimer);
    if (queue._persistDebounceTimer) clearTimeout(queue._persistDebounceTimer);
    for (const t of queue._retryTimers) clearTimeout(t);
    queue._retryTimers.clear();
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockVectorDb = {
      initialize: jest.fn().mockResolvedValue(true),
      isOnline: true,
      batchUpsertFiles: jest.fn().mockResolvedValue({ success: true, count: 1 }),
      upsertFile: jest.fn().mockResolvedValue({ success: true }),
      batchUpsertFolders: jest.fn().mockResolvedValue({ success: true, count: 1 })
    };
    container.resolve.mockReturnValue(mockVectorDb);

    queue = new EmbeddingQueue({
      batchSize: 5,
      flushDelayMs: 50
    });
  });

  afterEach(() => {
    clearQueueTimers();
  });

  test('should validate vector format on enqueue', async () => {
    const invalidItem = {
      id: 'file:test.txt',
      vector: [] // Empty vector
    };

    const result = await queue.enqueue(invalidItem);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('invalid_vector_format');
    expect(queue.queue.length).toBe(0);
  });

  test('should sanitize minor NaN corruption and reject major corruption', async () => {
    // Minor corruption: 1 NaN in 384 dims (~0.26%) — sanitized to 0
    const minorCorrupt = new Array(384).fill(0.5);
    minorCorrupt[50] = NaN;
    const result = await queue.enqueue({ id: 'file:minor.txt', vector: minorCorrupt });
    expect(result.success).toBe(true);
    expect(result.warnings).toContain('vector_sanitized');
    expect(queue.queue[0].vector[50]).toBe(0);

    // Major corruption: 1 NaN in 3 dims (33%) — rejected
    const majorResult = await queue.enqueue({ id: 'file:major.txt', vector: [0.1, NaN, 0.3] });
    expect(majorResult.success).toBe(false);
    expect(majorResult.reason).toBe('invalid_vector_values');
  });

  test('should handle offline database gracefully', async () => {
    mockVectorDb.isOnline = false;

    await queue.enqueue({ id: 'file:1', vector: [0.1] });

    // Trigger flush manually
    await queue.flush();

    // Should still be in queue (or moved to failed/retry depending on implementation details)
    // The implementation moves to retry logic which keeps it in queue or failed items.
    // Offline retries use a dedicated counter (separate from the generic
    // flush-error retryCount) so generic errors can't drain the offline budget.
    expect(queue._offlineRetryCount).toBeGreaterThan(0);
  });

  test('should respect flush lock', async () => {
    let resolveMutex;
    queue._flushMutex = new Promise((r) => (resolveMutex = r));
    queue.isFlushing = true;

    const flushPromise = queue.flush();

    // It should be pending
    const isPending = await Promise.race([
      flushPromise.then(() => false),
      new Promise((r) => setTimeout(() => r(true), 50))
    ]);
    expect(isPending).toBe(true);

    // Resolve mutex
    resolveMutex();
    // Logic in flush() will eventually proceed
    // We need to ensure mocks don't crash it.
    await expect(flushPromise).resolves.not.toThrow();
  });

  test('should remove items by file path', async () => {
    await queue.enqueue({
      id: 'file:/path/to/file.txt',
      vector: [0.1],
      meta: { path: '/path/to/file.txt' }
    });
    await queue.enqueue({
      id: 'file:/path/to/other.txt',
      vector: [0.2],
      meta: { path: '/path/to/other.txt' }
    });

    expect(queue.queue.length).toBe(2);

    const removed = queue.removeByFilePath('/path/to/file.txt');

    expect(removed).toBe(1);
    expect(queue.queue.length).toBe(1);
    expect(queue.queue[0].id).toBe('file:/path/to/other.txt');
  });

  test('scheduleFlush arms an unref-ed flush timer so it cannot pin the event loop', () => {
    // Regression (F-061): scheduleFlush's setTimeout was the lone queue timer
    // that was never unref'd, unlike _persistDebounceTimer and _scheduleRetry.
    // In a short-lived process (jest worker) a still-armed 50ms ref'd handle is
    // exactly the open handle behind the "worker exits 1 after a clean pass" flake.
    queue.scheduleFlush();
    expect(queue.flushTimer).toBeTruthy();
    expect(queue.flushTimer.hasRef()).toBe(false);
  });

  test('persist failure does not resurrect an id removed during the flush', async () => {
    // Regression (P0-3): on a persist failure the catch path used to unshift
    // the entire stale batch back onto the queue. If the user requested removal
    // of an id during the flush, that delete was silently undone — the deleted
    // item reappeared in the vector store on the next flush.
    await queue.enqueue({ id: 'file:a', vector: [0.1] });
    await queue.enqueue({ id: 'file:b', vector: [0.2] });

    // User asks to remove A mid-flush.
    queue._pendingRemovals = new Set(['file:a']);
    // Fail only the main flush persist (marked throwOnError), not the
    // pending-removals persist that fires earlier in the same flush.
    persistQueueData.mockImplementation(async (_path, _data, opts) => {
      if (opts && opts.throwOnError) throw new Error('ENOSPC: disk full');
      return true;
    });

    await queue.flush();

    expect(queue.queue.some((item) => item.id === 'file:a')).toBe(false);
    // B was never removed, so re-adding it on failure is correct (no data loss).
    expect(queue.queue.some((item) => item.id === 'file:b')).toBe(true);
  });

  test('persist failure does not duplicate an id a concurrent enqueue re-added', async () => {
    // Regression (P0-3): a concurrent enqueue during the persist await can
    // re-add the same id with fresh data. Blindly unshifting the stale batch
    // then leaves two items sharing one id, both of which flush next round.
    await queue.enqueue({ id: 'file:a', vector: [0.1] });

    persistQueueData.mockImplementation(async (_path, _data, opts) => {
      if (opts && opts.throwOnError) {
        // A fresh re-enqueue lands while the (failing) disk write is in flight.
        queue.queue.push({ id: 'file:a', vector: [0.9], meta: { fresh: true } });
        throw new Error('EIO: write failed');
      }
      return true;
    });

    await queue.flush();

    const matches = queue.queue.filter((item) => item.id === 'file:a');
    expect(matches).toHaveLength(1);
    // The surviving entry must be the fresh re-enqueue, not the stale batch copy.
    expect(matches[0].vector[0]).toBe(0.9);
  });
});
