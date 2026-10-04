/**
 * Timeout and Rate Limit Tests
 *
 * Exercises the shared implementations in src/shared (promiseUtils,
 * RateLimiter) rather than inline copies of debounce/throttle/backoff.
 */

jest.mock('../../src/shared/logger', () => {
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
  debounce,
  throttle,
  withTimeout,
  calculateRetryDelay
} = require('../../src/shared/promiseUtils');
const { SlidingWindowRateLimiter, Semaphore } = require('../../src/shared/RateLimiter');

describe('Timeout and Rate Limit Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ legacyFakeTimers: false });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Debounce Behavior', () => {
    it('should only execute after debounce period', () => {
      const fn = jest.fn();
      const debounced = debounce(fn, 500);

      debounced('call1');
      debounced('call2');
      debounced('call3');

      expect(fn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(499);
      expect(fn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(2);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('call3');
    });

    it('should reset timer on each call', () => {
      const fn = jest.fn();
      const debounced = debounce(fn, 500);

      debounced('first');
      jest.advanceTimersByTime(250);
      debounced('second');
      jest.advanceTimersByTime(250);
      expect(fn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(250);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('second');
    });

    it('should invoke once with the last arguments after a burst', () => {
      const fn = jest.fn();
      const debounced = debounce(fn, 500);

      for (let i = 0; i < 10; i++) {
        debounced(i);
      }

      expect(fn).not.toHaveBeenCalled();

      jest.advanceTimersByTime(500);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(9);
    });

    it('should support cancellation', () => {
      const fn = jest.fn();
      const debounced = debounce(fn, 500);

      debounced('test');
      debounced.cancel();
      jest.advanceTimersByTime(1000);

      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('Throttle Behavior', () => {
    it('should allow first call immediately', () => {
      const fn = jest.fn();
      const throttled = throttle(fn, 1000);

      throttled('first');

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('first');
    });

    it('should throttle rapid subsequent calls', () => {
      const fn = jest.fn();
      const throttled = throttle(fn, 1000);

      throttled('call1');
      throttled('call2');
      throttled('call3');

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith('call1');
    });

    it('should allow calls after throttle period', () => {
      const fn = jest.fn();
      const throttled = throttle(fn, 1000);

      throttled('first');
      expect(fn).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(1001);

      throttled('second');
      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenLastCalledWith('second');
    });

    it('should execute trailing call after throttle period', () => {
      const fn = jest.fn();
      const throttled = throttle(fn, 1000);

      throttled('immediate');
      throttled('pending');

      expect(fn).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(1000);

      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenLastCalledWith('pending');
    });
  });

  describe('Timeout Handling', () => {
    it('should resolve if operation completes before timeout', async () => {
      const operation = new Promise((resolve) => {
        setTimeout(() => resolve('success'), 500);
      });

      const promise = withTimeout(operation, 1000, 'timed-op');

      await jest.advanceTimersByTimeAsync(500);

      await expect(promise).resolves.toBe('success');
    });

    it('should reject if operation exceeds timeout', async () => {
      const operation = new Promise((resolve) => {
        setTimeout(() => resolve('success'), 2000);
      });

      const promise = withTimeout(operation, 1000, 'Custom timeout');
      const assertion = expect(promise).rejects.toThrow('Custom timeout timed out after 1000ms');

      await jest.advanceTimersByTimeAsync(1000);
      await assertion;
    });

    it('should handle multiple concurrent operations with different timeouts', async () => {
      const op1 = withTimeout(
        new Promise((resolve) => setTimeout(() => resolve('op1'), 500)),
        1000,
        'op1'
      );
      const op2 = withTimeout(
        new Promise((resolve) => setTimeout(() => resolve('op2'), 1500)),
        1000,
        'op2'
      );
      const op3 = withTimeout(
        new Promise((resolve) => setTimeout(() => resolve('op3'), 300)),
        1000,
        'op3'
      );
      const op2Assertion = expect(op2).rejects.toThrow('op2 timed out after 1000ms');

      await jest.advanceTimersByTimeAsync(600);

      const results = [await op3, await op1];

      await jest.advanceTimersByTimeAsync(400);

      await op2Assertion;
      expect(results).toEqual(['op3', 'op1']);
    });
  });

  describe('Rate Limiting Under Load', () => {
    it('should allow requests within rate limit', () => {
      const limiter = new SlidingWindowRateLimiter(10, 1000);

      for (let i = 0; i < 10; i++) {
        expect(limiter.canCall()).toBe(true);
        limiter.recordCall();
      }

      expect(limiter.canCall()).toBe(false);
    });

    it('should refill slots over time', () => {
      const limiter = new SlidingWindowRateLimiter(10, 1000);

      for (let i = 0; i < 10; i++) {
        limiter.recordCall();
      }
      expect(limiter.canCall()).toBe(false);

      jest.advanceTimersByTime(1000);

      expect(limiter.canCall()).toBe(true);
    });

    it('should handle burst traffic up to the window cap', () => {
      const limiter = new SlidingWindowRateLimiter(20, 1000);

      let successCount = 0;
      for (let i = 0; i < 25; i++) {
        if (limiter.canCall()) {
          limiter.recordCall();
          successCount++;
        }
      }

      expect(successCount).toBe(20);
      expect(limiter.getStats()).toEqual({
        currentCalls: 20,
        maxCalls: 20,
        windowMs: 1000
      });
    });
  });

  describe('Exponential Backoff', () => {
    it('should increase delay exponentially', () => {
      const delays = [];
      for (let i = 0; i < 5; i++) {
        delays.push(calculateRetryDelay(i, 1000, 30000, 2, 0));
      }

      expect(delays).toEqual([1000, 2000, 4000, 8000, 16000]);
    });

    it('should cap delay at maxDelay', () => {
      const delay = calculateRetryDelay(10, 1000, 5000, 2, 0);
      expect(delay).toBe(5000);
    });

    it('should add jitter within range', () => {
      const delays = new Set();
      for (let i = 0; i < 20; i++) {
        delays.add(calculateRetryDelay(0, 1000, 30000, 2, 0.2));
      }

      expect(delays.size).toBeGreaterThan(1);

      for (const d of delays) {
        expect(d).toBeGreaterThanOrEqual(800);
        expect(d).toBeLessThanOrEqual(1200);
      }
    });
  });

  describe('Concurrent Request Management', () => {
    it('should limit concurrent operations', async () => {
      const semaphore = new Semaphore(3);
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const operation = async (id) => {
        await semaphore.acquire();
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await jest.advanceTimersByTimeAsync(100);
        currentConcurrent--;
        semaphore.release();
        return id;
      };

      const operations = [];
      for (let i = 0; i < 10; i++) {
        operations.push(operation(i));
      }

      await Promise.all(operations);

      expect(maxConcurrent).toBe(3);
    });

    it('should track waiting operations', async () => {
      const semaphore = new Semaphore(2);

      await semaphore.acquire();
      await semaphore.acquire();

      expect(semaphore.getStats()).toEqual({
        activeCount: 2,
        queueLength: 0,
        maxConcurrent: 2
      });

      const waiting = [semaphore.acquire(), semaphore.acquire()];

      expect(semaphore.getStats().queueLength).toBe(2);

      semaphore.release();
      await Promise.resolve();

      expect(semaphore.getStats()).toEqual({
        activeCount: 2,
        queueLength: 1,
        maxConcurrent: 2
      });

      semaphore.release();
      semaphore.release();
      await Promise.all(waiting);
      semaphore.release();
      semaphore.release();
    });
  });
});
