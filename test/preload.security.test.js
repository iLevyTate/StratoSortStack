/**
 * @jest-environment node
 *
 * F-3: Preload security layer tests.
 * Tests the REAL rate limiter, sanitizer, and path validator — NOT mocked.
 * Complements preload.coverage.test.js which mocks these layers to pass-through.
 */

const { IpcRateLimiter } = require('../src/preload/ipcRateLimiter');
const { createIpcSanitizer } = require('../src/preload/ipcSanitizer');

describe('IpcRateLimiter (real)', () => {
  let limiter;

  beforeEach(() => {
    limiter = new IpcRateLimiter({
      maxRequestsPerSecond: 5,
      perfLimits: {
        RATE_LIMIT_CLEANUP_THRESHOLD: 100,
        RATE_LIMIT_STALE_MS: 5000
      }
    });
  });

  test('allows requests under the limit', () => {
    for (let i = 0; i < 5; i++) {
      expect(limiter.checkRateLimit('test:channel')).toBe(true);
    }
  });

  test('throws when rate limit exceeded', () => {
    for (let i = 0; i < 5; i++) {
      limiter.checkRateLimit('test:channel');
    }
    expect(() => limiter.checkRateLimit('test:channel')).toThrow('Rate limit exceeded');
  });

  test('tracks channels independently', () => {
    for (let i = 0; i < 5; i++) {
      limiter.checkRateLimit('channel:a');
    }
    // channel:b should still be under limit
    expect(limiter.checkRateLimit('channel:b')).toBe(true);
  });

  test('rejected request does not inflate counter', () => {
    for (let i = 0; i < 5; i++) {
      limiter.checkRateLimit('test:channel');
    }
    // This should throw but NOT increment counter
    expect(() => limiter.checkRateLimit('test:channel')).toThrow();
    // After window resets, the count should be back to 5 not 6
    expect(limiter.rateLimiter.get('test:channel').count).toBe(5);
  });
});

describe('IpcSanitizer (real)', () => {
  let sanitizer;

  beforeEach(() => {
    sanitizer = createIpcSanitizer({
      log: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() }
    });
  });

  test('blocks path traversal attempts', () => {
    const result = sanitizer.sanitizeObject('C:\\Users\\..\\Windows\\System32', true);
    expect(result).toBe('');
  });

  test('blocks encoded path traversal', () => {
    const result = sanitizer.sanitizeObject('C:\\Users\\%2e%2e\\Windows\\System32', true);
    expect(result).toBe('');
  });

  test('blocks double-encoded path traversal', () => {
    const result = sanitizer.sanitizeObject('C:\\Users\\%252e%252e\\admin', true);
    expect(result).toBe('');
  });

  test('blocks Unix path traversal', () => {
    const result = sanitizer.sanitizeObject('/home/../etc/passwd', true);
    expect(result).toBe('');
  });

  test('allows safe file paths', () => {
    const result = sanitizer.sanitizeObject('C:\\Users\\test\\Documents\\file.pdf', true);
    expect(result).toContain('file.pdf');
    expect(result).not.toBe('');
  });

  test('strips script tags from HTML strings', () => {
    const result = sanitizer.sanitizeObject('<script>alert("xss")</script>hello');
    expect(result).not.toContain('<script>');
    expect(result).toContain('hello');
  });

  test('blocks prototype pollution keys', () => {
    const result = sanitizer.sanitizeObject({
      __proto__: { polluted: true },
      constructor: 'bad',
      safe: 'value'
    });
    // __proto__ and constructor should NOT exist as own properties on the result
    expect(Object.hasOwn(result, '__proto__')).toBe(false);
    expect(Object.hasOwn(result, 'constructor')).toBe(false);
    expect(result.safe).toBe('value');
  });

  test('strips control characters from strings', () => {
    const result = sanitizer.stripControlChars('hello\x00\x01world');
    expect(result).toBe('helloworld');
  });

  test('preserves tab, newline, carriage return', () => {
    const result = sanitizer.stripControlChars('hello\tworld\nfoo\rbar');
    expect(result).toBe('hello\tworld\nfoo\rbar');
  });

  test('sanitizeArguments processes array of mixed args', () => {
    const result = sanitizer.sanitizeArguments([
      'C:\\Users\\test\\file.pdf',
      '<script>bad</script>text',
      { path: '/safe/file.txt', html: '<b>bold</b>' }
    ]);
    expect(result).toHaveLength(3);
    // File path preserved (no traversal)
    expect(result[0]).toContain('file.pdf');
    // Script tags stripped
    expect(result[1]).not.toContain('<script>');
    expect(result[1]).toContain('text');
  });

  test('respects sanitization depth limit', () => {
    // Build deeply nested object exceeding MAX_SANITIZE_DEPTH (32)
    let obj = { value: 'deep' };
    for (let i = 0; i < 40; i++) {
      obj = { nested: obj };
    }
    // Should not throw — returns safe fallback at depth limit
    const result = sanitizer.sanitizeObject(obj);
    expect(result).toBeDefined();
  });
});
