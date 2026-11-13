/**
 * @jest-environment node
 *
 * Smart Folder add and folder scan say in plain words why a folder cannot be
 * used: the write test runs inside the chosen folder (an external drive's own
 * root, /Volumes/SSD, is writable even though /Volumes is not), a read-only
 * drive says it is read-only, and a folder macOS blocks points at Privacy &
 * Security instead of showing "No files found".
 */
const path = require('path');
const { IPC_CHANNELS } = require('../src/shared/constants');

jest.mock('fs', () => ({
  promises: {
    stat: jest.fn(),
    mkdir: jest.fn(),
    writeFile: jest.fn(),
    unlink: jest.fn(),
    rm: jest.fn(),
    rename: jest.fn(),
    readdir: jest.fn()
  }
}));

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn((name) => (name === 'documents' ? 'C:\\Users\\Test\\Documents' : ''))
  },
  BrowserWindow: {
    getAllWindows: jest.fn(() => [{ isDestroyed: () => false, webContents: { send: jest.fn() } }])
  }
}));

jest.mock('../src/main/ipc/files/destinationPolicy', () => ({
  ...jest.requireActual('../src/main/ipc/files/destinationPolicy'),
  authorizeSmartFolderRoot: jest.fn(async () => ({ allowed: true, reason: 'test' }))
}));

jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  };
  return { createLogger: jest.fn(() => logger) };
});

jest.mock('../src/main/ipc/ipcWrappers', () => ({
  createHandler: jest.fn(({ handler }) => handler),
  safeHandle: jest.fn(),
  safeSend: jest.fn(),
  withErrorLogging: jest.fn((logger, handler) =>
    typeof handler === 'function' ? handler : (fn) => fn
  )
}));

jest.mock('../src/main/services/FolderMatchingService', () => ({ getInstance: jest.fn() }));
jest.mock('../src/main/services/ParallelEmbeddingService', () => ({ getInstance: jest.fn() }));
jest.mock('../src/main/services/LlamaService', () => ({ getInstance: jest.fn() }));
jest.mock('../src/main/services/SmartFoldersLLMService', () => ({
  enhanceSmartFolderWithLLM: jest.fn(async () => null)
}));

jest.mock('../src/shared/pathSanitization', () => ({
  validateFileOperationPathSync: jest.fn((p) => ({ valid: true, normalizedPath: p })),
  validateFileOperationPath: jest.fn(async (p) => ({ valid: true, normalizedPath: p }))
}));

jest.mock('../src/shared/crossPlatformUtils', () => ({
  ...jest.requireActual('../src/shared/crossPlatformUtils'),
  isUNCPath: jest.fn(() => false),
  isWindowsDeviceNamespacePath: jest.fn(() => false)
}));

jest.mock('../src/main/analysis/semanticExtensionMap', () => ({
  enrichFolderTextForEmbedding: jest.fn((name, desc) => `${name} ${desc || ''}`),
  enrichFileTextForEmbedding: jest.fn((text) => text)
}));

// Resolved so the test reads the same on Windows, macOS and Linux runners.
const FOLDER = path.resolve('/Volumes/SSD');
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(value) {
  Object.defineProperty(process, 'platform', { ...realPlatform, value });
}

describe('Smart Folder folder access messages', () => {
  let fs;
  let safeHandle;
  let scanDirectory;
  let registerSmartFoldersIpc;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    fs = require('fs').promises;
    safeHandle = require('../src/main/ipc/ipcWrappers').safeHandle;
    scanDirectory = jest.fn().mockResolvedValue([]);
    const folders = [];
    const mockLogger = require('../src/shared/logger').createLogger();
    const mockIpcMain = { handle: jest.fn() };
    const foldersService = {
      getCustomFolders: jest.fn(() => folders),
      setCustomFolders: jest.fn((next) => folders.splice(0, folders.length, ...next)),
      saveCustomFolders: jest.fn().mockResolvedValue(),
      scanDirectory
    };
    registerSmartFoldersIpc = require('../src/main/ipc/smartFolders');
    registerSmartFoldersIpc({
      ipcMain: mockIpcMain,
      IPC_CHANNELS,
      ...foldersService,
      foldersService,
      getServiceIntegration: () => null,
      logger: mockLogger,
      core: { ipcMain: mockIpcMain, IPC_CHANNELS, logger: mockLogger },
      folders: foldersService
    });

    fs.stat.mockResolvedValue({ isDirectory: () => true });
    fs.mkdir.mockResolvedValue();
    fs.unlink.mockResolvedValue();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform);
  });

  function getHandler(channel) {
    const call = safeHandle.mock.calls.find((c) => c[1] === channel);
    if (!call) throw new Error(`Handler for ${channel} not registered`);
    return call[2];
  }

  describe('ADD write test', () => {
    test('an existing folder is tested for writing inside itself, not in its parent', async () => {
      // The drive root is writable; its parent (like /Volumes on a Mac) is not.
      fs.writeFile.mockImplementation(async (file) => {
        if (path.dirname(file) === FOLDER) return undefined;
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      });

      const result = await getHandler(IPC_CHANNELS.SMART_FOLDERS.ADD)(
        {},
        { name: 'SSD', path: FOLDER }
      );

      expect(result).toEqual(expect.objectContaining({ success: true }));
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(`${FOLDER}${path.sep}.stratotest_`),
        'test'
      );
    });

    test('a folder that does not exist yet is tested in its parent', async () => {
      const target = path.join(FOLDER, 'Reports');
      fs.writeFile.mockImplementation(async (file) => {
        if (path.dirname(file) === target) {
          throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
        }
        return undefined;
      });

      const result = await getHandler(IPC_CHANNELS.SMART_FOLDERS.ADD)(
        {},
        { name: 'Reports', path: target }
      );

      expect(result).toEqual(expect.objectContaining({ success: true }));
      expect(fs.writeFile).toHaveBeenLastCalledWith(
        expect.stringContaining(`${FOLDER}${path.sep}.stratotest_`),
        'test'
      );
    });

    test('a read-only drive says it is read-only', async () => {
      fs.writeFile.mockRejectedValue(
        Object.assign(new Error('read-only file system'), { code: 'EROFS' })
      );

      const result = await getHandler(IPC_CHANNELS.SMART_FOLDERS.ADD)(
        {},
        { name: 'SSD', path: FOLDER }
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('PARENT_NOT_WRITABLE');
      expect(result.error).toMatch(/read-only/);
    });

    test('on a Mac, a blocked folder points to Privacy & Security', async () => {
      setPlatform('darwin');
      fs.writeFile.mockRejectedValue(
        Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
      );

      const result = await getHandler(IPC_CHANNELS.SMART_FOLDERS.ADD)(
        {},
        { name: 'SSD', path: FOLDER }
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('PARENT_NOT_WRITABLE');
      expect(result.error).toContain('Privacy & Security');
    });
  });

  describe('describeUnwritableFolder', () => {
    test('read-only on a Mac mentions drives formatted for Windows', () => {
      const { describeUnwritableFolder } = registerSmartFoldersIpc;
      expect(describeUnwritableFolder('EROFS', 'darwin')).toMatch(/NTFS/);
      expect(describeUnwritableFolder('EROFS', 'win32')).toMatch(/read-only/);
      expect(describeUnwritableFolder('EROFS', 'win32')).not.toMatch(/NTFS/);
    });

    test('permission errors point to Privacy & Security only on a Mac', () => {
      const { describeUnwritableFolder } = registerSmartFoldersIpc;
      expect(describeUnwritableFolder('EACCES', 'darwin')).toContain('Privacy & Security');
      expect(describeUnwritableFolder('EPERM', 'win32')).not.toContain('Privacy & Security');
      expect(describeUnwritableFolder('EPERM', 'win32')).toMatch(/cannot write/);
      expect(describeUnwritableFolder(undefined, 'linux')).toMatch(/cannot write/);
    });
  });

  describe('SCAN_STRUCTURE on a folder that cannot be opened', () => {
    function blockedScan(code) {
      const items = [
        { name: 'SSD', path: FOLDER, type: 'folder', error: 'Permission Denied', children: [] }
      ];
      Object.defineProperty(items, '__scanMeta', {
        value: { partial: false, reasons: [], rootError: code },
        enumerable: false
      });
      return items;
    }

    test('on a Mac it fails with FOLDER_NOT_READABLE and names Privacy & Security', async () => {
      setPlatform('darwin');
      scanDirectory.mockResolvedValue(blockedScan('EPERM'));

      const result = await getHandler(IPC_CHANNELS.SMART_FOLDERS.SCAN_STRUCTURE)({}, FOLDER);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('FOLDER_NOT_READABLE');
      expect(result.error).toContain('Privacy & Security');
    });

    test('elsewhere it fails with FOLDER_NOT_READABLE and a plain message', async () => {
      setPlatform('win32');
      scanDirectory.mockResolvedValue(blockedScan('EACCES'));

      const result = await getHandler(IPC_CHANNELS.SMART_FOLDERS.SCAN_STRUCTURE)({}, FOLDER);

      expect(result).toEqual({
        success: false,
        errorCode: 'FOLDER_NOT_READABLE',
        error: 'StratoSort cannot open this folder. Check that your account can read it.'
      });
    });

    test('a blocked subfolder still returns the files that could be read', async () => {
      const items = [
        { type: 'file', name: 'a.pdf', path: path.join(FOLDER, 'a.pdf'), size: 1 },
        { type: 'folder', name: 'locked', error: 'Permission Denied', children: [] }
      ];
      Object.defineProperty(items, '__scanMeta', {
        value: { partial: false, reasons: [] },
        enumerable: false
      });
      scanDirectory.mockResolvedValue(items);

      const result = await getHandler(IPC_CHANNELS.SMART_FOLDERS.SCAN_STRUCTURE)({}, FOLDER);

      expect(result.success).toBe(true);
      expect(result.files).toHaveLength(1);
    });
  });
});
