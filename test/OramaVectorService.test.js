/**
 * Tests for OramaVectorService
 * TIER 1 - CRITICAL for vector storage and search
 */

const fs = require('fs').promises;
const path = require('path');
const { getByID } = require('@orama/orama');
let app;
let OramaVectorService;
let mockLogger;

// Mock dependencies
jest.mock('electron', () => ({
  app: {
    getPath: jest.fn()
  }
}));

// Mock logger
jest.mock('../src/shared/logger', () => {
  mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };
  return {
    createLogger: () => mockLogger,
    __mockLogger: mockLogger
  };
});

// Mock singleton factory
jest.mock('../src/shared/singletonFactory', () => ({
  createSingletonHelpers: () => ({
    getInstance: jest.fn(),
    createInstance: jest.fn(),
    registerWithContainer: jest.fn(),
    resetInstance: jest.fn()
  })
}));

// Mock Orama persistence plugin to avoid jest ESM issues
jest.mock('@orama/plugin-data-persistence', () => ({
  persist: jest.fn(async () => '{}'),
  restore: jest.fn(async () => {
    throw new Error('restore not available in test');
  })
}));

// Mock llama utils for deterministic embedding model selection
jest.mock('../src/main/llamaUtils', () => ({
  getEmbeddingModel: jest.fn(() => 'nomic-embed-text-v1.5-Q8_0.gguf'),
  loadLlamaConfig: jest.fn().mockResolvedValue({
    selectedEmbeddingModel: 'nomic-embed-text-v1.5-Q8_0.gguf'
  })
}));

// Use a temporary directory for tests
const TEMP_DIR = path.join(__dirname, 'temp-orama-test');

// Load mocked modules after jest.mock calls
({ app } = require('electron'));
({ OramaVectorService } = require('../src/main/services/OramaVectorService'));

describe('OramaVectorService', () => {
  let service;

  beforeAll(async () => {
    // Create temp directory
    try {
      await fs.mkdir(TEMP_DIR, { recursive: true });
    } catch (e) {
      // Ignore
    }
  });

  afterAll(async () => {
    // Cleanup temp directory
    try {
      await fs.rm(TEMP_DIR, { recursive: true, force: true });
    } catch (e) {
      // Ignore
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    app.getPath.mockReturnValue(TEMP_DIR);
    service = new OramaVectorService();
    const llamaUtils = require('../src/main/llamaUtils');
    llamaUtils.getEmbeddingModel.mockReturnValue('nomic-embed-text-v1.5-Q8_0.gguf');
  });

  afterEach(async () => {
    await service.cleanup();
  });

  describe('initialization', () => {
    test('initializes successfully', async () => {
      await service.initialize();
      expect(service._initialized).toBe(true);
      expect(service._databases.files).toBeDefined();
      expect(service._databases.folders).toBeDefined();
    });

    test('creates data directory', async () => {
      await service.initialize();
      const stats = await fs.stat(path.join(TEMP_DIR, 'vector-db'));
      expect(stats.isDirectory()).toBe(true);
    });

    test('uses active embedding model dimension', async () => {
      const llamaUtils = require('../src/main/llamaUtils');
      llamaUtils.getEmbeddingModel.mockReturnValue('mxbai-embed-large-v1-f16.gguf');

      await service.initialize();
      const stats = await service.getStats();

      expect(stats.dimension).toBe(1024);
    });

    test('reports vector health in stats', async () => {
      await service.initialize();
      const stats = await service.getStats();

      expect(stats.vectorHealth).toEqual(
        expect.objectContaining({
          primaryHealthy: true,
          lastValidatedAt: expect.any(Number)
        })
      );
    });
  });

  describe('file operations', () => {
    const testFile = {
      id: 'file-1',
      vector: new Array(768).fill(0.1),
      meta: {
        path: '/docs/test.pdf',
        fileName: 'test.pdf',
        fileType: 'application/pdf',
        analyzedAt: new Date().toISOString()
      }
    };

    beforeEach(async () => {
      await service.initialize();
    });

    test('upserts and retrieves file embedding', async () => {
      const result = await service.upsertFile(testFile);
      expect(result.success).toBe(true);

      const file = await service.getFile('file-1');
      expect(file).toBeDefined();
      expect(file.id).toBe('file-1');
      expect(file.embedding).toEqual(testFile.vector);
    });

    test('queries similar files', async () => {
      await service.upsertFile(testFile);

      // Query with same vector
      const results = await service.querySimilarFiles(testFile.vector, 5);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('file-1');
      expect(results[0].score).toBeGreaterThan(0.9); // Should be very close to 1
    });

    test('excludes placeholder vectors from primary similarity queries', async () => {
      await service.upsertFile(testFile);
      await service.upsertFile({
        id: 'file-zero',
        vector: new Array(768).fill(0),
        meta: {
          path: '/docs/placeholder.txt',
          fileName: 'placeholder.txt',
          fileType: 'text/plain',
          analyzedAt: new Date().toISOString()
        }
      });

      const results = await service.querySimilarFiles(testFile.vector, 10);
      expect(results.some((r) => r.id === 'file-zero')).toBe(false);
      expect(results.some((r) => r.id === 'file-1')).toBe(true);
    });

    test('deletes file embedding', async () => {
      await service.upsertFile(testFile);

      const deleteResult = await service.deleteFileEmbedding('file-1');
      expect(deleteResult).toBe(true);

      const file = await service.getFile('file-1');
      expect(file).toBeNull();
    });

    test('validates vector dimensions', async () => {
      const invalidFile = {
        ...testFile,
        vector: [0.1, 0.2] // Wrong dimension
      };

      const result = await service.upsertFile(invalidFile);
      expect(result.success).toBe(false);
      expect(result.error).toBe('dimension_mismatch');
    });
  });

  describe('single-doc lookup error handling (F-041)', () => {
    const throwingDb = () =>
      new Proxy(
        {},
        {
          get() {
            throw new Error('simulated orama read fault');
          }
        }
      );

    beforeEach(async () => {
      await service.initialize();
    });

    test('getFile logs at debug and returns null when the lookup throws (not a silent bare catch)', async () => {
      service._databases.files = throwingDb();

      await expect(service.getFile('any-id')).resolves.toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        '[OramaVectorService] getFile lookup failed',
        expect.objectContaining({
          id: 'any-id',
          error: 'simulated orama read fault'
        })
      );
    });

    test('getDocument logs at debug and returns null when the lookup throws', async () => {
      service._databases.files = throwingDb();

      await expect(service.getDocument('any-id')).resolves.toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        '[OramaVectorService] getDocument lookup failed',
        expect.objectContaining({
          id: 'any-id',
          error: 'simulated orama read fault'
        })
      );
    });

    test('getDocument returns null without logging a lookup failure when the db is absent (legitimate not-ready case)', async () => {
      service._databases.files = null;

      await expect(service.getDocument('any-id')).resolves.toBeNull();
      expect(mockLogger.debug).not.toHaveBeenCalledWith(
        '[OramaVectorService] getDocument lookup failed',
        expect.anything()
      );
    });
  });

  describe('folder operations', () => {
    const testFolder = {
      id: 'folder-1',
      vector: new Array(768).fill(0.2),
      meta: {
        name: 'Documents',
        path: '/Documents',
        description: 'My documents'
      }
    };

    beforeEach(async () => {
      await service.initialize();
    });

    test('upserts and queries folders', async () => {
      await service.upsertFolder(testFolder);

      const results = await service.queryFoldersByEmbedding(testFolder.vector, 5);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('folder-1');
      expect(results[0].metadata.folderName).toBe('Documents');
    });
  });

  describe('batch upsert operations', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    test('batchUpsertFiles uses bounded worker concurrency', async () => {
      service._batchUpsertConcurrency = 2;
      let active = 0;
      let maxActive = 0;
      jest.spyOn(service, 'upsertFile').mockImplementation(async (file) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { success: true, fileId: file.id };
      });

      const files = Array.from({ length: 5 }, (_, idx) => ({
        id: `file-${idx}`,
        vector: new Array(768).fill(0.1),
        meta: { path: `/docs/file-${idx}.txt` }
      }));

      const result = await service.batchUpsertFiles(files);

      expect(result.success).toBe(true);
      expect(result.count).toBe(5);
      expect(maxActive).toBeLessThanOrEqual(2);
    });

    test('batchUpsertFolders uses bounded worker concurrency', async () => {
      service._batchUpsertConcurrency = 2;
      let active = 0;
      let maxActive = 0;
      jest.spyOn(service, 'upsertFolder').mockImplementation(async (folder) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { success: true, folderId: folder.id };
      });

      const folders = Array.from({ length: 4 }, (_, idx) => ({
        id: `folder-${idx}`,
        vector: new Array(768).fill(0.2),
        meta: { path: `/folders/${idx}`, name: `Folder ${idx}` }
      }));

      const result = await service.batchUpsertFolders(folders);

      expect(result.success).toBe(true);
      expect(result.count).toBe(4);
      expect(maxActive).toBeLessThanOrEqual(2);
    });
  });

  describe('move/rename coordination', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    test('updateFilePaths updates filePath and can re-key the id', async () => {
      await service.upsertFile({
        id: 'old-id',
        vector: new Array(768).fill(0.11),
        meta: {
          path: 'C:\\old\\a.pdf',
          fileName: 'a.pdf',
          fileType: 'application/pdf',
          analyzedAt: new Date().toISOString()
        }
      });

      const updated = await service.updateFilePaths([
        {
          oldId: 'old-id',
          newId: 'new-id',
          newPath: 'C:\\new\\a-renamed.pdf',
          newName: 'a-renamed.pdf'
        }
      ]);

      expect(updated).toBe(1);
      await expect(service.getFile('old-id')).resolves.toBeNull();

      const file = await service.getFile('new-id');
      expect(file).toBeDefined();
      expect(file.id).toBe('new-id');
      expect(file.filePath).toBe('C:\\new\\a-renamed.pdf');
      expect(file.fileName).toBe('a-renamed.pdf');
    });

    test('updateFilePaths supports FilePathCoordinator-style newMeta payloads', async () => {
      await service.upsertFile({
        id: 'file:C:\\old\\b.pdf',
        vector: new Array(768).fill(0.22),
        meta: {
          path: 'C:\\old\\b.pdf',
          fileName: 'b.pdf',
          fileType: 'application/pdf',
          analyzedAt: new Date().toISOString()
        }
      });

      const updated = await service.updateFilePaths([
        {
          oldId: 'file:C:\\old\\b.pdf',
          newId: 'file:C:\\new\\b.pdf',
          newMeta: { path: 'C:\\new\\b.pdf', name: 'b.pdf' }
        }
      ]);

      expect(updated).toBe(1);
      await expect(service.getFile('file:C:\\old\\b.pdf')).resolves.toBeNull();
      const file = await service.getFile('file:C:\\new\\b.pdf');
      expect(file).toBeDefined();
      expect(file.filePath).toBe('C:\\new\\b.pdf');
      expect(file.fileName).toBe('b.pdf');
    });

    // Regression: a post-move re-key used to throw
    // "Cannot read properties of null (reading 'length')" inside Orama when the
    // stored document's `embedding` was null (Orama v3.1.x `restore()` loses inline
    // vector data; the real vector lives in the `_embeddingStore` sidecar). The throw
    // aborted the re-key, leaving the vector entry stale at the old path.
    test('updateFilePaths re-keys when stored embedding is null (Orama restore bug)', async () => {
      const vector = new Array(768).fill(0.33);
      await service.upsertFile({
        id: 'stale-id',
        vector,
        meta: {
          path: 'C:\\old\\c.pdf',
          fileName: 'c.pdf',
          fileType: 'application/pdf',
          analyzedAt: new Date().toISOString()
        }
      });

      // Simulate the Orama v3.1.x restore state: the stored doc's inline vector is
      // null while the sidecar still holds the real embedding.
      const stored = await getByID(service._databases.files, 'stale-id');
      stored.embedding = null;
      expect(service._embeddingStore.files.get('stale-id')).toEqual(vector);

      const updated = await service.updateFilePaths([
        {
          oldId: 'stale-id',
          newId: 'fresh-id',
          newPath: 'C:\\new\\c.pdf',
          newName: 'c.pdf'
        }
      ]);

      // The re-key succeeds instead of being swallowed by the catch/warn path.
      expect(updated).toBe(1);
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        '[OramaVectorService] Failed to update file path:',
        expect.anything()
      );

      await expect(service.getFile('stale-id')).resolves.toBeNull();
      const file = await service.getFile('fresh-id');
      expect(file).toBeDefined();
      expect(file.filePath).toBe('C:\\new\\c.pdf');
      expect(file.hasVector).toBe(true);

      // The vector is preserved (recovered from the sidecar), so the moved file is
      // still discoverable by similarity at its new id rather than left orphaned.
      expect(service._embeddingStore.files.get('fresh-id')).toEqual(vector);
      const results = await service.querySimilarFiles(vector, 5);
      expect(results.some((r) => r.id === 'fresh-id')).toBe(true);
    });

    test('updateFilePaths renames in-place without throwing when no vector survives', async () => {
      await service.upsertFile({
        id: 'novec-id',
        vector: new Array(768).fill(0.44),
        meta: {
          path: 'C:\\old\\d.pdf',
          fileName: 'd.pdf',
          fileType: 'application/pdf',
          analyzedAt: new Date().toISOString()
        }
      });

      // Drop the inline vector AND the sidecar copy: nothing valid remains, so the
      // re-key must fall back to a placeholder rather than crash on null.length.
      const stored = await getByID(service._databases.files, 'novec-id');
      stored.embedding = null;
      service._embeddingStore.files.delete('novec-id');

      const updated = await service.updateFilePaths([
        {
          oldId: 'novec-id',
          newId: 'novec-id',
          newPath: 'C:\\old\\d-renamed.pdf',
          newName: 'd-renamed.pdf'
        }
      ]);

      expect(updated).toBe(1);
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        '[OramaVectorService] Failed to update file path:',
        expect.anything()
      );

      const file = await service.getFile('novec-id');
      expect(file).toBeDefined();
      expect(file.filePath).toBe('C:\\old\\d-renamed.pdf');
      expect(file.fileName).toBe('d-renamed.pdf');
      // No real vector survived, so the entry is flagged for sidecar repair rather
      // than cached as a bogus zero vector.
      expect(file.hasVector).toBe(false);
      expect(service._embeddingStore.files.has('novec-id')).toBe(false);
    });
  });

  describe('persistence scheduling', () => {
    beforeEach(async () => {
      await service.initialize();
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('debounces persistence writes', async () => {
      const spy = jest.spyOn(service, '_doPersist').mockResolvedValue(undefined);
      service._lastPersist = Date.now();

      service._schedulePersist();
      service._schedulePersist();
      service._schedulePersist();

      expect(spy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(5000);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    test('forces persist immediately when max wait exceeded', async () => {
      const spy = jest.spyOn(service, '_doPersist').mockResolvedValue(undefined);
      service._lastPersist = Date.now() - 60_000;

      service._schedulePersist();
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('peekFiles', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    test('excludes orphaned and no-vector documents from clustering sample', async () => {
      for (let i = 0; i < 5; i++) {
        await service.upsertFile({
          id: `peek-${i}`,
          vector: new Array(768).fill(0.01 + i * 0.001),
          meta: {
            path: `/docs/peek-${i}.pdf`,
            filePath: `/docs/peek-${i}.pdf`,
            fileName: `peek-${i}.pdf`,
            fileType: 'application/pdf',
            analyzedAt: new Date().toISOString()
          }
        });
      }

      await service.markEmbeddingsOrphaned(['peek-0', 'peek-1']);

      const { ids, embeddings } = await service.peekFiles(50);
      expect(ids).toHaveLength(3);
      expect(ids).toEqual(expect.arrayContaining(['peek-2', 'peek-3', 'peek-4']));
      expect(embeddings).toHaveLength(3);

      await service.upsertFile({
        id: 'peek-zero',
        vector: new Array(768).fill(0),
        meta: {
          path: '/docs/zero.pdf',
          filePath: '/docs/zero.pdf',
          fileName: 'zero.pdf',
          fileType: 'application/pdf',
          analyzedAt: new Date().toISOString()
        }
      });

      const afterZero = await service.peekFiles(50);
      expect(afterZero.ids).not.toContain('peek-zero');

      await service.markEmbeddingsOrphaned(['peek-2', 'peek-3', 'peek-4']);
      const allOrphan = await service.peekFiles(50);
      expect(allOrphan.ids).toHaveLength(0);
    });

    // F-221: an orphan mark is reversible. When the file turns out to exist
    // again the row must come back with its ORIGINAL vector, no re-embed.
    test('restoreOrphanedEmbeddings brings marked rows back with their original vector', async () => {
      for (let i = 0; i < 3; i++) {
        await service.upsertFile({
          id: `rest-${i}`,
          vector: new Array(768).fill(0.02 + i * 0.001),
          meta: { path: `/docs/rest-${i}.pdf`, fileName: `rest-${i}.pdf` }
        });
      }
      await service.markEmbeddingsOrphaned(['rest-0', 'rest-1']);
      expect((await service.peekFiles(50)).ids).toEqual(['rest-2']);

      const result = await service.restoreOrphanedEmbeddings(['rest-0', 'missing-id']);
      expect(result).toEqual({ restored: 1, failed: 0, missing: 1 });

      const after = await service.peekFiles(50);
      expect(after.ids).toEqual(expect.arrayContaining(['rest-0', 'rest-2']));
      expect(after.ids).not.toContain('rest-1');
      const doc = await service.getFile('rest-0');
      expect(doc.isOrphaned).toBe(false);
      expect(doc.orphanedAt).toBe('');
      expect(await service.getOrphanedEmbeddings()).toEqual(['rest-1']);
    });

    // F-222: the reaper needs the PATH of each orphan to re-check the disk,
    // and an age filter so only long-gone rows are removed.
    test('getOrphanedFileDocs returns id + path and honors the age filter', async () => {
      await service.upsertFile({
        id: 'orph-0',
        vector: new Array(768).fill(0.03),
        meta: { path: '/docs/orph-0.pdf', fileName: 'orph-0.pdf' }
      });
      await service.markEmbeddingsOrphaned(['orph-0']);

      const all = await service.getOrphanedFileDocs();
      expect(all).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'orph-0',
            path: '/docs/orph-0.pdf',
            orphanedAt: expect.any(String)
          })
        ])
      );
      // Marked just now: not older than one hour.
      expect(await service.getOrphanedFileDocs(60 * 60 * 1000)).toEqual([]);
    });
  });

  describe('persistence', () => {
    test('persists data to disk', async () => {
      await service.initialize();

      // Upsert data
      await service.upsertFile({
        id: 'persist-file',
        vector: new Array(768).fill(0.5),
        meta: { fileName: 'persist.txt' }
      });

      // Force persist
      await service.persistAll();

      // Ensure persistence did not error
      expect(mockLogger.error).not.toHaveBeenCalled();

      // Check for any files.json persistence output
      const dataDir = path.join(TEMP_DIR, 'vector-db');
      const entries = await fs.readdir(dataDir);
      const hasFilesPersist = entries.some((name) => name.startsWith('files.json'));
      expect(hasFilesPersist).toBe(true);
    });
  });
});
