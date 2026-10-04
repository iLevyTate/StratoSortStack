/**
 * @jest-environment node
 *
 * Round-trip persistence guard for the settings keys that the wiring audit
 * fixed (they were previously dropped by sanitizeSettings or the SAVE Zod
 * gate). A real save -> on-disk -> reload cycle proves they survive a restart:
 *   - downloadsTriageExclusions (was missing from VALIDATION_RULES)
 *   - chatPersonaCustomGuidance + customChatPersonas (was stripped by Zod)
 *   - ai provider blob (was dropped by sanitizeSettings)
 */
jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(),
    getVersion: jest.fn(() => '1.0.0')
  }
}));

// backupAndReplace performs the real atomic write in production; here we make
// it write straight through so the reload reads exactly what save() produced.
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

describe('settings round-trip persistence (audit fix keys)', () => {
  let tempDir;
  let filePath;
  let service;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-roundtrip-'));
    app.getPath.mockReturnValue(tempDir);
    filePath = path.join(tempDir, 'settings.json');
    await fs.writeFile(filePath, JSON.stringify({}, null, 2));

    service = new SettingsService();
    jest.clearAllMocks();
    mockBackupAndReplace.mockReset();
    mockBackupAndReplace.mockImplementation(async (targetPath, content) => {
      await fs.writeFile(targetPath, content);
      return { success: true };
    });
  });

  afterEach(async () => {
    service._stopFileWatcher?.();
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  test('preserves downloadsTriageExclusions, chat persona fields, and ai blob across reload', async () => {
    const aiBlob = {
      defaultProvider: 'llama',
      providers: { llama: { enabled: true } }
    };

    const saveResult = await service.save({
      // Includes whitespace + a duplicate to prove the sanitizer trims/dedupes
      // rather than dropping the whole array.
      downloadsTriageExclusions: ['*.tmp', '  *.log  ', '*.tmp'],
      chatPersonaCustomGuidance: 'Always answer in British English.',
      customChatPersonas: [{ id: 'reviewer', label: 'Reviewer', guidance: 'Be precise.' }],
      ai: aiBlob
    });

    expect(saveResult.settings.downloadsTriageExclusions).toEqual(['*.tmp', '*.log']);
    expect(saveResult.settings.chatPersonaCustomGuidance).toBe('Always answer in British English.');
    expect(saveResult.settings.customChatPersonas).toEqual([
      { id: 'custom:reviewer', label: 'Reviewer', description: '', guidance: 'Be precise.' }
    ]);
    expect(saveResult.settings.ai).toEqual(aiBlob);

    // Reload from a fresh service so nothing is served from the in-memory cache.
    service._stopFileWatcher?.();
    const reloaded = new SettingsService();
    try {
      const onDisk = await reloaded.load();
      expect(onDisk.downloadsTriageExclusions).toEqual(['*.tmp', '*.log']);
      expect(onDisk.chatPersonaCustomGuidance).toBe('Always answer in British English.');
      expect(onDisk.customChatPersonas).toEqual([
        { id: 'custom:reviewer', label: 'Reviewer', description: '', guidance: 'Be precise.' }
      ]);
      expect(onDisk.ai).toEqual(aiBlob);
    } finally {
      reloaded._stopFileWatcher?.();
    }
  });
});
