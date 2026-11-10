/**
 * @jest-environment node
 *
 * Nothing holds a file open while the model works on it, so it can be
 * renamed, moved or deleted in that time. The watcher records the result with
 * the size and date it read before the pass, so the record no longer touches
 * the disk: a file that vanished during its analysis got a history entry, a
 * "file analyzed" notification and learning feedback all the same.
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfw-gone-'));
  file = path.join(root, 'invoice.pdf');
  fs.writeFileSync(file, 'synthetic');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const RESULT = {
  analysis: { category: 'Finance', keywords: ['invoice'], summary: 'An invoice', confidence: 90 }
};

/** A watcher whose analyzer runs `duringAnalysis` and then returns a result. */
function makeWatcher(duringAnalysis) {
  const watcher = new SmartFolderWatcher({
    getSmartFolders: () => [{ id: 'f1', name: 'Finance', path: root }],
    analysisHistoryService: {
      recordAnalysis: jest.fn().mockResolvedValue(undefined),
      getAnalysisByPath: jest.fn().mockResolvedValue(null),
      getAnalysisByHash: jest.fn().mockResolvedValue(null)
    },
    settingsService: { load: jest.fn().mockResolvedValue({}) },
    notificationService: {
      notifyFileAnalyzed: jest.fn().mockResolvedValue(undefined),
      notifyLowConfidence: jest.fn().mockResolvedValue(undefined)
    },
    analyzeDocumentFile: jest.fn(async () => {
      await duringAnalysis();
      return RESULT;
    }),
    analyzeImageFile: jest.fn()
  });
  watcher.isRunning = true;
  watcher.watchedPaths = new Set([root]);
  watcher._embedAnalyzedFile = jest.fn().mockResolvedValue(undefined);
  watcher._recordLearningFeedback = jest.fn().mockResolvedValue(undefined);
  return watcher;
}

const analyze = (watcher) =>
  watcher._analyzeFile({ filePath: file, eventType: 'add', mtime: Date.now() });

function expectNothingRecorded(watcher) {
  expect(watcher.analyzeDocumentFile).toHaveBeenCalledTimes(1);
  expect(watcher.analysisHistoryService.recordAnalysis).not.toHaveBeenCalled();
  expect(watcher.notificationService.notifyFileAnalyzed).not.toHaveBeenCalled();
  expect(watcher._embedAnalyzedFile).not.toHaveBeenCalled();
  expect(watcher._recordLearningFeedback).not.toHaveBeenCalled();
  expect(watcher.stats.filesAnalyzed).toBe(0);
  expect(watcher.stats.errors).toBe(0);
}

describe('SmartFolderWatcher and a file that vanishes during its analysis', () => {
  test('a file deleted during the model pass is not recorded', async () => {
    const watcher = makeWatcher(async () => fs.rmSync(file));

    await analyze(watcher);

    expectNothingRecorded(watcher);
  });

  test('a file renamed during the model pass is not recorded under its old name', async () => {
    const watcher = makeWatcher(async () =>
      fs.renameSync(file, path.join(root, 'invoice-2026.pdf'))
    );

    await analyze(watcher);

    expectNothingRecorded(watcher);
  });

  test('an embedding retry for a file that goes during it embeds nothing', async () => {
    const watcher = makeWatcher(async () => {});
    // Gone after the retry found the file, before it embeds: the folder
    // lookup is the one step in between.
    const linkCheck = watcher._linkEscapeReason.bind(watcher);
    let found = false;
    watcher._linkEscapeReason = async (filePath) => {
      const reason = await linkCheck(filePath);
      found = true;
      return reason;
    };
    watcher.getSmartFolders = () => {
      if (found) fs.rmSync(file, { force: true });
      return [{ id: 'f1', name: 'Finance', path: root }];
    };

    await watcher._analyzeFile({
      filePath: file,
      eventType: 'add',
      retryCount: 1,
      cachedAnalysis: RESULT
    });

    expect(fs.existsSync(file)).toBe(false);
    expect(watcher._embedAnalyzedFile).not.toHaveBeenCalled();
    expect(watcher.analysisQueue).toEqual([]);
  });

  test('a file that is still there is recorded as before', async () => {
    const watcher = makeWatcher(async () => {});
    const before = fs.statSync(file);

    await analyze(watcher);

    const { recordAnalysis } = watcher.analysisHistoryService;
    expect(recordAnalysis).toHaveBeenCalledTimes(1);
    expect(recordAnalysis.mock.calls[0][0]).toEqual(
      expect.objectContaining({ size: before.size, lastModified: before.mtimeMs })
    );
    expect(watcher.notificationService.notifyFileAnalyzed).toHaveBeenCalledTimes(1);
    expect(watcher._embedAnalyzedFile).toHaveBeenCalledWith(file, RESULT);
    expect(watcher.stats.filesAnalyzed).toBe(1);
  });
});
