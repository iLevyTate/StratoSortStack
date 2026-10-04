jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => 'C:\\fake-user-data')
  },
  BrowserWindow: {
    getAllWindows: jest.fn(() => [])
  }
}));

jest.mock('../src/shared/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  },
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  }))
}));

jest.mock('../src/shared/errorClassifier', () => ({
  isNotFoundError: jest.fn()
}));

jest.mock('../src/shared/settingsValidation', () => ({
  validateSettings: jest.fn(),
  sanitizeSettings: jest.fn((settings) => settings)
}));

jest.mock('../src/shared/defaultSettings', () => ({
  // Identity: these tests assert on effective settings, not the on-disk subset.
  stripDefaultValues: (settings) => ({ ...(settings || {}) }),
  DEFAULT_SETTINGS: {
    confidenceThreshold: 0.5,
    theme: 'light',
    experienceMode: 'simple',
    defaultEmbeddingPolicy: 'embed',
    embeddingTiming: 'during_analysis',
    autoChunkOnAnalysis: true,
    graphExpansionEnabled: true,
    chunkContextEnabled: true,
    developerGraphEnabled: true
  },
  mergeWithDefaults: jest.fn((settings) => ({
    confidenceThreshold: 0.5,
    theme: 'light',
    experienceMode: 'simple',
    defaultEmbeddingPolicy: 'embed',
    embeddingTiming: 'during_analysis',
    autoChunkOnAnalysis: true,
    graphExpansionEnabled: true,
    chunkContextEnabled: true,
    developerGraphEnabled: true,
    ...settings
  }))
}));

jest.mock('../src/shared/atomicFileOperations', () => ({
  backupAndReplace: jest.fn()
}));

jest.mock('../src/shared/singletonFactory', () => ({
  createSingletonHelpers: jest.fn(() => ({
    getInstance: jest.fn(),
    createInstance: jest.fn(),
    registerWithContainer: jest.fn(),
    resetInstance: jest.fn()
  }))
}));

jest.mock('../src/shared/performanceConstants', () => ({
  LIMITS: {
    MAX_SETTINGS_BACKUPS: 3,
    MAX_WATCHER_RESTARTS: 2,
    WATCHER_RESTART_WINDOW: 10_000
  },
  DEBOUNCE: {
    SETTINGS_SAVE: 5,
    WATCHER_RESTART_BASE: 100
  },
  TIMEOUTS: {
    SERVICE_STARTUP: 250
  },
  RETRY: {
    MAX_ATTEMPTS_MEDIUM: 3,
    MAX_ATTEMPTS_HIGH: 5,
    SETTINGS_BACKUP: { initialDelay: 10 },
    SETTINGS_SAVE: { initialDelay: 10 }
  }
}));

jest.mock('../src/main/services/SettingsBackupService', () => ({
  SettingsBackupService: jest.fn().mockImplementation(() => ({
    createBackup: jest.fn(),
    listBackups: jest.fn(),
    restoreFromBackup: jest.fn(),
    cleanupOldBackups: jest.fn(),
    deleteBackup: jest.fn(),
    backupDir: 'C:\\fake-user-data\\settings-backups'
  }))
}));

jest.mock('../src/main/ipc/ipcWrappers', () => ({
  safeSend: jest.fn()
}));

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { isNotFoundError } = require('../src/shared/errorClassifier');
const { validateSettings } = require('../src/shared/settingsValidation');
const { backupAndReplace } = require('../src/shared/atomicFileOperations');
const { SettingsBackupService } = require('../src/main/services/SettingsBackupService');

jest.spyOn(fsSync, 'watch').mockImplementation(() => ({
  on: jest.fn(),
  close: jest.fn()
}));

jest.spyOn(fs, 'mkdir').mockResolvedValue();
jest.spyOn(fs, 'access').mockResolvedValue();
jest.spyOn(fs, 'writeFile').mockResolvedValue();
jest.spyOn(fs, 'readFile').mockResolvedValue('{"confidenceThreshold":0.4,"theme":"dark"}');

const SettingsService = require('../src/main/services/SettingsService');

describe('SettingsService', () => {
  let service;

  beforeEach(() => {
    jest.useFakeTimers();
    isNotFoundError.mockReset();
    validateSettings.mockReset();
    backupAndReplace.mockReset();
    SettingsBackupService.mockClear();
    service = new SettingsService();
  });

  afterEach(async () => {
    if (service) {
      await service.shutdown();
    }
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  test('load returns defaults when settings file missing', async () => {
    // Two reads happen on first load: SettingsMigrator reads the raw file
    // (to decide whether migration is needed) and _loadRaw reads it again.
    const enoent = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
    fs.readFile.mockRejectedValueOnce(enoent()).mockRejectedValueOnce(enoent());
    isNotFoundError.mockReturnValue(true);

    const settings = await service.load();
    // _buildRuntimeDefaults adds defaultSmartFolderLocation from app.getPath('documents').
    // Post-2026-04: Simple mode keeps embedding/graph features ENABLED in the
    // background (no longer downgrades to skip/manual/false), so a future
    // Advanced switch doesn't require reprocessing every file.
    expect(settings).toEqual(
      expect.objectContaining({
        confidenceThreshold: 0.5,
        theme: 'light',
        experienceMode: 'simple',
        defaultSmartFolderLocation: 'C:\\fake-user-data',
        defaultEmbeddingPolicy: 'embed',
        embeddingTiming: 'during_analysis',
        autoChunkOnAnalysis: true,
        graphExpansionEnabled: true,
        chunkContextEnabled: true,
        developerGraphEnabled: true
      })
    );
  });

  test('load backfills legacy settings without experienceMode to advanced', async () => {
    service._migrationChecked = true;
    fs.readFile.mockResolvedValueOnce('{"confidenceThreshold":0.4,"theme":"dark"}');

    const settings = await service.load();

    expect(settings).toEqual(
      expect.objectContaining({
        confidenceThreshold: 0.4,
        theme: 'dark',
        experienceMode: 'advanced'
      })
    );
  });

  test('load uses cache within TTL', async () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(1500);
    service._migrationChecked = true;
    const first = await service.load();
    const second = await service.load();
    expect(first).toEqual(second);
    expect(fs.readFile).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });

  test('save rejects invalid settings', async () => {
    validateSettings.mockReturnValue({
      valid: false,
      errors: ['invalid'],
      warnings: []
    });

    await expect(service.save({ theme: 'light' })).rejects.toThrow('Invalid settings provided');
    expect(backupAndReplace).not.toHaveBeenCalled();
  });

  test('save persists merged settings and returns backup info', async () => {
    validateSettings.mockReturnValue({ valid: true, errors: [], warnings: [] });
    const backupServiceInstance = SettingsBackupService.mock.results[0].value;
    backupServiceInstance.createBackup.mockResolvedValue({
      success: true,
      path: 'C:\\fake-user-data\\settings-backups\\backup.json'
    });
    backupAndReplace.mockResolvedValue({ success: true });

    const result = await service.save({ confidenceThreshold: 0.9 });
    expect(result.settings.confidenceThreshold).toBe(0.9);
    expect(result.backupCreated).toBe(true);
    expect(result.backupPath).toContain('settings-backups');
  });

  test('save in simple mode keeps embedding/graph features ENABLED (background processing)', async () => {
    // Post-2026-04: Simple mode no longer downgrades feature flags. The user
    // gets background embedding so a future Advanced switch doesn't require
    // reprocessing every file.
    validateSettings.mockReturnValue({ valid: true, errors: [], warnings: [] });
    const backupServiceInstance = SettingsBackupService.mock.results[0].value;
    backupServiceInstance.createBackup.mockResolvedValue({
      success: true,
      path: 'C:\\fake-user-data\\settings-backups\\backup.json'
    });
    backupAndReplace.mockResolvedValue({ success: true });
    service._loadRaw = jest.fn().mockResolvedValue({
      confidenceThreshold: 0.5,
      experienceMode: 'advanced',
      defaultEmbeddingPolicy: 'embed',
      embeddingTiming: 'during_analysis',
      autoChunkOnAnalysis: true,
      graphExpansionEnabled: true,
      chunkContextEnabled: true,
      developerGraphEnabled: true
    });

    const result = await service.save({
      experienceMode: 'simple',
      defaultEmbeddingPolicy: 'embed',
      embeddingTiming: 'during_analysis',
      autoChunkOnAnalysis: true,
      graphExpansionEnabled: true,
      chunkContextEnabled: true,
      developerGraphEnabled: true
    });

    expect(result.settings).toEqual(
      expect.objectContaining({
        experienceMode: 'simple',
        defaultEmbeddingPolicy: 'embed',
        embeddingTiming: 'during_analysis',
        autoChunkOnAnalysis: true,
        graphExpansionEnabled: true,
        chunkContextEnabled: true,
        developerGraphEnabled: true
      })
    );
  });

  test('save with advanced preserves deliberate skip/manual/false choices', async () => {
    // Regression guard for the "five settings impossible to turn off" bug:
    // the legacy pre-2026-04 value flip used to run inside every save,
    // silently reverting deliberate Advanced-mode choices of 'skip' /
    // 'manual' / false. That flip is now a one-time SettingsMigrator step
    // (schema v3), so a save must persist these values untouched.
    validateSettings.mockReturnValue({ valid: true, errors: [], warnings: [] });
    const backupServiceInstance = SettingsBackupService.mock.results[0].value;
    backupServiceInstance.createBackup.mockResolvedValue({
      success: true,
      path: 'C:\\fake-user-data\\settings-backups\\backup.json'
    });
    backupAndReplace.mockResolvedValue({ success: true });
    service._loadRaw = jest.fn().mockResolvedValue({
      confidenceThreshold: 0.5,
      experienceMode: 'simple',
      defaultEmbeddingPolicy: 'skip',
      embeddingTiming: 'manual',
      autoChunkOnAnalysis: false,
      graphExpansionEnabled: false,
      chunkContextEnabled: false,
      developerGraphEnabled: true
    });

    const result = await service.save({
      experienceMode: 'advanced',
      defaultEmbeddingPolicy: 'skip',
      embeddingTiming: 'manual',
      autoChunkOnAnalysis: false,
      graphExpansionEnabled: false,
      chunkContextEnabled: false,
      developerGraphEnabled: true
    });

    expect(result.settings).toEqual(
      expect.objectContaining({
        experienceMode: 'advanced',
        defaultEmbeddingPolicy: 'skip',
        embeddingTiming: 'manual',
        autoChunkOnAnalysis: false,
        graphExpansionEnabled: false,
        chunkContextEnabled: false
      })
    );
  });

  test('restoreFromBackup rejects invalid path input', async () => {
    const result = await service.restoreFromBackup(null);
    expect(result).toEqual({ success: false, error: 'Invalid backup path provided' });
  });

  test('restoreFromBackup rejects path traversal outside backup dir', async () => {
    await expect(
      service.restoreFromBackup(path.join('C:\\', 'outside', 'backup.json'))
    ).rejects.toThrow('outside backup directory');
  });

  test('handleExternalFileChange handles missing file', async () => {
    service._notifySettingsChanged = jest.fn();
    service._externalChangeMaxRetries = 1;
    fs.access.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    isNotFoundError.mockReturnValue(true);

    await service._handleExternalFileChange('change', 'settings.json');
    expect(service._notifySettingsChanged).toHaveBeenCalled();
  });

  test('handleExternalFileChange propagates through external settings callback when available', async () => {
    const onExternalSettingsChanged = jest.fn().mockResolvedValue(undefined);
    service.setExternalSettingsChangedHandler(onExternalSettingsChanged);
    service._notifySettingsChanged = jest.fn();
    service.load = jest.fn().mockResolvedValue({
      confidenceThreshold: 0.4,
      theme: 'dark'
    });
    fs.access.mockResolvedValue(undefined);

    await service._handleExternalFileChange('rename', 'settings.json');

    expect(onExternalSettingsChanged).toHaveBeenCalledWith(
      expect.objectContaining({ theme: 'dark' }),
      expect.objectContaining({
        source: 'external-file',
        eventType: 'rename',
        filename: 'settings.json'
      })
    );
    expect(service._notifySettingsChanged).not.toHaveBeenCalled();
  });

  test('handleExternalFileChange falls back to renderer notification when callback fails', async () => {
    const onExternalSettingsChanged = jest.fn().mockRejectedValue(new Error('callback failed'));
    service.setExternalSettingsChangedHandler(onExternalSettingsChanged);
    service._notifySettingsChanged = jest.fn().mockResolvedValue(undefined);
    service.load = jest.fn().mockResolvedValue({
      confidenceThreshold: 0.5,
      theme: 'light'
    });
    fs.access.mockResolvedValue(undefined);

    await service._handleExternalFileChange('change', 'settings.json');

    expect(onExternalSettingsChanged).toHaveBeenCalled();
    expect(service._notifySettingsChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ theme: 'light' }),
        source: 'external-file'
      })
    );
  });
});
