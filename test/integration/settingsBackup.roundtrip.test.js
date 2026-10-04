/**
 * Integration test: settings backup/restore roundtrip.
 *
 * Walks the end-to-end journey a user follows to migrate a machine:
 *
 *   1. Create a backup from a live settings object.
 *   2. "Wipe userData" by deleting the in-memory settings state.
 *   3. Restore from the same backup file.
 *   4. Assert the restored settings deep-equal the originals for every
 *      field the user set explicitly.
 *
 * Runs against the global memfs mock installed by `test/test-setup.js`,
 * which gives us a real filesystem API surface while keeping the suite
 * deterministic. This is the regression gate that guarantees a user
 * never loses settings to our own backup layer.
 */

const path = require('path');
const fs = require('fs').promises;

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/tmp/stratosort-settings-userdata'),
    getVersion: jest.fn(() => '2.0.999')
  }
}));

const { SettingsBackupService } = require('../../src/main/services/SettingsBackupService');
const { DEFAULT_SETTINGS } = require('../../src/shared/defaultSettings');

const BACKUP_DIR = '/tmp/stratosort-settings-userdata/settings-backups';

function buildUserSettings() {
  // Start from the real defaults so the shape matches what
  // `validateSettings` / `sanitizeSettings` will accept, then flip the
  // handful of fields the user cares about across a migration.
  return {
    ...DEFAULT_SETTINGS,
    experienceMode: 'advanced',
    notifications: false,
    notificationMode: 'ui',
    notifyOnAutoAnalysis: false,
    confidenceThreshold: 0.82,
    autoOrganize: true,
    maxConcurrentAnalysis: 3,
    textModel: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    visionModel: 'moondream2-q4_k_m.gguf',
    embeddingTiming: 'after_organize',
    defaultEmbeddingPolicy: 'embed',
    embeddingScope: 'smart_folders_only',
    namingConvention: 'subject-date',
    caseConvention: 'kebab-case',
    separator: '-'
  };
}

// Fields we assert round-trip losslessly. Anything `applyExperienceModeSettings`
// might rewrite on `simple` mode is intentionally excluded — we pin
// `experienceMode: 'advanced'` above so those branches don't apply here.
const USER_CONTROLLED_FIELDS = [
  'experienceMode',
  'notifications',
  'notificationMode',
  'notifyOnAutoAnalysis',
  'confidenceThreshold',
  'autoOrganize',
  'maxConcurrentAnalysis',
  'textModel',
  'visionModel',
  'embeddingTiming',
  'defaultEmbeddingPolicy',
  'embeddingScope',
  'namingConvention',
  'caseConvention',
  'separator'
];

describe('Integration — settings backup/restore roundtrip', () => {
  let service;
  let storedSettings;

  beforeEach(async () => {
    // memfs is reset between tests, so re-create the userData tree.
    await fs.mkdir(BACKUP_DIR, { recursive: true });

    storedSettings = buildUserSettings();
    service = new SettingsBackupService({
      backupDir: BACKUP_DIR,
      maxBackups: 5,
      defaults: { ...DEFAULT_SETTINGS },
      loadSettings: async () => storedSettings
    });
  });

  test('exports settings, wipes state, restores, and preserves every user-set field', async () => {
    const createResult = await service.createBackup();
    expect(createResult.success).toBe(true);
    expect(typeof createResult.path).toBe('string');

    // Confirm the backup is a valid, hashed envelope on disk.
    const onDisk = await fs.readFile(createResult.path, 'utf8');
    const parsed = JSON.parse(onDisk);
    expect(parsed.hash).toEqual(expect.any(String));
    expect(parsed.settings).toBeTruthy();
    for (const key of USER_CONTROLLED_FIELDS) {
      expect(parsed.settings[key]).toEqual(storedSettings[key]);
    }

    // Snapshot the originals before we "wipe userData".
    const originalSnapshot = JSON.parse(JSON.stringify(storedSettings));

    // Simulate wiping userData — the in-memory source of truth is gone;
    // the backup file on disk is the only remaining state.
    storedSettings = null;
    let saved = null;
    const saveSettings = async (nextSettings) => {
      saved = nextSettings;
      storedSettings = nextSettings;
    };

    const restoreResult = await service.restoreFromBackup(createResult.path, saveSettings);
    expect(restoreResult.success).toBe(true);
    expect(saved).not.toBeNull();

    // Every user-controlled field must survive the round-trip verbatim.
    for (const key of USER_CONTROLLED_FIELDS) {
      expect(saved[key]).toEqual(originalSnapshot[key]);
    }

    // The returned settings object the caller sees should match what we saved.
    expect(restoreResult.settings).toEqual(saved);
  });

  test('rejects a tampered backup (SHA-256 hash mismatch)', async () => {
    const createResult = await service.createBackup();
    expect(createResult.success).toBe(true);

    const original = await fs.readFile(createResult.path, 'utf8');
    // Flip one meaningful byte inside `settings` without touching `hash`.
    const tampered = original.replace('"advanced"', '"simple"  ');
    expect(tampered).not.toEqual(original);
    await fs.writeFile(createResult.path, tampered, 'utf8');

    const saveSettings = jest.fn();
    const restoreResult = await service.restoreFromBackup(createResult.path, saveSettings);
    expect(restoreResult.success).toBe(false);
    expect(restoreResult.error || '').toMatch(/hash mismatch|integrity/i);
    expect(saveSettings).not.toHaveBeenCalled();
  });

  test('rejects a backup outside the configured backup directory (path traversal)', async () => {
    const createResult = await service.createBackup();
    expect(createResult.success).toBe(true);

    const outside = '/tmp/stratosort-settings-userdata/evil-backup.json';
    await fs.copyFile(createResult.path, outside).catch(async () => {
      // memfs on some Node versions lacks copyFile; fall back to manual copy.
      const data = await fs.readFile(createResult.path);
      await fs.writeFile(outside, data);
    });

    const saveSettings = jest.fn();
    const restoreResult = await service.restoreFromBackup(outside, saveSettings);
    expect(restoreResult.success).toBe(false);
    expect(restoreResult.error || '').toMatch(/backup directory|invalid backup path/i);
    expect(saveSettings).not.toHaveBeenCalled();
  });
});
