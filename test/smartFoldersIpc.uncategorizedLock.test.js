/**
 * @jest-environment node
 */
const path = require('path');
const { IpcServiceContext } = require('../src/main/ipc/IpcServiceContext');
const { IPC_CHANNELS } = require('../src/shared/constants');

// Mock dependencies
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
    getPath: jest.fn((name) => {
      if (name === 'documents') return 'C:\\Users\\Test\\Documents';
      if (name === 'downloads') return 'C:\\Users\\Test\\Downloads';
      return '';
    })
  },
  BrowserWindow: {
    getAllWindows: jest.fn(() => [{ isDestroyed: () => false, webContents: { send: jest.fn() } }])
  }
}));

const mockAuthorizeSmartFolderRoot = jest.fn(async () => ({ allowed: true, reason: 'test' }));
jest.mock('../src/main/ipc/files/destinationPolicy', () => ({
  ...jest.requireActual('../src/main/ipc/files/destinationPolicy'),
  authorizeSmartFolderRoot: (...args) => mockAuthorizeSmartFolderRoot(...args)
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
  withErrorLogging: jest.fn((logger, handler) => {
    // If handler is passed as second arg, return it (wrapped)
    // If called with just logger, return a wrapper function
    if (typeof handler === 'function') {
      return async (...args) => {
        try {
          return await handler(...args);
        } catch (e) {
          // If logger.error is mocked, we can verify it's called
          logger.error(e);
          throw e; // Re-throw to let test see it or safeHandle catch it
        }
      };
    }
    return (fn) => fn;
  })
}));

jest.mock('../src/main/services/FolderMatchingService', () => ({
  getInstance: jest.fn()
}));

jest.mock('../src/main/services/ParallelEmbeddingService', () => ({
  getInstance: jest.fn()
}));

jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: jest.fn()
}));

jest.mock('../src/main/services/SmartFoldersLLMService', () => ({
  enhanceSmartFolderWithLLM: jest.fn()
}));

jest.mock('../src/main/utils/jsonRepair', () => ({
  extractAndParseJSON: jest.fn((json) => JSON.parse(json))
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
describe('Smart Folders IPC: the Uncategorized catch-all', () => {
  let mockFoldersService;
  let mockServiceIntegration;
  let safeHandle;
  let fs;
  let folders;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    fs = require('fs').promises;
    safeHandle = require('../src/main/ipc/ipcWrappers').safeHandle;
    const FolderMatchingService = require('../src/main/services/FolderMatchingService');
    const ParallelEmbeddingService = require('../src/main/services/ParallelEmbeddingService');
    FolderMatchingService.getInstance.mockReturnValue({
      initialize: jest.fn().mockResolvedValue(),
      embedText: jest.fn().mockResolvedValue({ vector: [0.1, 0.2, 0.3], model: 'test-model' }),
      generateFolderId: jest.fn(() => 'test-id')
    });
    ParallelEmbeddingService.getInstance.mockReturnValue({
      batchEmbedTexts: jest.fn().mockImplementation(async (items) => ({
        results: items.map((item) => ({ id: item.id, success: true, vector: [0.1, 0, 0] })),
        errors: [],
        stats: {}
      }))
    });

    folders = [
      { id: '1', name: 'Work', path: 'C:\\Users\\Test\\Documents\\Work', description: 'Work' },
      {
        id: 'default-uncategorized',
        name: 'Uncategorized',
        isDefault: true,
        category: 'uncategorized',
        path: 'C:\\Users\\Test\\Documents\\Uncategorized'
      }
    ];
    mockFoldersService = {
      getCustomFolders: jest.fn(() => folders),
      setCustomFolders: jest.fn(),
      saveCustomFolders: jest.fn().mockResolvedValue(),
      scanDirectory: jest.fn().mockResolvedValue([])
    };
    mockServiceIntegration = { smartFolderWatcher: null };

    const mockIpcMain = { handle: jest.fn() };
    const mockLogger = require('../src/shared/logger').createLogger();
    const registerSmartFoldersIpc = require('../src/main/ipc/smartFolders');
    registerSmartFoldersIpc({
      ipcMain: mockIpcMain,
      IPC_CHANNELS,
      ...mockFoldersService,
      foldersService: mockFoldersService,
      getServiceIntegration: () => mockServiceIntegration,
      logger: mockLogger,
      core: { ipcMain: mockIpcMain, IPC_CHANNELS, logger: mockLogger },
      folders: mockFoldersService
    });
  });

  function getHandler(channel) {
    const call = safeHandle.mock.calls.find((c) => c[1] === channel);
    if (!call) throw new Error(`Handler for ${channel} not registered`);
    return call[2];
  }

  test('EDIT refuses renaming the Uncategorized folder', async () => {
    const result = await getHandler(IPC_CHANNELS.SMART_FOLDERS.EDIT)({}, 'default-uncategorized', {
      ...folders[1],
      name: 'Strato test Data'
    });

    expect(result).toMatchObject({
      success: false,
      error:
        'Uncategorized holds files that fit no other folder. You can change where it is kept, but not its name.',
      errorCode: 'INVALID_FOLDER_DATA'
    });
    expect(mockFoldersService.setCustomFolders).not.toHaveBeenCalled();
    expect(mockFoldersService.saveCustomFolders).not.toHaveBeenCalled();
  });

  test('EDIT still lets the Uncategorized folder change path', async () => {
    fs.stat.mockResolvedValue({ isDirectory: () => true });
    const newPath = path.join('C:\\Users\\Test\\Documents', 'Catch all');

    const result = await getHandler(IPC_CHANNELS.SMART_FOLDERS.EDIT)({}, 'default-uncategorized', {
      ...folders[1],
      path: newPath
    });

    expect(result.success).toBe(true);
    expect(result.folder).toMatchObject({ name: 'Uncategorized', path: newPath });
  });

  test('EDIT keeps a description change on the Uncategorized folder', async () => {
    const result = await getHandler(IPC_CHANNELS.SMART_FOLDERS.EDIT)({}, 'default-uncategorized', {
      name: 'Uncategorized',
      description: 'Anything that fits no other folder'
    });
    expect(result.success).toBe(true);
  });

  test('DELETE refuses a catch-all that has category uncategorized under another name', async () => {
    folders[1] = { ...folders[1], name: 'Strato test Data' };

    const result = await getHandler(IPC_CHANNELS.SMART_FOLDERS.DELETE)({}, 'default-uncategorized');

    expect(result.success).toBe(false);
    expect(mockFoldersService.setCustomFolders).not.toHaveBeenCalled();
  });

  test('SAVE accepts a list whose catch-all was renamed in an older build', async () => {
    fs.stat.mockResolvedValue({ isDirectory: () => true });
    const renamed = [folders[0], { ...folders[1], name: 'Strato test Data' }];

    const result = await getHandler(IPC_CHANNELS.SMART_FOLDERS.SAVE)({}, renamed);

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
  });

  test('UPDATE_CUSTOM accepts a list whose catch-all was renamed in an older build', async () => {
    fs.stat.mockResolvedValue({ isDirectory: () => true });
    const renamed = [folders[0], { ...folders[1], name: 'Strato test Data' }];

    const result = await getHandler(IPC_CHANNELS.SMART_FOLDERS.UPDATE_CUSTOM)({}, renamed);

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
  });
});
