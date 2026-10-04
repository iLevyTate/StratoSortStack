/**
 * @jest-environment node
 */
import {
  BOOTSTRAP_IPC_OPTIONS,
  runIpcWithTimeoutRetry,
  withIpcTimeout
} from '../../src/renderer/store/ipcTimeout';

describe('ipcTimeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('withIpcTimeout resolves when the promise wins the race', async () => {
    const resultPromise = withIpcTimeout(Promise.resolve('ok'), 1000);
    await expect(resultPromise).resolves.toBe('ok');
  });

  test('withIpcTimeout rejects with IPC timeout when the timer wins', async () => {
    const resultPromise = withIpcTimeout(new Promise(() => {}), 50);
    const assertion = expect(resultPromise).rejects.toThrow('IPC timeout');
    await jest.advanceTimersByTimeAsync(50);
    await assertion;
  });

  test('runIpcWithTimeoutRetry retries timeout errors then succeeds', async () => {
    let calls = 0;
    const factory = () => {
      calls += 1;
      if (calls < 3) {
        return new Promise(() => {});
      }
      return Promise.resolve({ ready: true });
    };

    const resultPromise = runIpcWithTimeoutRetry(factory, {
      ms: 20,
      retries: 3,
      retryDelayMs: 10
    });

    // Drain attempt 1 timeout + delay + attempt 2 timeout + delay + attempt 3 success
    await jest.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(20);
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(10);
    await Promise.resolve();

    await expect(resultPromise).resolves.toEqual({ ready: true });
    expect(calls).toBe(3);
  });

  test('BOOTSTRAP_IPC_OPTIONS budget exceeds a single cold-start timeout', () => {
    expect(BOOTSTRAP_IPC_OPTIONS.ms).toBeGreaterThanOrEqual(15000);
    expect(BOOTSTRAP_IPC_OPTIONS.retries).toBeGreaterThanOrEqual(3);
  });
});
