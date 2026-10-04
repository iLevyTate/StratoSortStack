/**
 * Tests for Security Configuration
 * Tests path security, settings validation, and IPC security
 */

describe('securityConfig', () => {
  let securityConfig;

  beforeEach(() => {
    jest.resetModules();
    securityConfig = require('../src/shared/securityConfig');
  });

  describe('MAX_PATH_LENGTHS', () => {
    test('defines path lengths for each platform', () => {
      expect(securityConfig.MAX_PATH_LENGTHS.win32).toBe(32767);
      expect(securityConfig.MAX_PATH_LENGTHS.linux).toBe(4096);
      expect(securityConfig.MAX_PATH_LENGTHS.darwin).toBe(1024);
    });
  });

  describe('MAX_PATH_DEPTH', () => {
    test('defines maximum path depth', () => {
      expect(securityConfig.MAX_PATH_DEPTH).toBe(100);
    });
  });

  describe('RESERVED_WINDOWS_NAMES', () => {
    test('is a Set', () => {
      expect(securityConfig.RESERVED_WINDOWS_NAMES).toBeInstanceOf(Set);
    });

    test('includes CON', () => {
      expect(securityConfig.RESERVED_WINDOWS_NAMES.has('CON')).toBe(true);
    });

    test('includes PRN', () => {
      expect(securityConfig.RESERVED_WINDOWS_NAMES.has('PRN')).toBe(true);
    });

    test('includes NUL', () => {
      expect(securityConfig.RESERVED_WINDOWS_NAMES.has('NUL')).toBe(true);
    });

    test('includes COM ports', () => {
      for (let i = 1; i <= 9; i++) {
        expect(securityConfig.RESERVED_WINDOWS_NAMES.has(`COM${i}`)).toBe(true);
      }
    });

    test('includes LPT ports', () => {
      for (let i = 1; i <= 9; i++) {
        expect(securityConfig.RESERVED_WINDOWS_NAMES.has(`LPT${i}`)).toBe(true);
      }
    });
  });

  describe('DANGEROUS_PATHS', () => {
    test('defines unix dangerous paths', () => {
      expect(securityConfig.DANGEROUS_PATHS.unix).toContain('/etc');
      expect(securityConfig.DANGEROUS_PATHS.unix).toContain('/sys');
      expect(securityConfig.DANGEROUS_PATHS.unix).toContain('/proc');
    });

    test('defines windows dangerous paths', () => {
      expect(securityConfig.DANGEROUS_PATHS.windows).toContain('C:\\Windows');
      expect(securityConfig.DANGEROUS_PATHS.windows).toContain('C:\\Program Files');
    });

    test('defines darwin dangerous paths', () => {
      expect(securityConfig.DANGEROUS_PATHS.darwin).toContain('/System');
      expect(securityConfig.DANGEROUS_PATHS.darwin).toContain('/Library/System');
    });
  });

  describe('getDangerousPaths', () => {
    test('returns unix paths for linux', () => {
      const paths = securityConfig.getDangerousPaths('linux');
      expect(paths).toContain('/etc');
      expect(paths).not.toContain('C:\\Windows');
    });

    test('returns unix and darwin paths for darwin', () => {
      const paths = securityConfig.getDangerousPaths('darwin');
      expect(paths).toContain('/etc');
      expect(paths).toContain('/System');
    });

    test('returns windows paths for win32', () => {
      const paths = securityConfig.getDangerousPaths('win32');
      expect(paths).toContain('C:\\Windows');
      expect(paths).not.toContain('/etc');
    });

    test('uses current platform by default', () => {
      const paths = securityConfig.getDangerousPaths();
      expect(Array.isArray(paths)).toBe(true);
    });
  });

  describe('PROTOTYPE_POLLUTION_KEYS', () => {
    test('includes __proto__', () => {
      expect(securityConfig.PROTOTYPE_POLLUTION_KEYS).toContain('__proto__');
    });

    test('includes constructor', () => {
      expect(securityConfig.PROTOTYPE_POLLUTION_KEYS).toContain('constructor');
    });

    test('includes prototype', () => {
      expect(securityConfig.PROTOTYPE_POLLUTION_KEYS).toContain('prototype');
    });
  });

  describe('ALLOWED_APP_PATHS', () => {
    test('includes userData', () => {
      expect(securityConfig.ALLOWED_APP_PATHS).toContain('userData');
    });

    test('includes documents', () => {
      expect(securityConfig.ALLOWED_APP_PATHS).toContain('documents');
    });

    test('includes downloads', () => {
      expect(securityConfig.ALLOWED_APP_PATHS).toContain('downloads');
    });

    test('includes home', () => {
      expect(securityConfig.ALLOWED_APP_PATHS).toContain('home');
    });
  });

  describe('SETTINGS_VALIDATION', () => {
    test('has allowedKeys as a Set', () => {
      expect(securityConfig.SETTINGS_VALIDATION.allowedKeys).toBeInstanceOf(Set);
    });

    test('allowedKeys includes common settings', () => {
      expect(securityConfig.SETTINGS_VALIDATION.allowedKeys.has('textModel')).toBe(true);
      // Theme switching is no longer supported.
      expect(securityConfig.SETTINGS_VALIDATION.allowedKeys.has('theme')).toBe(false);
    });

    test('enums has valid loggingLevel values', () => {
      expect(securityConfig.SETTINGS_VALIDATION.enums.loggingLevel).toContain('error');
      expect(securityConfig.SETTINGS_VALIDATION.enums.loggingLevel).toContain('warn');
      expect(securityConfig.SETTINGS_VALIDATION.enums.loggingLevel).toContain('info');
      expect(securityConfig.SETTINGS_VALIDATION.enums.loggingLevel).toContain('debug');
    });

    test('numericLimits has valid constraints', () => {
      expect(securityConfig.SETTINGS_VALIDATION.numericLimits.cacheSize.min).toBe(0);
      expect(securityConfig.SETTINGS_VALIDATION.numericLimits.cacheSize.max).toBe(100000);
    });

    test('patterns has url regex', () => {
      expect(securityConfig.SETTINGS_VALIDATION.patterns.url).toBeInstanceOf(RegExp);
      expect('http://localhost:8080').toMatch(securityConfig.SETTINGS_VALIDATION.patterns.url);
    });

    test('patterns has modelName regex', () => {
      expect(securityConfig.SETTINGS_VALIDATION.patterns.modelName).toBeInstanceOf(RegExp);
      expect('llama3.2:latest').toMatch(securityConfig.SETTINGS_VALIDATION.patterns.modelName);
    });
  });

  describe('ALLOWED_METADATA_FIELDS', () => {
    test('includes common metadata fields', () => {
      expect(securityConfig.ALLOWED_METADATA_FIELDS).toContain('path');
      expect(securityConfig.ALLOWED_METADATA_FIELDS).toContain('name');
      expect(securityConfig.ALLOWED_METADATA_FIELDS).toContain('model');
      expect(securityConfig.ALLOWED_METADATA_FIELDS).toContain('description');
    });
  });

  describe('ALLOWED_RECEIVE_CHANNELS', () => {
    test('is an array', () => {
      expect(Array.isArray(securityConfig.ALLOWED_RECEIVE_CHANNELS)).toBe(true);
    });

    test('includes common receive channels', () => {
      expect(securityConfig.ALLOWED_RECEIVE_CHANNELS).toContain('system-metrics');
      expect(securityConfig.ALLOWED_RECEIVE_CHANNELS).toContain('operation-progress');
      expect(securityConfig.ALLOWED_RECEIVE_CHANNELS).toContain('vectordb:status-changed');
    });

    // Parse every safeOn(<constant-ref>) and safeOn('<literal>') subscription in
    // the real preload.js source, resolved against the real shared constants.
    // test-setup.js mocks fs with memfs; the real preload.js source only exists
    // on the actual disk, hence jest.requireActual.
    function collectPreloadSafeOnChannels() {
      const fs = jest.requireActual('fs');
      const path = require('path');
      const { IPC_CHANNELS, IPC_EVENTS } = require('../src/shared/constants');
      const preloadSource = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'preload', 'preload.js'),
        'utf8'
      );

      const refPattern = /safeOn\(\s*(IPC_EVENTS|IPC_CHANNELS)\.([A-Z0-9_]+)(?:\.([A-Z0-9_]+))?/g;
      const channels = new Set();
      for (const [, root, first, second] of preloadSource.matchAll(refPattern)) {
        const value = root === 'IPC_EVENTS' ? IPC_EVENTS[first] : IPC_CHANNELS[first]?.[second];
        if (typeof value !== 'string') {
          throw new Error(
            `Unresolvable safeOn reference in preload.js: ${root}.${first}${second ? `.${second}` : ''}`
          );
        }
        channels.add(value);
      }
      const literalPattern = /safeOn\(\s*['"`]([^'"`]+)['"`]/g;
      for (const [, channel] of preloadSource.matchAll(literalPattern)) {
        channels.add(channel);
      }
      return channels;
    }

    test('every preload safeOn() subscription channel is allowlisted (F-077)', () => {
      // safeOn() silently no-ops on channels missing from ALLOWED_RECEIVE_CHANNELS,
      // so a bridge wired in preload but missed here is dead in production with no
      // test failure (all preload suites mock this allowlist). notification-action
      // shipped that way in PR #332 and was only caught by production-log mining.
      const channels = collectPreloadSafeOnChannels();

      // If the regex stops matching after a preload refactor, this guard must fail
      // loudly rather than silently passing on an empty set.
      expect(channels.size).toBeGreaterThan(0);

      const missing = [...channels].filter(
        (channel) => !securityConfig.ALLOWED_RECEIVE_CHANNELS.includes(channel)
      );
      expect(missing).toEqual([]);
    });

    test('every ALLOWED_RECEIVE_CHANNELS entry has a preload safeOn() consumer (reverse F-077)', () => {
      // The inverse rot: an allowlist entry whose preload bridge is later
      // deleted stays open as receive surface forever, and nothing fails.
      // Any intentionally consumer-less channel must be listed here by name
      // with a reason — do not widen this silently.
      const INTENTIONALLY_UNCONSUMED = [];

      const consumed = collectPreloadSafeOnChannels();
      expect(consumed.size).toBeGreaterThan(0);

      const dead = securityConfig.ALLOWED_RECEIVE_CHANNELS.filter(
        (channel) => !consumed.has(channel) && !INTENTIONALLY_UNCONSUMED.includes(channel)
      );
      expect(dead).toEqual([]);
    });
  });

  describe('ALLOWED_SEND_CHANNELS', () => {
    test('is an array', () => {
      expect(Array.isArray(securityConfig.ALLOWED_SEND_CHANNELS)).toBe(true);
    });

    test('includes the renderer error-report send channel', () => {
      expect(securityConfig.ALLOWED_SEND_CHANNELS).toContain('renderer-error-report');
      expect(securityConfig.ALLOWED_SEND_CHANNELS).not.toContain('startup-continue');
      expect(securityConfig.ALLOWED_SEND_CHANNELS).not.toContain('startup-quit');
    });
  });

  describe('isExecutableExtension', () => {
    test('blocks classic Windows executables and scripts', () => {
      for (const path of ['C:/Users/x/Documents/setup.exe', 'a.bat', 'run.cmd', 'x.ps1', 'y.vbs']) {
        expect(securityConfig.isExecutableExtension(path)).toBe(true);
      }
    });

    test('blocks WSH script and installer-transform extensions (F-028)', () => {
      // .ws (Windows Script) and .mst (Installer Transform) were missing from
      // the denylist; both hand the OS something to execute when shell-opened.
      expect(securityConfig.isExecutableExtension('payload.ws')).toBe(true);
      expect(securityConfig.isExecutableExtension('transform.mst')).toBe(true);
      expect(securityConfig.isExecutableExtension('sidebar.gadget')).toBe(true);
    });

    test('blocks ClickOnce, Excel add-ins, update packages, scriptlets and Java Web Start (SB-02)', () => {
      for (const name of [
        'deploy.application',
        'addin.xll',
        'patch.msu',
        'component.wsc',
        'scriptlet.sct',
        'pinned.website',
        'launch.jnlp',
        'app.pyz',
        'app.pyzw'
      ]) {
        expect(securityConfig.isExecutableExtension(name)).toBe(true);
      }
    });

    test('blocks auto-mounting disk images (F-028)', () => {
      // Windows auto-mounts these on open, exposing the volume's autorun surface.
      for (const path of ['ship.iso', 'disk.img', 'old.vhd', 'modern.vhdx']) {
        expect(securityConfig.isExecutableExtension(path)).toBe(true);
      }
    });

    test('is case-insensitive', () => {
      expect(securityConfig.isExecutableExtension('SETUP.EXE')).toBe(true);
      expect(securityConfig.isExecutableExtension('Disk.ISO')).toBe(true);
    });

    test.each([
      'evil.exe',
      'evil.exe.',
      'evil.exe ',
      'evil.exe..',
      'evil.exe. .',
      'evil.EXE.',
      'C:\\dl\\evil.exe.',
      'evil.appref-ms',
      'evil.settingcontent-ms',
      'evil.library-ms',
      'evil.searchconnector-ms',
      'evil.msc',
      'evil.chm',
      'evil.diagcab'
    ])('blocks %j (trailing dot/space stripped like Windows ShellExecute)', (name) => {
      expect(securityConfig.isExecutableExtension(name)).toBe(true);
    });

    test.each([
      'notes.txt',
      'notes.txt.',
      'notes.txt ',
      '.bashrc',
      '.bashrc.',
      'archive.tar.gz',
      '...'
    ])('allows %j', (name) => {
      expect(securityConfig.isExecutableExtension(name)).toBe(false);
    });

    test('allows ordinary documents', () => {
      for (const path of ['report.pdf', 'notes.txt', 'photo.png', 'data.csv', 'archive.tar.gz']) {
        expect(securityConfig.isExecutableExtension(path)).toBe(false);
      }
    });

    test('does not flag a static-library archive (.lib has no shell run verb)', () => {
      // Deliberately excluded from the F-028 additions: opening a .lib does not
      // hand the OS a command to execute, so it fails the denylist's criterion.
      expect(securityConfig.isExecutableExtension('vendor.lib')).toBe(false);
    });

    test('handles missing extensions, dotfiles, and non-string input safely', () => {
      expect(securityConfig.isExecutableExtension('Makefile')).toBe(false);
      expect(securityConfig.isExecutableExtension('.gitignore')).toBe(false);
      expect(securityConfig.isExecutableExtension('')).toBe(false);
      expect(securityConfig.isExecutableExtension(null)).toBe(false);
      expect(securityConfig.isExecutableExtension(undefined)).toBe(false);
    });
  });
});
