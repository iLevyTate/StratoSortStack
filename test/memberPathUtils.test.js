/**
 * Tests for memberPathUtils – shared path/ID extraction and member normalization
 */

const {
  getMemberPath,
  getMemberId,
  safeBasename,
  safeDirname,
  normalizeDuplicateMember
} = require('../src/shared/memberPathUtils');

describe('getMemberPath', () => {
  it('returns .path when present', () => {
    expect(getMemberPath({ path: '/a/b.pdf' })).toBe('/a/b.pdf');
  });

  it('returns .filePath as second priority', () => {
    expect(getMemberPath({ filePath: '/a/c.pdf' })).toBe('/a/c.pdf');
  });

  it('returns .metadata.path as third priority', () => {
    expect(getMemberPath({ metadata: { path: '/m/p.txt' } })).toBe('/m/p.txt');
  });

  it('returns .originalPath as fourth priority', () => {
    expect(getMemberPath({ originalPath: '/orig.txt' })).toBe('/orig.txt');
  });

  it('returns empty string for null/undefined', () => {
    expect(getMemberPath(null)).toBe('');
    expect(getMemberPath(undefined)).toBe('');
  });

  it('returns empty string when no path properties exist', () => {
    expect(getMemberPath({ name: 'test' })).toBe('');
  });
});

describe('getMemberId', () => {
  it('returns .id when present', () => {
    expect(getMemberId({ id: 'abc' })).toBe('abc');
  });

  it('falls back to path when no id', () => {
    expect(getMemberId({ path: '/a/b.pdf' })).toBe('/a/b.pdf');
  });

  it('falls back to explicit fallback', () => {
    expect(getMemberId({}, 'fallback-id')).toBe('fallback-id');
  });

  it('returns empty string for null member with no fallback', () => {
    expect(getMemberId(null)).toBe('');
  });

  it('returns fallback for null member', () => {
    expect(getMemberId(null, 'fb')).toBe('fb');
  });
});

describe('safeBasename', () => {
  it('extracts filename from forward-slash path', () => {
    expect(safeBasename('/usr/local/file.txt')).toBe('file.txt');
  });

  it('extracts filename from backslash path', () => {
    expect(safeBasename('C:\\Users\\file.txt')).toBe('file.txt');
  });

  it('returns the string itself when no slashes', () => {
    expect(safeBasename('file.txt')).toBe('file.txt');
  });

  it('returns empty string for empty input', () => {
    expect(safeBasename('')).toBe('');
  });

  it('returns empty string for non-string input', () => {
    expect(safeBasename(null)).toBe('');
    expect(safeBasename(42)).toBe('');
    expect(safeBasename(undefined)).toBe('');
  });
});

describe('safeDirname', () => {
  it('returns the directory of a forward-slash path', () => {
    expect(safeDirname('/usr/local/file.txt')).toBe('/usr/local');
  });

  it('returns the directory of a backslash path (preserving separators)', () => {
    expect(safeDirname('C:\\Users\\benja\\f.txt')).toBe('C:\\Users\\benja');
  });

  it('returns empty string when there is no parent directory', () => {
    expect(safeDirname('file.txt')).toBe('');
  });

  it('returns empty string for a leading-separator-only path', () => {
    expect(safeDirname('/file.txt')).toBe('');
  });

  it('returns empty string for non-string input', () => {
    expect(safeDirname(null)).toBe('');
    expect(safeDirname(undefined)).toBe('');
    expect(safeDirname(42)).toBe('');
  });
});

describe('normalizeDuplicateMember', () => {
  it('produces consistent shape with path and id', () => {
    const member = { path: '/docs/file.pdf', size: 1024 };
    const result = normalizeDuplicateMember(member, 0, 0);

    expect(result.id).toBe('/docs/file.pdf');
    expect(result.path).toBe('/docs/file.pdf');
    expect(result.name).toBe('file.pdf');
    expect(result.size).toBe(1024);
  });

  it('uses fallback id when member has no id or path', () => {
    const result = normalizeDuplicateMember({}, 2, 5);
    expect(result.id).toBe('dup:5:2');
  });

  it('extracts name from member.name', () => {
    const result = normalizeDuplicateMember({ name: 'custom.txt', path: '/a/b.pdf' }, 0, 0);
    expect(result.name).toBe('custom.txt');
  });

  it('extracts name from member.fileName', () => {
    const result = normalizeDuplicateMember({ fileName: 'fn.txt', path: '/a/b.pdf' }, 0, 0);
    expect(result.name).toBe('fn.txt');
  });

  it('falls back to basename of path for name', () => {
    const result = normalizeDuplicateMember({ path: '/a/doc.pdf' }, 0, 0);
    expect(result.name).toBe('doc.pdf');
  });

  it('coerces size from fileSize', () => {
    const result = normalizeDuplicateMember({ fileSize: '2048' }, 0, 0);
    expect(result.size).toBe(2048);
  });

  it('coerces size from metadata.size', () => {
    const result = normalizeDuplicateMember({ metadata: { size: 512 } }, 0, 0);
    expect(result.size).toBe(512);
  });

  it('leaves size unset when absent', () => {
    const result = normalizeDuplicateMember({}, 0, 0);
    expect(result.size).toBeNull();
  });

  it('preserves explicit zero-byte sizes', () => {
    const result = normalizeDuplicateMember({ size: 0 }, 0, 0);
    expect(result.size).toBe(0);
  });

  it('preserves extra properties from the original member', () => {
    const result = normalizeDuplicateMember({ path: '/a.txt', extra: 'keep' }, 0, 0);
    expect(result.extra).toBe('keep');
  });
});
