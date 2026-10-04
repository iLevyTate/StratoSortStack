/**
 * Tests for LlamaResilience
 */

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn()
  })
}));

jest.mock('../src/shared/errorHandlingUtils', () => ({
  withRetry: jest.fn()
}));

const { withRetry } = require('../src/shared/errorHandlingUtils');
const {
  withLlamaResilience,
  withOramaResilience,
  isRetryableLlamaError,
  shouldFallbackToCPU,
  getLlamaCircuitStats,
  getLlamaCircuitSummary,
  resetLlamaCircuit,
  cleanupLlamaCircuits,
  _circuitBreakers,
  _getCircuitBreaker
} = require('../src/main/services/LlamaResilience');

describe('LlamaResilience', () => {
  beforeEach(() => {
    withRetry.mockReset();
    cleanupLlamaCircuits();
  });

  afterAll(() => {
    cleanupLlamaCircuits();
  });

  test('isRetryableLlamaError matches known patterns', () => {
    expect(isRetryableLlamaError(new Error('CUDA memory allocation failed'))).toBe(true);
    expect(isRetryableLlamaError(new Error('Other error'))).toBe(false);
  });

  test('shouldFallbackToCPU matches GPU errors', () => {
    expect(shouldFallbackToCPU(new Error('CUDA out of memory'))).toBe(true);
    expect(shouldFallbackToCPU(new Error('Not related'))).toBe(false);
  });

  test('withLlamaResilience returns successful result', async () => {
    withRetry.mockImplementationOnce((operation) => operation);
    const operation = jest.fn().mockResolvedValue('ok');
    await expect(withLlamaResilience(operation)).resolves.toBe('ok');
  });

  test('withLlamaResilience falls back to CPU on GPU errors', async () => {
    withRetry.mockImplementationOnce(() => async () => {
      throw new Error('CUDA out of memory');
    });
    withRetry.mockImplementationOnce((operation) => operation);

    const operation = jest.fn((options) => {
      if (options?.forceCPU) return 'cpu-ok';
      throw new Error('CUDA out of memory');
    });

    await expect(withLlamaResilience(operation)).resolves.toBe('cpu-ok');
    expect(operation).toHaveBeenCalledWith({ forceCPU: true });
  });

  test('withLlamaResilience retries once on transient_load_failure tag, succeeds on second attempt', async () => {
    // First attempt (via mocked withRetry) throws an error tagged by
    // DegradationManager as a transient load failure (generic "Failed to
    // load model" with no specific signal). The resilience layer should NOT
    // escalate to CPU fallback — it should sleep ~1.5 s and retry the
    // operation directly. We verify the retry path runs by making the
    // direct invocation succeed.
    const taggedError = new Error('Failed to load model');
    taggedError._degradationAction = 'transient_load_failure';

    // The withRetry mock intercepts the FIRST attempt and rejects without
    // calling `operation`. The catch block then invokes `operation()`
    // directly — that direct call is what `operation` actually sees.
    withRetry.mockImplementationOnce(() => async () => {
      throw taggedError;
    });

    const operation = jest.fn().mockResolvedValueOnce('recovered');

    // Real 1.5s delay — acceptable in a single test, and faking timers
    // around `delay()` adds noise to the semantics under test.
    await expect(withLlamaResilience(operation)).resolves.toBe('recovered');
    expect(operation).toHaveBeenCalledTimes(1);
  }, 10000);

  test('withLlamaResilience does NOT escalate transient_load_failure to CPU fallback', async () => {
    // Even though shouldFallbackToCPU might match unrelated error text in
    // a future change, the transient_load_failure branch must hard-stop
    // after one retry — CPU fallback masks permanent failures (e.g. a
    // model file deleted post-startup) by retrying for tens of seconds in
    // CPU mode for no benefit.
    const taggedError = new Error('Failed to load model');
    taggedError._degradationAction = 'transient_load_failure';

    withRetry.mockImplementationOnce(() => async () => {
      throw taggedError;
    });

    const operation = jest.fn().mockRejectedValue(new Error('still failing'));

    await expect(withLlamaResilience(operation)).rejects.toThrow(/still failing/);
    // Operation called exactly ONCE — the explicit retry — never with forceCPU.
    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation).not.toHaveBeenCalledWith(expect.objectContaining({ forceCPU: true }));
  }, 10000);

  test('withLlamaResilience throws enriched error when retries fail', async () => {
    withRetry.mockImplementationOnce(() => async () => {
      throw new Error('timeout');
    });

    await expect(
      withLlamaResilience(async () => 'ignored', { allowCPUFallback: false })
    ).rejects.toThrow(/Llama operation failed/);
  });

  test('withOramaResilience uses withRetry wrapper', async () => {
    const operation = jest.fn().mockResolvedValue('done');
    withRetry.mockImplementationOnce((op) => op);
    await expect(withOramaResilience(operation, { maxRetries: 2 })).resolves.toBe('done');
    expect(withRetry).toHaveBeenCalledWith(operation, expect.objectContaining({ maxRetries: 2 }));
  });

  // --- Circuit breaker integration tests ---

  describe('circuit breaker integration', () => {
    beforeEach(() => {
      cleanupLlamaCircuits();
    });

    test('creates per-model-type circuit breakers lazily', () => {
      expect(_circuitBreakers.size).toBe(0);

      _getCircuitBreaker('text');
      _getCircuitBreaker('embedding');
      expect(_circuitBreakers.size).toBe(2);

      // Same type returns the same instance
      const first = _getCircuitBreaker('text');
      const second = _getCircuitBreaker('text');
      expect(first).toBe(second);
    });

    test('withLlamaResilience with modelType routes through circuit breaker', async () => {
      withRetry.mockImplementation((operation) => operation);
      const operation = jest.fn().mockResolvedValue('result');

      const result = await withLlamaResilience(operation, { modelType: 'text' });

      expect(result).toBe('result');
      expect(_circuitBreakers.has('text')).toBe(true);

      const breaker = _circuitBreakers.get('text');
      expect(breaker.getState()).toBe('CLOSED');
      expect(breaker.getStats().successfulRequests).toBe(1);
    });

    test('circuit breaker records failures and opens after threshold', async () => {
      // Make withRetry pass-through so the operation actually throws
      withRetry.mockImplementation(() => async () => {
        throw new Error('fatal model error');
      });

      const failingOp = jest.fn().mockRejectedValue(new Error('fatal model error'));

      // Fail 5 times (the failureThreshold)
      for (let i = 0; i < 5; i++) {
        await expect(
          withLlamaResilience(failingOp, { modelType: 'embedding', allowCPUFallback: false })
        ).rejects.toThrow();
      }

      const breaker = _circuitBreakers.get('embedding');
      expect(breaker.getState()).toBe('OPEN');

      // Next call should be rejected immediately by the breaker
      withRetry.mockImplementation((operation) => operation);
      const healthyOp = jest.fn().mockResolvedValue('should-not-run');

      await expect(withLlamaResilience(healthyOp, { modelType: 'embedding' })).rejects.toThrow(
        /circuit breaker is OPEN/i
      );

      // The healthy operation should never have been called
      expect(healthyOp).not.toHaveBeenCalled();
    });

    test('memory budget refusals do not open the circuit breaker', async () => {
      withRetry.mockImplementation((operation) => operation);
      const budgetError = new Error(
        'Cannot start the vision runtime (load): memory budget exceeded while text stays in use'
      );
      budgetError.code = 'MODEL_MEMORY_BUDGET_EXCEEDED';
      const refusedOp = jest.fn().mockRejectedValue(budgetError);

      for (let i = 0; i < 5; i++) {
        await expect(
          withLlamaResilience(refusedOp, { modelType: 'text', allowCPUFallback: false })
        ).rejects.toThrow(/memory budget/i);
      }

      const breaker = _circuitBreakers.get('text');
      expect(breaker.getState()).toBe('CLOSED');
      expect(breaker.getStats().failedRequests).toBe(0);
    });

    test('getLlamaCircuitSummary lists breaker states and the open ones', () => {
      expect(getLlamaCircuitSummary()).toEqual({ states: {}, open: [] });

      _getCircuitBreaker('text').forceState('OPEN');
      _getCircuitBreaker('embedding');

      expect(getLlamaCircuitSummary()).toEqual({
        states: { text: 'OPEN', embedding: 'CLOSED' },
        open: ['text']
      });
    });

    test('abort-like errors do not open the circuit breaker', async () => {
      withRetry.mockImplementation((operation) => operation);
      const abortError = new Error('Operation aborted');
      abortError.name = 'AbortError';
      const abortedOp = jest.fn().mockRejectedValue(abortError);

      for (let i = 0; i < 5; i++) {
        await expect(
          withLlamaResilience(abortedOp, { modelType: 'text', allowCPUFallback: false })
        ).rejects.toThrow(/aborted/i);
      }

      const breaker = _circuitBreakers.get('text');
      expect(breaker.getState()).toBe('CLOSED');
      expect(breaker.getStats().failedRequests).toBe(0);
      expect(abortedOp).toHaveBeenCalledTimes(5);
    });

    test('different model types have independent circuit breakers', async () => {
      withRetry.mockImplementation(() => async () => {
        throw new Error('fatal');
      });

      const failingOp = jest.fn();

      // Trip the text breaker
      for (let i = 0; i < 5; i++) {
        await expect(
          withLlamaResilience(failingOp, { modelType: 'text', allowCPUFallback: false })
        ).rejects.toThrow();
      }

      // Text should be open
      expect(_circuitBreakers.get('text').getState()).toBe('OPEN');

      // Embedding should still work (separate breaker)
      withRetry.mockImplementation((operation) => operation);
      const embedOp = jest.fn().mockResolvedValue('embed-ok');

      await expect(withLlamaResilience(embedOp, { modelType: 'embedding' })).resolves.toBe(
        'embed-ok'
      );

      expect(_circuitBreakers.get('embedding').getState()).toBe('CLOSED');
    });

    test('without modelType, no circuit breaker is used (backward compat)', async () => {
      withRetry.mockImplementation((operation) => operation);
      const operation = jest.fn().mockResolvedValue('ok');

      await expect(withLlamaResilience(operation)).resolves.toBe('ok');
      expect(_circuitBreakers.size).toBe(0);
    });

    test('getLlamaCircuitStats returns stats for all active breakers', async () => {
      withRetry.mockImplementation((operation) => operation);

      await withLlamaResilience(jest.fn().mockResolvedValue('a'), { modelType: 'text' });
      await withLlamaResilience(jest.fn().mockResolvedValue('b'), { modelType: 'embedding' });

      const stats = getLlamaCircuitStats();
      expect(stats).toHaveProperty('text');
      expect(stats).toHaveProperty('embedding');
      expect(stats.text.successfulRequests).toBe(1);
      expect(stats.embedding.successfulRequests).toBe(1);
    });

    test('resetLlamaCircuit resets a tripped breaker', async () => {
      withRetry.mockImplementation(() => async () => {
        throw new Error('fatal');
      });

      // Trip the breaker
      for (let i = 0; i < 5; i++) {
        await expect(
          withLlamaResilience(jest.fn(), { modelType: 'vision', allowCPUFallback: false })
        ).rejects.toThrow();
      }

      expect(_circuitBreakers.get('vision').getState()).toBe('OPEN');

      // Reset it
      resetLlamaCircuit('vision');
      expect(_circuitBreakers.get('vision').getState()).toBe('CLOSED');

      // Should accept requests again
      withRetry.mockImplementation((operation) => operation);
      await expect(
        withLlamaResilience(jest.fn().mockResolvedValue('recovered'), { modelType: 'vision' })
      ).resolves.toBe('recovered');
    });

    test('cleanupLlamaCircuits clears all breakers', () => {
      _getCircuitBreaker('text');
      _getCircuitBreaker('embedding');
      _getCircuitBreaker('vision');
      expect(_circuitBreakers.size).toBe(3);

      cleanupLlamaCircuits();
      expect(_circuitBreakers.size).toBe(0);
    });
  });
});
