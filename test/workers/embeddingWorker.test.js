/**
 * Unit tests for `embeddingWorker`.
 *
 * The worker runs inside a Piscina pool, but its default export
 * (`runEmbeddingTask`) is a plain async function of its payload. We
 * exercise the REAL module directly so the synchronous validation,
 * cleanup, and error-coding branches are actually covered. Those
 * branches run BEFORE any `node-llama-cpp` import, so no native binary
 * is required to reach them.
 *
 * What we're pinning:
 *   1. The module's exported function actually loaded (no swallowed require).
 *   2. Non-object / missing-text payloads reject with LLAMA_INFERENCE_FAILED.
 *   3. A valid text with no modelPath reaches ensureModelLoaded's guard and
 *      the outer catch preserves LLAMA_MODEL_NOT_FOUND.
 *   4. `type:'cleanup'` is a no-op that resolves to `{ cleaned: true }`.
 */

jest.mock('../../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const runEmbeddingTask = require('../../src/main/workers/embeddingWorker');
const { ERROR_CODES } = require('../../src/shared/errorCodes');

async function captureRejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected promise to reject, but it resolved');
}

describe('main/workers/embeddingWorker', () => {
  test('exports the runEmbeddingTask function (require did not silently fail)', () => {
    expect(typeof runEmbeddingTask).toBe('function');
  });

  describe('payload validation', () => {
    test('rejects a non-object payload with LLAMA_INFERENCE_FAILED', async () => {
      const err = await captureRejection(runEmbeddingTask(null));
      expect(err.message).toMatch(/payload must be an object/i);
      expect(err.code).toBe(ERROR_CODES.LLAMA_INFERENCE_FAILED);

      const err2 = await captureRejection(runEmbeddingTask('not-an-object'));
      expect(err2.message).toMatch(/payload must be an object/i);
      expect(err2.code).toBe(ERROR_CODES.LLAMA_INFERENCE_FAILED);
    });

    test('rejects when text is missing or non-string with LLAMA_INFERENCE_FAILED', async () => {
      const err = await captureRejection(runEmbeddingTask({}));
      expect(err.message).toMatch(/text must be a string/i);
      expect(err.code).toBe(ERROR_CODES.LLAMA_INFERENCE_FAILED);

      const err2 = await captureRejection(runEmbeddingTask({ text: 123 }));
      expect(err2.message).toMatch(/text must be a string/i);
      expect(err2.code).toBe(ERROR_CODES.LLAMA_INFERENCE_FAILED);
    });

    test('rejects a valid text with no modelPath as LLAMA_MODEL_NOT_FOUND', async () => {
      // text passes validation, so this reaches ensureModelLoaded's
      // missing-path guard, and the outer catch must preserve its code
      // rather than overwriting it with LLAMA_INFERENCE_FAILED.
      const err = await captureRejection(runEmbeddingTask({ text: 'hello world' }));
      expect(err.message).toMatch(/model path is required/i);
      expect(err.code).toBe(ERROR_CODES.LLAMA_MODEL_NOT_FOUND);
    });
  });

  describe('cleanup dispatch', () => {
    test('type:"cleanup" resolves to { cleaned: true } without loading a model', async () => {
      await expect(runEmbeddingTask({ type: 'cleanup' })).resolves.toEqual({ cleaned: true });
    });
  });
});
