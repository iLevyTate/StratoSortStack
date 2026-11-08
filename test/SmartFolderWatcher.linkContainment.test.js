/**
 * @jest-environment node
 *
 * The live watcher must never follow a link out of a smart folder. chokidar
 * (followSymlinks: false) still reports a file symlink as an 'add', and a
 * path under a junction/directory link is an ordinary file to lstat, yet
 * fs.stat / readFile follow both to the target anywhere on disk, which was
 * then read, analyzed, embedded (and possibly sent to a cloud provider) under
 * the link's path. The startup scan already skips links; these tests pin the
 * same rule for live events and for queued items, on a real filesystem.
 */

// The global test setup swaps fs for memfs; links, realpath and 8.3 names
// need the real filesystem.
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

const fs = require('fs');
const os = require('os');
const path = require('path');
const SmartFolderWatcher = require('../src/main/services/SmartFolderWatcher');

let base;
let root;
let outside;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'sfw-links-'));
  root = path.join(base, 'watched');
  outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'private text outside the smart folder');
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function makeWatcher() {
  const watcher = new SmartFolderWatcher({
    getSmartFolders: () => [{ id: 'f1', name: 'Watched', path: root }],
    analysisHistoryService: {
      recordAnalysis: jest.fn().mockResolvedValue(undefined),
      getAnalysisByPath: jest.fn().mockResolvedValue(null)
    },
    settingsService: { load: jest.fn().mockResolvedValue({}) },
    analyzeDocumentFile: jest.fn().mockRejectedValue(new Error('stop after analyzer call')),
    analyzeImageFile: jest.fn()
  });
  watcher.isRunning = true;
  watcher.watchedPaths = new Set([root]);
  // Not under test: move detection and the history gate.
  watcher._attemptMoveResolution = jest.fn().mockResolvedValue(false);
  watcher._needsAnalysis = jest.fn().mockResolvedValue(true);
  return watcher;
}

async function liveAdd(watcher, filePath) {
  const stats = fs.statSync(filePath);
  await watcher._queueFileForAnalysis(filePath, stats.mtimeMs, 'add', stats, filePath);
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

describe('SmartFolderWatcher link containment', () => {
  test('a regular file inside the smart folder is queued', async () => {
    const watcher = makeWatcher();
    const filePath = path.join(root, 'notes.txt');
    fs.writeFileSync(filePath, 'hello');

    await liveAdd(watcher, filePath);

    expect(watcher.analysisQueue.map((i) => i.filePath)).toEqual([filePath]);
  });

  test('a file reached through a junction to a folder outside is not queued', async () => {
    const watcher = makeWatcher();
    fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
    const viaJunction = path.join(root, 'linked', 'secret.txt');
    expect(fs.lstatSync(viaJunction).isSymbolicLink()).toBe(false);

    await liveAdd(watcher, viaJunction);

    expect(watcher.analysisQueue).toHaveLength(0);
  });

  test('a file symlink to a file outside is not queued', async () => {
    const watcher = makeWatcher();
    const link = tryFileSymlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    if (!link) return; // symlink creation not permitted on this machine

    await liveAdd(watcher, link);

    expect(watcher.analysisQueue).toHaveLength(0);
  });

  test('a queued item whose path now leads outside is not analyzed', async () => {
    const watcher = makeWatcher();
    fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');
    const viaJunction = path.join(root, 'linked', 'secret.txt');

    await watcher._analyzeFile({ filePath: viaJunction, eventType: 'add' });

    expect(watcher.analyzeDocumentFile).not.toHaveBeenCalled();
  });

  test('a queued regular file inside the smart folder still reaches the analyzer', async () => {
    const watcher = makeWatcher();
    const filePath = path.join(root, 'notes.txt');
    fs.writeFileSync(filePath, 'hello');

    await expect(watcher._analyzeFile({ filePath, eventType: 'add' })).rejects.toThrow(
      'stop after analyzer call'
    );
    expect(watcher.analyzeDocumentFile).toHaveBeenCalledTimes(1);
  });

  test('a smart folder whose own path goes through a junction still works', async () => {
    const realRoot = path.join(base, 'real-root');
    fs.mkdirSync(realRoot);
    const aliasRoot = path.join(base, 'alias-root');
    fs.symlinkSync(realRoot, aliasRoot, 'junction');
    root = aliasRoot;
    const watcher = makeWatcher();
    const filePath = path.join(aliasRoot, 'notes.txt');
    fs.writeFileSync(filePath, 'hello');

    await liveAdd(watcher, filePath);

    expect(watcher.analysisQueue.map((i) => i.filePath)).toEqual([filePath]);
  });

  describe('when native realpath fails on the volume', () => {
    // fs.promises.realpath is the native resolver (GetFinalPathNameByHandle
    // on Windows); it fails with EISDIR/EINVAL on some volumes (RAM disks,
    // VeraCrypt/ImDisk containers, some virtual cloud drives). The JS walk
    // (lstat + readlink) still resolves links there.
    beforeEach(() => {
      jest.spyOn(fs.promises, 'realpath').mockRejectedValue(
        Object.assign(new Error('EISDIR: illegal operation on a directory, realpath'), {
          code: 'EISDIR'
        })
      );
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('a regular file inside the smart folder is still queued', async () => {
      const watcher = makeWatcher();
      const filePath = path.join(root, 'notes.txt');
      fs.writeFileSync(filePath, 'hello');

      await liveAdd(watcher, filePath);

      expect(watcher.analysisQueue.map((i) => i.filePath)).toEqual([filePath]);
    });

    test('a file reached through a junction to a folder outside is still refused', async () => {
      const watcher = makeWatcher();
      fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');

      await liveAdd(watcher, path.join(root, 'linked', 'secret.txt'));

      expect(watcher.analysisQueue).toHaveLength(0);
    });
  });

  test('a smart folder configured by its 8.3 short name still works', async () => {
    if (process.platform !== 'win32') return;
    const longRoot = path.join(base, 'A Very Long Smart Folder');
    fs.mkdirSync(longRoot);
    const listing = require('child_process').execSync(`cmd /c dir /x "${base}"`).toString();
    const match = listing.match(/\s(\S+~\d+)\s+A Very Long Smart Folder/);
    if (!match) return; // 8.3 names disabled on this volume
    root = path.join(base, match[1]);
    const watcher = makeWatcher();
    const filePath = path.join(root, 'notes.txt');
    fs.writeFileSync(filePath, 'hello');

    await liveAdd(watcher, filePath);

    expect(watcher.analysisQueue.map((i) => i.filePath)).toEqual([filePath]);
  });
});
