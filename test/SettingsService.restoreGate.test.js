/**
 * SettingsService.restoreFromBackup runs the caller's `beforeWrite` on the
 * merged settings before the file is written. What it returns is what lands
 * on disk; a throw leaves the current settings untouched.
 */

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => 'C:\\user-data')
  }
}));

jest.mock('fs', () => {
  const promises = {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    mkdir: jest.fn(),
    readdir: jest.fn(),
    stat: jest.fn(),
    lstat: jest.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    unlink: jest.fn(),
    rename: jest.fn()
  };
  return {
    promises,
    watch: jest.fn(),
    existsSync: jest.fn(() => true)
  };
});

jest.mock('../src/shared/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  },
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  })
}));

const mockBackupAndReplace = jest.fn().mockResolvedValue({ success: true });
jest.mock('../src/shared/atomicFileOperations', () => ({
  backupAndReplace: (...args) => mockBackupAndReplace(...args)
}));

jest.mock('../src/main/services/SettingsBackupService', () => ({
  SettingsBackupService: jest.fn().mockImplementation(() => ({
    backupDir: 'C:\\user-data\\settings-backups',
    listBackups: jest.fn().mockResolvedValue([]),
    // Mirrors the real service: the apply callback writes, and a throw from
    // it becomes a failed result rather than an exception.
    restoreFromBackup: jest.fn(async (_backupPath, apply) => {
      try {
        const settings = await apply({ confidenceThreshold: 0.9, language: 'en' });
        return { success: true, settings };
      } catch (err) {
        return { success: false, error: err.message };
      }
    })
  }))
}));

jest.mock('../src/main/ipc/ipcWrappers', () => ({
  safeSend: jest.fn()
}));

const path = require('path');

describe('SettingsService.restoreFromBackup beforeWrite', () => {
  function makeService() {
    jest.resetModules();
    const SettingsService = require('../src/main/services/SettingsService');
    jest.spyOn(SettingsService.prototype, '_startFileWatcher').mockImplementation(() => {});
    return new SettingsService();
  }

  beforeEach(() => {
    mockBackupAndReplace.mockClear();
  });

  test('what beforeWrite returns is what is written and cached', async () => {
    const service = makeService();
    const backupPath = path.join(service.backupDir, 'b1.json');
    const beforeWrite = jest.fn(async (merged) => ({ ...merged, language: 'fr' }));

    const result = await service.restoreFromBackup(backupPath, { beforeWrite });

    expect(result.success).toBe(true);
    expect(beforeWrite).toHaveBeenCalledWith(
      expect.objectContaining({ confidenceThreshold: 0.9, language: 'en' })
    );
    expect(mockBackupAndReplace).toHaveBeenCalledTimes(1);
    const written = JSON.parse(mockBackupAndReplace.mock.calls[0][1]);
    expect(written.language).toBe('fr');
    expect(service._cache).toEqual(expect.objectContaining({ language: 'fr' }));
  });

  test('a throwing beforeWrite writes nothing and fails the restore', async () => {
    const service = makeService();
    const backupPath = path.join(service.backupDir, 'b1.json');
    const cacheBefore = service._cache;

    const result = await service.restoreFromBackup(backupPath, {
      beforeWrite: async () => {
        throw new Error('CONSENT_REQUIRED');
      }
    });

    expect(result).toEqual({ success: false, error: 'CONSENT_REQUIRED' });
    expect(mockBackupAndReplace).not.toHaveBeenCalled();
    expect(service._cache).toBe(cacheBefore);
  });

  test('without beforeWrite the merged settings are written as they are', async () => {
    const service = makeService();
    const backupPath = path.join(service.backupDir, 'b1.json');

    const result = await service.restoreFromBackup(backupPath);

    expect(result.success).toBe(true);
    const written = JSON.parse(mockBackupAndReplace.mock.calls[0][1]);
    expect(written.language).toBe('en');
  });
});
