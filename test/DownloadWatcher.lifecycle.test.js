/**
 * @jest-environment node
 */
/**
 * DownloadWatcher lifecycle regressions:
 *  - error-driven restart must actually re-create the chokidar watcher
 *    (stop() used to leave `_stopped` latched, so the restart timer's guard
 *    was always true and the watcher died for the session on the first
 *    retryable error);
 *  - shutdown() must be terminal — no queued restart may re-create the
 *    watcher on a disposed instance;
 *  - an `unlink` that is really a move performed by the app (batch organize
 *    under the ghost-cleanup latch, or an operation-tracker-recorded move)
 *    must not delete the file's embeddings and analysis history.
 */

const mockFs = {
  stat: jest.fn(),
  access: jest.fn(),
  mkdir: jest.fn().mockResolvedValue(undefined),
  rename: jest.fn().mockResolvedValue(undefined)
};
jest.mock('fs', () => ({ promises: mockFs, constants: { R_OK: 4 } }));

// Each chokidar.watch() call returns a fresh fake watcher that records its
// event handlers so tests can fire 'error' / 'unlink' as chokidar would.
const mockWatchers = [];
jest.mock('chokidar', () => ({
  watch: jest.fn(() => {
    const handlers = {};
    const watcher = {
      handlers,
      on: jest.fn((event, handler) => {
        handlers[event] = handler;
        return watcher;
      }),
      close: jest.fn().mockResolvedValue(undefined),
      removeAllListeners: jest.fn()
    };
    mockWatchers.push(watcher);
    return watcher;
  })
}));

jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

jest.mock('../src/main/errors/FileSystemError', () => {
  class FileSystemError extends Error {
    constructor(code) {
      super(`FileSystemError: ${code}`);
      this.code = code;
      this.isFileSystemError = true;
    }
    getUserFriendlyMessage() {
      return this.message;
    }
    shouldRetry() {
      return true;
    }
    toJSON() {
      return { code: this.code };
    }
    static fromNodeError() {
      return new FileSystemError('NODE_ERROR');
    }
    static forOperation(op) {
      return new FileSystemError(`${op.toUpperCase()}_FAILED`);
    }
  }
  class WatcherError extends FileSystemError {
    constructor() {
      super('WATCHER_FAILED');
    }
  }
  return { FileSystemError, WatcherError };
});

jest.mock('../src/shared/atomicFileOperations', () => ({
  crossDeviceMove: jest.fn().mockResolvedValue(undefined),
  renameNoReplace: jest.fn((src, dest) => require('fs').promises.rename(src, dest))
}));

// Set-backed tracker stand-in: recordOperation(p) makes wasRecentlyOperated(p)
// true, which is the only contract _handleFileDeletion relies on.
const mockTrackedPaths = new Set();
jest.mock('../src/shared/fileOperationTracker', () => ({
  getInstance: jest.fn(() => ({
    wasRecentlyOperated: jest.fn((p) => mockTrackedPaths.has(p)),
    recordOperation: jest.fn((p) => mockTrackedPaths.add(p)),
    clear: jest.fn(),
    shutdown: jest.fn()
  })),
  FileOperationTracker: jest.fn(),
  DEFAULT_COOLDOWN_MS: 5000
}));

const chokidar = require('chokidar');
const { getInstance: getFileOperationTracker } = require('../src/shared/fileOperationTracker');
const { deferGhostCleanup, resumeGhostCleanup } = require('../src/shared/ghostCleanupGuard');
const DownloadWatcher = require('../src/main/services/DownloadWatcher');

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

function makeWatcher(extraDeps = {}) {
  return new DownloadWatcher({
    analyzeDocumentFile: jest.fn(),
    analyzeImageFile: jest.fn(),
    getCustomFolders: jest.fn().mockReturnValue([]),
    autoOrganizeService: { processNewFile: jest.fn() },
    settingsService: { load: jest.fn().mockResolvedValue({ autoOrganize: true }) },
    ...extraDeps
  });
}

async function startAndSettle(watcher) {
  const started = watcher.start();
  await flushMicrotasks();
  await started;
}

describe('DownloadWatcher lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWatchers.length = 0;
    mockTrackedPaths.clear();
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    mockFs.stat.mockResolvedValue({ isDirectory: () => true, size: 100 });
    mockFs.access.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('error-driven restart', () => {
    test('re-creates the chokidar watcher after a retryable error', async () => {
      const watcher = makeWatcher();
      await startAndSettle(watcher);
      expect(chokidar.watch).toHaveBeenCalledTimes(1);

      mockWatchers[0].handlers.error(new Error('EMFILE: too many open files'));
      await flushMicrotasks();
      expect(watcher.watcher).toBeNull();
      expect(watcher.restartTimer).not.toBeNull();

      await jest.advanceTimersByTimeAsync(watcher.restartDelay * watcher.restartAttempts);
      await flushMicrotasks();

      expect(chokidar.watch).toHaveBeenCalledTimes(2);
      expect(watcher.watcher).toBe(mockWatchers[1]);
      expect(watcher._stopped).toBe(false);
    });

    test('shutdown() is terminal: no restart is scheduled or fired afterwards', async () => {
      const watcher = makeWatcher();
      await startAndSettle(watcher);
      const liveWatcher = mockWatchers[0];

      await watcher.shutdown();
      expect(watcher.watcher).toBeNull();

      // A late chokidar error on the (already detached) watcher.
      liveWatcher.handlers.error(new Error('EMFILE: too many open files'));
      await flushMicrotasks();
      await jest.advanceTimersByTimeAsync(watcher.restartDelay * 3);
      await flushMicrotasks();

      expect(watcher.restartTimer).toBeNull();
      expect(chokidar.watch).toHaveBeenCalledTimes(1);
      expect(watcher.watcher).toBeNull();
    });

    test('shutdown() racing an in-progress error restart wins', async () => {
      const watcher = makeWatcher();
      await startAndSettle(watcher);

      // Error handler has called stop() and queued its restart .then, but
      // the timer is not scheduled yet when shutdown() latches the instance.
      mockWatchers[0].handlers.error(new Error('EMFILE: too many open files'));
      await watcher.shutdown();
      await flushMicrotasks();
      await jest.advanceTimersByTimeAsync(watcher.restartDelay * 3);
      await flushMicrotasks();

      expect(chokidar.watch).toHaveBeenCalledTimes(1);
      expect(watcher.watcher).toBeNull();
    });

    test('stop() during an error restart cancels it but leaves the instance resumable', async () => {
      const watcher = makeWatcher();
      await startAndSettle(watcher);

      // Restart chain has torn down and queued its .then; the user disables
      // auto-organize before the timer fires.
      mockWatchers[0].handlers.error(new Error('EMFILE: too many open files'));
      await watcher.stop();
      await flushMicrotasks();
      await jest.advanceTimersByTimeAsync(watcher.restartDelay * 3);
      await flushMicrotasks();

      expect(chokidar.watch).toHaveBeenCalledTimes(1);
      expect(watcher.watcher).toBeNull();
      expect(watcher.restartTimer).toBeNull();

      // Same singleton instance is re-enabled later.
      await startAndSettle(watcher);
      expect(chokidar.watch).toHaveBeenCalledTimes(2);
      expect(watcher.watcher).toBe(mockWatchers[1]);
    });

    test('stop() after the restart timer is scheduled cancels the timer', async () => {
      const watcher = makeWatcher();
      await startAndSettle(watcher);

      mockWatchers[0].handlers.error(new Error('EMFILE: too many open files'));
      await flushMicrotasks();
      expect(watcher.restartTimer).not.toBeNull();

      await watcher.stop();
      await jest.advanceTimersByTimeAsync(watcher.restartDelay * 3);
      await flushMicrotasks();

      expect(chokidar.watch).toHaveBeenCalledTimes(1);
      expect(watcher.watcher).toBeNull();
    });

    test('stop() during a pending start never leaves a watcher behind', async () => {
      const watcher = makeWatcher();
      let releaseStat;
      mockFs.stat.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseStat = () => resolve({ isDirectory: () => true });
          })
      );

      const starting = watcher.start();
      await flushMicrotasks();
      const stopping = watcher.stop();
      await flushMicrotasks();
      releaseStat();
      await Promise.all([starting, stopping]);

      expect(watcher.watcher).toBeNull();
      expect(watcher._stopped).toBe(false);
    });
  });

  describe('_handleFileDeletion gates', () => {
    const filePath = '/downloads/report.pdf';
    let vectorDbService;
    let analysisHistoryService;
    let watcher;

    beforeEach(() => {
      vectorDbService = {
        batchDeleteFileEmbeddings: jest.fn().mockResolvedValue(undefined),
        deleteFileChunks: jest.fn().mockResolvedValue(undefined)
      };
      analysisHistoryService = { removeEntriesByPath: jest.fn().mockResolvedValue(undefined) };
      watcher = makeWatcher({ vectorDbService, analysisHistoryService });
    });

    test('skips cleanup while a batch organize holds the ghost-cleanup latch', async () => {
      deferGhostCleanup();
      try {
        await watcher._handleFileDeletion(filePath);
      } finally {
        resumeGhostCleanup();
      }

      expect(vectorDbService.batchDeleteFileEmbeddings).not.toHaveBeenCalled();
      expect(vectorDbService.deleteFileChunks).not.toHaveBeenCalled();
      expect(analysisHistoryService.removeEntriesByPath).not.toHaveBeenCalled();
    });

    test('skips cleanup for a path the app itself just moved', async () => {
      getFileOperationTracker().recordOperation(filePath, 'move', 'undoRedo');

      await watcher._handleFileDeletion(filePath);

      expect(vectorDbService.batchDeleteFileEmbeddings).not.toHaveBeenCalled();
      expect(analysisHistoryService.removeEntriesByPath).not.toHaveBeenCalled();
    });

    test('cleans up embeddings and history for a genuine external deletion', async () => {
      await watcher._handleFileDeletion(filePath);

      expect(vectorDbService.batchDeleteFileEmbeddings).toHaveBeenCalledTimes(1);
      expect(vectorDbService.batchDeleteFileEmbeddings.mock.calls[0][0]).toEqual(
        expect.arrayContaining([expect.stringContaining(filePath)])
      );
      expect(analysisHistoryService.removeEntriesByPath).toHaveBeenCalledWith(filePath);
    });
  });
});
