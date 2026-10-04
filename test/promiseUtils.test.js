/**
 * Tests for Promise Utilities
 * Tests delay, timeout, retry, debounce, throttle, and batch processing
 */

// Mock logger
jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

const {
  delay,
  sleep,
  withTimeout,
  withRetry,
  retry,
  debounce,
  throttle,
  batchProcess,
  mapWithConcurrency,
  throwIfAborted,
  swallow
} = require('../src/shared/promiseUtils');

describe('promiseUtils', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('delay', () => {
    test('resolves after specified time', async () => {
      const promise = delay(1000);

      jest.advanceTimersByTime(1000);

      await expect(promise).resolves.toBeUndefined();
    });

    test('sleep is alias for delay', () => {
      expect(sleep).toBe(delay);
    });
  });

  describe('withTimeout', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    test('resolves when promise completes before timeout', async () => {
      const promise = Promise.resolve('success');

      const result = await withTimeout(promise, 1000, 'Test');

      expect(result).toBe('success');
    });

    test('rejects when promise exceeds timeout', async () => {
      const slowPromise = new Promise((resolve) => setTimeout(resolve, 2000));

      await expect(withTimeout(slowPromise, 100, 'SlowOp')).rejects.toThrow(
        'SlowOp timed out after 100ms'
      );
    });

    test('wraps function with timeout', async () => {
      const fastFn = jest.fn().mockResolvedValue('fast result');
      const wrappedFn = withTimeout(fastFn, 1000, 'FastFn');

      const result = await wrappedFn('arg1');

      expect(result).toBe('fast result');
      expect(fastFn).toHaveBeenCalledWith('arg1');
    });

    test('wrapped function rejects on timeout', async () => {
      const slowFn = () => new Promise((resolve) => setTimeout(resolve, 2000));
      const wrappedFn = withTimeout(slowFn, 100, 'SlowFn');

      await expect(wrappedFn()).rejects.toThrow('SlowFn timed out after 100ms');
    });

    test('does not emit unhandledRejection when the original promise rejects after timeout', async () => {
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      let rejectLate;
      const hanging = new Promise((_, reject) => {
        rejectLate = reject;
      });

      await expect(withTimeout(hanging, 20, 'LateOp')).rejects.toThrow(
        'LateOp timed out after 20ms'
      );
      rejectLate(new Error('late boom'));
      await delay(20);
      process.removeListener('unhandledRejection', unhandled);
      expect(unhandled).not.toHaveBeenCalled();
    });
  });

  describe('withRetry', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    test('returns result on first success', async () => {
      const fn = jest.fn().mockResolvedValue('success');
      const retryFn = withRetry(fn, { maxRetries: 3, initialDelay: 10 });

      const result = await retryFn();

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('retries on failure', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockResolvedValue('success');

      const retryFn = withRetry(fn, { maxRetries: 3, initialDelay: 10 });

      const result = await retryFn();

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });

    test('throws after max retries', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('always fails'));
      const retryFn = withRetry(fn, { maxRetries: 2, initialDelay: 10 });

      await expect(retryFn()).rejects.toThrow('always fails');
      expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    test('respects shouldRetry callback', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('AUTH_FAILED'));
      const retryFn = withRetry(fn, {
        maxRetries: 3,
        initialDelay: 10,
        shouldRetry: (error) => !error.message.includes('AUTH')
      });

      await expect(retryFn()).rejects.toThrow('AUTH_FAILED');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('calls onRetry callback', async () => {
      const fn = jest.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValue('success');
      const onRetry = jest.fn();

      const retryFn = withRetry(fn, {
        maxRetries: 3,
        initialDelay: 10,
        onRetry
      });

      await retryFn();

      expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 0);
    });

    test('supports alias parameter names', async () => {
      const fn = jest.fn().mockResolvedValue('success');
      const retryFn = withRetry(fn, {
        maxAttempts: 2,
        delay: 10,
        backoffFactor: 1.5
      });

      await retryFn();

      expect(fn).toHaveBeenCalled();
    });

    test('passes arguments to wrapped function', async () => {
      const fn = jest.fn().mockResolvedValue('result');
      const retryFn = withRetry(fn, { maxRetries: 1, initialDelay: 10 });

      await retryFn('arg1', 'arg2', { key: 'value' });

      expect(fn).toHaveBeenCalledWith('arg1', 'arg2', { key: 'value' });
    });
  });

  describe('retry', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    test('immediately invokes operation with retry logic', async () => {
      const operation = jest.fn().mockResolvedValue('result');

      const result = await retry(operation, {
        maxRetries: 3,
        initialDelay: 10
      });

      expect(result).toBe('result');
      expect(operation).toHaveBeenCalledTimes(1);
    });
  });

  describe('debounce', () => {
    test('delays function execution', () => {
      const fn = jest.fn();
      const debounced = debounce(fn, 100);

      debounced();
      debounced();
      debounced();

      expect(fn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(100);

      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('cancel prevents execution', () => {
      const fn = jest.fn();
      const debounced = debounce(fn, 100);

      debounced();
      debounced.cancel();

      jest.advanceTimersByTime(100);

      expect(fn).not.toHaveBeenCalled();
    });

    test('flush executes immediately', () => {
      const fn = jest.fn().mockReturnValue('result');
      const debounced = debounce(fn, 100);

      debounced();
      const result = debounced.flush();

      expect(fn).toHaveBeenCalledTimes(1);
      expect(result).toBe('result');
    });

    test('leading option executes immediately', () => {
      const fn = jest.fn();
      const debounced = debounce(fn, 100, { leading: true, trailing: false });

      debounced();

      expect(fn).toHaveBeenCalledTimes(1);

      debounced();
      debounced();

      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('passes last arguments', () => {
      const fn = jest.fn();
      const debounced = debounce(fn, 100);

      debounced('first');
      debounced('second');
      debounced('third');

      jest.advanceTimersByTime(100);

      expect(fn).toHaveBeenCalledWith('third');
    });
  });

  describe('throttle', () => {
    test('limits function execution rate', () => {
      const fn = jest.fn();
      const throttled = throttle(fn, 100);

      throttled();
      expect(fn).toHaveBeenCalledTimes(1);

      throttled();
      throttled();
      expect(fn).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(100);

      expect(fn).toHaveBeenCalledTimes(2);
    });

    test('cancel prevents trailing execution', () => {
      const fn = jest.fn();
      const throttled = throttle(fn, 100);

      throttled();
      throttled();
      throttled.cancel();

      jest.advanceTimersByTime(100);

      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('batchProcess', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    test('processes items in batches', async () => {
      const items = [1, 2, 3, 4, 5];
      const fn = jest.fn().mockResolvedValue('processed');

      const results = await batchProcess(items, fn, 2);

      expect(results).toHaveLength(5);
      expect(fn).toHaveBeenCalledTimes(5);
    });

    test('maintains order of results', async () => {
      const items = ['a', 'b', 'c'];
      const fn = jest.fn().mockImplementation((item) => Promise.resolve(item.toUpperCase()));

      const results = await batchProcess(items, fn, 2);

      expect(results).toEqual(['A', 'B', 'C']);
    });

    test('handles errors gracefully', async () => {
      const items = [1, 2, 3];
      const fn = jest
        .fn()
        .mockResolvedValueOnce('success1')
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce('success3');

      const results = await batchProcess(items, fn, 3);

      expect(results[0]).toBe('success1');
      expect(results[1]).toBeNull();
      expect(results[2]).toBe('success3');
    });

    test('uses default batch size of 5', async () => {
      const items = Array(10).fill(0);
      const fn = jest.fn().mockResolvedValue('done');

      await batchProcess(items, fn);

      expect(fn).toHaveBeenCalledTimes(10);
    });

    test('passes index to callback', async () => {
      const items = ['a', 'b', 'c'];
      const fn = jest.fn().mockResolvedValue('result');

      await batchProcess(items, fn, 10);

      expect(fn).toHaveBeenCalledWith('a', 0);
      expect(fn).toHaveBeenCalledWith('b', 1);
      expect(fn).toHaveBeenCalledWith('c', 2);
    });
  });

  describe('mapWithConcurrency', () => {
    beforeEach(() => {
      jest.useRealTimers();
    });

    const deferred = () => {
      let resolve, reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };

    test('returns [] for empty or non-array input', async () => {
      expect(await mapWithConcurrency([], 4, jest.fn())).toEqual([]);
      expect(await mapWithConcurrency(null, 4, jest.fn())).toEqual([]);
    });

    test('preserves input order in results regardless of completion order', async () => {
      const gates = [deferred(), deferred(), deferred()];
      const promise = mapWithConcurrency([0, 1, 2], 3, async (item) => {
        await gates[item].promise;
        return `r${item}`;
      });
      // Resolve out of order: 2, 0, 1
      gates[2].resolve();
      gates[0].resolve();
      gates[1].resolve();
      expect(await promise).toEqual(['r0', 'r1', 'r2']);
    });

    test('never exceeds the concurrency bound and actually runs in parallel', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const gate = deferred();
      const items = [1, 2, 3, 4, 5, 6];

      const promise = mapWithConcurrency(items, 2, async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate.promise;
        inFlight -= 1;
      });

      // Give the workers a microtask turn to start.
      await Promise.resolve();
      expect(inFlight).toBe(2);
      gate.resolve();
      await promise;
      expect(maxInFlight).toBe(2);
    });

    test('propagates iteratee errors instead of silently dropping them', async () => {
      await expect(
        mapWithConcurrency([1, 2, 3], 2, async (item) => {
          if (item === 2) throw new Error('boom');
          return item;
        })
      ).rejects.toThrow('boom');
    });

    test('passes item and index to the iteratee', async () => {
      const fn = jest.fn().mockResolvedValue('x');
      await mapWithConcurrency(['a', 'b'], 8, fn);
      expect(fn).toHaveBeenCalledWith('a', 0);
      expect(fn).toHaveBeenCalledWith('b', 1);
    });

    test('clamps concurrency to at least 1 and at most items.length', async () => {
      const results = await mapWithConcurrency([1, 2], 0, async (n) => n * 2);
      expect(results).toEqual([2, 4]);
    });

    test('settle:true does not reject when a worker iteratee throws', async () => {
      const results = await mapWithConcurrency(
        [1, 2, 3],
        2,
        async (item) => {
          if (item === 2) throw new Error('boom');
          return item;
        },
        { settle: true }
      );
      expect(results[0]).toBe(1);
      expect(results[2]).toBe(3);
    });
  });

  describe('throwIfAborted', () => {
    test('throws AbortError when the signal is aborted', () => {
      const controller = new AbortController();
      controller.abort();
      expect(() => throwIfAborted(controller.signal)).toThrow('Aborted');
      try {
        throwIfAborted(controller.signal);
      } catch (err) {
        expect(err.name).toBe('AbortError');
      }
    });

    test('is a no-op when the signal is live', () => {
      expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
    });
  });

  describe('swallow', () => {
    beforeEach(() => {
      // swallow is async — use real timers so the catch path resolves
      jest.useRealTimers();
    });

    test('resolves to undefined on success', async () => {
      const result = await swallow(Promise.resolve('ignored'));
      expect(result).toBeUndefined();
    });

    test('resolves to undefined on rejection', async () => {
      const result = await swallow(Promise.reject(new Error('boom')));
      expect(result).toBeUndefined();
    });

    test('logs rejection at default debug level with context and error details', async () => {
      const log = { debug: jest.fn(), warn: jest.fn() };
      const err = new Error('disk full');
      err.code = 'ENOSPC';

      await swallow(Promise.reject(err), log, 'cleanup:tmp');

      expect(log.debug).toHaveBeenCalledTimes(1);
      expect(log.debug).toHaveBeenCalledWith('[swallow] cleanup:tmp', {
        error: 'disk full',
        code: 'ENOSPC'
      });
      expect(log.warn).not.toHaveBeenCalled();
    });

    test('logs at warn when explicitly requested', async () => {
      const log = { debug: jest.fn(), warn: jest.fn() };

      await swallow(Promise.reject(new Error('failed')), log, 'journal:rollback', 'warn');

      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith('[swallow] journal:rollback', {
        error: 'failed',
        code: undefined
      });
      expect(log.debug).not.toHaveBeenCalled();
    });

    test('does not log on success', async () => {
      const log = { debug: jest.fn(), warn: jest.fn() };

      await swallow(Promise.resolve('ok'), log, 'ctx');

      expect(log.debug).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    });

    test('tolerates missing logger (no throw)', async () => {
      await expect(swallow(Promise.reject(new Error('x')))).resolves.toBeUndefined();
    });

    test('tolerates logger missing the requested level method (no throw)', async () => {
      const log = { debug: undefined };

      await expect(
        swallow(Promise.reject(new Error('x')), log, 'ctx', 'debug')
      ).resolves.toBeUndefined();
    });

    test('does not catch errors thrown by the logger itself', async () => {
      const log = {
        debug: () => {
          throw new Error('logger broken');
        }
      };

      await expect(swallow(Promise.reject(new Error('orig')), log, 'ctx')).rejects.toThrow(
        'logger broken'
      );
    });
  });
});
