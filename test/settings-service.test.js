/**
 * @jest-environment node
 */
// Unmock fs to use real filesystem for these tests
// The global test-setup mocks fs with memfs, but this causes issues when
// spying on real fs operations. These tests need the real filesystem.
jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

// Mock electron before importing
jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(),
    getVersion: jest.fn(() => '1.0.0')
  }
}));

// Mock atomicFileOperations - backupAndReplace is used by save()
const mockBackupAndReplace = jest.fn();
jest.mock('../src/shared/atomicFileOperations', () => {
  const actual = jest.requireActual('../src/shared/atomicFileOperations');
  return {
    ...actual,
    backupAndReplace: mockBackupAndReplace
  };
});

const { app } = require('electron');

const SettingsService = require('../src/main/services/SettingsService');

describe('SettingsService atomic save', () => {
  let tempDir;
  let service;
  let filePath;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-test-'));
    app.getPath.mockReturnValue(tempDir);
    filePath = path.join(tempDir, 'settings.json');

    // Write a placeholder settings file BEFORE creating the service.
    // The constructor starts _startFileWatcher() async (fire-and-forget).
    // If the file doesn't exist, the watcher writes defaults, which can
    // race with the test's own writeFile and overwrite test data.
    await fs.writeFile(filePath, JSON.stringify({}, null, 2));

    service = new SettingsService();

    // Reset mocks
    jest.clearAllMocks();
    mockBackupAndReplace.mockReset();
  });

  afterEach(async () => {
    // Stop file watcher to prevent handles
    service._stopFileWatcher?.();

    // Cleanup temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test('interrupted write leaves original file intact', async () => {
    // Write an already-migrated settings file so the one-shot rejection below
    // is consumed by the test's save(), not by the schema migration's save().
    const { SETTINGS_SCHEMA_VERSION } = require('../src/shared/constants');
    const originalSettings = {
      loggingLevel: 'warn',
      settingsSchemaVersion: SETTINGS_SCHEMA_VERSION
    };
    await fs.writeFile(filePath, JSON.stringify(originalSettings, null, 2));

    // Mock backupAndReplace to reject with an error (simulating write failure)
    mockBackupAndReplace.mockRejectedValueOnce(new Error('simulated failure'));

    // Attempt to save should fail
    await expect(service.save({ loggingLevel: 'debug' })).rejects.toThrow('simulated failure');

    // Original file should still have the original content
    const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    expect(content.loggingLevel).toBe('warn');
  });

  test('successful save updates the file', async () => {
    // Write original settings file
    const originalSettings = { loggingLevel: 'warn' };
    await fs.writeFile(filePath, JSON.stringify(originalSettings, null, 2));

    // Mock backupAndReplace to succeed and actually write the file
    mockBackupAndReplace.mockImplementation(async (targetPath, content) => {
      await fs.writeFile(targetPath, content);
      return { success: true };
    });

    // Save should succeed
    const result = await service.save({ loggingLevel: 'debug' });
    expect(result.settings.loggingLevel).toBe('debug');

    // File should have new value
    const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    expect(content.loggingLevel).toBe('debug');
  });

  // Regression: a cold save() on an unversioned settings file used to
  // deadlock — save() held the mutex, createBackup() called load(), load()
  // ran the schema migration, and the migrator's own save() waited on the
  // mutex its caller was holding (30 s MutexTimeoutError). Worse, the outer
  // write then clobbered the migrated file with the pre-migration snapshot.
  test('cold save() on a legacy settings file migrates first and does not deadlock', async () => {
    const { SETTINGS_SCHEMA_VERSION } = require('../src/shared/constants');
    await fs.writeFile(
      filePath,
      JSON.stringify({ llamaTextModel: 'legacy-model.gguf', loggingLevel: 'warn' }, null, 2)
    );
    mockBackupAndReplace.mockImplementation(async (targetPath, content) => {
      await fs.writeFile(targetPath, content);
      return { success: true };
    });

    const started = Date.now();
    const result = await service.save({ loggingLevel: 'debug' });
    expect(Date.now() - started).toBeLessThan(5000);

    expect(result.settings.loggingLevel).toBe('debug');
    const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    expect(content.loggingLevel).toBe('debug');
    expect(content.settingsSchemaVersion).toBe(SETTINGS_SCHEMA_VERSION);
    // The legacy key was migrated, not discarded by the outer write.
    expect(content.textModel).toBe('legacy-model.gguf');
    expect(content).not.toHaveProperty('llamaTextModel');
  }, 15000);
});
