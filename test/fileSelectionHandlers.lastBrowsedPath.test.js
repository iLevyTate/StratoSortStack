/**
 * @jest-environment node
 *
 * Every file dialog saved `lastBrowsedPath`, even when it had not changed.
 * Each save rewrote settings.json and, before the backup pools were
 * separated, took a pre-save snapshot that rotated a user's manual backup
 * out after ten dialogs (audit ST-01).
 */

const mockFs = {
  stat: jest.fn(async () => ({ isDirectory: () => true })),
  access: jest.fn(async () => undefined),
  readdir: jest.fn(async () => [])
};
jest.mock('fs', () => ({ promises: mockFs }));

jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

jest.mock('../src/shared/pathSanitization', () => ({
  ...jest.requireActual('../src/shared/pathSanitization'),
  validateFileOperationPath: jest.fn(async (p) => ({ valid: true, normalizedPath: p }))
}));

jest.mock('../src/main/ipc/ipcWrappers', () => ({
  createHandler: jest.fn(({ handler }) => handler),
  withErrorLogging: jest.fn((logger, handler) => handler),
  safeHandle: (ipcMain, channel, handler) => {
    ipcMain.handle(channel, handler);
  },
  z: null
}));

jest.mock('electron', () => ({ app: { getPath: jest.fn().mockReturnValue('/mock/documents') } }));

const mockSettings = { load: jest.fn(), save: jest.fn(async () => ({ success: true })) };
jest.mock('../src/main/services/SettingsService', () => ({
  getInstance: jest.fn(() => mockSettings)
}));

const { registerFileSelectionHandlers } = require('../src/main/ipc/files/fileSelectionHandlers');

function registerAndGetHandler() {
  const handlers = {};
  registerFileSelectionHandlers({
    ipcMain: { handle: jest.fn((channel, handler) => (handlers[channel] = handler)) },
    IPC_CHANNELS: {
      FILES: {
        SELECT_DIRECTORY: 'files:select-directory',
        GET_DOCUMENTS_PATH: 'files:get-documents-path',
        GET_FILE_STATS: 'files:get-file-stats',
        GET_FILES_IN_DIRECTORY: 'files:get-files-in-directory',
        SELECT: 'files:select'
      }
    },
    dialog: {
      showOpenDialog: jest.fn(async () => ({ canceled: false, filePaths: ['/pick/here'] }))
    },
    getMainWindow: jest.fn(() => ({
      isFocused: () => true,
      isMinimized: () => false,
      isVisible: () => true,
      focus: jest.fn(),
      restore: jest.fn(),
      show: jest.fn()
    }))
  });
  return handlers['files:select-directory'];
}

describe('lastBrowsedPath bookkeeping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('does not save when the dialog opened in the same folder as last time', async () => {
    mockSettings.load.mockResolvedValue({ lastBrowsedPath: '/pick/here' });
    const handler = registerAndGetHandler();

    const result = await handler({});

    expect(result.success).toBe(true);
    expect(mockSettings.save).not.toHaveBeenCalled();
  });

  test('saves only the changed key when the folder differs', async () => {
    mockSettings.load.mockResolvedValue({ lastBrowsedPath: '/somewhere/else' });
    const handler = registerAndGetHandler();

    await handler({});

    expect(mockSettings.save).toHaveBeenCalledTimes(1);
    expect(mockSettings.save).toHaveBeenCalledWith({ lastBrowsedPath: '/pick/here' });
  });
});
