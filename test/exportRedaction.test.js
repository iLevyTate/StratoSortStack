jest.unmock('../src/shared/logger');

const {
  deepSanitizeForExport,
  redactInlineSecrets,
  sanitizeExportText
} = require('../src/shared/exportRedaction');

describe('exportRedaction', () => {
  test('redacts export-only sensitive keys (e.g. sessionId)', () => {
    const out = deepSanitizeForExport({ sessionId: 'abc123', ok: 'yes' });
    expect(out.sessionId).toBe('[REDACTED]');
    expect(out.ok).toBe('yes');
  });

  test('redacts JWT and Bearer substrings in plain text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.payload.signature';
    const text = `Use Bearer abcdefghijklmnop and ${jwt} here`;
    const out = redactInlineSecrets(text);
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).toContain('[REDACTED_JWT]');
    expect(out).not.toContain('abcdefghijklmnop');
    expect(out).not.toContain(jwt);
  });

  test('sanitizeExportText matches deepSanitizeForExport for strings', () => {
    const s = 'Path C:\\Users\\x\\doc.pdf token in Bearer xyz123456789012345';
    const a = sanitizeExportText(s);
    const b = deepSanitizeForExport(s);
    expect(a).toBe(b);
    expect(a).toContain('[REDACTED_PATH]\\doc.pdf');
    expect(a).toContain('Bearer [REDACTED]');
  });

  test('fully redacts a slash-containing Bearer token (secrets redacted before path rewrite)', () => {
    // A Bearer token whose body contains `/` (legal per the Bearer char class).
    // Under the old path-redaction-first order, `sanitizeLogData` rewrote the
    // `/def/ghijklmnop` tail to `[REDACTED_PATH]/ghijklmnop`, which broke the
    // `\bBearer\s+...{8,}\b` anchor and left `abc` + `ghijklmnop` in the output.
    const out = deepSanitizeForExport('Bearer abc/def/ghijklmnop');
    expect(out).toBe('Bearer [REDACTED]');
    expect(out).not.toContain('ghijklmnop');
    expect(out).not.toContain('abc');
  });

  test('recurses nested objects and arrays', () => {
    const out = deepSanitizeForExport({
      items: [{ cookie: 'secret', name: 'a' }],
      path: '/home/u/file.txt'
    });
    expect(out.items[0].cookie).toBe('[REDACTED]');
    expect(out.items[0].name).toBe('a');
    expect(out.path).toBe('[REDACTED_PATH]/file.txt');
  });
});
