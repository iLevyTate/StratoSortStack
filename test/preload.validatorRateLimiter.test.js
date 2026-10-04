/**
 * @jest-environment node
 *
 * Direct unit tests for the two smallest preload security primitives —
 * previously the weakest-covered files in src/preload (ipcValidator 28%
 * branch, ipcRateLimiter 40% functions). These assert the REAL modules'
 * observable behavior: window reset / rollback / stale-entry cleanup for the
 * rate limiter, and the structural event-source checks plus every
 * oversized-payload channel fallback for the validator.
 */

const { IpcRateLimiter } = require('../src/preload/ipcRateLimiter');
const { createIpcValidator } = require('../src/preload/ipcValidator');

describe('IpcRateLimiter', () => {
  const perfLimits = { RATE_LIMIT_CLEANUP_THRESHOLD: 3, RATE_LIMIT_STALE_MS: 500 };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('allows exactly maxRequestsPerSecond, then throws with retry guidance', () => {
    const limiter = new IpcRateLimiter({ maxRequestsPerSecond: 3, perfLimits });

    expect(limiter.checkRateLimit('files:get')).toBe(true);
    expect(limiter.checkRateLimit('files:get')).toBe(true);
    expect(limiter.checkRateLimit('files:get')).toBe(true);
    expect(() => limiter.checkRateLimit('files:get')).toThrow(/Rate limit exceeded/);
  });

  test('rejected requests do not inflate the counter (rollback)', () => {
    const limiter = new IpcRateLimiter({ maxRequestsPerSecond: 1, perfLimits });

    limiter.checkRateLimit('ch');
    expect(() => limiter.checkRateLimit('ch')).toThrow(/Rate limit exceeded/);
    expect(() => limiter.checkRateLimit('ch')).toThrow(/Rate limit exceeded/);
    // Counter stayed at the cap, not cap+N.
    expect(limiter.rateLimiter.get('ch').count).toBe(1);
  });

  test('window resets after one second', () => {
    const limiter = new IpcRateLimiter({ maxRequestsPerSecond: 1, perfLimits });

    limiter.checkRateLimit('ch');
    expect(() => limiter.checkRateLimit('ch')).toThrow(/Rate limit exceeded/);

    jest.setSystemTime(1_000_000 + 1001);
    expect(limiter.checkRateLimit('ch')).toBe(true);
    expect(limiter.rateLimiter.get('ch').count).toBe(1);
  });

  test('rate limits are per-channel', () => {
    const limiter = new IpcRateLimiter({ maxRequestsPerSecond: 1, perfLimits });

    limiter.checkRateLimit('a');
    expect(() => limiter.checkRateLimit('a')).toThrow(/Rate limit exceeded/);
    expect(limiter.checkRateLimit('b')).toBe(true);
  });

  test('schedules a single batched cleanup that drops stale channels', () => {
    const limiter = new IpcRateLimiter({ maxRequestsPerSecond: 5, perfLimits });

    limiter.checkRateLimit('a');
    limiter.checkRateLimit('b');
    limiter.checkRateLimit('c');
    limiter.checkRateLimit('d'); // size 4 > threshold 3 -> schedules cleanup
    expect(limiter._cleanupScheduled).toBe(true);
    limiter.checkRateLimit('e'); // does not schedule a second one
    expect(limiter.rateLimiter.size).toBe(5);

    // Make a/b/c/d/e stale (past resetTime + RATE_LIMIT_STALE_MS), then add a
    // fresh channel that must survive the sweep.
    jest.setSystemTime(1_000_000 + 1000 + perfLimits.RATE_LIMIT_STALE_MS + 1);
    limiter.checkRateLimit('fresh');

    jest.advanceTimersByTime(100); // fire the scheduled cleanup

    expect(limiter.rateLimiter.has('fresh')).toBe(true);
    expect(limiter.rateLimiter.size).toBe(1);
    expect(limiter._cleanupScheduled).toBe(false);
  });
});

describe('createIpcValidator', () => {
  const warn = jest.fn();
  const { validateEventSource, validateResult, isValidSystemMetrics } = createIpcValidator({
    log: { warn }
  });

  beforeEach(() => warn.mockClear());

  describe('validateEventSource', () => {
    test.each([
      ['null event', null],
      ['non-object event', 'evt'],
      ['missing sender', {}],
      ['non-object sender', { sender: 'x' }],
      ['senderFrame with non-string url', { sender: {}, senderFrame: { url: 42 } }]
    ])('rejects %s', (_name, event) => {
      expect(validateEventSource(event)).toBe(false);
    });

    test('accepts a structurally valid event (with and without senderFrame)', () => {
      expect(validateEventSource({ sender: {} })).toBe(true);
      expect(validateEventSource({ sender: {}, senderFrame: { url: 'app://index' } })).toBe(true);
    });
  });

  describe('isValidSystemMetrics', () => {
    test('rejects null / non-object / empty shapes', () => {
      expect(isValidSystemMetrics(null)).toBe(false);
      expect(isValidSystemMetrics('x')).toBe(false);
      expect(isValidSystemMetrics({})).toBe(false);
    });

    test('accepts uptime or memory shapes', () => {
      expect(isValidSystemMetrics({ uptime: 12 })).toBe(true);
      expect(isValidSystemMetrics({ uptime: '12h' })).toBe(true);
      expect(isValidSystemMetrics({ memory: { used: 1 } })).toBe(true);
    });
  });

  describe('validateResult — oversized/deep payload fallbacks', () => {
    const hugeString = 'x'.repeat(500001);

    test.each([
      ['files:select-directory', { success: false, path: null }],
      ['smart-folders:get-custom', []],
      ['analysis-history:get', []],
      ['undo-redo:get-history', []],
      ['undo-redo:get-state', { stack: [], pointer: -1, canUndo: false, canRedo: false }],
      [
        'undo-redo:undo',
        { success: false, message: 'Undo/redo response rejected: payload exceeded safety limits' }
      ],
      [
        'some:other-channel',
        { success: false, error: 'IPC response rejected: payload exceeded safety limits' }
      ]
    ])('maps rejected payload on %s to its safe fallback', (channel, expected) => {
      expect(validateResult(hugeString, channel)).toEqual(expected);
      expect(warn).toHaveBeenCalledWith(
        '[SecureIPC] Rejected oversized/deep IPC response payload',
        { channel }
      );
    });

    // Boundaries mirror ipcValidator.js (MAX_STRING_LENGTH 500000,
    // MAX_ARRAY_LENGTH 50000, MAX_OBJECT_KEYS 5000, MAX_RESULT_DEPTH 24):
    // exactly-at-cap passes through, cap+1 is rejected.
    const fallback = { success: false, error: expect.any(String) };
    const buildDeep = (depth) => {
      const root = {};
      let cursor = root;
      for (let i = 0; i < depth; i += 1) {
        cursor.next = {};
        cursor = cursor.next;
      }
      cursor.v = 1;
      return root;
    };

    test('accepts payloads exactly at each cap', () => {
      const atCapString = 'x'.repeat(500000);
      expect(validateResult({ a: atCapString }, 'c')).toEqual({ a: atCapString });

      const atCapArray = new Array(50000).fill(1);
      expect(validateResult(atCapArray, 'c')).toBe(atCapArray);

      const atCapObject = {};
      for (let i = 0; i < 5000; i += 1) atCapObject[`k${i}`] = i;
      expect(validateResult(atCapObject, 'c')).toBe(atCapObject);

      // Root object sits at depth 0, so 24 nested levels reach depth 24 exactly.
      const atCapDeep = buildDeep(24);
      expect(validateResult(atCapDeep, 'c')).toBe(atCapDeep);
    });

    test('rejects nested string, array, key-count, and depth one past each cap', () => {
      expect(validateResult({ a: hugeString }, 'c')).toEqual(fallback);
      expect(validateResult(new Array(50001).fill(1), 'c')).toEqual(fallback);

      const wideObject = {};
      for (let i = 0; i <= 5000; i += 1) wideObject[`k${i}`] = i;
      expect(validateResult(wideObject, 'c')).toEqual(fallback);

      expect(validateResult(buildDeep(25), 'c')).toEqual(fallback);
    });

    test('rejects function payloads but tolerates cycles', () => {
      expect(validateResult(() => {}, 'c')).toEqual({
        success: false,
        error: expect.any(String)
      });

      const cyclic = { name: 'ok' };
      cyclic.self = cyclic;
      expect(validateResult(cyclic, 'c')).toBe(cyclic); // cycle-safe, passes through
    });
  });

  describe('validateResult — per-channel success-path shaping', () => {
    test('system:get-metrics passes valid metrics and nulls invalid ones', () => {
      const metrics = { uptime: 42 };
      expect(validateResult(metrics, 'system:get-metrics')).toBe(metrics);
      expect(validateResult({ bogus: true }, 'system:get-metrics')).toBeNull();
    });

    test('files:select-directory enforces result shape', () => {
      const ok = { success: true, path: '/x' };
      expect(validateResult(ok, 'files:select-directory')).toBe(ok);
      expect(validateResult('nope', 'files:select-directory')).toEqual({
        success: false,
        path: null
      });
    });

    test('smart-folders:get-custom coerces non-arrays to []', () => {
      const arr = [{ id: 1 }];
      expect(validateResult(arr, 'smart-folders:get-custom')).toBe(arr);
      expect(validateResult({ not: 'array' }, 'smart-folders:get-custom')).toEqual([]);
    });

    test('unknown channels pass validated payloads through untouched', () => {
      const payload = { anything: [1, 2, 3] };
      expect(validateResult(payload, 'zz:unknown')).toBe(payload);
    });
  });
});
