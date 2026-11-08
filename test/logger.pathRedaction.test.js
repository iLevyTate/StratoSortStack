/**
 * Path redaction at the logger chokepoint (sanitizeLogData): object keys,
 * home folders, Windows paths that switch separator style, and POSIX paths
 * whose top-level folder has a space. Everything the log file and the Live
 * Activity feed show passes through this function, so a hole here is a leak
 * in both. All paths are synthetic.
 */

// test-setup.js mocks the logger globally; this suite exercises the real one.
jest.unmock('../src/shared/logger');

const { sanitizeLogData } = require('../src/shared/logger');

const USER_NAMES = /jdoe|jane doe|Jane|bob|x-user/i;

describe('sanitizeLogData redacts paths used as object keys', () => {
  test('a Windows path key keeps only its basename', () => {
    const sanitized = sanitizeLogData({ 'C:\\Users\\jdoe\\Docs\\x.pdf': 'ok' });
    expect(sanitized).toEqual({ '[REDACTED_PATH]\\x.pdf': 'ok' });
  });

  test('a POSIX path key keeps only its basename', () => {
    const sanitized = sanitizeLogData({ '/Users/jane doe/Medical Records/x.pdf': 1 });
    expect(sanitized).toEqual({ '[REDACTED_PATH]/x.pdf': 1 });
  });

  test('a UNC path key keeps only its basename', () => {
    const sanitized = sanitizeLogData({ '\\\\server\\share\\jdoe\\x.pdf': true });
    expect(sanitized).toEqual({ '[REDACTED_PATH]\\x.pdf': true });
  });

  test('path keys in a nested per-file map are redacted, values still sanitized', () => {
    const sanitized = sanitizeLogData({
      byPath: {
        'C:\\Users\\jdoe\\Docs\\x.pdf': { status: 'done', dest: 'C:\\Users\\jdoe\\Out\\x.pdf' },
        '/home/x-user/Tax Returns/y.pdf': { status: 'queued' }
      }
    });
    expect(sanitized).toEqual({
      byPath: {
        '[REDACTED_PATH]\\x.pdf': { status: 'done', dest: '[REDACTED_PATH]\\x.pdf' },
        '[REDACTED_PATH]/y.pdf': { status: 'queued' }
      }
    });
    expect(JSON.stringify(sanitized)).not.toMatch(USER_NAMES);
  });

  test('two path keys that reduce to the same text are both kept', () => {
    const sanitized = sanitizeLogData({
      'C:\\Users\\jdoe\\Inbox\\x.pdf': 'a',
      'C:\\Users\\jdoe\\Medical\\x.pdf': 'b'
    });
    expect(Object.values(sanitized).sort()).toEqual(['a', 'b']);
    expect(JSON.stringify(sanitized)).not.toMatch(/jdoe|Inbox|Medical/);
  });

  test('key-name rules still apply to the original key', () => {
    const sanitized = sanitizeLogData({
      password: 'hunter2',
      homeDir: '/Users/jdoe/Library',
      filePath: 'C:\\Users\\jdoe\\Docs\\x.pdf',
      plain: 'value'
    });
    expect(sanitized).toEqual({
      password: '[REDACTED]',
      homeDir: '[REDACTED_PATH]/Library',
      filePath: '[REDACTED_PATH]\\x.pdf',
      plain: 'value'
    });
  });

  test('control characters in a key are neutralized', () => {
    const sanitized = sanitizeLogData({ 'a\nFAKE LINE': 1 });
    expect(Object.keys(sanitized)).toEqual(['a\\nFAKE LINE']);
  });

  test('array indices are left alone', () => {
    expect(sanitizeLogData(['C:\\Users\\jdoe\\x.pdf', 'plain'])).toEqual([
      '[REDACTED_PATH]\\x.pdf',
      'plain'
    ]);
  });
});

describe('sanitizeLogData does not keep the user name of a home folder', () => {
  test.each([
    ['C:\\Users\\jdoe', '[REDACTED_PATH]'],
    ['home C:\\Users\\jdoe', 'home [REDACTED_PATH]'],
    ['home C:\\Users\\jdoe\\', 'home [REDACTED_PATH]\\'],
    ['C:/Users/jdoe', '[REDACTED_PATH]'],
    [
      "ENOENT: no such file or directory, scandir 'C:\\Users\\jdoe'",
      "ENOENT: no such file or directory, scandir '[REDACTED_PATH]'"
    ],
    ['{"rootPath":"C:\\\\Users\\\\jdoe"}', '{"rootPath":"[REDACTED_PATH]"}'],
    ['\\\\server\\home\\jdoe', '[REDACTED_PATH]'],
    ['/Users/jdoe', '[REDACTED_PATH]'],
    ['text /Users/jdoe and /home/bob', 'text [REDACTED_PATH] and [REDACTED_PATH]'],
    ['file:/users/jdoe', 'file:[REDACTED_PATH]'],
    ['/mnt/c/Users/Jane', '[REDACTED_PATH]']
  ])('%s', (raw, expected) => {
    const sanitized = sanitizeLogData(raw);
    expect(sanitized).toBe(expected);
    expect(sanitized).not.toMatch(USER_NAMES);
  });

  test('a home folder under a path-like key is fully redacted', () => {
    expect(
      sanitizeLogData({
        homeDir: 'C:\\Users\\jdoe',
        homePath: '/home/jdoe/',
        homeDirectory: '/Users/jane doe'
      })
    ).toEqual({
      homeDir: '[REDACTED_PATH]',
      homePath: '[REDACTED_PATH]',
      homeDirectory: '[REDACTED_PATH]'
    });
  });

  test('a home folder under an ordinary key is fully redacted', () => {
    expect(sanitizeLogData({ path: 'C:\\Users\\jdoe', isUNC: false })).toEqual({
      path: '[REDACTED_PATH]',
      isUNC: false
    });
  });

  test.each([
    ['C:\\Users\\jdoe\\Documents', '[REDACTED_PATH]\\Documents'],
    ['/Users/jdoe/Documents', '[REDACTED_PATH]/Documents'],
    ['C:\\Users', '[REDACTED_PATH]\\Users']
  ])('a folder below the home folder still keeps its name: %s', (raw, expected) => {
    expect(sanitizeLogData(raw)).toBe(expected);
  });
});

describe('sanitizeLogData redacts Windows paths that switch separator style', () => {
  test.each([
    ['mixed C:\\Users\\jdoe/Documents/x.pdf', 'mixed [REDACTED_PATH]/x.pdf'],
    ['mixed C:/Users/jdoe\\Documents\\x.pdf', 'mixed [REDACTED_PATH]\\x.pdf'],
    ['C:\\Users\\jdoe/x.pdf', '[REDACTED_PATH]/x.pdf'],
    ['C:\\Users\\jdoe\\Documents/Finance/x.pdf', '[REDACTED_PATH]/x.pdf'],
    [
      'join C:\\Users\\jdoe\\AppData\\Roaming\\stratosort/vectors/index.json',
      'join [REDACTED_PATH]/index.json'
    ],
    ['C:\\Users\\jdoe/My Docs/x.pdf', '[REDACTED_PATH]/x.pdf'],
    ['\\\\server\\share\\jdoe/Docs/x.pdf', '[REDACTED_PATH]/x.pdf'],
    ['C:\\PROGRA~1/a b/c', '[REDACTED_PATH]/c'],
    ['{"p":"C:\\\\Users\\\\jdoe/Documents/x.pdf"}', '{"p":"[REDACTED_PATH]/x.pdf"}']
  ])('%s', (raw, expected) => {
    const sanitized = sanitizeLogData(raw);
    expect(sanitized).toBe(expected);
    expect(sanitized).not.toMatch(/jdoe|Users|Documents|AppData|server|share/);
  });

  test.each([
    [
      'Moved C:\\Users\\Bob\\a.pdf to Finance/Taxes',
      'Moved [REDACTED_PATH]\\a.pdf to Finance/Taxes'
    ],
    [
      'Loaded C:\\Models\\qwen.gguf in 300ms (gpu=yes, 50% layers/offload)',
      'Loaded [REDACTED_PATH]\\qwen.gguf in 300ms (gpu=yes, 50% layers/offload)'
    ],
    [
      'payload {"from":"C:\\\\Users\\\\Bob\\\\a.pdf","note":"12/40"}',
      'payload {"from":"[REDACTED_PATH]\\\\a.pdf","note":"12/40"}'
    ]
  ])('a name with a space before the other separator still ends the path: %s', (raw, expected) => {
    expect(sanitizeLogData(raw)).toBe(expected);
  });

  test('stays linear on long hostile mixed-separator inputs', () => {
    const hostile = [
      'C:\\a/'.repeat(12000),
      'C:\\' + 'a/b\\'.repeat(12000),
      'C:/' + 'a\\b/'.repeat(12000) + ' ',
      '\\\\s\\h' + '/a\\b'.repeat(12000)
    ];
    for (const input of hostile) {
      const start = Date.now();
      expect(typeof sanitizeLogData(input)).toBe('string');
      expect(Date.now() - start).toBeLessThan(500);
    }
  });
});

describe('sanitizeLogData redacts POSIX paths whose top-level folder has a space', () => {
  test.each([
    ['/Shared Drives/Team X/x.pdf', '[REDACTED_PATH]/x.pdf'],
    ['open /Shared Drives/Team X/x.pdf', 'open [REDACTED_PATH]/x.pdf'],
    ['/Shared Drives/x.pdf', '[REDACTED_PATH]/x.pdf'],
    ['/Shared Drives/Team X/Sub/x.pdf', '[REDACTED_PATH]/x.pdf'],
    [
      'Failed to read /Shared Drives/Team X/x.pdf: ENOENT',
      'Failed to read [REDACTED_PATH]/x.pdf: ENOENT'
    ],
    ['file:/shared drives/team x/x.pdf', 'file:[REDACTED_PATH]/x.pdf'],
    [
      "copy '/Team Share/a/x.pdf' '/Team Share/b/y.pdf'",
      "copy '[REDACTED_PATH]/x.pdf' '[REDACTED_PATH]/y.pdf'"
    ],
    ['Moved /Team Share/x.pdf to Finance/Taxes', 'Moved [REDACTED_PATH]/x.pdf to Finance/Taxes']
  ])('%s', (raw, expected) => {
    const sanitized = sanitizeLogData(raw);
    expect(sanitized).toBe(expected);
    expect(sanitized).not.toMatch(/Shared|Drives|Team|Sub/i);
  });

  test('the same path as an object field is redacted', () => {
    expect(sanitizeLogData({ path: '/Shared Drives/Team X/x.pdf' })).toEqual({
      path: '[REDACTED_PATH]/x.pdf'
    });
  });

  test.each([
    ['read/write and/or'],
    ['use /tmp or /var for scratch'],
    ['the /Users folder and /home dir'],
    ['the /a b c route'],
    ['ratio 3:4 at 10:30 (12/40)']
  ])('leaves prose without a path as it was: %s', (raw) => {
    expect(sanitizeLogData(raw)).toBe(raw);
  });

  test('stays linear on long hostile inputs', () => {
    const hostile = [
      '/a b'.repeat(16000),
      ' /a b'.repeat(16000) + '/',
      '/a b/'.repeat(12000),
      '/a ' + 'b '.repeat(25000) + '/',
      "'/a b/" + 'c d '.repeat(12000)
    ];
    for (const input of hostile) {
      const start = Date.now();
      expect(typeof sanitizeLogData(input)).toBe('string');
      expect(Date.now() - start).toBeLessThan(500);
    }
  });
});
