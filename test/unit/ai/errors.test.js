'use strict';
const { AIProviderError, AI_ERROR_CODES } = require('../../../src/main/services/ai/errors');

describe('AIProviderError', () => {
  test('preserves typed code across throw/catch', () => {
    let caught;
    try {
      throw new AIProviderError('AUTH_FAILED', 'invalid key');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AIProviderError);
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe('AUTH_FAILED');
    expect(caught.message).toBe('invalid key');
    expect(caught.name).toBe('AIProviderError');
  });

  test('rejects unknown error code at construction time', () => {
    expect(() => new AIProviderError('NOT_A_REAL_CODE', 'oops')).toThrow(/unknown.*error code/i);
  });

  test('toJSON omits message details to prevent key leakage in logs', () => {
    const err = new AIProviderError('AUTH_FAILED', 'sk-ant-1234567890abcdef rejected');
    const json = err.toJSON();
    expect(json).toEqual({ name: 'AIProviderError', code: 'AUTH_FAILED' });
    expect(JSON.stringify(json)).not.toContain('sk-ant');
  });

  test('AI_ERROR_CODES is the documented set', () => {
    expect(AI_ERROR_CODES).toEqual(
      expect.arrayContaining([
        'AUTH_FAILED',
        'RATE_LIMITED',
        'NETWORK_ERROR',
        'CONTENT_TOO_LONG',
        'BUDGET_EXCEEDED',
        'PROVIDER_DISABLED',
        'NO_PROVIDER_READY',
        'PROVIDER_FAILED',
        'INVALID_RESPONSE'
      ])
    );
  });

  test('preserves a cause chain for debugging', () => {
    const inner = new Error('socket hangup');
    const err = new AIProviderError('NETWORK_ERROR', 'failed to reach Claude', { cause: inner });
    expect(err.cause).toBe(inner);
  });
});
