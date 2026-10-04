const { createIpcSanitizer } = require('../src/preload/ipcSanitizer');

describe('ipcSanitizer', () => {
  test('sanitizes control characters but preserves newlines', () => {
    const log = { warn: jest.fn() };
    const { sanitizeArguments } = createIpcSanitizer({ log });
    const input = 'hello\u0007\nworld';
    const [sanitized] = sanitizeArguments([input]);
    expect(sanitized).toBe('hello\nworld');
  });

  test('rejects path traversal segments with empty string', () => {
    const log = { warn: jest.fn() };
    const { sanitizeArguments } = createIpcSanitizer({ log });
    const [sanitized] = sanitizeArguments(['C:\\safe\\..\\evil.txt']);
    expect(sanitized).toBe('');
    expect(log.warn).toHaveBeenCalled();
  });

  test('blocks dangerous object keys', () => {
    const log = { warn: jest.fn() };
    const { sanitizeArguments } = createIpcSanitizer({ log });
    const [sanitized] = sanitizeArguments([{ __proto__: { admin: true }, ok: 1 }]);
    expect(Object.prototype.hasOwnProperty.call(sanitized, '__proto__')).toBe(false);
    expect(sanitized.ok).toBe(1);
  });

  test('sanitizes html content but preserves comparisons', () => {
    const log = { warn: jest.fn() };
    const { sanitizeArguments } = createIpcSanitizer({ log });
    const [sanitized] = sanitizeArguments(['size < 10MB']);
    expect(sanitized).toBe('size < 10MB');
  });

  test('fails closed on invalid path characters instead of silently renaming the file', () => {
    const log = { warn: jest.fn() };
    const { sanitizeObject } = createIpcSanitizer({ log });
    // POSIX treats <>" as legal filename chars; the old code stripped them and
    // returned "/home/user/ab.txt" — a different, real file. It must reject.
    const result = sanitizeObject('/home/user/a<b>.txt', true);
    expect(result).toBe('');
    expect(log.warn).toHaveBeenCalled();
  });

  test('returns the original path (percent-decode is detection-only)', () => {
    const log = { warn: jest.fn() };
    const { sanitizeObject } = createIpcSanitizer({ log });
    // %20 is decoded only to DETECT obfuscated traversal; the returned value
    // must stay the literal on-disk path, not the decoded "report final.txt".
    const result = sanitizeObject('/home/user/report%20final.txt', true);
    expect(result).toBe('/home/user/report%20final.txt');
  });
});
