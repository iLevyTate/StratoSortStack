/**
 * Tests for Cross-Platform Utilities
 * Tests platform detection, spawning, and path handling
 */

const path = require('path');

describe('crossPlatformUtils', () => {
  let crossPlatformUtils;
  const originalPlatform = process.platform;

  beforeEach(() => {
    jest.resetModules();
    crossPlatformUtils = require('../src/shared/crossPlatformUtils');
  });

  afterEach(() => {
    // Restore platform if modified
    Object.defineProperty(process, 'platform', {
      value: originalPlatform
    });
  });

  describe('platform detection', () => {
    test('PLATFORM matches process.platform', () => {
      expect(crossPlatformUtils.PLATFORM).toBe(process.platform);
    });

    test('isWindows is correct for current platform', () => {
      expect(crossPlatformUtils.isWindows).toBe(process.platform === 'win32');
    });

    test('isMacOS is correct for current platform', () => {
      expect(crossPlatformUtils.isMacOS).toBe(process.platform === 'darwin');
    });

    test('isLinux is correct for current platform', () => {
      expect(crossPlatformUtils.isLinux).toBe(process.platform === 'linux');
    });

    test('isUnix is true for macOS or Linux', () => {
      const expected = process.platform === 'darwin' || process.platform === 'linux';
      expect(crossPlatformUtils.isUnix).toBe(expected);
    });

    test.each([
      ['win32', true],
      ['darwin', true],
      ['linux', false]
    ])(
      'isCaseInsensitiveFileSystem reads process.platform at call time (%s)',
      (platform, expected) => {
        Object.defineProperty(process, 'platform', { value: platform });
        expect(crossPlatformUtils.isCaseInsensitiveFileSystem()).toBe(expected);
      }
    );
  });

  describe('getExecutableName', () => {
    test('returns base name on Unix', () => {
      if (!crossPlatformUtils.isWindows) {
        expect(crossPlatformUtils.getExecutableName('npm')).toBe('npm');
      }
    });

    test('adds .cmd for npm on Windows', () => {
      if (crossPlatformUtils.isWindows) {
        expect(crossPlatformUtils.getExecutableName('npm')).toBe('npm.cmd');
      }
    });

    test('adds .cmd for yarn on Windows', () => {
      if (crossPlatformUtils.isWindows) {
        expect(crossPlatformUtils.getExecutableName('yarn')).toBe('yarn.cmd');
      }
    });

    test('adds .exe for pip on Windows', () => {
      if (crossPlatformUtils.isWindows) {
        expect(crossPlatformUtils.getExecutableName('pip')).toBe('pip.exe');
      }
    });

    test('uses custom windowsExtension when provided', () => {
      if (crossPlatformUtils.isWindows) {
        expect(crossPlatformUtils.getExecutableName('myapp', { windowsExtension: '.exe' })).toBe(
          'myapp.exe'
        );
      }
    });

    test('returns base name for unknown executable on Windows', () => {
      if (crossPlatformUtils.isWindows) {
        expect(crossPlatformUtils.getExecutableName('unknownapp')).toBe('unknownapp');
      }
    });
  });

  describe('getPythonCandidates', () => {
    test('returns array of candidates', () => {
      const candidates = crossPlatformUtils.getPythonCandidates();
      expect(Array.isArray(candidates)).toBe(true);
      expect(candidates.length).toBeGreaterThan(0);
    });

    test('candidates have command and args', () => {
      const candidates = crossPlatformUtils.getPythonCandidates();
      candidates.forEach((candidate) => {
        expect(candidate).toHaveProperty('command');
        expect(candidate).toHaveProperty('args');
        expect(Array.isArray(candidate.args)).toBe(true);
      });
    });

    test('includes python3 candidate', () => {
      const candidates = crossPlatformUtils.getPythonCandidates();
      const hasPython3 = candidates.some((c) => c.command === 'python3');
      expect(hasPython3).toBe(true);
    });

    test('Windows includes py launcher', () => {
      if (crossPlatformUtils.isWindows) {
        const candidates = crossPlatformUtils.getPythonCandidates();
        const hasPy = candidates.some((c) => c.command === 'py');
        expect(hasPy).toBe(true);
      }
    });
  });

  describe('getNvidiaSmiExecutable', () => {
    test('returns correct executable name', () => {
      const expected = crossPlatformUtils.isWindows ? 'nvidia-smi.exe' : 'nvidia-smi';
      expect(crossPlatformUtils.getNvidiaSmiExecutable()).toBe(expected);
    });
  });

  describe('getModifierKey', () => {
    test('returns Cmd for macOS', () => {
      if (crossPlatformUtils.isMacOS) {
        expect(crossPlatformUtils.getModifierKey()).toBe('Cmd');
      }
    });

    test('returns Ctrl for Windows/Linux', () => {
      if (!crossPlatformUtils.isMacOS) {
        expect(crossPlatformUtils.getModifierKey()).toBe('Ctrl');
      }
    });
  });

  describe('getAccelerator', () => {
    test('creates accelerator with modifier and key', () => {
      const result = crossPlatformUtils.getAccelerator('S');
      const expected = crossPlatformUtils.isMacOS ? 'Cmd+S' : 'Ctrl+S';
      expect(result).toBe(expected);
    });

    test('includes Shift when specified', () => {
      const result = crossPlatformUtils.getAccelerator('S', { shift: true });
      expect(result).toContain('Shift');
    });

    test('includes Alt when specified', () => {
      const result = crossPlatformUtils.getAccelerator('S', { alt: true });
      expect(result).toContain('Alt');
    });

    test('uses CmdOrCtrl when specified', () => {
      const result = crossPlatformUtils.getAccelerator('S', { useCmdOrCtrl: true });
      expect(result).toBe('CmdOrCtrl+S');
    });

    test('combines multiple modifiers', () => {
      const result = crossPlatformUtils.getAccelerator('S', { shift: true, alt: true });
      expect(result).toContain('Shift');
      expect(result).toContain('Alt');
    });
  });

  describe('getQuitAccelerator', () => {
    test('returns quit accelerator', () => {
      const result = crossPlatformUtils.getQuitAccelerator();
      const expected = crossPlatformUtils.isMacOS ? 'Cmd+Q' : 'Ctrl+Q';
      expect(result).toBe(expected);
    });
  });

  describe('getSettingsAccelerator', () => {
    test('returns settings accelerator', () => {
      const result = crossPlatformUtils.getSettingsAccelerator();
      const expected = crossPlatformUtils.isMacOS ? 'Cmd+,' : 'Ctrl+,';
      expect(result).toBe(expected);
    });
  });

  describe('normalizePath', () => {
    test('normalizes path with forward slashes', () => {
      const result = crossPlatformUtils.normalizePath('a/b/c');
      expect(result).toBe(path.normalize('a/b/c'));
    });

    test('returns input for null', () => {
      expect(crossPlatformUtils.normalizePath(null)).toBeNull();
    });

    test('returns input for undefined', () => {
      expect(crossPlatformUtils.normalizePath(undefined)).toBeUndefined();
    });

    test('returns input for non-string', () => {
      expect(crossPlatformUtils.normalizePath(123)).toBe(123);
    });
  });

  describe('joinPath', () => {
    test('joins path segments', () => {
      const result = crossPlatformUtils.joinPath('a', 'b', 'c');
      expect(result).toBe(path.join('a', 'b', 'c'));
    });
  });

  describe('resolvePath', () => {
    test('resolves to absolute path', () => {
      const result = crossPlatformUtils.resolvePath('a', 'b');
      expect(path.isAbsolute(result)).toBe(true);
    });
  });

  describe('isUNCPath', () => {
    test('returns true for UNC path with backslashes', () => {
      expect(crossPlatformUtils.isUNCPath('\\\\server\\share')).toBe(true);
    });

    test('returns true for UNC path with forward slashes', () => {
      expect(crossPlatformUtils.isUNCPath('//server/share')).toBe(true);
    });

    test('returns false for regular path', () => {
      expect(crossPlatformUtils.isUNCPath('/home/user')).toBe(false);
    });

    test('returns false for Windows drive path', () => {
      expect(crossPlatformUtils.isUNCPath('C:\\Users')).toBe(false);
    });

    test('returns false for null', () => {
      expect(crossPlatformUtils.isUNCPath(null)).toBe(false);
    });

    test('returns false for undefined', () => {
      expect(crossPlatformUtils.isUNCPath(undefined)).toBe(false);
    });

    test('returns false for non-string', () => {
      expect(crossPlatformUtils.isUNCPath(123)).toBe(false);
    });

    test.each([
      '\\\\?\\C:\\x',
      '\\\\.\\C:\\x',
      '//?/C:/x',
      '\\\\?\\UNC\\server\\share',
      '\\\\.\\UNC\\server\\share',
      '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1'
    ])('returns false for device-namespace path %s', (input) => {
      expect(crossPlatformUtils.isUNCPath(input)).toBe(false);
    });

    test('requires a server segment that is not ? or .', () => {
      expect(crossPlatformUtils.isUNCPath('\\\\server\\share')).toBe(true);
      expect(crossPlatformUtils.isUNCPath('\\\\?bad\\share')).toBe(false);
      expect(crossPlatformUtils.isUNCPath('\\\\.bad\\share')).toBe(false);
    });
  });

  describe('isWindowsDeviceNamespacePath', () => {
    test.each([
      '\\\\?\\C:\\x',
      '\\\\.\\C:\\x',
      '//?/C:/x',
      '//./C:/x',
      '\\\\?\\UNC\\server\\share',
      '\\\\.\\GLOBALROOT\\Device\\HarddiskVolume1'
    ])('returns true for %s', (input) => {
      expect(crossPlatformUtils.isWindowsDeviceNamespacePath(input)).toBe(true);
    });

    test.each(['\\\\server\\share', '//server/share', 'C:\\Users', '/home/user', '', null, 7])(
      'returns false for %s',
      (input) => {
        expect(crossPlatformUtils.isWindowsDeviceNamespacePath(input)).toBe(false);
      }
    );
  });

  describe('safePathJoin', () => {
    test('joins regular paths', () => {
      const result = crossPlatformUtils.safePathJoin('/base', 'sub', 'file.txt');
      expect(result).toBe(path.join('/base', 'sub', 'file.txt'));
    });

    test('preserves UNC prefix', () => {
      const result = crossPlatformUtils.safePathJoin('\\\\server\\share', 'folder', 'file.txt');
      expect(result).toMatch(/^\\\\server\\share/);
    });

    test('handles null basePath', () => {
      const result = crossPlatformUtils.safePathJoin(null, 'a', 'b');
      expect(result).toBe(path.join('a', 'b'));
    });

    test('handles undefined basePath', () => {
      const result = crossPlatformUtils.safePathJoin(undefined, 'a', 'b');
      expect(result).toBe(path.join('a', 'b'));
    });
  });

  describe('getHomeDirectory', () => {
    test('returns home directory', () => {
      const result = crossPlatformUtils.getHomeDirectory();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('getPathSeparator', () => {
    test('returns correct separator', () => {
      expect(crossPlatformUtils.getPathSeparator()).toBe(path.sep);
    });
  });

  describe('getKillCommand', () => {
    test('returns taskkill for Windows', () => {
      if (crossPlatformUtils.isWindows) {
        const result = crossPlatformUtils.getKillCommand(1234);
        expect(result.command).toBe('taskkill');
        expect(result.args).toContain('/pid');
      }
    });

    test('returns kill for Unix', () => {
      if (!crossPlatformUtils.isWindows) {
        const result = crossPlatformUtils.getKillCommand(1234);
        expect(result.command).toBe('kill');
      }
    });

    test('includes force flags when force is true', () => {
      const result = crossPlatformUtils.getKillCommand(1234, true);
      if (crossPlatformUtils.isWindows) {
        expect(result.args).toContain('/f');
      } else {
        expect(result.args).toContain('-KILL');
      }
    });
  });

  describe('getSleepCommand', () => {
    test('returns timeout for Windows', () => {
      if (crossPlatformUtils.isWindows) {
        const result = crossPlatformUtils.getSleepCommand(5);
        expect(result.command).toBe('timeout');
        expect(result.args).toContain('/t');
      }
    });

    test('returns sleep for Unix', () => {
      if (!crossPlatformUtils.isWindows) {
        const result = crossPlatformUtils.getSleepCommand(5);
        expect(result.command).toBe('sleep');
        expect(result.args).toContain('5');
      }
    });
  });

  describe('getTrayIconConfig', () => {
    test('returns icon config with path and isTemplate', () => {
      const result = crossPlatformUtils.getTrayIconConfig('/icons');
      expect(result).toHaveProperty('iconPath');
      expect(result).toHaveProperty('isTemplate');
    });

    test('returns .ico for Windows', () => {
      if (crossPlatformUtils.isWindows) {
        const result = crossPlatformUtils.getTrayIconConfig('/icons');
        expect(result.iconPath).toContain('.ico');
      }
    });

    test('returns template image for macOS', () => {
      if (crossPlatformUtils.isMacOS) {
        const result = crossPlatformUtils.getTrayIconConfig('/icons');
        expect(result.isTemplate).toBe(true);
      }
    });
  });

  describe('isFeatureSupported', () => {
    test('returns boolean for known feature', () => {
      const result = crossPlatformUtils.isFeatureSupported('tray');
      expect(typeof result).toBe('boolean');
    });

    test('returns false for unknown feature', () => {
      expect(crossPlatformUtils.isFeatureSupported('unknownFeature')).toBe(false);
    });

    test('jumpList is Windows only', () => {
      expect(crossPlatformUtils.isFeatureSupported('jumpList')).toBe(crossPlatformUtils.isWindows);
    });

    test('dockMenu is macOS only', () => {
      expect(crossPlatformUtils.isFeatureSupported('dockMenu')).toBe(crossPlatformUtils.isMacOS);
    });

    test('tray is supported on all platforms', () => {
      expect(crossPlatformUtils.isFeatureSupported('tray')).toBe(true);
    });
  });

  describe('getFeatureDocumentation', () => {
    test('returns string for known feature', () => {
      const result = crossPlatformUtils.getFeatureDocumentation('jumpList');
      expect(typeof result).toBe('string');
    });

    test('returns default message for unknown feature', () => {
      const result = crossPlatformUtils.getFeatureDocumentation('unknownFeature');
      expect(result).toContain('No documentation available');
    });
  });

  describe('crossSpawn', () => {
    test('spawns process and returns result', async () => {
      const result = await crossPlatformUtils.crossSpawn('node', ['--version']);
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('stdout');
      expect(result).toHaveProperty('stderr');
    });

    test('returns stdout content', async () => {
      const result = await crossPlatformUtils.crossSpawn('node', ['--version']);
      expect(result.stdout).toMatch(/^v\d+\.\d+\.\d+/);
    });

    test('handles timeout', async () => {
      const result = await crossPlatformUtils.crossSpawn(
        'node',
        ['-e', 'setTimeout(() => {}, 10000)'],
        {
          timeout: 100
        }
      );
      expect(result.timedOut).toBe(true);
    });

    test('handles non-existent command', async () => {
      const result = await crossPlatformUtils.crossSpawn('nonexistentcommand12345');
      expect(result.error).toBeDefined();
    });
  });

  describe('getSpawnOptions', () => {
    test('returns object with windowsHide', () => {
      const result = crossPlatformUtils.getSpawnOptions();
      expect(result.windowsHide).toBe(true);
    });

    test('shell is false by default', () => {
      const result = crossPlatformUtils.getSpawnOptions();
      expect(result.shell).toBe(false);
    });

    test('shell is true when useShell is true', () => {
      const result = crossPlatformUtils.getSpawnOptions({ useShell: true });
      expect(result.shell).toBe(true);
    });
  });

  describe('crossPlatformBasename', () => {
    test('extracts filename from Windows-style path', () => {
      expect(crossPlatformUtils.crossPlatformBasename('C:\\Users\\docs\\file.txt')).toBe(
        'file.txt'
      );
    });

    test('extracts filename from Unix-style path', () => {
      expect(crossPlatformUtils.crossPlatformBasename('/home/user/docs/file.txt')).toBe('file.txt');
    });

    test('extracts filename from mixed-separator path', () => {
      expect(crossPlatformUtils.crossPlatformBasename('C:\\Users/docs\\file.txt')).toBe('file.txt');
    });

    test('returns filename when no separators present', () => {
      expect(crossPlatformUtils.crossPlatformBasename('file.txt')).toBe('file.txt');
    });

    test('handles UNC paths', () => {
      expect(crossPlatformUtils.crossPlatformBasename('\\\\server\\share\\folder\\doc.pdf')).toBe(
        'doc.pdf'
      );
    });

    test('handles deeply nested Windows path', () => {
      expect(
        crossPlatformUtils.crossPlatformBasename('C:\\Docs\\Invoices\\2026\\invoice-01.pdf')
      ).toBe('invoice-01.pdf');
    });

    test('returns empty string for empty input', () => {
      expect(crossPlatformUtils.crossPlatformBasename('')).toBe('');
    });

    test('returns empty string for null', () => {
      expect(crossPlatformUtils.crossPlatformBasename(null)).toBe('');
    });

    test('returns empty string for undefined', () => {
      expect(crossPlatformUtils.crossPlatformBasename(undefined)).toBe('');
    });

    test('returns empty string for non-string', () => {
      expect(crossPlatformUtils.crossPlatformBasename(123)).toBe('');
    });

    test('handles path ending with separator', () => {
      expect(crossPlatformUtils.crossPlatformBasename('C:\\folder\\')).toBe('');
      expect(crossPlatformUtils.crossPlatformBasename('/folder/')).toBe('');
    });

    test('handles filenames with spaces', () => {
      expect(crossPlatformUtils.crossPlatformBasename('C:\\My Docs\\my file.txt')).toBe(
        'my file.txt'
      );
    });

    test('handles filenames with dots', () => {
      expect(crossPlatformUtils.crossPlatformBasename('/path/to/archive.tar.gz')).toBe(
        'archive.tar.gz'
      );
    });

    test('matches path.basename for Unix paths on all platforms', () => {
      const unixPath = '/home/user/file.txt';
      expect(crossPlatformUtils.crossPlatformBasename(unixPath)).toBe(path.basename(unixPath));
    });

    test('matches path.win32.basename for Windows paths on all platforms', () => {
      const winPath = 'C:\\Users\\docs\\report.pdf';
      expect(crossPlatformUtils.crossPlatformBasename(winPath)).toBe(path.win32.basename(winPath));
    });
  });

  describe('DEFAULT_SPAWN_OPTIONS', () => {
    test('timeout uses TIMEOUTS.API_REQUEST_SLOW', () => {
      const { TIMEOUTS } = require('../src/shared/performanceConstants');
      expect(crossPlatformUtils.DEFAULT_SPAWN_OPTIONS.timeout).toBe(TIMEOUTS.API_REQUEST_SLOW);
    });
  });
});
