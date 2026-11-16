/**
 * @jest-environment node
 *
 * The startup reconcile and the orphan reaper delete a file's history,
 * vectors and chunks once they decide the file is gone. They used to take any
 * failure to reach the file as "gone", so a share that blipped or a folder
 * that denied access wiped the analysis of files that still exist. Only a
 * definite "not found", under a Smart Folder that can itself be reached,
 * counts now.
 */

jest.mock('fs', () => jest.requireActual('fs'));
jest.mock('fs/promises', () => jest.requireActual('fs/promises'));
jest.mock('os', () => jest.requireActual('os'));
jest.mock('chokidar', () => ({
  watch: jest.fn(() => ({
    on: jest.fn().mockReturnThis(),
    once: jest.fn(),
    close: jest.fn().mockResolvedValue()
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
// The reconcile waits 5 s for startup to settle before sweeping.
jest.mock('../src/shared/promiseUtils', () => ({
  ...jest.requireActual('../src/shared/promiseUtils'),
  delay: jest.fn().mockResolvedValue(undefined)
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const SmartFolderWatcher = require('../src/main/services/SmartFolderWatcher');

let base;
let root;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'sfw-sweep-'));
  root = path.join(base, 'Share');
  fs.mkdirSync(root);
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

function makeWatcher(filePaths) {
  const entries = {};
  filePaths.forEach((p, i) => {
    entries[`e${i}`] = { originalPath: p };
  });
  const watcher = new SmartFolderWatcher({
    getSmartFolders: () => [{ id: 'f1', name: 'Share', path: root }],
    analysisHistoryService: { analysisHistory: { entries } },
    settingsService: { load: jest.fn().mockResolvedValue({}) },
    analyzeDocumentFile: jest.fn(),
    analyzeImageFile: jest.fn()
  });
  watcher.isRunning = true;
  watcher.watchedPaths = new Set([root]);
  watcher.vectorDbService = {};
  watcher._finalizeDeletion = jest.fn().mockResolvedValue(undefined);
  return watcher;
}

/** Make fs.promises.stat fail with `code` for the given paths only. */
function failStatFor(paths, code) {
  const realStat = fs.promises.stat.bind(fs.promises);
  jest.spyOn(fs.promises, 'stat').mockImplementation(async (p, ...rest) => {
    if (paths.includes(p)) throw Object.assign(new Error(code), { code });
    return realStat(p, ...rest);
  });
}

const errnoError = (code) => Object.assign(new Error(code), { code });

describe('startup reconcile', () => {
  test('removes only files that are definitely not found', async () => {
    const deleted = path.join(root, 'deleted.pdf');
    const ioError = path.join(root, 'io-error.pdf');
    const denied = path.join(root, 'denied.pdf');
    fs.writeFileSync(ioError, 'synthetic');
    fs.writeFileSync(denied, 'synthetic');
    const watcher = makeWatcher([deleted, ioError, denied]);
    // Fail every way of probing the file, so the test does not depend on
    // which call the sweep uses.
    for (const method of ['stat', 'access']) {
      const real = fs.promises[method].bind(fs.promises);
      jest.spyOn(fs.promises, method).mockImplementation(async (p, ...rest) => {
        if (p === ioError) throw errnoError('EIO');
        if (p === denied) throw errnoError('EACCES');
        return real(p, ...rest);
      });
    }

    await watcher._reconcileOrphanedEntries();

    expect(watcher._finalizeDeletion).toHaveBeenCalledTimes(1);
    expect(watcher._finalizeDeletion).toHaveBeenCalledWith(deleted);
  });

  test('a Smart Folder that cannot be reached removes nothing, even when its files read as not found', async () => {
    const a = path.join(root, 'a.pdf');
    const b = path.join(root, 'b.pdf');
    const watcher = makeWatcher([a, b]);
    // A dropped share: the files and the folder all fail to stat.
    failStatFor([root], 'ETIMEDOUT');

    await watcher._reconcileOrphanedEntries();

    expect(watcher._finalizeDeletion).not.toHaveBeenCalled();
  });
});

describe('orphan reaper', () => {
  test('keeps an orphan whose file cannot be read, and skips one whose Smart Folder is unreachable', async () => {
    const reachable = path.join(root, 'locked.pdf');
    fs.writeFileSync(reachable, 'synthetic');
    const watcher = makeWatcher([]);
    watcher.vectorDbService = {
      getOrphanedFileDocs: jest.fn().mockResolvedValue([{ id: 'file:1', path: reachable }])
    };
    failStatFor([reachable], 'EACCES');

    await expect(watcher._reapStaleOrphans()).resolves.toEqual({
      reaped: 0,
      kept: 1,
      skipped: 0
    });

    jest.restoreAllMocks();
    const missing = path.join(root, 'missing.pdf');
    watcher.vectorDbService.getOrphanedFileDocs.mockResolvedValue([
      { id: 'file:2', path: missing }
    ]);
    failStatFor([root], 'EHOSTDOWN');

    await expect(watcher._reapStaleOrphans()).resolves.toEqual({
      reaped: 0,
      kept: 0,
      skipped: 1
    });
    expect(watcher._finalizeDeletion).not.toHaveBeenCalled();
  });

  test('reaps an orphan whose file is gone from a reachable Smart Folder', async () => {
    const missing = path.join(root, 'missing.pdf');
    const watcher = makeWatcher([]);
    watcher.vectorDbService = {
      getOrphanedFileDocs: jest.fn().mockResolvedValue([{ id: 'file:1', path: missing }])
    };

    await expect(watcher._reapStaleOrphans()).resolves.toEqual({
      reaped: 1,
      kept: 0,
      skipped: 0
    });
    expect(watcher._finalizeDeletion).toHaveBeenCalledWith(missing);
  });
});
