/**
 * @jest-environment node
 *
 * A Smart Folder root that is neither under Documents, beside an existing
 * root nor picked in a dialog is confirmed in a main-process message box.
 * SMART_FOLDERS.EDIT runs on the default 30 s invoke timeout, so a user who
 * reads that box for longer has already been shown a failure by the time
 * they answer: the preload rejected and the registry aborted
 * event.abortSignal. The box must close with the request and a late "Allow"
 * must not rename the folder on disk or rewrite the list.
 */
'use strict';

const path = require('path');

const DOCUMENTS = path.resolve(path.sep, 'Users', 'Test', 'Documents');
const WORK = path.join(DOCUMENTS, 'Work');
const UNCATEGORIZED = path.join(DOCUMENTS, 'Uncategorized');
const ELSEWHERE = path.resolve(path.sep, 'Archive', 'Taxes');

jest.mock('fs', () => ({
  promises: {
    stat: jest.fn(),
    mkdir: jest.fn(),
    writeFile: jest.fn(),
    unlink: jest.fn(),
    rm: jest.fn(),
    rename: jest.fn(),
    readdir: jest.fn(),
    realpath: jest.fn(async (p) => p)
  }
}));

const mockShowMessageBox = jest.fn();
jest.mock('electron', () => {
  const nodePath = require('path');
  const documents = nodePath.resolve(nodePath.sep, 'Users', 'Test', 'Documents');
  return {
    app: {
      isPackaged: true,
      getPath: jest.fn((name) => {
        if (name === 'documents') return documents;
        if (name === 'downloads')
          return nodePath.resolve(nodePath.sep, 'Users', 'Test', 'Downloads');
        if (name === 'userData') return nodePath.resolve(nodePath.sep, 'Users', 'Test', 'AppData');
        return '';
      })
    },
    dialog: { showMessageBox: (...args) => mockShowMessageBox(...args) },
    BrowserWindow: { getAllWindows: jest.fn(() => []) }
  };
});

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
const mockRenameNoReplace = jest.fn(async () => undefined);
jest.mock('../src/shared/atomicFileOperations', () => ({
  ...jest.requireActual('../src/shared/atomicFileOperations'),
  renameNoReplace: (...args) => mockRenameNoReplace(...args)
}));

const { IPC_CHANNELS } = require('../src/shared/constants');

describe('Smart Folder root confirmation follows the request abort', () => {
  let fs;
  let safeHandle;
  let foldersService;
  let policy;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    delete process.env.STRATOSORT_E2E;

    fs = require('fs').promises;
    // The old root is a directory, the new one does not exist yet: the shape
    // in which the edit renames the folder on disk.
    fs.stat.mockImplementation(async (p) => {
      if (p === ELSEWHERE) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { isDirectory: () => true };
    });
    safeHandle = require('../src/main/ipc/ipcWrappers').safeHandle;
    require('../src/main/services/FolderMatchingService').getInstance.mockReturnValue({
      initialize: jest.fn().mockResolvedValue(),
      embedText: jest.fn().mockResolvedValue({ vector: [0.1], model: 'test-model' }),
      generateFolderId: jest.fn(() => 'test-id')
    });
    require('../src/main/services/ParallelEmbeddingService').getInstance.mockReturnValue({
      batchEmbedTexts: jest.fn().mockResolvedValue({ results: [], errors: [], stats: {} })
    });
    require('../src/main/services/LlamaService').getInstance.mockReturnValue({
      initialize: jest.fn().mockResolvedValue(),
      generateText: jest.fn().mockResolvedValue({ response: '{}' }),
      getConfig: jest.fn().mockResolvedValue({})
    });

    const folderState = [
      { id: '1', name: 'Work', path: WORK, description: 'Work stuff' },
      { id: 'default-uncategorized', name: 'Uncategorized', isDefault: true, path: UNCATEGORIZED }
    ];
    foldersService = {
      getCustomFolders: jest.fn(() => folderState),
      setCustomFolders: jest.fn(),
      saveCustomFolders: jest.fn().mockResolvedValue(),
      scanDirectory: jest.fn().mockResolvedValue([])
    };
    const logger = require('../src/shared/logger').createLogger();
    const ipcMain = { handle: jest.fn() };
    require('../src/main/ipc/smartFolders')({
      ipcMain,
      IPC_CHANNELS,
      ...foldersService,
      foldersService,
      getServiceIntegration: () => ({ smartFolderWatcher: null }),
      getMainWindow: () => null,
      logger,
      core: { ipcMain, IPC_CHANNELS, logger },
      folders: foldersService
    });
    policy = require('../src/main/ipc/files/destinationPolicy');
    policy._resetDestinationPolicyForTests();
  });

  function getHandler(channel) {
    const call = safeHandle.mock.calls.find((c) => c[1] === channel);
    if (!call) throw new Error(`Handler for ${channel} not registered`);
    return call[2];
  }

  test('an edit the renderer gave up on while the dialog was open is refused even when the user then allows, and nothing moves', async () => {
    const controller = new AbortController();
    mockShowMessageBox.mockImplementation(async () => {
      // The 30 s invoke timeout fires while the box is open; the user clicks
      // "Allow for this session" afterwards.
      controller.abort();
      return { response: 0 };
    });

    const result = await getHandler(IPC_CHANNELS.SMART_FOLDERS.EDIT)(
      { abortSignal: controller.signal },
      '1',
      { path: ELSEWHERE }
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        errorCode: policy.DESTINATION_ERROR_CODES.ABORTED
      })
    );
    // The signal reaches Electron so the box closes with the request.
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
    expect(mockShowMessageBox.mock.calls[0].at(-1).signal).toBe(controller.signal);
    // No directory is created, renamed or recorded for the abandoned request.
    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(mockRenameNoReplace).not.toHaveBeenCalled();
    expect(foldersService.setCustomFolders).not.toHaveBeenCalled();
    expect(foldersService.saveCustomFolders).not.toHaveBeenCalled();
    // And the late answer did not approve the folder for the session either.
    expect(policy.getAllowedDestinationRoots().some((r) => r.reason === 'session-folder')).toBe(
      false
    );
  });

  test('a request already aborted never opens the dialog when adding a folder', async () => {
    const controller = new AbortController();
    controller.abort();
    mockShowMessageBox.mockResolvedValue({ response: 0 });

    const result = await getHandler(IPC_CHANNELS.SMART_FOLDERS.ADD)(
      { abortSignal: controller.signal },
      { name: 'Taxes', path: ELSEWHERE }
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        errorCode: policy.DESTINATION_ERROR_CODES.ABORTED
      })
    );
    expect(mockShowMessageBox).not.toHaveBeenCalled();
    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(foldersService.saveCustomFolders).not.toHaveBeenCalled();
  });
});
