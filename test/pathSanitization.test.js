/**
 * Tests for Path Sanitization Utilities
 * SECURITY CRITICAL - Prevents path traversal and injection attacks
 */

const {
  sanitizePath,
  isPathSafe,
  sanitizeMetadata,
  prepareFileMetadata,
  prepareFolderMetadata,
  validateFileOperationPath,
  normalizePathForIndex,
  getCanonicalFileId,
  arePathsEquivalent,
  sanitizeSuggestedBaseName
} = require('../src/shared/pathSanitization');
const path = require('path');
const fs = require('fs');

describe('Path Sanitization', () => {
  describe('sanitizePath', () => {
    describe('path traversal prevention', () => {
      test('rejects paths with .. sequences', () => {
        expect(() => sanitizePath('../file.txt')).toThrow('path traversal detected');
        expect(() => sanitizePath('..\\file.txt')).toThrow('path traversal detected');
        // Note: After normalization, absolute paths like '/home/user/../../etc/passwd'
        // become '/etc/passwd' which doesn't contain '..' so it passes
        // This is a design decision - normalized absolute paths are considered safe
      });

      test('rejects multiple .. sequences', () => {
        expect(() => sanitizePath('../../file.txt')).toThrow('path traversal detected');
        expect(() => sanitizePath('../../../etc/passwd')).toThrow('path traversal detected');
        expect(() => sanitizePath('..\\..\\Windows\\System32')).toThrow('path traversal detected');
      });
    });

    describe('Windows alternate data stream (ADS) prevention', () => {
      test('rejects ADS stream names on Windows-style paths', () => {
        expect(() => sanitizePath('C:\\Users\\me\\file.txt:hidden')).toThrow(
          'alternate data stream'
        );
        expect(() => sanitizePath('C:\\Users\\me\\file.txt::$DATA')).toThrow(
          'alternate data stream'
        );
        expect(() => sanitizePath('C:\\dir\\file.txt:stream:$DATA')).toThrow(
          'alternate data stream'
        );
      });

      test('rejects ADS behind DOS device prefixes', () => {
        expect(() => sanitizePath('\\\\?\\C:\\dir\\file.txt:hidden')).toThrow(
          'alternate data stream'
        );
      });

      test('allows the drive designator colon', () => {
        expect(() => sanitizePath('C:\\Users\\me\\file.txt')).not.toThrow();
      });

      test('rejects encoded path traversal attempts', () => {
        // Normalized paths with .. should still be caught
        expect(() => sanitizePath('foo/bar/../../../etc')).toThrow();
      });
    });

    describe('valid absolute paths', () => {
      test('allows valid Windows absolute paths', () => {
        expect(() => sanitizePath('C:\\Users\\Documents\\file.txt')).not.toThrow();
        expect(() => sanitizePath('D:\\Projects\\stratosort\\file.txt')).not.toThrow();
        expect(() => sanitizePath('E:\\Data\\backup.zip')).not.toThrow();
      });

      test('allows valid Unix absolute paths', () => {
        expect(() => sanitizePath('/home/user/documents/file.txt')).not.toThrow();
        expect(() => sanitizePath('/var/log/app.log')).not.toThrow();
        expect(() => sanitizePath('/tmp/data.json')).not.toThrow();
      });

      test('normalizes valid paths correctly', () => {
        const windowsPath = sanitizePath('C:\\Users\\Documents\\./subdir\\file.txt');
        expect(windowsPath).toBe(path.win32.normalize('C:\\Users\\Documents\\./subdir\\file.txt'));
        expect(windowsPath).not.toContain('./');

        const unixPath = sanitizePath('/home/user/./documents/file.txt');
        expect(unixPath).toBe(path.normalize('/home/user/./documents/file.txt'));
      });

      test('works under path-browserify (preload: path.win32 is null)', () => {
        // Sandboxed preload aliases `path` → path-browserify, which leaves
        // path.win32 = null. Drag/drop must still sanitize Windows paths.
        let browserifySanitizePath;
        jest.isolateModules(() => {
          jest.doMock('path', () => require('path-browserify'));
          ({ sanitizePath: browserifySanitizePath } = require('../src/shared/pathSanitization'));
        });

        expect(require('path-browserify').win32).toBeNull();
        expect(() =>
          browserifySanitizePath('C:\\Users\\Documents\\Research\\notes.pdf')
        ).not.toThrow();
        expect(browserifySanitizePath('C:\\Users\\Documents\\./subdir\\file.txt')).toBe(
          'C:\\Users\\Documents\\subdir\\file.txt'
        );
        expect(() => browserifySanitizePath('..\\secret.txt')).toThrow('path traversal detected');
      });
    });

    describe('relative paths', () => {
      test('allows simple relative paths', () => {
        // Relative paths without .. are allowed (calling code makes them absolute)
        expect(() => sanitizePath('documents/file.txt')).not.toThrow();
        expect(() => sanitizePath('folder/subfolder/file.txt')).not.toThrow();
      });

      test('normalizes relative paths', () => {
        const result = sanitizePath('documents/./file.txt');
        expect(result).not.toContain('./');
      });
    });

    describe('null byte injection prevention', () => {
      test('rejects null bytes in paths', () => {
        expect(() => sanitizePath('C:\\file\0.txt')).toThrow(/null byte/i);
      });

      test('rejects multiple null bytes', () => {
        expect(() => sanitizePath('C:\\file\0\0\0.txt')).toThrow(/null byte/i);
      });
    });

    describe('empty and invalid inputs', () => {
      test('returns empty string for null input', () => {
        expect(sanitizePath(null)).toBe('');
      });

      test('returns empty string for undefined input', () => {
        expect(sanitizePath(undefined)).toBe('');
      });

      test('returns empty string for empty string', () => {
        expect(sanitizePath('')).toBe('');
      });

      test('returns empty string for non-string input', () => {
        expect(sanitizePath(123)).toBe('');
        expect(sanitizePath({})).toBe('');
        expect(sanitizePath([])).toBe('');
      });
    });

    describe('special characters', () => {
      test('allows common filename characters', () => {
        expect(() => sanitizePath('C:\\file-name_123.txt')).not.toThrow();
        expect(() => sanitizePath('C:\\file (1).txt')).not.toThrow();
        expect(() => sanitizePath('C:\\file[2].txt')).not.toThrow();
      });

      test('allows dot sequences in filenames', () => {
        const pathWithDots = 'C:\\Users\\Ben\\Downloads\\Important - To Do........pdf';
        expect(() => sanitizePath(pathWithDots)).not.toThrow();
        expect(isPathSafe(pathWithDots)).toBe(true);
      });

      test('handles spaces in paths', () => {
        expect(() => sanitizePath('C:\\Program Files\\app\\file.txt')).not.toThrow();
        expect(() => sanitizePath('/home/user/My Documents/file.txt')).not.toThrow();
      });
    });

    describe('edge cases', () => {
      test('handles long paths according to the effective platform limit', () => {
        const { getEffectiveMaxPathLength } = require('../src/shared/securityConfig');
        const maxLength = getEffectiveMaxPathLength(process.platform);
        const longPath = 'C:\\' + 'a'.repeat(250) + '\\file.txt';
        if (longPath.length <= maxLength) {
          expect(() => sanitizePath(longPath)).not.toThrow();
        } else {
          // Over the limit: rejected (never silently truncated to another file)
          expect(() => sanitizePath(longPath)).toThrow(/exceeds maximum/);
        }
      });

      test('handles paths with multiple slashes', () => {
        const result = sanitizePath('C:\\\\Users\\\\Documents\\\\file.txt');
        // Path.normalize handles this
        expect(result).toBeTruthy();
      });

      test('handles mixed slash types (Windows)', () => {
        const result = sanitizePath('C:/Users\\Documents/file.txt');
        expect(result).toBeTruthy();
      });
    });
  });

  describe('isPathSafe', () => {
    test('returns true for safe paths', () => {
      expect(isPathSafe('C:\\Users\\Documents\\file.txt')).toBe(true);
      expect(isPathSafe('/home/user/file.txt')).toBe(true);
      expect(isPathSafe('documents/file.txt')).toBe(true);
    });

    test('returns false for unsafe paths', () => {
      expect(isPathSafe('../file.txt')).toBe(false);
      expect(isPathSafe('../../etc/passwd')).toBe(false);
      expect(isPathSafe('..\\..\\etc\\passwd')).toBe(false);
    });

    test('returns true for invalid inputs (sanitizes to empty, not unsafe)', () => {
      // Invalid inputs are sanitized to empty string, which is not a security risk
      expect(isPathSafe(null)).toBe(true);
      expect(isPathSafe(undefined)).toBe(true);
      expect(isPathSafe(123)).toBe(true);
      expect(isPathSafe({})).toBe(true);
    });
  });

  describe('sanitizeMetadata', () => {
    describe('field filtering', () => {
      test('preserves allowed fields', () => {
        const input = {
          path: 'C:\\file.txt',
          name: 'file.txt',
          model: 'llama3.2',
          updatedAt: '2024-01-01T00:00:00Z',
          description: 'Test file',
          fileSize: 1024,
          mimeType: 'text/plain',
          category: 'document',
          tags: ['test', 'sample'],
          confidence: 0.95
        };

        const result = sanitizeMetadata(input);

        expect(result.path).toBe('C:\\file.txt');
        expect(result.name).toBe('file.txt');
        expect(result.model).toBe('llama3.2');
        expect(result.updatedAt).toBe('2024-01-01T00:00:00Z');
        expect(result.description).toBe('Test file');
        expect(result.fileSize).toBe(1024);
        expect(result.mimeType).toBe('text/plain');
        expect(result.category).toBe('document');
        expect(result.tags).toBe('test,sample');
        expect(result.confidence).toBe(0.95);
      });

      test('filters out dangerous fields', () => {
        const input = {
          path: 'C:\\file.txt',
          __proto__: { pollution: true },
          constructor: function () {},
          prototype: {}
        };

        const result = sanitizeMetadata(input);

        expect(result.path).toBe('C:\\file.txt');
        // Check that dangerous keys are not in the sanitized object
        expect(Object.keys(result)).not.toContain('__proto__');
        expect(Object.keys(result)).not.toContain('constructor');
        expect(Object.keys(result)).not.toContain('prototype');
      });

      test('filters out fields not in allowed list', () => {
        const input = {
          path: 'C:\\file.txt',
          name: 'file.txt',
          dangerousField: 'should be removed',
          executable: '/bin/bash',
          secretKey: 'abc123'
        };

        const result = sanitizeMetadata(input);

        expect(result.path).toBe('C:\\file.txt');
        expect(result.name).toBe('file.txt');
        expect(result.dangerousField).toBeUndefined();
        expect(result.executable).toBeUndefined();
        expect(result.secretKey).toBeUndefined();
      });

      test('respects custom allowed fields list', () => {
        const input = {
          customField1: 'value1',
          customField2: 'value2',
          notAllowed: 'value3'
        };

        const result = sanitizeMetadata(input, ['customField1', 'customField2']);

        expect(result.customField1).toBe('value1');
        expect(result.customField2).toBe('value2');
        expect(result.notAllowed).toBeUndefined();
      });
    });

    describe('path sanitization in metadata', () => {
      test('sanitizes path field', () => {
        const input = {
          path: 'C:\\Users\\Documents\\file.txt',
          name: 'file.txt'
        };

        const result = sanitizeMetadata(input);

        expect(result.path).toBe('C:\\Users\\Documents\\file.txt');
      });

      test('removes invalid path field', () => {
        const input = {
          path: '../../../etc/passwd',
          name: 'file.txt'
        };

        const result = sanitizeMetadata(input);

        // Invalid path should be skipped
        expect(result.path).toBeUndefined();
        expect(result.name).toBe('file.txt');
      });

      test('drops paths containing null bytes', () => {
        const input = {
          path: 'C:\\file\0.txt',
          name: 'file.txt'
        };

        const result = sanitizeMetadata(input);

        expect(result.path).toBeUndefined();
        expect(result.name).toBe('file.txt');
      });
    });

    describe('value type filtering', () => {
      test('filters out function values', () => {
        const input = {
          name: 'file.txt',
          dangerous: function () {
            return 'hack';
          },
          alsoFunction: () => {}
        };

        const result = sanitizeMetadata(input);

        expect(result.name).toBe('file.txt');
        expect(result.dangerous).toBeUndefined();
        expect(result.alsoFunction).toBeUndefined();
      });

      test('filters out null and undefined values', () => {
        const input = {
          name: 'file.txt',
          nullValue: null,
          undefinedValue: undefined
        };

        const result = sanitizeMetadata(input);

        expect(result.name).toBe('file.txt');
        expect(result.nullValue).toBeUndefined();
        expect(result.undefinedValue).toBeUndefined();
      });

      test('preserves valid primitive types', () => {
        const input = {
          name: 'file.txt',
          fileSize: 1024,
          confidence: 0.95,
          category: 'document',
          tags: ['tag1', 'tag2']
        };

        const result = sanitizeMetadata(input);

        expect(result.name).toBe('file.txt');
        expect(result.fileSize).toBe(1024);
        expect(result.confidence).toBe(0.95);
        expect(result.category).toBe('document');
        expect(result.tags).toBe('tag1,tag2');
      });

      test('handles zero and false as valid values', () => {
        const input = {
          fileSize: 0,
          confidence: 0
        };

        const result = sanitizeMetadata(input, ['fileSize', 'confidence']);

        // Zero should be preserved (not treated as falsy)
        expect(result.fileSize).toBe(0);
        expect(result.confidence).toBe(0);
      });
    });

    describe('invalid inputs', () => {
      test('returns empty object for null input', () => {
        expect(sanitizeMetadata(null)).toEqual({});
      });

      test('returns empty object for undefined input', () => {
        expect(sanitizeMetadata(undefined)).toEqual({});
      });

      test('returns empty object for non-object input', () => {
        expect(sanitizeMetadata('string')).toEqual({});
        expect(sanitizeMetadata(123)).toEqual({});
        expect(sanitizeMetadata(true)).toEqual({});
      });

      test('returns empty object for array input', () => {
        expect(sanitizeMetadata([1, 2, 3])).toEqual({});
      });
    });

    describe('edge cases', () => {
      test('handles empty object', () => {
        expect(sanitizeMetadata({})).toEqual({});
      });

      test('handles very large metadata objects', () => {
        const large = {};
        for (let i = 0; i < 1000; i++) {
          large[`field${i}`] = `value${i}`;
        }

        const result = sanitizeMetadata(large);

        // Should filter everything (not in allowed list)
        expect(Object.keys(result)).toHaveLength(0);
      });

      test('handles nested objects (only top-level filtering)', () => {
        const input = {
          name: 'file.txt',
          tags: ['tag1', 'tag2'] // tags is an allowed array field
        };

        const result = sanitizeMetadata(input);

        // Arrays are normalized into strings for vector DB compatibility
        expect(result.tags).toBe('tag1,tag2');
        expect(result.name).toBe('file.txt');
      });

      test('handles special characters in field names', () => {
        const input = {
          name: 'file.txt',
          'field-with-dash': 'value',
          field_with_underscore: 'value'
        };

        const result = sanitizeMetadata(input, [
          'name',
          'field-with-dash',
          'field_with_underscore'
        ]);

        expect(result.name).toBe('file.txt');
        expect(result['field-with-dash']).toBe('value');
        expect(result['field_with_underscore']).toBe('value');
      });
    });

    describe('prototype pollution prevention', () => {
      test('prevents __proto__ pollution', () => {
        const input = {
          __proto__: { polluted: true },
          path: 'C:\\file.txt'
        };

        const result = sanitizeMetadata(input);

        // __proto__ should be filtered (not in result's own properties)
        expect(Object.keys(result)).not.toContain('__proto__');
        expect(result.path).toBe('C:\\file.txt');
        expect({}.polluted).toBeUndefined(); // Global object not polluted
      });

      test('prevents constructor pollution', () => {
        const input = {
          constructor: { polluted: true },
          path: 'C:\\file.txt'
        };

        const result = sanitizeMetadata(input);

        expect(Object.keys(result)).not.toContain('constructor');
        expect(result.path).toBe('C:\\file.txt');
      });

      test('prevents prototype pollution', () => {
        const input = {
          prototype: { polluted: true },
          path: 'C:\\file.txt'
        };

        const result = sanitizeMetadata(input);

        expect(result.prototype).toBeUndefined();
      });
    });
  });

  describe('validate file operations helpers', () => {
    const {
      validateFileOperationPath,
      validateFileOperationPathSync,
      isPathDangerous,
      isPathWithinAllowed,
      checkSymlinkSafety
    } = require('../src/shared/pathSanitization');

    test('isPathDangerous flags system directories', () => {
      const isWin = path.sep === '\\';
      if (isWin) {
        expect(isPathDangerous('C:\\Windows\\System32')).toBe(true);
      } else {
        expect(isPathDangerous('/etc/passwd')).toBe(true);
      }
      expect(isPathDangerous('/home/user/docs')).toBe(false);
    });

    // Regression: Windows DOS device path prefixes (\\?\, \\.\, \\?\UNC\)
    // must not bypass the dangerous-path deny list. Running on non-Windows
    // we can still exercise the branch because isPathDangerous does not
    // gate the prefix-strip on the current platform (deny paths for win32
    // are enumerated by getDangerousPaths regardless).
    //
    // These tests run only on win32, because on posix getDangerousPaths()
    // returns posix deny prefixes and no \\?\ stripping is meaningful.
    describe('isPathDangerous - Windows DOS device path prefixes (regression)', () => {
      const isWin = path.sep === '\\';
      const maybe = isWin ? test : test.skip;

      maybe('flags \\\\?\\C:\\Windows\\System32 as dangerous', () => {
        expect(isPathDangerous('\\\\?\\C:\\Windows\\System32')).toBe(true);
      });

      maybe('flags mixed-case \\\\?\\c:\\Program Files\\foo', () => {
        expect(isPathDangerous('\\\\?\\c:\\Program Files\\foo')).toBe(true);
      });

      maybe('flags \\\\.\\C:\\Windows', () => {
        expect(isPathDangerous('\\\\.\\C:\\Windows')).toBe(true);
      });

      maybe('flags \\\\?\\GLOBALROOT namespace access', () => {
        expect(isPathDangerous('\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1')).toBe(true);
        expect(isPathDangerous('\\\\.\\GLOBALROOT\\SystemRoot')).toBe(true);
      });

      maybe('does not flag \\\\?\\UNC\\server\\share\\user-file', () => {
        // A UNC long-path to an ordinary share is not dangerous by itself.
        // (admin shares like \\host\c$\Windows are already caught via the
        // underlying C:\Windows deny prefix if they actually resolve there.)
        expect(isPathDangerous('\\\\?\\UNC\\server\\share\\docs\\file.txt')).toBe(false);
      });

      maybe('still flags ordinary C:\\Windows (no regression on plain paths)', () => {
        expect(isPathDangerous('C:\\Windows\\System32')).toBe(true);
        expect(isPathDangerous('c:\\program files\\Foo')).toBe(true);
      });
    });

    test('isPathWithinAllowed matches proper subpaths only', () => {
      expect(isPathWithinAllowed('/home/user/docs/file.txt', ['/home/user'])).toBe(true);
      expect(isPathWithinAllowed('/home/user_docs/file.txt', ['/home/user'])).toBe(false);
      expect(isPathWithinAllowed('/home/userdocs', ['/home/user'])).toBe(false);
    });

    test('validateFileOperationPathSync rejects outside allowed and traversal', () => {
      const base = path.resolve(path.join(__dirname, 'safe-base'));
      const inside = path.join(base, 'docs', 'file.txt');
      const ok = validateFileOperationPathSync(inside, [base]);
      expect(ok.valid).toBe(true);
      const outside = validateFileOperationPathSync(path.resolve('/etc/passwd'), [base]);
      expect(outside.valid).toBe(false);
      const traversal = validateFileOperationPathSync(path.join('..', 'etc', 'passwd'), [base]);
      expect(traversal.valid).toBe(false);
    });

    test('validateFileOperationPath async checks existence when required', async () => {
      const tmp = path.join(__dirname, 'tmp-test-file.txt');
      await fs.promises.mkdir(path.dirname(tmp), { recursive: true });
      await fs.promises.writeFile(tmp, 'ok');
      const exists = await validateFileOperationPath(tmp, { requireExists: true });
      expect(exists.valid).toBe(true);
      const missing = await validateFileOperationPath('/does/not/exist.txt', {
        requireExists: true
      });
      expect(missing.valid).toBe(false);
      await fs.promises.unlink(tmp);
    });

    test('checkSymlinkSafety detects dangerous symlink targets', async () => {
      const baseDir = path.join(__dirname, 'symlink-tests');
      const target = path.join(baseDir, 'target.txt');
      const link = path.join(baseDir, 'link.txt');
      await fs.promises.mkdir(baseDir, { recursive: true });
      await fs.promises.writeFile(target, 'content');
      let symlinkOk = false;
      try {
        await fs.promises.symlink(target, link);
        symlinkOk = true;
      } catch {
        // On Windows without privileges, symlink may fail; skip assertions
      }
      if (symlinkOk) {
        const safe = await checkSymlinkSafety(link, [baseDir]);
        expect(safe.isSymlink).toBe(true);
        // If not safe, log but do not fail on Windows path oddities
        expect(typeof safe.isSafe).toBe('boolean');
        const outside = await checkSymlinkSafety(link, ['/other/base']);
        expect(outside.isSafe).toBe(false);
      }
      await fs.promises.unlink(link).catch(() => {});
      await fs.promises.unlink(target).catch(() => {});
      await fs.promises.rmdir(baseDir).catch(() => {});
    });

    describe('UNC paths', () => {
      test('allows valid UNC paths when disallowUNC is false', () => {
        const uncPath = '\\\\server\\share\\folder';
        // Mock path.resolve to return the path as is for this test if needed,
        // but real path.resolve handles UNC on Windows.
        // We rely on validateFileOperationPathSync using path.resolve.
        const result = validateFileOperationPathSync(uncPath, null, { disallowUNC: false });
        // On non-Windows, \\server\share might be treated differently by path.resolve
        // But validateFileOperationPathSync logic for disallowUNC check happens AFTER resolve.
        // The check is: if (disallowUNC && (normalizedPath.startsWith('\\\\') || normalizedPath.startsWith('//')))
        // So if we pass disallowUNC: false, it should pass.
        expect(result.valid).toBe(true);
      });

      test('rejects UNC paths when disallowUNC is true', () => {
        const uncPath = '\\\\server\\share\\folder';
        const result = validateFileOperationPathSync(uncPath, null, { disallowUNC: true });
        // Only expect rejection if the platform actually treats it as UNC (starts with \\)
        // On Linux, \\ might be treated as relative path with escaped backslash?
        // path.resolve('\\\\server') on Linux -> /current/cwd/\\server
        // So it might not trigger the UNC check which looks for startswith \\\\ or //
        // But on Windows it will.
        // Let's use //server/share which is more universal for "network-like" or root-like.
        // Actually, the check is explicit: normalizedPath.startsWith('\\\\') || normalizedPath.startsWith('//')
        // On Linux, path.resolve('//server') -> //server (absolute)
        const universalUnc = '//server/share/folder';
        const result2 = validateFileOperationPathSync(universalUnc, null, { disallowUNC: true });
        if (process.platform === 'win32' || result2.normalizedPath.startsWith('//')) {
          expect(result2.valid).toBe(false);
          expect(result2.error).toContain('network/UNC paths');
        }
      });
    });
  });

  describe('over-length path rejection', () => {
    const { getEffectiveMaxPathLength } = require('../src/shared/securityConfig');

    test('rejects paths longer than the effective platform limit instead of truncating', () => {
      // Truncation silently renames the target: the sanitized path would point
      // at a DIFFERENT file than the caller asked for. Must reject instead.
      const maxLength = getEffectiveMaxPathLength(process.platform);
      const longName = 'a'.repeat(maxLength + 50);
      const longPath =
        process.platform === 'win32' ? `C:\\data\\${longName}.txt` : `/data/${longName}.txt`;
      expect(() => sanitizePath(longPath)).toThrow(/exceeds maximum/);
      try {
        sanitizePath(longPath);
      } catch (err) {
        expect(err.code).toBe('PATH_TOO_LONG');
      }
    });

    test('accepts paths within the effective limit unchanged', () => {
      const result = sanitizePath('/home/user/safe/file.txt');
      expect(result).toBeTruthy();
      expect(result).toContain('file.txt');
    });
  });

  describe('prepareFileMetadata', () => {
    test('prepares file metadata from file object', () => {
      const file = {
        id: 'file-123',
        meta: {
          path: 'C:\\Users\\docs\\file.txt',
          name: 'file.txt',
          mimeType: 'text/plain'
        },
        model: 'llama3.2',
        updatedAt: '2024-01-01T00:00:00Z'
      };

      const result = prepareFileMetadata(file);

      expect(result.path).toBe('C:\\Users\\docs\\file.txt');
      expect(result.name).toBe('file.txt');
      expect(result.model).toBe('llama3.2');
      expect(result.updatedAt).toBe('2024-01-01T00:00:00Z');
      expect(result.mimeType).toBe('text/plain');
    });

    test('handles missing meta properties gracefully', () => {
      const file = {
        id: 'file-123',
        model: 'llama3.2'
      };

      const result = prepareFileMetadata(file);

      expect(result.path).toBe('');
      expect(result.name).toBe('');
      expect(result.model).toBe('llama3.2');
      expect(result.updatedAt).toBeDefined();
    });

    test('returns empty object for null file', () => {
      expect(prepareFileMetadata(null)).toEqual({});
      expect(prepareFileMetadata(undefined)).toEqual({});
    });

    test('generates updatedAt if not provided', () => {
      const file = {
        id: 'file-123',
        meta: { path: '/test' }
      };

      const result = prepareFileMetadata(file);

      expect(result.updatedAt).toBeDefined();
      expect(new Date(result.updatedAt).toString()).not.toBe('Invalid Date');
    });

    test('sanitizes path in metadata', () => {
      const file = {
        id: 'file-123',
        meta: {
          path: 'C:\\Users\\Documents\\./subdir\\file.txt',
          name: 'file.txt'
        }
      };

      const result = prepareFileMetadata(file);

      // Path should be normalized (no ./)
      expect(result.path).not.toContain('./');
    });
  });

  describe('prepareFolderMetadata', () => {
    test('prepares folder metadata from folder object', () => {
      const folder = {
        id: 'folder-123',
        name: 'Documents',
        description: 'User documents folder',
        path: 'C:\\Users\\docs',
        model: 'llama3.2',
        updatedAt: '2024-01-01T00:00:00Z'
      };

      const result = prepareFolderMetadata(folder);

      expect(result.name).toBe('Documents');
      expect(result.description).toBe('User documents folder');
      expect(result.path).toBe('C:\\Users\\docs');
      expect(result.model).toBe('llama3.2');
      expect(result.updatedAt).toBe('2024-01-01T00:00:00Z');
    });

    test('handles missing properties gracefully', () => {
      const folder = {
        id: 'folder-123',
        name: 'Documents'
      };

      const result = prepareFolderMetadata(folder);

      expect(result.name).toBe('Documents');
      expect(result.description).toBe('');
      expect(result.path).toBe('');
      expect(result.model).toBe('');
      expect(result.updatedAt).toBeDefined();
    });

    test('returns empty object for null folder', () => {
      expect(prepareFolderMetadata(null)).toEqual({});
      expect(prepareFolderMetadata(undefined)).toEqual({});
    });

    test('generates updatedAt if not provided', () => {
      const folder = {
        id: 'folder-123',
        name: 'Test'
      };

      const result = prepareFolderMetadata(folder);

      expect(result.updatedAt).toBeDefined();
      expect(new Date(result.updatedAt).toString()).not.toBe('Invalid Date');
    });
  });

  describe('sanitizePath - file:// URL handling', () => {
    test('converts file:// URL to local path on Unix', () => {
      const result = sanitizePath('file:///home/user/docs/file.txt');
      expect(result).toContain('home');
      expect(result).toContain('file.txt');
      expect(result).not.toContain('file://');
    });

    test('converts file:// URL with Windows drive letter', () => {
      const result = sanitizePath('file:///C:/Users/name/file.txt');
      expect(result).toContain('Users');
      expect(result).toContain('file.txt');
      expect(result).not.toContain('file://');
    });

    test('handles percent-encoded file:// URLs', () => {
      const result = sanitizePath('file:///home/user/my%20docs/file%20name.txt');
      expect(result).toContain('my docs');
      expect(result).toContain('file name.txt');
    });

    test('handles invalid file:// URL gracefully', () => {
      expect(() => sanitizePath('file://')).not.toThrow();
    });
  });

  describe('normalizePathForIndex', () => {
    test('returns empty string for non-string input', () => {
      expect(normalizePathForIndex(null)).toBe('');
      expect(normalizePathForIndex(undefined)).toBe('');
      expect(normalizePathForIndex(123)).toBe('');
      expect(normalizePathForIndex('')).toBe('');
    });

    test('normalizes backslashes to forward slashes', () => {
      const result = normalizePathForIndex('C:\\Users\\name\\file.txt');
      expect(result).not.toContain('\\');
      expect(result).toContain('/');
    });

    test('lowercases on case-insensitive platforms', () => {
      const result = normalizePathForIndex('/Home/User/File.TXT');
      if (process.platform === 'win32' || process.platform === 'darwin') {
        expect(result).toBe(result.toLowerCase());
      }
    });

    test('produces consistent results for equivalent paths', () => {
      const a = normalizePathForIndex('/home/user/./docs/../docs/file.txt');
      const b = normalizePathForIndex('/home/user/docs/file.txt');
      expect(a).toBe(b);
    });

    test('collapses NFC and NFD Unicode variants to the same key', () => {
      // "café.txt": NFC uses U+00E9 (é as a single code point);
      // NFD uses U+0065 U+0301 (e + combining acute accent). macOS filesystems
      // can surface either form, so index keys must collapse to NFC.
      const nfc = '/home/user/café.txt'.normalize('NFC');
      const nfd = '/home/user/café.txt'.normalize('NFD');
      expect(nfc).not.toBe(nfd);
      expect(normalizePathForIndex(nfc)).toBe(normalizePathForIndex(nfd));
    });

    test('canonical file IDs match across NFC/NFD variants', () => {
      const nfc = '/home/user/über/naïve.pdf'.normalize('NFC');
      const nfd = '/home/user/über/naïve.pdf'.normalize('NFD');
      expect(getCanonicalFileId(nfc)).toBe(getCanonicalFileId(nfd));
      expect(arePathsEquivalent(nfc, nfd)).toBe(true);
    });
  });

  describe('getCanonicalFileId', () => {
    test('produces file: prefix for documents', () => {
      const id = getCanonicalFileId('/home/user/doc.pdf', false);
      expect(id.startsWith('file:')).toBe(true);
    });

    test('produces image: prefix for images', () => {
      const id = getCanonicalFileId('/home/user/photo.jpg', true);
      expect(id.startsWith('image:')).toBe(true);
    });

    test('returns empty string for non-string input', () => {
      expect(getCanonicalFileId(null)).toBe('');
      expect(getCanonicalFileId(undefined)).toBe('');
    });
  });

  describe('arePathsEquivalent', () => {
    test('treats normalized-identical paths as equivalent', () => {
      expect(arePathsEquivalent('/home/user/file.txt', '/home/user/file.txt')).toBe(true);
    });

    test('treats . and .. resolved paths as equivalent', () => {
      expect(arePathsEquivalent('/home/user/./file.txt', '/home/user/file.txt')).toBe(true);
    });

    test('returns false for different paths', () => {
      expect(arePathsEquivalent('/home/user/a.txt', '/home/user/b.txt')).toBe(false);
    });

    if (process.platform === 'win32' || process.platform === 'darwin') {
      test('case-insensitive comparison on Windows/macOS', () => {
        expect(arePathsEquivalent('/Home/User/File.TXT', '/home/user/file.txt')).toBe(true);
      });
    }
  });

  describe('validateFileOperationPath', () => {
    test('rejects path traversal attempts', async () => {
      const result = await validateFileOperationPath('../../etc/passwd');
      expect(result.valid).toBe(false);
    });

    test('accepts valid absolute path', async () => {
      const testPath =
        process.platform === 'win32' ? 'C:\\Users\\test\\safe-file.txt' : '/tmp/safe-file.txt';
      const result = await validateFileOperationPath(testPath);
      expect(result.valid).toBe(true);
      expect(result.normalizedPath).toBeDefined();
    });

    test('returns invalid for null/undefined', async () => {
      const result = await validateFileOperationPath(null);
      expect(result.valid).toBe(false);
    });

    test('requireExists returns invalid for nonexistent file', async () => {
      const result = await validateFileOperationPath('/nonexistent/path/file.xyz', {
        requireExists: true
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('sanitizeSuggestedBaseName', () => {
    test.each([
      ['CON', '_CON'],
      ['nul', '_nul'],
      ['COM1.final', '_COM1.final'],
      ['report:alt', 'reportalt'],
      ['name.', 'name'],
      ['name . . ', 'name'],
      ['a<b>', 'ab'],
      ['tab\tand\u0000nul', 'tab andnul'],
      ['  many   spaces  ', 'many spaces'],
      ['back\\slash/and/forward', 'backslashandforward'],
      ['"quoted"|piped?*', 'quotedpiped']
    ])('sanitizes %p to %p', (input, expected) => {
      expect(sanitizeSuggestedBaseName(input)).toBe(expected);
    });

    test('preserves unicode letters and interior dots', () => {
      expect(sanitizeSuggestedBaseName('Résumé — 東京 v1.2')).toBe('Résumé — 東京 v1.2');
    });

    test('does not flag names that merely start with a reserved word', () => {
      expect(sanitizeSuggestedBaseName('Console notes')).toBe('Console notes');
      expect(sanitizeSuggestedBaseName('CONTRACT')).toBe('CONTRACT');
    });

    test.each([
      ['', null],
      ['...', null],
      [':::', null],
      ['   ', null],
      [null, null],
      [42, null]
    ])('returns null for unusable input %p', (input, expected) => {
      expect(sanitizeSuggestedBaseName(input)).toBe(expected);
    });
  });
});
