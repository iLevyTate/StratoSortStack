/**
 * settings.json holds only what the user set (audit rows ST-02, ST-03, ST-08).
 *
 * Every save used to write the whole merged settings object, so a default
 * stamped by one build survived into every later build that changed it.
 * save() now strips values equal to a current or superseded default (except
 * the keys whose presence carries meaning), and every read path strips the
 * same way before merging over the current defaults. A Simple/Advanced switch
 * parks and restores the user's Advanced-only choices through the same save.
 */

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/user-data')
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

jest.mock('../src/main/services/SettingsBackupService', () => ({
  SettingsBackupService: jest.fn().mockImplementation(() => ({
    backupDir: '/user-data/settings-backups',
    createBackup: jest.fn().mockResolvedValue({ success: true, path: '/user-data/b.json' }),
    listBackups: jest.fn().mockResolvedValue([]),
    restoreFromBackup: jest.fn(),
    deleteBackup: jest.fn()
  }))
}));

jest.mock('../src/main/ipc/ipcWrappers', () => ({ safeSend: jest.fn() }));

const { DEFAULT_SETTINGS } = require('../src/shared/defaultSettings');
const { SIMPLE_MODE_ENFORCED_VALUES } = require('../src/shared/experienceMode');

function loadService() {
  jest.resetModules();
  const SettingsService = require('../src/main/services/SettingsService');
  jest.spyOn(SettingsService.prototype, '_startFileWatcher').mockImplementation(() => {});
  const service = new SettingsService();
  service._migrationChecked = true;
  return service;
}

const readPersisted = (service) => JSON.parse(mockFiles.get(service.settingsPath));

describe('SettingsService — settings.json holds user values only', () => {
  beforeEach(() => {
    mockFiles.clear();
  });

  test('save writes only the keys that differ from the defaults, plus the presence-bearing keys', async () => {
    const service = loadService();

    const result = await service.save({ confidenceThreshold: 0.9, notifications: true });

    const persisted = readPersisted(service);
    expect(persisted).toEqual({
      settingsSchemaVersion: DEFAULT_SETTINGS.settingsSchemaVersion,
      experienceMode: 'simple',
      autoConcurrency: true,
      confidenceThreshold: 0.9
    });
    // The runtime default resolves this machine's Documents folder; that is
    // a default too, so it is not written as a user value.
    expect(persisted).not.toHaveProperty('defaultSmartFolderLocation');
    expect(result.settings.defaultSmartFolderLocation).toBe(
      service.defaults.defaultSmartFolderLocation
    );
    expect(persisted).not.toHaveProperty('notifications');
    expect(persisted).not.toHaveProperty('workflowRestoreMaxAge');
    // Callers still get the complete settings object.
    expect(result.settings).toEqual(
      expect.objectContaining({
        confidenceThreshold: 0.9,
        notifications: true,
        workflowRestoreMaxAge: DEFAULT_SETTINGS.workflowRestoreMaxAge
      })
    );
    expect(service._cache).toEqual(expect.objectContaining({ confidenceThreshold: 0.9 }));
  });

  test('a value set back to the default disappears from the file', async () => {
    const service = loadService();
    await service.save({ confidenceThreshold: 0.9 });
    expect(readPersisted(service)).toHaveProperty('confidenceThreshold', 0.9);

    await service.save({ confidenceThreshold: DEFAULT_SETTINGS.confidenceThreshold });

    expect(readPersisted(service)).not.toHaveProperty('confidenceThreshold');
    expect((await service.load()).confidenceThreshold).toBe(DEFAULT_SETTINGS.confidenceThreshold);
  });

  test('a superseded default stamped by an earlier build is ignored on load and dropped on save (ST-03)', async () => {
    const service = loadService();
    mockFiles.set(
      service.settingsPath,
      JSON.stringify({
        settingsSchemaVersion: DEFAULT_SETTINGS.settingsSchemaVersion,
        experienceMode: 'advanced',
        workflowRestoreMaxAge: 60 * 60 * 1000,
        confidenceThreshold: 0.6
      })
    );

    const loaded = await service.load();
    expect(loaded.workflowRestoreMaxAge).toBe(24 * 60 * 60 * 1000);
    expect(loaded.confidenceThreshold).toBe(0.6);

    await service.save({ notifications: false });
    const persisted = readPersisted(service);
    expect(persisted).not.toHaveProperty('workflowRestoreMaxAge');
    expect(persisted).toEqual(
      expect.objectContaining({ confidenceThreshold: 0.6, notifications: false })
    );
  });

  test('a user-chosen non-default restore window is kept', async () => {
    const service = loadService();
    mockFiles.set(
      service.settingsPath,
      JSON.stringify({ experienceMode: 'advanced', workflowRestoreMaxAge: 2 * 60 * 60 * 1000 })
    );

    expect((await service.load()).workflowRestoreMaxAge).toBe(2 * 60 * 60 * 1000);
    await service.save({ notifications: false });
    expect(readPersisted(service).workflowRestoreMaxAge).toBe(2 * 60 * 60 * 1000);
  });

  test('a pre-v3 file holding the default concurrency cap is not pinned to manual (ST-02)', async () => {
    const service = loadService();
    mockFiles.set(
      service.settingsPath,
      JSON.stringify({
        experienceMode: 'advanced',
        maxConcurrentAnalysis: DEFAULT_SETTINGS.maxConcurrentAnalysis
      })
    );

    const loaded = await service.load();
    expect(loaded.autoConcurrency).toBe(true);

    await service.save({ notifications: false });
    const persisted = readPersisted(service);
    expect(persisted.autoConcurrency).toBe(true);
    expect(persisted).not.toHaveProperty('maxConcurrentAnalysis');
  });

  test('a file without experienceMode still hydrates as Advanced and then persists the mode', async () => {
    const service = loadService();
    mockFiles.set(service.settingsPath, JSON.stringify({ confidenceThreshold: 0.4 }));

    expect((await service.load()).experienceMode).toBe('advanced');
    await service.save({ notifications: false });
    expect(readPersisted(service).experienceMode).toBe('advanced');
  });

  describe('Simple/Advanced switch (ST-08)', () => {
    const advancedChoices = {
      experienceMode: 'advanced',
      defaultEmbeddingPolicy: 'skip',
      embeddingTiming: 'manual',
      autoChunkOnAnalysis: false
    };

    test('switching to Simple parks the Advanced choices and enforces the recommended values', async () => {
      const service = loadService();
      mockFiles.set(service.settingsPath, JSON.stringify(advancedChoices));

      // The renderer sends the enforced values along with the new mode.
      const result = await service.save({
        experienceMode: 'simple',
        ...SIMPLE_MODE_ENFORCED_VALUES
      });

      expect(result.settings).toMatchObject(SIMPLE_MODE_ENFORCED_VALUES);
      expect(result.settings.advancedModeValues).toEqual({
        defaultEmbeddingPolicy: 'skip',
        embeddingTiming: 'manual',
        autoChunkOnAnalysis: false
      });
      const persisted = readPersisted(service);
      expect(persisted.experienceMode).toBe('simple');
      expect(persisted.advancedModeValues).toEqual(result.settings.advancedModeValues);
      expect(persisted).not.toHaveProperty('defaultEmbeddingPolicy');
    });

    test('switching back to Advanced restores the parked choices and clears the stash', async () => {
      const service = loadService();
      mockFiles.set(service.settingsPath, JSON.stringify(advancedChoices));
      await service.save({ experienceMode: 'simple', ...SIMPLE_MODE_ENFORCED_VALUES });
      service.invalidateCache();

      const result = await service.save({
        experienceMode: 'advanced',
        ...SIMPLE_MODE_ENFORCED_VALUES
      });

      expect(result.settings.defaultEmbeddingPolicy).toBe('skip');
      expect(result.settings.embeddingTiming).toBe('manual');
      expect(result.settings.autoChunkOnAnalysis).toBe(false);
      expect(result.settings.graphExpansionEnabled).toBe(true);
      expect(result.settings.advancedModeValues).toBeNull();
      const persisted = readPersisted(service);
      expect(persisted).toEqual(
        expect.objectContaining({
          experienceMode: 'advanced',
          defaultEmbeddingPolicy: 'skip',
          embeddingTiming: 'manual',
          autoChunkOnAnalysis: false
        })
      );
      expect(persisted).not.toHaveProperty('advancedModeValues');
    });

    test('a user with only recommended values switches both ways with no stash', async () => {
      const service = loadService();
      mockFiles.set(service.settingsPath, JSON.stringify({ experienceMode: 'advanced' }));

      await service.save({ experienceMode: 'simple' });
      expect(readPersisted(service)).not.toHaveProperty('advancedModeValues');
      service.invalidateCache();

      const result = await service.save({ experienceMode: 'advanced' });
      expect(result.settings).toMatchObject(SIMPLE_MODE_ENFORCED_VALUES);
      expect(readPersisted(service)).not.toHaveProperty('advancedModeValues');
    });
  });
});

describe('SettingsService — the last snapshot stays readable while the disk is read', () => {
  beforeEach(() => {
    mockFiles.clear();
  });

  test('getAll keeps the loaded values during a save instead of falling back to defaults', async () => {
    const service = loadService();
    mockFiles.set(
      service.settingsPath,
      JSON.stringify({ downloadsTriageExclusions: ['*.psd'], captionVideoKeyframes: true })
    );
    await service.load();
    expect(service.getAll().downloadsTriageExclusions).toEqual(['*.psd']);

    // Watchers read getAll() synchronously; sample it on every tick of the save.
    const seen = [];
    const fs = require('fs').promises;
    const realRead = fs.readFile.getMockImplementation();
    fs.readFile.mockImplementation(async (p) => {
      seen.push(service.getAll());
      return realRead(p);
    });

    await service.save({ lastBrowsedPath: '/somewhere' });

    expect(seen.length).toBeGreaterThan(0);
    for (const snapshot of seen) {
      expect(snapshot.downloadsTriageExclusions).toEqual(['*.psd']);
      expect(snapshot.captionVideoKeyframes).toBe(true);
    }
    expect(service.getAll().lastBrowsedPath).toBe('/somewhere');
    fs.readFile.mockImplementation(realRead);
  });

  test('invalidateCache forces the next load to read the disk but keeps the snapshot until then', async () => {
    const service = loadService();
    mockFiles.set(service.settingsPath, JSON.stringify({ downloadsTriageExclusions: ['*.psd'] }));
    await service.load();

    mockFiles.set(service.settingsPath, JSON.stringify({ downloadsTriageExclusions: ['*.iso'] }));
    service.invalidateCache();
    expect(service.getAll().downloadsTriageExclusions).toEqual(['*.psd']);

    const reloaded = await service.load();
    expect(reloaded.downloadsTriageExclusions).toEqual(['*.iso']);
    expect(service.getAll().downloadsTriageExclusions).toEqual(['*.iso']);
  });
});

describe('SettingsService — the resolved Documents folder is a default, not a user value', () => {
  beforeEach(() => {
    mockFiles.clear();
  });

  test("saving this machine's Documents path persists nothing and load resolves it live", async () => {
    const service = loadService();
    const documents = service.defaults.defaultSmartFolderLocation;
    expect(documents).not.toBe('Documents');

    await service.save({ defaultSmartFolderLocation: documents });
    expect(readPersisted(service)).not.toHaveProperty('defaultSmartFolderLocation');

    // A trailing separator or a case difference (Windows) is the same folder.
    await service.save({ defaultSmartFolderLocation: `${documents}/` });
    expect(readPersisted(service)).not.toHaveProperty('defaultSmartFolderLocation');

    service.invalidateCache();
    const loaded = await service.load();
    expect(loaded.defaultSmartFolderLocation).toBe(documents);
  });

  test('a path the user chose is kept, and a stale persisted Documents path reads as the live one', async () => {
    const service = loadService();
    await service.save({ defaultSmartFolderLocation: '/srv/shared/Sorted' });
    expect(readPersisted(service).defaultSmartFolderLocation).toBe('/srv/shared/Sorted');

    // A file written by an older build with the resolved path frozen in.
    mockFiles.set(
      service.settingsPath,
      JSON.stringify({ defaultSmartFolderLocation: service.defaults.defaultSmartFolderLocation })
    );
    service.invalidateCache();
    const loaded = await service.load();
    expect(loaded.defaultSmartFolderLocation).toBe(service.defaults.defaultSmartFolderLocation);
    await service.save({ notifications: false });
    expect(readPersisted(service)).not.toHaveProperty('defaultSmartFolderLocation');
  });

  test('importing an Advanced export onto a Simple install keeps the imported choices', async () => {
    const service = loadService();
    mockFiles.set(
      service.settingsPath,
      JSON.stringify({
        experienceMode: 'simple',
        advancedModeValues: { defaultEmbeddingPolicy: 'skip', embeddingTiming: 'manual' }
      })
    );

    // An export is the full load() output of the other machine.
    const result = await service.save({
      experienceMode: 'advanced',
      defaultEmbeddingPolicy: 'web_only',
      embeddingTiming: SIMPLE_MODE_ENFORCED_VALUES.embeddingTiming,
      advancedModeValues: null
    });

    expect(result.settings.defaultEmbeddingPolicy).toBe('web_only');
    expect(result.settings.embeddingTiming).toBe('manual');
    expect(result.settings.advancedModeValues).toBeNull();
    expect(readPersisted(service).defaultEmbeddingPolicy).toBe('web_only');
  });
});
