describe('batchLockManager', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('acquire and release lock', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const {
      acquireBatchLock,
      releaseBatchLock
    } = require('../src/main/ipc/files/batchLockManager');

    const acquired = await acquireBatchLock('batch-1', 1000);
    expect(acquired).toBe(true);

    const waiterPromise = acquireBatchLock('batch-2', 1000);
    releaseBatchLock('batch-1');
    jest.runOnlyPendingTimers();
    const waiter = await waiterPromise;
    expect(waiter).toBe(true);
    releaseBatchLock('batch-2');
    jest.useRealTimers();
  });

  test('release by non-holder batch does not unlock', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const {
      acquireBatchLock,
      releaseBatchLock
    } = require('../src/main/ipc/files/batchLockManager');

    const acquired = await acquireBatchLock('batch-holder', 1000);
    expect(acquired).toBe(true);

    const waiterPromise = acquireBatchLock('batch-waiter', 1000);
    releaseBatchLock('wrong-batch-id');

    // Waiter should still be blocked until actual holder releases.
    jest.advanceTimersByTime(50);
    let settled = false;
    waiterPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseBatchLock('batch-holder');
    jest.runOnlyPendingTimers();
    await expect(waiterPromise).resolves.toBe(true);
    releaseBatchLock('batch-waiter');
    jest.useRealTimers();
  });

  test('force-releases stale lock when held past timeout', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const {
      acquireBatchLock,
      releaseBatchLock,
      BATCH_LOCK_TIMEOUT
    } = require('../src/main/ipc/files/batchLockManager');

    await acquireBatchLock('stale-batch', 10000);
    jest.advanceTimersByTime(BATCH_LOCK_TIMEOUT + 1);

    // New batch should acquire immediately (stale was force-released)
    const acquired = await acquireBatchLock('new-batch', 1000);
    expect(acquired).toBe(true);
    releaseBatchLock('new-batch');
    jest.useRealTimers();
  });

  // A batch that trips MAX_TOTAL_BATCH_TIME still has a rollback tail to run
  // (in-flight move + restoring every completed op). The old 5-minute TTL
  // equalled that limit, so the lock was force-released exactly when the
  // rollback started and a second batch could overlap it.
  describe('lease covers the rollback tail and can be renewed', () => {
    /** Resolve only if the promise settles within the flushed microtasks. */
    async function settledValue(promise) {
      let value = { settled: false };
      promise.then((v) => {
        value = { settled: true, result: v };
      });
      await Promise.resolve();
      await Promise.resolve();
      return value;
    }

    // acquireBatchLock retries with backoff (max 10s) between attempts, so a
    // contender may be sleeping rather than queued as a waiter when the
    // holder releases — advance far enough for its next attempt to run.
    const RETRY_WINDOW_MS = 10_000;

    test('lock is still held when MAX_TOTAL_BATCH_TIME has elapsed', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(0);
      const {
        acquireBatchLock,
        releaseBatchLock
      } = require('../src/main/ipc/files/batchLockManager');
      const { PROCESSING_LIMITS } = require('../src/shared/constants');

      await acquireBatchLock('a', 1000);
      await jest.advanceTimersByTimeAsync(PROCESSING_LIMITS.MAX_TOTAL_BATCH_TIME + 1);

      const contender = acquireBatchLock('b', 1000);
      await jest.advanceTimersByTimeAsync(1000);
      expect(await settledValue(contender)).toEqual({ settled: false });

      // Acquisition on release proves 'a' — not a stale force-release — was the holder.
      releaseBatchLock('a');
      await jest.advanceTimersByTimeAsync(RETRY_WINDOW_MS);
      await expect(contender).resolves.toBe(true);
      releaseBatchLock('b');
      jest.useRealTimers();
    });

    test('renewBatchLock by the holder extends the lease past the TTL', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(0);
      const {
        acquireBatchLock,
        renewBatchLock,
        releaseBatchLock,
        BATCH_LOCK_TIMEOUT
      } = require('../src/main/ipc/files/batchLockManager');

      await acquireBatchLock('a', 1000);
      await jest.advanceTimersByTimeAsync(BATCH_LOCK_TIMEOUT - 1000);
      expect(renewBatchLock('a')).toBe(true);
      await jest.advanceTimersByTimeAsync(BATCH_LOCK_TIMEOUT - 1000);

      // Well past the original TTL, but within the renewed lease: still held.
      const contender = acquireBatchLock('b', 1000);
      await jest.advanceTimersByTimeAsync(1000);
      expect(await settledValue(contender)).toEqual({ settled: false });

      releaseBatchLock('a');
      await jest.advanceTimersByTimeAsync(RETRY_WINDOW_MS);
      await expect(contender).resolves.toBe(true);
      releaseBatchLock('b');
      jest.useRealTimers();
    });

    test('renewBatchLock by a non-holder is ignored', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(0);
      const {
        acquireBatchLock,
        renewBatchLock,
        releaseBatchLock,
        BATCH_LOCK_TIMEOUT
      } = require('../src/main/ipc/files/batchLockManager');

      await acquireBatchLock('a', 1000);
      await jest.advanceTimersByTimeAsync(BATCH_LOCK_TIMEOUT - 1000);
      expect(renewBatchLock('not-the-holder')).toBe(false);
      await jest.advanceTimersByTimeAsync(1001);

      // No effective renewal: the lease expired and 'b' takes over.
      await expect(acquireBatchLock('b', 1000)).resolves.toBe(true);
      releaseBatchLock('b');
      jest.useRealTimers();
    });

    test('without renewal the lock is force-released once the TTL passes', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(0);
      const {
        acquireBatchLock,
        releaseBatchLock,
        BATCH_LOCK_TIMEOUT
      } = require('../src/main/ipc/files/batchLockManager');

      await acquireBatchLock('a', 1000);
      await jest.advanceTimersByTimeAsync(BATCH_LOCK_TIMEOUT + 1);

      await expect(acquireBatchLock('b', 1000)).resolves.toBe(true);
      releaseBatchLock('b');
      jest.useRealTimers();
    });
  });

  test('acquireBatchLock retries until acquired', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const {
      acquireBatchLock,
      releaseBatchLock
    } = require('../src/main/ipc/files/batchLockManager');

    await acquireBatchLock('holder', 100);
    const waiterPromise = acquireBatchLock('waiter', 100);
    // Advance past first attempt timeout
    jest.advanceTimersByTime(150);
    releaseBatchLock('holder');
    jest.runOnlyPendingTimers();
    const result = await waiterPromise;
    expect(result).toBe(true);
    releaseBatchLock('waiter');
    jest.useRealTimers();
  });
});
