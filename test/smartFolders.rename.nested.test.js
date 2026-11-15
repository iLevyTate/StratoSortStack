/**
 * @jest-environment node
 *
 * Renaming a parent Smart Folder moves its directory on disk, and every Smart
 * Folder nested inside it moves along. Only the edited folder's record was
 * updated, so the nested ones kept the old path and the next organize into
 * them recreated the old tree (mkdir recursive) beside the renamed one.
 *
 * Harness mirrors smartFolders.rename.remap.test.js (mocked fs + wrappers).
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

jest.mock('../src/main/services/FolderMatchingService', () => ({ getInstance: jest.fn() }));
jest.mock('../src/main/services/ParallelEmbeddingService', () => ({ getInstance: jest.fn() }));
jest.mock('../src/main/services/LlamaService', () => ({ getInstance: jest.fn() }));
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

const DOCS = path.join('C:\\Users\\Test\\Documents');
const OLD_PATH = path.join(DOCS, 'Finance');
const NEW_PATH = path.join(DOCS, 'Money');

describe('smart folder rename re-points the Smart Folders nested under it', () => {
  let safeHandle;
  let fs;
  let watcher;

  function getHandler(channel) {
    const call = safeHandle.mock.calls.find((c) => c[1] === channel);
    if (!call) throw new Error(`Handler for ${channel} not registered`);
    return call[2];
  }

  function register(folders) {
    const mockLogger = require('../src/shared/logger').createLogger();
    const foldersService = {
      getCustomFolders: jest.fn(() => folders.map((f) => ({ ...f }))),
      setCustomFolders: jest.fn(),
      saveCustomFolders: jest.fn().mockResolvedValue(),
      scanDirectory: jest.fn().mockResolvedValue([])
    };
    const serviceIntegration = {
      smartFolderWatcher: watcher,
      analysisHistory: { analysisHistory: { entries: {} } }
    };
    const context = {
      ipcMain: { handle: jest.fn() },
      IPC_CHANNELS,
      ...foldersService,
      foldersService,
      getServiceIntegration: () => serviceIntegration,
      getFilePathCoordinator: () => null,
      logger: mockLogger,
      core: { ipcMain: { handle: jest.fn() }, IPC_CHANNELS, logger: mockLogger },
      folders: foldersService
    };
    require('../src/main/ipc/smartFolders')(context);
    return foldersService;
  }

  const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

  // Folder ids map to paths; the saved list is what the handler persisted.
  function savedPaths(foldersService) {
    const [saved] = foldersService.saveCustomFolders.mock.calls[0];
    return Object.fromEntries(saved.map((f) => [f.id, f.path]));
  }

  const folders = [
    { id: 'parent', name: 'Finance', path: OLD_PATH },
    { id: 'child', name: 'Taxes', path: path.join(OLD_PATH, 'Taxes') },
    // Stored with different case: NTFS treats it as the same directory.
    {
      id: 'grandchild',
      name: 'Receipts',
      path: 'c:\\users\\test\\documents\\finance\\Taxes\\Receipts'
    },
    { id: 'prefixTrap', name: 'Archive', path: path.join(DOCS, 'FinanceOld') },
    { id: 'sibling', name: 'Other', path: path.join(DOCS, 'Other') }
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    fs = require('fs').promises;
    safeHandle = require('../src/main/ipc/ipcWrappers').safeHandle;
    watcher = {
      isRunning: true,
      updateWatchedFolders: jest.fn(async () => {}),
      scanFolderForUnanalyzedFiles: jest.fn(async () => ({ scanned: 0, queued: 0 }))
    };
  });

  test('nested folders follow the renamed directory; prefix look-alikes and siblings do not', async () => {
    const foldersService = register(folders);
    // stat: parent of newPath -> dir; oldPath -> dir; newPath -> ENOENT
    fs.stat
      .mockResolvedValueOnce({ isDirectory: () => true })
      .mockResolvedValueOnce({ isDirectory: () => true })
      .mockRejectedValueOnce(enoent());
    fs.access.mockRejectedValue(enoent());
    fs.rename.mockResolvedValue();

    const result = await getHandler(IPC_CHANNELS.SMART_FOLDERS.EDIT)(
      {},
      'parent',
      { path: NEW_PATH },
      { pathChange: 'move' }
    );

    expect(result.success).toBe(true);
    expect(fs.rename).toHaveBeenCalledTimes(1);
    const norm = (p) => String(p).replace(/\\/g, '/');
    const paths = savedPaths(foldersService);
    expect(norm(paths.child)).toBe(norm(path.join(NEW_PATH, 'Taxes')));
    expect(norm(paths.grandchild)).toBe(norm(path.join(NEW_PATH, 'Taxes', 'Receipts')));
    expect(paths.prefixTrap).toBe(path.join(DOCS, 'FinanceOld'));
    expect(paths.sibling).toBe(path.join(DOCS, 'Other'));

    // The watcher is handed the list with the new nested paths.
    const [watched] = watcher.updateWatchedFolders.mock.calls[0];
    const watchedChild = watched.find((f) => f.id === 'child');
    expect(norm(watchedChild.path)).toBe(norm(path.join(NEW_PATH, 'Taxes')));
  });

  test('a repoint onto an existing directory (no rename on disk) leaves nested folders alone', async () => {
    const foldersService = register(folders);
    // stat: parent of newPath -> dir; oldPath -> dir; newPath -> existing dir
    fs.stat
      .mockResolvedValueOnce({ isDirectory: () => true })
      .mockResolvedValueOnce({ isDirectory: () => true })
      .mockResolvedValueOnce({ isDirectory: () => true });

    const result = await getHandler(IPC_CHANNELS.SMART_FOLDERS.EDIT)(
      {},
      'parent',
      { path: NEW_PATH },
      { pathChange: 'move' }
    );

    expect(result.success).toBe(true);
    expect(fs.rename).not.toHaveBeenCalled();
    const paths = savedPaths(foldersService);
    expect(paths.child).toBe(path.join(OLD_PATH, 'Taxes'));
    expect(paths.grandchild).toBe('c:\\users\\test\\documents\\finance\\Taxes\\Receipts');
  });
});
