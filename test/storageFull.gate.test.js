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

  test('DownloadWatcher holds a new download instead of analyzing it', async () => {
    jest.useFakeTimers();
    try {
      const mod = require('../src/main/services/DownloadWatcher');
      const DownloadWatcher = mod.DownloadWatcher || mod;
      raiseFull();
      const fake = {
        _stopped: false,
        analyzeDocumentFile: jest.fn(),
        analyzeImageFile: jest.fn(),
        _loadSettingsSnapshot: jest.fn()
      };
      fake.handleFile = DownloadWatcher.prototype.handleFile;
      await fake.handleFile('/dl/report.pdf');
      expect(fake._loadSettingsSnapshot).not.toHaveBeenCalled();

      const retried = jest.spyOn(fake, 'handleFile').mockResolvedValue(undefined);
      jest.advanceTimersByTime(60_000);
      expect(retried).toHaveBeenCalledWith('/dl/report.pdf');
    } finally {
      jest.useRealTimers();
    }
  });
});
