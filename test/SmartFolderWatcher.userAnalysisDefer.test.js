/**
 * @jest-environment node
 *
 * In a live run the smart-folder watcher analyzed the same PDFs the user was
 * analyzing from Discover, at the same time: twice the GPU work and an
 * "analyzed" notification from each. Files a user-started analysis is
 * working on are now deferred by the watcher and re-checked afterwards.
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
  isUserAnalysisInFlight,
  withUserAnalysis,
  _resetUserAnalysisInFlight
} = require('../src/main/analysis/userAnalysisInFlight');

let root;
let file;

beforeEach(() => {
  _resetUserAnalysisInFlight();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfw-user-'));
  file = path.join(root, 'invoice.pdf');
  fs.writeFileSync(file, 'synthetic');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('userAnalysisInFlight', () => {
  test('marks a file for the duration of a claim', () => {
    const release = claimUserAnalysis([file]);
    expect(isUserAnalysisInFlight(file)).toBe(true);
    release();
    release();
    expect(isUserAnalysisInFlight(file)).toBe(false);
  });

  test('overlapping claims keep the file marked until both end', () => {
    const a = claimUserAnalysis(file);
    const b = claimUserAnalysis([file]);
    a();
    expect(isUserAnalysisInFlight(file)).toBe(true);
    b();
    expect(isUserAnalysisInFlight(file)).toBe(false);
  });

  test('withUserAnalysis releases on failure too', async () => {
    await expect(
      withUserAnalysis(file, async () => {
        expect(isUserAnalysisInFlight(file)).toBe(true);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(isUserAnalysisInFlight(file)).toBe(false);
  });
});

function makeWatcher({ needsAnalysis = true } = {}) {
  const watcher = new SmartFolderWatcher({
    getSmartFolders: () => [{ id: 'f1', name: 'Finance', path: root }],
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
  watcher._needsAnalysis = jest.fn().mockResolvedValue(needsAnalysis);
  return watcher;
}

describe('SmartFolderWatcher defers files Discover is analyzing', () => {
  test('a file in a user analysis is requeued with a delay, not analyzed', async () => {
    const watcher = makeWatcher();
    const release = claimUserAnalysis(file);
    const before = Date.now();
    await watcher._analyzeFile({ filePath: file, eventType: 'add', mtime: Date.now() });
    release();

    expect(watcher.analyzeDocumentFile).not.toHaveBeenCalled();
    const queued = watcher.analysisQueue.find((q) => q.filePath === file);
    expect(queued).toEqual(expect.objectContaining({ recheck: true }));
    expect(queued.notBefore).toBeGreaterThanOrEqual(before + 10000);
  });

  test('the re-check skips the file once the history has it', async () => {
    const watcher = makeWatcher({ needsAnalysis: false });
    await watcher._analyzeFile({ filePath: file, eventType: 'add', recheck: true });
    expect(watcher._needsAnalysis).toHaveBeenCalled();
    expect(watcher.analyzeDocumentFile).not.toHaveBeenCalled();
  });

  test('a file nobody else is analyzing goes straight to the analyzer', async () => {
    const watcher = makeWatcher();
    await watcher
      ._analyzeFile({ filePath: file, eventType: 'add', mtime: Date.now() })
      .catch(() => {});
    expect(watcher.analyzeDocumentFile).toHaveBeenCalled();
  });

  test('an explicit reanalyze request is never deferred', async () => {
    const watcher = makeWatcher();
    const release = claimUserAnalysis(file);
    await watcher._analyzeFile({ filePath: file, eventType: 'reanalyze' }).catch(() => {});
    release();
    expect(watcher.analyzeDocumentFile).toHaveBeenCalled();
  });
});

describe('SmartFolderWatcher checks the history again before it analyzes', () => {
  // The whole queue is held while a Discover run is in progress. An item
  // queued before the run is no longer "in flight" when the queue resumes, so
  // only the history can say that Discover has analyzed it meanwhile.
  test('a queued file that was analyzed elsewhere meanwhile is skipped', async () => {
    const watcher = makeWatcher({ needsAnalysis: false });
    await watcher._analyzeFile({ filePath: file, eventType: 'add', mtime: Date.now() });
    expect(watcher._needsAnalysis).toHaveBeenCalled();
    expect(watcher.analyzeDocumentFile).not.toHaveBeenCalled();
  });

  // A change event that arrives while the watcher is analyzing the file is
  // queued (the history has nothing yet). Run after the first analysis, it
  // used to analyze the unchanged file again and store the original file
  // name over the suggested one.
  test('a change event for a file whose analysis is current is skipped', async () => {
    const watcher = makeWatcher({ needsAnalysis: false });
    await watcher._analyzeFile({ filePath: file, eventType: 'change', mtime: Date.now() });
    expect(watcher.analyzeDocumentFile).not.toHaveBeenCalled();
  });

  test('an explicit reanalyze request is not checked', async () => {
    const watcher = makeWatcher({ needsAnalysis: false });
    await watcher._analyzeFile({ filePath: file, eventType: 'reanalyze' }).catch(() => {});
    expect(watcher._needsAnalysis).not.toHaveBeenCalled();
    expect(watcher.analyzeDocumentFile).toHaveBeenCalled();
  });

  test('an embedding retry is not checked: its analysis is already in the history', async () => {
    const watcher = makeWatcher({ needsAnalysis: false });
    watcher._embedAnalyzedFile = jest.fn().mockResolvedValue(undefined);
    const cachedAnalysis = { analysis: { category: 'Finance', keywords: [] } };
    await watcher._analyzeFile({ filePath: file, eventType: 'add', cachedAnalysis, retryCount: 1 });
    expect(watcher._needsAnalysis).not.toHaveBeenCalled();
    expect(watcher._embedAnalyzedFile).toHaveBeenCalledWith(file, cachedAnalysis);
  });

  test('the history records the file as it was when the analysis started', async () => {
    const watcher = makeWatcher();
    watcher._embedAnalyzedFile = jest.fn().mockResolvedValue(undefined);
    const before = fs.statSync(file);
    watcher.analyzeDocumentFile = jest.fn(async () => {
      // The file is saved again while the model is still reading the old text.
      fs.writeFileSync(file, 'synthetic, edited during the analysis');
      fs.utimesSync(file, new Date(), new Date(before.mtimeMs + 60000));
      return { analysis: { category: 'Finance', keywords: ['invoice'], summary: 'An invoice' } };
    });

    await watcher._analyzeFile({ filePath: file, eventType: 'add', mtime: before.mtimeMs });

    const recordAnalysis = watcher.analysisHistoryService.recordAnalysis;
    expect(recordAnalysis).toHaveBeenCalledTimes(1);
    expect(recordAnalysis.mock.calls[0][0]).toEqual(
      expect.objectContaining({ size: before.size, lastModified: before.mtimeMs })
    );
  });
});

describe('SmartFolderWatcher holds its queue while a Discover analysis runs', () => {
  // Live run: a startup catch-up of 879 smart-folder files took turns with
  // the user's 11-file Discover batch, file by file, on one GPU.
  afterEach(() => {
    jest.useRealTimers();
  });

  test('nothing is analyzed during the run, and the queue resumes after it', async () => {
    jest.useFakeTimers();
    const watcher = makeWatcher();
    watcher._analyzeFile = jest.fn(async () => {});
    watcher.analysisQueue.push({ filePath: file, mtime: 1, eventType: 'add' });

    const release = claimUserAnalysis(path.join(root, 'other-discover-file.pdf'));
    await watcher._processQueue();
    expect(watcher._analyzeFile).not.toHaveBeenCalled();
    expect(watcher._userAnalysisHoldTimer).not.toBeNull();

    // Still running at the next check: still held.
    await jest.advanceTimersByTimeAsync(5000);
    expect(watcher._analyzeFile).not.toHaveBeenCalled();

    release();
    await jest.advanceTimersByTimeAsync(5000);
    expect(watcher._analyzeFile).toHaveBeenCalledTimes(1);
    expect(watcher._userAnalysisHoldTimer).toBeNull();
  });
});
