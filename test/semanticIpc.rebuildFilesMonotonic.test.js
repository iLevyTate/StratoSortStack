/**
 * @jest-environment node
 *
 * D5/Q4 guardrail: EMBEDDINGS.REBUILD_FILES must be monotonic.
 *
 * The handler used to call resetFiles() + resetFileChunks() BEFORE re-embedding
 * anything, so a crash, a model outage, or a partial run left the user with an
 * empty knowledge store and no way back. It now upserts over the live
 * collections, can backfill only the files that lack a vector (`onlyMissing`),
 * and can leave watched-folder paths to the watcher (`excludePathPrefixes`).
 */
const { IPC_CHANNELS } = require('../src/shared/constants');

// Mock dependencies
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
  createErrorResponse: jest.fn((err) => ({ success: false, error: err.message })),
  safeHandle: jest.fn(),
  withErrorLogging: jest.fn((logger, handler) => {
    if (typeof logger === 'function') return logger;
    return handler;
  }),
  withVectorDbInit: jest.fn((arg) => {
    if (typeof arg === 'function') return arg;
    if (arg && typeof arg.handler === 'function') return arg.handler;
    return arg;
  }),
  z: (() => {
    const chainable = () => new Proxy({}, { get: () => chainable });
    return new Proxy({}, { get: () => chainable });
  })()
}));

jest.mock('../src/main/services/OramaVectorService', () => ({
  getInstance: jest.fn(() => ({
    initialize: jest.fn().mockResolvedValue(),
    getStats: jest.fn(),
    rebuildIndex: jest.fn()
  }))
}));

jest.mock('../src/main/services/FolderMatchingService', () => ({
  getInstance: jest.fn(() => ({
    initialize: jest.fn().mockResolvedValue(),
    rebuildIndex: jest.fn()
  }))
}));

jest.mock('../src/main/services/ParallelEmbeddingService', () => ({
  getInstance: jest.fn(() => ({}))
}));

jest.mock('../src/main/services/SearchService', () => ({
  SearchService: jest.fn()
}));

jest.mock('../src/main/services/ClusteringService', () => ({
  ClusteringService: jest.fn()
}));

jest.mock('../src/main/services/QueryProcessor', () => ({
  getInstance: jest.fn()
}));

jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: jest.fn(() => ({
    getConfig: jest.fn().mockResolvedValue({})
  }))
}));

// Keep the rebuild off the real embedding-index metadata file (userData write).
jest.mock('../src/main/services/vectorDb/embeddingIndexMetadata', () => ({
  readEmbeddingIndexMetadata: jest.fn().mockResolvedValue(null),
  writeEmbeddingIndexMetadata: jest.fn().mockResolvedValue(undefined),
  updateEmbeddingIndexMetadata: jest.fn().mockResolvedValue(undefined),
  markRebuildInProgress: jest.fn().mockResolvedValue(undefined),
  clearRebuildInProgress: jest.fn().mockResolvedValue(undefined)
}));

// CP-11 resolver is exercised by its own suite; here it only needs to resolve.
jest.mock('../src/main/analysis/embeddingModelOptions', () => ({
  resolveEmbeddingModelOptions: jest.fn().mockResolvedValue({})
}));

describe('EMBEDDINGS.REBUILD_FILES (monotonic + onlyMissing)', () => {
  // test-setup.js swaps `fs` for memfs, so the handler's fs.access() check only
  // passes for a path that exists IN memfs. Created fresh in beforeEach (after
  // jest.resetModules(), so the volume is the one the fresh `fs` mock reads).
  const existingPath = '/rebuild-monotonic/report.txt';

  let safeHandle;
  let OramaVectorService;
  let FolderMatchingService;
  let historyService;
  let mockFoldersService;
  /** Mutable so a test can hand the handler a settingsService (chunking toggle). */
  let serviceIntegration;

  const entry = (p, extractedText = '') => ({
    originalPath: p,
    organization: {},
    analysis: {
      subject: 'Subject',
      summary: 'A summary of the file',
      tags: ['t'],
      extractedText
    }
  });

  const getFileId = (p) => require('../src/main/utils/fileIdUtils').getFileEmbeddingId(p, 'file');

  const invoke = async (channel, payload) => {
    const call = safeHandle.mock.calls.find((c) => c[1] === channel);
    if (!call) throw new Error(`${channel} handler not registered`);
    const handler =
      typeof call[2] === 'function' ? call[2] : call.find((arg) => typeof arg === 'function');
    if (typeof handler !== 'function') throw new Error(`${channel} handler is not a function`);
    return handler({}, payload);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    const { vol } = require('memfs');
    vol.mkdirSync('/rebuild-monotonic', { recursive: true });
    vol.writeFileSync(existingPath, 'content');

    safeHandle = require('../src/main/ipc/ipcWrappers').safeHandle;
    OramaVectorService = require('../src/main/services/OramaVectorService');
    FolderMatchingService = require('../src/main/services/FolderMatchingService');

    const { container, ServiceIds } = require('../src/main/services/ServiceContainer');

    const mockVectorDbInstance = {
      initialize: jest.fn().mockResolvedValue(),
      getStats: jest.fn(),
      rebuildIndex: jest.fn(),
      resetFolders: jest.fn(),
      resetFiles: jest.fn(),
      resetFileChunks: jest.fn(),
      batchUpsertFolders: jest.fn(),
      batchUpsertFiles: jest.fn().mockResolvedValue({ count: 0 }),
      batchUpsertFileChunks: jest.fn().mockResolvedValue(0),
      deleteFileChunks: jest.fn().mockResolvedValue(0),
      getFile: jest.fn().mockResolvedValue(null),
      // I4b: the backfill asks the store's own usability rule, not getFile().
      hasUsableVector: jest.fn().mockResolvedValue(false),
      // Passages present unless a test says otherwise, so a usable file
      // vector is a complete file by default.
      hasFileChunks: jest.fn().mockResolvedValue(true)
    };

    const mockFolderMatcherInstance = {
      initialize: jest.fn().mockResolvedValue(),
      rebuildIndex: jest.fn(),
      embedText: jest.fn().mockResolvedValue({ vector: [0.1, 0.2], model: 'm' }),
      generateFolderId: jest.fn(() => 'folder-1')
    };

    const mockEmbeddingService = {
      embedText: jest.fn().mockResolvedValue({ vector: [0.1, 0.2], model: 'm' })
    };

    const mockLlamaService = {
      getConfig: jest.fn().mockResolvedValue({})
    };

    container.resolve = jest.fn((id) => {
      switch (id) {
        case ServiceIds.ORAMA_VECTOR:
          return mockVectorDbInstance;
        case ServiceIds.FOLDER_MATCHING:
          return mockFolderMatcherInstance;
        case ServiceIds.LLAMA_SERVICE:
          return mockLlamaService;
        case ServiceIds.PARALLEL_EMBEDDING:
          return mockEmbeddingService;
        default:
          return null;
      }
    });
    container.tryResolve = container.resolve;

    OramaVectorService.getInstance.mockReturnValue(mockVectorDbInstance);
    FolderMatchingService.getInstance.mockReturnValue(mockFolderMatcherInstance);

    historyService = { getRecentAnalysis: jest.fn().mockResolvedValue([]) };
    mockFoldersService = { getCustomFolders: jest.fn(() => []) };
    // No settingsService => loadCurrentSettings() returns null =>
    // shouldBuildChunkEmbeddings() defaults to true. Tests that need chunking
    // OFF assign `serviceIntegration.settingsService` before invoking.
    serviceIntegration = { analysisHistory: historyService };

    const mockLogger = require('../src/shared/logger').createLogger();
    const context = {
      ipcMain: { handle: jest.fn() },
      IPC_CHANNELS,
      settingsService: { get: jest.fn() },
      foldersService: mockFoldersService,
      getServiceIntegration: () => serviceIntegration,
      logger: mockLogger,
      getCustomFolders: mockFoldersService.getCustomFolders
    };

    const registerEmbeddingsIpc = require('../src/main/ipc/semantic');
    registerEmbeddingsIpc(context);
  });

  test('never resets collections and upserts every history file that exists', async () => {
    const orama = OramaVectorService.getInstance();
    orama.resetFiles = jest.fn();
    orama.resetFileChunks = jest.fn();
    orama.getFile = jest.fn().mockResolvedValue(null);
    orama.batchUpsertFiles = jest.fn().mockResolvedValue({ count: 1 });
    orama.batchUpsertFileChunks = jest.fn().mockResolvedValue(0);
    orama.deleteFileChunks = jest.fn().mockResolvedValue(0);
    historyService.getRecentAnalysis = jest.fn().mockResolvedValue([entry(existingPath)]);

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, {});

    expect(result.success).toBe(true);
    expect(orama.resetFiles).not.toHaveBeenCalled();
    expect(orama.resetFileChunks).not.toHaveBeenCalled();
    expect(orama.batchUpsertFiles).toHaveBeenCalledTimes(1);
    expect(result.files).toBe(1);
  });

  test('onlyMissing skips files that already have a live vector', async () => {
    const orama = OramaVectorService.getInstance();
    // Live row with a real, non-placeholder embedding.
    orama.hasUsableVector = jest.fn().mockResolvedValue(true);
    orama.batchUpsertFiles = jest.fn().mockResolvedValue({ count: 0 });
    historyService.getRecentAnalysis = jest.fn().mockResolvedValue([entry(existingPath)]);

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, { onlyMissing: true });

    expect(result.success).toBe(true);
    expect(result.skippedExisting).toBe(1);
    expect(orama.batchUpsertFiles).not.toHaveBeenCalled();
  });

  test('onlyMissing re-embeds a file whose vector is orphaned', async () => {
    const orama = OramaVectorService.getInstance();
    // Orphaned rows are not usable, so hasUsableVector() reports false.
    orama.hasUsableVector = jest.fn().mockResolvedValue(false);
    orama.batchUpsertFiles = jest.fn().mockResolvedValue({ count: 1 });
    historyService.getRecentAnalysis = jest.fn().mockResolvedValue([entry(existingPath)]);

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, { onlyMissing: true });

    expect(result.skippedExisting).toBe(0);
    expect(orama.batchUpsertFiles).toHaveBeenCalledTimes(1);
  });

  test('onlyMissing embeds a file with no row at all', async () => {
    const orama = OramaVectorService.getInstance();
    orama.hasUsableVector = jest.fn().mockResolvedValue(false);
    orama.batchUpsertFiles = jest.fn().mockResolvedValue({ count: 1 });
    historyService.getRecentAnalysis = jest.fn().mockResolvedValue([entry(existingPath)]);

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, { onlyMissing: true });

    expect(result.skippedExisting).toBe(0);
    expect(orama.hasUsableVector).toHaveBeenCalledWith(getFileId(existingPath));
    expect(orama.batchUpsertFiles).toHaveBeenCalledTimes(1);
  });

  test('onlyMissing backfills a usable file whose passages were never built', async () => {
    const longText = 'A long document body. '.repeat(40);
    historyService.getRecentAnalysis.mockResolvedValue([entry(existingPath, longText)]);
    const orama = require('../src/main/services/OramaVectorService').getInstance();
    orama.hasUsableVector = jest.fn().mockResolvedValue(true);
    orama.hasFileChunks = jest.fn().mockResolvedValue(false);
    orama.batchUpsertFiles = jest.fn().mockResolvedValue({ count: 1 });
    orama.batchUpsertFileChunks = jest.fn(async (payloads) => payloads.length);

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, { onlyMissing: true });

    expect(result.success).toBe(true);
    expect(orama.hasFileChunks).toHaveBeenCalledWith(getFileId(existingPath));
    expect(orama.batchUpsertFileChunks).toHaveBeenCalled();
    expect(result.skippedExisting).toBe(0);
  });

  test('onlyMissing still skips a usable file whose passages exist', async () => {
    const longText = 'A long document body. '.repeat(40);
    historyService.getRecentAnalysis.mockResolvedValue([entry(existingPath, longText)]);
    const orama = require('../src/main/services/OramaVectorService').getInstance();
    orama.hasUsableVector = jest.fn().mockResolvedValue(true);
    orama.hasFileChunks = jest.fn().mockResolvedValue(true);

    await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, { onlyMissing: true });

    expect(orama.batchUpsertFileChunks).not.toHaveBeenCalled();
    expect(orama.batchUpsertFiles).not.toHaveBeenCalled();
  });

  test('onlyMissing does not probe passages when chunk rebuild is off', async () => {
    const longText = 'A long document body. '.repeat(40);
    historyService.getRecentAnalysis.mockResolvedValue([entry(existingPath, longText)]);
    serviceIntegration.settingsService = {
      load: jest.fn().mockResolvedValue({ autoChunkOnAnalysis: false, experienceMode: 'advanced' })
    };
    const orama = require('../src/main/services/OramaVectorService').getInstance();
    orama.hasUsableVector = jest.fn().mockResolvedValue(true);
    orama.hasFileChunks = jest.fn().mockResolvedValue(false);

    await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, { onlyMissing: true });

    expect(orama.hasFileChunks).not.toHaveBeenCalled();
    expect(orama.batchUpsertFiles).not.toHaveBeenCalled();
  });

  test('excludePathPrefixes leaves watched-folder files to the watcher', async () => {
    const orama = OramaVectorService.getInstance();
    orama.batchUpsertFiles = jest.fn().mockResolvedValue({ count: 0 });
    historyService.getRecentAnalysis = jest.fn().mockResolvedValue([entry(existingPath)]);
    const path = require('path');

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, {
      excludePathPrefixes: [path.dirname(existingPath)]
    });

    expect(result.skippedExcluded).toBe(1);
    expect(orama.batchUpsertFiles).not.toHaveBeenCalled();
  });

  test('an excluded prefix does not swallow a sibling folder sharing its leading characters', async () => {
    // A naive startsWith would match "/rebuild-monotonic" against
    // "/rebuild-monotonic-archive/report.txt". The shared containment helper
    // does a real path-segment boundary check, so it must not.
    const siblingDir = '/rebuild-monotonic-archive';
    const siblingPath = `${siblingDir}/report.txt`;
    const { vol } = require('memfs');
    vol.mkdirSync(siblingDir, { recursive: true });
    vol.writeFileSync(siblingPath, 'content');

    const orama = OramaVectorService.getInstance();
    orama.batchUpsertFiles = jest.fn().mockResolvedValue({ count: 1 });
    historyService.getRecentAnalysis = jest.fn().mockResolvedValue([entry(siblingPath)]);

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, {
      excludePathPrefixes: ['/rebuild-monotonic']
    });

    expect(result.skippedExcluded).toBe(0);
    expect(orama.batchUpsertFiles).toHaveBeenCalledTimes(1);
  });

  test('a filesystem-root prefix excludes everything under it', async () => {
    // R1 regression: the previous implementation (isPathWithinAllowed + a
    // trailing-separator pre-strip) matched no root-ish prefix at all: "/" was
    // stripped to '' and dropped; "C:\" became "C:" which path.normalize turns
    // into "C:."; and a UNC share root re-gained a trailing separator from
    // path.normalize and failed the remainder check. isPathWithinFolder
    // normalizes first and appends "/" afterwards, so all three match.
    const orama = OramaVectorService.getInstance();
    orama.batchUpsertFiles = jest.fn().mockResolvedValue({ count: 0 });
    historyService.getRecentAnalysis = jest.fn().mockResolvedValue([entry(existingPath)]);

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, {
      excludePathPrefixes: ['/']
    });

    expect(result.skippedExcluded).toBe(1);
    expect(orama.batchUpsertFiles).not.toHaveBeenCalled();
  });

  // The next two use paths that memfs cannot hold, so they assert on WHICH skip
  // fired: the exclusion check runs before fs.access, so an excluded row lands
  // in skippedExcluded while an unmatched one would fall through to
  // skippedMissing. That distinction is exactly what a root-prefix bug breaks.
  const winTest = process.platform === 'win32' ? test : test.skip;

  winTest('a UNC share-root prefix matches files inside the share', async () => {
    const orama = OramaVectorService.getInstance();
    orama.batchUpsertFiles = jest.fn().mockResolvedValue({ count: 0 });
    historyService.getRecentAnalysis = jest
      .fn()
      .mockResolvedValue([entry('\\\\srv\\share\\a.txt')]);

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, {
      excludePathPrefixes: ['\\\\srv\\share']
    });

    expect(result.skippedExcluded).toBe(1);
    expect(result.skippedMissing).toBe(0);
  });

  winTest('a drive-root prefix matches files on that drive', async () => {
    const orama = OramaVectorService.getInstance();
    orama.batchUpsertFiles = jest.fn().mockResolvedValue({ count: 0 });
    historyService.getRecentAnalysis = jest.fn().mockResolvedValue([entry('C:\\Users\\x\\a.txt')]);

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, {
      excludePathPrefixes: ['C:\\']
    });

    expect(result.skippedExcluded).toBe(1);
    expect(result.skippedMissing).toBe(0);
  });

  test('a trailing separator on an excluded prefix still matches', async () => {
    const orama = OramaVectorService.getInstance();
    orama.batchUpsertFiles = jest.fn().mockResolvedValue({ count: 0 });
    historyService.getRecentAnalysis = jest.fn().mockResolvedValue([entry(existingPath)]);

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, {
      excludePathPrefixes: ['/rebuild-monotonic/']
    });

    expect(result.skippedExcluded).toBe(1);
    expect(orama.batchUpsertFiles).not.toHaveBeenCalled();
  });

  test('clears a shrunk file old chunks even when the new text is below MIN_TEXT_LENGTH', async () => {
    // Regression: the deleteFileChunks() call used to sit INSIDE the
    // MIN_TEXT_LENGTH gate, so a file whose extracted text shrank below the
    // threshold kept the chunk rows the old global resetFileChunks() swept.
    const { CHUNKING } = require('../src/shared/performanceConstants');
    const shortText = 'short';
    expect(shortText.length).toBeLessThan(CHUNKING.MIN_TEXT_LENGTH);

    const orama = OramaVectorService.getInstance();
    orama.batchUpsertFiles = jest.fn().mockResolvedValue({ count: 1 });
    orama.deleteFileChunks = jest.fn().mockResolvedValue(3);
    orama.batchUpsertFileChunks = jest.fn().mockResolvedValue(0);
    historyService.getRecentAnalysis = jest
      .fn()
      .mockResolvedValue([entry(existingPath, shortText)]);

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, {});

    expect(result.success).toBe(true);
    expect(orama.deleteFileChunks).toHaveBeenCalledWith(getFileId(existingPath));
    // Nothing to re-chunk, so no chunk batch is ever upserted.
    expect(orama.batchUpsertFileChunks).not.toHaveBeenCalled();
  });

  test('each file chunk delete is immediately followed by that same file chunk write', async () => {
    // C1: deleteFileChunks() used to run per file inside the loop while the
    // chunk upsert waited until the whole (up to 50k entry) run finished, so a
    // crash mid-run durably lost chunks for every file already processed.
    // With two files the deletes must INTERLEAVE with their own writes — a
    // grouped "delete A, delete B, write A, write B" flush would still leave
    // A's chunks gone across B's delete.
    const secondPath = '/rebuild-monotonic/second.txt';
    const { vol } = require('memfs');
    vol.writeFileSync(secondPath, 'content');
    const label = (id) => (id === getFileId(existingPath) ? 'A' : 'B');

    const callOrder = [];
    const orama = OramaVectorService.getInstance();
    orama.batchUpsertFiles = jest.fn(async (batch) => {
      callOrder.push('upsertFiles');
      return { count: batch.length };
    });
    orama.deleteFileChunks = jest.fn(async (fileId) => {
      callOrder.push(`deleteChunks:${label(fileId)}`);
      return 0;
    });
    orama.batchUpsertFileChunks = jest.fn(async (payloads) => {
      callOrder.push(`upsertChunks:${label(payloads[0].meta.fileId)}`);
      return payloads.length;
    });
    historyService.getRecentAnalysis = jest
      .fn()
      .mockResolvedValue([
        entry(existingPath, 'x'.repeat(2000)),
        entry(secondPath, 'y'.repeat(2000))
      ]);

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, {});

    expect(result.success).toBe(true);
    expect(callOrder).toEqual([
      'upsertFiles',
      'deleteChunks:A',
      'upsertChunks:A',
      'deleteChunks:B',
      'upsertChunks:B'
    ]);
  });

  test('a failed chunk delete is counted and reported, not swallowed', async () => {
    const orama = OramaVectorService.getInstance();
    orama.batchUpsertFiles = jest.fn().mockResolvedValue({ count: 1 });
    orama.deleteFileChunks = jest.fn().mockRejectedValue(new Error('chunk store busy'));
    orama.batchUpsertFileChunks = jest.fn().mockResolvedValue(0);
    historyService.getRecentAnalysis = jest.fn().mockResolvedValue([entry(existingPath, 'short')]);

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, {});

    expect(result.success).toBe(true);
    expect(result.chunkDeleteFailures).toBe(1);
  });

  // D7 / K-16: a fallback analysis is provisional; embedding it put
  // placeholder vectors (e.g. every Whisper-skipped video) into the index.
  test('skips provisional (fallback) analyses and reports them as skipped', async () => {
    const orama = OramaVectorService.getInstance();
    orama.getFile = jest.fn().mockResolvedValue(null);
    orama.batchUpsertFiles = jest.fn().mockResolvedValue({ count: 1 });
    const provisional = {
      ...entry(existingPath, 'short'),
      analysis: { subject: 'clip', extractionMethod: 'media-skipped-no-whisper' }
    };
    historyService.getRecentAnalysis = jest.fn().mockResolvedValue([provisional]);

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, {});

    expect(result.success).toBe(true);
    expect(result.skippedProvisional).toBe(1);
    expect(result.files).toBe(0);
    expect(orama.batchUpsertFiles).not.toHaveBeenCalled();
  });

  test('leaves existing chunks alone when chunk rebuild is disabled', async () => {
    // D5: with chunking off we have nothing better to put in their place, so
    // the stored chunks stay the best data we have. Only Advanced mode can
    // turn chunking off; Simple mode (the default when experienceMode is
    // absent) enforces it on (F-192 / CP-12).
    serviceIntegration.settingsService = {
      load: jest.fn().mockResolvedValue({ experienceMode: 'advanced', autoChunkOnAnalysis: false })
    };

    const orama = OramaVectorService.getInstance();
    orama.getFile = jest.fn().mockResolvedValue(null);
    orama.batchUpsertFiles = jest.fn().mockResolvedValue({ count: 1 });
    orama.deleteFileChunks = jest.fn().mockResolvedValue(0);
    historyService.getRecentAnalysis = jest.fn().mockResolvedValue([entry(existingPath, 'short')]);

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, {});

    expect(result.success).toBe(true);
    expect(orama.deleteFileChunks).not.toHaveBeenCalled();
  });

  test('duplicate history rows for one file are deduped before the skip counters', async () => {
    // The dedupe check runs ahead of the exclude/onlyMissing checks, so repeat
    // history entries neither inflate skippedExisting nor re-hit the store.
    const orama = OramaVectorService.getInstance();
    orama.hasUsableVector = jest.fn().mockResolvedValue(false);
    orama.batchUpsertFiles = jest.fn().mockResolvedValue({ count: 1 });
    historyService.getRecentAnalysis = jest
      .fn()
      .mockResolvedValue([entry(existingPath), entry(existingPath), entry(existingPath)]);

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, { onlyMissing: true });

    expect(result.skippedExisting).toBe(0);
    expect(result.uniquePrepared).toBe(1);
    expect(orama.hasUsableVector).toHaveBeenCalledTimes(1);
  });

  test('skip counts are unique files, not history rows', async () => {
    // M1: three history rows naming one already-embedded file must report
    // "1 skipped", not "3 skipped" — and must only ask the store once.
    const orama = OramaVectorService.getInstance();
    orama.hasUsableVector = jest.fn().mockResolvedValue(true);
    orama.batchUpsertFiles = jest.fn().mockResolvedValue({ count: 0 });
    historyService.getRecentAnalysis = jest
      .fn()
      .mockResolvedValue([entry(existingPath), entry(existingPath), entry(existingPath)]);

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, { onlyMissing: true });

    expect(result.success).toBe(true);
    expect(result.skippedExisting).toBe(1);
    expect(result.message).toContain('(1 skipped)');
    expect(orama.hasUsableVector).toHaveBeenCalledTimes(1);
  });

  test('a complete pass merges model + dims into the index metadata', async () => {
    // I2: never a full write — a crashed FULL_REBUILD leaves
    // `rebuildInProgress: true` on disk and this run must not clear it.
    const meta = require('../src/main/services/vectorDb/embeddingIndexMetadata');
    const orama = OramaVectorService.getInstance();
    orama.batchUpsertFiles = jest.fn().mockResolvedValue({ count: 1 });
    historyService.getRecentAnalysis = jest.fn().mockResolvedValue([entry(existingPath)]);

    await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, {});

    expect(meta.writeEmbeddingIndexMetadata).not.toHaveBeenCalled();
    expect(meta.updateEmbeddingIndexMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'm', dims: 2, source: 'rebuild-files' })
    );
  });

  test('a row whose file is gone from disk is a skip, not a failure, and still stamps', async () => {
    // R2: a deleted file is unembeddable by definition — no future run can fix
    // it. Counting it as a failure would make every rebuild look "partial" from
    // the first deletion onward, so the index model would never be stamped
    // again. Other access errors (permissions, I/O) stay failures.
    const meta = require('../src/main/services/vectorDb/embeddingIndexMetadata');
    const orama = OramaVectorService.getInstance();
    orama.batchUpsertFiles = jest.fn().mockResolvedValue({ count: 1 });
    historyService.getRecentAnalysis = jest
      .fn()
      .mockResolvedValue([entry(existingPath), entry('/rebuild-monotonic/gone.txt')]);

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, {});

    expect(result.success).toBe(true);
    expect(result.skippedMissing).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.indexModelStamped).toBe(true);
    expect(result.message).toContain('(1 skipped)');
    expect(meta.updateEmbeddingIndexMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'm', dims: 2, source: 'rebuild-files' })
    );
  });

  test('marks a missing-on-disk file skipped so coverage can reach 100% (D6 follow-up)', async () => {
    // Without this, statistics.js getQuickStats() keeps counting a
    // gone-from-disk file in embedding.eligibleFiles forever, so a real
    // library with any deleted files could never reach 100% coverage no
    // matter how complete a rebuild is.
    const missingPath = '/rebuild-monotonic/gone.txt';
    const orama = OramaVectorService.getInstance();
    orama.batchUpsertFiles = jest.fn().mockResolvedValue({ count: 0 });
    historyService.getRecentAnalysis = jest.fn().mockResolvedValue([entry(missingPath)]);
    historyService.updateEmbeddingStateByPath = jest
      .fn()
      .mockResolvedValue({ updated: 1, notFound: 0 });

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, {});

    expect(result.success).toBe(true);
    expect(result.skippedMissing).toBe(1);
    expect(historyService.updateEmbeddingStateByPath).toHaveBeenCalledWith(missingPath, {
      status: 'skipped'
    });
    expect(result.missingMarkedSkipped).toBe(1);
  });

  test('a partial pass does not restamp the index model', async () => {
    // Half the index may still be embedded with the previous model, so claiming
    // this run's model would hide a real mismatch from the stats readers.
    const meta = require('../src/main/services/vectorDb/embeddingIndexMetadata');
    const orama = OramaVectorService.getInstance();
    orama.hasUsableVector = jest.fn().mockResolvedValue(false);
    orama.batchUpsertFiles = jest.fn().mockResolvedValue({ count: 1 });
    historyService.getRecentAnalysis = jest.fn().mockResolvedValue([entry(existingPath)]);

    await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, { onlyMissing: true });

    expect(meta.writeEmbeddingIndexMetadata).not.toHaveBeenCalled();
    expect(meta.updateEmbeddingIndexMetadata).toHaveBeenCalledWith({
      source: 'rebuild-files-partial'
    });
  });

  test('CP-14: an analysis with only purpose + keywords is now embeddable', async () => {
    // The old ad-hoc join read subject/summary/tags/extractedText only, so an
    // analysis carrying just purpose + keywords produced an empty string and
    // was rejected with 'No content to embed'. buildEmbeddingSummary (the same
    // builder the analysis pipeline uses, real here — only the model-options
    // resolver is mocked) reads the full field set.
    const orama = OramaVectorService.getInstance();
    orama.batchUpsertFiles = jest.fn().mockResolvedValue({ count: 1 });
    historyService.getRecentAnalysis = jest.fn().mockResolvedValue([
      {
        originalPath: existingPath,
        organization: {},
        analysis: { purpose: 'Quarterly revenue planning', keywords: ['revenue', 'forecast'] }
      }
    ]);

    const result = await invoke(IPC_CHANNELS.EMBEDDINGS.REBUILD_FILES, {});

    expect(result.success).toBe(true);
    expect(result.prepared).toBe(1);
    expect(result.files).toBe(1);
    expect(result.errors).toEqual([]);
    expect(orama.batchUpsertFiles).toHaveBeenCalledTimes(1);
  });
});
