/**
 * @jest-environment node
 *
 * A link inside a Smart Folder can lead anywhere: another drive, a network
 * share, the folder the operating system runs at login. The policy must
 * decide on where files really land, not only on the path as written.
 */
'use strict';

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const {
  authorizeDestination,
  getAutostartLocations,
  DESTINATION_ERROR_CODES,
  _resetDestinationPolicyForTests
} = require('../src/main/ipc/files/destinationPolicy');

function decliningDialog() {
  return { showMessageBox: jest.fn(async () => ({ response: 1 })) };
}

async function link(target, at) {
  // Junctions need no privilege on Windows; the type is ignored elsewhere.
  await fs.symlink(target, at, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('destinationPolicy resolves links before trusting a folder', () => {
  let root;
  let smart;
  let outside;
  let home;
  let deps;

  beforeEach(async () => {
    _resetDestinationPolicyForTests();
    // Canonical from the start: os.tmpdir() is itself behind a link on macOS
    // (/var -> /private/var) and an 8.3 alias on some Windows hosts
    // (RUNNER~1), and the policy decides on the resolved form.
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dest-policy-')));
    smart = path.join(root, 'Smart');
    outside = path.join(root, 'Outside');
    home = path.join(root, 'home');
    await fs.mkdir(smart);
    await fs.mkdir(outside);
    await fs.mkdir(home);
    deps = {
      platform: process.platform,
      home,
      env: {},
      app: { isPackaged: true, getPath: (name) => path.join(root, 'app', name) },
      getServiceIntegration: () => ({
        smartFolderWatcher: { getSmartFolders: () => [{ path: smart }], watchedPaths: new Set() }
      })
    };
  });

  afterEach(async () => {
    try {
      await fs.rm(root, { recursive: true, force: true });
    } catch {
      // best-effort tmp cleanup
    }
  });

  test('a folder inside a Smart Folder, not yet created, is allowed without a dialog', async () => {
    const dialog = decliningDialog();
    const decision = await authorizeDestination(path.join(smart, 'Taxes', '2025', 'a.pdf'), {
      ...deps,
      dialog
    });
    expect(decision).toEqual({ allowed: true, reason: 'smart-folder' });
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  test('a link inside a Smart Folder that leads out of it is put to the user, naming the real folder', async () => {
    await link(outside, path.join(smart, 'link'));
    const dialog = decliningDialog();
    const decision = await authorizeDestination(path.join(smart, 'link', 'a.pdf'), {
      ...deps,
      dialog
    });
    expect(decision.allowed).toBe(false);
    expect(decision.errorCode).toBe(DESTINATION_ERROR_CODES.NOT_ALLOWED);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    const options = dialog.showMessageBox.mock.calls[0].at(-1);
    expect(options.detail).toContain(await fs.realpath(outside));
  });

  test('a link to a startup folder is refused without a dialog', async () => {
    const env =
      process.platform === 'win32' ? { APPDATA: path.join(home, 'AppData', 'Roaming') } : {};
    const startup = getAutostartLocations({ platform: process.platform, home, env })[0];
    await fs.mkdir(startup, { recursive: true });
    await link(startup, path.join(smart, 'auto'));
    const dialog = decliningDialog();
    const decision = await authorizeDestination(path.join(smart, 'auto', 'a.pdf'), {
      ...deps,
      env,
      dialog
    });
    expect(decision).toEqual(
      expect.objectContaining({ allowed: false, errorCode: DESTINATION_ERROR_CODES.AUTOSTART })
    );
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  test('a startup folder reached through a linked ancestor is still refused', async () => {
    // The home the policy is told about is a link to where home really is, as
    // with macOS /var -> /private/var or a dotfile-managed ~/.config. The
    // resolved landing folder then shares no prefix with the startup folder as
    // the policy spells it; both sides have to be resolved for the refusal.
    const realHome = path.join(root, 'home-real');
    await fs.mkdir(realHome);
    const homeAlias = path.join(root, 'home-alias');
    await link(realHome, homeAlias);
    const env =
      process.platform === 'win32' ? { APPDATA: path.join(homeAlias, 'AppData', 'Roaming') } : {};
    const startup = getAutostartLocations({ platform: process.platform, home: homeAlias, env })[0];
    await fs.mkdir(startup, { recursive: true });
    await link(startup, path.join(smart, 'auto'));
    const dialog = decliningDialog();
    const decision = await authorizeDestination(path.join(smart, 'auto', 'a.pdf'), {
      ...deps,
      home: homeAlias,
      env,
      dialog
    });
    expect(decision).toEqual(
      expect.objectContaining({ allowed: false, errorCode: DESTINATION_ERROR_CODES.AUTOSTART })
    );
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  test('a Smart Folder registered through a link still trusts its own subfolders', async () => {
    const alias = path.join(root, 'SmartAlias');
    await link(smart, alias);
    const dialog = decliningDialog();
    const decision = await authorizeDestination(path.join(alias, 'sub', 'a.pdf'), {
      ...deps,
      dialog,
      getServiceIntegration: () => ({
        smartFolderWatcher: { getSmartFolders: () => [{ path: alias }], watchedPaths: new Set() }
      })
    });
    expect(decision).toEqual({ allowed: true, reason: 'smart-folder' });
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  test('a link whose real folder is inside the same Smart Folder is allowed', async () => {
    const inner = path.join(smart, 'Archive');
    await fs.mkdir(inner);
    await link(inner, path.join(smart, 'shortcut'));
    const dialog = decliningDialog();
    const decision = await authorizeDestination(path.join(smart, 'shortcut', 'a.pdf'), {
      ...deps,
      dialog
    });
    expect(decision).toEqual({ allowed: true, reason: 'smart-folder' });
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });
});
