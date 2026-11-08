/**
 * Create-folder judges where the folder would really land: a folder spelled
 * inside an allowed location but reached through a link (a Windows junction,
 * or a directory symlink elsewhere) that leads outside is refused. The
 * refusal must say why, with its own code, instead of the generic
 * PATH_NOT_ALLOWED that reads like a typo. Real filesystem in os.tmpdir().
 */

jest.mock('fs', () => jest.requireActual('fs'));
jest.mock('fs/promises', () => jest.requireActual('fs/promises'));

// The handler allows the home directory and Documents/Downloads/Desktop. The
// temp directory usually sits inside the real home, so point every allowed
// location at a folder inside the test's temp root instead.
const mockAllowed = { base: '' };
jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return { ...actual, homedir: () => mockAllowed.base || actual.homedir() };
});
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => mockAllowed.base) }
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

// The destination policy's prompt needs a window; approve every parent so
// the test is about the path check alone.
jest.mock('../src/main/ipc/files/destinationPolicy', () => ({
  authorizeDestination: jest.fn(async () => ({ allowed: true, reason: 'test' }))
}));

const fs = require('fs');
const os = require('os');
const path = require('path');

const CHANNEL = 'files:create-folder-direct';

describe('create-folder through a link that leads outside the allowed locations', () => {
  /** @type {string} */
  let tmpRoot;
  /** @type {string} */
  let allowedBase;
  /** @type {string} */
  let outside;
  /** @type {string|null} */
  let escapeLink = null;
  /** @type {Record<string, Function>} */
  let handlers;

  beforeAll(() => {
    tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'strato-mkdir-link-')));
    allowedBase = path.join(tmpRoot, 'home');
    outside = path.join(tmpRoot, 'outside');
    fs.mkdirSync(allowedBase);
    fs.mkdirSync(outside);
    mockAllowed.base = allowedBase;
    const link = path.join(allowedBase, 'escape');
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
      escapeLink = link;
    } catch {
      escapeLink = null;
    }
  });

  afterAll(() => {
    try {
      if (escapeLink) fs.unlinkSync(escapeLink);
    } catch {
      // ignore
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
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

  test('a folder inside the junction is refused with the link code and message', async () => {
    // Junctions need no privilege on Windows, so this must never skip there.
    if (process.platform === 'win32') expect(escapeLink).not.toBeNull();
    if (!escapeLink) return; // directory symlinks not creatable here
    const target = path.join(escapeLink, 'New Folder');

    const result = await handlers[CHANNEL]({}, target);

    expect(result).toEqual({
      success: false,
      error:
        'That folder is inside a link that points outside your allowed locations. Choose the real folder instead.',
      errorCode: 'LINK_OUTSIDE_ALLOWED'
    });
    expect(fs.existsSync(path.join(outside, 'New Folder'))).toBe(false);

    // The log names the folder as spelled; never the link's target.
    const { logger } = require('../src/shared/logger');
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('LINK_OUTSIDE_ALLOWED');
    expect(logged).not.toContain(JSON.stringify(outside).slice(1, -1));
  });

  test('the junction itself is refused the same way', async () => {
    if (!escapeLink) return;
    const result = await handlers[CHANNEL]({}, escapeLink);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('LINK_OUTSIDE_ALLOWED');
  });

  test('a normal folder in the allowed location is still created', async () => {
    const target = path.join(allowedBase, 'Projects', 'Receipts');

    const result = await handlers[CHANNEL]({}, target);

    expect(result).toEqual(
      expect.objectContaining({ success: true, path: target, alreadyExisted: false })
    );
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  test('a junction to a folder inside the allowed location still works', async () => {
    const realDir = path.join(allowedBase, 'real-docs');
    fs.mkdirSync(realDir, { recursive: true });
    const insideLink = path.join(allowedBase, 'docs-link');
    try {
      fs.symlinkSync(realDir, insideLink, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return;
    }
    try {
      const result = await handlers[CHANNEL]({}, path.join(insideLink, 'Sub'));
      expect(result.success).toBe(true);
      expect(fs.statSync(path.join(realDir, 'Sub')).isDirectory()).toBe(true);
    } finally {
      fs.unlinkSync(insideLink);
    }
  });

  test('a path outside the allowed locations as spelled keeps the generic refusal', async () => {
    const result = await handlers[CHANNEL]({}, path.join(outside, 'Elsewhere'));
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PATH_NOT_ALLOWED');
    expect(fs.existsSync(path.join(outside, 'Elsewhere'))).toBe(false);
  });
});
