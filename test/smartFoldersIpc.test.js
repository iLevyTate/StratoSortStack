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
  validateFileOperationPathSync: jest.fn((p) => ({ valid: true, normalizedPath: p }))
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

describe('Smart Folders IPC', () => {
  let mockIpcMain;
  let mockFoldersService;
  let mockServiceIntegration;
  let mockFolderMatcher;
  let mockParallelEmbedding;
  let mockLlamaService;
  let mockSmartFolderWatcher;
  let safeHandle;
  let registerSmartFoldersIpc;
  let fs;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    fs = require('fs').promises;
    safeHandle = require('../src/main/ipc/ipcWrappers').safeHandle;
    const FolderMatchingService = require('../src/main/services/FolderMatchingService');
    const ParallelEmbeddingService = require('../src/main/services/ParallelEmbeddingService');
    const LlamaService = require('../src/main/services/LlamaService');

    // Mock folder matcher
    mockFolderMatcher = {
      initialize: jest.fn().mockResolvedValue(),
      embedText: jest.fn().mockResolvedValue({ vector: [0.1, 0.2, 0.3], model: 'test-model' }),
      generateFolderId: jest.fn(() => 'test-id')
    };
    FolderMatchingService.getInstance.mockReturnValue(mockFolderMatcher);

    mockParallelEmbedding = {
      batchEmbedTexts: jest.fn().mockImplementation(async (items) => ({
        results: items.map((item, idx) => ({
          id: item.id,
          success: true,
          vector: idx === 0 ? [0.9, 0, 0] : [0.1, 0, 0],
          model: 'test-model'
        })),
        errors: [],
        stats: {}
      }))
    };
    ParallelEmbeddingService.getInstance.mockReturnValue(mockParallelEmbedding);

    // Mock Llama Service
    mockLlamaService = {
      initialize: jest.fn().mockResolvedValue(),
      generateText: jest.fn().mockResolvedValue({ response: '{"index": 1, "reason": "match"}' }),
      getConfig: jest.fn().mockResolvedValue({})
    };
    LlamaService.getInstance.mockReturnValue(mockLlamaService);

    // Mock folders service
    mockFoldersService = {
      getCustomFolders: jest.fn(() => [
        {
          id: '1',
          name: 'Work',
          path: 'C:\\Users\\Test\\Documents\\Work',
          description: 'Work stuff'
        },
        {
          id: 'default-uncategorized',
          name: 'Uncategorized',
          isDefault: true,
          path: 'C:\\Users\\Test\\Documents\\Uncategorized'
        }
      ]),
      setCustomFolders: jest.fn(),
      saveCustomFolders: jest.fn().mockResolvedValue(),
      scanDirectory: jest.fn().mockResolvedValue([])
    };

    // Mock smart folder watcher
    mockSmartFolderWatcher = {
      start: jest.fn().mockResolvedValue(true),
      stop: jest.fn(),
      getStatus: jest.fn().mockReturnValue({ isRunning: true, watchedCount: 5 }),
      isRunning: true,
      scanForUnanalyzedFiles: jest.fn().mockResolvedValue({ scanned: 10, queued: 5 }),
      updateWatchedFolders: jest.fn().mockResolvedValue(undefined),
      scanFolderForUnanalyzedFiles: jest.fn().mockResolvedValue({ scanned: 0, queued: 0 })
    };

    mockServiceIntegration = {
      smartFolderWatcher: mockSmartFolderWatcher
    };

    mockIpcMain = { handle: jest.fn() };
    const mockLogger = require('../src/shared/logger').createLogger();

    const context = {
      ipcMain: mockIpcMain,
      IPC_CHANNELS,
      // Spread folders service methods for createFromLegacyParams
      ...mockFoldersService,
      foldersService: mockFoldersService,
      getServiceIntegration: () => mockServiceIntegration,
      logger: mockLogger,
      // Include direct references expected by createFromLegacyParams if passed as object
      core: { ipcMain: mockIpcMain, IPC_CHANNELS, logger: mockLogger },
      folders: mockFoldersService
    };

    registerSmartFoldersIpc = require('../src/main/ipc/smartFolders');
    registerSmartFoldersIpc(context);
  });

  function getHandler(channel) {
    const call = safeHandle.mock.calls.find((c) => c[1] === channel);
    if (!call) throw new Error(`Handler for ${channel} not registered`);
    return call[2]; // The wrapped handler
  }

  describe('SMART_FOLDERS.MATCH', () => {
    test('matches using embeddings successfully', async () => {
      const handler = getHandler(IPC_CHANNELS.SMART_FOLDERS.MATCH);
      const smartFolders = [
        { name: 'Finance', description: 'Invoices' },
        { name: 'Personal', description: 'Photos' }
      ];

      // Query embedding (folder side uses ParallelEmbeddingService.batchEmbedTexts)
      mockFolderMatcher.embedText.mockResolvedValueOnce({ vector: [1, 0, 0], model: 'test-model' });

      const result = await handler({}, { text: 'invoice.pdf', smartFolders });

      expect(result.success).toBe(true);
      expect(result.folder.name).toBe('Finance');
      expect(result.method).toBe('embeddings');
    });

    test('falls back to LLM when embedding fails', async () => {
      const handler = getHandler(IPC_CHANNELS.SMART_FOLDERS.MATCH);
      const smartFolders = [{ name: 'Finance', description: 'Invoices' }];

      // Force embedding failure
      mockFolderMatcher.embedText.mockRejectedValue(new Error('Embedding failed'));

      const result = await handler({}, { text: 'invoice.pdf', smartFolders });

      expect(result.success).toBe(true);
      expect(result.method).toBe('llm');
      expect(mockLlamaService.generateText).toHaveBeenCalled();
    });
  });

  describe('SMART_FOLDERS.ADD', () => {
    test('a folder the destination policy did not approve is not registered and no directory is created', async () => {
      const handler = getHandler(IPC_CHANNELS.SMART_FOLDERS.ADD);
      mockAuthorizeSmartFolderRoot.mockResolvedValueOnce({
        allowed: false,
        reason: 'declined',
        errorCode: 'DESTINATION_NOT_ALLOWED',
        error: 'Destination folder was not approved: C:\\Users\\Test\\Elsewhere'
      });

      const result = await handler({}, { name: 'Elsewhere', path: 'C:\\Users\\Test\\Elsewhere' });

      expect(result).toEqual(
        expect.objectContaining({ success: false, errorCode: 'DESTINATION_NOT_ALLOWED' })
      );
      expect(result.error).toMatch(/not approved/);
      expect(mockFoldersService.saveCustomFolders).not.toHaveBeenCalled();
      expect(fs.mkdir).not.toHaveBeenCalled();
      // Folders already on record and Documents are handed over as trusted
      // roots, so registering beside them never prompts.
      expect(mockAuthorizeSmartFolderRoot).toHaveBeenCalledWith(
        'C:\\Users\\Test\\Elsewhere',
        expect.objectContaining({
          knownRoots: expect.arrayContaining([
            'C:\\Users\\Test\\Documents',
            'C:\\Users\\Test\\Documents\\Work'
          ])
        })
      );
    });

    test('adds a new folder successfully', async () => {
      const handler = getHandler(IPC_CHANNELS.SMART_FOLDERS.ADD);
      const { enhanceSmartFolderWithLLM } = require('../src/main/services/SmartFoldersLLMService');
      let resolveEnhancement;
      const enhancementDone = new Promise((resolve) => {
        resolveEnhancement = resolve;
      });
      const folderState = [...mockFoldersService.getCustomFolders()];
      mockFoldersService.getCustomFolders.mockImplementation(() => folderState);
      mockFoldersService.setCustomFolders.mockImplementation((nextFolders) => {
        folderState.splice(0, folderState.length, ...nextFolders);
      });
      const newFolder = { name: 'Projects', path: 'C:\\Users\\Test\\Documents\\Projects' };
      enhanceSmartFolderWithLLM.mockReturnValueOnce(enhancementDone);

      // Mock path check sequence:
      // 1. Parent dir check (succeeds)
      // 2. Target dir check (fails - ENOENT, triggering creation)
      // 3. Target dir verification (succeeds after creation)
      fs.stat
        .mockResolvedValueOnce({ isDirectory: () => true })
        .mockRejectedValueOnce({ code: 'ENOENT' })
        .mockResolvedValueOnce({ isDirectory: () => true });

      fs.mkdir.mockResolvedValue();
      fs.writeFile.mockResolvedValue(); // Test write
      fs.unlink.mockResolvedValue(); // Cleanup test write

      const result = await handler({}, newFolder);

      if (!result.success) {
        console.error('ADD error:', result);
        throw new Error(`ADD failed: ${result.error} - ${result.details || ''}`);
      }

      expect(result.success).toBe(true);
      expect(result.directoryCreated).toBe(true);
      expect(mockFoldersService.setCustomFolders).toHaveBeenCalled();
      expect(mockFoldersService.saveCustomFolders).toHaveBeenCalled();

      // Check that the new folder was added
      const initialSavedFolders = mockFoldersService.setCustomFolders.mock.calls[0][0];
      expect(initialSavedFolders).toHaveLength(3); // 2 existing + 1 new
      expect(initialSavedFolders[2].name).toBe('Projects');

      resolveEnhancement({
        improvedDescription: 'Project files and planning docs',
        suggestedKeywords: ['project', 'planning'],
        suggestedCategory: 'work',
        confidence: 92,
        relatedFolders: ['Work', 'MadeUpFolder']
      });
      await enhancementDone;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (mockFoldersService.setCustomFolders.mock.calls.length > 1) break;
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect(mockFoldersService.setCustomFolders.mock.calls.length).toBeGreaterThan(1);
      const finalSavedFolders =
        mockFoldersService.setCustomFolders.mock.calls[
          mockFoldersService.setCustomFolders.mock.calls.length - 1
        ][0];
      expect(finalSavedFolders[2].description).toBe('Project files and planning docs');
      expect(finalSavedFolders[2].confidenceScore).toBeCloseTo(0.92, 2);
      expect(finalSavedFolders[2].relatedFolders).toEqual(['Work']);

      // [F-081] The completed enhancement must broadcast smart-folders-updated
      // so an open renderer refreshes instead of showing the pre-enhancement
      // folder until remount. The broadcast runs after the save/embedding-sync
      // awaits, so flush microtasks until it lands.
      const { safeSend } = require('../src/main/ipc/ipcWrappers');
      for (let attempt = 0; attempt < 10 && safeSend.mock.calls.length === 0; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(safeSend).toHaveBeenCalledWith(
        expect.anything(),
        'smart-folders-updated',
        expect.objectContaining({
          folderId: finalSavedFolders[2].id,
          reason: 'llm-enhancement'
        })
      );

      // F-194 (K-05): the running watcher must pick the folder up NOW — not
      // at the next restart — and scan it for files that already exist.
      expect(mockSmartFolderWatcher.updateWatchedFolders).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ name: 'Projects' })])
      );
      expect(mockSmartFolderWatcher.scanFolderForUnanalyzedFiles).toHaveBeenCalledWith(
        newFolder.path
      );
    });

    test('a watcher that is missing or throws never fails the add', async () => {
      const handler = getHandler(IPC_CHANNELS.SMART_FOLDERS.ADD);
      const { enhanceSmartFolderWithLLM } = require('../src/main/services/SmartFoldersLLMService');
      enhanceSmartFolderWithLLM.mockResolvedValueOnce(null);
      mockSmartFolderWatcher.updateWatchedFolders.mockRejectedValueOnce(new Error('boom'));
      fs.stat
        .mockResolvedValueOnce({ isDirectory: () => true })
        .mockRejectedValueOnce({ code: 'ENOENT' })
        .mockResolvedValueOnce({ isDirectory: () => true });
      fs.mkdir.mockResolvedValue();
      fs.writeFile.mockResolvedValue();
      fs.unlink.mockResolvedValue();

      const result = await handler(
        {},
        { name: 'Ledgers', path: 'C:\\Users\\Test\\Documents\\Ledgers' }
      );
      expect(result).toEqual(expect.objectContaining({ success: true }));
    });

    test('validates folder name characters', async () => {
      const handler = getHandler(IPC_CHANNELS.SMART_FOLDERS.ADD);
      const invalidFolder = { name: 'Bad:Name', path: 'C:\\Test' };

      const result = await handler({}, invalidFolder);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBeDefined(); // CHECK: Should use proper error code check if exported
    });

    test('rejects canonically-equivalent name and surfaces existingFolder for the renderer', async () => {
      // Pre-existing "Logos" folder. Canonical-equivalence rejects
      // "Logos and Graphic Design" (token-subset of "Logos") so we don't
      // create a duplicate the embedding matcher will flip-flop between.
      // The IPC contract returns errorCode + existingFolder so the
      // renderer can prompt "Use existing 'Logos'?" instead of a generic
      // "Failed to add" — without this contract the v3 UX silently
      // surfaces a confusing error for names v2.0.9 accepted.
      const folderState = [
        {
          id: 'logos-1',
          name: 'Logos',
          path: 'C:\\Users\\Test\\Documents\\Logos',
          description: 'Logo assets'
        }
      ];
      mockFoldersService.getCustomFolders.mockImplementation(() => folderState);

      const handler = getHandler(IPC_CHANNELS.SMART_FOLDERS.ADD);
      const result = await handler(
        {},
        {
          name: 'Logos and Graphic Design',
          path: 'C:\\Users\\Test\\Documents\\Logos and Graphic Design'
        }
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('FOLDER_NAME_EQUIVALENT');
      expect(result.existingFolder).toBeDefined();
      expect(result.existingFolder.name).toBe('Logos');
      // The folder was NOT added.
      expect(mockFoldersService.setCustomFolders).not.toHaveBeenCalled();
    });
  });

  describe('Smart Folder root vetting', () => {
    // The preload gives up on an invoke after its timeout and the registry
    // aborts event.abortSignal; the confirmation dialog must go with it, so
    // every handler that vets a root hands the signal to the policy.
    test('each handler that vets a root forwards the request abortSignal to the destination policy', async () => {
      const controller = new AbortController();
      const event = { abortSignal: controller.signal };
      mockAuthorizeSmartFolderRoot.mockResolvedValue({
        allowed: false,
        reason: 'declined',
        errorCode: 'DESTINATION_NOT_ALLOWED',
        error: 'Destination folder was not approved'
      });
      const elsewhere = { name: 'Elsewhere', path: 'C:\\Users\\Test\\Elsewhere' };
      const list = [
        elsewhere,
        {
          id: 'default-uncategorized',
          name: 'Uncategorized',
          isDefault: true,
          path: 'C:\\Users\\Test\\Documents\\Uncategorized'
        }
      ];

      await getHandler(IPC_CHANNELS.SMART_FOLDERS.ADD)(event, { ...elsewhere });
      await getHandler(IPC_CHANNELS.SMART_FOLDERS.EDIT)(event, '1', { path: elsewhere.path });
      await getHandler(IPC_CHANNELS.SMART_FOLDERS.SAVE)(
        event,
        list.map((f) => ({ ...f }))
      );
      await getHandler(IPC_CHANNELS.SMART_FOLDERS.UPDATE_CUSTOM)(
        event,
        list.map((f) => ({ ...f }))
      );

      expect(mockAuthorizeSmartFolderRoot).toHaveBeenCalledTimes(4);
      for (const [, deps] of mockAuthorizeSmartFolderRoot.mock.calls) {
        expect(deps.abortSignal).toBe(controller.signal);
      }
    });

    test('a request without a signal hands the policy null rather than undefined', async () => {
      mockAuthorizeSmartFolderRoot.mockResolvedValueOnce({ allowed: false, reason: 'declined' });
      await getHandler(IPC_CHANNELS.SMART_FOLDERS.ADD)(
        {},
        { name: 'Elsewhere', path: 'C:\\Users\\Test\\Elsewhere' }
      );
      expect(mockAuthorizeSmartFolderRoot.mock.calls[0][1]).toEqual(
        expect.objectContaining({ abortSignal: null })
      );
    });
  });

  describe('SMART_FOLDERS.SCAN_STRUCTURE', () => {
    test('scans directory structure', async () => {
      const handler = getHandler(IPC_CHANNELS.SMART_FOLDERS.SCAN_STRUCTURE);

      mockFoldersService.scanDirectory.mockResolvedValue([
        { type: 'file', name: 'doc.pdf', path: '/path/doc.pdf', size: 100 },
        { type: 'directory', name: 'sub', children: [] }
      ]);

      const result = await handler({}, 'C:\\Users\\Test\\Documents');

      if (!result.success) {
        console.error('SCAN error:', result);
      }

      expect(result.success).toBe(true);
      expect(result.files).toHaveLength(1);
      expect(result.files[0].name).toBe('doc.pdf');
    });
  });

  describe('SMART_FOLDERS.WATCHER_START', () => {
    test('starts the watcher', async () => {
      const handler = getHandler(IPC_CHANNELS.SMART_FOLDERS.WATCHER_START);

      const result = await handler({}, {});

      expect(mockSmartFolderWatcher.start).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    test('returns error if watcher not available', async () => {
      const handler = getHandler(IPC_CHANNELS.SMART_FOLDERS.WATCHER_START);

      // Temporarily remove watcher
      const originalWatcher = mockServiceIntegration.smartFolderWatcher;
      mockServiceIntegration.smartFolderWatcher = null;

      const result = await handler({}, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('not available');

      // Restore
      mockServiceIntegration.smartFolderWatcher = originalWatcher;
    });
  });
});
