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

  // A chat question or a description that mentions a Windows path is prose,
  // not a path. Blanking it made main answer "Query must be at least 2
  // characters" for a long question, and saved descriptions empty.
  describe('free-text fields that mention a path', () => {
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { ...realPlatform, value: 'win32' });
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', realPlatform);
    });

    test.each([
      ['query', 'What is in D:\\Docs\\Taxes?'],
      ['query', 'find invoices under Scans\\2024\\*.pdf'],
      ['query', 'C:\\Users\\me what is this?'],
      ['query', 'look in Docs\\..\\Old'],
      ['description', 'Files from C:\\Scans\\*.pdf'],
      ['text', 'Anything under \\\\NAS\\Docs | Archive?'],
      ['message', 'Could not open C:\\Scans\\a?.pdf'],
      ['note', 'Wrong folder, should be D:\\Taxes\\2024?']
    ])('keeps %s text unchanged: %s', (key, value) => {
      const log = { warn: jest.fn() };
      const { sanitizeArguments } = createIpcSanitizer({ log });
      const [sanitized] = sanitizeArguments([{ [key]: value }]);
      expect(sanitized[key]).toBe(value);
      expect(log.warn).not.toHaveBeenCalled();
    });

    test('keeps free text inside nested payloads and arrays', () => {
      const log = { warn: jest.fn() };
      const { sanitizeArguments } = createIpcSanitizer({ log });
      const [sanitized] = sanitizeArguments([
        {
          folder: { description: 'Scans from C:\\Scans\\*.pdf' },
          text: ['Is D:\\Docs\\a.pdf here?']
        }
      ]);
      expect(sanitized.folder.description).toBe('Scans from C:\\Scans\\*.pdf');
      expect(sanitized.text).toEqual(['Is D:\\Docs\\a.pdf here?']);
    });

    test('still strips script tags and control characters from free text', () => {
      const log = { warn: jest.fn() };
      const { sanitizeArguments } = createIpcSanitizer({ log });
      const [sanitized] = sanitizeArguments([
        { query: 'What is in D:\\Docs?\u0007<script>alert(1)</script>' }
      ]);
      expect(sanitized.query).toBe('What is in D:\\Docs?');
    });

    test.each([
      ['a path key with an invalid character', { filePath: 'C:\\a?b.txt' }, 'filePath'],
      ['a path key with traversal', { folderPath: 'C:\\safe\\..\\evil' }, 'folderPath'],
      ['a source with an invalid character', { source: 'C:\\a?b.txt' }, 'source'],
      ['a source with traversal', { source: 'C:\\safe\\..\\evil.txt' }, 'source'],
      ['a destination with traversal', { destination: 'Docs\\..\\..\\evil.txt' }, 'destination'],
      ['a destination with a wildcard', { destination: 'D:\\Out\\*.pdf' }, 'destination']
    ])('still blanks %s', (_label, payload, key) => {
      const log = { warn: jest.fn() };
      const { sanitizeArguments } = createIpcSanitizer({ log });
      const [sanitized] = sanitizeArguments([payload]);
      expect(sanitized[key]).toBe('');
      expect(log.warn).toHaveBeenCalled();
    });

    test('a path key nested under a free-text key is still treated as a path', () => {
      const log = { warn: jest.fn() };
      const { sanitizeArguments } = createIpcSanitizer({ log });
      const [sanitized] = sanitizeArguments([{ message: { filePath: 'C:\\safe\\..\\evil.txt' } }]);
      expect(sanitized.message.filePath).toBe('');
    });

    test('a top-level path string is still blanked', () => {
      const log = { warn: jest.fn() };
      const { sanitizeArguments } = createIpcSanitizer({ log });
      expect(sanitizeArguments(['C:\\safe\\..\\evil.txt', 'C:\\a?b.txt'])).toEqual(['', '']);
    });
  });
});
