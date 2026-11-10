/**
 * @jest-environment node
 *
 * Reading a file can raise a change event for it. On NTFS the first read in
 * an hour rewrites the last-access time, Windows reports a change, and
 * chokidar 6 passes it on although mtime and size are what they were. The
 * event reaches the watcher a few seconds into its own analysis of the file,
 * before the history has it, so every file the watcher analyzed was queued a
 * second time (and, for an image, cost a vision batch that analyzed nothing).
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

let root;
let file;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfw-echo-'));
  file = path.join(root, 'report.pdf');
  fs.writeFileSync(file, 'synthetic');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A watcher whose analyzer runs `duringAnalysis` (the moment the change event
 * arrives) and then fails, which ends _analyzeFile without the history ever
 * getting the file: the state the event finds in a live run.
 */
function makeWatcher(duringAnalysis) {
  const watcher = new SmartFolderWatcher({
    getSmartFolders: () => [{ id: 'f1', name: 'Finance', path: root }],
    analysisHistoryService: {
      recordAnalysis: jest.fn().mockResolvedValue(undefined),
      getAnalysisByPath: jest.fn().mockResolvedValue(null),
      getAnalysisByHash: jest.fn().mockResolvedValue(null)
    },
    settingsService: { load: jest.fn().mockResolvedValue({}) },
    analyzeDocumentFile: jest.fn(async () => {
      await duringAnalysis(watcher);
      throw new Error('stop after analyzer call');
    }),
    analyzeImageFile: jest.fn()
  });
  watcher.isRunning = true;
  watcher.watchedPaths = new Set([root]);
  return watcher;
}

const changeEvent = (watcher) =>
  watcher._queueFileForAnalysis(file, Date.now(), 'change', undefined, undefined);

const analyze = (watcher) =>
  watcher._analyzeFile({ filePath: file, eventType: 'add', mtime: Date.now() }).catch(() => {});

describe('SmartFolderWatcher and change events from its own read', () => {
  test('a change event for a file it is analyzing, with mtime and size unchanged, is not queued', async () => {
    const watcher = makeWatcher(changeEvent);

    await analyze(watcher);

    expect(watcher.analyzeDocumentFile).toHaveBeenCalledTimes(1);
    expect(watcher.analysisQueue).toEqual([]);
  });

  test('a file edited during its analysis is queued again', async () => {
    const watcher = makeWatcher(async (w) => {
      fs.writeFileSync(file, 'synthetic, edited while it was analyzed');
      await changeEvent(w);
    });

    await analyze(watcher);

    expect(watcher.analysisQueue).toEqual([
      expect.objectContaining({ filePath: file, eventType: 'change' })
    ]);
  });

  test('a rewrite of the same length during its analysis is queued again', async () => {
    const watcher = makeWatcher(async (w) => {
      fs.writeFileSync(file, 'SYNTHETIC');
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(file, later, later);
      await changeEvent(w);
    });

    await analyze(watcher);

    expect(watcher.analysisQueue).toEqual([
      expect.objectContaining({ filePath: file, eventType: 'change' })
    ]);
  });

  // An embedding retry reads nothing, so no event during it is its echo.
  // The edit here was saved before the retry began: the retry stats the file
  // as edited, and the event for the edit arrives while it embeds.
  test('a change event during an embedding retry is judged by the history', async () => {
    const watcher = makeWatcher(async () => {});
    watcher._embedAnalyzedFile = jest.fn(() => changeEvent(watcher));

    await watcher._analyzeFile({
      filePath: file,
      eventType: 'add',
      mtime: Date.now(),
      retryCount: 1,
      cachedAnalysis: { analysis: { category: 'Finance' } }
    });

    expect(watcher._embedAnalyzedFile).toHaveBeenCalledTimes(1);
    expect(watcher.analysisQueue).toEqual([
      expect.objectContaining({ filePath: file, eventType: 'change' })
    ]);
  });

  test('a change event after the analysis ended is judged by the history as before', async () => {
    const watcher = makeWatcher(async () => {});

    await analyze(watcher);
    await changeEvent(watcher);

    // The analyzer failed, so the history has no entry: still to be analyzed.
    expect(watcher.analysisQueue).toEqual([
      expect.objectContaining({ filePath: file, eventType: 'change' })
    ]);
  });
});
