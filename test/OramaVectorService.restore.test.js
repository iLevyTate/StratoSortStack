/**
 * Restore-path tests for OramaVectorService.
 * Ensures docs missing embeddings retain BM25 recall via placeholder vectors.
 */

const mockCreate = jest.fn();
const mockInsert = jest.fn();
const mockUpdate = jest.fn();
let mockLogger;

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/mock-user-data')
  }
}));

jest.mock('../src/shared/logger', () => {
  mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };
  return {
    createLogger: () => mockLogger
  };
});

jest.mock('../src/shared/singletonFactory', () => ({
  createSingletonHelpers: () => ({
    getInstance: jest.fn(),
    createInstance: jest.fn(),
    registerWithContainer: jest.fn(),
    resetInstance: jest.fn()
  })
}));

jest.mock('@orama/orama', () => ({
  create: (...args) => mockCreate(...args),
  insert: (...args) => mockInsert(...args),
  search: jest.fn(),
  remove: jest.fn(),
  update: (...args) => mockUpdate(...args),
  count: jest.fn(),
  getByID: jest.fn()
}));

jest.mock('@orama/plugin-data-persistence', () => ({
  persist: jest.fn(),
  restore: jest.fn()
}));

const mockDegradedRaise = jest.fn();
jest.mock('../src/main/services/DegradedStateTracker', () => ({
  getInstance: () => ({ raise: mockDegradedRaise, clear: jest.fn() })
}));

jest.mock('lz4-napi', () => ({
  compress: jest.fn(async (buf) => buf),
  uncompress: jest.fn(async () => {
    throw new Error('Not used in this test');
  })
}));

const mockFs = {
  readFile: jest.fn(),
  unlink: jest.fn(),
  rename: jest.fn(),
  mkdir: jest.fn(),
  writeFile: jest.fn(),
  stat: jest.fn()
};

jest.mock('fs', () => ({
  promises: mockFs
}));

const { OramaVectorService } = require('../src/main/services/OramaVectorService');
const { getByID: mockGetByID, search: mockSearch } = require('@orama/orama');
const { persist: mockPersist } = require('@orama/plugin-data-persistence');

describe('OramaVectorService restore behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreate.mockResolvedValue({ _name: 'mock-db' });
    mockInsert.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue(undefined);
  });

  test('uses zero-vector placeholders for documents missing embeddings during restore', async () => {
    const persisted = JSON.stringify({
      docs: {
        docs: {
          a: {
            id: 'a',
            embedding: null,
            filePath: '/a.txt',
            fileName: 'a.txt',
            fileType: 'text/plain',
            analyzedAt: new Date().toISOString()
          },
          b: {
            id: 'b',
            embedding: [0.1, 0.2, 0.3],
            filePath: '/b.txt',
            fileName: 'b.txt',
            fileType: 'text/plain',
            analyzedAt: new Date().toISOString()
          }
        }
      }
    });

    mockFs.readFile.mockImplementation(async (targetPath) => {
      const filePath = String(targetPath);
      if (filePath.endsWith('.lz4')) {
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      if (filePath.endsWith('files.json')) return persisted;
      if (filePath.endsWith('files.sidecar.json')) return JSON.stringify({});
      throw new Error(`Unexpected readFile path: ${filePath}`);
    });

    const service = new OramaVectorService();
    service._dataPath = '/mock-user-data/vector-db';
    service._dimension = 3;
    service._embeddingStore = {};
    service._collectionDimensions = {};
    service._clearQueryCache = jest.fn();

    const schema = { id: 'string', embedding: 'vector[3]' };
    const db = await service._createOrRestoreDatabase('files', schema);

    expect(db).toEqual({ _name: 'mock-db' });
    expect(mockInsert).toHaveBeenCalledTimes(2);
    expect(mockInsert).toHaveBeenCalledWith(
      { _name: 'mock-db' },
      expect.objectContaining({ id: 'a', embedding: [0, 0, 0] })
    );
    expect(mockInsert).toHaveBeenCalledWith(
      { _name: 'mock-db' },
      expect.objectContaining({ id: 'b' })
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Using zero-vector placeholder for files doc missing embedding during restore'
      ),
      expect.objectContaining({ id: 'a' })
    );
  });

  test('restores missing embeddings from sidecar before placeholder fallback', async () => {
    const persisted = JSON.stringify({
      docs: {
        docs: {
          a: {
            id: 'a',
            embedding: null,
            filePath: '/a.txt',
            fileName: 'a.txt',
            fileType: 'text/plain',
            analyzedAt: new Date().toISOString()
          }
        }
      }
    });

    mockFs.readFile.mockImplementation(async (targetPath) => {
      const filePath = String(targetPath);
      if (filePath.endsWith('.lz4')) {
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      if (filePath.endsWith('files.json')) return persisted;
      if (filePath.endsWith('files.sidecar.json')) return JSON.stringify({ a: [0.1, 0.2, 0.3] });
      throw new Error(`Unexpected readFile path: ${filePath}`);
    });

    const service = new OramaVectorService();
    service._dataPath = '/mock-user-data/vector-db';
    service._dimension = 3;
    service._embeddingStore = {};
    service._collectionDimensions = {};
    service._clearQueryCache = jest.fn();

    const schema = { id: 'string', embedding: 'vector[3]' };
    await service._createOrRestoreDatabase('files', schema);

    expect(mockInsert).toHaveBeenCalledWith(
      { _name: 'mock-db' },
      expect.objectContaining({ id: 'a', embedding: [0.1, 0.2, 0.3] })
    );
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Using zero-vector placeholder'),
      expect.anything()
    );
  });

  test('normalizes sidecar embeddings persisted as numeric-key objects', async () => {
    const persisted = JSON.stringify({
      docs: {
        docs: {
          a: {
            id: 'a',
            embedding: null,
            filePath: '/a.txt',
            fileName: 'a.txt',
            fileType: 'text/plain',
            analyzedAt: new Date().toISOString()
          }
        }
      }
    });

    mockFs.readFile.mockImplementation(async (targetPath) => {
      const filePath = String(targetPath);
      if (filePath.endsWith('.lz4')) {
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      if (filePath.endsWith('files.json')) return persisted;
      if (filePath.endsWith('files.sidecar.json'))
        return JSON.stringify({ a: { 0: 0.1, 1: 0.2, 2: 0.3 } });
      throw new Error(`Unexpected readFile path: ${filePath}`);
    });

    const service = new OramaVectorService();
    service._dataPath = '/mock-user-data/vector-db';
    service._dimension = 3;
    service._embeddingStore = {};
    service._collectionDimensions = {};
    service._clearQueryCache = jest.fn();

    const schema = { id: 'string', embedding: 'vector[3]' };
    await service._createOrRestoreDatabase('files', schema);

    expect(mockInsert).toHaveBeenCalledWith(
      { _name: 'mock-db' },
      expect.objectContaining({ id: 'a', embedding: [0.1, 0.2, 0.3] })
    );
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Using zero-vector placeholder'),
      expect.anything()
    );
  });

  test('cloneFileEmbedding prefers sidecar embedding when source document embedding is missing', async () => {
    mockGetByID.mockResolvedValueOnce({
      id: 'file:source',
      embedding: undefined,
      hasVector: false,
      filePath: '/source.txt',
      fileName: 'source.txt',
      fileType: 'text/plain',
      analyzedAt: new Date().toISOString(),
      suggestedName: '',
      keywords: [],
      tags: [],
      isOrphaned: false,
      orphanedAt: '',
      extractionMethod: ''
    });

    const service = new OramaVectorService();
    service.initialize = jest.fn().mockResolvedValue(undefined);
    service._databases = { files: { _name: 'mock-files-db' } };
    service._dimension = 3;
    service._embeddingStore = {
      files: new Map([['file:source', [0.1, 0.2, 0.3]]])
    };
    service._invalidateCacheForFile = jest.fn();
    service._schedulePersist = jest.fn();

    const result = await service.cloneFileEmbedding('file:source', 'file:dest', {
      path: '/dest.txt',
      name: 'dest.txt'
    });

    expect(result).toEqual({ success: true, cloned: true });
    expect(mockInsert).toHaveBeenCalledWith(
      service._databases.files,
      expect.objectContaining({
        id: 'file:dest',
        embedding: [0.1, 0.2, 0.3],
        hasVector: true,
        filePath: '/dest.txt',
        fileName: 'dest.txt'
      })
    );
    expect(service._embeddingStore.files.get('file:dest')).toEqual([0.1, 0.2, 0.3]);
  });

  test('cloneFileEmbedding fails safely when no valid source embedding exists', async () => {
    mockGetByID.mockResolvedValueOnce({
      id: 'file:source',
      embedding: undefined,
      hasVector: false,
      filePath: '/source.txt',
      fileName: 'source.txt',
      fileType: 'text/plain'
    });

    const service = new OramaVectorService();
    service.initialize = jest.fn().mockResolvedValue(undefined);
    service._databases = { files: { _name: 'mock-files-db' } };
    service._dimension = 3;
    service._embeddingStore = { files: new Map() };

    const result = await service.cloneFileEmbedding('file:source', 'file:dest', {
      path: '/dest.txt',
      name: 'dest.txt'
    });

    expect(result).toEqual({
      success: false,
      cloned: false,
      error: 'Source file has no valid embedding to clone'
    });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  test('rebuild repair uses full persistence snapshot (not capped search slices)', async () => {
    const docCount = 10020;
    const docs = {};
    for (let i = 0; i < docCount; i++) {
      docs[`file:${i}`] = {
        id: `file:${i}`,
        embedding: [0.1, 0.2, 0.3],
        filePath: `/doc-${i}.txt`,
        fileName: `doc-${i}.txt`,
        fileType: 'text/plain',
        analyzedAt: new Date().toISOString(),
        keywords: [],
        tags: []
      };
    }

    mockPersist.mockResolvedValueOnce({
      docs: {
        docs
      }
    });

    const service = new OramaVectorService();
    service._dimension = 3;
    service._schemas = {
      files: { id: 'string', embedding: 'vector[3]', hasVector: 'boolean', filePath: 'string' }
    };
    service._databases = { files: { _name: 'files-db' } };
    service._embeddingStore = { files: new Map() };
    service._collectionDimensions = {};
    service._clearQueryCache = jest.fn();
    service.persistAll = jest.fn().mockResolvedValue(undefined);

    const result = await service._repairFilesVectorIndexFromCurrentState();

    expect(result).toEqual(
      expect.objectContaining({
        repaired: true,
        repairedDocs: docCount
      })
    );
    expect(mockPersist).toHaveBeenCalledWith({ _name: 'files-db' });
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockInsert).toHaveBeenCalledTimes(docCount);
    expect(service.persistAll).toHaveBeenCalledTimes(1);
  });
  describe('dimension guard on an empty collection', () => {
    function makeService() {
      const service = new OramaVectorService();
      service._dimension = 3;
      service._collectionDimensions = { files: null };
      return service;
    }

    test('a vector of the wrong length is refused against the schema dimension, and nothing is cached', async () => {
      const service = makeService();

      const result = await service.validateEmbeddingDimension([1, 2, 3, 4], 'files');

      expect(result).toEqual({
        valid: false,
        error: 'dimension_mismatch',
        expectedDim: 3,
        actualDim: 4
      });
      expect(service._collectionDimensions.files).toBeNull();
    });

    test('a vector of the schema length is accepted and fixes the collection dimension', async () => {
      const service = makeService();

      await expect(service.validateEmbeddingDimension([1, 2, 3], 'files')).resolves.toEqual({
        valid: true
      });
      expect(service._collectionDimensions.files).toBe(3);
    });

    test('batch validation applies the same schema floor', () => {
      const service = makeService();

      // A stale old-model vector arriving first, alone, must be measured
      // against the schema, not taken as the batch's own yardstick.
      expect(service._validateBatchDimensions([{ vector: [1, 2] }], 'files')).toEqual({
        valid: false,
        error: 'dimension_mismatch',
        expectedDim: 3,
        actualDim: 2
      });
      expect(service._collectionDimensions.files).toBeNull();

      expect(
        service._validateBatchDimensions([{ vector: [1, 2] }, { vector: [1, 2, 3] }], 'files')
      ).toEqual({ valid: false, error: 'dimension_mismatch', expectedDim: 3, actualDim: 2 });
      expect(service._collectionDimensions.files).toBeNull();

      expect(service._validateBatchDimensions([{ vector: [1, 2, 3] }], 'files')).toEqual({
        valid: true
      });
      expect(service._collectionDimensions.files).toBe(3);
    });

    test('without a resolved schema dimension the first vector still sets the collection dimension', async () => {
      const service = new OramaVectorService();
      service._dimension = null;
      service._collectionDimensions = { files: null };

      await expect(service.validateEmbeddingDimension([1, 2, 3, 4], 'files')).resolves.toEqual({
        valid: true
      });
      expect(service._collectionDimensions.files).toBe(4);
    });
  });

  test('a persisted store of another dimension is archived together with its rolling backups', async () => {
    const persisted = JSON.stringify({
      docs: {
        docs: {
          a: {
            id: 'a',
            embedding: [0.1, 0.2, 0.3, 0.4],
            filePath: '/a.txt',
            fileName: 'a.txt',
            fileType: 'text/plain',
            analyzedAt: new Date().toISOString()
          }
        }
      }
    });

    mockFs.readFile.mockImplementation(async (targetPath) => {
      const filePath = String(targetPath);
      if (filePath.endsWith('.lz4')) {
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      if (filePath.endsWith('files.json')) return persisted;
      if (filePath.endsWith('files.sidecar.json')) return JSON.stringify({});
      throw new Error(`Unexpected readFile path: ${filePath}`);
    });
    mockFs.rename.mockImplementation(async (from) => {
      if (String(from).endsWith('files.json.lz4.bak')) {
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }
      return undefined;
    });

    const service = new OramaVectorService();
    service._dataPath = '/mock-user-data/vector-db';
    service._dimension = 3;
    service._embeddingStore = {};
    service._collectionDimensions = {};
    service._clearQueryCache = jest.fn();

    const schema = { id: 'string', embedding: 'vector[3]' };
    const db = await service._createOrRestoreDatabase('files', schema);

    expect(db).toEqual({ _name: 'mock-db' });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(service._collectionDimensions.files).toBeNull();

    // The service joins these paths with path.sep, so on Windows `from` ends in
    // `\files.json`; normalise to forward slashes so the suffixes below hold on
    // every platform.
    const renamed = mockFs.rename.mock.calls.map(([from, to]) => [
      String(from).replace(/\\/g, '/'),
      String(to)
    ]);
    const archivedFor = (suffix) =>
      renamed.find(([from]) => from.endsWith(suffix) && !from.endsWith(`.bak${suffix}`));
    const stampPattern = /\.dim4\.\d+\.bak$/;

    expect(archivedFor('/files.json')[1]).toMatch(stampPattern);
    expect(archivedFor('/files.json.lz4')[1]).toMatch(stampPattern);
    // The rolling backups hold the same four-dimensional vectors. Left in
    // place they would be restored on the next launch and trip this branch
    // again, so they are set aside under the same stamp.
    expect(archivedFor('/files.json.bak')[1]).toMatch(stampPattern);
    expect(archivedFor('/files.json.lz4.bak')[1]).toMatch(stampPattern);
    // A missing rolling backup is the normal case, not something to log.
    expect(mockLogger.debug).not.toHaveBeenCalledWith(
      expect.stringContaining('Could not archive files rolling backup'),
      expect.anything()
    );

    expect(mockDegradedRaise).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'orama.dimension-changed:files',
        detail: expect.objectContaining({ oldDimension: 4, newDimension: 3 })
      })
    );
  });
});
