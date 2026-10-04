/**
 * @jest-environment node
 *
 * F-188 (K-08): renaming a smart folder moves the directory on disk. Every
 * history entry and vector under it still points at the OLD child paths, so
 * the startup reconcile and the search-time ghost check treat all of them as
 * gone. The rename must re-key that knowledge through the same
 * `FilePathCoordinator.batchPathUpdate` that Organize uses for a move.
 *
 * Harness mirrors smartFolders.rename.toctou.test.js (mocked fs + wrappers).
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

const OLD_PATH = path.join('C:\\Users\\Test\\Documents', 'Finance');
const NEW_PATH = path.join('C:\\Users\\Test\\Documents', 'Money');
const INSIDE_A = path.join(OLD_PATH, 'q1.pdf');
const INSIDE_B = path.join(OLD_PATH, 'deep', 'q2.pdf');
const OUTSIDE = path.join('C:\\Users\\Test\\Documents', 'Other', 'x.pdf');
const PREFIX_TRAP = path.join('C:\\Users\\Test\\Documents', 'FinanceOld', 'y.pdf');

describe('smart folder rename re-keys the knowledge under it [F-188]', () => {
  let safeHandle;
  let fs;
  let coordinator;
  let historyEntries;

  function getHandler(channel) {
    const call = safeHandle.mock.calls.find((c) => c[1] === channel);
    if (!call) throw new Error(`Handler for ${channel} not registered`);
    return call[2];
  }

  function register({ withCoordinator = true } = {}) {
    const mockLogger = require('../src/shared/logger').createLogger();
    const foldersService = {
      getCustomFolders: jest.fn(() => [
        { id: '1', name: 'Finance', path: OLD_PATH, description: 'Financial docs' }
      ]),
      setCustomFolders: jest.fn(),
      saveCustomFolders: jest.fn().mockResolvedValue(),
      scanDirectory: jest.fn().mockResolvedValue([])
    };
    const serviceIntegration = {
      smartFolderWatcher: null,
      analysisHistory: { analysisHistory: { entries: historyEntries } }
    };
    const context = {
      ipcMain: { handle: jest.fn() },
      IPC_CHANNELS,
      ...foldersService,
      foldersService,
      getServiceIntegration: () => serviceIntegration,
      getFilePathCoordinator: () => (withCoordinator ? coordinator : null),
      logger: mockLogger,
      core: { ipcMain: { handle: jest.fn() }, IPC_CHANNELS, logger: mockLogger },
      folders: foldersService
    };
    require('../src/main/ipc/smartFolders')(context);
    return mockLogger;
  }

  function armSuccessfulRename() {
    // stat: parent of newPath -> dir; oldPath -> dir; newPath -> ENOENT
    fs.stat
      .mockResolvedValueOnce({ isDirectory: () => true })
      .mockResolvedValueOnce({ isDirectory: () => true })
      .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    // renameNoReplace probes the destination: ENOENT means free.
    fs.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    fs.rename.mockResolvedValue();
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    fs = require('fs').promises;
    safeHandle = require('../src/main/ipc/ipcWrappers').safeHandle;
    coordinator = {
      batchPathUpdate: jest.fn(async (changes) => ({
        success: true,
        results: [],
        summary: { total: changes.length, successful: changes.length, failed: 0 }
      }))
    };
    historyEntries = {
      a: { originalPath: INSIDE_A },
      b: {
        originalPath: path.join('C:\\elsewhere', 'moved.pdf'),
        organization: { actual: INSIDE_B }
      },
      c: { originalPath: OUTSIDE },
      d: { originalPath: PREFIX_TRAP },
      e: { originalPath: null }
    };
  });

  test('every history entry under the old folder is re-keyed to the new folder (and nothing else)', async () => {
    register();
    armSuccessfulRename();
    const handler = getHandler(IPC_CHANNELS.SMART_FOLDERS.EDIT);

    const result = await handler({}, '1', { path: NEW_PATH });

    expect(result.success).toBe(true);
    expect(fs.rename).toHaveBeenCalledTimes(1);
    expect(coordinator.batchPathUpdate).toHaveBeenCalledTimes(1);
    const [changes, options] = coordinator.batchPathUpdate.mock.calls[0];
    expect(options).toEqual(expect.objectContaining({ type: 'move' }));
    // Separator-agnostic: other suites in the same worker can leave `path`
    // in posix mode, which only changes the slash the handler joins with.
    const norm = (p) => String(p).replace(/\\/g, '/');
    const normalized = changes.map((c) => ({ oldPath: norm(c.oldPath), newPath: norm(c.newPath) }));
    expect(normalized).toEqual(
      expect.arrayContaining([
        { oldPath: norm(INSIDE_A), newPath: norm(path.join(NEW_PATH, 'q1.pdf')) },
        { oldPath: norm(INSIDE_B), newPath: norm(path.join(NEW_PATH, 'deep', 'q2.pdf')) }
      ])
    );
    expect(changes).toHaveLength(2);
  });

  test('a rename with no knowledge under the folder does not call the coordinator', async () => {
    historyEntries = { c: { originalPath: OUTSIDE } };
    register();
    armSuccessfulRename();
    const handler = getHandler(IPC_CHANNELS.SMART_FOLDERS.EDIT);

    const result = await handler({}, '1', { path: NEW_PATH });

    expect(result.success).toBe(true);
    expect(coordinator.batchPathUpdate).not.toHaveBeenCalled();
  });

  test('a remap failure is logged, never turned into a failed rename (the directory already moved)', async () => {
    coordinator.batchPathUpdate = jest.fn(async () => ({
      success: false,
      errors: [{ system: 'vectorDb', error: 'boom' }],
      summary: { total: 2, successful: 0, failed: 2 }
    }));
    const logger = register();
    armSuccessfulRename();
    const handler = getHandler(IPC_CHANNELS.SMART_FOLDERS.EDIT);

    const result = await handler({}, '1', { path: NEW_PATH });

    expect(result.success).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/knowledge/i),
      expect.objectContaining({ oldPath: OLD_PATH, newPath: NEW_PATH })
    );
  });

  test('without a coordinator the rename still succeeds and the gap is logged', async () => {
    const logger = register({ withCoordinator: false });
    armSuccessfulRename();
    const handler = getHandler(IPC_CHANNELS.SMART_FOLDERS.EDIT);

    const result = await handler({}, '1', { path: NEW_PATH });

    expect(result.success).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/knowledge/i),
      expect.objectContaining({ oldPath: OLD_PATH })
    );
  });

  test('a repoint (destination already exists, nothing moved) does not re-key anything', async () => {
    register();
    // stat: parent -> dir; oldPath -> dir; newPath -> dir (already exists)
    fs.stat
      .mockResolvedValueOnce({ isDirectory: () => true })
      .mockResolvedValueOnce({ isDirectory: () => true })
      .mockResolvedValueOnce({ isDirectory: () => true });
    const handler = getHandler(IPC_CHANNELS.SMART_FOLDERS.EDIT);

    const result = await handler({}, '1', { path: NEW_PATH });

    expect(result.success).toBe(true);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(coordinator.batchPathUpdate).not.toHaveBeenCalled();
  });
});
