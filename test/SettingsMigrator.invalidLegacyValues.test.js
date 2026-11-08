/**
 * A legacy settings.json can hold a value an older build accepted but the
 * current validation rules reject (e.g. maxConcurrentAnalysis above today's
 * cap, or a string-typed confidenceThreshold). The schema migration must
 * still run: rename llama-prefixed model keys, stamp the schema version,
 * and drop or coerce only the out-of-range value, instead of failing the
 * whole migration on every launch.
 *
 * Real SettingsService + SettingsMigrator + SettingsBackupService over the
 * memfs-backed fs from test/test-setup.js.
 */

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/settings-migration-userdata'),
    getVersion: jest.fn(() => '4.0.0')
  }
}));

jest.mock('../src/shared/logger', () => {
  const make = () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  });
  return { logger: make(), createLogger: () => make() };
});

jest.mock('../src/main/ipc/ipcWrappers', () => ({ safeSend: jest.fn() }));

// The transactional writer depends on fsync/rename details memfs does not
// model; plain writes are enough to observe what ends up on disk.
jest.mock('../src/shared/atomicFileOperations', () => {
  const write = async (filePath, content) => {
    await require('fs').promises.writeFile(filePath, content, 'utf8');
  };
  return {
    atomicFileOps: { safeWriteFile: write },
    backupAndReplace: async (filePath, content) => {
      await write(filePath, content);
      return { success: true };
    }
  };
});

const fsSync = require('fs');
const path = require('path');

const USER_DATA = '/settings-migration-userdata';
const SETTINGS_PATH = path.join(USER_DATA, 'settings.json');

function loadSettingsService() {
  const SettingsService = require('../src/main/services/SettingsService');
  jest.spyOn(SettingsService.prototype, '_startFileWatcher').mockImplementation(() => {});
  return SettingsService;
}

describe('settings schema migration with now-invalid legacy values', () => {
  let service;

  beforeEach(() => {
    try {
      fsSync.rmSync(USER_DATA, { recursive: true, force: true });
    } catch {
      // first run
    }
    fsSync.mkdirSync(USER_DATA, { recursive: true });
  });

  afterEach(async () => {
    if (service) await service.shutdown?.();
    service = null;
    jest.restoreAllMocks();
  });

  test('an out-of-range legacy value does not block the key renames or the version stamp', async () => {
    fsSync.writeFileSync(
      SETTINGS_PATH,
      JSON.stringify({ llamaTextModel: 'my-model.gguf', maxConcurrentAnalysis: 16 }),
      'utf8'
    );
    const SettingsService = loadSettingsService();
    service = new SettingsService();

    const loaded = await service.load();

    expect(service._migrationAttempts).toBe(0);
    expect(service._migrationChecked).toBe(true);
    expect(loaded.textModel).toBe('my-model.gguf');

    const onDisk = JSON.parse(fsSync.readFileSync(SETTINGS_PATH, 'utf8'));
    expect(onDisk.textModel).toBe('my-model.gguf');
    expect(onDisk.llamaTextModel).toBeUndefined();
    expect(onDisk.settingsSchemaVersion).toBe(3);
    expect(onDisk.maxConcurrentAnalysis).not.toBe(16);
  });

  test('a string-typed confidenceThreshold is coerced rather than failing the migration', async () => {
    fsSync.writeFileSync(
      SETTINGS_PATH,
      JSON.stringify({ llamaTextModel: 'my-model.gguf', confidenceThreshold: '0.4' }),
      'utf8'
    );
    const SettingsService = loadSettingsService();
    service = new SettingsService();

    const loaded = await service.load();

    expect(service._migrationChecked).toBe(true);
    expect(service._migrationAttempts).toBe(0);
    expect(loaded.textModel).toBe('my-model.gguf');
    expect(loaded.confidenceThreshold).toBe(0.4);
    const onDisk = JSON.parse(fsSync.readFileSync(SETTINGS_PATH, 'utf8'));
    expect(onDisk.settingsSchemaVersion).toBe(3);
  });
});
