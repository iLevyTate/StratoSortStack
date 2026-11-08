/**
 * Tests for embeddingQueue/parallelProcessor
 * Focus: batch success/failure handling and individual fallback behavior.
 */

jest.mock('../src/shared/logger', () => {
  const logger = {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

jest.mock('../src/shared/promiseUtils', () => ({
  withTimeout: jest.fn((p) => p),
  createBackgroundWorkTracker: jest.fn(() => ({
    track: jest.fn((p) => p),
    drain: jest.fn(),
    get size() {
      return 0;
    }
  })),
  createInitGuard: jest.fn(() => ({
    isInitialized: () => false,
    initialize: jest.fn(async (fn) => fn()),
    reset: jest.fn(),
    requireInitialized: jest.fn()
  }))
}));

jest.mock('../src/shared/performanceConstants', () => ({
  TIMEOUTS: {
    EMBEDDING_REQUEST: 1000,
    BATCH_EMBEDDING_MAX: 1000
  }
}));

const { processItemsInParallel } = require('../src/main/analysis/embeddingQueue/parallelProcessor');

describe('embeddingQueue parallelProcessor', () => {
  test('uses batchUpsertFiles when available and reports progress once', async () => {
    const vectorDbService = {
      batchUpsertFiles: jest.fn().mockResolvedValue({ success: true })
    };
    const onProgress = jest.fn();
    const onItemFailed = jest.fn();
    const failedItemIds = new Set();

    const items = [
      { id: 'file:a', vector: [1, 2, 3], meta: { path: 'a' } },
      { id: 'file:b', vector: [1, 2, 3], meta: { path: 'b' } }
    ];

    const processed = await processItemsInParallel({
      items,
      type: 'file',
      vectorDbService,
      failedItemIds,
      startProcessedCount: 0,
      totalBatchSize: 2,
      concurrency: 2,
      onProgress,
      onItemFailed
    });

    expect(vectorDbService.batchUpsertFiles).toHaveBeenCalledWith(items);
    expect(processed).toBe(2);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: 'processing',
        completed: 2,
        total: 2,
        percent: 100,
        itemType: 'file'
      })
    );
    expect(onItemFailed).not.toHaveBeenCalled();
    expect(Array.from(failedItemIds)).toEqual([]);
  });

  test('treats batchUpsertFiles dimension_mismatch as fatal and marks all items failed', async () => {
    const vectorDbService = {
      batchUpsertFiles: jest
        .fn()
        .mockResolvedValue({ success: false, error: 'dimension_mismatch' }),
      upsertFile: jest.fn().mockResolvedValue({ success: true })
    };
    const onProgress = jest.fn();
    const onItemFailed = jest.fn();
    const failedItemIds = new Set();

    const items = [
      { id: 'file:a', vector: [1, 2, 3], meta: { path: 'a' } },
      { id: 'file:b', vector: [1, 2, 3], meta: { path: 'b' } }
    ];

    const processed = await processItemsInParallel({
      items,
      type: 'file',
      vectorDbService,
      failedItemIds,
      startProcessedCount: 0,
      totalBatchSize: 2,
      concurrency: 2,
      onProgress,
      onItemFailed
    });

    expect(vectorDbService.batchUpsertFiles).toHaveBeenCalled();
    // dimension_mismatch is fatal - no individual fallback (entire schema is wrong)
    expect(vectorDbService.upsertFile).not.toHaveBeenCalled();
    expect(processed).toBe(0);
    expect(onItemFailed).toHaveBeenCalledTimes(2);
    expect(failedItemIds.has('file:a')).toBe(true);
    expect(failedItemIds.has('file:b')).toBe(true);
  });

  test('marks failed items when individual upsert returns success:false', async () => {
    const vectorDbService = {
      upsertFile: jest.fn().mockResolvedValueOnce({ success: false, error: 'bad_vector' })
    };
    const onProgress = jest.fn();
    const onItemFailed = jest.fn();
    const failedItemIds = new Set();

    const items = [{ id: 'file:a', vector: [1, 2, 3], meta: { path: 'a' } }];

    const processed = await processItemsInParallel({
      items,
      type: 'file',
      vectorDbService,
      failedItemIds,
      startProcessedCount: 0,
      totalBatchSize: 1,
      concurrency: 1,
      onProgress,
      onItemFailed
    });

    expect(processed).toBe(0);
    expect(failedItemIds.has('file:a')).toBe(true);
    expect(onItemFailed).toHaveBeenCalledWith(items[0], expect.stringContaining('bad_vector'));
  });

  test('marks failed items when individual upsert requires rebuild', async () => {
    const vectorDbService = {
      upsertFile: jest.fn().mockResolvedValueOnce({ success: false, requiresRebuild: true })
    };
    const onProgress = jest.fn();
    const onItemFailed = jest.fn();
    const failedItemIds = new Set();

    const items = [{ id: 'file:a', vector: [1, 2, 3], meta: { path: 'a' } }];

    const processed = await processItemsInParallel({
      items,
      type: 'file',
      vectorDbService,
      failedItemIds,
      startProcessedCount: 0,
      totalBatchSize: 1,
      concurrency: 1,
      onProgress,
      onItemFailed
    });

    expect(processed).toBe(0);
    expect(failedItemIds.has('file:a')).toBe(true);
    expect(onItemFailed).toHaveBeenCalledWith(
      items[0],
      expect.stringContaining('dimension_mismatch')
    );
  });

  test('formats folder payloads for batchUpsertFolders', async () => {
    const vectorDbService = {
      batchUpsertFolders: jest.fn().mockResolvedValue({ success: true })
    };
    const onProgress = jest.fn();
    const onItemFailed = jest.fn();
    const failedItemIds = new Set();

    const items = [
      {
        id: 'folder:one',
        vector: [1],
        meta: { name: 'One', path: 'C:\\One' },
        model: 'm',
        updatedAt: 't'
      }
    ];

    const processed = await processItemsInParallel({
      items,
      type: 'folder',
      vectorDbService,
      failedItemIds,
      startProcessedCount: 0,
      totalBatchSize: 1,
      concurrency: 1,
      onProgress,
      onItemFailed
    });

    expect(vectorDbService.batchUpsertFolders).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'folder:one',
        vector: [1],
        name: 'One',
        path: 'C:\\One',
        model: 'm',
        updatedAt: 't'
      })
    ]);
    expect(processed).toBe(1);
    expect(onItemFailed).not.toHaveBeenCalled();
  });

  describe('vector store refusing writes (shutdown / writes blocked)', () => {
    const SHUTDOWN_FILE_BATCH = { queued: false, count: 0, skipped: true, reason: 'shutdown' };

    function run(type, vectorDbService, items) {
      const onProgress = jest.fn();
      const onItemFailed = jest.fn();
      const failedItemIds = new Set();
      const promise = processItemsInParallel({
        items,
        type,
        vectorDbService,
        failedItemIds,
        startProcessedCount: 0,
        totalBatchSize: items.length,
        concurrency: 2,
        onProgress,
        onItemFailed
      });
      return { promise, onProgress, onItemFailed, failedItemIds };
    }

    test('a refused file batch rejects so the batch stays queued instead of counting as embedded', async () => {
      const vectorDbService = {
        batchUpsertFiles: jest.fn().mockResolvedValue(SHUTDOWN_FILE_BATCH),
        upsertFile: jest.fn(async (file) => ({
          queued: false,
          fileId: file.id,
          skipped: true,
          reason: 'shutdown'
        }))
      };
      const items = [{ id: 'file:a', vector: [1], meta: { path: 'a' } }];
      const { promise, onProgress, onItemFailed, failedItemIds } = run(
        'file',
        vectorDbService,
        items
      );

      await expect(promise).rejects.toMatchObject({ code: 'VECTOR_WRITES_BLOCKED' });
      expect(onProgress).not.toHaveBeenCalled();
      // Transient refusal, not a per-item failure: it must not count toward dead-lettering.
      expect(onItemFailed).not.toHaveBeenCalled();
      expect(failedItemIds.size).toBe(0);
      // No point retrying each item individually against a store that refuses writes.
      expect(vectorDbService.upsertFile).not.toHaveBeenCalled();
    });

    test('a refused single-file upsert rejects instead of counting as embedded', async () => {
      const vectorDbService = {
        upsertFile: jest.fn(async (file) => ({
          queued: false,
          fileId: file.id,
          skipped: true,
          reason: 'shutdown'
        }))
      };
      const items = [
        { id: 'file:a', vector: [1], meta: { path: 'a' } },
        { id: 'file:b', vector: [1], meta: { path: 'b' } }
      ];
      const { promise, onProgress, onItemFailed, failedItemIds } = run(
        'file',
        vectorDbService,
        items
      );

      await expect(promise).rejects.toMatchObject({ code: 'VECTOR_WRITES_BLOCKED' });
      expect(onProgress).not.toHaveBeenCalled();
      expect(onItemFailed).not.toHaveBeenCalled();
      expect(failedItemIds.size).toBe(0);
    });

    test('a refused folder batch rejects instead of counting as embedded', async () => {
      const vectorDbService = {
        batchUpsertFolders: jest
          .fn()
          .mockResolvedValue({ queued: false, count: 0, skipped: [], reason: 'shutdown' })
      };
      const items = [{ id: 'folder:one', vector: [1], meta: { name: 'One', path: 'C:\\One' } }];
      const { promise, onProgress, onItemFailed } = run('folder', vectorDbService, items);

      await expect(promise).rejects.toMatchObject({ code: 'VECTOR_WRITES_BLOCKED' });
      expect(onProgress).not.toHaveBeenCalled();
      expect(onItemFailed).not.toHaveBeenCalled();
    });

    test('a refused single-folder upsert rejects instead of counting as embedded', async () => {
      const vectorDbService = {
        upsertFolder: jest.fn(async (folder) => ({
          queued: false,
          folderId: folder.id,
          skipped: true,
          reason: 'shutdown'
        }))
      };
      const items = [{ id: 'folder:one', vector: [1], meta: { name: 'One', path: 'C:\\One' } }];
      const { promise, onItemFailed } = run('folder', vectorDbService, items);

      await expect(promise).rejects.toMatchObject({ code: 'VECTOR_WRITES_BLOCKED' });
      expect(onItemFailed).not.toHaveBeenCalled();
    });
  });
});
