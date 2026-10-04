/**
 * @jest-environment node
 *
 * Regression: the handler fired one pLimit()/Semaphore.acquire() per
 * operation up-front. The shared Semaphore defaults to maxQueueSize=100 and
 * a 60s queue timeout, so any batch over ~105 operations instantly rejected
 * ops 106+ with QUEUE_FULL — which the unexpected-rejection safety net then
 * escalated into a FULL BATCH ROLLBACK. The unit suite never saw it because
 * it mocks promiseUtils with an unbounded fake Semaphore; this suite uses
 * the REAL Semaphore.
 */

const { handleBatchOrganize } = require('../src/main/ipc/files/batchOrganizeHandler');

jest.mock('fs', () => ({
  promises: {
    access: jest.fn(),
    rename: jest.fn().mockResolvedValue(),
    mkdir: jest.fn().mockResolvedValue(),
    unlink: jest.fn().mockResolvedValue(),
    stat: jest.fn().mockResolvedValue({ size: 100 })
  }
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

jest.mock('../src/main/ipc/files/embeddingSync', () => ({
  syncEmbeddingForMove: jest.fn(),
  removeEmbeddingsForPathBestEffort: jest.fn()
}));

jest.mock('../src/main/utils/fileDedup', () => ({
  computeFileChecksum: jest.fn().mockResolvedValue('checksum123'),
  handleDuplicateMove: jest.fn().mockResolvedValue(null)
}));

jest.mock('../src/shared/atomicFileOperations', () => ({
  crossDeviceMove: jest.fn(),
  // Delegate to the suite's fs.rename mock (see batchOrganizeHandler.test.js).
  renameNoReplace: jest.fn((src, dest) => require('fs').promises.rename(src, dest))
}));

jest.mock('../src/shared/pathSanitization', () => ({
  validateFileOperationPath: jest.fn((p) => ({ valid: true, normalizedPath: p }))
}));

jest.mock('../src/shared/correlationId', () => ({
  withCorrelationId: jest.fn((fn) => fn())
}));

jest.mock('../src/main/ipc/semantic', () => ({
  getSearchServiceInstance: jest.fn(() => ({
    invalidateAndRebuild: jest.fn().mockResolvedValue()
  }))
}));

// NOTE: no jest.mock of ../src/shared/promiseUtils — the real Semaphore is
// the subject under test.

describe('Batch Organize Handler — large batches (real Semaphore)', () => {
  test('processes 150 operations without QUEUE_FULL rollback', async () => {
    const fs = require('fs').promises;
    fs.access.mockImplementation(async (p) => {
      if (p.includes('dest')) return;
      if (p.includes('src')) throw { code: 'ENOENT' };
    });

    const operations = Array.from({ length: 150 }, (_, i) => ({
      source: `/src/doc${i}.pdf`,
      destination: `/dest/doc${i}.pdf`,
      type: 'move'
    }));

    const params = {
      operation: { operations },
      logger: require('../src/shared/logger').logger,
      getServiceIntegration: jest.fn(() => ({
        processingState: {
          createOrLoadOrganizeBatch: jest.fn((id, ops) => ({ operations: ops })),
          markOrganizeOpStarted: jest.fn(),
          markOrganizeOpDone: jest.fn(),
          markOrganizeOpError: jest.fn(),
          completeOrganizeBatch: jest.fn()
        },
        undoRedo: { recordAction: jest.fn() }
      })),
      getMainWindow: jest.fn()
    };

    const result = await handleBatchOrganize(params);

    expect(result.rolledBack).toBeFalsy();
    expect(result.success).toBe(true);
    expect(result.successCount).toBe(150);
    expect(fs.rename).toHaveBeenCalledTimes(150);
  }, 30000);
});
