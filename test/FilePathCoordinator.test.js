/**
 * Tests for FilePathCoordinator
 * Focus: atomicPathUpdate orchestration and error tolerance across systems.
 */

const mockFilePathCoordinatorLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  setContext: jest.fn()
};

jest.mock('../src/shared/logger', () => ({
  logger: mockFilePathCoordinatorLogger,
  createLogger: () => mockFilePathCoordinatorLogger
}));

jest.mock('../src/shared/pathSanitization', () => ({
  normalizePathForIndex: (p) => String(p).replace(/\\/g, '/')
}));

jest.mock('../src/main/utils/fileIdUtils', () => {
  const path = require('path');
  const normalize = (p) => String(p).replace(/\\/g, '/');
  const getPathVariants = jest.fn((p) => [p, String(p).toLowerCase()]);
  return {
    getPathVariants,
    getAllIdVariants: jest.fn((filePath) => {
      return [...new Set(getPathVariants(filePath).flatMap((v) => [`file:${v}`, `image:${v}`]))];
    }),
    getFileEmbeddingId: jest.fn((filePath, type = 'file') => {
      const prefix = type === 'image' ? 'image:' : type === 'chunk' ? 'chunk:' : 'file:';
      return `${prefix}${normalize(filePath)}`;
    }),
    // Mirrors the real contract, including options.newMeta merged over path/name.
    buildPathUpdatePairs: jest.fn((oldPath, newPath, options = {}) => {
      const normalizedNew = normalize(newPath);
      const newMeta = { path: newPath, name: path.basename(newPath), ...(options.newMeta || {}) };
      const updates = [];
      const seen = new Set();
      for (const variant of getPathVariants(oldPath)) {
        for (const type of ['file', 'image']) {
          const oldId = `${type}:${variant}`;
          const newId = `${type}:${normalizedNew}`;
          const key = `${oldId}->${newId}`;
          if (oldId !== newId && !seen.has(key)) {
            updates.push({ oldId, newId, newMeta });
            seen.add(key);
          }
        }
      }
      return updates;
    })
  };
});

jest.mock('../src/shared/pathTraceLogger', () => ({
  traceCoordinatorStart: jest.fn(),
  traceCoordinatorComplete: jest.fn(),
  traceDbUpdate: jest.fn()
}));

const { FilePathCoordinator } = require('../src/main/services/FilePathCoordinator');

describe('FilePathCoordinator', () => {
  test('atomicPathUpdate updates all systems and emits path-changed', async () => {
    const vectorDbService = {
      updateFilePaths: jest.fn().mockResolvedValue(2),
      deleteFileChunks: jest.fn().mockResolvedValue(undefined)
    };
    const analysisHistoryService = {
      updateEntryPaths: jest.fn().mockResolvedValue(undefined)
    };
    const embeddingQueue = {
      updateByFilePath: jest.fn()
    };
    const processingStateService = {
      moveJob: jest.fn().mockResolvedValue(undefined)
    };
    const cacheInvalidationBus = {
      invalidateForPathChange: jest.fn()
    };
    const relationshipIndexService = {
      invalidateIndex: jest.fn()
    };

    const coordinator = new FilePathCoordinator({
      vectorDbService,
      analysisHistoryService,
      embeddingQueue,
      processingStateService,
      cacheInvalidationBus,
      relationshipIndexService
    });

    const onChanged = jest.fn();
    coordinator.on('path-changed', onChanged);

    const res = await coordinator.atomicPathUpdate('C:\\Old\\A.pdf', 'C:\\New\\A-renamed.pdf', {
      type: 'move'
    });

    expect(res.success).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.updated).toEqual(
      expect.objectContaining({
        vectorDb: true,
        analysisHistory: true,
        embeddingQueue: true,
        processingState: true,
        cacheInvalidated: true
      })
    );

    expect(vectorDbService.updateFilePaths).toHaveBeenCalled();
    // includes both file: and image: id updates for variants
    expect(vectorDbService.updateFilePaths.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          oldId: expect.stringMatching(/^file:/),
          newId: 'file:C:/New/A-renamed.pdf'
        }),
        expect.objectContaining({
          oldId: expect.stringMatching(/^image:/),
          newId: 'image:C:/New/A-renamed.pdf'
        })
      ])
    );

    expect(analysisHistoryService.updateEntryPaths).toHaveBeenCalledWith([
      { oldPath: 'C:\\Old\\A.pdf', newPath: 'C:\\New\\A-renamed.pdf', newName: 'A-renamed.pdf' }
    ]);
    expect(embeddingQueue.updateByFilePath).toHaveBeenCalledWith(
      'C:\\Old\\A.pdf',
      'C:\\New\\A-renamed.pdf'
    );
    expect(processingStateService.moveJob).toHaveBeenCalledWith(
      'C:\\Old\\A.pdf',
      'C:\\New\\A-renamed.pdf'
    );
    expect(cacheInvalidationBus.invalidateForPathChange).toHaveBeenCalledWith(
      'C:\\Old\\A.pdf',
      'C:\\New\\A-renamed.pdf',
      'move'
    );
    expect(vectorDbService.deleteFileChunks).toHaveBeenCalled();
    expect(relationshipIndexService.invalidateIndex).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'move',
        oldPath: 'C:\\Old\\A.pdf',
        newPath: 'C:\\New\\A-renamed.pdf',
        updated: expect.any(Object),
        errors: []
      })
    );

    expect(coordinator._pendingOperations.size).toBe(0);
  });

  test('_updateVectorDbPath calls deleteFileChunks for each id variant after updateFilePaths', async () => {
    const vectorDbService = {
      updateFilePaths: jest.fn().mockResolvedValue(2),
      deleteFileChunks: jest.fn().mockResolvedValue(undefined)
    };
    const coordinator = new FilePathCoordinator({
      vectorDbService,
      analysisHistoryService: { updateEntryPaths: jest.fn() },
      embeddingQueue: { updateByFilePath: jest.fn() }
    });

    await coordinator._updateVectorDbPath('C:\\Old\\doc.pdf', 'C:\\New\\doc.pdf');

    expect(vectorDbService.updateFilePaths).toHaveBeenCalled();
    expect(vectorDbService.deleteFileChunks.mock.calls.length).toBeGreaterThan(0);
    const { getAllIdVariants } = require('../src/main/utils/fileIdUtils');
    const expectedIds = getAllIdVariants('C:\\Old\\doc.pdf');
    expect(vectorDbService.deleteFileChunks.mock.calls.map((c) => c[0]).sort()).toEqual(
      [...expectedIds].sort()
    );
  });

  test('batchPathUpdate invokes deleteFileChunks for each old path in batch', async () => {
    const vectorDbService = {
      updateFilePaths: jest.fn().mockResolvedValue(undefined),
      deleteFileChunks: jest.fn().mockResolvedValue(undefined)
    };
    const analysisHistoryService = { updateEntryPaths: jest.fn().mockResolvedValue(undefined) };
    const embeddingQueue = { updateByFilePaths: jest.fn() };

    const coordinator = new FilePathCoordinator({
      vectorDbService,
      analysisHistoryService,
      embeddingQueue,
      batchSize: 50
    });

    const changes = [
      { oldPath: 'C:\\a\\1.pdf', newPath: 'C:\\b\\1.pdf' },
      { oldPath: 'C:\\a\\2.pdf', newPath: 'C:\\b\\2.pdf' },
      { oldPath: 'C:\\a\\3.pdf', newPath: 'C:\\b\\3.pdf' }
    ];
    await coordinator.batchPathUpdate(changes, { type: 'move' });

    const { getAllIdVariants } = require('../src/main/utils/fileIdUtils');
    const expected = changes.flatMap((c) => getAllIdVariants(c.oldPath)).sort();
    const actual = vectorDbService.deleteFileChunks.mock.calls.map((c) => c[0]).sort();
    expect(actual).toEqual(expected);
  });

  // F-199 (CP-13 / K-11): a path update used to DELETE the file's chunk vectors
  // and never rebuild them, so organizing a file removed its deep-recall
  // search. Chunks are re-keyed to the new id (clone → delete old) instead.
  describe('chunk vectors follow the file on a path update [F-199]', () => {
    function makeVectorDb() {
      const calls = [];
      return {
        calls,
        updateFilePaths: jest.fn().mockResolvedValue(2),
        cloneFileChunks: jest.fn(async (from, to) => {
          calls.push(['clone', from, to]);
          return { success: true, count: 3 };
        }),
        deleteFileChunks: jest.fn(async (id) => {
          calls.push(['delete', id]);
        })
      };
    }

    test('_updateVectorDbPath clones chunks to the new id before deleting the old ones', async () => {
      const vectorDbService = makeVectorDb();
      const coordinator = new FilePathCoordinator({
        vectorDbService,
        analysisHistoryService: { updateEntryPaths: jest.fn() },
        embeddingQueue: { updateByFilePath: jest.fn() }
      });
      const { buildPathUpdatePairs, getAllIdVariants } = require('../src/main/utils/fileIdUtils');
      const pairs = buildPathUpdatePairs('C:\\Old\\doc.pdf', 'C:\\New\\doc.pdf');

      await coordinator._updateVectorDbPath('C:\\Old\\doc.pdf', 'C:\\New\\doc.pdf');

      for (const pair of pairs) {
        expect(vectorDbService.cloneFileChunks).toHaveBeenCalledWith(pair.oldId, pair.newId);
      }
      const firstDelete = vectorDbService.calls.findIndex((c) => c[0] === 'delete');
      const lastClone = vectorDbService.calls.map((c) => c[0]).lastIndexOf('clone');
      expect(lastClone).toBeLessThan(firstDelete);
      expect(vectorDbService.deleteFileChunks.mock.calls.map((c) => c[0]).sort()).toEqual(
        [...getAllIdVariants('C:\\Old\\doc.pdf')].sort()
      );
    });

    test('batchPathUpdate re-keys chunks for every change', async () => {
      const vectorDbService = makeVectorDb();
      const coordinator = new FilePathCoordinator({
        vectorDbService,
        analysisHistoryService: { updateEntryPaths: jest.fn().mockResolvedValue(undefined) },
        embeddingQueue: { updateByFilePaths: jest.fn() },
        batchSize: 50
      });
      const changes = [
        { oldPath: 'C:\\a\\1.pdf', newPath: 'C:\\b\\1.pdf' },
        { oldPath: 'C:\\a\\2.pdf', newPath: 'C:\\b\\2.pdf' }
      ];
      await coordinator.batchPathUpdate(changes, { type: 'move' });

      const { buildPathUpdatePairs } = require('../src/main/utils/fileIdUtils');
      const expectedPairs = changes.flatMap((c) => buildPathUpdatePairs(c.oldPath, c.newPath));
      expect(vectorDbService.cloneFileChunks).toHaveBeenCalledTimes(expectedPairs.length);
      for (const pair of expectedPairs) {
        expect(vectorDbService.cloneFileChunks).toHaveBeenCalledWith(pair.oldId, pair.newId);
      }
    });

    // K-11: history learned the destination folder on organize; the vector row
    // kept the old one, so the Atlas coloured an organized file by the folder
    // it had just left.
    test('batchPathUpdate carries the destination folder into the vector rows', async () => {
      const vectorDbService = makeVectorDb();
      const coordinator = new FilePathCoordinator({
        vectorDbService,
        analysisHistoryService: { updateEntryPaths: jest.fn().mockResolvedValue(undefined) },
        embeddingQueue: { updateByFilePaths: jest.fn() },
        batchSize: 50
      });

      await coordinator.batchPathUpdate(
        [
          {
            oldPath: 'C:\\Inbox\\lease.pdf',
            newPath: 'C:\\Housing\\lease.pdf',
            newCategory: 'Housing',
            newSmartFolder: 'Housing',
            newSmartFolderPath: 'C:\\Housing'
          },
          // A plain rename carries no folder context and must not invent one.
          { oldPath: 'C:\\Housing\\a.pdf', newPath: 'C:\\Housing\\b.pdf' }
        ],
        { type: 'move' }
      );

      const updates = vectorDbService.updateFilePaths.mock.calls.flatMap((c) => c[0]);
      const moved = updates.filter((u) => u.newMeta.path === 'C:\\Housing\\lease.pdf');
      const renamed = updates.filter((u) => u.newMeta.path === 'C:\\Housing\\b.pdf');
      expect(moved.length).toBeGreaterThan(0);
      for (const u of moved) {
        expect(u.newMeta).toEqual(
          expect.objectContaining({
            category: 'Housing',
            smartFolder: 'Housing',
            smartFolderPath: 'C:\\Housing'
          })
        );
      }
      expect(renamed.length).toBeGreaterThan(0);
      for (const u of renamed) {
        expect(u.newMeta).not.toHaveProperty('category');
        expect(u.newMeta).not.toHaveProperty('smartFolder');
      }
    });

    test('a clone failure never blocks the path update or the cleanup', async () => {
      const vectorDbService = makeVectorDb();
      vectorDbService.cloneFileChunks = jest.fn().mockRejectedValue(new Error('chunk db busy'));
      const coordinator = new FilePathCoordinator({
        vectorDbService,
        analysisHistoryService: { updateEntryPaths: jest.fn() },
        embeddingQueue: { updateByFilePath: jest.fn() }
      });
      await expect(
        coordinator._updateVectorDbPath('C:\\Old\\doc.pdf', 'C:\\New\\doc.pdf')
      ).resolves.toBeUndefined();
      expect(vectorDbService.updateFilePaths).toHaveBeenCalled();
      // Old chunks are kept when the clone failed (nothing to replace them yet).
      expect(vectorDbService.deleteFileChunks).not.toHaveBeenCalled();
    });
  });

  test('batchPathUpdate does not throw when vectorDb is unavailable', async () => {
    const coordinator = new FilePathCoordinator({
      vectorDbService: null,
      analysisHistoryService: { updateEntryPaths: jest.fn().mockResolvedValue(undefined) },
      embeddingQueue: { updateByFilePaths: jest.fn() }
    });

    await expect(
      coordinator.batchPathUpdate([{ oldPath: 'C:\\o.pdf', newPath: 'C:\\n.pdf' }])
    ).resolves.toEqual(
      expect.objectContaining({
        success: expect.any(Boolean),
        errors: expect.any(Array)
      })
    );
  });

  test('batchPathUpdate rolls back vectorDb when analysis history batch fails', async () => {
    const vectorDbService = {
      updateFilePaths: jest.fn().mockResolvedValue(2),
      deleteFileChunks: jest.fn().mockResolvedValue(undefined)
    };
    const analysisHistoryService = {
      updateEntryPaths: jest
        .fn()
        .mockRejectedValueOnce(new Error('history batch failed'))
        .mockResolvedValue(undefined)
    };
    const embeddingQueue = {
      updateByFilePaths: jest.fn()
    };
    const processingStateService = {
      moveJob: jest.fn().mockResolvedValue(undefined)
    };
    const cacheInvalidationBus = {
      invalidateBatch: jest.fn()
    };

    const coordinator = new FilePathCoordinator({
      vectorDbService,
      analysisHistoryService,
      embeddingQueue,
      processingStateService,
      cacheInvalidationBus,
      batchSize: 50
    });

    const changes = [{ oldPath: 'C:\\Old\\a.pdf', newPath: 'C:\\New\\a.pdf' }];
    const res = await coordinator.batchPathUpdate(changes, { type: 'move' });

    expect(res.success).toBe(false);
    expect(vectorDbService.updateFilePaths).toHaveBeenCalledTimes(2);
    expect(analysisHistoryService.updateEntryPaths).toHaveBeenCalledTimes(1);
  });

  test('batchPathUpdate rolls back vectorDb and analysisHistory when embedding queue batch fails', async () => {
    const vectorDbService = {
      updateFilePaths: jest.fn().mockResolvedValue(undefined),
      deleteFileChunks: jest.fn().mockResolvedValue(undefined)
    };
    const analysisHistoryService = {
      updateEntryPaths: jest.fn().mockResolvedValue(undefined)
    };
    const embeddingQueue = {
      updateByFilePaths: jest
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('queue failed');
        })
        .mockImplementation(() => undefined)
    };

    const coordinator = new FilePathCoordinator({
      vectorDbService,
      analysisHistoryService,
      embeddingQueue,
      batchSize: 50
    });

    const changes = [{ oldPath: 'C:\\Old\\x.pdf', newPath: 'C:\\New\\x.pdf' }];
    const res = await coordinator.batchPathUpdate(changes, { type: 'move' });

    expect(res.success).toBe(false);
    expect(vectorDbService.updateFilePaths).toHaveBeenCalledTimes(2);
    expect(analysisHistoryService.updateEntryPaths).toHaveBeenCalledTimes(2);
  });

  test('batchPathUpdate does not call rollback when all systems succeed', async () => {
    const vectorDbService = {
      updateFilePaths: jest.fn().mockResolvedValue(undefined),
      deleteFileChunks: jest.fn().mockResolvedValue(undefined)
    };
    const analysisHistoryService = {
      updateEntryPaths: jest.fn().mockResolvedValue(undefined)
    };
    const embeddingQueue = {
      updateByFilePaths: jest.fn()
    };

    const coordinator = new FilePathCoordinator({
      vectorDbService,
      analysisHistoryService,
      embeddingQueue,
      batchSize: 50
    });

    await coordinator.batchPathUpdate([{ oldPath: 'C:\\Old\\x.pdf', newPath: 'C:\\New\\x.pdf' }], {
      type: 'move'
    });

    expect(vectorDbService.updateFilePaths).toHaveBeenCalledTimes(1);
    expect(analysisHistoryService.updateEntryPaths).toHaveBeenCalledTimes(1);
    expect(embeddingQueue.updateByFilePaths).toHaveBeenCalledTimes(1);
  });

  test('batchPathUpdate logs IRRECOVERABLE when vectorDb rollback throws', async () => {
    mockFilePathCoordinatorLogger.error.mockClear();
    const vectorDbService = {
      updateFilePaths: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('disk full')),
      deleteFileChunks: jest.fn().mockResolvedValue(undefined)
    };
    const analysisHistoryService = {
      updateEntryPaths: jest.fn().mockRejectedValueOnce(new Error('history failed'))
    };

    const coordinator = new FilePathCoordinator({
      vectorDbService,
      analysisHistoryService,
      embeddingQueue: { updateByFilePaths: jest.fn() },
      batchSize: 50
    });

    await coordinator.batchPathUpdate([{ oldPath: 'C:\\Old\\x.pdf', newPath: 'C:\\New\\x.pdf' }], {
      type: 'move'
    });

    expect(mockFilePathCoordinatorLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('IRRECOVERABLE'),
      expect.objectContaining({ error: 'disk full' })
    );
  });

  test('batchPathUpdate retries invalidateBatch then falls back to invalidateAll without raising divergence', async () => {
    const tracker = require('../src/main/services/DegradedStateTracker').getInstance();
    const raiseSpy = jest.spyOn(tracker, 'raise').mockImplementation(() => {});
    try {
      const vectorDbService = {
        updateFilePaths: jest.fn().mockResolvedValue(undefined),
        deleteFileChunks: jest.fn().mockResolvedValue(undefined)
      };
      const analysisHistoryService = {
        updateEntryPaths: jest.fn().mockResolvedValue(undefined)
      };
      const cacheInvalidationBus = {
        invalidateBatch: jest.fn(() => {
          throw new Error('bus exploded');
        }),
        invalidateAll: jest.fn()
      };

      const coordinator = new FilePathCoordinator({
        vectorDbService,
        analysisHistoryService,
        embeddingQueue: { updateByFilePaths: jest.fn() },
        cacheInvalidationBus,
        batchSize: 50
      });

      const res = await coordinator.batchPathUpdate(
        [{ oldPath: 'C:\\Old\\x.pdf', newPath: 'C:\\New\\x.pdf' }],
        { type: 'move' }
      );

      // retry once (2 calls total) then broad fallback
      expect(cacheInvalidationBus.invalidateBatch).toHaveBeenCalledTimes(2);
      expect(cacheInvalidationBus.invalidateAll).toHaveBeenCalledWith('path-change-compensate');
      // fallback succeeded, so no cache-divergence degraded flag
      expect(
        raiseSpy.mock.calls.some(([arg]) => arg && arg.code === 'filepath.cache-divergence')
      ).toBe(false);
      expect(res.errors.some((e) => e.system === 'cacheInvalidation')).toBe(true);
    } finally {
      raiseSpy.mockRestore();
    }
  });

  test('batchPathUpdate raises cache-divergence when retry and invalidateAll both fail after stores were touched', async () => {
    const tracker = require('../src/main/services/DegradedStateTracker').getInstance();
    const raiseSpy = jest.spyOn(tracker, 'raise').mockImplementation(() => {});
    try {
      const vectorDbService = {
        updateFilePaths: jest.fn().mockResolvedValue(undefined),
        deleteFileChunks: jest.fn().mockResolvedValue(undefined)
      };
      const analysisHistoryService = {
        updateEntryPaths: jest.fn().mockResolvedValue(undefined)
      };
      const cacheInvalidationBus = {
        invalidateBatch: jest.fn(() => {
          throw new Error('bus exploded');
        }),
        invalidateAll: jest.fn(() => {
          throw new Error('fallback exploded');
        })
      };

      const coordinator = new FilePathCoordinator({
        vectorDbService,
        analysisHistoryService,
        embeddingQueue: { updateByFilePaths: jest.fn() },
        cacheInvalidationBus,
        batchSize: 50
      });

      await coordinator.batchPathUpdate(
        [{ oldPath: 'C:\\Old\\x.pdf', newPath: 'C:\\New\\x.pdf' }],
        { type: 'move' }
      );

      expect(cacheInvalidationBus.invalidateBatch).toHaveBeenCalledTimes(2);
      expect(
        raiseSpy.mock.calls.some(([arg]) => arg && arg.code === 'filepath.cache-divergence')
      ).toBe(true);
    } finally {
      raiseSpy.mockRestore();
    }
  });

  test('handleFileDeletion removes state across all systems', async () => {
    const vectorDbService = {
      batchDeleteFileEmbeddings: jest.fn().mockResolvedValue(undefined),
      deleteFileChunks: jest.fn().mockResolvedValue(true)
    };
    const analysisHistoryService = {
      removeEntriesByPath: jest.fn().mockResolvedValue(undefined)
    };
    const embeddingQueue = {
      removeByFilePath: jest.fn()
    };
    const processingStateService = {
      clearState: jest.fn().mockResolvedValue(undefined)
    };
    const cacheInvalidationBus = {
      invalidateForDeletion: jest.fn()
    };

    const coordinator = new FilePathCoordinator({
      vectorDbService,
      analysisHistoryService,
      embeddingQueue,
      processingStateService,
      cacheInvalidationBus
    });

    const onDeleted = jest.fn();
    coordinator.on('file-deleted', onDeleted);

    const res = await coordinator.handleFileDeletion('C:\\Old\\A.pdf');
    expect(res.success).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.cleaned).toEqual(
      expect.objectContaining({
        vectorDb: true,
        analysisHistory: true,
        embeddingQueue: true,
        processingState: true,
        cacheInvalidated: true
      })
    );

    expect(vectorDbService.batchDeleteFileEmbeddings).toHaveBeenCalled();
    expect(vectorDbService.deleteFileChunks).toHaveBeenCalled();
    expect(analysisHistoryService.removeEntriesByPath).toHaveBeenCalledWith('C:\\Old\\A.pdf');
    expect(embeddingQueue.removeByFilePath).toHaveBeenCalledWith('C:\\Old\\A.pdf');
    expect(processingStateService.clearState).toHaveBeenCalledWith('C:\\Old\\A.pdf');
    expect(cacheInvalidationBus.invalidateForDeletion).toHaveBeenCalledWith('C:\\Old\\A.pdf');
    expect(onDeleted).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'C:\\Old\\A.pdf',
        cleaned: expect.any(Object),
        errors: []
      })
    );
  });

  test('handleFileCopy clones embeddings/history and invalidates caches', async () => {
    const vectorDbService = {
      cloneFileEmbedding: jest.fn().mockResolvedValue(undefined),
      cloneFileChunks: jest.fn().mockResolvedValue(undefined)
    };
    const analysisHistoryService = {
      cloneEntryForCopy: jest.fn().mockResolvedValue(undefined)
    };
    const cacheInvalidationBus = {
      invalidateForPathChange: jest.fn()
    };

    const coordinator = new FilePathCoordinator({
      vectorDbService,
      analysisHistoryService,
      cacheInvalidationBus
    });

    const onCopied = jest.fn();
    coordinator.on('file-copied', onCopied);

    const res = await coordinator.handleFileCopy('C:\\Old\\A.pdf', 'C:\\New\\A.pdf');
    expect(res.success).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.cloned).toEqual(
      expect.objectContaining({ vectorDb: true, analysisHistory: true, cacheInvalidated: true })
    );

    expect(vectorDbService.cloneFileEmbedding).toHaveBeenCalled();
    expect(vectorDbService.cloneFileChunks).toHaveBeenCalled();
    expect(analysisHistoryService.cloneEntryForCopy).toHaveBeenCalledWith(
      'C:\\Old\\A.pdf',
      'C:\\New\\A.pdf'
    );
    expect(cacheInvalidationBus.invalidateForPathChange).toHaveBeenCalledWith(
      'C:\\Old\\A.pdf',
      'C:\\New\\A.pdf',
      'copy'
    );
    expect(onCopied).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: 'C:\\Old\\A.pdf',
        destPath: 'C:\\New\\A.pdf',
        cloned: expect.any(Object),
        errors: []
      })
    );
  });

  test('atomicPathUpdate records errors when services are unavailable', async () => {
    const analysisHistoryService = {
      updateEntryPaths: jest.fn().mockResolvedValue(undefined)
    };

    const coordinator = new FilePathCoordinator({
      vectorDbService: null,
      analysisHistoryService,
      embeddingQueue: null,
      processingStateService: null,
      cacheInvalidationBus: null
    });

    const res = await coordinator.atomicPathUpdate('C:\\Old\\A.pdf', 'C:\\New\\A.pdf', {
      type: 'move'
    });

    expect(res.success).toBe(false);
    expect(res.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ system: 'vectorDb' }),
        expect.objectContaining({ system: 'embeddingQueue' }),
        expect.objectContaining({ system: 'processingState' }),
        expect.objectContaining({ system: 'cacheInvalidation' })
      ])
    );
    expect(res.updated.analysisHistory).toBe(true);
    expect(coordinator._pendingOperations.size).toBe(0);
  });

  test('atomicPathUpdate continues when one system throws', async () => {
    const vectorDbService = {
      updateFilePaths: jest.fn().mockRejectedValue(new Error('db down'))
    };
    const analysisHistoryService = {
      updateEntryPaths: jest.fn().mockResolvedValue(undefined)
    };
    const cacheInvalidationBus = {
      invalidateForPathChange: jest.fn()
    };

    const coordinator = new FilePathCoordinator({
      vectorDbService,
      analysisHistoryService,
      embeddingQueue: { updateByFilePath: jest.fn() },
      processingStateService: { moveJob: jest.fn().mockResolvedValue(undefined) },
      cacheInvalidationBus
    });

    const res = await coordinator.atomicPathUpdate('C:\\Old\\A.pdf', 'C:\\New\\A.pdf', {
      type: 'move'
    });

    expect(res.success).toBe(false);
    expect(res.errors).toEqual([expect.objectContaining({ system: 'vectorDb', error: 'db down' })]);
    expect(res.updated.analysisHistory).toBe(true);
    expect(cacheInvalidationBus.invalidateForPathChange).toHaveBeenCalled();
    expect(coordinator._pendingOperations.size).toBe(0);
  });

  test('batchPathUpdate dedupes failedSystems and reports partialSuccess when only processingState fails across >=3 files', async () => {
    // processingState pushes one error entry per file. With 3 files failing only
    // processingState, a raw entry count (3) would wrongly trip the ">=3 failed
    // systems = total loss" heuristic even though vectorDb/analysisHistory/
    // embeddingQueue all succeeded. Distinct-system count is 1 → still partial.
    const vectorDbService = {
      updateFilePaths: jest.fn().mockResolvedValue(undefined),
      deleteFileChunks: jest.fn().mockResolvedValue(undefined)
    };
    const analysisHistoryService = {
      updateEntryPaths: jest.fn().mockResolvedValue(undefined)
    };
    const embeddingQueue = {
      updateByFilePaths: jest.fn()
    };
    const processingStateService = {
      moveJob: jest.fn().mockRejectedValue(new Error('ps down'))
    };

    const coordinator = new FilePathCoordinator({
      vectorDbService,
      analysisHistoryService,
      embeddingQueue,
      processingStateService,
      batchSize: 50
    });

    const changes = [
      { oldPath: 'C:\\Old\\a.pdf', newPath: 'C:\\New\\a.pdf' },
      { oldPath: 'C:\\Old\\b.pdf', newPath: 'C:\\New\\b.pdf' },
      { oldPath: 'C:\\Old\\c.pdf', newPath: 'C:\\New\\c.pdf' }
    ];
    const res = await coordinator.batchPathUpdate(changes, { type: 'move' });

    expect(res.results).toHaveLength(3);
    for (const result of res.results) {
      expect(result.success).toBe(false);
      // deduped: a single distinct failed system, not one entry per file
      expect(result.failedSystems).toEqual(['processingState']);
      // 1 distinct failed system (< 3) ⇒ partial, not total loss
      expect(result.partialSuccess).toBe(true);
    }
  });
  describe('atomicPathUpdate carries folder context into the vector row and the history entry', () => {
    function makeCoordinator() {
      const vectorDbService = {
        updateFilePaths: jest.fn().mockResolvedValue(1),
        deleteFileChunks: jest.fn().mockResolvedValue(undefined)
      };
      const analysisHistoryService = {
        updateEntryPaths: jest.fn().mockResolvedValue(undefined)
      };
      const coordinator = new FilePathCoordinator({
        vectorDbService,
        analysisHistoryService,
        embeddingQueue: { updateByFilePath: jest.fn() },
        processingStateService: { moveJob: jest.fn().mockResolvedValue(undefined) },
        cacheInvalidationBus: { invalidateForPathChange: jest.fn() }
      });
      return { coordinator, vectorDbService, analysisHistoryService };
    }

    test('a move into a smart folder stamps category and folder on both stores', async () => {
      const { coordinator, vectorDbService, analysisHistoryService } = makeCoordinator();

      const res = await coordinator.atomicPathUpdate(
        'C:\\Inbox\\lease.pdf',
        'C:\\Housing\\lease.pdf',
        {
          type: 'undo_redo',
          folderMeta: {
            newCategory: 'Housing',
            newSmartFolder: 'Housing',
            newSmartFolderPath: 'C:\\Housing'
          }
        }
      );

      expect(res.success).toBe(true);
      const updates = vectorDbService.updateFilePaths.mock.calls.flatMap((c) => c[0]);
      expect(updates.length).toBeGreaterThan(0);
      for (const u of updates) {
        expect(u.newMeta).toEqual(
          expect.objectContaining({
            path: 'C:\\Housing\\lease.pdf',
            category: 'Housing',
            smartFolder: 'Housing',
            smartFolderPath: 'C:\\Housing'
          })
        );
      }
      expect(analysisHistoryService.updateEntryPaths).toHaveBeenCalledWith([
        expect.objectContaining({
          oldPath: 'C:\\Inbox\\lease.pdf',
          newPath: 'C:\\Housing\\lease.pdf',
          newCategory: 'Housing',
          newSmartFolder: 'Housing',
          newSmartFolderPath: 'C:\\Housing'
        })
      ]);
    });

    test('a move back out of every smart folder clears the folder fields instead of keeping them', async () => {
      const { coordinator, vectorDbService, analysisHistoryService } = makeCoordinator();

      await coordinator.atomicPathUpdate('C:\\Housing\\lease.pdf', 'C:\\Downloads\\lease.pdf', {
        type: 'undo_redo',
        folderMeta: { clearSmartFolder: true }
      });

      const updates = vectorDbService.updateFilePaths.mock.calls.flatMap((c) => c[0]);
      expect(updates.length).toBeGreaterThan(0);
      for (const u of updates) {
        expect(u.newMeta).toEqual(
          expect.objectContaining({ smartFolder: null, smartFolderPath: null })
        );
        expect(u.newMeta).not.toHaveProperty('category');
      }
      // The history entry is stamped in the same update: it must be told the
      // file left its Smart Folder, not just where it went.
      expect(analysisHistoryService.updateEntryPaths).toHaveBeenCalledTimes(1);
      const historyUpdate = analysisHistoryService.updateEntryPaths.mock.calls[0][0][0];
      expect(historyUpdate).toEqual({
        oldPath: 'C:\\Housing\\lease.pdf',
        newPath: 'C:\\Downloads\\lease.pdf',
        newName: 'lease.pdf',
        newSmartFolder: null,
        newSmartFolderPath: null
      });
    });

    test('a batch move out of every smart folder clears the folder fields on each history entry', async () => {
      const analysisHistoryService = { updateEntryPaths: jest.fn().mockResolvedValue(undefined) };
      const coordinator = new FilePathCoordinator({
        vectorDbService: {
          updateFilePaths: jest.fn().mockResolvedValue(1),
          deleteFileChunks: jest.fn().mockResolvedValue(undefined)
        },
        analysisHistoryService,
        embeddingQueue: { updateByFilePaths: jest.fn() },
        batchSize: 50
      });

      await coordinator.batchPathUpdate(
        [
          {
            oldPath: 'C:\\Housing\\lease.pdf',
            newPath: 'C:\\Downloads\\lease.pdf',
            clearSmartFolder: true
          },
          {
            oldPath: 'C:\\Housing\\deed.pdf',
            newPath: 'C:\\Downloads\\deed.pdf',
            clearSmartFolder: true
          }
        ],
        { type: 'undo_redo' }
      );

      expect(analysisHistoryService.updateEntryPaths).toHaveBeenCalledTimes(1);
      const historyUpdates = analysisHistoryService.updateEntryPaths.mock.calls[0][0];
      expect(historyUpdates).toHaveLength(2);
      for (const u of historyUpdates) {
        expect(u).toEqual(
          expect.objectContaining({ newSmartFolder: null, newSmartFolderPath: null })
        );
        expect(u).not.toHaveProperty('newCategory');
      }
    });

    test('a plain rename with no folder context touches only path and name', async () => {
      const { coordinator, vectorDbService, analysisHistoryService } = makeCoordinator();

      await coordinator.atomicPathUpdate('C:\\Housing\\a.pdf', 'C:\\Housing\\b.pdf', {
        type: 'rename'
      });

      const updates = vectorDbService.updateFilePaths.mock.calls.flatMap((c) => c[0]);
      expect(updates.length).toBeGreaterThan(0);
      for (const u of updates) {
        expect(Object.keys(u.newMeta).sort()).toEqual(['name', 'path']);
      }
      const historyUpdate = analysisHistoryService.updateEntryPaths.mock.calls[0][0][0];
      expect(historyUpdate).not.toHaveProperty('newCategory');
      expect(historyUpdate).not.toHaveProperty('newSmartFolder');
    });
  });
});
