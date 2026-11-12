/**
 * A search-index save that keeps failing for a reason other than a full disk
 * (a locked file, an I/O error) tells the user.
 *
 * Only disk-full raised a banner. Any other failure was logged, retries
 * stopped after five tries, and the user never learned that recent index
 * changes were not on disk.
 */

const path = require('path');
const fsp = require('fs').promises;

jest.mock('electron', () => ({ app: { getPath: jest.fn() } }));
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

const { app } = require('electron');
const tracker = require('../src/main/services/DegradedStateTracker');
const { OramaVectorService } = require('../src/main/services/OramaVectorService');

const SAVE_FAILED_CODE = 'orama.save-failed';
const MAX_RETRIES = 5;
const TEMP_DIR = path.join(__dirname, 'temp-orama-save-failed');

describe('OramaVectorService when saving keeps failing', () => {
  /** @type {any} */
  let service;
  /** @type {any} */
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

  function failWrites(code) {
    writeSpy?.mockRestore();
    writeSpy = jest
      .spyOn(fsp, 'writeFile')
      .mockRejectedValue(Object.assign(new Error(`${code}: write failed`), { code }));
  }

  function writesWork() {
    writeSpy?.mockRestore();
    writeSpy = null;
  }

  async function persistOnce() {
    service._persistPending = true;
    return service._doPersist();
  }

  const saveFailedFlag = () =>
    tracker
      .getInstance()
      .list()
      .find((flag) => flag.code === SAVE_FAILED_CODE);

  test('failures short of the retry limit show nothing', async () => {
    failWrites('EBUSY');
    for (let i = 0; i < MAX_RETRIES - 1; i++) await persistOnce();
    expect(tracker.getInstance().list()).toEqual([]);
  });

  test('when retries give up, the banner says the index was not saved', async () => {
    failWrites('EBUSY');
    for (let i = 0; i < MAX_RETRIES; i++) await persistOnce();

    const flag = saveFailedFlag();
    expect(flag).toMatchObject({ severity: 'error', dismissed: false });
    expect(flag.message).toMatch(/could not save its search index/i);
    expect(flag.message).toMatch(/may be lost/i);
    expect(flag.detail).toMatchObject({ errno: 'EBUSY' });
    // Not a full disk: no storage-full banner, no once-a-minute retry.
    expect(tracker.isStorageFull()).toBe(false);
    expect(service._storageFullRetryTimer).toBeFalsy();
  });

  test('the next save that works clears it', async () => {
    failWrites('EPERM');
    for (let i = 0; i < MAX_RETRIES; i++) await persistOnce();
    expect(saveFailedFlag()).toBeTruthy();

    writesWork();
    expect(await persistOnce()).toMatchObject({ success: true });
    expect(saveFailedFlag()).toBeUndefined();
  });

  // Retries stop at the limit, so the flag would never clear if a later
  // write did not start saving again.
  test('a later write starts saving again, with a fresh round of retries', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      failWrites('EBUSY');
      for (let i = 0; i < MAX_RETRIES; i++) await persistOnce();
      expect(saveFailedFlag()).toBeTruthy();
      expect(service._persistRetryCount).toBe(0);

      writesWork();
      const persisted = jest.spyOn(service, '_doPersist');
      service._schedulePersist();
      jest.advanceTimersByTime(service._persistGapMs());
      expect(persisted).toHaveBeenCalledTimes(1);
      await service._currentPersistPromise;
      expect(saveFailedFlag()).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a full disk raises the storage-full banner instead, as before', async () => {
    failWrites('ENOSPC');
    for (let i = 0; i < MAX_RETRIES; i++) await persistOnce();

    expect(tracker.isStorageFull()).toBe(true);
    expect(saveFailedFlag()).toBeUndefined();
    expect(service._storageFullRetryTimer).toBeTruthy();
  });

  // Disk full, then space freed but the file is locked: the storage-full
  // banner and its retry already cover it, so no second banner goes up.
  test('a lock while the storage-full banner is up does not add a second banner', async () => {
    failWrites('ENOSPC');
    await persistOnce();
    failWrites('EBUSY');
    for (let i = 1; i < MAX_RETRIES; i++) await persistOnce();

    expect(tracker.isStorageFull()).toBe(true);
    expect(saveFailedFlag()).toBeUndefined();
  });
});
