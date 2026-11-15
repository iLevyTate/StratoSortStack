/**
 * @jest-environment node
 *
 * Smart Folders can nest. chokidar's unwatch() closes and ignores the whole
 * subtree of the path it is given, and a later add() lifts that ignore only
 * for the exact path added. Removing a nested Smart Folder used to unwatch it
 * even though its parent was still watched, so new files there raised no
 * events until a restart, and its queued analysis was dropped. Removing the
 * outer folder blinded the inner one the same way.
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

const fs = require('fs');
const os = require('os');
const path = require('path');
const SmartFolderWatcher = require('../src/main/services/SmartFolderWatcher');

let base;
let outer;
let inner;
let other;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'sfw-nested-'));
  outer = path.join(base, 'Work');
  inner = path.join(outer, 'Invoices');
  other = path.join(base, 'Other');
  fs.mkdirSync(inner, { recursive: true });
  fs.mkdirSync(other);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

/** A running watcher over `watched` with a stand-in chokidar instance. */
function makeWatcher(watched) {
  const watcher = new SmartFolderWatcher({
    getSmartFolders: () =>
      watched.map((p, i) => ({ id: `f${i}`, name: path.basename(p), path: p })),
    analysisHistoryService: {},
    settingsService: { load: jest.fn().mockResolvedValue({}) },
    analyzeDocumentFile: jest.fn(),
    analyzeImageFile: jest.fn()
  });
  watcher.isRunning = true;
  watcher.watcher = { add: jest.fn(), unwatch: jest.fn() };
  watcher.watchedPaths = new Set(watched);
  watcher.restart = jest.fn().mockResolvedValue(true);
  return watcher;
}

const folders = (...paths) => paths.map((p, i) => ({ id: `f${i}`, path: p }));

describe('SmartFolderWatcher.updateWatchedFolders with nested Smart Folders', () => {
  test('removing a nested folder keeps watching it through its parent and keeps its work', async () => {
    const watcher = makeWatcher([outer, inner]);
    const queued = path.join(inner, 'invoice.pdf');
    const timeout = setTimeout(() => {}, 60_000);
    watcher.analysisQueue = [{ filePath: queued }];
    watcher.pendingAnalysis.set(queued, { filePath: queued, timeout });

    try {
      await watcher.updateWatchedFolders(folders(outer));

      expect(watcher.watcher.unwatch).not.toHaveBeenCalled();
      expect(watcher.restart).not.toHaveBeenCalled();
      expect([...watcher.watchedPaths]).toEqual([outer]);
      expect(watcher.analysisQueue.map((i) => i.filePath)).toEqual([queued]);
      expect(watcher.pendingAnalysis.has(queued)).toBe(true);
    } finally {
      clearTimeout(timeout);
    }
  });

  test('removing the outer folder restarts instead of unwatching over the nested one', async () => {
    const watcher = makeWatcher([outer, inner]);
    const keep = path.join(inner, 'invoice.pdf');
    const drop = path.join(outer, 'notes.pdf');
    watcher.analysisQueue = [{ filePath: keep }, { filePath: drop }];

    await watcher.updateWatchedFolders(folders(inner));

    expect(watcher.watcher.unwatch).not.toHaveBeenCalled();
    expect(watcher.restart).toHaveBeenCalledTimes(1);
    expect([...watcher.watchedPaths]).toEqual([inner]);
    // stop() persists what is left and start() restores it, so the purge
    // must spare the nested folder's work.
    expect(watcher.analysisQueue.map((i) => i.filePath)).toEqual([keep]);
  });

  test('a folder with no nesting is still unwatched in place', async () => {
    const watcher = makeWatcher([outer, other]);
    watcher.analysisQueue = [{ filePath: path.join(other, 'a.pdf') }];

    await watcher.updateWatchedFolders(folders(outer));

    expect(watcher.watcher.unwatch).toHaveBeenCalledWith(other);
    expect(watcher.restart).not.toHaveBeenCalled();
    expect(watcher.analysisQueue).toEqual([]);
  });

  test('adding a parent of a folder unwatched earlier restarts, since add() cannot lift that ignore', async () => {
    const watcher = makeWatcher([inner, other]);

    await watcher.updateWatchedFolders(folders(other));
    expect(watcher.watcher.unwatch).toHaveBeenCalledWith(inner);
    expect(watcher.restart).not.toHaveBeenCalled();

    await watcher.updateWatchedFolders(folders(other, outer));
    expect(watcher.watcher.add).toHaveBeenCalledWith(outer);
    expect(watcher.restart).toHaveBeenCalledTimes(1);
  });

  test('re-adding the exact folder unwatched earlier does not restart', async () => {
    const watcher = makeWatcher([inner, other]);

    await watcher.updateWatchedFolders(folders(other));
    await watcher.updateWatchedFolders(folders(other, inner));

    expect(watcher.watcher.add).toHaveBeenCalledWith(inner);
    expect(watcher.restart).not.toHaveBeenCalled();
  });
});
