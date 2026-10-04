const BACKUP_DIR = require('path').join('fake-user-data', 'settings-backups');
const SETTINGS_FILE = require('path').join(BACKUP_DIR, 'settings.json');

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => require('path').join('fake-user-data')),
    getVersion: jest.fn(() => '2.0.0')
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

jest.mock('../src/shared/performanceConstants', () => ({
  LIMITS: { MAX_SETTINGS_BACKUPS: 2 }
}));

jest.mock('../src/shared/atomicFileOperations', () => ({
  atomicFileOps: {
    safeWriteFile: jest.fn().mockResolvedValue()
  }
}));

jest.mock('../src/shared/settingsValidation', () => ({
  validateSettings: jest.fn(() => ({ valid: true, errors: [], warnings: [] })),
  sanitizeSettings: jest.fn((settings) => settings)
}));

const mockFs = {
  mkdir: jest.fn().mockResolvedValue(),
  readdir: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn().mockResolvedValue(),
  stat: jest.fn(),
  unlink: jest.fn().mockResolvedValue()
};

jest.mock('fs', () => ({
  promises: mockFs
}));

const { validateSettings } = require('../src/shared/settingsValidation');
const { SettingsBackupService } = require('../src/main/services/SettingsBackupService');

const stableStringify = (value) =>
  JSON.stringify(
    value,
    (key, val) => {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        return Object.keys(val)
          .sort()
          .reduce((acc, k) => {
            acc[k] = val[k];
            return acc;
          }, {});
      }
      return val;
    },
    2
  );

describe('SettingsBackupService', () => {
  beforeEach(() => {
    mockFs.readdir.mockReset();
    mockFs.readFile.mockReset();
    mockFs.stat.mockReset();
    mockFs.unlink.mockReset();
  });

  test('createBackup writes backup and returns metadata', async () => {
    const service = new SettingsBackupService({
      backupDir: BACKUP_DIR,
      defaults: { theme: 'light' },
      loadSettings: jest.fn().mockResolvedValue({ theme: 'dark' })
    });

    const result = await service.createBackup();
    expect(result.success).toBe(true);
    expect(result.path).toContain('settings-');
  });

  test('listBackups skips invalid files', async () => {
    mockFs.readdir.mockResolvedValue(['settings-a.json']);
    mockFs.readFile.mockRejectedValueOnce(new Error('bad json'));
    const service = new SettingsBackupService({
      backupDir: BACKUP_DIR,
      defaults: {},
      loadSettings: jest.fn()
    });

    const result = await service.listBackups();
    expect(result).toEqual([]);
  });

  test('restoreFromBackup validates and saves settings', async () => {
    const service = new SettingsBackupService({
      backupDir: BACKUP_DIR,
      defaults: { theme: 'light' },
      loadSettings: jest.fn()
    });

    const backup = {
      timestamp: new Date().toISOString(),
      appVersion: '2.0.0',
      settings: { theme: 'dark' }
    };
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(stableStringify(backup), 'utf8').digest('hex');
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify({ ...backup, hash }));

    const saveSettings = jest.fn().mockResolvedValue();
    const result = await service.restoreFromBackup(SETTINGS_FILE, saveSettings);

    expect(result.success).toBe(true);
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }));
  });

  test('restoreFromBackup reports validation errors', async () => {
    validateSettings.mockReturnValueOnce({ valid: false, errors: ['bad'], warnings: [] });
    const service = new SettingsBackupService({
      backupDir: BACKUP_DIR,
      defaults: {},
      loadSettings: jest.fn()
    });
    const backup = {
      timestamp: new Date().toISOString(),
      appVersion: '2.0.0',
      settings: { theme: 'dark' }
    };
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(stableStringify(backup), 'utf8').digest('hex');
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify({ ...backup, hash }));

    const result = await service.restoreFromBackup(SETTINGS_FILE, jest.fn());

    expect(result.success).toBe(false);
    expect(result.validationErrors).toEqual(['bad']);
  });
});

describe('SettingsBackupService backup pools (manual vs automatic)', () => {
  const makeService = () =>
    new SettingsBackupService({
      backupDir: BACKUP_DIR,
      maxBackups: 2,
      defaults: { theme: 'light' },
      loadSettings: jest.fn().mockResolvedValue({ theme: 'dark' })
    });

  const listing = (files) => {
    mockFs.readdir.mockResolvedValue(files.map((f) => f.name));
    mockFs.readFile.mockImplementation(async (p) => {
      const f = files.find((x) => String(p).endsWith(x.name));
      if (!f) throw new Error('missing');
      return JSON.stringify({
        timestamp: f.timestamp,
        appVersion: '2.0.0',
        ...(f.kind ? { kind: f.kind } : {}),
        settings: {}
      });
    });
    mockFs.stat.mockResolvedValue({ size: 10, mtime: new Date('2026-01-01T00:00:00Z') });
  };

  beforeEach(() => {
    mockFs.readdir.mockResolvedValue([]);
  });

  test('a manual backup is named apart from the automatic ones and says so', async () => {
    const result = await makeService().createBackup({ kind: 'manual' });
    expect(result.success).toBe(true);
    expect(result.kind).toBe('manual');
    expect(result.path).toMatch(/settings-manual-/);
  });

  test('a pre-save backup stays automatic by default', async () => {
    const result = await makeService().createBackup();
    expect(result.kind).toBe('automatic');
    expect(result.path).not.toMatch(/manual/);
  });

  test('listBackups reports the kind, from the field or the filename', async () => {
    listing([
      { name: 'settings-manual-2026-01-03.json', timestamp: '2026-01-03T00:00:00Z' },
      { name: 'settings-2026-01-02.json', timestamp: '2026-01-02T00:00:00Z', kind: 'automatic' },
      { name: 'settings-2026-01-01.json', timestamp: '2026-01-01T00:00:00Z' }
    ]);
    const backups = await makeService().listBackups();
    expect(backups.map((b) => [b.filename, b.kind])).toEqual([
      ['settings-manual-2026-01-03.json', 'manual'],
      ['settings-2026-01-02.json', 'automatic'],
      ['settings-2026-01-01.json', 'automatic']
    ]);
  });

  test('rotation deletes only automatic backups; a manual one outlives any number of saves', async () => {
    // Three manual backups older than every automatic one, plus four
    // automatic ones against a cap of two.
    listing([
      { name: 'settings-2026-02-04.json', timestamp: '2026-02-04T00:00:00Z' },
      { name: 'settings-2026-02-03.json', timestamp: '2026-02-03T00:00:00Z' },
      { name: 'settings-2026-02-02.json', timestamp: '2026-02-02T00:00:00Z' },
      { name: 'settings-2026-02-01.json', timestamp: '2026-02-01T00:00:00Z' },
      { name: 'settings-manual-2026-01-03.json', timestamp: '2026-01-03T00:00:00Z' },
      { name: 'settings-manual-2026-01-02.json', timestamp: '2026-01-02T00:00:00Z' },
      { name: 'settings-manual-2026-01-01.json', timestamp: '2026-01-01T00:00:00Z' }
    ]);

    await makeService().cleanupOldBackups();

    const deleted = mockFs.unlink.mock.calls.map((c) => require('path').basename(c[0]));
    expect(deleted.sort()).toEqual(['settings-2026-02-01.json', 'settings-2026-02-02.json']);
  });
});
