/**
 * restoreFromBackup takes a snapshot of the current settings before it
 * writes the restored ones, so a restore can be undone. That snapshot must
 * only be taken when the restore is actually going to happen, and callers
 * that know there is nothing real to snapshot (startup auto-recovery from a
 * corrupt settings.json) can opt out, so defaults never rotate out a genuine
 * backup.
 *
 * Real SettingsBackupService over the memfs-backed fs from test/test-setup.js.
 */

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/settings-snapshot-userdata'),
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

// The transactional writer depends on fsync details memfs does not model.
jest.mock('../src/shared/atomicFileOperations', () => ({
  atomicFileOps: {
    safeWriteFile: async (filePath, content) => {
      await require('fs').promises.writeFile(filePath, content, 'utf8');
    }
  }
}));

const fsSync = require('fs');
const path = require('path');
const { SettingsBackupService } = require('../src/main/services/SettingsBackupService');

const BACKUP_DIR = path.join('/settings-snapshot-userdata', 'settings-backups');

function backupFiles() {
  return fsSync
    .readdirSync(BACKUP_DIR)
    .filter((name) => name.startsWith('settings-') && name.endsWith('.json'))
    .sort();
}

async function writeUserBackup(settings) {
  const writer = new SettingsBackupService({
    backupDir: BACKUP_DIR,
    defaults: {},
    loadSettings: async () => settings
  });
  const created = await writer.createBackup();
  expect(created.success).toBe(true);
  return created.path;
}

describe('SettingsBackupService pre-restore snapshot', () => {
  beforeEach(() => {
    try {
      fsSync.rmSync('/settings-snapshot-userdata', { recursive: true, force: true });
    } catch {
      // first run
    }
    fsSync.mkdirSync(BACKUP_DIR, { recursive: true });
  });

  test('a backup that fails validation is rejected without writing a snapshot', async () => {
    const invalidBackup = await writeUserBackup({ confidenceThreshold: 'not-a-number' });
    const before = backupFiles();

    const service = new SettingsBackupService({
      backupDir: BACKUP_DIR,
      defaults: { confidenceThreshold: 0.75 },
      loadSettings: async () => ({ confidenceThreshold: 0.75 })
    });
    const saveSettings = jest.fn();
    const result = await service.restoreFromBackup(invalidBackup, saveSettings);

    expect(result.success).toBe(false);
    expect(saveSettings).not.toHaveBeenCalled();
    expect(backupFiles()).toEqual(before);
  });

  test('a valid restore snapshots the current settings first by default', async () => {
    const userBackup = await writeUserBackup({ confidenceThreshold: 0.33 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const service = new SettingsBackupService({
      backupDir: BACKUP_DIR,
      defaults: { confidenceThreshold: 0.75 },
      loadSettings: async () => ({ confidenceThreshold: 0.6 })
    });
    const saveSettings = jest.fn().mockResolvedValue({ success: true });
    const result = await service.restoreFromBackup(userBackup, saveSettings);

    expect(result.success).toBe(true);
    expect(backupFiles()).toHaveLength(2);
    const newest = (await service.listBackups())[0];
    const snapshot = JSON.parse(fsSync.readFileSync(newest.path, 'utf8'));
    expect(snapshot.settings.confidenceThreshold).toBe(0.6);
  });

  test('preRestoreBackup: false restores without writing a snapshot', async () => {
    const userBackup = await writeUserBackup({ confidenceThreshold: 0.33 });
    const loadSettings = jest.fn(async () => ({ confidenceThreshold: 0.75 }));

    const service = new SettingsBackupService({
      backupDir: BACKUP_DIR,
      defaults: { confidenceThreshold: 0.75 },
      loadSettings
    });
    const saveSettings = jest.fn().mockResolvedValue({ success: true });
    const result = await service.restoreFromBackup(userBackup, saveSettings, {
      preRestoreBackup: false
    });

    expect(result.success).toBe(true);
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ confidenceThreshold: 0.33 })
    );
    expect(loadSettings).not.toHaveBeenCalled();
    expect(backupFiles()).toEqual([path.basename(userBackup)]);
  });
});
