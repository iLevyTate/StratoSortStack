/**
 * @jest-environment node
 *
 * Destination policy for renderer-requested file writes: where a move or copy
 * may land without asking, when the main-process dialog is shown, and what is
 * refused outright.
 */
'use strict';

const policy = require('../src/main/ipc/files/destinationPolicy');

const {
  authorizeDestination,
  authorizeDestinations,
  decisionForDestination,
  rememberUserChosenLocation,
  getAutostartLocations,
  isAutostartLocation,
  buildStrictFileOpsAllowlist,
  DESTINATION_ERROR_CODES,
  _resetDestinationPolicyForTests
} = policy;

const POSIX = {
  platform: 'linux',
  home: '/home/kim',
  env: {},
  app: {
    isPackaged: true,
    getPath: (name) =>
      name === 'userData' ? '/home/kim/.config/StratoSort' : '/home/kim/Downloads'
  }
};

function withSmartFolders(folders) {
  return () => ({
    smartFolderWatcher: { getSmartFolders: () => folders, watchedPaths: new Set() }
  });
}

function approvingDialog() {
  return { showMessageBox: jest.fn(async () => ({ response: 0 })) };
}

function decliningDialog() {
  return { showMessageBox: jest.fn(async () => ({ response: 1 })) };
}

describe('destinationPolicy', () => {
  const ORIGINAL_E2E = process.env.STRATOSORT_E2E;

  beforeEach(() => {
    _resetDestinationPolicyForTests();
    delete process.env.STRATOSORT_E2E;
  });

  afterAll(() => {
    if (ORIGINAL_E2E === undefined) delete process.env.STRATOSORT_E2E;
    else process.env.STRATOSORT_E2E = ORIGINAL_E2E;
  });

  describe('autostart folders', () => {
    test('lists the login-time folders per platform', () => {
      expect(
        getAutostartLocations({
          platform: 'win32',
          env: { APPDATA: 'C:\\Users\\kim\\AppData\\Roaming', ProgramData: 'C:\\ProgramData' },
          home: 'C:\\Users\\kim'
        })
      ).toEqual(
        expect.arrayContaining([
          'C:\\Users\\kim\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup',
          'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup'
        ])
      );
      expect(getAutostartLocations({ platform: 'darwin', home: '/Users/kim' })).toEqual(
        expect.arrayContaining(['/Users/kim/Library/LaunchAgents', '/Library/LaunchDaemons'])
      );
      expect(getAutostartLocations({ platform: 'linux', home: '/home/kim' })).toEqual(
        expect.arrayContaining(['/home/kim/.config/autostart', '/etc/xdg/autostart'])
      );
    });

    test('a Windows Startup destination is refused without any dialog', async () => {
      const dialog = approvingDialog();
      const decision = await authorizeDestination(
        'C:\\Users\\kim\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\run.bat',
        {
          platform: 'win32',
          env: { APPDATA: 'C:\\Users\\kim\\AppData\\Roaming' },
          home: 'C:\\Users\\kim',
          app: { isPackaged: true, getPath: () => 'C:\\Users\\kim\\AppData\\Roaming\\StratoSort' },
          dialog
        }
      );
      expect(decision.allowed).toBe(false);
      expect(decision.errorCode).toBe(DESTINATION_ERROR_CODES.AUTOSTART);
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    });

    test('a LaunchAgents destination is refused even when picked in a dialog this session', async () => {
      rememberUserChosenLocation('/Users/kim/Library/LaunchAgents', 'darwin');
      const decision = await authorizeDestination('/Users/kim/Library/LaunchAgents/com.x.plist', {
        platform: 'darwin',
        home: '/Users/kim',
        app: {
          isPackaged: true,
          getPath: () => '/Users/kim/Library/Application Support/StratoSort'
        },
        dialog: approvingDialog()
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('autostart');
    });

    test('isAutostartLocation matches by path segment, not by prefix', () => {
      const deps = { platform: 'linux', home: '/home/kim' };
      expect(isAutostartLocation('/home/kim/.config/autostart/x.desktop', deps)).toBe(true);
      expect(isAutostartLocation('/home/kim/.config/autostart-notes', deps)).toBe(false);
    });
  });

  describe('places that need no prompt', () => {
    test('inside a Smart Folder', async () => {
      const dialog = approvingDialog();
      const decision = await authorizeDestination('/home/kim/Docs/Taxes/2025/w2.pdf', {
        ...POSIX,
        dialog,
        getServiceIntegration: withSmartFolders([{ path: '/home/kim/Docs/Taxes' }])
      });
      expect(decision).toEqual({ allowed: true, reason: 'smart-folder' });
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    });

    test('a sibling folder that shares a prefix with a Smart Folder is not inside it', async () => {
      const dialog = decliningDialog();
      const decision = await authorizeDestination('/home/kim/Docs/Taxes-old/w2.pdf', {
        ...POSIX,
        dialog,
        getServiceIntegration: withSmartFolders([{ path: '/home/kim/Docs/Taxes' }])
      });
      expect(decision.allowed).toBe(false);
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    });

    test('Downloads and the app data directory', async () => {
      const dialog = approvingDialog();
      expect(
        (await authorizeDestination('/home/kim/Downloads/sorted/a.pdf', { ...POSIX, dialog }))
          .reason
      ).toBe('downloads');
      expect(
        (await authorizeDestination('/home/kim/.config/StratoSort/tmp/a.pdf', { ...POSIX, dialog }))
          .reason
      ).toBe('user-data');
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    });

    test('a rename in place (same folder as the source)', async () => {
      const dialog = approvingDialog();
      const decision = await authorizeDestination('/home/kim/Desktop/renamed.pdf', {
        ...POSIX,
        dialog,
        sourcePath: '/home/kim/Desktop/original.pdf'
      });
      expect(decision).toEqual({ allowed: true, reason: 'same-folder' });
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    });

    test('a folder picked in a native dialog this session', async () => {
      const dialog = approvingDialog();
      rememberUserChosenLocation('/mnt/archive/2025', 'linux');
      const decision = await authorizeDestination('/mnt/archive/2025/q3/a.pdf', {
        ...POSIX,
        dialog
      });
      expect(decision).toEqual({ allowed: true, reason: 'session-folder' });
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    });
  });

  describe('network destinations', () => {
    test('a UNC destination outside any Smart Folder is refused without a dialog', async () => {
      const dialog = approvingDialog();
      const decision = await authorizeDestination('\\\\fileserver\\drop\\a.pdf', {
        ...POSIX,
        platform: 'win32',
        dialog
      });
      expect(decision.allowed).toBe(false);
      expect(decision.errorCode).toBe(DESTINATION_ERROR_CODES.UNC);
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    });

    test('a UNC destination inside a registered network Smart Folder is allowed', async () => {
      const decision = await authorizeDestination('\\\\fileserver\\team\\Contracts\\2025\\a.pdf', {
        ...POSIX,
        platform: 'win32',
        dialog: decliningDialog(),
        getServiceIntegration: withSmartFolders([{ path: '\\\\fileserver\\team\\Contracts' }])
      });
      expect(decision).toEqual({ allowed: true, reason: 'smart-folder' });
    });
  });

  describe('the main-process prompt', () => {
    test('an approved folder is remembered for the session', async () => {
      const dialog = approvingDialog();
      const first = await authorizeDestination('/home/kim/Desktop/out/a.pdf', {
        ...POSIX,
        dialog,
        sourcePath: '/home/kim/Pictures/a.pdf',
        intent: { count: 1, name: 'a.pdf' }
      });
      expect(first).toEqual({ allowed: true, reason: 'confirmed' });
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
      // No main window in this test, so the options are the only argument.
      const options = dialog.showMessageBox.mock.calls[0].at(-1);
      expect(options.message).toBe('Put "a.pdf" in /home/kim/Desktop/out?');
      expect(options.buttons).toEqual(['Allow for this session', 'Cancel']);
      expect(options.cancelId).toBe(1);

      const second = await authorizeDestination('/home/kim/Desktop/out/b.pdf', {
        ...POSIX,
        dialog
      });
      expect(second).toEqual({ allowed: true, reason: 'session-folder' });
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    });

    test('the dialog is parented to the main window when there is one', async () => {
      const dialog = approvingDialog();
      const win = { isDestroyed: () => false };
      await authorizeDestination('/home/kim/Desktop/out/a.pdf', {
        ...POSIX,
        dialog,
        getMainWindow: () => win
      });
      expect(dialog.showMessageBox.mock.calls[0][0]).toBe(win);
    });

    test('a declined folder is refused and asked again next time', async () => {
      const dialog = decliningDialog();
      const first = await authorizeDestination('/home/kim/Desktop/out/a.pdf', { ...POSIX, dialog });
      expect(first.allowed).toBe(false);
      expect(first.errorCode).toBe(DESTINATION_ERROR_CODES.NOT_ALLOWED);
      expect(first.error).toMatch(/not approved/);
      const second = await authorizeDestination('/home/kim/Desktop/out/b.pdf', {
        ...POSIX,
        dialog
      });
      expect(second.allowed).toBe(false);
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(2);
    });

    test('a request cancelled while the dialog is open is refused even when the user then allows, and the folder is not remembered', async () => {
      const controller = new AbortController();
      const dialog = {
        showMessageBox: jest.fn(async (...args) => {
          // The preload gave up on the invoke (timeout or user cancel) while
          // the box was open; the user clicks Allow afterwards.
          controller.abort();
          return { response: 0 };
        })
      };
      const decision = await authorizeDestination('/home/kim/Desktop/out/a.pdf', {
        ...POSIX,
        dialog,
        abortSignal: controller.signal
      });
      expect(decision).toEqual(
        expect.objectContaining({
          allowed: false,
          reason: 'aborted',
          errorCode: DESTINATION_ERROR_CODES.ABORTED
        })
      );
      // The signal is handed to Electron so the box closes with the request.
      expect(dialog.showMessageBox.mock.calls[0].at(-1).signal).toBe(controller.signal);

      const again = approvingDialog();
      const second = await authorizeDestination('/home/kim/Desktop/out/b.pdf', {
        ...POSIX,
        dialog: again
      });
      expect(again.showMessageBox).toHaveBeenCalledTimes(1);
      expect(second).toEqual({ allowed: true, reason: 'confirmed' });
    });

    test('a request already cancelled never opens the dialog', async () => {
      const controller = new AbortController();
      controller.abort();
      const dialog = approvingDialog();
      const decision = await authorizeDestination('/home/kim/Desktop/out/a.pdf', {
        ...POSIX,
        dialog,
        abortSignal: controller.signal
      });
      expect(decision.allowed).toBe(false);
      expect(decision.errorCode).toBe(DESTINATION_ERROR_CODES.ABORTED);
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
    });

    test('with no dialog available the destination is refused, never silently allowed', async () => {
      const decision = await authorizeDestination('/home/kim/Desktop/out/a.pdf', {
        ...POSIX,
        dialog: {}
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('no-dialog');
    });

    test('a dialog that throws refuses the destination', async () => {
      const decision = await authorizeDestination('/home/kim/Desktop/out/a.pdf', {
        ...POSIX,
        dialog: {
          showMessageBox: jest.fn(async () => {
            throw new Error('no display');
          })
        }
      });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('no-dialog');
    });

    test('concurrent requests for one folder share a single prompt', async () => {
      const dialog = approvingDialog();
      const deps = { ...POSIX, dialog };
      const [a, b, c] = await Promise.all([
        authorizeDestination('/home/kim/Desktop/out/a.pdf', deps),
        authorizeDestination('/home/kim/Desktop/out/b.pdf', deps),
        authorizeDestination('/home/kim/Desktop/out/c.pdf', deps)
      ]);
      expect([a.allowed, b.allowed, c.allowed]).toEqual([true, true, true]);
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    });

    test('unpackaged e2e runs approve without a dialog and say so', async () => {
      process.env.STRATOSORT_E2E = '1';
      const dialog = approvingDialog();
      const log = { info: jest.fn(), warn: jest.fn() };
      const decision = await authorizeDestination('/home/kim/Desktop/out/a.pdf', {
        ...POSIX,
        app: { ...POSIX.app, isPackaged: false },
        dialog,
        log
      });
      expect(decision).toEqual({ allowed: true, reason: 'e2e' });
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalled();
    });

    test('a packaged build ignores STRATOSORT_E2E', async () => {
      process.env.STRATOSORT_E2E = '1';
      const dialog = decliningDialog();
      const decision = await authorizeDestination('/home/kim/Desktop/out/a.pdf', {
        ...POSIX,
        dialog
      });
      expect(decision.allowed).toBe(false);
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    });
  });

  describe('authorizeDestinations', () => {
    // Decisions are keyed per platform (case-folded on macOS and Windows), so
    // lookups name the same platform the POSIX fixtures were decided under.
    test('asks once per landing folder and names the file count', async () => {
      const dialog = approvingDialog();
      const decisions = await authorizeDestinations(
        [
          { source: '/in/a.pdf', destination: '/home/kim/Desktop/out/a.pdf' },
          { source: '/in/b.pdf', destination: '/home/kim/Desktop/out/b.pdf' },
          { source: '/in/c.pdf', destination: '/home/kim/Docs/Taxes/c.pdf' }
        ],
        {
          ...POSIX,
          dialog,
          getServiceIntegration: withSmartFolders([{ path: '/home/kim/Docs/Taxes' }])
        }
      );
      expect(decisions.size).toBe(2);
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
      expect(dialog.showMessageBox.mock.calls[0].at(-1).message).toBe(
        'Put 2 files in /home/kim/Desktop/out?'
      );
      expect(decisionForDestination(decisions, '/home/kim/Desktop/out/b.pdf', 'linux')).toEqual({
        allowed: true,
        reason: 'confirmed'
      });
      expect(decisionForDestination(decisions, '/home/kim/Docs/Taxes/c.pdf', 'linux')).toEqual({
        allowed: true,
        reason: 'smart-folder'
      });
      expect(decisionForDestination(decisions, '/elsewhere/x.pdf', 'linux')).toBeUndefined();
    });

    test('an in-place rename does not vouch for a move from elsewhere into its folder', async () => {
      // One rename inside Desktop used to decide 'same-folder' for the whole
      // Desktop group, so a move from Downloads landed there with no dialog.
      const dialog = decliningDialog();
      const decisions = await authorizeDestinations(
        [
          { source: '/home/kim/Desktop/a.txt', destination: '/home/kim/Desktop/b.txt' },
          {
            source: '/home/kim/Downloads/payload.bin',
            destination: '/home/kim/Desktop/payload.bin'
          }
        ],
        { ...POSIX, dialog }
      );
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
      expect(dialog.showMessageBox.mock.calls[0].at(-1).message).toBe(
        'Put "payload.bin" in /home/kim/Desktop?'
      );
      // The move from elsewhere takes the folder's (declined) decision...
      const moved = decisionForDestination(
        decisions,
        '/home/kim/Desktop/payload.bin',
        'linux',
        '/home/kim/Downloads/payload.bin'
      );
      expect(moved.allowed).toBe(false);
      expect(moved.reason).toBe('declined');
      // ...while the rename stays allowed on its own merits.
      expect(
        decisionForDestination(
          decisions,
          '/home/kim/Desktop/b.txt',
          'linux',
          '/home/kim/Desktop/a.txt'
        )
      ).toEqual({ allowed: true, reason: 'same-folder' });
      // Without the source there is nothing to exempt: the folder decision stands.
      expect(decisionForDestination(decisions, '/home/kim/Desktop/b.txt', 'linux').allowed).toBe(
        false
      );
    });

    test('a folder of nothing but in-place renames is not put to the user', async () => {
      const dialog = decliningDialog();
      const decisions = await authorizeDestinations(
        [
          { source: '/home/kim/Desktop/a.txt', destination: '/home/kim/Desktop/a-1.txt' },
          { source: '/home/kim/Desktop/b.txt', destination: '/home/kim/Desktop/b-1.txt' }
        ],
        { ...POSIX, dialog }
      );
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
      expect(decisionForDestination(decisions, '/home/kim/Desktop/a-1.txt', 'linux')).toEqual({
        allowed: true,
        reason: 'same-folder'
      });
    });

    test('a rename inside a startup folder is refused like any other write there', async () => {
      const decisions = await authorizeDestinations(
        [
          {
            source: '/home/kim/.config/autostart/a.desktop',
            destination: '/home/kim/.config/autostart/b.desktop'
          }
        ],
        { ...POSIX, dialog: approvingDialog() }
      );
      const decision = decisionForDestination(
        decisions,
        '/home/kim/.config/autostart/b.desktop',
        'linux',
        '/home/kim/.config/autostart/a.desktop'
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('autostart');
    });

    test('a refused folder fails only the operations that land in it', async () => {
      const decisions = await authorizeDestinations(
        [
          { source: '/in/a.pdf', destination: '/home/kim/.config/autostart/a.desktop' },
          { source: '/in/b.pdf', destination: '/home/kim/Downloads/b.pdf' }
        ],
        { ...POSIX, dialog: approvingDialog() }
      );
      expect(
        decisionForDestination(decisions, '/home/kim/.config/autostart/a.desktop', 'linux').allowed
      ).toBe(false);
      expect(decisionForDestination(decisions, '/home/kim/Downloads/b.pdf', 'linux').allowed).toBe(
        true
      );
    });
  });

  describe('buildStrictFileOpsAllowlist', () => {
    const ORIGINAL = process.env.STRATOSORT_STRICT_FILE_OPS;
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.STRATOSORT_STRICT_FILE_OPS;
      else process.env.STRATOSORT_STRICT_FILE_OPS = ORIGINAL;
    });

    test('is off unless the flag is exactly true', () => {
      delete process.env.STRATOSORT_STRICT_FILE_OPS;
      expect(buildStrictFileOpsAllowlist(null)).toEqual({ enabled: false, allowlist: [] });
      process.env.STRATOSORT_STRICT_FILE_OPS = 'yes';
      expect(buildStrictFileOpsAllowlist(null).enabled).toBe(false);
    });

    test('lists the watched Smart Folder roots when on', () => {
      process.env.STRATOSORT_STRICT_FILE_OPS = 'true';
      const result = buildStrictFileOpsAllowlist(() => ({
        smartFolderWatcher: { watchedPaths: new Set(['/home/kim/Docs/Taxes']) }
      }));
      expect(result.enabled).toBe(true);
      // path.resolve puts the host's drive in front on Windows.
      expect(result.allowlist).toEqual(
        expect.arrayContaining([require('path').resolve('/home/kim/Docs/Taxes')])
      );
    });
  });
});
