/**
 * @jest-environment node
 */
const { createIpcSanitizer } = require('../src/preload/ipcSanitizer');

describe('sanitizeTrustedEventArgs', () => {
  const warn = jest.fn();
  const sanitizer = createIpcSanitizer({ log: { warn } });

  beforeEach(() => warn.mockClear());

  test('keeps quotes, angle brackets, and .. in path payloads', () => {
    const [out] = sanitizer.sanitizeTrustedEventArgs([
      { path: 'C:\\Users\\alex\\file "quoted".pdf', nested: { rel: '..\\other<tag>.txt' } }
    ]);
    expect(out.path).toContain('"quoted"');
    expect(out.nested.rel).toContain('..');
    expect(out.nested.rel).toContain('<tag>');
  });

  test('strips control characters and prototype keys', () => {
    const payload = JSON.parse('{"ok":"a\\u0001b","__proto__":{"polluted":true}}');
    const [out] = sanitizer.sanitizeTrustedEventArgs([payload]);
    expect(out.ok).toBe('ab');
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
  });

  // Same depth budget and fallback shape as the renderer->main invoke path:
  // previously trusted events were cut at depth 20 and silently nulled.
  const buildNested = (depth, leaf) => {
    let value = leaf;
    for (let i = 0; i < depth; i += 1) value = { next: value };
    return value;
  };

  test('keeps payloads at the shared MAX_SANITIZE_DEPTH (32) intact without warning', () => {
    const [out] = sanitizer.sanitizeTrustedEventArgs([buildNested(32, 'leaf\u0001')]);
    let cursor = out;
    for (let i = 0; i < 32; i += 1) cursor = cursor.next;
    expect(cursor).toBe('leaf');
    expect(warn).not.toHaveBeenCalled();
  });

  test('replaces subtrees past the depth cap with the invoke-path fallback and warns', () => {
    const [out] = sanitizer.sanitizeTrustedEventArgs([buildNested(33, ['x'])]);
    let cursor = out;
    for (let i = 0; i < 33; i += 1) cursor = cursor.next;
    // Arrays fall back to [] (not null) — identical to sanitizeObject.
    expect(cursor).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      '[SecureIPC] Sanitization depth limit reached, returning safe fallback value'
    );
  });
});
