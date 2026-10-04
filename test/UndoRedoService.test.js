/**
 * @jest-environment node
 */
/**
 * Tests for UndoRedoService
 * Tests undo/redo functionality, memory management, and file operations
 */

// Unmock fs to use real filesystem for these tests
// The global test-setup mocks fs with memfs, but this causes path resolution
// issues on Windows. These tests need the real filesystem.
jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const path = require('path');
const fs = require('fs').promises;
const os = require('os');

// Mock electron with a getter that reads the dynamic value
jest.mock('electron', () => ({
  app: {
    getPath: jest.fn()
  }
}));

describe('UndoRedoService', () => {
  let UndoRedoService;
  let service;
  let testDir;

  beforeEach(async () => {
    // Create temp directory for tests FIRST
    testDir = path.join(os.tmpdir(), `undo-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Update the mock to return our testDir
    const electron = require('electron');
    electron.app.getPath.mockReturnValue(testDir);

    // Clear module cache and re-require with updated mock
    jest.resetModules();

    // After reset, re-require electron and update mock again
    const electronAfterReset = require('electron');
    electronAfterReset.app.getPath.mockReturnValue(testDir);

    UndoRedoService = require('../src/main/services/UndoRedoService');
    service = new UndoRedoService({
      maxActions: 10,
      maxMemoryMB: 1,
      maxBatchSize: 100,
      saveDebounceMs: 0
    });
  });

  afterEach(async () => {
    // Cleanup test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('constructor', () => {
    test('initializes with default options', () => {
      const defaultService = new UndoRedoService();
      expect(defaultService.maxActions).toBe(50);
      expect(defaultService.maxMemoryMB).toBe(10);
      expect(defaultService.maxBatchSize).toBe(1000);
    });

    test('accepts custom options', () => {
      expect(service.maxActions).toBe(10);
      expect(service.maxMemoryMB).toBe(1);
      expect(service.maxBatchSize).toBe(100);
    });

    test('initializes with empty actions', () => {
      expect(service.actions).toEqual([]);
      expect(service.currentIndex).toBe(-1);
    });
  });

  describe('initialize', () => {
    test('sets initialized to true', async () => {
      await service.initialize();
      expect(service.initialized).toBe(true);
    });

    test('does not reinitialize', async () => {
      await service.initialize();
      const spy = jest.spyOn(service, 'loadActions');
      await service.initialize();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('canUndo/canRedo', () => {
    test('canUndo returns false when no actions', () => {
      expect(service.canUndo()).toBe(false);
    });

    test('canRedo returns false when no actions', () => {
      expect(service.canRedo()).toBe(false);
    });

    test('canUndo returns true after recording action', async () => {
      await service.recordAction('FILE_MOVE', {
        originalPath: '/a',
        newPath: '/b'
      });
      expect(service.canUndo()).toBe(true);
    });

    test('canRedo returns true after undo', async () => {
      const source = path.join(testDir, 'source.txt');
      const dest = path.join(testDir, 'dest.txt');
      await fs.writeFile(dest, 'content');

      await service.recordAction('FILE_MOVE', {
        originalPath: source,
        newPath: dest
      });

      await service.undo();
      expect(service.canRedo()).toBe(true);
    });
  });

  describe('recordAction', () => {
    test('records action and increments index', async () => {
      await service.recordAction('FILE_MOVE', {
        originalPath: '/a',
        newPath: '/b'
      });

      expect(service.actions).toHaveLength(1);
      expect(service.currentIndex).toBe(0);
    });

    test('generates unique action ID', async () => {
      const id1 = await service.recordAction('FILE_MOVE', {
        originalPath: '/a',
        newPath: '/b'
      });
      const id2 = await service.recordAction('FILE_MOVE', {
        originalPath: '/c',
        newPath: '/d'
      });

      expect(id1).not.toBe(id2);
    });

    test('truncates batch operations over max size', async () => {
      const operations = Array(200)
        .fill()
        .map((_, i) => ({
          type: 'move',
          originalPath: `/a${i}`,
          newPath: `/b${i}`
        }));

      await service.recordAction('BATCH_ORGANIZE', { operations });

      expect(service.actions[0].data.operations.length).toBe(100);
    });

    test('removes future actions when recording after undo', async () => {
      await service.recordAction('FILE_MOVE', {
        originalPath: '/a',
        newPath: '/b'
      });

      const source = path.join(testDir, 'source.txt');
      const dest = path.join(testDir, 'dest.txt');
      await fs.writeFile(dest, 'content');
      await service.recordAction('FILE_MOVE', {
        originalPath: source,
        newPath: dest
      });

      await service.undo();

      await service.recordAction('FILE_RENAME', {
        originalPath: '/e',
        newPath: '/f'
      });

      expect(service.actions).toHaveLength(2);
      expect(service.actions[1].type).toBe('FILE_RENAME');
    });

    test('prunes old actions when max is exceeded', async () => {
      for (let i = 0; i < 15; i++) {
        await service.recordAction('FILE_MOVE', {
          originalPath: `/a${i}`,
          newPath: `/b${i}`
        });
      }

      expect(service.actions.length).toBeLessThanOrEqual(10);
    });
  });

  describe('ghost-cleanup latch', () => {
    test('undo and redo hold the latch while files move and release it afterwards', async () => {
      const guard = require('../src/shared/ghostCleanupGuard');
      const src = path.join(testDir, 'a.txt');
      const dest = path.join(testDir, 'b.txt');
      await fs.writeFile(dest, 'x');
      await service.recordAction('FILE_MOVE', { originalPath: src, newPath: dest });

      const seen = [];
      const origReverse = service.executeReverseAction.bind(service);
      service.executeReverseAction = async (action) => {
        seen.push(['undo', guard.isGhostCleanupDeferred()]);
        return origReverse(action);
      };
      const origForward = service.executeForwardAction.bind(service);
      service.executeForwardAction = async (action) => {
        seen.push(['redo', guard.isGhostCleanupDeferred()]);
        return origForward(action);
      };

      await service.undo();
      expect(guard.isGhostCleanupDeferred()).toBe(false);
      await service.redo();
      expect(guard.isGhostCleanupDeferred()).toBe(false);
      expect(seen).toEqual([
        ['undo', true],
        ['redo', true]
      ]);
    });
  });

  describe('getActionDescription', () => {
    test('describes FILE_MOVE', () => {
      const desc = service.getActionDescription('FILE_MOVE', {
        originalPath: '/home/test.txt',
        newPath: '/home/docs/test.txt'
      });
      expect(desc).toContain('Move');
      expect(desc).toContain('test.txt');
    });

    test('describes FILE_RENAME', () => {
      const desc = service.getActionDescription('FILE_RENAME', {
        originalPath: '/home/old.txt',
        newPath: '/home/new.txt'
      });
      expect(desc).toContain('Rename');
      expect(desc).toContain('old.txt');
      expect(desc).toContain('new.txt');
    });

    test('describes FILE_DELETE', () => {
      const desc = service.getActionDescription('FILE_DELETE', {
        originalPath: '/home/deleted.txt'
      });
      expect(desc).toContain('Delete');
      expect(desc).toContain('deleted.txt');
    });

    test('describes FOLDER_CREATE', () => {
      const desc = service.getActionDescription('FOLDER_CREATE', {
        folderPath: '/home/newfolder'
      });
      expect(desc).toContain('Create folder');
      expect(desc).toContain('newfolder');
    });

    test('describes BATCH_ORGANIZE', () => {
      const desc = service.getActionDescription('BATCH_ORGANIZE', {
        operations: [{}, {}, {}]
      });
      expect(desc).toContain('Organize');
      expect(desc).toContain('3');
    });
  });

  describe('generateId', () => {
    test('generates unique IDs', () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        ids.add(service.generateId());
      }
      expect(ids.size).toBe(100);
    });
  });

  describe('getActionHistory', () => {
    test('returns empty array when no actions', () => {
      expect(service.getActionHistory()).toEqual([]);
    });

    test('returns action history', async () => {
      await service.recordAction('FILE_MOVE', {
        originalPath: '/a',
        newPath: '/b'
      });
      await service.recordAction('FILE_RENAME', {
        originalPath: '/c',
        newPath: '/d'
      });

      const history = service.getActionHistory();

      expect(history).toHaveLength(2);
      expect(history[0]).toHaveProperty('id');
      expect(history[0]).toHaveProperty('description');
      expect(history[0]).toHaveProperty('timestamp');
      expect(history[0]).toHaveProperty('type');
    });

    test('respects limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await service.recordAction('FILE_MOVE', {
          originalPath: `/a${i}`,
          newPath: `/b${i}`
        });
      }

      const history = service.getActionHistory(2);
      expect(history).toHaveLength(2);
    });
  });

  describe('getRedoHistory', () => {
    test('returns empty array when nothing to redo', () => {
      expect(service.getRedoHistory()).toEqual([]);
    });
  });

  describe('getFullState', () => {
    test('includes operations metadata for batch actions', async () => {
      const operations = [
        { source: '/in/a.txt', destination: '/out/a.txt' },
        { source: '/in/b.txt', destination: '/out/b.txt' }
      ];
      await service.recordAction('BATCH_OPERATION', { operations });

      const state = service.getFullState();
      expect(state.stack).toHaveLength(1);
      expect(state.stack[0].metadata.operationCount).toBe(2);
      expect(state.stack[0].metadata.operations).toEqual(operations);
    });
  });

  describe('clearHistory', () => {
    test('clears all actions', async () => {
      await service.recordAction('FILE_MOVE', {
        originalPath: '/a',
        newPath: '/b'
      });
      await service.recordAction('FILE_MOVE', {
        originalPath: '/c',
        newPath: '/d'
      });

      await service.clearHistory();

      expect(service.actions).toEqual([]);
      expect(service.currentIndex).toBe(-1);
      expect(service.currentMemoryEstimate).toBe(0);
    });
  });

  describe('getStats', () => {
    test('returns statistics', async () => {
      await service.recordAction('FILE_MOVE', {
        originalPath: '/a',
        newPath: '/b'
      });

      const stats = service.getStats();

      expect(stats).toHaveProperty('totalActions');
      expect(stats).toHaveProperty('currentIndex');
      expect(stats).toHaveProperty('canUndo');
      expect(stats).toHaveProperty('canRedo');
      expect(stats).toHaveProperty('memoryUsageMB');
      expect(stats).toHaveProperty('memoryLimitMB');
      expect(stats).toHaveProperty('actionLimit');
      expect(stats).toHaveProperty('batchSizeLimit');
    });

    test('totalActions reflects recorded actions', async () => {
      await service.recordAction('FILE_MOVE', {
        originalPath: '/a',
        newPath: '/b'
      });
      await service.recordAction('FILE_MOVE', {
        originalPath: '/c',
        newPath: '/d'
      });

      const stats = service.getStats();
      expect(stats.totalActions).toBe(2);
    });
  });

  describe('fileExists', () => {
    test('returns true for existing file', async () => {
      const filePath = path.join(testDir, 'exists.txt');
      await fs.writeFile(filePath, 'content');

      const result = await service.fileExists(filePath);
      expect(result).toBe(true);
    });

    test('returns false for non-existing file', async () => {
      const filePath = path.join(testDir, 'notexists.txt');
      const result = await service.fileExists(filePath);
      expect(result).toBe(false);
    });
  });

  describe('safeMove', () => {
    test('moves file to destination', async () => {
      const source = path.join(testDir, 'source.txt');
      const dest = path.join(testDir, 'dest.txt');
      await fs.writeFile(source, 'content');

      await service.safeMove(source, dest);

      expect(await service.fileExists(source)).toBe(false);
      expect(await service.fileExists(dest)).toBe(true);
    });

    test('creates destination directory if needed', async () => {
      const source = path.join(testDir, 'source.txt');
      const dest = path.join(testDir, 'subdir', 'dest.txt');
      await fs.writeFile(source, 'content');

      await service.safeMove(source, dest);

      expect(await service.fileExists(dest)).toBe(true);
    });

    test('fails closed when the occupancy probe fails open on an occupied destination', async () => {
      // Regression: fileExists() returns false on ANY fs.access error
      // (EACCES included), so an occupied-but-unreadable destination used
      // to read as free — and the bare fs.rename then silently replaced
      // the occupant. safeMove now routes through renameNoReplace, whose
      // own probe fails closed. Simulate the fail-open preflight by
      // stubbing fileExists; the destination genuinely exists on disk.
      const source = path.join(testDir, 'src.txt');
      const dest = path.join(testDir, 'occupied.txt');
      await fs.writeFile(source, 'source-content');
      await fs.writeFile(dest, 'occupant-content');

      jest
        .spyOn(service, 'fileExists')
        .mockResolvedValueOnce(true) // source-exists check passes
        .mockResolvedValueOnce(false); // destination probe fails open

      await expect(service.safeMove(source, dest)).rejects.toMatchObject({
        code: 'UNDO_DESTINATION_OCCUPIED'
      });

      // The occupant must be intact and the source unconsumed.
      expect(await fs.readFile(dest, 'utf8')).toBe('occupant-content');
      expect(await fs.readFile(source, 'utf8')).toBe('source-content');
    });
  });

  describe('createBackup', () => {
    test('creates backup of file', async () => {
      const source = path.join(testDir, 'tobackup.txt');
      await fs.writeFile(source, 'backup content');

      const backupPath = await service.createBackup(source);

      expect(await service.fileExists(backupPath)).toBe(true);
    });

    test('backup has same content', async () => {
      const source = path.join(testDir, 'tobackup.txt');
      const content = 'original content';
      await fs.writeFile(source, content);

      const backupPath = await service.createBackup(source);
      const backupContent = await fs.readFile(backupPath, 'utf8');

      expect(backupContent).toBe(content);
    });

    test('throws for non-existent file', async () => {
      const source = path.join(testDir, 'notexists.txt');

      await expect(service.createBackup(source)).rejects.toThrow();
    });
  });

  describe('cleanupOldBackups', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    test('returns cleanup result', async () => {
      const result = await service.cleanupOldBackups();
      expect(result).toHaveProperty('removed');
      expect(result).toHaveProperty('errors');
    });

    test('age gate: spares unreferenced backups younger than 24h, reaps older ones', async () => {
      // Regression for the crash-window data-loss bug: a backup can be
      // legitimately unreferenced for a short time (crash between unlink
      // and the debounced actions-file flush). The orphan sweep must not
      // destroy it — it may be the only surviving copy of the user's file.
      const backupDir = path.join(testDir, 'undo-backups');
      await fs.mkdir(backupDir, { recursive: true });

      const oldOrphan = `${Date.now() - 25 * 60 * 60 * 1000}_aaaa_old.txt`;
      const youngOrphan = `${Date.now() - 60 * 1000}_bbbb_young.txt`;
      const referencedOld = `${Date.now() - 2 * DAY_MS}_cccc_referenced.txt`;
      await fs.writeFile(path.join(backupDir, oldOrphan), 'old orphan');
      await fs.writeFile(path.join(backupDir, youngOrphan), 'young orphan');
      await fs.writeFile(path.join(backupDir, referencedOld), 'referenced');

      // Reference one backup from the action history — it must survive
      // regardless of age.
      service.actions = [
        {
          id: 'a1',
          type: 'FILE_DELETE',
          data: { backupPath: path.join(backupDir, referencedOld) }
        }
      ];

      const result = await service.cleanupOldBackups();

      expect(result.removed).toBe(1);
      expect(result.skippedYoung).toBe(1);
      await expect(fs.access(path.join(backupDir, oldOrphan))).rejects.toThrow();
      await expect(fs.access(path.join(backupDir, youngOrphan))).resolves.toBeUndefined();
      await expect(fs.access(path.join(backupDir, referencedOld))).resolves.toBeUndefined();
    });

    test('backups named by a set-aside history file survive the sweep', async () => {
      // loadActions quarantines an unparseable or unreadable history beside
      // the live file. With the live history now empty, the sweep used to
      // delete the delete-backups that file still pointed at.
      const backupDir = path.join(testDir, 'undo-backups');
      await fs.mkdir(backupDir, { recursive: true });
      const twoDaysAgo = Date.now() - 2 * DAY_MS;
      const namedByCorrupt = `${twoDaysAgo}_dddd_report.docx`;
      const namedByUnreadable = `${twoDaysAgo}_eeee_notes.txt`;
      const trueOrphan = `${twoDaysAgo}_ffff_orphan.txt`;
      for (const name of [namedByCorrupt, namedByUnreadable, trueOrphan]) {
        await fs.writeFile(path.join(backupDir, name), 'x');
      }
      // Torn JSON: the backupPath pair is lifted from the text, not parsed.
      await fs.writeFile(
        `${service.actionsPath}.corrupt.${twoDaysAgo}`,
        `{"actions":[{"type":"FILE_DELETE","data":{"backupPath":${JSON.stringify(
          path.join(backupDir, namedByCorrupt)
        )}}},{"type":"BATCH_OPERATION","data":{"operations":[{"backupPa`
      );
      await fs.writeFile(
        `${service.actionsPath}.unreadable.${twoDaysAgo + 1}`,
        JSON.stringify({
          actions: [
            {
              type: 'BATCH_OPERATION',
              data: { operations: [{ backupPath: path.join(backupDir, namedByUnreadable) }] }
            }
          ]
        })
      );
      service.actions = [];

      const result = await service.cleanupOldBackups();

      expect(result.removed).toBe(1);
      await expect(fs.access(path.join(backupDir, trueOrphan))).rejects.toThrow();
      await expect(fs.access(path.join(backupDir, namedByCorrupt))).resolves.toBeUndefined();
      await expect(fs.access(path.join(backupDir, namedByUnreadable))).resolves.toBeUndefined();
    });

    test('age gate falls back to mtime for files without a timestamp prefix', async () => {
      const backupDir = path.join(testDir, 'undo-backups');
      await fs.mkdir(backupDir, { recursive: true });
      // Freshly created (young mtime) and no parseable prefix — must be kept.
      await fs.writeFile(path.join(backupDir, 'noprefix.txt'), 'x');

      const result = await service.cleanupOldBackups();

      expect(result.removed).toBe(0);
      await expect(fs.access(path.join(backupDir, 'noprefix.txt'))).resolves.toBeUndefined();
    });
  });

  describe('recordAction durability (crash-window ordering)', () => {
    test('durable: true flushes the action to disk before resolving, bypassing the debounce', async () => {
      const debounced = new UndoRedoService({
        maxActions: 10,
        maxMemoryMB: 1,
        maxBatchSize: 100,
        saveDebounceMs: 60_000 // long enough that only a forced flush can persist
      });
      const actionsPath = path.join(testDir, 'undo-actions.json');

      // A plain recordAction sits in the debounce window — not yet on disk.
      await debounced.recordAction('FILE_MOVE', { originalPath: '/a', newPath: '/b' });
      let persisted = JSON.parse(await fs.readFile(actionsPath, 'utf8'));
      expect(persisted.actions).toHaveLength(0);

      // durable: true must be readable from disk the moment it resolves —
      // this is what makes record-before-unlink crash-safe for deletes.
      const id = await debounced.recordAction(
        'FILE_DELETE',
        { originalPath: '/x', backupPath: '/backups/1_x', createBackup: true },
        { durable: true }
      );
      persisted = JSON.parse(await fs.readFile(actionsPath, 'utf8'));
      expect(persisted.actions.map((a) => a.id)).toContain(id);
      expect(persisted.actions.find((a) => a.id === id).data.backupPath).toBe('/backups/1_x');

      await debounced.shutdown();
    });
  });

  describe('removeAction', () => {
    test('removes a recorded action by id and persists the removal', async () => {
      const id1 = await service.recordAction('FILE_MOVE', { originalPath: '/a', newPath: '/b' });
      const id2 = await service.recordAction('FILE_DELETE', {
        originalPath: '/x',
        backupPath: '/backups/1_x',
        createBackup: true
      });

      const removedResult = await service.removeAction(id2);

      expect(removedResult).toBe(true);
      expect(service.actions.map((a) => a.id)).toEqual([id1]);
      expect(service.currentIndex).toBe(0);

      const persisted = JSON.parse(
        await fs.readFile(path.join(testDir, 'undo-actions.json'), 'utf8')
      );
      expect(persisted.actions.map((a) => a.id)).toEqual([id1]);
    });

    test('returns false for an unknown id', async () => {
      await service.recordAction('FILE_MOVE', { originalPath: '/a', newPath: '/b' });
      await expect(service.removeAction('nope')).resolves.toBe(false);
      expect(service.actions).toHaveLength(1);
    });
  });

  describe('memory management', () => {
    test('estimates action size', () => {
      const action = {
        id: 'test',
        type: 'FILE_MOVE',
        data: { originalPath: '/a', newPath: '/b' }
      };
      const size = service._estimateActionSize(action);
      expect(typeof size).toBe('number');
      expect(size).toBeGreaterThan(0);
    });

    test('recalculates memory estimate', async () => {
      await service.recordAction('FILE_MOVE', {
        originalPath: '/a',
        newPath: '/b'
      });
      const beforeRecalc = service.currentMemoryEstimate;

      service._recalculateMemoryEstimate();

      expect(service.currentMemoryEstimate).toBe(beforeRecalc);
    });
  });

  describe('undo', () => {
    test('throws when nothing to undo', async () => {
      await service.initialize();
      await expect(service.undo()).rejects.toThrow('No actions to undo');
    });

    test('returns clear error for truncated batch action data', async () => {
      service.initialized = true;
      service.actions = [
        {
          id: 'truncated-undo-1',
          type: 'BATCH_OPERATION',
          timestamp: new Date().toISOString(),
          description: 'Truncated batch action',
          data: {
            truncated: true
          }
        }
      ];
      service.currentIndex = 0;

      await expect(service.undo()).rejects.toThrow('Cannot undo truncated batch action data');
    });
  });

  describe('redo', () => {
    test('throws when nothing to redo', async () => {
      await service.initialize();
      await expect(service.redo()).rejects.toThrow('No actions to redo');
    });

    test('returns clear error for truncated batch action data', async () => {
      service.initialized = true;
      service.actions = [
        {
          id: 'truncated-redo-1',
          type: 'BATCH_OPERATION',
          timestamp: new Date().toISOString(),
          description: 'Truncated batch action',
          data: {
            truncated: true
          }
        }
      ];
      service.currentIndex = -1;

      await expect(service.redo()).rejects.toThrow('Cannot redo truncated batch action data');
    });
  });

  describe('shutdown', () => {
    test('flushes a pending debounced save and cancels the timer', async () => {
      // Use a service with a real debounce so a pending timer exists at shutdown.
      const debouncedService = new UndoRedoService({
        maxActions: 10,
        maxMemoryMB: 1,
        maxBatchSize: 100,
        saveDebounceMs: 500
      });
      await debouncedService.initialize();

      const saveSpy = jest.spyOn(debouncedService, 'saveActions');
      debouncedService._scheduleSaveActions();
      expect(debouncedService._pendingSaveTimer).not.toBeNull();

      await debouncedService.shutdown();

      expect(debouncedService._pendingSaveTimer).toBeNull();
      expect(saveSpy).toHaveBeenCalled();
    });

    test('is safe to call when nothing is pending', async () => {
      await service.initialize();
      await expect(service.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('_collectMoveMutations (F-152 broadcast source)', () => {
    const batchAction = {
      type: 'MOVE_BATCH',
      data: {
        operations: [
          { type: 'move', originalPath: '/src/a.pdf', newPath: '/dest/a.pdf' },
          { type: 'move', originalPath: '/src/b.pdf', newPath: '/dest/b.pdf' },
          { type: 'trash', originalPath: '/src/c.pdf' }
        ]
      }
    };

    test('undo flips batch move pairs (newPath -> originalPath) and skips trash ops', () => {
      const pairs = service._collectMoveMutations(batchAction, undefined, 'undo');
      expect(pairs).toEqual([
        { oldPath: '/dest/a.pdf', newPath: '/src/a.pdf' },
        { oldPath: '/dest/b.pdf', newPath: '/src/b.pdf' }
      ]);
    });

    test('redo keeps forward direction (originalPath -> newPath)', () => {
      const pairs = service._collectMoveMutations(batchAction, undefined, 'redo');
      expect(pairs).toEqual([
        { oldPath: '/src/a.pdf', newPath: '/dest/a.pdf' },
        { oldPath: '/src/b.pdf', newPath: '/dest/b.pdf' }
      ]);
    });

    test('skips ops whose result (matched by opIndex) reports failure', () => {
      // Undo walks the batch backwards, so results arrive as c, b, a.
      const results = [
        { success: false, opIndex: 2 },
        { success: false, opIndex: 1 },
        { success: true, opIndex: 0 }
      ];
      const pairs = service._collectMoveMutations(batchAction, results, 'undo');
      expect(pairs).toEqual([{ oldPath: '/dest/a.pdf', newPath: '/src/a.pdf' }]);
    });

    test('a partial undo names the files that actually moved back, not their mirror image', () => {
      // c and b reversed, a failed (destination occupied). Position-based
      // alignment paired a with c's success and reported a as moved.
      const results = [
        { success: true, opIndex: 2 },
        { success: true, opIndex: 1 },
        { success: false, opIndex: 0 }
      ];
      expect(service._collectMoveMutations(batchAction, results, 'undo')).toEqual([
        { oldPath: '/dest/b.pdf', newPath: '/src/b.pdf' }
      ]);
    });

    test('results without an opIndex are read in the order the undo loop produced them', () => {
      // Legacy shape: three results in reverse execution order (c, b, a).
      const results = [{ success: true }, { success: true }, { success: false }];
      expect(service._collectMoveMutations(batchAction, results, 'undo')).toEqual([
        { oldPath: '/dest/b.pdf', newPath: '/src/b.pdf' }
      ]);
      // Redo runs forward, so the same array reads a, b, c.
      expect(service._collectMoveMutations(batchAction, results, 'redo')).toEqual([
        { oldPath: '/src/a.pdf', newPath: '/dest/a.pdf' },
        { oldPath: '/src/b.pdf', newPath: '/dest/b.pdf' }
      ]);
    });

    test('a real partial batch undo broadcasts only the moves that happened', async () => {
      const dir = path.join(testDir, 'partial');
      const src = (name) => path.join(dir, 'src', name);
      const dest = (name) => path.join(dir, 'dest', name);
      await fs.mkdir(path.join(dir, 'src'), { recursive: true });
      await fs.mkdir(path.join(dir, 'dest'), { recursive: true });
      // a cannot go back: its original path is occupied. b and c can.
      await fs.writeFile(src('a.txt'), 'occupant');
      for (const name of ['a.txt', 'b.txt', 'c.txt']) await fs.writeFile(dest(name), name);
      await service.recordBatch('MOVE_BATCH', [
        { type: 'move', originalPath: src('a.txt'), newPath: dest('a.txt') },
        { type: 'move', originalPath: src('b.txt'), newPath: dest('b.txt') },
        { type: 'move', originalPath: src('c.txt'), newPath: dest('c.txt') }
      ]);

      const result = await service.undo();

      expect(result.failCount).toBe(1);
      expect(result.pathMutations).toEqual([
        { oldPath: dest('b.txt'), newPath: src('b.txt') },
        { oldPath: dest('c.txt'), newPath: src('c.txt') }
      ]);
    });

    test('handles single FILE_MOVE actions', () => {
      const action = {
        type: 'FILE_MOVE',
        data: { originalPath: '/src/one.pdf', newPath: '/dest/one.pdf' }
      };
      expect(service._collectMoveMutations(action, undefined, 'undo')).toEqual([
        { oldPath: '/dest/one.pdf', newPath: '/src/one.pdf' }
      ]);
      expect(service._collectMoveMutations(action, undefined, 'redo')).toEqual([
        { oldPath: '/src/one.pdf', newPath: '/dest/one.pdf' }
      ]);
    });
  });

  describe('one history, announced (UR-01, UR-08, UR-14)', () => {
    test('hasBatchActionCovering is decided per move, so a resumed run keeps its own undo entry', async () => {
      const op = (n) => ({ type: 'move', originalPath: `/in/${n}.pdf`, newPath: `/out/${n}.pdf` });
      // The live run recorded moves 0-1 before the user paused it.
      await service.recordAction('BATCH_OPERATION', {
        batchId: 'batch_2_cafe0001',
        operations: [op(0), op(1)]
      });

      // A retry of that same persistence after a crash is covered...
      expect(
        await service.hasBatchActionCovering('batch_2_cafe0001', [op(0), op(1)], {
          includeDerived: true
        })
      ).toBe(true);
      expect(await service.hasBatchActionCovering('batch_2_cafe0001', [op(1)])).toBe(true);
      // ...the moves the resumed run just made are not.
      expect(await service.hasBatchActionCovering('batch_2_cafe0001', [op(2), op(3)])).toBe(false);
      expect(await service.hasBatchActionCovering('batch_2_cafe0001', [op(1), op(2)])).toBe(false);

      // Entries under derived ids count towards coverage together.
      await service.recordAction('BATCH_OPERATION', {
        batchId: 'batch_2_cafe0001:r1700000000000',
        operations: [op(2), op(3)]
      });
      expect(
        await service.hasBatchActionCovering('batch_2_cafe0001', [op(0), op(3)], {
          includeDerived: true
        })
      ).toBe(true);
      expect(
        await service.hasBatchActionCovering('batch_2_cafe0001', [op(3)], {
          includeDerived: false
        })
      ).toBe(false);
      expect(await service.hasBatchActionCovering('batch_2_cafe0001', [])).toBe(false);
    });

    test('uncoveredBatchOperations returns the moves no entry for the batch lists yet', async () => {
      const op = (n) => ({ type: 'move', originalPath: `/in/${n}.pdf`, newPath: `/out/${n}.pdf` });
      await service.recordAction('BATCH_OPERATION', {
        batchId: 'batch_2_cafe0001',
        operations: [op(0), op(1)]
      });

      // A resume persisting the union of done ops records only the remainder.
      expect(
        await service.uncoveredBatchOperations('batch_2_cafe0001', [op(0), op(1), op(2), op(3)], {
          includeDerived: true
        })
      ).toEqual([op(2), op(3)]);
      expect(await service.uncoveredBatchOperations('batch_2_cafe0001', [op(0), op(1)])).toEqual(
        []
      );
      // Same identity as hasBatchActionCovering: original + new path, not type.
      expect(
        await service.uncoveredBatchOperations('batch_2_cafe0001', [{ ...op(1), type: 'rename' }])
      ).toEqual([]);
      // Entries under derived ids count only when asked for.
      await service.recordAction('BATCH_OPERATION', {
        batchId: 'batch_2_cafe0001:r1700000000000',
        operations: [op(2)]
      });
      expect(
        await service.uncoveredBatchOperations('batch_2_cafe0001', [op(2), op(3)], {
          includeDerived: true
        })
      ).toEqual([op(3)]);
      expect(
        await service.uncoveredBatchOperations('batch_2_cafe0001', [op(2), op(3)], {
          includeDerived: false
        })
      ).toEqual([op(2), op(3)]);
      // Nothing recorded for the batch, or no batch id: nothing is covered.
      expect(await service.uncoveredBatchOperations('batch_7_00000000', [op(0)])).toEqual([op(0)]);
      expect(await service.uncoveredBatchOperations(null, [op(0)])).toEqual([op(0)]);
    });

    test('hasBatchAction matches ids derived from a live batch id only when asked', async () => {
      await service.recordAction('BATCH_OPERATION', {
        batchId: 'batch_1_abcdef01:p3',
        operations: [{ type: 'move', originalPath: '/a/x.txt', newPath: '/b/x.txt' }]
      });

      expect(await service.hasBatchAction('batch_1_abcdef01:p3')).toBe(true);
      expect(await service.hasBatchAction('batch_1_abcdef01')).toBe(false);
      expect(await service.hasBatchAction('batch_1_abcdef01', { includeDerived: true })).toBe(true);
      expect(await service.hasBatchAction('batch_1_abcdef0', { includeDerived: true })).toBe(false);
    });

    test('record, remove and clear notify state listeners; undo does not (its handler does)', async () => {
      const seen = [];
      const unsubscribe = service.onStateChanged((change) => seen.push(change.reason));

      const id = await service.recordAction('FILE_MOVE', {
        originalPath: path.join(testDir, 'a.txt'),
        newPath: path.join(testDir, 'b.txt')
      });
      await service.removeAction(id);
      await service.clearHistory();
      expect(seen).toEqual(['record', 'remove', 'clear']);

      unsubscribe();
      await service.recordAction('FILE_MOVE', {
        originalPath: path.join(testDir, 'c.txt'),
        newPath: path.join(testDir, 'd.txt')
      });
      expect(seen).toEqual(['record', 'remove', 'clear']);
    });

    test('getFullState marks trash-only entries as not reversible and carries the batch id', async () => {
      await service.recordAction('BATCH_OPERATION', {
        batchId: 'batch_7_deadbeef',
        operations: [{ type: 'move', originalPath: '/a/x.txt', newPath: '/b/x.txt' }]
      });
      await service.recordBatch(
        'TRASH_BATCH',
        [
          { type: 'trash', originalPath: '/a/one.txt' },
          { type: 'trash', originalPath: '/a/two.txt' }
        ],
        { summary: { label: 'Delete duplicates' } }
      );

      const state = service.getFullState();
      expect(state.stack).toHaveLength(2);
      expect(state.stack[0]).toEqual(
        expect.objectContaining({
          type: 'BATCH_OPERATION',
          reversible: true,
          metadata: expect.objectContaining({ batchId: 'batch_7_deadbeef' })
        })
      );
      expect(state.stack[1]).toEqual(
        expect.objectContaining({
          type: 'TRASH_BATCH',
          reversible: false,
          description: 'Delete duplicates (2 files)'
        })
      );
    });

    test('undoing a trash-only entry restores nothing, says so, and drops the entry', async () => {
      await service.recordAction('FILE_MOVE', {
        originalPath: path.join(testDir, 'keep-a.txt'),
        newPath: path.join(testDir, 'keep-b.txt')
      });
      await service.recordBatch('TRASH_BATCH', [
        { type: 'trash', originalPath: '/a/one.txt' },
        { type: 'trash', originalPath: '/a/two.txt' }
      ]);
      expect(service.actions).toHaveLength(2);

      const result = await service.undo();

      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          code: 'TRASH_NO_RESTORE',
          removedFromHistory: true,
          message: expect.stringContaining('2 files are in the system Trash'),
          successCount: 0,
          failCount: 0
        })
      );
      expect(result.message).not.toMatch(/^Undid/);
      // The entry is gone from both stacks; the earlier move is the new top.
      expect(service.actions).toHaveLength(1);
      expect(service.currentIndex).toBe(0);
      expect(service.canRedo()).toBe(false);
      expect(service.actions[0].type).toBe('FILE_MOVE');
    });

    test('a mixed batch says how many files stay in the Trash', async () => {
      const src = path.join(testDir, 'moved.txt');
      const dest = path.join(testDir, 'sorted', 'moved.txt');
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, 'x');
      await service.recordBatch('MOVE_BATCH', [
        { type: 'move', originalPath: src, newPath: dest },
        { type: 'trash', originalPath: path.join(testDir, 'gone.txt') }
      ]);

      const result = await service.undo();

      expect(result.success).toBe(true);
      expect(result.message).toMatch(/^Undid: .* \(1 file stays in the system Trash\)$/);
      expect(result.trashNotRestored).toBe(1);
      expect(result.successCount).toBe(1);
      expect(result.failCount).toBe(0);
      await expect(fs.access(src)).resolves.toBeUndefined();
    });
  });
});
