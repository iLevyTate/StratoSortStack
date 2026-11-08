/**
 * @jest-environment node
 *
 * SmartFolderWatcher queue mechanics around failures and stopping:
 * - a failed analysis is retried after a backoff, not immediately, so a
 *   transient condition (model memory budget, a running vision batch, a
 *   locked file) does not burn every attempt within milliseconds and end in
 *   an "Analysis Failed" record and toast;
 * - the queue does not spin on setTimeout(0) while every queued item is
 *   still being analyzed by an earlier pass or waiting out its backoff;
 * - the overflow buffer is drained even when the main queue is empty;
 * - stop()/shutdown() abort the analysis in flight and stay inside the
 *   shutdown phase budget, and an aborted item is not recorded as failed,
 *   even when the analysis only unwinds after stop() has returned; the rest
 *   of an image batch does not run after stop.
 */

jest.mock('chokidar', () => ({
  watch: jest.fn(() => ({
    on: jest.fn().mockReturnThis(),
    once: jest.fn(),
    close: jest.fn().mockResolvedValue()
  }))
}));

// No in-process model in these tests: image batches run without vision batch mode.
jest.mock('../src/main/services/LlamaService', () => ({ getInstance: () => null }));

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

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sfw-retry-'));
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeDoc(name) {
  const filePath = path.join(tmpRoot, name);
  fs.writeFileSync(filePath, 'hello world');
  return filePath;
}

function makeWatcher(overrides = {}) {
  const watcher = new SmartFolderWatcher({
    getSmartFolders: () => [{ id: 'f1', name: 'Root', path: tmpRoot }],
    analysisHistoryService: {
      recordAnalysis: jest.fn().mockResolvedValue(undefined),
      getAnalysisByPath: jest.fn().mockResolvedValue(null)
    },
    settingsService: { load: jest.fn().mockResolvedValue({}) },
    notificationService: { notifyWatcherError: jest.fn().mockResolvedValue(undefined) },
    analyzeDocumentFile: jest.fn(),
    analyzeImageFile: jest.fn(),
    ...overrides
  });
  watcher.isRunning = true;
  return watcher;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function budgetError() {
  const error = new Error('Model memory budget exceeded');
  error.code = 'MODEL_MEMORY_BUDGET_EXCEEDED';
  return error;
}

function countProcessQueueCalls(watcher) {
  const original = watcher._processQueue.bind(watcher);
  const counter = { calls: 0 };
  watcher._processQueue = (...args) => {
    counter.calls += 1;
    return original(...args);
  };
  return counter;
}

describe('SmartFolderWatcher retry backoff', () => {
  test('a failed analysis is retried after a delay, not straight away', async () => {
    const watcher = makeWatcher();
    watcher.analyzeDocumentFile.mockRejectedValue(budgetError());
    const filePath = writeDoc('a.txt');

    watcher._enqueueAnalysisItem({ filePath, eventType: 'add', queuedAt: Date.now() });
    await watcher._processQueue();
    await sleep(150);

    expect(watcher.analyzeDocumentFile).toHaveBeenCalledTimes(1);
    expect(watcher.notificationService.notifyWatcherError).not.toHaveBeenCalled();
    expect(watcher.analysisQueue).toHaveLength(1);
    const [firstRetry] = watcher.analysisQueue;
    expect(firstRetry.retryCount).toBe(1);
    const firstDelay = firstRetry.notBefore - Date.now();
    expect(firstDelay).toBeGreaterThan(0);

    // Once the delay has passed the retry runs, and the next one waits longer.
    const later = firstRetry.notBefore + 1;
    jest.spyOn(Date, 'now').mockReturnValue(later);
    await watcher._processQueue();
    expect(watcher.analyzeDocumentFile).toHaveBeenCalledTimes(2);
    const [secondRetry] = watcher.analysisQueue;
    expect(secondRetry.retryCount).toBe(2);
    expect(secondRetry.notBefore - later).toBeGreaterThan(firstDelay);
    watcher.isRunning = false;
  });

  test('a waiting retry does not hold up other queued files', async () => {
    const watcher = makeWatcher();
    watcher._analyzeWithTimeout = jest.fn().mockResolvedValue(undefined);
    const waiting = { filePath: writeDoc('w.txt'), retryCount: 1, notBefore: Date.now() + 60_000 };
    const fresh = { filePath: writeDoc('f.txt') };
    watcher.analysisQueue.push(waiting, fresh);

    await watcher._processQueue();
    watcher.isRunning = false;

    expect(watcher._analyzeWithTimeout).toHaveBeenCalledTimes(1);
    expect(watcher._analyzeWithTimeout.mock.calls[0][0].filePath).toBe(fresh.filePath);
    expect(watcher.analysisQueue).toEqual([waiting]);
  });
});

describe('SmartFolderWatcher queue re-entry', () => {
  test('does not spin while every queued item is still being analyzed', async () => {
    const watcher = makeWatcher();
    const filePath = writeDoc('busy.txt');
    watcher.processingFiles.add(filePath);
    watcher.analysisQueue.push({ filePath, dedupKey: filePath });
    const counter = countProcessQueueCalls(watcher);

    await watcher._processQueue();
    await sleep(300);
    watcher.isRunning = false;

    expect(counter.calls).toBeLessThanOrEqual(2);
  });

  test('does not spin while the only queued item is waiting out its backoff', async () => {
    const watcher = makeWatcher();
    watcher._analyzeWithTimeout = jest.fn().mockResolvedValue(undefined);
    watcher.analysisQueue.push({
      filePath: writeDoc('later.txt'),
      retryCount: 1,
      notBefore: Date.now() + 60_000
    });
    const counter = countProcessQueueCalls(watcher);

    await watcher._processQueue();
    await sleep(300);
    watcher.isRunning = false;

    expect(counter.calls).toBeLessThanOrEqual(2);
    expect(watcher._analyzeWithTimeout).not.toHaveBeenCalled();
  });
});

describe('SmartFolderWatcher overflow buffer', () => {
  test('is drained into an empty main queue on the next tick', async () => {
    const watcher = makeWatcher();
    watcher._analyzeWithTimeout = jest.fn().mockResolvedValue(undefined);
    const overflowItem = { filePath: writeDoc('overflow.txt'), eventType: 'reanalyze' };
    watcher.analysisQueue = [];
    watcher._pendingReanalyzeItems = [overflowItem];

    await watcher._processQueue();
    watcher.isRunning = false;

    expect(watcher._analyzeWithTimeout).toHaveBeenCalledTimes(1);
    expect(watcher._analyzeWithTimeout.mock.calls[0][0].filePath).toBe(overflowItem.filePath);
    expect(watcher._pendingReanalyzeItems).toHaveLength(0);
  });
});

describe('SmartFolderWatcher stop with analysis in flight', () => {
  test('shutdown aborts the running analysis and does not record it as failed', async () => {
    let receivedSignal;
    let started;
    const analyzerStarted = new Promise((resolve) => {
      started = resolve;
    });
    const watcher = makeWatcher();
    watcher.analyzeDocumentFile.mockImplementation((_p, _cats, options) => {
      receivedSignal = options.abortSignal;
      started();
      return new Promise((_resolve, reject) => {
        options.abortSignal.addEventListener('abort', () => {
          const error = new Error('Operation aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });
    // Last allowed attempt: a failure now would write "Analysis Failed".
    watcher.analysisQueue.push({ filePath: writeDoc('long.txt'), retryCount: 3 });

    const processing = watcher._processQueue();
    await analyzerStarted;
    const t0 = Date.now();
    await watcher.shutdown();
    const elapsed = Date.now() - t0;

    expect(receivedSignal.aborted).toBe(true);
    expect(elapsed).toBeLessThan(3000);
    await processing;
    expect(watcher.notificationService.notifyWatcherError).not.toHaveBeenCalled();
    expect(watcher.analysisHistoryService.recordAnalysis).not.toHaveBeenCalled();
  }, 45_000);

  test('shutdown does not wait the full in-flight window for an analysis that ignores abort', async () => {
    const watcher = makeWatcher();
    let started;
    const analyzerStarted = new Promise((resolve) => {
      started = resolve;
    });
    watcher.analyzeDocumentFile.mockImplementation(() => {
      started();
      return new Promise(() => {});
    });
    watcher.analysisQueue.push({ filePath: writeDoc('stuck.txt') });

    void watcher._processQueue();
    await analyzerStarted;
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    let resolved = false;
    const shutdown = watcher.shutdown().then(() => {
      resolved = true;
      return undefined;
    });
    // lifecycle gives the whole serviceIntegration phase 20 s; the watcher's
    // share must leave room for the services shut down after it.
    await jest.advanceTimersByTimeAsync(10_000);
    expect(resolved).toBe(true);
    await shutdown;
  }, 45_000);

  test('an analysis that unwinds from the abort only after shutdown returned is not recorded as failed', async () => {
    const watcher = makeWatcher();
    let started;
    const analyzerStarted = new Promise((resolve) => {
      started = resolve;
    });
    watcher.analyzeDocumentFile.mockImplementation((_p, _cats, options) => {
      started();
      return new Promise((_resolve, reject) => {
        // Honours the abort, but takes longer than shutdown's in-flight wait.
        options.abortSignal.addEventListener('abort', () => {
          setTimeout(() => {
            const error = new Error('Operation aborted');
            error.name = 'AbortError';
            reject(error);
          }, 6_000);
        });
      });
    });
    // Last allowed attempt: a failure now would write "Analysis Failed".
    watcher.analysisQueue.push({ filePath: writeDoc('slow-abort.txt'), retryCount: 3 });

    const processing = watcher._processQueue();
    await analyzerStarted;
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    let shutdownDone = false;
    const shutdown = watcher.shutdown().then(() => {
      shutdownDone = true;
      return undefined;
    });
    await jest.advanceTimersByTimeAsync(5_500);
    expect(shutdownDone).toBe(true);
    await jest.advanceTimersByTimeAsync(2_000);
    await shutdown;
    await processing;

    expect(watcher.notificationService.notifyWatcherError).not.toHaveBeenCalled();
    expect(watcher.analysisHistoryService.recordAnalysis).not.toHaveBeenCalled();
    expect(watcher.analysisQueue).toHaveLength(0);
  }, 45_000);

  test('the rest of an image batch is not analyzed once shutdown has returned', async () => {
    const watcher = makeWatcher();
    let started;
    const analyzerStarted = new Promise((resolve) => {
      started = resolve;
    });
    // Anything after the first image fails fast instead of hanging the test.
    watcher.analyzeImageFile.mockRejectedValue(new Error('analyzed after stop'));
    watcher.analyzeImageFile.mockImplementationOnce((_filePath, _cats, options) => {
      started();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          setTimeout(() => {
            const error = new Error('Operation aborted');
            error.name = 'AbortError';
            reject(error);
          }, 6_000);
        });
      });
    });
    watcher.analysisQueue.push(
      { filePath: writeDoc('one.png'), retryCount: 3 },
      { filePath: writeDoc('two.png') }
    );

    const processing = watcher._processQueue();
    await analyzerStarted;
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const shutdown = watcher.shutdown();
    await jest.advanceTimersByTimeAsync(7_500);
    await shutdown;
    await processing;

    expect(watcher.analyzeImageFile).toHaveBeenCalledTimes(1);
    expect(watcher.notificationService.notifyWatcherError).not.toHaveBeenCalled();
    expect(watcher.analysisHistoryService.recordAnalysis).not.toHaveBeenCalled();
  }, 45_000);
});
