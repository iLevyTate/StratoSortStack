/**
 * @jest-environment node
 *
 * K-08: renaming a smart folder physically moves every file inside it, so the
 * knowledge about those files (history entries, file vectors, chunk vectors,
 * graph ids) must follow. Before the fix `handleSmartFoldersEdit` moved the
 * directory and updated nothing; the next startup reconcile then saw every
 * contained history entry pointing at a path that no longer exists and
 * deleted it.
 *
 * After the fix the handler builds {oldPath,newPath} pairs for every history
 * entry under the old folder and hands them to
 * FilePathCoordinator.batchPathUpdate. A coordinator failure is logged and
 * never fails the rename (the directory move already succeeded).
 */

const { IPC_CHANNELS } = require('../src/shared/constants');

jest.mock('fs', () => ({
  promises: {
    stat: jest.fn(),
    mkdir: jest.fn(),
    writeFile: jest.fn(),
    unlink: jest.fn(),
    rm: jest.fn(),
    rename: jest.fn(),
    access: jest.fn(),
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
    if (typeof handler === 'function') {
      return async (...args) => handler(...args);
    }
    return (fn) => fn;
  }),
  z: {
    object: jest.fn(() => ({ passthrough: jest.fn(() => ({})) })),
    string: jest.fn(() => ({ min: jest.fn(() => ({})), optional: jest.fn(() => ({})) })),
    array: jest.fn(() => ({})),
    any: jest.fn(() => ({})),
    void: jest.fn(() => ({})),
    record: jest.fn(() => ({}))
  }
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

const mockCoordinator = { batchPathUpdate: jest.fn() };
const mockContainer = {
  has: jest.fn(() => true),
  resolve: jest.fn(() => mockCoordinator)
};
jest.mock('../src/main/services/ServiceContainer', () => ({
  container: mockContainer,
  ServiceIds: { FILE_PATH_COORDINATOR: 'filePathCoordinator' }
}));

const OLD_PATH = 'C:\\Users\\Test\\Documents\\Finance';
const NEW_PATH = 'C:\\Users\\Test\\Documents\\Money';

describe('smartFolders rename moves the knowledge with the directory [K-08]', () => {
  let mockFoldersService;
  let mockServiceIntegration;
  let safeHandle;
  let fs;
  let logger;

  function getHandler(channel) {
    const call = safeHandle.mock.calls.find((c) => c[1] === channel);
    if (!call) throw new Error(`Handler for ${channel} not registered`);
    return call[2];
  }

  function armSuccessfulRename() {
    // fs.stat sequence in handleSmartFoldersEdit: parent dir, old path, new path.
    fs.stat
      .mockResolvedValueOnce({ isDirectory: () => true })
      .mockResolvedValueOnce({ isDirectory: () => true })
      .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    fs.stat.mockResolvedValue({ isDirectory: () => true });
    // renameNoReplace probes the destination; ENOENT means it is free.
    fs.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    fs.rename.mockResolvedValue();
    fs.mkdir.mockResolvedValue();
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    fs = require('fs').promises;
    safeHandle = require('../src/main/ipc/ipcWrappers').safeHandle;
    logger = require('../src/shared/logger').createLogger();

    mockContainer.has.mockReturnValue(true);
    mockContainer.resolve.mockReturnValue(mockCoordinator);
    mockCoordinator.batchPathUpdate.mockResolvedValue({
      success: true,
      summary: { total: 2, successful: 2, failed: 0 }
    });

    mockFoldersService = {
      getCustomFolders: jest.fn(() => [
        { id: '1', name: 'Finance', path: OLD_PATH, description: 'Financial docs' }
      ]),
      setCustomFolders: jest.fn(),
      saveCustomFolders: jest.fn().mockResolvedValue(),
      scanDirectory: jest.fn().mockResolvedValue([])
    };

    mockServiceIntegration = {
      smartFolderWatcher: null,
      analysisHistory: {
        getRecentAnalysis: jest.fn().mockResolvedValue([
          { originalPath: `${OLD_PATH}\\tax-2025.pdf`, organization: {} },
          {
            originalPath: 'C:\\Users\\Test\\Downloads\\invoice.pdf',
            organization: { actual: `${OLD_PATH}\\Invoices\\invoice.pdf` }
          },
          { originalPath: 'C:\\Users\\Test\\Documents\\Other\\note.txt', organization: {} }
        ])
      }
    };

    const context = {
      ipcMain: { handle: jest.fn() },
      IPC_CHANNELS,
      ...mockFoldersService,
      foldersService: mockFoldersService,
      getServiceIntegration: () => mockServiceIntegration,
      logger,
      core: { ipcMain: { handle: jest.fn() }, IPC_CHANNELS, logger },
      folders: mockFoldersService
    };

    require('../src/main/ipc/smartFolders')(context);
    armSuccessfulRename();
  });

  test('routes every contained history entry through the path coordinator', async () => {
    const handler = getHandler(IPC_CHANNELS.SMART_FOLDERS.EDIT);

    const result = await handler({}, '1', { path: NEW_PATH });

    expect(result.success).toBe(true);
    expect(fs.rename).toHaveBeenCalledWith(OLD_PATH, NEW_PATH);
    expect(mockContainer.resolve).toHaveBeenCalledWith('filePathCoordinator');
    expect(mockCoordinator.batchPathUpdate).toHaveBeenCalledTimes(1);
    const [pathChanges, options] = mockCoordinator.batchPathUpdate.mock.calls[0];
    expect(pathChanges).toEqual([
      { oldPath: `${OLD_PATH}\\tax-2025.pdf`, newPath: `${NEW_PATH}\\tax-2025.pdf` },
      {
        oldPath: `${OLD_PATH}\\Invoices\\invoice.pdf`,
        newPath: `${NEW_PATH}\\Invoices\\invoice.pdf`
      }
    ]);
    expect(options).toEqual({ type: 'move' });
  });

  test('does nothing when no history entry lives under the renamed folder', async () => {
    mockServiceIntegration.analysisHistory.getRecentAnalysis.mockResolvedValue([
      { originalPath: 'C:\\Users\\Test\\Documents\\Other\\note.txt', organization: {} }
    ]);
    const handler = getHandler(IPC_CHANNELS.SMART_FOLDERS.EDIT);

    const result = await handler({}, '1', { path: NEW_PATH });

    expect(result.success).toBe(true);
    expect(mockCoordinator.batchPathUpdate).not.toHaveBeenCalled();
  });

  test('a coordinator failure is logged and never fails the rename', async () => {
    mockCoordinator.batchPathUpdate.mockRejectedValue(new Error('vector store offline'));
    const handler = getHandler(IPC_CHANNELS.SMART_FOLDERS.EDIT);

    const result = await handler({}, '1', { path: NEW_PATH });

    expect(result.success).toBe(true);
    expect(mockFoldersService.saveCustomFolders).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('relocate knowledge'),
      expect.objectContaining({ oldPath: OLD_PATH, newPath: NEW_PATH })
    );
  });

  test('skips quietly when the coordinator is not registered', async () => {
    mockContainer.has.mockReturnValue(false);
    const handler = getHandler(IPC_CHANNELS.SMART_FOLDERS.EDIT);

    const result = await handler({}, '1', { path: NEW_PATH });

    expect(result.success).toBe(true);
    expect(mockCoordinator.batchPathUpdate).not.toHaveBeenCalled();
  });

  test('does not touch knowledge when the directory was repointed, not renamed', async () => {
    // Destination already exists: handler repoints without moving files.
    fs.stat.mockReset();
    fs.stat.mockResolvedValue({ isDirectory: () => true });
    const handler = getHandler(IPC_CHANNELS.SMART_FOLDERS.EDIT);

    const result = await handler({}, '1', { path: NEW_PATH });

    expect(result.success).toBe(true);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(mockCoordinator.batchPathUpdate).not.toHaveBeenCalled();
  });
});
