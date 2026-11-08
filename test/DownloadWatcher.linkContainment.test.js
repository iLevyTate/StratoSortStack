/**
 * @jest-environment node
 *
 * The Downloads watcher must not follow a link out of the Downloads folder.
 * chokidar (followSymlinks: false) still reports a file symlink as an 'add',
 * and fs.stat / readFile follow it (or a junction part-way down the path) to
 * the target anywhere on disk, which was then analyzed, recorded and possibly
 * renamed under the link's path. SmartFolderWatcher refuses these; these
 * tests pin the same rule here, on the real filesystem in a temp directory.
 * They also pin that stop() cancels a media analysis in flight.
 */

// The global test setup swaps fs for memfs; links and realpath need the real
// filesystem.
jest.mock('fs', () => jest.requireActual('fs'));
jest.mock('fs/promises', () => jest.requireActual('fs/promises'));
jest.mock('os', () => jest.requireActual('os'));

jest.mock('chokidar', () => ({
  watch: jest.fn(() => ({
    on: jest.fn().mockReturnThis(),
    close: jest.fn().mockResolvedValue(),
    removeAllListeners: jest.fn()
  }))
}));

jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  };
  return { logger, createLogger: () => logger };
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const DownloadWatcher = require('../src/main/services/DownloadWatcher');

const isWindows = process.platform === 'win32';

let base;
let downloads;
let outside;

beforeEach(() => {
  base = spelledTempPath(fs.mkdtempSync(path.join(os.tmpdir(), 'dlw-links-')));
  downloads = path.join(base, 'Downloads');
  outside = path.join(base, 'outside');
  fs.mkdirSync(downloads);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'private text outside Downloads');
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

function makeWatcher(overrides = {}) {
  const watcher = new DownloadWatcher({
    analyzeDocumentFile: jest.fn().mockResolvedValue(null),
    analyzeImageFile: jest.fn().mockResolvedValue(null),
    analyzeMediaFile: jest.fn().mockResolvedValue(null),
    getCustomFolders: () => [],
    settingsService: { load: jest.fn().mockResolvedValue({}) },
    ...overrides
  });
  watcher.downloadsPath = downloads;
  return watcher;
}

/** Create a file symlink, or return null where the OS refuses (Windows without the privilege). */
function tryFileSymlink(target, link) {
  try {
    fs.symlinkSync(target, link, 'file');
    return link;
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return null;
    throw error;
  }
}

// The temp root as a user would pass it. On Windows expand 8.3 short names
// (RUNNER~1) so it matches what the code resolves. On macOS keep the OS
// spelling: /var/folders/... resolves to /private/var/..., which is on the
// system-directory denylist as typed, and no user ever passes that form.
function spelledTempPath(p) {
  return process.platform === 'darwin' ? p : fs.realpathSync.native(p);
}

describe('DownloadWatcher link containment', () => {
  test('a regular download is accepted', async () => {
    const watcher = makeWatcher();
    const filePath = path.join(downloads, 'report.txt');
    fs.writeFileSync(filePath, 'hello');

    await expect(watcher._validateFile(filePath, {})).resolves.toBe(true);
  });

  test('a file symlink to a file outside Downloads is refused', async () => {
    const watcher = makeWatcher();
    const link = tryFileSymlink(path.join(outside, 'secret.txt'), path.join(downloads, 'link.txt'));
    if (!link) return; // symlink creation not permitted on this machine

    await expect(watcher._validateFile(link, {})).resolves.toBe(false);
  });

  test('a file reached through a junction to a folder outside Downloads is refused', async () => {
    const watcher = makeWatcher();
    fs.symlinkSync(outside, path.join(downloads, 'linked'), isWindows ? 'junction' : 'dir');
    const viaJunction = path.join(downloads, 'linked', 'secret.txt');
    expect(fs.lstatSync(viaJunction).isSymbolicLink()).toBe(false);

    await expect(watcher._validateFile(viaJunction, {})).resolves.toBe(false);
  });

  test('a Downloads folder that is itself a junction (moved to another drive) still works', async () => {
    const realDownloads = path.join(base, 'D-drive-Downloads');
    fs.mkdirSync(realDownloads);
    const aliasDownloads = path.join(base, 'AliasDownloads');
    fs.symlinkSync(realDownloads, aliasDownloads, isWindows ? 'junction' : 'dir');
    const watcher = makeWatcher();
    watcher.downloadsPath = aliasDownloads;
    const filePath = path.join(aliasDownloads, 'report.txt');
    fs.writeFileSync(filePath, 'hello');

    await expect(watcher._validateFile(filePath, {})).resolves.toBe(true);
  });

  test('where native realpath fails on the volume, a regular download is still accepted', async () => {
    jest.spyOn(fs.promises, 'realpath').mockRejectedValue(
      Object.assign(new Error('EISDIR: illegal operation on a directory, realpath'), {
        code: 'EISDIR'
      })
    );
    const watcher = makeWatcher();
    const filePath = path.join(downloads, 'report.txt');
    fs.writeFileSync(filePath, 'hello');

    await expect(watcher._validateFile(filePath, {})).resolves.toBe(true);
  });

  test('a link out of Downloads never reaches the analyzer through handleFile', async () => {
    const watcher = makeWatcher();
    fs.symlinkSync(outside, path.join(downloads, 'linked'), isWindows ? 'junction' : 'dir');

    await watcher.handleFile(path.join(downloads, 'linked', 'secret.txt'));

    expect(watcher.analyzeDocumentFile).not.toHaveBeenCalled();
  });
});

describe('DownloadWatcher media analysis cancellation', () => {
  test('stop() aborts the signal passed to analyzeMediaFile', async () => {
    let receivedSignal = null;
    let markCalled;
    const called = new Promise((resolve) => {
      markCalled = resolve;
    });
    const analyzeMediaFile = jest.fn((_filePath, _folders, options = {}) => {
      receivedSignal = options.signal || options.abortSignal || null;
      markCalled();
      return new Promise((_resolve, reject) => {
        if (!receivedSignal) return; // never settles without a signal
        receivedSignal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });
    const watcher = makeWatcher({ analyzeMediaFile });
    const filePath = path.join(downloads, 'meeting.mp3');
    fs.writeFileSync(filePath, 'not really audio');

    const pipeline = watcher.handleFile(filePath);
    watcher._inFlightHandles.add(pipeline);
    await called;
    await watcher.stop();

    expect(receivedSignal).not.toBeNull();
    expect(receivedSignal.aborted).toBe(true);
    await expect(pipeline).resolves.toBeUndefined();
  }, 15000);
});
