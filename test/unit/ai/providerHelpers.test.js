'use strict';

const {
  DEFAULT_REQUEST_TIMEOUT_MS,
  combineSignalsWithTimeout,
  redactSensitive
} = require('../../../src/main/services/ai/providers/_providerHelpers');

describe('_providerHelpers', () => {
  describe('redactSensitive', () => {
    test('redacts Bearer tokens', () => {
      expect(redactSensitive('Authorization: Bearer abc123.def-456/==')).toContain('<redacted>');
      expect(redactSensitive('Bearer sk_live_TOKEN')).not.toMatch(/sk_live_TOKEN/);
    });

    test('redacts OpenAI and Anthropic key shapes', () => {
      expect(redactSensitive('key sk-ABCDEFGHIJKL123')).toBe('key <redacted>');
      expect(redactSensitive('key sk-ant-ABCDEFGHIJKL123')).toBe('key <redacted>');
    });

    test('redacts Slack tokens', () => {
      expect(redactSensitive('xoxb-1234567890-abcdef')).toBe('<redacted>');
    });

    test('redacts api-key / authorization assignments', () => {
      expect(redactSensitive('x-api-key: supersecretvalue')).toBe('<redacted>');
      expect(redactSensitive('api_key=supersecretvalue')).toBe('<redacted>');
    });

    test('leaves benign strings untouched', () => {
      expect(redactSensitive('Request failed with status 500')).toBe(
        'Request failed with status 500'
      );
    });

    test('returns non-string and empty values unchanged', () => {
      expect(redactSensitive('')).toBe('');
      expect(redactSensitive(null)).toBeNull();
      expect(redactSensitive(42)).toBe(42);
      expect(redactSensitive(undefined)).toBeUndefined();
    });
  });

  describe('combineSignalsWithTimeout', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    test('exports a sane default timeout', () => {
      expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(120_000);
    });

    test('signal is already aborted when caller signal is already aborted', () => {
      const caller = AbortSignal.abort(new Error('caller gone'));
      const { signal, cancel } = combineSignalsWithTimeout(caller, 1000);
      expect(signal.aborted).toBe(true);
      cancel();
    });

    test('aborts when the caller signal aborts later', () => {
      const controller = new AbortController();
      const { signal, cancel } = combineSignalsWithTimeout(controller.signal, 60_000);
      expect(signal.aborted).toBe(false);
      controller.abort(new Error('user cancelled'));
      expect(signal.aborted).toBe(true);
      cancel();
    });

    test('aborts when the timeout elapses', () => {
      jest.useFakeTimers();
      const { signal, cancel } = combineSignalsWithTimeout(undefined, 5000);
      expect(signal.aborted).toBe(false);
      jest.advanceTimersByTime(5000);
      expect(signal.aborted).toBe(true);
      cancel();
    });

    test('cancel() prevents the timeout from firing', () => {
      jest.useFakeTimers();
      const { signal, cancel } = combineSignalsWithTimeout(undefined, 5000);
      cancel();
      jest.advanceTimersByTime(10_000);
      expect(signal.aborted).toBe(false);
    });

    test('no timer is armed for a non-finite or non-positive timeout', () => {
      jest.useFakeTimers();
      const { signal } = combineSignalsWithTimeout(undefined, 0);
      jest.advanceTimersByTime(1_000_000);
      expect(signal.aborted).toBe(false);
    });
  });
});
