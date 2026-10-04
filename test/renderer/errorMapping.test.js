const { mapErrorToNotification } = require('../../src/renderer/utils/errorMapping');
const { ERROR_CODES } = require('../../src/shared/errorCodes');

describe('errorMapping', () => {
  test('maps known error types to friendly messages', () => {
    const result = mapErrorToNotification({
      error: 'Timeout occurred',
      errorType: 'TIMEOUT',
      operationType: 'Search'
    });
    expect(result.severity).toBe('warning');
    expect(result.message).toContain('Search failed');
  });

  test('falls back to raw error message when type is unknown', () => {
    const result = mapErrorToNotification({
      error: 'Something broke',
      errorType: 'UNKNOWN_ERROR',
      operationType: 'Analyze'
    });
    expect(result.message).toContain('Analyze failed');
    expect(result.message).toContain('Something broke');
  });

  test('uses generic message when no error string provided', () => {
    const result = mapErrorToNotification({});
    expect(result.message).toContain('Operation failed');
  });

  describe('Llama actionable copy', () => {
    test('surfaces actionable copy for SIGILL / CPU-incompat code', () => {
      const result = mapErrorToNotification({
        errorCode: ERROR_CODES.LLAMA_MODEL_INCOMPATIBLE_CPU,
        error: new Error('SIGILL from llama_addon.node')
      });
      expect(result.severity).toBe('error');
      expect(result.message).toMatch(/SIGILL|CPU does not support/i);
      expect(result.message).toMatch(/Qwen|small/i);
    });

    test('infers CPU-incompat from raw error text even without a code', () => {
      const result = mapErrorToNotification({
        error: new Error('Illegal instruction in llama_addon.node')
      });
      expect(result.severity).toBe('error');
      expect(result.message).toMatch(/SIGILL|CPU does not support/i);
    });

    test('maps path mismatch code to migration guidance', () => {
      const result = mapErrorToNotification({
        errorCode: ERROR_CODES.LLAMA_MODEL_PATH_MISMATCH,
        error: new Error('Model found in legacy dir')
      });
      expect(result.severity).toBe('error');
      expect(result.message).toMatch(/legacy install directory/i);
      expect(result.message).toMatch(/model setup/i);
    });

    test('maps auto-fallback to a non-blocking warning', () => {
      const result = mapErrorToNotification({
        errorCode: ERROR_CODES.LLAMA_MODEL_AUTO_FALLBACK,
        error: new Error('auto-fallback applied')
      });
      expect(result.severity).toBe('warning');
      expect(result.message).toMatch(/smaller default model|Quality may be reduced/i);
    });

    test('maps model-not-found to install-model guidance', () => {
      const result = mapErrorToNotification({
        errorCode: ERROR_CODES.LLAMA_MODEL_NOT_FOUND
      });
      expect(result.severity).toBe('error');
      expect(result.message).toMatch(/Settings.*Models|model setup wizard/i);
    });
  });
});
