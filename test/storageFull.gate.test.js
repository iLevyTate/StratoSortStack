/**
 * Disk full: the vector store says so, and background analysis holds.
 *
 * A real run filled the disk; every vector-store save failed with ENOSPC,
 * the store gave up after five tries, and the watcher kept analyzing images
 * into a store that could not keep them. Nothing reached the user.
 */

const path = require('path');
const fsp = require('fs').promises;

jest.mock('electron', () => ({ app: { getPath: jest.fn() } }));
jest.mock('chokidar', () => ({ watch: jest.fn() }));
jest.mock('../src/shared/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: () => logger, logger };
});
jest.mock('../src/shared/singletonFactory', () => ({
  createSingletonHelpers: () => ({
    getInstance: jest.fn(),
    createInstance: jest.fn(),
    registerWithContainer: jest.fn(),
    resetInstance: jest.fn()
  })
}));
jest.mock('@orama/plugin-data-persistence', () => ({
  persist: jest.fn(async () => '{}'),
  restore: jest.fn(async () => {
    throw new Error('restore not available in test');
  })
}));
jest.mock('../src/main/llamaUtils', () => ({
  getEmbeddingModel: jest.fn(() => 'nomic-embed-text-v1.5-Q8_0.gguf'),
  loadLlamaConfig: jest.fn().mockResolvedValue({
    selectedEmbeddingModel: 'nomic-embed-text-v1.5-Q8_0.gguf'
  })
}));

const tracker = require('../src/main/services/DegradedStateTracker');

function raiseFull() {
  tracker.getInstance().raise({
    code: tracker.STORAGE_FULL_CODE,
    subsystem: 'storage',
    severity: 'error',
    message: 'full'
  });
}

describe('DegradedStateTracker storage-full flag', () => {
  beforeEach(() => tracker.getInstance()._reset());

  test('isStorageFull follows the flag, and dismissing the banner does not lift it', () => {
    expect(tracker.isStorageFull()).toBe(false);
    raiseFull();
    expect(tracker.isStorageFull()).toBe(true);
    tracker.getInstance().dismiss(tracker.STORAGE_FULL_CODE);
    expect(tracker.isStorageFull()).toBe(true);
    tracker.getInstance().clear(tracker.STORAGE_FULL_CODE);
    expect(tracker.isStorageFull()).toBe(false);
  });

  // Two stores raise the one flag. Whichever saved first used to clear it
  // while the other still could not write, so the hold and the banner flapped.
  test('the flag stays up until every store that raised it can save again', () => {
    const { VECTOR_STORE, ANALYSIS_HISTORY } = tracker.STORAGE_FULL_SOURCES;
    tracker.raiseStorageFull(VECTOR_STORE, { errno: 'ENOSPC' });
    tracker.raiseStorageFull(ANALYSIS_HISTORY, { errno: 'SQLITE_FULL' });
    const [both] = tracker.getInstance().list();
    expect(both.message).toMatch(/search index/);
    expect(both.message).toMatch(/analysis history/);
    tracker.getInstance().dismiss(tracker.STORAGE_FULL_CODE);

    expect(tracker.clearStorageFull(ANALYSIS_HISTORY)).toBe(false);
    expect(tracker.isStorageFull()).toBe(true);
    const [left] = tracker.getInstance().list();
    // Still the same, still-dismissed flag: the banner does not come back.
    expect(left.dismissed).toBe(true);
    expect(left.sources).toEqual([VECTOR_STORE]);
    expect(left.message).not.toMatch(/analysis history/);

    expect(tracker.clearStorageFull(VECTOR_STORE)).toBe(true);
    expect(tracker.isStorageFull()).toBe(false);
  });

  test('a store that never raised the flag cannot clear it', () => {
    const { VECTOR_STORE, ANALYSIS_HISTORY } = tracker.STORAGE_FULL_SOURCES;
    tracker.raiseStorageFull(VECTOR_STORE);
    tracker.clearStorageFull(ANALYSIS_HISTORY);
    expect(tracker.isStorageFull()).toBe(true);
  });
});

describe('isDiskFullError', () => {
  const { isDiskFullError } = require('../src/shared/errorClassifier');

  test('knows the Node and SQLite codes for a full disk, and nothing else', () => {
    expect(isDiskFullError({ code: 'ENOSPC' })).toBe(true);
    expect(isDiskFullError({ code: 'EDQUOT' })).toBe(true);
    expect(isDiskFullError({ code: 'SQLITE_FULL' })).toBe(true);
    expect(isDiskFullError('SQLITE_FULL')).toBe(true);
    expect(isDiskFullError(new Error('database or disk is full'))).toBe(true);
    expect(isDiskFullError({ code: 'EBUSY', message: 'locked' })).toBe(false);
    expect(isDiskFullError({ code: 'SQLITE_BUSY' })).toBe(false);
    expect(isDiskFullError(null)).toBe(false);
  });
});

describe('OramaVectorService on a full disk', () => {
  const { app } = require('electron');
  const { OramaVectorService } = require('../src/main/services/OramaVectorService');
  const TEMP_DIR = path.join(__dirname, 'temp-orama-storage-full');
  let service;
  let writeSpy;

  beforeAll(async () => {
    await fsp.mkdir(TEMP_DIR, { recursive: true });
  });
  afterAll(async () => {
    await fsp.rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    tracker.getInstance()._reset();
    app.getPath.mockReturnValue(TEMP_DIR);
    service = new OramaVectorService();
    await service.initialize();
  });
  afterEach(async () => {
    writeSpy?.mockRestore();
    if (service?.shutdown) await service.shutdown();
  });

  function diskFull() {
    writeSpy = jest
      .spyOn(fsp, 'writeFile')
      .mockRejectedValue(
        Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      );
  }

  async function persistOnce() {
    service._persistPending = true;
    await service._doPersist();
  }

  test('a save that fails with ENOSPC raises the storage-full banner', async () => {
    diskFull();
    await persistOnce();
    expect(tracker.isStorageFull()).toBe(true);
    expect(tracker.getInstance().list()[0].message).toMatch(/disk is full/i);
  });

  test('a save that fails for another reason does not claim the disk is full', async () => {
    writeSpy = jest
      .spyOn(fsp, 'writeFile')
      .mockRejectedValue(Object.assign(new Error('locked'), { code: 'EBUSY' }));
    await persistOnce();
    expect(tracker.isStorageFull()).toBe(false);
  });

  test('after five failures it keeps a once-a-minute retry, and the first good save clears the flag', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      diskFull();
      for (let i = 0; i < 5; i++) await persistOnce();
      expect(service._storageFullRetryTimer).toBeTruthy();

      writeSpy.mockRestore();
      writeSpy = null;
      const persisted = jest.spyOn(service, '_doPersist');
      jest.advanceTimersByTime(60_000);
      expect(persisted).toHaveBeenCalledTimes(1);
      await service._currentPersistPromise;
      expect(tracker.isStorageFull()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  // Space freed, but the retry then hit a lock (antivirus on the big .lz4)
  // instead of ENOSPC: no further retry was scheduled, so the flag and the
  // watchers' hold stayed on until some user action happened to save.
  test('the once-a-minute retry keeps going when a later attempt fails for another reason', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      diskFull();
      for (let i = 0; i < 5; i++) await persistOnce();
      expect(service._storageFullRetryTimer).toBeTruthy();

      writeSpy.mockRejectedValue(Object.assign(new Error('locked'), { code: 'EBUSY' }));
      jest.advanceTimersByTime(60_000);
      await service._currentPersistPromise;
      expect(tracker.isStorageFull()).toBe(true);
      expect(service._storageFullRetryTimer).toBeTruthy();

      writeSpy.mockRestore();
      writeSpy = null;
      jest.advanceTimersByTime(60_000);
      await service._currentPersistPromise;
      expect(tracker.isStorageFull()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  // The sidecar (uncompressed vectors) is the biggest write. It failing used
  // to be logged at debug level while the round still counted as saved, so
  // the flag cleared and incremental saves never wrote that sidecar again.
  test('a sidecar that fails to save is a failed save, and is written again next time', async () => {
    const realWriteFile = fsp.writeFile;
    writeSpy = jest
      .spyOn(fsp, 'writeFile')
      .mockImplementation((file, ...rest) =>
        String(file).includes('.sidecar.json')
          ? Promise.reject(
              Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
            )
          : realWriteFile.call(fsp, file, ...rest)
      );

    await persistOnce();
    expect(tracker.isStorageFull()).toBe(true);
    const collections = Object.keys(service._databases);
    expect(collections.length).toBeGreaterThan(0);
    for (const name of collections) expect(service._collectionNeedsSave(name)).toBe(true);

    writeSpy.mockRestore();
    writeSpy = null;
    await persistOnce();
    expect(tracker.isStorageFull()).toBe(false);
    for (const name of collections) expect(service._collectionNeedsSave(name)).toBe(false);
  });

  test('the vector store saving again does not lift analysis history’s hold', async () => {
    diskFull();
    await persistOnce();
    tracker.raiseStorageFull(tracker.STORAGE_FULL_SOURCES.ANALYSIS_HISTORY, {
      errno: 'SQLITE_FULL'
    });

    writeSpy.mockRestore();
    writeSpy = null;
    await persistOnce();
    expect(service._storageFullRaised).toBe(false);
    expect(tracker.isStorageFull()).toBe(true);
  });
});

describe('watchers hold while the disk is full', () => {
  beforeEach(() => {
    tracker.getInstance()._reset();
  });

  test('SmartFolderWatcher leaves its queue alone and looks again later', async () => {
    jest.useFakeTimers();
    try {
      const mod = require('../src/main/services/SmartFolderWatcher');
      const Watcher = mod.SmartFolderWatcher || mod;
      raiseFull();
      const fake = {
        _isStopping: false,
        isProcessingQueue: false,
        analysisQueue: [{ filePath: '/w/a.png' }],
        processingFiles: new Set(),
        _analyzeWithTimeout: jest.fn()
      };
      fake._processQueue = Watcher.prototype._processQueue;
      await fake._processQueue();
      expect(fake.analysisQueue).toHaveLength(1);
      expect(fake._analyzeWithTimeout).not.toHaveBeenCalled();
      expect(fake.isProcessingQueue).toBe(false);
      expect(fake._storageFullHoldTimer).toBeTruthy();

      // A second pass while still full does not stack another timer.
      const firstTimer = fake._storageFullHoldTimer;
      await fake._processQueue();
      expect(fake._storageFullHoldTimer).toBe(firstTimer);

      const recheck = jest.spyOn(fake, '_processQueue').mockResolvedValue(undefined);
      jest.advanceTimersByTime(60_000);
      expect(recheck).toHaveBeenCalledTimes(1);
      expect(fake._storageFullHoldTimer).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test('SmartFolderWatcher status says the queue is held, not being analyzed', () => {
    const mod = require('../src/main/services/SmartFolderWatcher');
    const Watcher = mod.SmartFolderWatcher || mod;
    const fake = {
      isRunning: true,
      isStarting: false,
      watchedPaths: new Set(['/w']),
      analysisQueue: [{ filePath: '/w/a.png' }, { filePath: '/w/b.png' }],
      processingFiles: new Set(),
      _pendingReanalyzeItems: [],
      _parkedItems: [],
      stats: {}
    };
    expect(Watcher.prototype.getStatus.call(fake).heldForDiskFull).toBe(false);
    raiseFull();
    expect(Watcher.prototype.getStatus.call(fake).heldForDiskFull).toBe(true);
    fake.analysisQueue = [];
    expect(Watcher.prototype.getStatus.call(fake).heldForDiskFull).toBe(false);
  });

  describe('DownloadWatcher', () => {
    const chokidar = require('chokidar');
    let watcher;

    const fakeChokidar = () => ({
      on: jest.fn(),
      removeAllListeners: jest.fn(),
      close: jest.fn().mockResolvedValue(undefined)
    });

    beforeEach(() => {
      jest.useFakeTimers();
      require('electron').app.getPath.mockReturnValue(path.join(__dirname, 'temp-dl-storage-full'));
      const mod = require('../src/main/services/DownloadWatcher');
      const DownloadWatcher = mod.DownloadWatcher || mod;
      watcher = new DownloadWatcher({
        settingsService: { load: jest.fn().mockResolvedValue({}) },
        analyzeDocumentFile: jest.fn(),
        analyzeImageFile: jest.fn()
      });
      // Running, as far as the hold is concerned.
      watcher.watcher = fakeChokidar();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    test('holds a new download instead of analyzing it, once per file', async () => {
      raiseFull();
      const load = jest.spyOn(watcher, '_loadSettingsSnapshot');
      await watcher.handleFile('/dl/report.pdf');
      // A second watcher event for the same file while it is held.
      await watcher.handleFile('/dl/report.pdf');
      expect(load).not.toHaveBeenCalled();
      expect(watcher.getStatus().heldForDiskFullCount).toBe(1);

      const handle = jest.spyOn(watcher, 'handleFile');
      const debounced = jest.spyOn(watcher, '_debouncedHandleFile').mockImplementation(() => {});
      // Still full at the recheck: nothing is let through.
      jest.advanceTimersByTime(60_000);
      expect(debounced).not.toHaveBeenCalled();

      tracker.getInstance()._reset();
      jest.advanceTimersByTime(60_000);
      // One run, through the debounced path so the per-file dedupe applies.
      expect(debounced).toHaveBeenCalledTimes(1);
      expect(debounced).toHaveBeenCalledWith('/dl/report.pdf');
      expect(handle).not.toHaveBeenCalled();
      expect(watcher.getStatus().heldForDiskFullCount).toBe(0);
    });

    test('stop() cancels the recheck, and the next start() picks the held download up', async () => {
      raiseFull();
      await watcher.handleFile('/dl/held.pdf');
      await watcher.stop();

      // The user turned the watcher off; space frees later. Nothing runs.
      tracker.getInstance()._reset();
      const handle = jest.spyOn(watcher, 'handleFile');
      const debounced = jest.spyOn(watcher, '_debouncedHandleFile').mockImplementation(() => {});
      jest.advanceTimersByTime(5 * 60_000);
      expect(handle).not.toHaveBeenCalled();
      expect(debounced).not.toHaveBeenCalled();

      // Turned back on: ignoreInitial means chokidar never reports the file
      // again, so the watcher hands it to the pipeline itself.
      chokidar.watch.mockReturnValue(fakeChokidar());
      jest.spyOn(watcher, '_verifyDirectory').mockResolvedValue(true);
      await watcher.start();
      expect(debounced).toHaveBeenCalledWith('/dl/held.pdf');
    });
  });
});
