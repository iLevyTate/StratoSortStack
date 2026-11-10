/**
 * @jest-environment node
 *
 * An embedding retry carries the result of a pass that is over and only
 * embeds it again. Two ways that went wrong:
 *
 * - the retry gave way to an item already queued for the file, and that item
 *   was then skipped as already analyzed, so nothing embedded the file;
 * - the file changed after the pass, and the retry embedded the old result
 *   over whatever the newer pass had stored.
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
let watcher;
let duringAnalysis;

const RESULT = {
  analysis: { category: 'Finance', keywords: ['invoice'], summary: 'An invoice', confidence: 90 }
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfw-fresh-'));
  file = path.join(root, 'invoice.pdf');
  fs.writeFileSync(file, 'synthetic');
  duringAnalysis = () => {};
  watcher = new SmartFolderWatcher({
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
  // The embedding after the first pass fails; later ones work.
  watcher._embedAnalyzedFile = jest
    .fn()
    .mockRejectedValueOnce(new Error('embedding model busy'))
    .mockResolvedValue(undefined);
  watcher._recordLearningFeedback = jest.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  watcher._isStopping = true;
  fs.rmSync(root, { recursive: true, force: true });
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function firstPass() {
  await watcher._analyzeFile({ filePath: file, eventType: 'add', mtime: Date.now() });
  await settle();
}

const takeQueued = () => watcher.analysisQueue.splice(0);

describe('an embedding retry that gave way to a queued item', () => {
  // A scan reaches the file while its pass is running and queues it again.
  const scanDuringPass = () => {
    duringAnalysis = () =>
      watcher._enqueueAnalysisItem({ filePath: file, mtime: Date.now(), eventType: 'scan' });
  };

  test('is embedded when that item turns out to need no analysis', async () => {
    scanDuringPass();
    await firstPass();

    const queued = takeQueued();
    expect(queued).toEqual([expect.objectContaining({ eventType: 'scan' })]);
    expect(queued[0].cachedAnalysis).toBeUndefined();

    // The history has the file by now.
    watcher._needsAnalysis = jest.fn().mockResolvedValue(false);
    await watcher._analyzeFile(queued[0]);

    expect(watcher.analyzeDocumentFile).toHaveBeenCalledTimes(1);
    expect(watcher._embedAnalyzedFile).toHaveBeenCalledTimes(2);
    expect(watcher._embedAnalyzedFile).toHaveBeenLastCalledWith(file, RESULT);
    expect(watcher.analysisHistoryService.recordAnalysis).toHaveBeenCalledTimes(1);
  });

  test('is left alone when that item runs a pass of its own', async () => {
    scanDuringPass();
    await firstPass();
    const [queued] = takeQueued();
    duringAnalysis = () => {};

    watcher._needsAnalysis = jest.fn().mockResolvedValue(true);
    await watcher._analyzeFile(queued);
    await settle();

    expect(watcher.analyzeDocumentFile).toHaveBeenCalledTimes(2);
    // Once after each pass; the result of the first is not embedded a third time.
    expect(watcher._embedAnalyzedFile).toHaveBeenCalledTimes(2);
    expect(watcher.analysisQueue).toEqual([]);
  });
});

describe('an embedding retry for a file that changed since its pass', () => {
  test('embeds nothing: the result is of the content before', async () => {
    await firstPass();
    const [retry] = takeQueued();
    expect(retry.cachedAnalysis).toBe(RESULT);

    fs.writeFileSync(file, 'synthetic, edited after the pass');
    await watcher._analyzeFile(retry);

    expect(watcher._embedAnalyzedFile).toHaveBeenCalledTimes(1);
    expect(watcher.analysisQueue).toEqual([]);
  });

  test('a file that did not change is embedded as before', async () => {
    await firstPass();
    const [retry] = takeQueued();

    await watcher._analyzeFile(retry);

    expect(watcher._embedAnalyzedFile).toHaveBeenCalledTimes(2);
    expect(watcher._embedAnalyzedFile).toHaveBeenLastCalledWith(file, RESULT);
  });
});
