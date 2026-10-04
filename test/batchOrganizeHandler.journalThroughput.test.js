/**
 * @jest-environment node
 *
 * Regression: every organize op awaited two journal writes
 * (markOrganizeOpStarted + markOrganizeOpDone), each of which only resolved
 * when ProcessingStateService's 500 ms debounce fired, and the writes were
 * serialized on the state mutation lock. That cost about 1.1 s per file no
 * matter the worker concurrency, so a batch over roughly 270 files hit
 * MAX_TOTAL_BATCH_TIME (300 s) and rolled every move back. The unit suites
 * never saw it because they stub `markOrganizeOpStarted` with jest.fn();
 * this suite drives the REAL ProcessingStateService (journal file and the
 * moved files both live in the suite-wide memfs) with real timers.
 */

const os = require('os');
const path = require('path');
const fs = require('fs').promises;

const mockUserDataDir = path.join(os.tmpdir(), 'stratosort-journal-throughput');

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => mockUserDataDir) }
}));

jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  };
  return { createLogger: jest.fn(() => logger), logger };
});

jest.mock('../src/main/ipc/files/batchLockManager', () => ({
  acquireBatchLock: jest.fn().mockResolvedValue(true),
  renewBatchLock: jest.fn().mockReturnValue(true),
  releaseBatchLock: jest.fn()
}));

jest.mock('../src/main/ipc/files/batchValidator', () => ({
  validateBatchOperation: jest.fn(() => null),
  MAX_BATCH_SIZE: 1000
}));

jest.mock('../src/main/ipc/files/batchRollback', () => ({
  executeRollback: jest.fn().mockResolvedValue({ success: false, rolledBack: true })
}));

jest.mock('../src/main/ipc/files/batchProgressReporter', () => ({
  sendFileOperationBatchComplete: jest.fn(),
  sendOperationProgress: jest.fn(),
  sendChunkedResults: jest.fn().mockResolvedValue({ sent: true })
}));

jest.mock('../src/shared/fileOperationTracker', () => ({
  getInstance: jest.fn(() => ({ recordOperation: jest.fn() }))
}));

const { handleBatchOrganize } = require('../src/main/ipc/files/batchOrganizeHandler');
const ProcessingStateService = require('../src/main/services/ProcessingStateService');

// 200 files: the old code needed about 1.1 s per file, so it cannot finish
// inside the test timeout; the fixed code takes a few seconds alone and well
// under the budget when the whole suite runs in parallel on a slow CI host.
const FILE_COUNT = 200;
const TIME_BUDGET_MS = 120_000;

describe('Batch organize journal throughput (real ProcessingStateService)', () => {
  let processingState;

  afterEach(async () => {
    await processingState?.destroy?.();
  });

  test(
    `moves ${FILE_COUNT} files with a durable journal in well under the batch time budget`,
    async () => {
      const srcDir = path.join(mockUserDataDir, 'src');
      const destDir = path.join(mockUserDataDir, 'dest');
      await fs.mkdir(srcDir, { recursive: true });
      await fs.mkdir(destDir, { recursive: true });
      await Promise.all(
        Array.from({ length: FILE_COUNT }, (_, i) =>
          fs.writeFile(path.join(srcDir, `doc${i}.txt`), `document ${i}\n`)
        )
      );
      processingState = new ProcessingStateService();
      await processingState.initialize();
      const flushSpy = jest.spyOn(processingState, '_flushSaveState');

      const operations = Array.from({ length: FILE_COUNT }, (_, i) => ({
        source: path.join(srcDir, `doc${i}.txt`),
        destination: path.join(destDir, `doc${i}.txt`),
        type: 'move'
      }));

      const startedAt = Date.now();
      const result = await handleBatchOrganize({
        operation: { operations },
        logger: require('../src/shared/logger').logger,
        getServiceIntegration: jest.fn(() => ({
          processingState,
          undoRedo: { recordAction: jest.fn() }
        })),
        getMainWindow: jest.fn()
      });
      const elapsedMs = Date.now() - startedAt;

      expect(result.rolledBack).toBeFalsy();
      expect(result.success).toBe(true);
      expect(result.successCount).toBe(FILE_COUNT);
      expect(elapsedMs).toBeLessThan(TIME_BUDGET_MS);

      // Each op awaits exactly one journal flush (the started mark) and the
      // done mark joins a flush already scheduled, so flushes stay at or
      // below one per op. The old code ran three serialized flushes per op.
      expect(flushSpy.mock.calls.length).toBeLessThanOrEqual(FILE_COUNT + 20);

      // Every file landed, and the journal recorded every op as done and the
      // batch as complete (the resume service must never replay this batch).
      const landed = await fs.readdir(destDir);
      expect(landed).toHaveLength(FILE_COUNT);
      const batches = Object.values(processingState.state.organize.batches);
      expect(batches).toHaveLength(1);
      expect(batches[0].completedAt).toBeTruthy();
      expect(batches[0].operations.every((op) => op.status === 'done')).toBe(true);

      // What is on disk matches memory: a crash right now loses nothing.
      const onDisk = JSON.parse(
        await fs.readFile(path.join(mockUserDataDir, 'processing-state.json'), 'utf8')
      );
      const persisted = Object.values(onDisk.organize.batches)[0];
      expect(persisted.completedAt).toBeTruthy();
      expect(persisted.operations.filter((op) => op.status === 'done')).toHaveLength(FILE_COUNT);
    },
    TIME_BUDGET_MS + 30_000
  );
});
