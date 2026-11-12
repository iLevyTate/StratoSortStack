/**
 * Where create-folder may make a folder. Any drive is acceptable, an external
 * one included: the home directory is not a boundary. The destination policy
 * decides whether the location is one the user agreed to. The handler itself
 * refuses only a path that is, or really leads into, a system directory, and
 * a link into one gets its own code and message instead of the generic
 * PATH_NOT_ALLOWED that reads like a typo. Real filesystem in os.tmpdir().
 */

jest.mock('fs', () => jest.requireActual('fs'));
jest.mock('fs/promises', () => jest.requireActual('fs/promises'));

// The temp directory usually sits inside the real home. Point the home
// directory and every Electron user folder at one folder inside the test's
// temp root, so its sibling `outside` is outside all of them.
const mockHome = { base: '' };
jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, homedir: () => mockHome.base || actual.homedir() };
});
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => mockHome.base) }
}));

jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

jest.mock('../src/main/ipc/ipcWrappers', () => ({
  createHandler: jest.fn(({ handler }) => handler),
  safeHandle: (ipcMain, channel, handler) => ipcMain.handle(channel, handler),
  z: null
}));

// The destination policy's prompt needs a window. Each test says what the
// policy answers; its own rules are covered in destinationPolicy*.test.js.
jest.mock('../src/main/ipc/files/destinationPolicy', () => ({
  authorizeDestination: jest.fn()
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isPathDangerous } = require('../src/shared/pathSanitization');
const { authorizeDestination } = require('../src/main/ipc/files/destinationPolicy');

const CHANNEL = 'files:create-folder-direct';
const isWindows = process.platform === 'win32';
const linkType = isWindows ? 'junction' : 'dir';

// The temp root as a user would pass it. On Windows expand 8.3 short names
// (RUNNER~1) so it matches what the code resolves. On macOS keep the OS
// spelling: /var/folders/... resolves to /private/var/..., which is on the
// system-directory denylist as typed, and no user ever passes that form.
function spelledTempPath(p) {
  return process.platform === 'darwin' ? p : fs.realpathSync.native(p);
}

/**
 * A real system directory the denylist covers, used as a link target.
 * @returns {string|null}
 */
function pickSystemDirectory() {
  const candidates = isWindows
    ? [process.env.SystemRoot || path.win32.join('C:/', 'Windows')]
    : ['/etc', '/usr/sbin', '/sbin', '/bin'];
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync.native(candidate);
      if (fs.statSync(real).isDirectory() && isPathDangerous(real)) return real;
    } catch {
      // try the next one
    }
  }
  return null;
}

describe('where create-folder may make a folder', () => {
  /** @type {string} */
  let tmpRoot;
  /** @type {string} */
  let home;
  /** @type {string} */
  let outside;
  /** @type {string[]} */
  let links;
  /** @type {Record<string, Function>} */
  let handlers;

  /**
   * @param {string} target
   * @param {string} name
   * @returns {string|null} The link, or null when links cannot be made here
   */
  function linkTo(target, name) {
    const link = path.join(home, name);
    try {
      fs.symlinkSync(target, link, linkType);
    } catch {
      return null;
    }
    links.push(link);
    return link;
  }

  beforeAll(() => {
    tmpRoot = spelledTempPath(fs.mkdtempSync(path.join(os.tmpdir(), 'strato-mkdir-where-')));
    home = path.join(tmpRoot, 'home');
    outside = path.join(tmpRoot, 'outside');
    fs.mkdirSync(home);
    fs.mkdirSync(outside);
    mockHome.base = home;
    links = [];
  });

  afterAll(() => {
    // Unlink before the recursive remove so it can never follow a link.
    for (const link of links) {
      try {
        fs.unlinkSync(link);
      } catch {
        // ignore
      }
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    authorizeDestination.mockReset();
    authorizeDestination.mockResolvedValue({ allowed: true, reason: 'test' });
    require('../src/shared/logger').logger.warn.mockClear();

    handlers = {};
    const ipcMain = { handle: jest.fn((channel, fn) => (handlers[channel] = fn)) };
    const { registerFolderHandlers } = require('../src/main/ipc/files/folderHandlers');
    registerFolderHandlers({
      ipcMain,
      IPC_CHANNELS: {
        FILES: {
          CREATE_FOLDER_DIRECT: CHANNEL,
          OPEN_FOLDER: 'files:open-folder',
          DELETE_FOLDER: 'files:delete-folder'
        }
      },
      shell: { openPath: jest.fn() }
    });
  });

  test('a folder outside the home directory is created once the policy allows it', async () => {
    const target = path.join(outside, 'Sorted', 'Invoices');

    const result = await handlers[CHANNEL]({}, target);

    expect(result).toEqual(
      expect.objectContaining({ success: true, path: target, alreadyExisted: false })
    );
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(authorizeDestination).toHaveBeenCalledWith(target, expect.any(Object));
  });

  test('a folder the policy refuses is not created, and its reason is passed on', async () => {
    authorizeDestination.mockResolvedValue({
      allowed: false,
      reason: 'declined',
      error: 'Destination folder was not approved.',
      errorCode: 'DESTINATION_NOT_ALLOWED'
    });
    const target = path.join(outside, 'Declined');

    const result = await handlers[CHANNEL]({}, target);

    expect(result).toEqual({
      success: false,
      error: 'Destination folder was not approved.',
      errorCode: 'DESTINATION_NOT_ALLOWED'
    });
    expect(fs.existsSync(target)).toBe(false);
  });

  test('a folder in the home directory is still created', async () => {
    const target = path.join(home, 'Projects', 'Receipts');

    const result = await handlers[CHANNEL]({}, target);

    expect(result).toEqual(
      expect.objectContaining({ success: true, path: target, alreadyExisted: false })
    );
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  test('a folder reached through a link is put to the policy as it was spelled', async () => {
    const link = linkTo(outside, 'elsewhere-link');
    // Junctions need no privilege on Windows, so this must never skip there.
    if (isWindows) expect(link).not.toBeNull();
    if (!link) return; // directory symlinks not creatable here
    const target = path.join(link, 'Through Link');

    const result = await handlers[CHANNEL]({}, target);

    // The policy resolves the link itself and names the real folder when it
    // asks; the handler must not refuse before the policy sees the path.
    expect(authorizeDestination).toHaveBeenCalledWith(target, expect.any(Object));
    expect(result.success).toBe(true);
    expect(fs.statSync(path.join(outside, 'Through Link')).isDirectory()).toBe(true);
  });

  describe('a link into a system directory', () => {
    /** @type {string|null} */
    let systemLink = null;
    /** @type {string|null} */
    let systemDir = null;

    beforeAll(() => {
      systemDir = pickSystemDirectory();
      systemLink = systemDir ? linkTo(systemDir, 'system-link') : null;
    });

    beforeEach(() => {
      // Were the path check ever to let these through, the policy refuses, so
      // the test cannot create anything in a real system directory.
      authorizeDestination.mockResolvedValue({
        allowed: false,
        reason: 'test-guard',
        error: 'guard',
        errorCode: 'DESTINATION_NOT_ALLOWED'
      });
    });

    test('a folder inside it is refused with the link code and message', async () => {
      if (isWindows) expect(systemLink).not.toBeNull();
      if (!systemLink || !systemDir) return;
      const target = path.join(systemLink, 'strato-test-never-created');

      const result = await handlers[CHANNEL]({}, target);

      expect(result).toEqual({
        success: false,
        error:
          'That folder leads into a system folder through a link or short name. Choose a different folder.',
        errorCode: 'LINK_INTO_SYSTEM'
      });
      expect(authorizeDestination).not.toHaveBeenCalled();

      // The log names the folder as spelled; never the link's target.
      const { logger } = require('../src/shared/logger');
      const logged = JSON.stringify(logger.warn.mock.calls);
      expect(logged).toContain('LINK_INTO_SYSTEM');
      expect(logged).not.toContain(JSON.stringify(systemDir).slice(1, -1));
    });

    test('the link itself is refused the same way', async () => {
      if (!systemLink) return;

      const result = await handlers[CHANNEL]({}, systemLink);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('LINK_INTO_SYSTEM');
      expect(authorizeDestination).not.toHaveBeenCalled();
    });
  });

  test('a system directory as spelled keeps the generic refusal', async () => {
    const systemDir = pickSystemDirectory();
    if (!systemDir) return;
    authorizeDestination.mockResolvedValue({ allowed: false, reason: 'test-guard' });

    const result = await handlers[CHANNEL]({}, path.join(systemDir, 'strato-test-never-created'));

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PATH_NOT_ALLOWED');
    expect(result.error).toMatch(/system directories/);
    expect(authorizeDestination).not.toHaveBeenCalled();
  });
});
