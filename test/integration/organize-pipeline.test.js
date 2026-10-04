/**
 * @jest-environment node
 *
 * Organize pipeline integration: FilePathCoordinator + OramaVectorService path
 * migration (embedding id move, chunk cleanup) without the full Electron app.
 */

const fs = require('fs').promises;
const path = require('path');

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn()
  }
}));

jest.mock('../../src/shared/logger', () => {
  const mock = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };
  return {
    createLogger: () => mock,
    logger: mock,
    __mockLogger: mock
  };
});

jest.mock('../../src/shared/singletonFactory', () => ({
  createSingletonHelpers: () => ({
    getInstance: jest.fn(),
    createInstance: jest.fn(),
    registerWithContainer: jest.fn(),
    resetInstance: jest.fn()
  })
}));

jest.mock('@orama/plugin-data-persistence', () => ({
  persist: jest.fn(async () => '{}'),
  restore: jest.fn(async () => {
    throw new Error('restore not available in test');
  })
}));

jest.mock('../../src/main/llamaUtils', () => ({
  getEmbeddingModel: jest.fn(() => 'nomic-embed-text-v1.5-Q8_0.gguf'),
  loadLlamaConfig: jest.fn().mockResolvedValue({
    selectedEmbeddingModel: 'nomic-embed-text-v1.5-Q8_0.gguf'
  })
}));

jest.mock('../../src/shared/pathTraceLogger', () => ({
  traceCoordinatorStart: jest.fn(),
  traceCoordinatorComplete: jest.fn(),
  traceDbUpdate: jest.fn()
}));

const { app } = require('electron');
const { OramaVectorService } = require('../../src/main/services/OramaVectorService');
const { FilePathCoordinator } = require('../../src/main/services/FilePathCoordinator');
const { getFileEmbeddingId } = require('../../src/main/utils/fileIdUtils');

const TEMP_DIR = path.join(__dirname, 'temp-organize-pipeline');

describe('organize pipeline (coordinator + vector DB)', () => {
  let vectorDb;
  let coordinator;
  let relationshipIndexService;
  let cacheInvalidationBus;
  const historyUpdates = [];

  beforeAll(async () => {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  });

  afterAll(async () => {
    try {
      await fs.rm(TEMP_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    app.getPath.mockReturnValue(TEMP_DIR);
    historyUpdates.length = 0;

    vectorDb = new OramaVectorService();
    await vectorDb.initialize();

    const analysisHistoryService = {
      updateEntryPaths: jest.fn(async (rows) => {
        historyUpdates.push(...rows);
      })
    };

    relationshipIndexService = { invalidateIndex: jest.fn() };
    cacheInvalidationBus = { invalidateForPathChange: jest.fn() };

    coordinator = new FilePathCoordinator({
      vectorDbService: vectorDb,
      analysisHistoryService,
      embeddingQueue: {
        updateByFilePath: jest.fn(),
        updateByFilePaths: jest.fn()
      },
      processingStateService: {
        moveJob: jest.fn().mockResolvedValue(undefined)
      },
      cacheInvalidationBus,
      relationshipIndexService
    });
  });

  afterEach(async () => {
    if (vectorDb) {
      await vectorDb.cleanup();
    }
  });

  test('after organize-style move: file embedding at new path, chunks removed for old ids', async () => {
    const oldPath = 'C:\\Project\\draft.pdf';
    const newPath = 'C:\\Archive\\draft.pdf';
    const oldFileId = getFileEmbeddingId(oldPath, 'file');
    const vec = new Array(768).fill(0.08);

    await vectorDb.upsertFile({
      id: oldFileId,
      vector: vec,
      meta: {
        path: oldPath,
        filePath: oldPath,
        fileName: 'draft.pdf',
        fileType: 'application/pdf',
        analyzedAt: new Date().toISOString()
      }
    });

    await vectorDb.batchUpsertFileChunks([
      {
        id: `${oldFileId}:chunk:0`,
        vector: vec,
        meta: {
          fileId: oldFileId,
          chunkIndex: 0,
          content: 'page one'
        }
      }
    ]);

    expect((await vectorDb.getChunksForFile(oldFileId)).length).toBe(1);

    const res = await coordinator.atomicPathUpdate(oldPath, newPath, { type: 'move' });
    expect(res.success).toBe(true);

    const newFileId = getFileEmbeddingId(newPath, 'file');
    const moved = await vectorDb.getFile(newFileId);
    expect(moved).toBeDefined();
    expect(moved.filePath).toBe(newPath);

    await expect(vectorDb.getFile(oldFileId)).resolves.toBeNull();
    expect((await vectorDb.getChunksForFile(oldFileId)).length).toBe(0);

    expect(historyUpdates).toEqual(
      expect.arrayContaining([expect.objectContaining({ oldPath, newPath, newName: 'draft.pdf' })])
    );
    expect(relationshipIndexService.invalidateIndex).toHaveBeenCalled();
    expect(cacheInvalidationBus.invalidateForPathChange).toHaveBeenCalledWith(
      oldPath,
      newPath,
      'move'
    );
  });
});
