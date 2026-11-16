jest.mock('fs', () => ({
  promises: {
    access: jest.fn(),
    rm: jest.fn()
  }
}));

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn()
  }
}));

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const mockLoadSettings = jest.fn(async () => ({}));
jest.mock('../src/main/services/SettingsService', () => ({
  getInstance: () => ({ load: mockLoadSettings })
}));

const fs = require('fs').promises;
const { app } = require('electron');
const path = require('path');
const {
  DataMigrationService,
  MIGRATION_STATUS
} = require('../src/main/services/migration/DataMigrationService');

describe('DataMigrationService', () => {
  let svc;
  const mockUserData = '/mock/userData';

  beforeEach(() => {
    jest.clearAllMocks();
    app.getPath.mockReturnValue(mockUserData);
    svc = new DataMigrationService();
  });

  describe('needsMigration', () => {
    test('returns true if legacy data exists', async () => {
      // Mock access to succeed for first path
      fs.access.mockResolvedValueOnce(undefined);

      const result = await svc.needsMigration();
      expect(result).toBe(true);
      expect(fs.access).toHaveBeenCalled();
    });

    test('returns false if no legacy data exists', async () => {
      // Mock access to fail for all checks
      fs.access.mockRejectedValue({ code: 'ENOENT' });

      const result = await svc.needsMigration();
      expect(result).toBe(false);
    });
  });

  describe('legacy name used as the live vector folder', () => {
    afterEach(() => {
      mockLoadSettings.mockResolvedValue({});
      fs.access.mockReset();
      fs.rm.mockReset();
    });

    test('migrate keeps it and still removes the other legacy paths', async () => {
      mockLoadSettings.mockResolvedValue({ vectorDbPersistPath: 'vector_storage' });
      fs.access.mockResolvedValue(undefined);
      fs.rm.mockResolvedValue(undefined);

      await svc.migrate();

      const removed = fs.rm.mock.calls.map(([p]) => path.basename(p));
      expect(removed).not.toContain('vector_storage');
      expect(removed).toContain('chroma_db');
    });

    test('needsMigration ignores it', async () => {
      mockLoadSettings.mockResolvedValue({ vectorDbPersistPath: 'chroma_db' });
      fs.access.mockImplementation(async (p) => {
        if (path.basename(p) !== 'chroma_db') throw Object.assign(new Error(), { code: 'ENOENT' });
      });

      await expect(svc.needsMigration()).resolves.toBe(false);
    });
  });

  describe('migrate', () => {
    test('deletes legacy data and reports success', async () => {
      // Setup: access succeeds for one path, fails for others
      fs.access.mockImplementation(async (p) => {
        if (p.includes('chromadb')) return undefined; // exists
        throw { code: 'ENOENT' };
      });

      const onProgress = jest.fn();
      const result = await svc.migrate({ onProgress });

      expect(result.success).toBe(true);
      expect(result.migratedCount).toBeGreaterThan(0);
      expect(result.message).toContain('Cleanup complete');
      expect(svc.getStatus().status).toBe(MIGRATION_STATUS.COMPLETED);

      // Verify deletion
      expect(fs.rm).toHaveBeenCalledWith(
        expect.stringContaining('chromadb'),
        expect.objectContaining({ recursive: true, force: true })
      );
    });

    test('handles no legacy data found during migrate execution', async () => {
      fs.access.mockRejectedValue({ code: 'ENOENT' });

      const result = await svc.migrate();

      expect(result.success).toBe(true);
      expect(result.migratedCount).toBe(0);
      expect(result.message).toContain('No legacy data found');
      expect(svc.getStatus().status).toBe(MIGRATION_STATUS.NOT_NEEDED);
      expect(fs.rm).not.toHaveBeenCalled();
    });

    test('handles deletion errors gracefully', async () => {
      fs.access.mockResolvedValue(undefined); // exists
      fs.rm.mockRejectedValue(new Error('Permission denied'));

      const result = await svc.migrate();

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(svc.getStatus().status).toBe(MIGRATION_STATUS.FAILED);
    });
  });

  describe('reset', () => {
    test('clears state', () => {
      svc._status = MIGRATION_STATUS.FAILED;
      svc._errors.push('err');
      svc.reset();
      const status = svc.getStatus();
      expect(status.status).toBe(MIGRATION_STATUS.NOT_STARTED);
      expect(status.errors).toEqual([]);
    });
  });
});
