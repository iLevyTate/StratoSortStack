/**
 * @jest-environment node
 *
 * UndoRedoService — backup sweep while the live history is shielded.
 *
 * When undo-actions.json cannot be read AND cannot be renamed or copied
 * aside, loadActions leaves it in place and starts an empty in-memory
 * history. Every backup that file names is then unreferenced from the
 * sweep's point of view, so cleanupOldBackups must stand down until the
 * file has been set aside and its references can be read again.
 *
 * The same holds when the rename succeeds but the set-aside copy is still
 * unreadable (a read-denying ACL, a share-delete-only hold, a bad sector all
 * survive a rename): the sweep stands down until that copy has been read.
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
    copyFile: jest.fn().mockResolvedValue(),
    mkdir: jest.fn().mockResolvedValue(),
    unlink: jest.fn().mockResolvedValue(),
    access: jest.fn().mockResolvedValue(),
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

jest.mock('../src/shared/atomicFileOperations', () => ({
  crossDeviceMove: jest.fn().mockResolvedValue(),
  durableWriteJson: jest.fn().mockResolvedValue()
}));

jest.mock('../src/shared/pathSanitization', () => ({
  validateFileOperationPath: jest.fn(async (candidate) => ({
    valid: true,
    normalizedPath: String(candidate)
  }))
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

const path = require('path');
const fs = require('fs').promises;
const UndoRedoService = require('../src/main/services/UndoRedoService');
const { durableWriteJson } = require('../src/shared/atomicFileOperations');
const { getInstance } = require('../src/main/services/DegradedStateTracker');

const DAY_MS = 24 * 60 * 60 * 1000;

describe('UndoRedoService - backup sweep with a shielded history', () => {
  let service;
  let backupDir;
  let historyDir;
  let namedByHistory;
  let trueOrphan;
  let busy;

  beforeEach(() => {
    jest.clearAllMocks();
    getInstance().clear('undo.history-unreadable');

    service = new UndoRedoService({ saveDebounceMs: 0, historyReadRetryDelaysMs: [0, 0] });
    backupDir = path.join(service.userDataPath, 'undo-backups');
    historyDir = path.dirname(service.actionsPath);
    const twoDaysAgo = Date.now() - 2 * DAY_MS;
    namedByHistory = `${twoDaysAgo}_aaaa_report.docx`;
    trueOrphan = `${twoDaysAgo}_bbbb_orphan.txt`;

    // A scanner holds undo-actions.json without share-read or share-delete:
    // the read, the rename and the copy all fail for the whole retry window.
    busy = new Error('EBUSY: resource busy or locked');
    busy.code = 'EBUSY';
    fs.readFile.mockRejectedValue(busy);
    fs.rename.mockRejectedValue(busy);
    fs.copyFile.mockRejectedValue(busy);

    // Backup dir exists and holds a two-day-old backup the (unreadable)
    // history references, plus a genuinely abandoned one of the same age.
    fs.access.mockResolvedValue();
    fs.readdir.mockImplementation(async (dir) => {
      if (dir === backupDir) return [namedByHistory, trueOrphan];
      if (dir === historyDir) return ['undo-actions.json'];
      return [];
    });
  });

  afterEach(() => {
    getInstance().clear('undo.history-unreadable');
  });

  test('startup does not reap the backups an unreadable, still-in-place history references', async () => {
    await service.initialize();
    // initialize() fires the sweep without awaiting it; let it settle.
    await new Promise((resolve) => setImmediate(resolve));

    expect(service.actions).toEqual([]);
    expect(service._shieldedHistoryPath).toMatch(/undo-actions\.json\.unreadable\.\d+$/);
    expect(durableWriteJson).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  test('cleanupOldBackups stands down while shielded and sweeps again once the file is set aside', async () => {
    await service.loadActions();
    expect(service._shieldedHistoryPath).toBeTruthy();

    const shielded = await service.cleanupOldBackups();

    expect(shielded).toMatchObject({ removed: 0, errors: 0 });
    expect(fs.unlink).not.toHaveBeenCalled();

    // The hold clears: the next save moves the file aside under the
    // quarantine name, and that file is what the sweep reads from now on.
    const quarantinePath = service._shieldedHistoryPath;
    fs.rename.mockResolvedValue();
    fs.readFile.mockImplementation(async (file) => {
      if (file === quarantinePath) {
        return JSON.stringify({
          actions: [
            { type: 'FILE_DELETE', data: { backupPath: path.join(backupDir, namedByHistory) } }
          ]
        });
      }
      throw busy;
    });
    fs.readdir.mockImplementation(async (dir) => {
      if (dir === backupDir) return [namedByHistory, trueOrphan];
      if (dir === historyDir) return ['undo-actions.json', path.basename(quarantinePath)];
      return [];
    });
    service.initialized = true;
    await service.recordAction('FILE_MOVE', { originalPath: '/a', newPath: '/b' });
    expect(service._shieldedHistoryPath).toBeNull();
    expect(durableWriteJson).toHaveBeenCalledTimes(1);

    const released = await service.cleanupOldBackups();

    expect(released.removed).toBe(1);
    expect(fs.unlink).toHaveBeenCalledTimes(1);
    expect(fs.unlink).toHaveBeenCalledWith(path.join(backupDir, trueOrphan));
  });

  describe('the rename succeeds but the set-aside copy is still unreadable', () => {
    let quarantineName;

    beforeEach(() => {
      // A read-denying ACL (or a hold that shares delete but not read):
      // the rename goes through, every read still fails. The quarantine
      // name shows up beside the fresh history, exactly as it would on disk.
      quarantineName = null;
      fs.rename.mockResolvedValue();
      fs.readdir.mockImplementation(async (dir) => {
        if (dir === backupDir) return [namedByHistory, trueOrphan];
        if (dir === historyDir) {
          return quarantineName ? ['undo-actions.json', quarantineName] : ['undo-actions.json'];
        }
        return [];
      });
    });

    test('startup does not reap the backups a moved-but-unreadable history references', async () => {
      await service.initialize();
      await new Promise((resolve) => setImmediate(resolve));

      expect(service.actions).toEqual([]);
      expect(service._shieldedHistoryPath).toBeNull();
      expect(durableWriteJson).toHaveBeenCalled();
      expect(fs.unlink).not.toHaveBeenCalled();
    });

    test('cleanupOldBackups stands down until the moved file reads, then sweeps with its references', async () => {
      await service.loadActions();
      const quarantinePath = service._unverifiedSetAsidePath;
      expect(quarantinePath).toMatch(/undo-actions\.json\.unreadable\.\d+$/);
      quarantineName = path.basename(quarantinePath);

      const stoodDown = await service.cleanupOldBackups();
      expect(stoodDown).toMatchObject({ removed: 0, errors: 0 });
      expect(fs.unlink).not.toHaveBeenCalled();
      expect(service._unverifiedSetAsidePath).toBe(quarantinePath);

      // The ACL is fixed: the set-aside copy reads and names its backup.
      fs.readFile.mockImplementation(async (file) => {
        if (file === quarantinePath) {
          return JSON.stringify({
            actions: [
              { type: 'FILE_DELETE', data: { backupPath: path.join(backupDir, namedByHistory) } }
            ]
          });
        }
        throw busy;
      });

      const swept = await service.cleanupOldBackups();

      expect(service._unverifiedSetAsidePath).toBeNull();
      expect(swept.removed).toBe(1);
      expect(fs.unlink).toHaveBeenCalledTimes(1);
      expect(fs.unlink).toHaveBeenCalledWith(path.join(backupDir, trueOrphan));
    });

    test('a set-aside copy that reads but does not parse keeps the sweep standing down', async () => {
      await service.loadActions();
      const quarantinePath = service._unverifiedSetAsidePath;
      quarantineName = path.basename(quarantinePath);
      fs.readFile.mockImplementation(async (file) => {
        if (file === quarantinePath) return '{"actions": [';
        throw busy;
      });

      const stoodDown = await service.cleanupOldBackups();

      expect(stoodDown).toMatchObject({ removed: 0, errors: 0 });
      expect(fs.unlink).not.toHaveBeenCalled();
      expect(service._unverifiedSetAsidePath).toBe(quarantinePath);
    });
  });
});
