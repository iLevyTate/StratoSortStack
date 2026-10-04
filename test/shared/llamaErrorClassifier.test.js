const {
  classifyLlamaError,
  looksLikeCpuIncompatibility,
  looksLikeModelNotFound
} = require('../../src/shared/llamaErrorClassifier');
const { ERROR_CODES } = require('../../src/shared/errorCodes');

describe('llamaErrorClassifier', () => {
  describe('looksLikeCpuIncompatibility', () => {
    test.each([
      ['SIGILL in llama-addon.node'],
      ['node-llama-cpp: Illegal instruction at 0x7fff...'],
      ['Fatal error in llama_addon.node'],
      ['AVX2 required by this build'],
      ['unsupported CPU: missing AVX']
    ])('matches "%s"', (message) => {
      expect(looksLikeCpuIncompatibility(new Error(message))).toBe(true);
    });

    test('ignores unrelated errors', () => {
      expect(looksLikeCpuIncompatibility(new Error('ENOENT: no such file'))).toBe(false);
      expect(looksLikeCpuIncompatibility(new Error('Connection refused'))).toBe(false);
      expect(looksLikeCpuIncompatibility(null)).toBe(false);
      expect(looksLikeCpuIncompatibility(undefined)).toBe(false);
    });

    test('accepts plain strings', () => {
      expect(looksLikeCpuIncompatibility('SIGILL encountered')).toBe(true);
      expect(looksLikeCpuIncompatibility('benign message')).toBe(false);
    });
  });

  describe('looksLikeModelNotFound', () => {
    test('matches explicit code', () => {
      const err = new Error('missing');
      err.code = ERROR_CODES.LLAMA_MODEL_NOT_FOUND;
      expect(looksLikeModelNotFound(err)).toBe(true);
    });

    test.each([
      ['Model not found: qwen2.5-0.5b.gguf'],
      ['ENOENT: no such file or directory, open ".../Llama-3.2-3B-Instruct-Q4_K_M.gguf"'],
      ['Failed to load model: ENOENT open ".../some-model.gguf"']
    ])('matches "%s"', (message) => {
      expect(looksLikeModelNotFound(new Error(message))).toBe(true);
    });

    test('ignores unrelated errors', () => {
      expect(looksLikeModelNotFound(new Error('SIGILL'))).toBe(false);
      expect(looksLikeModelNotFound(null)).toBe(false);
    });
  });

  describe('classifyLlamaError', () => {
    test('preserves an already-tagged LLAMA_* code', () => {
      const err = new Error('boom');
      err.code = ERROR_CODES.LLAMA_OOM;
      expect(classifyLlamaError(err)).toBe(ERROR_CODES.LLAMA_OOM);
    });

    test('maps SIGILL-like errors to LLAMA_MODEL_INCOMPATIBLE_CPU', () => {
      expect(classifyLlamaError(new Error('Illegal instruction'))).toBe(
        ERROR_CODES.LLAMA_MODEL_INCOMPATIBLE_CPU
      );
    });

    test('maps file-not-found errors to LLAMA_MODEL_NOT_FOUND', () => {
      expect(classifyLlamaError(new Error('Model not found: x.gguf'))).toBe(
        ERROR_CODES.LLAMA_MODEL_NOT_FOUND
      );
    });

    test('returns null for unclassified errors', () => {
      expect(classifyLlamaError(new Error('some other problem'))).toBeNull();
      expect(classifyLlamaError(null)).toBeNull();
    });
  });
});
