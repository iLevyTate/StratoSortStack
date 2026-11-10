/**
 * @jest-environment node
 *
 * An embedding retry is a queue item that carries the result of the analysis
 * before it (`cachedAnalysis`) and only embeds that again. When one took the
 * place of a queued item that was still to run the model (a reanalysis the
 * user asked for, a newer change event), the request was lost: the item kept
 * the old result, so the file was never read again.
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
const {
  claimUserAnalysis,
  _resetUserAnalysisInFlight
} = require('../src/main/analysis/userAnalysisInFlight');

let root;
let file;
let watcher;

const OLD_RESULT = { analysis: { category: 'Finance', keywords: ['old'], summary: 'Old text' } };

beforeEach(() => {
  _resetUserAnalysisInFlight();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfw-retry-'));
  file = path.join(root, 'invoice.pdf');
  fs.writeFileSync(file, 'synthetic');
  watcher = new SmartFolderWatcher({
    getSmartFolders: () => [{ id: 'f1', name: 'Finance', path: root }],
    analysisHistoryService: {
      recordAnalysis: jest.fn().mockResolvedValue(undefined),
      getAnalysisByPath: jest.fn().mockResolvedValue(null),
      getAnalysisByHash: jest.fn().mockResolvedValue(null)
    },
    settingsService: { load: jest.fn().mockResolvedValue({}) },
    analyzeDocumentFile: jest.fn().mockRejectedValue(new Error('stop after analyzer call')),
    analyzeImageFile: jest.fn()
  });
  watcher.isRunning = true;
  watcher.watchedPaths = new Set([root]);
  watcher._embedAnalyzedFile = jest.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  watcher._isStopping = true;
  clearTimeout(watcher._userAnalysisHoldTimer);
  _resetUserAnalysisInFlight();
  fs.rmSync(root, { recursive: true, force: true });
});

const embeddingRetry = (filePath, extra = {}) => ({
  filePath,
  mtime: 1000,
  eventType: 'add',
  retryCount: 1,
  cachedAnalysis: OLD_RESULT,
  ...extra
});

describe('an embedding retry and a queued request for the same file', () => {
  test('a reanalysis the user asked for still runs the model', async () => {
    watcher._enqueueAnalysisItem({ filePath: file, eventType: 'reanalyze', applyNaming: true });
    watcher._enqueueAnalysisItem(embeddingRetry(file));

    expect(watcher.analysisQueue).toHaveLength(1);
    const [queued] = watcher.analysisQueue;
    expect(queued).toEqual(expect.objectContaining({ eventType: 'reanalyze', applyNaming: true }));
    expect(queued.cachedAnalysis).toBeUndefined();

    await watcher._analyzeFile(queued).catch(() => {});
    expect(watcher.analyzeDocumentFile).toHaveBeenCalledTimes(1);
  });

  test('a second reanalysis is not replaced by the retry of the first', () => {
    watcher._enqueueAnalysisItem({ filePath: file, eventType: 'reanalyze', applyNaming: false });
    watcher._enqueueAnalysisItem(embeddingRetry(file, { eventType: 'reanalyze' }));

    expect(watcher.analysisQueue).toHaveLength(1);
    expect(watcher.analysisQueue[0].cachedAnalysis).toBeUndefined();
    expect(watcher.analysisQueue[0].applyNaming).toBe(false);
  });

  test('a queued change event is not replaced by the retry of the pass before it', async () => {
    watcher._enqueueAnalysisItem({ filePath: file, mtime: 2000, eventType: 'change' });
    watcher._enqueueAnalysisItem(embeddingRetry(file));

    expect(watcher.analysisQueue).toHaveLength(1);
    const [queued] = watcher.analysisQueue;
    expect(queued).toEqual(expect.objectContaining({ eventType: 'change', mtime: 2000 }));
    expect(queued.cachedAnalysis).toBeUndefined();

    await watcher._analyzeFile(queued).catch(() => {});
    expect(watcher.analyzeDocumentFile).toHaveBeenCalledTimes(1);
  });

  test('a retry still replaces the retry before it', () => {
    watcher._enqueueAnalysisItem(embeddingRetry(file));
    watcher._enqueueAnalysisItem(embeddingRetry(file, { retryCount: 2 }));

    expect(watcher.analysisQueue).toHaveLength(1);
    expect(watcher.analysisQueue[0]).toEqual(
      expect.objectContaining({ retryCount: 2, cachedAnalysis: OLD_RESULT })
    );
  });

  test('a change event still replaces a queued retry and runs the model', () => {
    watcher._enqueueAnalysisItem(embeddingRetry(file));
    watcher._enqueueAnalysisItem({ filePath: file, mtime: 2000, eventType: 'change' });

    expect(watcher.analysisQueue).toHaveLength(1);
    expect(watcher.analysisQueue[0].eventType).toBe('change');
    expect(watcher.analysisQueue[0].cachedAnalysis).toBeUndefined();
  });

  test('a retry with nothing queued for the file is queued as one', () => {
    watcher._enqueueAnalysisItem(embeddingRetry(file));

    expect(watcher.analysisQueue).toEqual([
      expect.objectContaining({ filePath: file, cachedAnalysis: OLD_RESULT })
    ]);
  });
});

describe('an image batch handed back when a Discover analysis starts', () => {
  // The images of a batch are off the queue while it runs. A retry for one of
  // them can be queued meanwhile; when the batch is handed back, that queued
  // item is the one that stays.
  function batchOfTwo(secondItem) {
    const first = path.join(root, 'a.png');
    const second = path.join(root, 'b.png');
    watcher._imageItemNeedsVision = jest.fn().mockResolvedValue(false);
    watcher._analyzeFile = jest.fn(async () => {
      // The embedding of an earlier pass over the second image fails now...
      watcher._enqueueAnalysisItem(embeddingRetry(second));
      // ...and the user starts a Discover analysis.
      claimUserAnalysis(path.join(root, 'discover-file.pdf'));
    });
    watcher.analysisQueue.push(
      { filePath: first, mtime: 1, eventType: 'add' },
      { filePath: second, ...secondItem }
    );
    return second;
  }

  test('a reanalysis waiting in the batch is not turned into an embedding retry', async () => {
    const second = batchOfTwo({ mtime: 1, eventType: 'reanalyze', applyNaming: true });

    await watcher._processQueue();

    expect(watcher._analyzeFile).toHaveBeenCalledTimes(1);
    expect(watcher.analysisQueue).toHaveLength(1);
    const [queued] = watcher.analysisQueue;
    expect(queued).toEqual(
      expect.objectContaining({ filePath: second, eventType: 'reanalyze', applyNaming: true })
    );
    expect(queued.cachedAnalysis).toBeUndefined();
  });

  test('a change event waiting in the batch is not turned into one either', async () => {
    const second = batchOfTwo({ mtime: 2000, eventType: 'change' });

    await watcher._processQueue();

    expect(watcher._analyzeFile).toHaveBeenCalledTimes(1);
    expect(watcher.analysisQueue).toHaveLength(1);
    expect(watcher.analysisQueue[0].filePath).toBe(second);
    expect(watcher.analysisQueue[0].cachedAnalysis).toBeUndefined();
  });
});

describe('an item put on the queue without a key (Reanalyze all)', () => {
  // The analysis holds the file under its normalized path. The check for
  // "is this file being analyzed" looked the raw path up instead, so a second
  // item for the file was started beside the first.
  test('is not started while an analysis of the same file is running', () => {
    const item = { filePath: file, mtime: 1, eventType: 'reanalyze' };
    watcher.processingFiles.add(watcher._queueItemKey(item));

    expect(watcher._makeRunnableCheck()(item)).toBe(false);

    watcher.processingFiles.clear();
    expect(watcher._makeRunnableCheck()(item)).toBe(true);
  });
});
