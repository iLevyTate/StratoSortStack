/**
 * @jest-environment node
 *
 * UndoRedoService Extended Tests
 *
 * Covers complex undo/redo chains, memory limits, batch operations,
 * mutex serialization, and edge cases not tested in the basic suite.
 */

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/test/userData')
  }
}));

jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn().mockResolvedValue(),
    rename: jest.fn().mockResolvedValue(),
    mkdir: jest.fn().mockResolvedValue(),
    unlink: jest.fn().mockResolvedValue(),
    access: jest.fn(),
    stat: jest.fn(),
    readdir: jest.fn().mockResolvedValue([]),
    rm: jest.fn().mockResolvedValue()
  }
}));

jest.mock('../src/shared/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }))
}));

jest.mock('../src/shared/performanceConstants', () => {
  const actual = jest.requireActual('../src/shared/performanceConstants');
  return {
    ...actual,
    RETRY: { ...actual.RETRY, ATOMIC_BACKOFF_STEP_MS: 10 }
  };
});

jest.mock('../src/shared/atomicFileOperations', () => ({
  crossDeviceMove: jest.fn().mockResolvedValue(),
  durableWriteJson: jest.fn().mockResolvedValue()
}));

jest.mock('../src/shared/pathSanitization', () => ({
  validateFileOperationPath: jest.fn()
}));

jest.mock('../src/main/services/ServiceContainer', () => ({
  container: {
    tryResolve: jest.fn(() => null),
    has: jest.fn(() => false),
    resolve: jest.fn(() => null)
  },
  ServiceIds: {
    ORAMA_VECTOR: 'ORAMA_VECTOR',
    FILE_PATH_COORDINATOR: 'FILE_PATH_COORDINATOR'
  }
}));

const fs = require('fs').promises;
const UndoRedoService = require('../src/main/services/UndoRedoService');
const { validateFileOperationPath } = require('../src/shared/pathSanitization');
const { durableWriteJson } = require('../src/shared/atomicFileOperations');

describe('UndoRedoService - Extended Tests', () => {
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    validateFileOperationPath.mockImplementation(async (candidate) => ({
      valid: true,
      normalizedPath: String(candidate)
    }));

    // Default: no existing actions file
    const enoent = new Error('ENOENT');
    enoent.code = 'ENOENT';
    fs.readFile.mockRejectedValue(enoent);
    fs.access.mockRejectedValue(enoent); // For cleanupOldBackups

    service = new UndoRedoService({
      maxActions: 5,
      maxMemoryMB: 1,
      maxBatchSize: 10,
      saveDebounceMs: 0
    });
  });

  describe('Save coalescing', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    test('coalesces burst recordAction writes into one scheduled save', async () => {
      jest.useFakeTimers();
      const debouncedService = new UndoRedoService({
        maxActions: 5,
        maxMemoryMB: 1,
        maxBatchSize: 10,
        saveDebounceMs: 25
      });
      debouncedService.initialized = true;
      const saveSpy = jest.spyOn(debouncedService, 'saveActions').mockResolvedValue(undefined);

      await debouncedService.recordAction('FILE_MOVE', {
        originalPath: '/a.txt',
        newPath: '/b.txt'
      });
      await debouncedService.recordAction('FILE_MOVE', {
        originalPath: '/c.txt',
        newPath: '/d.txt'
      });
      await debouncedService.recordAction('FILE_MOVE', {
        originalPath: '/e.txt',
        newPath: '/f.txt'
      });

      expect(saveSpy).toHaveBeenCalledTimes(0);

      await jest.advanceTimersByTimeAsync(30);

      expect(saveSpy).toHaveBeenCalledTimes(1);
    });

    test('undo forces immediate save and cancels pending scheduled save', async () => {
      jest.useFakeTimers();
      const debouncedService = new UndoRedoService({
        maxActions: 5,
        maxMemoryMB: 1,
        maxBatchSize: 10,
        saveDebounceMs: 50
      });
      debouncedService.initialized = true;
      debouncedService.executeReverseAction = jest.fn().mockResolvedValue(undefined);
      const saveSpy = jest.spyOn(debouncedService, 'saveActions').mockResolvedValue(undefined);

      await debouncedService.recordAction('FILE_MOVE', {
        originalPath: '/x.txt',
        newPath: '/y.txt'
      });
      expect(saveSpy).toHaveBeenCalledTimes(0);

      await debouncedService.undo();
      expect(saveSpy).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(100);
      expect(saveSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Complex undo/redo chains', () => {
    test('record, undo, redo produces consistent state', async () => {
      // Spy on safeMove to prevent actual file operations
      service.safeMove = jest.fn().mockResolvedValue();

      const id = await service.recordAction('FILE_MOVE', {
        originalPath: '/a/file.txt',
        newPath: '/b/file.txt'
      });

      expect(id).toBeDefined();
      expect(service.canUndo()).toBe(true);
      expect(service.canRedo()).toBe(false);

      const undoResult = await service.undo();
      expect(undoResult.success).toBe(true);
      expect(service.canUndo()).toBe(false);
      expect(service.canRedo()).toBe(true);

      const redoResult = await service.redo();
      expect(redoResult.success).toBe(true);
      expect(service.canUndo()).toBe(true);
      expect(service.canRedo()).toBe(false);
    });

    test('recording new action after undo discards redo stack', async () => {
      service.safeMove = jest.fn().mockResolvedValue();

      await service.recordAction('FILE_MOVE', {
        originalPath: '/a.txt',
        newPath: '/b.txt'
      });
      await service.recordAction('FILE_MOVE', {
        originalPath: '/c.txt',
        newPath: '/d.txt'
      });

      expect(service.actions.length).toBe(2);

      // Undo last action
      await service.undo();
      expect(service.canRedo()).toBe(true);

      // Record new action - should discard redo
      await service.recordAction('FILE_RENAME', {
        originalPath: '/e.txt',
        newPath: '/f.txt'
      });

      expect(service.canRedo()).toBe(false);
      expect(service.actions.length).toBe(2); // 1st action + new action
    });

    test('undo with no actions throws', async () => {
      await service.initialize();

      await expect(service.undo()).rejects.toThrow('No actions to undo');
    });

    test('redo with no undone actions throws', async () => {
      await service.initialize();

      await expect(service.redo()).rejects.toThrow('No actions to redo');
    });

    test('blocks undo when persisted action path fails validation', async () => {
      service.initialized = true;
      service.actions = [
        {
          id: 'action-unsafe',
          type: 'FILE_MOVE',
          data: {
            originalPath: '/safe/original.txt',
            newPath: '/unsafe/blocked.txt'
          },
          timestamp: new Date().toISOString(),
          description: 'Move original.txt'
        }
      ];
      service.currentIndex = 0;

      validateFileOperationPath.mockImplementation(async (candidate) => {
        const value = String(candidate);
        if (value.includes('/unsafe/')) {
          return {
            valid: false,
            normalizedPath: '',
            error: 'Invalid path: access to system directories is not allowed'
          };
        }
        return { valid: true, normalizedPath: value };
      });

      await expect(service.undo()).rejects.toThrow('Unsafe action path blocked');

      const unsafeRename = fs.rename.mock.calls.find(([source]) =>
        String(source).includes('/unsafe/blocked.txt')
      );
      expect(unsafeRename).toBeUndefined();
    });
  });

  describe('Memory limits', () => {
    test('prunes old actions when maxActions exceeded', async () => {
      for (let i = 0; i < 7; i++) {
        await service.recordAction('FILE_RENAME', {
          originalPath: `/old${i}.txt`,
          newPath: `/new${i}.txt`
        });
      }

      // maxActions is 5, so oldest actions should be pruned
      expect(service.actions.length).toBeLessThanOrEqual(5);
    });

    test('tracks memory estimate correctly', async () => {
      await service.recordAction('FILE_MOVE', {
        originalPath: '/a.txt',
        newPath: '/b.txt'
      });

      expect(service.currentMemoryEstimate).toBeGreaterThan(0);
    });

    test('_estimateActionSize handles circular references gracefully', () => {
      const circular = {};
      circular.self = circular;

      const size = service._estimateActionSize(circular);
      // Fallback to 1024 on circular reference
      expect(size).toBe(1024);
    });

    test('_recalculateMemoryEstimate sums all action sizes', async () => {
      await service.recordAction('FILE_MOVE', {
        originalPath: '/a.txt',
        newPath: '/b.txt'
      });
      await service.recordAction('FILE_MOVE', {
        originalPath: '/c.txt',
        newPath: '/d.txt'
      });

      const expected = service.actions.reduce((sum, a) => sum + service._estimateActionSize(a), 0);
      service._recalculateMemoryEstimate();
      expect(service.currentMemoryEstimate).toBe(expected);
    });
  });

  describe('Batch operations', () => {
    test('limits batch operation size to maxBatchSize', async () => {
      const ops = Array.from({ length: 20 }, (_, i) => ({
        originalPath: `/source/file${i}.txt`,
        newPath: `/dest/file${i}.txt`
      }));

      await service.recordAction('BATCH_ORGANIZE', { operations: ops });

      // The recorded action should have at most maxBatchSize (10) operations
      const action = service.actions[service.actions.length - 1];
      expect(action.data.operations.length).toBeLessThanOrEqual(10);
    });

    test('small batch operations are not truncated', async () => {
      const ops = Array.from({ length: 3 }, (_, i) => ({
        originalPath: `/source/file${i}.txt`,
        newPath: `/dest/file${i}.txt`
      }));

      await service.recordAction('BATCH_ORGANIZE', { operations: ops });

      const action = service.actions[service.actions.length - 1];
      expect(action.data.operations.length).toBe(3);
    });
  });

  describe('Batch vector path updates', () => {
    const operations = [
      { type: 'move', originalPath: '/src/a.txt', newPath: '/dst/a.txt' },
      { type: 'move', originalPath: '/src/b.txt', newPath: '/dst/b.txt' }
    ];

    test('undo updates the index per reversed operation and rebuilds search once', async () => {
      await service.recordAction('BATCH_ORGANIZE', { operations });
      jest.spyOn(service, 'reverseFileOperation').mockResolvedValue({ success: true });
      jest.spyOn(service, '_retractLearningForRevertedMoves').mockResolvedValue();
      const updateSpy = jest.spyOn(service, 'updateVectorDbPath').mockResolvedValue();
      const batchSpy = jest.spyOn(service, 'updateVectorDbPaths').mockResolvedValue();
      const rebuildSpy = jest.spyOn(service, '_requestSearchIndexRebuild').mockImplementation();

      await service.undo();

      expect(updateSpy.mock.calls).toEqual([
        ['/dst/b.txt', '/src/b.txt', expect.objectContaining({ rebuildSearchIndex: false })],
        ['/dst/a.txt', '/src/a.txt', expect.objectContaining({ rebuildSearchIndex: false })]
      ]);
      expect(batchSpy).not.toHaveBeenCalled();
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
      expect(rebuildSpy).toHaveBeenCalledWith({ reason: 'undo-redo-batch', count: 2 });
    });

    test('undo skips the index update for an operation that failed to reverse', async () => {
      await service.recordAction('BATCH_ORGANIZE', { operations });
      jest
        .spyOn(service, 'reverseFileOperation')
        .mockResolvedValueOnce({ success: false, error: 'locked' })
        .mockResolvedValueOnce({ success: true });
      jest.spyOn(service, '_retractLearningForRevertedMoves').mockResolvedValue();
      const updateSpy = jest.spyOn(service, 'updateVectorDbPath').mockResolvedValue();
      const rebuildSpy = jest.spyOn(service, '_requestSearchIndexRebuild').mockImplementation();

      await service.undo();

      expect(updateSpy.mock.calls).toEqual([
        ['/dst/a.txt', '/src/a.txt', expect.objectContaining({ rebuildSearchIndex: false })]
      ]);
      expect(rebuildSpy).toHaveBeenCalledWith({ reason: 'undo-redo-batch', count: 1 });
    });

    test('redo updates the index per re-executed operation and rebuilds search once', async () => {
      await service.recordAction('BATCH_ORGANIZE', { operations });
      jest.spyOn(service, 'reverseFileOperation').mockResolvedValue({ success: true });
      jest.spyOn(service, 'executeFileOperation').mockResolvedValue();
      jest.spyOn(service, '_retractLearningForRevertedMoves').mockResolvedValue();
      const updateSpy = jest.spyOn(service, 'updateVectorDbPath').mockResolvedValue();
      const rebuildSpy = jest.spyOn(service, '_requestSearchIndexRebuild').mockImplementation();

      await service.undo();
      updateSpy.mockClear();
      rebuildSpy.mockClear();

      await service.redo();

      expect(updateSpy.mock.calls).toEqual([
        ['/src/a.txt', '/dst/a.txt', expect.objectContaining({ rebuildSearchIndex: false })],
        ['/src/b.txt', '/dst/b.txt', expect.objectContaining({ rebuildSearchIndex: false })]
      ]);
      expect(rebuildSpy).toHaveBeenCalledTimes(1);
      expect(rebuildSpy).toHaveBeenCalledWith({ reason: 'undo-redo-batch', count: 2 });
    });

    test('with the coordinator present, a path update still asks for the BM25 rebuild and reports whether the indexes followed', async () => {
      // The coordinator branch returned before the rebuild request, so
      // keyword search answered with the pre-undo path for up to 15 minutes.
      const { container } = require('../src/main/services/ServiceContainer');
      const coordinator = {
        atomicPathUpdate: jest
          .fn()
          .mockResolvedValueOnce({ success: true, errors: [], updated: {} })
          .mockResolvedValueOnce({
            success: false,
            errors: [{ system: 'vectorDb', error: 'offline' }],
            updated: {}
          })
      };
      container.has.mockReturnValue(true);
      container.resolve.mockReturnValue(coordinator);
      const rebuildSpy = jest.spyOn(service, '_requestSearchIndexRebuild').mockImplementation();
      try {
        const ok = await service.updateVectorDbPath('/dst/a.txt', '/src/a.txt', {
          folderMeta: { clearSmartFolder: true }
        });
        expect(ok).toEqual({ synced: true });
        expect(coordinator.atomicPathUpdate).toHaveBeenCalledWith('/dst/a.txt', '/src/a.txt', {
          type: 'undo_redo',
          skipProcessingState: true,
          folderMeta: { clearSmartFolder: true }
        });
        expect(rebuildSpy).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'undo-redo-move', newPath: '/src/a.txt' })
        );

        const failed = await service.updateVectorDbPath('/dst/b.txt', '/src/b.txt');
        expect(failed.synced).toBe(false);
        expect(failed.warning).toMatch(/b\.txt.*vectorDb/);
      } finally {
        container.has.mockReturnValue(false);
        container.resolve.mockReturnValue(null);
      }
    });

    test('a batch undo whose index updates did not all land is reported as partial with warnings', async () => {
      await service.recordAction('BATCH_ORGANIZE', { operations });
      jest.spyOn(service, 'reverseFileOperation').mockResolvedValue({ success: true });
      jest.spyOn(service, '_retractLearningForRevertedMoves').mockResolvedValue();
      jest.spyOn(service, '_requestSearchIndexRebuild').mockImplementation();
      jest
        .spyOn(service, 'updateVectorDbPath')
        .mockResolvedValueOnce({ synced: true })
        .mockResolvedValueOnce({ synced: false, warning: 'Index not fully updated for a.txt' });

      const result = await service.undo();

      // Both files moved back; one index update did not land.
      expect(result.successCount).toBe(2);
      expect(result.partial).toBe(true);
      expect(result.warnings).toEqual(['Index not fully updated for a.txt']);
      expect(result.message).toMatch(/1 index update incomplete/);
      expect(result.results.map((r) => r.indexSynced)).toEqual([true, false]);
    });

    test('a single move still requests its own search rebuild', async () => {
      const rebuildSpy = jest.spyOn(service, '_requestSearchIndexRebuild').mockImplementation();

      await service.updateVectorDbPath('/src/solo.txt', '/dst/solo.txt');

      expect(rebuildSpy).toHaveBeenCalledWith({
        reason: 'undo-redo-move',
        oldPath: '/src/solo.txt',
        newPath: '/dst/solo.txt'
      });
    });
  });

  describe('Action descriptions', () => {
    test('generates description for FILE_MOVE', () => {
      const desc = service.getActionDescription('FILE_MOVE', {
        originalPath: '/downloads/report.pdf',
        newPath: '/docs/Finance/report.pdf'
      });

      expect(desc).toContain('report.pdf');
    });

    test('generates description for FILE_RENAME', () => {
      const desc = service.getActionDescription('FILE_RENAME', {
        originalPath: '/docs/old-name.txt',
        newPath: '/docs/new-name.txt'
      });

      expect(desc).toContain('old-name.txt');
      expect(desc).toContain('new-name.txt');
    });

    test('handles missing actionData defensively', () => {
      expect(() => service.getActionDescription('FILE_MOVE')).not.toThrow();
      expect(() => service.getActionDescription('FILE_RENAME', null)).not.toThrow();
      expect(() =>
        service.getActionDescription('BATCH_OPERATION', { operations: null })
      ).not.toThrow();
      expect(service.getActionDescription('BATCH_OPERATION', { operations: null })).toContain('0');
    });
  });

  describe('History management', () => {
    test('getActionHistory returns limited results', async () => {
      for (let i = 0; i < 5; i++) {
        await service.recordAction('FILE_RENAME', {
          originalPath: `/file${i}.txt`,
          newPath: `/renamed${i}.txt`
        });
      }

      const history = service.getActionHistory(3);
      expect(history.length).toBeLessThanOrEqual(3);
    });

    test('clearHistory resets everything', async () => {
      await service.recordAction('FILE_MOVE', {
        originalPath: '/a.txt',
        newPath: '/b.txt'
      });

      await service.clearHistory();

      expect(service.actions).toEqual([]);
      expect(service.currentIndex).toBe(-1);
      expect(service.currentMemoryEstimate).toBe(0);
    });

    test('getStats returns full state', async () => {
      await service.initialize();

      const stats = service.getStats();

      expect(stats).toHaveProperty('canUndo');
      expect(stats).toHaveProperty('canRedo');
      expect(stats).toHaveProperty('memoryUsageMB');
      expect(stats).toHaveProperty('memoryLimitMB');
      expect(stats).toHaveProperty('actionLimit');
      expect(stats).toHaveProperty('batchSizeLimit');
    });
  });

  describe('Persistence', () => {
    test('saveActions persists through the fsync-backed durable JSON writer', async () => {
      await service.recordAction('FILE_MOVE', {
        originalPath: '/a.txt',
        newPath: '/b.txt'
      });

      expect(durableWriteJson).toHaveBeenCalledWith(
        expect.stringContaining('undo-actions.json'),
        expect.objectContaining({
          actions: expect.arrayContaining([expect.objectContaining({ type: 'FILE_MOVE' })]),
          currentIndex: 0,
          lastSaved: expect.any(String)
        })
      );
      // No hand-rolled temp + rename any more; the shared writer owns that.
      expect(fs.writeFile).not.toHaveBeenCalled();
    });

    test('loadActions restores state from disk', async () => {
      const saved = {
        actions: [
          {
            id: '1',
            type: 'FILE_MOVE',
            data: { originalPath: '/a', newPath: '/b' },
            timestamp: new Date().toISOString(),
            description: 'test'
          }
        ],
        currentIndex: 0
      };
      fs.readFile.mockResolvedValueOnce(JSON.stringify(saved));

      await service.loadActions();

      expect(service.actions).toHaveLength(1);
      expect(service.currentIndex).toBe(0);
    });

    test('loadActions quarantines corrupted JSON, raises a flag and starts fresh', async () => {
      const { getInstance } = require('../src/main/services/DegradedStateTracker');
      getInstance().clear('undo.history-unreadable');
      fs.readFile.mockResolvedValueOnce('not-json{{{');

      await service.loadActions();

      expect(service.actions).toEqual([]);
      expect(service.currentIndex).toBe(-1);
      // The unreadable bytes are kept next to the live file, not overwritten.
      expect(fs.rename).toHaveBeenCalledWith(
        expect.stringContaining('undo-actions.json'),
        expect.stringMatching(/undo-actions\.json\.corrupt\.\d+$/)
      );
      // A fresh empty history is persisted so the next start is clean.
      expect(durableWriteJson).toHaveBeenCalledWith(
        expect.stringContaining('undo-actions.json'),
        expect.objectContaining({ actions: [], currentIndex: -1 })
      );
      const flag = getInstance()
        .list()
        .find((entry) => entry.code === 'undo.history-unreadable');
      expect(flag).toMatchObject({ subsystem: 'undo', severity: 'warning' });
      expect(flag.message).toContain('reset');
      getInstance().clear('undo.history-unreadable');
    });

    test('loadActions retries a transient read error and then loads the history', async () => {
      const busy = new Error('EBUSY: resource busy or locked');
      busy.code = 'EBUSY';
      fs.readFile.mockRejectedValueOnce(busy).mockResolvedValueOnce(
        JSON.stringify({
          actions: [{ id: '1', type: 'FILE_MOVE', data: { originalPath: '/a', newPath: '/b' } }],
          currentIndex: 0
        })
      );
      const quick = new UndoRedoService({ saveDebounceMs: 0, historyReadRetryDelaysMs: [0, 0] });

      await quick.loadActions();

      expect(fs.readFile).toHaveBeenCalledTimes(2);
      expect(quick.actions).toHaveLength(1);
      expect(fs.rename).not.toHaveBeenCalled();
      expect(durableWriteJson).not.toHaveBeenCalled();
    });

    test('an unreadable history that can be moved aside is kept and a fresh one starts', async () => {
      const { getInstance } = require('../src/main/services/DegradedStateTracker');
      getInstance().clear('undo.history-unreadable');
      const denied = new Error('EACCES: permission denied');
      denied.code = 'EACCES';
      fs.readFile.mockRejectedValue(denied);
      const quick = new UndoRedoService({ saveDebounceMs: 0, historyReadRetryDelaysMs: [0] });

      await quick.loadActions();

      expect(fs.readFile).toHaveBeenCalledTimes(2);
      expect(fs.rename).toHaveBeenCalledWith(
        expect.stringContaining('undo-actions.json'),
        expect.stringMatching(/undo-actions\.json\.unreadable\.\d+$/)
      );
      expect(durableWriteJson).toHaveBeenCalledWith(
        expect.stringContaining('undo-actions.json'),
        expect.objectContaining({ actions: [], currentIndex: -1 })
      );
      const flag = getInstance()
        .list()
        .find((entry) => entry.code === 'undo.history-unreadable');
      expect(flag.message).toContain('EACCES');
      expect(flag.message).toContain('set aside');
      getInstance().clear('undo.history-unreadable');
    });

    test('an unreadable history that cannot be moved aside is never written over', async () => {
      const { getInstance } = require('../src/main/services/DegradedStateTracker');
      getInstance().clear('undo.history-unreadable');
      const busy = new Error('EBUSY: resource busy or locked');
      busy.code = 'EBUSY';
      fs.readFile.mockRejectedValue(busy);
      fs.rename.mockRejectedValue(busy);
      const quick = new UndoRedoService({ saveDebounceMs: 0, historyReadRetryDelaysMs: [0, 0] });

      await quick.loadActions();

      expect(quick.actions).toEqual([]);
      // No empty history is written over the intact file.
      expect(durableWriteJson).not.toHaveBeenCalled();
      const flag = getInstance()
        .list()
        .find((entry) => entry.code === 'undo.history-unreadable');
      expect(flag.message).toContain('left untouched');

      // A later record keeps this session's history in memory only...
      quick.initialized = true;
      await quick.recordAction('FILE_MOVE', { originalPath: '/a', newPath: '/b' });
      expect(quick.actions).toHaveLength(1);
      expect(durableWriteJson).not.toHaveBeenCalled();

      // ...until the hold clears and the file can be moved aside.
      fs.rename.mockResolvedValue();
      await quick.recordAction('FILE_MOVE', { originalPath: '/c', newPath: '/d' });
      expect(fs.rename).toHaveBeenLastCalledWith(
        expect.stringContaining('undo-actions.json'),
        expect.stringMatching(/undo-actions\.json\.unreadable\.\d+$/)
      );
      expect(durableWriteJson).toHaveBeenCalledTimes(1);
      expect(durableWriteJson.mock.calls[0][1].actions).toHaveLength(2);
      getInstance().clear('undo.history-unreadable');
    });

    test('loadActions does not quarantine a missing history file', async () => {
      // beforeEach already rejects readFile with ENOENT.
      await service.loadActions();

      expect(service.actions).toEqual([]);
      expect(fs.rename).not.toHaveBeenCalled();
      expect(durableWriteJson).toHaveBeenCalledTimes(1);
    });

    test('loadActions clamps out-of-range currentIndex from disk', async () => {
      fs.readFile.mockResolvedValueOnce(
        JSON.stringify({
          actions: [
            {
              id: '1',
              type: 'FILE_MOVE',
              data: { originalPath: '/a', newPath: '/b' },
              timestamp: new Date().toISOString(),
              description: 'test 1'
            },
            {
              id: '2',
              type: 'FILE_MOVE',
              data: { originalPath: '/c', newPath: '/d' },
              timestamp: new Date().toISOString(),
              description: 'test 2'
            }
          ],
          currentIndex: 99
        })
      );

      await service.loadActions();

      expect(service.actions).toHaveLength(2);
      expect(service.currentIndex).toBe(1);
      expect(service.canUndo()).toBe(true);
      expect(service.canRedo()).toBe(false);
    });

    test('loadActions clamps negative currentIndex lower bound to -1', async () => {
      fs.readFile.mockResolvedValueOnce(
        JSON.stringify({
          actions: [
            {
              id: '1',
              type: 'FILE_MOVE',
              data: { originalPath: '/a', newPath: '/b' },
              timestamp: new Date().toISOString(),
              description: 'test 1'
            }
          ],
          currentIndex: -99
        })
      );

      await service.loadActions();

      expect(service.actions).toHaveLength(1);
      expect(service.currentIndex).toBe(-1);
      expect(service.canUndo()).toBe(false);
      expect(service.canRedo()).toBe(true);
    });

    test('loadActions treats non-numeric currentIndex as -1', async () => {
      fs.readFile.mockResolvedValueOnce(
        JSON.stringify({
          actions: [
            {
              id: '1',
              type: 'FILE_MOVE',
              data: { originalPath: '/a', newPath: '/b' },
              timestamp: new Date().toISOString(),
              description: 'test 1'
            }
          ],
          currentIndex: 'bad-index'
        })
      );

      await service.loadActions();

      expect(service.actions).toHaveLength(1);
      expect(service.currentIndex).toBe(-1);
      expect(service.canUndo()).toBe(false);
      expect(service.canRedo()).toBe(true);
    });
  });

  describe('Mutex serialization', () => {
    test('concurrent recordAction calls are serialized', async () => {
      const order = [];

      // Override saveActions to track call order
      const origSave = service.saveActions.bind(service);
      service.saveActions = async () => {
        order.push('save-start');
        await new Promise((r) => setTimeout(r, 10));
        order.push('save-end');
      };

      await Promise.all([
        service.recordAction('FILE_MOVE', { originalPath: '/a', newPath: '/b' }),
        service.recordAction('FILE_MOVE', { originalPath: '/c', newPath: '/d' })
      ]);

      // Saves should be serialized (start-end-start-end, not interleaved)
      const firstEnd = order.indexOf('save-end');
      const secondStart = order.lastIndexOf('save-start');
      expect(firstEnd).toBeLessThan(secondStart);
    });
  });

  describe('Constructor configuration', () => {
    test('defaults for maxActions, maxMemoryMB, maxBatchSize', () => {
      const defaultService = new UndoRedoService();

      expect(defaultService.maxActions).toBe(50);
      expect(defaultService.maxMemoryMB).toBe(10);
      expect(defaultService.maxBatchSize).toBe(1000);
    });

    test('custom values are respected', () => {
      expect(service.maxActions).toBe(5);
      expect(service.maxMemoryMB).toBe(1);
      expect(service.maxBatchSize).toBe(10);
    });
  });

  describe('Initialize', () => {
    test('initialize sets initialized flag', async () => {
      await service.initialize();

      expect(service.initialized).toBe(true);
    });

    test('double initialize is a no-op', async () => {
      await service.initialize();
      await service.initialize();

      // Should only read file once (first init)
      expect(fs.readFile).toHaveBeenCalledTimes(1);
    });

    test('initialize recovers from loadActions failure', async () => {
      fs.readFile.mockRejectedValueOnce(new Error('Disk error'));

      await service.initialize();

      expect(service.initialized).toBe(true);
      expect(service.actions).toEqual([]);
    });
  });
});
