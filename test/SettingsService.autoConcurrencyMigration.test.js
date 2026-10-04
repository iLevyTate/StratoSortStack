/**
 * v2.0.9 -> v3 settings migration: autoConcurrency.
 *
 * v3 introduced `autoConcurrency: true` as the default. Users who tuned
 * `maxConcurrentAnalysis` in v2.0.9 expect that explicit limit to keep
 * working after upgrade. Without a migration the v2-shape settings.json
 * (no `autoConcurrency` key, has `maxConcurrentAnalysis`) silently
 * inherits the new auto default and the user's manual cap is ignored.
 *
 * The fix lives in `_hydrateLoadedSettings`: when the persisted file
 * carries maxConcurrentAnalysis but no autoConcurrency, set
 * autoConcurrency=false at hydration time AND mutate the source object
 * so it persists on next save.
 */

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => 'C:\\user-data')
  }
}));

jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    mkdir: jest.fn(),
    readdir: jest.fn(),
    stat: jest.fn(),
    unlink: jest.fn(),
    rename: jest.fn()
  },
  watch: jest.fn(),
  existsSync: jest.fn(() => true)
}));

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

jest.mock('../src/main/services/SettingsBackupService', () => ({
  SettingsBackupService: jest.fn().mockImplementation(() => ({
    listBackups: jest.fn().mockResolvedValue([]),
    restoreFromBackup: jest.fn()
  }))
}));

jest.mock('../src/main/ipc/ipcWrappers', () => ({ safeSend: jest.fn() }));

function loadService() {
  jest.resetModules();
  const SettingsService = require('../src/main/services/SettingsService');
  jest.spyOn(SettingsService.prototype, '_startFileWatcher').mockImplementation(() => {});
  return SettingsService;
}

describe('SettingsService autoConcurrency migration (v2.0.9 -> v3)', () => {
  test('preserves manual maxConcurrentAnalysis by setting autoConcurrency=false on a v2-shape file', () => {
    const SettingsService = loadService();
    const service = new SettingsService();

    // v2.0.9-shape persisted settings: no `autoConcurrency`, has a manual
    // cap that differs from the default (a value equal to the default is
    // one the app wrote, not the user; see the load-level tests below).
    const sourceSettings = {
      maxConcurrentAnalysis: 2
      // (no autoConcurrency key — v2 didn't have it)
    };
    const merged = { ...service.defaults, ...sourceSettings };

    const hydrated = service._hydrateLoadedSettings(merged, sourceSettings);

    expect(hydrated.autoConcurrency).toBe(false);
    expect(hydrated.maxConcurrentAnalysis).toBe(2);
    // Source mutated so the migration sticks on the next save.
    expect(sourceSettings.autoConcurrency).toBe(false);
  });

  test('does not flip autoConcurrency when the user has explicitly persisted true', () => {
    const SettingsService = loadService();
    const service = new SettingsService();

    const sourceSettings = {
      autoConcurrency: true,
      maxConcurrentAnalysis: 4
    };
    const merged = { ...service.defaults, ...sourceSettings };

    const hydrated = service._hydrateLoadedSettings(merged, sourceSettings);

    expect(hydrated.autoConcurrency).toBe(true);
    expect(sourceSettings.autoConcurrency).toBe(true);
  });

  test('does not flip autoConcurrency when neither key is persisted (fresh install)', () => {
    const SettingsService = loadService();
    const service = new SettingsService();

    const sourceSettings = {}; // brand new install: defaults apply
    const merged = { ...service.defaults, ...sourceSettings };

    const hydrated = service._hydrateLoadedSettings(merged, sourceSettings);

    // Default autoConcurrency: true (from DEFAULT_SETTINGS) is preserved.
    expect(hydrated.autoConcurrency).toBe(true);
    // We did NOT add an autoConcurrency key to sourceSettings — fresh
    // install settings.json stays minimal.
    expect(Object.prototype.hasOwnProperty.call(sourceSettings, 'autoConcurrency')).toBe(false);
  });

  test('honours an explicit autoConcurrency=false even when maxConcurrentAnalysis is also present', () => {
    const SettingsService = loadService();
    const service = new SettingsService();

    const sourceSettings = {
      autoConcurrency: false,
      maxConcurrentAnalysis: 6
    };
    const merged = { ...service.defaults, ...sourceSettings };

    const hydrated = service._hydrateLoadedSettings(merged, sourceSettings);

    expect(hydrated.autoConcurrency).toBe(false);
    expect(hydrated.maxConcurrentAnalysis).toBe(6);
  });
});

describe('SettingsService autoConcurrency migration — load level (ST-02)', () => {
  // Every save used to write the whole merged settings object, so a
  // pre-v3 file carries `maxConcurrentAnalysis: 1` (the default) whether or
  // not the user ever touched it. The v2-shape check then pinned every such
  // upgrade to autoConcurrency=false. Reading the file now drops values
  // equal to the default first, so only a real manual cap triggers the pin.
  test('a v2 file holding the default cap is not pinned to manual concurrency', () => {
    const SettingsService = loadService();
    const service = new SettingsService();
    const { DEFAULT_SETTINGS } = require('../src/shared/defaultSettings');

    const effective = service._normalizeParsedSettings({
      maxConcurrentAnalysis: DEFAULT_SETTINGS.maxConcurrentAnalysis,
      confidenceThreshold: 0.75
    });

    expect(effective.autoConcurrency).toBe(true);
    expect(effective.maxConcurrentAnalysis).toBe(DEFAULT_SETTINGS.maxConcurrentAnalysis);
  });

  test('a v2 file holding a manual cap is still pinned', () => {
    const SettingsService = loadService();
    const service = new SettingsService();

    const effective = service._normalizeParsedSettings({ maxConcurrentAnalysis: 3 });

    expect(effective.autoConcurrency).toBe(false);
    expect(effective.maxConcurrentAnalysis).toBe(3);
  });

  test('an explicit autoConcurrency survives the default strip', () => {
    const SettingsService = loadService();
    const service = new SettingsService();

    const effective = service._normalizeParsedSettings({
      autoConcurrency: true,
      maxConcurrentAnalysis: 3
    });

    expect(effective.autoConcurrency).toBe(true);
    expect(effective.maxConcurrentAnalysis).toBe(3);
  });
});
