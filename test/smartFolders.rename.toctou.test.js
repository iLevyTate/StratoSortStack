/**
 * @jest-environment node
 *
 * Regression guard for the smartFolders directory-rename TOCTOU overwrite
 * window (Position 04 audit gap A). Before the fix, `handleSmartFoldersEdit`
 * ran `!newExists` preflight, then went through an async validation, then
 * called bare `fs.rename(oldPath, newPath)`. POSIX/NTFS rename silently
 * overwrites an occupied destination, so any process that squats on newPath
 * during the widened preflight-to-rename window destroys the squatter's data.
 *
 * The fix routes through `renameNoReplace` from atomicFileOperations, which
 * probes destination existence *inside its own critical section* immediately
 * before the rename and throws EEXIST when occupied — closing the window as
 * much as libuv permits and letting the handler return a structured refusal
 * (`errorCode: RENAME_FAILED`) instead of silently overwriting.
 *
 * This test simulates a race by mocking fs so that:
 *   - smartFolders' own `fs.stat(newPath)` still sees ENOENT at preflight
 *   - `renameNoReplace`'s `fs.access(newPath)` succeeds (dest was squatted)
 *   - bare `fs.rename` (the fails-before path) succeeds unconditionally
 *
 * Fails-before: handler returns `{ success: true }` because bare fs.rename
 * silently overwrites → this test's `success: false` assertion FAILS.
 * Passes-after: renameNoReplace throws EEXIST, handler catches and returns
 * `{ success: false, errorCode: 'RENAME_FAILED' }` → test PASSES.
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

describe('smartFolders directory rename TOCTOU overwrite guard [Position 04 Gap A]', () => {
  let mockIpcMain;
  let mockFoldersService;
  let mockServiceIntegration;
  let safeHandle;
  let registerSmartFoldersIpc;
  let fs;

  function getHandler(channel) {
    const call = safeHandle.mock.calls.find((c) => c[1] === channel);
    if (!call) throw new Error(`Handler for ${channel} not registered`);
    return call[2];
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    fs = require('fs').promises;
    safeHandle = require('../src/main/ipc/ipcWrappers').safeHandle;

    mockFoldersService = {
      getCustomFolders: jest.fn(() => [
        {
          id: '1',
          name: 'Finance',
          path: 'C:\\Users\\Test\\Documents\\Finance',
          description: 'Financial docs'
        }
      ]),
      setCustomFolders: jest.fn(),
      saveCustomFolders: jest.fn().mockResolvedValue(),
      scanDirectory: jest.fn().mockResolvedValue([])
    };

    mockServiceIntegration = { smartFolderWatcher: null };

    mockIpcMain = { handle: jest.fn() };
    const mockLogger = require('../src/shared/logger').createLogger();

    const context = {
      ipcMain: mockIpcMain,
      IPC_CHANNELS,
      ...mockFoldersService,
      foldersService: mockFoldersService,
      getServiceIntegration: () => mockServiceIntegration,
      logger: mockLogger,
      core: { ipcMain: mockIpcMain, IPC_CHANNELS, logger: mockLogger },
      folders: mockFoldersService
    };

    registerSmartFoldersIpc = require('../src/main/ipc/smartFolders');
    registerSmartFoldersIpc(context);
  });

  test('refuses to overwrite when destination is occupied between preflight and rename', async () => {
    const handler = getHandler(IPC_CHANNELS.SMART_FOLDERS.EDIT);

    const oldPath = 'C:\\Users\\Test\\Documents\\Finance';
    const newPath = 'C:\\Users\\Test\\Documents\\Money';

    // fs.stat sequence during handleSmartFoldersEdit:
    //   1) parentStats = fs.stat(parentDir of newPath)   -> directory
    //   2) oldStats    = fs.stat(oldPath)                -> directory (exists)
    //   3) newStats    = fs.stat(newPath)                -> ENOENT   (preflight sees free)
    fs.stat
      .mockResolvedValueOnce({ isDirectory: () => true })
      .mockResolvedValueOnce({ isDirectory: () => true })
      .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    // renameNoReplace calls fs.access(newPath) immediately before the rename.
    // Access succeeding means dest is now occupied (a squatter took it during
    // the widened preflight window). Only the fixed handler reaches this.
    fs.access.mockResolvedValue();

    // Bare fs.rename (the origin/main path) succeeds unconditionally,
    // silently replacing the squatter — this is the very bug we're guarding.
    fs.rename.mockResolvedValue();

    const result = await handler({}, '1', { path: newPath });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('RENAME_FAILED');
    // The state must NOT be persisted when the rename is refused.
    expect(mockFoldersService.saveCustomFolders).not.toHaveBeenCalled();

    // Under the fix, bare fs.rename should never fire because renameNoReplace
    // throws EEXIST before it. Under origin/main, fs.rename fires exactly once
    // and this assertion catches the silent overwrite.
    expect(fs.rename).not.toHaveBeenCalledWith(oldPath, newPath);
  });
});
