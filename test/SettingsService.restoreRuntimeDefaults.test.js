/**
 * Restoring a backup (from Settings, or by auto-recovery after a corrupt
 * settings.json) writes the same on-disk shape as save(): the user's values
 * only. The backup's settings come from load(), which fills in this
 * machine's resolved Documents folder, so a restore used to persist that
 * path as if the user had chosen it, and it outlived a Documents move.
 * Auto-recovery wrote the full merged object, stamping every default.
 */

// The Documents folder in this platform's own form, as Electron reports it.
// A Windows path on Linux is not an absolute path there, so the settings
// sanitizer drops it and the recovered location comes back undefined.
const mockDocumentsDir =
  process.platform === 'win32' ? 'C:\\Users\\a-user\\Documents' : '/home/a-user/Documents';

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn((name) => (name === 'documents' ? mockDocumentsDir : 'C:\\user-data'))
  }
}));

const mockFiles = new Map();
jest.mock('fs', () => {
  const notFound = (/** @type {string} */ p) =>
    Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return {
    promises: {
      readFile: jest.fn(async (p) => {
        if (!mockFiles.has(p)) throw notFound(p);
        return mockFiles.get(p);
      }),
      writeFile: jest.fn(async (p, data) => {
        mockFiles.set(p, String(data));
      }),
      mkdir: jest.fn().mockResolvedValue(undefined),
      readdir: jest.fn().mockResolvedValue([]),
      stat: jest.fn(),
      lstat: jest.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
      unlink: jest.fn().mockResolvedValue(undefined),
      rename: jest.fn().mockResolvedValue(undefined),
      access: jest.fn().mockResolvedValue(undefined)
    },
    watch: jest.fn(),
    existsSync: jest.fn(() => true)
  };
});

jest.mock('../src/shared/atomicFileOperations', () => ({
  backupAndReplace: jest.fn(async (p, data) => {
    mockFiles.set(p, String(data));
    return { success: true };
  })
}));

jest.mock('../src/shared/logger', () => {
  const l = () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  });
  return { logger: l(), createLogger: l };
});

// What the backup service hands the apply callback: the backup's settings
// merged over the full defaults, as the real SettingsBackupService does.
let mockRestoredSettings = null;
jest.mock('../src/main/services/SettingsBackupService', () => ({
  SettingsBackupService: jest.fn().mockImplementation(() => ({
    backupDir: 'C:\\user-data\\settings-backups',
    createBackup: jest.fn().mockResolvedValue({ success: true }),
    listBackups: jest
      .fn()
      .mockResolvedValue([
        { filename: 'b1.json', path: 'C:\\user-data\\settings-backups\\b1.json' }
      ]),
    restoreFromBackup: jest.fn(async (_backupPath, apply) => {
      try {
        await apply(mockRestoredSettings);
        return { success: true, settings: mockRestoredSettings };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }),
    deleteBackup: jest.fn()
  }))
}));

jest.mock('../src/main/ipc/ipcWrappers', () => ({ safeSend: jest.fn() }));

const path = require('path');
const { DEFAULT_SETTINGS } = require('../src/shared/defaultSettings');

function loadService() {
  jest.resetModules();
  const SettingsService = require('../src/main/services/SettingsService');
  jest.spyOn(SettingsService.prototype, '_startFileWatcher').mockImplementation(() => {});
  const service = new SettingsService();
  service._migrationChecked = true;
  return service;
}

const readPersisted = (service) => JSON.parse(mockFiles.get(service.settingsPath));

describe('SettingsService restore writes user values only', () => {
  beforeEach(() => {
    mockFiles.clear();
  });

  test('restoreFromBackup does not persist the resolved Documents path', async () => {
    const service = loadService();
    const runtimeDocuments = service.defaults.defaultSmartFolderLocation;
    // The resolved path, not the literal the shared strip knows about.
    expect(runtimeDocuments).not.toBe(DEFAULT_SETTINGS.defaultSmartFolderLocation);
    mockRestoredSettings = { ...service.defaults, confidenceThreshold: 0.9 };

    const result = await service.restoreFromBackup(path.join(service.backupDir, 'b1.json'));

    expect(result.success).toBe(true);
    const persisted = readPersisted(service);
    expect(persisted).not.toHaveProperty('defaultSmartFolderLocation');
    expect(persisted.confidenceThreshold).toBe(0.9);
    // The in-memory settings stay complete.
    expect(service._cache.defaultSmartFolderLocation).toBe(runtimeDocuments);
  });

  test('restoreFromBackup keeps a location the user chose', async () => {
    const service = loadService();
    mockRestoredSettings = {
      ...service.defaults,
      defaultSmartFolderLocation: 'D:\\Sorted'
    };

    await service.restoreFromBackup(path.join(service.backupDir, 'b1.json'));

    expect(readPersisted(service).defaultSmartFolderLocation).toBe('D:\\Sorted');
  });

  test('auto-recovery writes only user values and keeps the backup schema stamp', async () => {
    const service = loadService();
    mockRestoredSettings = {
      ...service.defaults,
      confidenceThreshold: 0.9,
      // Restore sets an older stamp so migrations re-run; it must survive.
      settingsSchemaVersion: 1
    };

    const recovered = await service._attemptAutoRecovery();

    expect(recovered).toBeTruthy();
    const persisted = readPersisted(service);
    expect(persisted).not.toHaveProperty('defaultSmartFolderLocation');
    expect(persisted).not.toHaveProperty('notifications');
    expect(persisted).not.toHaveProperty('workflowRestoreMaxAge');
    expect(persisted.confidenceThreshold).toBe(0.9);
    expect(persisted.settingsSchemaVersion).toBe(1);
    expect(recovered.defaultSmartFolderLocation).toBe(service.defaults.defaultSmartFolderLocation);
  });
});
