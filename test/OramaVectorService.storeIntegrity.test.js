/**
 * The vector store must not destroy data it was only asked to read, or data
 * that belongs to a different file than the one named.
 *
 * 1. Orama 3.1.x search() nulls the vector ON THE STORED DOCUMENT of every
 *    hit unless includeVectors is set. Every query erased the vectors of the
 *    rows it returned; getByID then saw null (so every chunk clone on a move
 *    failed) and the next persist wrote the nulls to disk.
 * 2. `where` on a string property is a union over its tokens. The batch
 *    delete cascade had no exact-id guard, and deleteFileByPath trusted the
 *    match, so deleting one file removed other files' chunks and vectors.
 *
 * Real Orama, no module mock: both defects live in Orama's semantics.
 */

jest.mock('electron', () => ({ app: { getPath: jest.fn(() => '/tmp') } }));

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('../src/shared/singletonFactory', () => ({
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

jest.mock('../src/main/llamaUtils', () => ({
  getEmbeddingModel: jest.fn(() => 'all-MiniLM-L6-v2'),
  loadLlamaConfig: jest.fn().mockResolvedValue({}),
  getLlamaService: jest.fn(() => null)
}));

const { create, insert, getByID, count } = require('@orama/orama');
const { OramaVectorService } = require('../src/main/services/OramaVectorService');

const DIR = '/home/me/Documents';
const REPORT = `file:${DIR}/report.pdf`;
const REPORT_COPY = `file:${DIR}/report (1).pdf`;
const INVOICE = `file:${DIR}/invoice.pdf`;

async function makeService() {
  const files = await create({
    schema: {
      id: 'string',
      embedding: 'vector[3]',
      hasVector: 'boolean',
      filePath: 'string',
      fileName: 'string',
      fileType: 'string',
      analyzedAt: 'string',
      suggestedName: 'string',
      keywords: 'string[]',
      tags: 'string[]',
      isOrphaned: 'boolean',
      fileHash: 'string'
    }
  });
  const fileChunks = await create({
    schema: {
      id: 'string',
      embedding: 'vector[3]',
      fileId: 'string',
      chunkIndex: 'number',
      content: 'string',
      startOffset: 'number',
      endOffset: 'number'
    }
  });
  for (const [i, id] of [REPORT, REPORT_COPY, INVOICE].entries()) {
    const filePath = id.slice('file:'.length);
    await insert(files, {
      id,
      embedding: [1, i, 0],
      hasVector: true,
      filePath,
      fileName: filePath.split('/').pop(),
      fileType: 'document',
      analyzedAt: '2026-09-01T00:00:00.000Z',
      suggestedName: '',
      keywords: [],
      tags: [],
      isOrphaned: false,
      fileHash: `hash-${i}`
    });
  }

  const service = new OramaVectorService();
  service.initialize = jest.fn().mockResolvedValue();
  service._schedulePersist = jest.fn();
  service._emitSearchDataMutated = jest.fn();
  service._invalidateCacheForFile = jest.fn();
  service._databases.files = files;
  service._databases.fileChunks = fileChunks;
  service._collectionDimensions.files = 3;
  service._collectionDimensions.fileChunks = 3;
  service._embeddingStore.files = new Map();

  await service.batchUpsertFileChunks(
    [REPORT, REPORT_COPY, INVOICE].flatMap((fileId, f) =>
      [0, 1].map((i) => ({
        id: `chunk:${fileId}:${i}`,
        vector: [f + 1, i + 1, 1],
        meta: { fileId, chunkIndex: i, content: `${fileId} passage ${i}` }
      }))
    )
  );
  return { service, files, fileChunks };
}

describe('OramaVectorService never destroys what it only read', () => {
  test('queries leave stored vectors intact', async () => {
    const { service, files, fileChunks } = await makeService();

    await service.querySimilarFiles([1, 0, 0], 10);
    await service.querySimilarFileChunks([1, 0, 0], 10);
    await service.getChunksForFile(REPORT);
    await service.peekFiles(10);

    expect((await getByID(files, REPORT)).embedding).toEqual([1, 0, 0]);
    expect((await getByID(fileChunks, `chunk:${REPORT}:1`)).embedding).toEqual([1, 2, 1]);
  });

  test('a move after a search still carries every chunk vector (clone reads a live vector)', async () => {
    const { service, fileChunks } = await makeService();
    await service.getChunksForFile(REPORT);
    const DEST = 'file:/home/me/Archive/report.pdf';

    await expect(service.cloneFileChunks(REPORT, DEST)).resolves.toMatchObject({ count: 2 });
    expect((await getByID(fileChunks, `chunk:${DEST}:0`)).embedding).toEqual([1, 1, 1]);
  });

  test('chunk vectors are kept in the sidecar store, so a persist can recover them', async () => {
    const { service } = await makeService();

    expect(service._embeddingStore.fileChunks.get(`chunk:${INVOICE}:1`)).toEqual([3, 2, 1]);

    await service.deleteFileChunks(INVOICE);
    expect(service._embeddingStore.fileChunks.has(`chunk:${INVOICE}:1`)).toBe(false);
    expect(service._embeddingStore.fileChunks.has(`chunk:${REPORT}:1`)).toBe(true);
  });
});

describe('OramaVectorService deletes only the file it was asked to', () => {
  test('batchDeleteFileEmbeddings cascades into that file’s chunks only', async () => {
    const { service, fileChunks } = await makeService();

    await service.batchDeleteFileEmbeddings([REPORT]);

    expect(await count(fileChunks)).toBe(4);
    expect(await service.getChunksForFile(REPORT)).toEqual([]);
    expect((await service.getChunksForFile(INVOICE)).length).toBe(2);
    expect((await service.getChunksForFile(REPORT_COPY)).length).toBe(2);
  });

  test('deleteFileByPath removes the one duplicate, not its neighbours', async () => {
    const { service, files } = await makeService();

    const result = await service.deleteFileByPath(`${DIR}/report (1).pdf`);

    expect(result.deleted).toBe(1);
    expect(await getByID(files, REPORT_COPY)).toBeUndefined();
    expect(await getByID(files, REPORT)).toBeDefined();
    expect(await getByID(files, INVOICE)).toBeDefined();
    expect((await service.getChunksForFile(REPORT)).length).toBe(2);
  });

  test('findByHash returns only that hash', async () => {
    const { service } = await makeService();
    const docs = await service.findByHash('hash-1');
    expect(docs.map((d) => d.id)).toEqual([REPORT_COPY]);
  });
});
