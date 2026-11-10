/**
 * @jest-environment node
 *
 * A request to the vision runtime is aborted while it runs for one of two
 * reasons: its caller gave up (Stop, a closed window), or the analysis ran out
 * of time. Both rejected with the same plain error, which the vision breaker
 * counts. Five Stops during slow inferences opened it, and for five minutes
 * every image got an OCR result in place of the vision model. Only running
 * out of time says anything about the runtime.
 *
 * Real request, real breaker, real timeout wrapper; the runtime is a local
 * server that never answers.
 */
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/mock/userData') }
}));
jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  };
  return { logger, createLogger: () => logger };
});

const http = require('http');
const { _requestJson } = require('../src/main/services/VisionService');
const promiseUtils = require('../src/shared/promiseUtils');
const {
  withLlamaResilience,
  cleanupLlamaCircuits,
  _getCircuitBreaker
} = require('../src/main/services/LlamaResilience');

const { withAbortableTimeout } = promiseUtils;

describe('a vision request that is aborted while the runtime works on it', () => {
  let server;
  let port;
  let onArrival;
  let sendRequest;

  beforeEach(async () => {
    onArrival = null;
    server = http.createServer(() => {
      // Never answered, as an inference that is still running.
      if (onArrival) onArrival();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    sendRequest = jest.fn((signal) =>
      _requestJson({
        method: 'POST',
        port,
        path: '/v1/chat/completions',
        body: { a: 1 },
        signal
      })
    );
  });

  afterEach(async () => {
    cleanupLlamaCircuits();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const nextArrival = () =>
    new Promise((resolve) => {
      onArrival = resolve;
    });

  /**
   * The layers an image analysis puts around the request: the timeout wrapper
   * hands its own signal to the guarded call. `guarded()` is the promise the
   * breaker settles, which outlives the rejection the caller gets.
   */
  function analyze({ callerSignal, timeoutMs = 60000 } = {}) {
    let guarded;
    const outcome = withAbortableTimeout(
      (inner) => {
        guarded = withLlamaResilience(() => sendRequest(inner.signal), { modelType: 'vision' });
        return guarded;
      },
      timeoutMs,
      'Image analysis',
      { signal: callerSignal }
    );
    return { outcome, guarded: () => guarded.catch((error) => error) };
  }

  async function stopDuringInference() {
    const caller = new AbortController();
    const arrived = nextArrival();
    const run = analyze({ callerSignal: caller.signal });
    await arrived;
    caller.abort();
    await expect(run.outcome).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
    return run.guarded();
  }

  async function runOutOfTime() {
    const run = analyze({ timeoutMs: 150 });
    await expect(run.outcome).rejects.toThrow(/timed out after 150ms/);
    return run.guarded();
  }

  test('five Stops in a row leave the vision breaker closed', async () => {
    for (let stop = 0; stop < 5; stop += 1) {
      await stopDuringInference();
    }

    expect(_getCircuitBreaker('vision').getState()).toBe('CLOSED');
    // The next image is sent to the runtime.
    await stopDuringInference();
    expect(sendRequest).toHaveBeenCalledTimes(6);
  });

  // The renderer's own limit on the invoke: main aborts the handler's signal
  // with this reason. The runtime did not answer in time, as above.
  async function invokeTimesOut() {
    const caller = new AbortController();
    const arrived = nextArrival();
    const run = analyze({ callerSignal: caller.signal });
    await arrived;
    caller.abort('ipc-timeout');
    await expect(run.outcome).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
    return run.guarded();
  }

  test('five invokes that timed out in the renderer open it too', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const error = await invokeTimesOut();
      expect(error.originalError || error).toMatchObject({ name: 'Error' });
    }

    expect(_getCircuitBreaker('vision').getState()).toBe('OPEN');
  });

  test('a Stop rejects the request as an abort', async () => {
    const error = await stopDuringInference();

    expect(error.message).toMatch(/Vision request aborted/);
    expect(error.originalError || error).toMatchObject({ name: 'AbortError' });
  });

  test('five analyses that ran out of time still open it', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const error = await runOutOfTime();
      expect(error.originalError || error).toMatchObject({ name: 'Error' });
    }

    expect(_getCircuitBreaker('vision').getState()).toBe('OPEN');
    await expect(analyze().outcome).rejects.toThrow(/Circuit breaker is OPEN for llama-vision/);
    expect(sendRequest).toHaveBeenCalledTimes(5);
  });

  describe('how the request tells the two apart', () => {
    const innerSignalOf = async ({ callerSignal, timeoutMs }) => {
      let innerSignal;
      await withAbortableTimeout(
        (inner) => {
          innerSignal = inner.signal;
          return new Promise(() => {});
        },
        timeoutMs,
        'Image analysis',
        { signal: callerSignal }
      ).catch(() => {});
      return innerSignal;
    };

    test('the timeout wrapper marks the signal it aborts when the time ran out', async () => {
      const signal = await innerSignalOf({ timeoutMs: 20 });

      expect(signal.aborted).toBe(true);
      expect(promiseUtils.isTimeoutAbort(signal)).toBe(true);
      // Work that rethrows the reason is classified as it was before.
      expect(signal.reason).toMatchObject({
        name: 'AbortError',
        message: 'This operation was aborted'
      });
    });

    test('and does not mark it when the caller gave up', async () => {
      const caller = new AbortController();
      setTimeout(() => caller.abort(), 10);

      const signal = await innerSignalOf({ callerSignal: caller.signal, timeoutMs: 60000 });

      expect(signal.aborted).toBe(true);
      expect(promiseUtils.isTimeoutAbort(signal)).toBe(false);
    });

    test('a signal of AbortSignal.timeout counts as running out of time', async () => {
      const signal = AbortSignal.timeout(5);
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));

      expect(promiseUtils.isTimeoutAbort(signal)).toBe(true);
    });

    test('a signal that was not aborted, or no signal, does not', () => {
      expect(promiseUtils.isTimeoutAbort(new AbortController().signal)).toBe(false);
      expect(promiseUtils.isTimeoutAbort(null)).toBe(false);
      expect(promiseUtils.isTimeoutAbort(undefined)).toBe(false);
    });
  });
});
