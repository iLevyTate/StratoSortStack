/**
 * Tests for Shell Handlers
 * Tests shell operations (open file, reveal in folder)
 */

// Mock logger
jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

// Mock ipcWrappers
jest.mock('../src/main/ipc/ipcWrappers', () => ({
  createHandler: jest.fn(({ handler }) => handler),
  withErrorLogging: jest.fn((logger, handler) => handler),
  safeHandle: (ipcMain, channel, handler) => {
    ipcMain.handle(channel, handler);
  },
  z: null
}));

// Mock fs.promises for path validation
jest.mock('fs', () => ({
  promises: {
    access: jest.fn().mockResolvedValue(undefined),
    lstat: jest.fn().mockResolvedValue({ isSymbolicLink: () => false }),
    realpath: jest.fn(async (p) => p),
    stat: jest.fn(async () => ({ isFile: () => true, mode: 0o644 }))
  }
}));

// Mock pathSanitization - allow paths through validation
jest.mock('../src/shared/pathSanitization', () => ({
  validateFileOperationPath: jest.fn().mockImplementation(async (filePath) => ({
    valid: true,
    normalizedPath: filePath
  })),
  sanitizePath: jest.fn((p) => p),
  isPathDangerous: jest.fn(() => false),
  checkSymlinkSafety: jest.fn().mockResolvedValue({ isSymlink: false, isSafe: true })
}));

describe('Shell Handlers', () => {
  let registerShellHandlers;
  let mockIpcMain;
  let mockShell;
  let handlers;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    mockIpcMain = {
      handle: jest.fn()
    };

    mockShell = {
      openPath: jest.fn().mockResolvedValue(''),
      showItemInFolder: jest.fn()
    };

    handlers = {};

    // Capture registered handlers
    mockIpcMain.handle.mockImplementation((channel, handler) => {
      handlers[channel] = handler;
    });

    const module = require('../src/main/ipc/files/shellHandlers');
    registerShellHandlers = module.registerShellHandlers;
  });

  describe('registerShellHandlers', () => {
    test('registers all handlers', () => {
      registerShellHandlers({
        ipcMain: mockIpcMain,
        IPC_CHANNELS: {
          FILES: {
            OPEN_FILE: 'files:open-file',
            REVEAL_FILE: 'files:reveal-file'
          }
        },
        shell: mockShell
      });

      expect(mockIpcMain.handle).toHaveBeenCalledTimes(2);
    });
  });

  describe('openFile handler', () => {
    beforeEach(() => {
      registerShellHandlers({
        ipcMain: mockIpcMain,
        IPC_CHANNELS: {
          FILES: {
            OPEN_FILE: 'files:open-file',
            REVEAL_FILE: 'files:reveal-file'
          }
        },
        shell: mockShell
      });
    });

    test('opens file successfully', async () => {
      const handler = handlers['files:open-file'];
      const result = await handler({}, '/path/to/file.pdf');

      expect(result.success).toBe(true);
      expect(mockShell.openPath).toHaveBeenCalledWith('/path/to/file.pdf');
    });

    test('handles open error', async () => {
      mockShell.openPath.mockRejectedValueOnce(new Error('Cannot open file'));

      const handler = handlers['files:open-file'];
      const result = await handler({}, '/path/to/file.pdf');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Cannot open file');
    });

    test('handles different file types', async () => {
      const handler = handlers['files:open-file'];

      await handler({}, '/path/to/document.pdf');
      expect(mockShell.openPath).toHaveBeenCalledWith('/path/to/document.pdf');

      await handler({}, '/path/to/image.jpg');
      expect(mockShell.openPath).toHaveBeenCalledWith('/path/to/image.jpg');

      await handler({}, '/path/to/archive.zip');
      expect(mockShell.openPath).toHaveBeenCalledWith('/path/to/archive.zip');
    });
  });

  describe('revealFile handler', () => {
    beforeEach(() => {
      registerShellHandlers({
        ipcMain: mockIpcMain,
        IPC_CHANNELS: {
          FILES: {
            OPEN_FILE: 'files:open-file',
            REVEAL_FILE: 'files:reveal-file'
          }
        },
        shell: mockShell
      });
    });

    test('reveals file in folder successfully', async () => {
      const handler = handlers['files:reveal-file'];
      const result = await handler({}, '/path/to/file.pdf');

      expect(result.success).toBe(true);
      expect(mockShell.showItemInFolder).toHaveBeenCalledWith('/path/to/file.pdf');
    });

    test('handles reveal error', async () => {
      mockShell.showItemInFolder.mockImplementationOnce(() => {
        throw new Error('Cannot reveal file');
      });

      const handler = handlers['files:reveal-file'];
      const result = await handler({}, '/path/to/file.pdf');

      expect(result.success).toBe(false);
      // Error message comes from shell operation failure
      expect(result.error).toBe('Cannot reveal file');
    });

    test('reveals files with special characters in path', async () => {
      const handler = handlers['files:reveal-file'];
      const result = await handler({}, '/path/to/file with spaces.pdf');

      expect(result.success).toBe(true);
      expect(mockShell.showItemInFolder).toHaveBeenCalledWith('/path/to/file with spaces.pdf');
    });
  });

  describe('openFile executable guard', () => {
    const register = () =>
      registerShellHandlers({
        ipcMain: mockIpcMain,
        IPC_CHANNELS: { FILES: { OPEN_FILE: 'files:open-file', REVEAL_FILE: 'files:reveal-file' } },
        shell: mockShell
      });

    test('refuses a ClickOnce manifest and other newly listed launchers', async () => {
      register();
      const handler = handlers['files:open-file'];
      for (const name of [
        '/dl/setup.application',
        '/dl/addin.xll',
        '/dl/patch.msu',
        '/dl/x.jnlp'
      ]) {
        const result = await handler({}, name);
        expect(result.success).toBe(false);
        expect(result.errorCode).toBe('EXECUTABLE_BLOCKED');
      }
      expect(mockShell.openPath).not.toHaveBeenCalled();
    });

    test('refuses a harmless-looking link whose target is an executable', async () => {
      const fs = require('fs').promises;
      fs.realpath.mockResolvedValueOnce('/opt/payload/evil.exe');
      register();
      const result = await handlers['files:open-file']({}, '/home/kim/report.pdf');
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('EXECUTABLE_BLOCKED');
      expect(mockShell.openPath).not.toHaveBeenCalled();
    });

    const posixOnly = process.platform === 'win32' ? test.skip : test;

    posixOnly('refuses an extensionless file that carries an execute bit', async () => {
      const fs = require('fs').promises;
      fs.stat.mockResolvedValueOnce({ isFile: () => true, mode: 0o100755 });
      register();
      const result = await handlers['files:open-file']({}, '/home/kim/bin/tool');
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('EXECUTABLE_BLOCKED');
      expect(mockShell.openPath).not.toHaveBeenCalled();
    });

    posixOnly('opens an extensionless file that is not executable', async () => {
      const fs = require('fs').promises;
      fs.stat.mockResolvedValueOnce({ isFile: () => true, mode: 0o100644 });
      register();
      const result = await handlers['files:open-file']({}, '/home/kim/notes/README');
      expect(result.success).toBe(true);
      expect(mockShell.openPath).toHaveBeenCalledWith('/home/kim/notes/README');
    });
  });
});
