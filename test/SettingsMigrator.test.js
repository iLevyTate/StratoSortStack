jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('../src/shared/constants', () => ({
  AI_DEFAULTS: {
    TEXT: { MODEL: 'text.gguf' },
    IMAGE: { MODEL: 'vision.gguf' },
    EMBEDDING: { MODEL: 'embed.gguf' }
  },
  SETTINGS_SCHEMA_VERSION: 3
}));

const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { SettingsMigrator } = require('../src/main/services/migration/SettingsMigrator');

describe('SettingsMigrator', () => {
  /** @type {string[]} */
  let tempDirs;

  beforeEach(() => {
    tempDirs = [];
  });

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  // The migrator must read the settings file raw off disk (NOT through
  // SettingsService._loadRaw, which injects the current schema version via
  // defaults-merging and strips legacy keys via sanitization — either one
  // silently defeats migration). These tests exercise that contract with
  // real files.
  const makeService = async (fileContents) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-migrator-test-'));
    tempDirs.push(dir);
    const settingsPath = path.join(dir, 'settings.json');
    if (fileContents !== undefined) {
      const data =
        typeof fileContents === 'string' ? fileContents : JSON.stringify(fileContents, null, 2);
      await fs.writeFile(settingsPath, data, 'utf-8');
    }
    return { settingsPath, save: jest.fn().mockResolvedValue() };
  };

  test('needsMigration returns true for old version', async () => {
    const settingsService = await makeService({ settingsSchemaVersion: 1 });
    const migrator = new SettingsMigrator(settingsService);
    await expect(migrator.needsMigration()).resolves.toBe(true);
  });

  test('needsMigration returns true for a file that predates version stamping', async () => {
    // Regression: mergeWithDefaults used to inject the CURRENT schema
    // version into unstamped files before the migrator ever saw them, so
    // this exact cohort (the v3 migration's target audience) never migrated.
    const settingsService = await makeService({ defaultEmbeddingPolicy: 'skip' });
    const migrator = new SettingsMigrator(settingsService);
    await expect(migrator.needsMigration()).resolves.toBe(true);
  });

  test('needsMigration returns true when old keys present', async () => {
    const settingsService = await makeService({
      llamaTextModel: 'old.gguf',
      settingsSchemaVersion: 3
    });
    const migrator = new SettingsMigrator(settingsService);
    await expect(migrator.needsMigration()).resolves.toBe(true);
  });

  test('needsMigration returns false when no settings file exists (first launch)', async () => {
    const settingsService = await makeService(undefined);
    const migrator = new SettingsMigrator(settingsService);
    await expect(migrator.needsMigration()).resolves.toBe(false);
  });

  test('needsMigration returns true when migration status cannot be determined', async () => {
    const settingsService = await makeService('{ this is not json');
    const migrator = new SettingsMigrator(settingsService);
    await expect(migrator.needsMigration()).resolves.toBe(true);
  });

  test('migrate updates keys and writes defaults', async () => {
    const settingsService = await makeService({
      settingsSchemaVersion: 1,
      llamaTextModel: 'old.gguf'
    });
    const migrator = new SettingsMigrator(settingsService);

    const result = await migrator.migrate();

    expect(result.success).toBe(true);
    expect(settingsService.save).toHaveBeenCalledWith(
      expect.objectContaining({
        textModel: 'old.gguf',
        embeddingModel: 'embed.gguf',
        settingsSchemaVersion: 3
      })
    );
    expect(settingsService.save.mock.calls[0][0]).not.toHaveProperty('llamaTextModel');
  });

  test('migrate flips pre-v3 legacy Simple-mode values once', async () => {
    const settingsService = await makeService({
      settingsSchemaVersion: 2,
      defaultEmbeddingPolicy: 'skip',
      embeddingTiming: 'manual',
      autoChunkOnAnalysis: false,
      graphExpansionEnabled: false,
      chunkContextEnabled: false
    });
    const migrator = new SettingsMigrator(settingsService);

    const result = await migrator.migrate();

    expect(result.success).toBe(true);
    expect(settingsService.save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultEmbeddingPolicy: 'embed',
        embeddingTiming: 'during_analysis',
        autoChunkOnAnalysis: true,
        graphExpansionEnabled: true,
        chunkContextEnabled: true,
        settingsSchemaVersion: 3
      })
    );
  });

  test('migrate flips legacy values on an unstamped (pre-versioning) file', async () => {
    // Regression companion to the needsMigration test above: the whole
    // point of the v3 migration is exactly this cohort.
    const settingsService = await makeService({
      defaultEmbeddingPolicy: 'skip',
      embeddingTiming: 'manual'
    });
    const migrator = new SettingsMigrator(settingsService);

    const result = await migrator.migrate();

    expect(result.success).toBe(true);
    expect(settingsService.save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultEmbeddingPolicy: 'embed',
        embeddingTiming: 'during_analysis',
        settingsSchemaVersion: 3
      })
    );
  });

  test('migrate leaves legacy-looking values alone at current version', async () => {
    // A user at v3 who deliberately chose 'skip'/'manual'/false must not be
    // re-flipped — migrate() early-returns at the current schema version.
    const settingsService = await makeService({
      settingsSchemaVersion: 3,
      textModel: 'text.gguf',
      defaultEmbeddingPolicy: 'skip',
      embeddingTiming: 'manual'
    });
    const migrator = new SettingsMigrator(settingsService);

    const result = await migrator.migrate();

    expect(result.success).toBe(true);
    expect(result.migrated).toEqual([]);
    expect(settingsService.save).not.toHaveBeenCalled();
  });

  test('migrate is a no-op when no settings file exists', async () => {
    const settingsService = await makeService(undefined);
    const migrator = new SettingsMigrator(settingsService);

    const result = await migrator.migrate();

    expect(result.success).toBe(true);
    expect(result.migrated).toEqual([]);
    expect(settingsService.save).not.toHaveBeenCalled();
  });

  test('validateSettings reports missing required keys', async () => {
    const settingsService = await makeService({ settingsSchemaVersion: 3 });
    const migrator = new SettingsMigrator(settingsService);

    const result = await migrator.validateSettings();
    expect(result.valid).toBe(false);
    expect(result.issues.join(' ')).toMatch(/textModel/);
  });
});
