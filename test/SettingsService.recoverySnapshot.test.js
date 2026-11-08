/**
 * Startup auto-recovery from a corrupt settings.json must not write a
 * snapshot of DEFAULT settings as the newest automatic backup: that snapshot
 * would rotate out a genuine backup and become the first thing the next
 * recovery (or a user clicking Restore on the top entry) picks.
 *
 * Real SettingsService + real SettingsBackupService over the memfs-backed fs
 * from test/test-setup.js.
 */

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/settings-recovery-userdata'),
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

// The real transactional writer depends on fsync/rename details memfs does
// not model; plain writes are enough to observe which files end up on disk.
// While mockSettingsWriteHeld is true, writes to settings.json fail the way a
// Windows AV/indexer hold makes them fail (backups still write).
let mockSettingsWriteHeld = false;
jest.mock('../src/shared/atomicFileOperations', () => {
  const write = async (filePath, content) => {
    await require('fs').promises.writeFile(filePath, content, 'utf8');
  };
  return {
    atomicFileOps: { safeWriteFile: write },
    backupAndReplace: async (filePath, content) => {
      if (mockSettingsWriteHeld) {
        return { success: false, error: 'EBUSY: resource busy or locked' };
      }
      await write(filePath, content);
      return { success: true };
    }
  };
});

const fsSync = require('fs');
const path = require('path');

const USER_DATA = '/settings-recovery-userdata';
const BACKUP_DIR = path.join(USER_DATA, 'settings-backups');
const SETTINGS_PATH = path.join(USER_DATA, 'settings.json');

function loadSettingsService() {
  const SettingsService = require('../src/main/services/SettingsService');
  jest.spyOn(SettingsService.prototype, '_startFileWatcher').mockImplementation(() => {});
  return SettingsService;
}

describe('settings auto-recovery backup snapshot', () => {
  beforeEach(() => {
    try {
      fsSync.rmSync(USER_DATA, { recursive: true, force: true });
    } catch {
      // first run
    }
    fsSync.mkdirSync(BACKUP_DIR, { recursive: true });
    mockSettingsWriteHeld = false;
  });

  afterEach(() => {
    mockSettingsWriteHeld = false;
    jest.restoreAllMocks();
  });

  /** Write `count` genuine automatic backups of `settings`, oldest first. */
  async function writeGenuineBackups(settings, count) {
    const { SettingsBackupService } = require('../src/main/services/SettingsBackupService');
    const writer = new SettingsBackupService({
      backupDir: BACKUP_DIR,
      defaults: {},
      loadSettings: async () => settings
    });
    for (let i = 0; i < count; i++) {
      const created = await writer.createBackup();
      expect(created.success).toBe(true);
      // Distinct timestamps keep the newest-first order deterministic.
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
  }

  function backupThresholds(backups) {
    return backups.map(
      (b) => JSON.parse(fsSync.readFileSync(b.path, 'utf8')).settings.confidenceThreshold
    );
  }

  test('recovering from a corrupt settings.json does not snapshot defaults as the newest backup', async () => {
    const SettingsService = loadSettingsService();
    const { SettingsBackupService } = require('../src/main/services/SettingsBackupService');

    // A genuine automatic backup of the user's settings, written by the app.
    const userSettings = { confidenceThreshold: 0.33, notifications: false };
    const writer = new SettingsBackupService({
      backupDir: BACKUP_DIR,
      defaults: {},
      loadSettings: async () => userSettings
    });
    const created = await writer.createBackup();
    expect(created.success).toBe(true);

    fsSync.writeFileSync(SETTINGS_PATH, '{"confidenceThreshold": ', 'utf8');

    const service = new SettingsService();
    try {
      const loaded = await service._loadRaw();
      expect(loaded.confidenceThreshold).toBe(0.33);

      const backups = await service._backupService.listBackups();
      expect(backups.map((b) => b.filename)).toEqual([path.basename(created.path)]);
    } finally {
      await service.shutdown?.();
    }
  });

  test('a session that already read real settings still snapshots them before recovering', async () => {
    const SettingsService = loadSettingsService();
    const { SettingsBackupService } = require('../src/main/services/SettingsBackupService');

    const backedUp = { confidenceThreshold: 0.33, notifications: false };
    const writer = new SettingsBackupService({
      backupDir: BACKUP_DIR,
      defaults: {},
      loadSettings: async () => backedUp
    });
    const created = await writer.createBackup();
    expect(created.success).toBe(true);

    // This session read newer settings than the backup holds...
    fsSync.writeFileSync(SETTINGS_PATH, JSON.stringify({ confidenceThreshold: 0.77 }), 'utf8');
    const service = new SettingsService();
    try {
      const first = await service._loadRaw();
      expect(first.confidenceThreshold).toBe(0.77);

      // ...then the file was corrupted underneath it.
      fsSync.writeFileSync(SETTINGS_PATH, '{"confidenceThreshold": ', 'utf8');
      service._cacheTimestamp = 0;
      const recovered = await service._loadRaw();
      expect(recovered.confidenceThreshold).toBe(0.33);

      const backups = await service._backupService.listBackups();
      expect(backups).toHaveLength(2);
      const snapshot = backups.find((b) => b.filename !== path.basename(created.path));
      const snapshotData = JSON.parse(fsSync.readFileSync(snapshot.path, 'utf8'));
      expect(snapshotData.settings.confidenceThreshold).toBe(0.77);
    } finally {
      await service.shutdown?.();
    }
  });

  test('a recovery pass after a failed one does not snapshot the defaults it fell back to', async () => {
    const SettingsService = loadSettingsService();
    await writeGenuineBackups({ confidenceThreshold: 0.33 }, 10);
    fsSync.writeFileSync(SETTINGS_PATH, '{"confidenceThreshold": ', 'utf8');
    mockSettingsWriteHeld = true;

    const service = new SettingsService();
    try {
      // Pass 1: every restore write fails, so the load falls back to defaults.
      const first = await service._loadRaw();
      expect(first.confidenceThreshold).toBe(service.defaults.confidenceThreshold);

      // Pass 2 (cache expired, still held): the cache now holds only those
      // defaults, which are not settings worth snapshotting.
      service._cacheTimestamp = 0;
      await service._loadRaw();
      const afterSecond = await service._backupService.listBackups();
      expect(backupThresholds(afterSecond)).toEqual(Array(10).fill(0.33));

      // Hold clears: recovery restores the user's settings, not defaults.
      mockSettingsWriteHeld = false;
      service._cacheTimestamp = 0;
      const third = await service._loadRaw();
      expect(third.confidenceThreshold).toBe(0.33);
    } finally {
      await service.shutdown?.();
    }
  });

  test('a recovery pass snapshots real settings at most once however many backups it tries', async () => {
    const SettingsService = loadSettingsService();
    await writeGenuineBackups({ confidenceThreshold: 0.33 }, 10);
    fsSync.writeFileSync(SETTINGS_PATH, JSON.stringify({ confidenceThreshold: 0.77 }), 'utf8');

    const service = new SettingsService();
    try {
      expect((await service._loadRaw()).confidenceThreshold).toBe(0.77);

      fsSync.writeFileSync(SETTINGS_PATH, '{"confidenceThreshold": ', 'utf8');
      mockSettingsWriteHeld = true;
      service._cacheTimestamp = 0;
      await service._loadRaw();

      const thresholds = backupThresholds(await service._backupService.listBackups());
      expect(thresholds.filter((t) => t === 0.77)).toHaveLength(1);
      expect(thresholds.filter((t) => t === 0.33)).toHaveLength(9);
    } finally {
      await service.shutdown?.();
    }
  });
});
