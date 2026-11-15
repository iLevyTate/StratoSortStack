/**
 * @jest-environment node
 *
 * Changing a Smart Folder's path to a folder that does not exist yet used to
 * move the old folder there, files and all, without asking. The edit now
 * changes nothing and asks (PATH_CHANGE_CHOICE_REQUIRED) until the caller
 * says 'move' (take the old folder and its files along) or 'new' (start with
 * a new empty folder, leave the old one where it is).
 *
 * Harness mirrors smartFolders.rename.nested.test.js (mocked fs + wrappers),
 * with fs.stat answering from a set of folders that exist.
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
    getPath: jest.fn((name) => (name === 'documents' ? '/Users/alex/Documents' : ''))
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

// path.resolve gives an absolute path on every platform (C:\Users\alex on
// Windows, /Users/alex elsewhere).
const DOCS = path.resolve('/Users/alex/Documents');
const OLD_PATH = path.join(DOCS, 'Reports');
const NEW_PATH = path.join(DOCS, 'Work', 'Reports 2026');

describe('editing a Smart Folder path to a folder that does not exist yet', () => {
  let safeHandle;
  let fs;
  /** Folders that exist, keyed by path.resolve. */
  let existing;

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
      smartFolderWatcher: {
        isRunning: true,
        updateWatchedFolders: jest.fn(async () => {}),
        scanFolderForUnanalyzedFiles: jest.fn(async () => ({ scanned: 0, queued: 0 }))
      },
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
  const edit = (...args) => getHandler(IPC_CHANNELS.SMART_FOLDERS.EDIT)({}, ...args);
  const savedFolder = (foldersService, id) =>
    foldersService.saveCustomFolders.mock.calls[0][0].find((f) => f.id === id);

  const reports = {
    id: 'reports',
    name: 'Reports',
    path: OLD_PATH,
    description: 'Quarterly reports',
    inPlaceFiles: 'skip'
  };
  const nested = { id: 'drafts', name: 'Drafts', path: path.join(OLD_PATH, 'Drafts') };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    fs = require('fs').promises;
    safeHandle = require('../src/main/ipc/ipcWrappers').safeHandle;
    existing = new Set([DOCS, path.dirname(NEW_PATH), OLD_PATH].map((p) => path.resolve(p)));
    fs.stat.mockImplementation(async (p) => {
      if (existing.has(path.resolve(p))) return { isDirectory: () => true };
      throw enoent();
    });
    fs.access.mockRejectedValue(enoent());
    fs.rename.mockResolvedValue();
    fs.mkdir.mockResolvedValue();
  });

  test('without a choice nothing changes, and the reply names both folders', async () => {
    const foldersService = register([reports, nested]);

    const result = await edit('reports', { path: NEW_PATH });

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        errorCode: 'PATH_CHANGE_CHOICE_REQUIRED',
        oldPath: OLD_PATH,
        newPath: NEW_PATH
      })
    );
    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(foldersService.saveCustomFolders).not.toHaveBeenCalled();
    // Asked before the destination policy, which can show its own prompt.
    expect(mockAuthorizeSmartFolderRoot).not.toHaveBeenCalled();
  });

  test("'move' moves the old folder and its files to the new path", async () => {
    const foldersService = register([reports, nested]);

    const result = await edit('reports', { path: NEW_PATH }, { pathChange: 'move' });

    expect(result.success).toBe(true);
    expect(result.movedFolder).toBe(true);
    expect(fs.rename).toHaveBeenCalledWith(OLD_PATH, NEW_PATH);
    expect(savedFolder(foldersService, 'reports').path).toBe(NEW_PATH);
    // The nested Smart Folder moved with it.
    expect(savedFolder(foldersService, 'drafts').path).toBe(path.join(NEW_PATH, 'Drafts'));
  });

  test("'new' creates an empty folder and leaves the old one and its files where they are", async () => {
    const foldersService = register([reports, nested]);

    const result = await edit('reports', { path: NEW_PATH }, { pathChange: 'new' });

    expect(result.success).toBe(true);
    expect(result.movedFolder).toBe(false);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.mkdir).toHaveBeenCalledWith(NEW_PATH, { recursive: true });
    expect(savedFolder(foldersService, 'reports').path).toBe(NEW_PATH);
    // Nothing moved, so the nested Smart Folder keeps its path.
    expect(savedFolder(foldersService, 'drafts').path).toBe(path.join(OLD_PATH, 'Drafts'));
  });

  test('the user settings on the folder are kept through a path change', async () => {
    const foldersService = register([reports]);

    await edit('reports', { path: NEW_PATH }, { pathChange: 'new' });

    expect(savedFolder(foldersService, 'reports')).toEqual(
      expect.objectContaining({ description: 'Quarterly reports', inPlaceFiles: 'skip' })
    );
  });

  test('a new path that already exists needs no choice: the folder is pointed there', async () => {
    existing.add(path.resolve(NEW_PATH));
    const foldersService = register([reports]);

    const result = await edit('reports', { path: NEW_PATH });

    expect(result.success).toBe(true);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(savedFolder(foldersService, 'reports').path).toBe(NEW_PATH);
  });

  test('an old folder that is gone needs no choice: the new one is created', async () => {
    existing.delete(path.resolve(OLD_PATH));
    const foldersService = register([reports]);

    const result = await edit('reports', { path: NEW_PATH });

    expect(result.success).toBe(true);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.mkdir).toHaveBeenCalledWith(NEW_PATH, { recursive: true });
    expect(savedFolder(foldersService, 'reports').path).toBe(NEW_PATH);
  });

  test('the same folder spelled with a trailing separator or other slashes is not a path change', async () => {
    const respellings = [`${OLD_PATH}${path.sep}`, OLD_PATH.split(path.sep).join('/')];
    for (const spelling of respellings) {
      jest.clearAllMocks();
      const foldersService = register([reports]);
      const result = await edit('reports', { path: spelling });
      expect(result.success).toBe(true);
      expect(fs.rename).not.toHaveBeenCalled();
      expect(foldersService.saveCustomFolders).toHaveBeenCalled();
    }
  });

  describe('on a case-insensitive volume', () => {
    const realPlatform = process.platform;
    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: realPlatform });
    });

    test('a change of case is the same folder, not a move', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const foldersService = register([reports]);

      const result = await edit('reports', { path: OLD_PATH.toUpperCase() });

      expect(result.success).toBe(true);
      expect(result.errorCode).toBeUndefined();
      expect(fs.rename).not.toHaveBeenCalled();
      expect(foldersService.saveCustomFolders).toHaveBeenCalled();
    });

    test('on macOS a decomposed accent is the same folder as the composed one', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      const composed = path.join(DOCS, 'Caf\u00e9');
      const decomposed = path.join(DOCS, 'Cafe\u0301');
      existing.add(path.resolve(composed));
      const foldersService = register([{ ...reports, path: composed }]);

      const result = await edit('reports', { path: decomposed });

      expect(result.success).toBe(true);
      expect(result.errorCode).toBeUndefined();
      expect(fs.rename).not.toHaveBeenCalled();
      expect(fs.mkdir).not.toHaveBeenCalledWith(decomposed, expect.anything());
      expect(foldersService.saveCustomFolders).toHaveBeenCalled();
    });
  });

  test('an edit of only a remembered choice keeps everything else', async () => {
    const foldersService = register([reports]);

    const result = await edit('reports', { inPlaceFiles: 'leave' });

    expect(result.success).toBe(true);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(savedFolder(foldersService, 'reports')).toEqual(
      expect.objectContaining({
        name: 'Reports',
        path: OLD_PATH,
        description: 'Quarterly reports',
        inPlaceFiles: 'leave'
      })
    );
  });
});

describe('Smart Folder IPC schemas', () => {
  const { schemas } = jest.requireActual('../src/main/ipc/validationSchemas');

  test('the edit takes an optional path-change choice', () => {
    expect(schemas.smartFolderEdit.safeParse(['id', { path: '/Users/alex/Out' }]).success).toBe(
      true
    );
    const parsed = schemas.smartFolderEdit.safeParse([
      'id',
      { path: '/Users/alex/Out' },
      { pathChange: 'new' }
    ]);
    expect(parsed.success).toBe(true);
    expect(parsed.data[2]).toEqual({ pathChange: 'new' });
  });

  test('the edit refuses an unknown choice', () => {
    expect(schemas.smartFolderEdit.safeParse(['id', {}, { pathChange: 'delete' }]).success).toBe(
      false
    );
    expect(schemas.smartFolderEdit.safeParse(['id', {}, { force: true }]).success).toBe(false);
  });

  test('a whole-list save keeps the overlap choices', () => {
    const parsed = schemas.smartFoldersArray.safeParse([
      { name: 'Out', path: '/Users/alex/Out', sourceOverlapOk: true, inPlaceFiles: 'skip' },
      { name: 'In', path: '/Users/alex/In', inPlaceFiles: null }
    ]);
    expect(parsed.success).toBe(true);
    expect(parsed.data[0]).toEqual(
      expect.objectContaining({ sourceOverlapOk: true, inPlaceFiles: 'skip' })
    );
    expect(parsed.data[1].inPlaceFiles).toBeNull();
  });
});
