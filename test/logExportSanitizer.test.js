jest.unmock('../src/shared/logger');

const {
  isTextLogFile,
  sanitizeLogContent,
  _sanitizeLogLine
} = require('../src/main/utils/logExportSanitizer');

describe('logExportSanitizer', () => {
  test('detects text-based log file extensions', () => {
    expect(isTextLogFile('app.log')).toBe(true);
    expect(isTextLogFile('events.JSONL')).toBe(true);
    expect(isTextLogFile('crash.dmp')).toBe(false);
  });

  test('sanitizes plain text log lines containing filesystem paths', () => {
    const line = 'Opening C:\\Users\\alice\\Documents\\secret.txt';
    const sanitized = _sanitizeLogLine(line);
    expect(sanitized).toContain('[REDACTED_PATH]\\secret.txt');
    expect(sanitized).not.toContain('alice');
  });

  test('sanitizes JSON log lines with sensitive fields', () => {
    const line = JSON.stringify({
      msg: 'request complete',
      token: 'abc123',
      sessionId: 'sid-123',
      nested: {
        password: 'hunter2',
        source: '/Users/alice/private/notes.md'
      }
    });

    const sanitized = JSON.parse(_sanitizeLogLine(line));
    expect(sanitized.token).toBe('[REDACTED]');
    expect(sanitized.sessionId).toBe('[REDACTED]');
    expect(sanitized.nested.password).toBe('[REDACTED]');
    expect(sanitized.nested.source).toBe('[REDACTED_PATH]/notes.md');
  });

  test('sanitizes JWT fragments in non-JSON log lines', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const line = `upstream returned Authorization: Bearer ${jwt}`;
    const sanitized = _sanitizeLogLine(line);
    expect(sanitized).toContain('[REDACTED_JWT]');
    expect(sanitized).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  test('sanitizes each line and preserves line endings', () => {
    const content = [
      'Path C:\\Users\\alice\\Desktop\\todo.txt',
      JSON.stringify({ authorization: 'Bearer secret' }),
      ''
    ].join('\n');

    const sanitized = sanitizeLogContent(content);
    expect(sanitized).toContain('[REDACTED_PATH]\\todo.txt');
    expect(sanitized).toContain('"authorization":"[REDACTED]"');
    expect(sanitized.endsWith('\n')).toBe(true);
  });
});
