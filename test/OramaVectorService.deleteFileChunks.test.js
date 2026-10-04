/**
 * Regression test for OramaVectorService.deleteFileChunks (found on real data).
 *
 * `deleteFileChunks(fileId)` streams `search(db, { term: '', where: { fileId } })`
 * and removes every hit. Orama does NOT do exact matching on a `string`-typed
 * property, so that `where` clause matches chunks belonging to OTHER files too
 * and the call wipes the whole collection.
 *
 * That was survivable while the rebuild cleared all chunks up front with one
 * global `resetFileChunks()` and then rewrote them. Once the rebuild became
 * monotonic (D5) and deletes each file's chunks individually just before
 * writing its replacements, every per-file delete wiped the chunks written for
 * all previous files: a rebuild reported ~1170 chunks written and left 0.
 *
 * These tests use the REAL Orama (no module mock) because the defect is in the
 * filter semantics; a mocked backend cannot reproduce it.
 */

jest.mock('electron', () => ({ app: { getPath: jest.fn(() => 'C:/tmp') } }));

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
  getEmbeddingModel: jest.fn(() => 'nomic-embed-text-v1.5-Q8_0.gguf'),
  loadLlamaConfig: jest.fn().mockResolvedValue({
    selectedEmbeddingModel: 'nomic-embed-text-v1.5-Q8_0.gguf'
  }),
  getLlamaService: jest.fn(() => null)
}));

const { create, insert, search, count } = require('@orama/orama');
const { OramaVectorService } = require('../src/main/services/OramaVectorService');

// Real canonical ids: a common `file:` prefix and shared path segments are
// exactly what makes Orama's tokenized string filter match across files.
const FILE_A = 'file:C:\\Users\\tester\\Documents\\report.pdf';
const FILE_B = 'file:C:\\Users\\tester\\Documents\\invoice.pdf';

async function makeChunkDb() {
  const db = await create({
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
  for (let i = 0; i < 3; i++) {
    await insert(db, {
      id: `chunk:${FILE_A}:${i}`,
      embedding: [1, 0, 0],
      fileId: FILE_A,
      chunkIndex: i,
      content: `alpha ${i}`,
      startOffset: 0,
      endOffset: 9
    });
  }
  for (let i = 0; i < 2; i++) {
    await insert(db, {
      id: `chunk:${FILE_B}:${i}`,
      embedding: [0, 1, 0],
      fileId: FILE_B,
      chunkIndex: i,
      content: `beta ${i}`,
      startOffset: 0,
      endOffset: 9
    });
  }
  return db;
}

function makeService(db) {
  const service = new OramaVectorService();
  service.initialize = jest.fn().mockResolvedValue();
  service._schedulePersist = jest.fn();
  service._emitSearchDataMutated = jest.fn();
  service._databases.fileChunks = db;
  return service;
}

describe('OramaVectorService.deleteFileChunks', () => {
  test("Orama's where filter on a string fileId over-matches (the underlying defect)", async () => {
    const db = await makeChunkDb();
    const res = await search(db, { term: '', where: { fileId: FILE_A }, limit: 1000 });
    const matchedOtherFile = res.hits.some((h) => h.document.fileId === FILE_B);
    // Documents reality rather than asserting the desired behaviour: the
    // filter is not exact, which is why the delete needs its own guard.
    expect(matchedOtherFile).toBe(true);
  });

  test('removes only the requested file\u2019s chunks and leaves other files intact', async () => {
    const db = await makeChunkDb();
    const service = makeService(db);

    const deleted = await service.deleteFileChunks(FILE_A);

    expect(deleted).toBe(3);
    expect(await count(db)).toBe(2);
    const remaining = await search(db, { term: '', limit: 1000 });
    expect(remaining.hits.map((h) => h.document.fileId)).toEqual([FILE_B, FILE_B]);
  });

  test('a rebuild that deletes each file in turn keeps every other file\u2019s chunks', async () => {
    const db = await makeChunkDb();
    const service = makeService(db);

    // The rebuild flush order: delete file A's rows, then file B's.
    await service.deleteFileChunks(FILE_A);
    expect(await count(db)).toBe(2);
    await service.deleteFileChunks(FILE_B);
    expect(await count(db)).toBe(0);
  });

  test('deleting a file with no chunks removes nothing', async () => {
    const db = await makeChunkDb();
    const service = makeService(db);

    const deleted = await service.deleteFileChunks('file:C:\\Users\\tester\\Documents\\absent.pdf');

    expect(deleted).toBe(0);
    expect(await count(db)).toBe(5);
  });
});

// Same over-match, the other three chunk operations. getChunksForFile feeds
// search's chunk-context snippets (keyed by chunkIndex, so a foreign chunk 1
// overwrote this file's chunk 1); cloneFileChunks runs on every organize move.
describe('OramaVectorService chunk operations are exact per file', () => {
  const FILE_A_BAK = `${FILE_A}.bak`;

  async function addChunks(db, fileId, n, label, start = 0) {
    for (let i = start; i < start + n; i++) {
      await insert(db, {
        id: `chunk:${fileId}:${i}`,
        embedding: [0, 0, 1],
        fileId,
        chunkIndex: i,
        content: `${label} ${i}`,
        startOffset: 0,
        endOffset: 9
      });
    }
  }

  test('getChunksForFile returns only that file\u2019s chunks', async () => {
    const db = await makeChunkDb();
    const service = makeService(db);

    const chunks = await service.getChunksForFile(FILE_A);

    expect(chunks.map((c) => c.text)).toEqual(['alpha 0', 'alpha 1', 'alpha 2']);
  });

  test('cloneFileChunks copies only the source file, not a sibling whose id contains it', async () => {
    const db = await makeChunkDb();
    await addChunks(db, FILE_A_BAK, 2, 'backup');
    const service = makeService(db);
    const DEST = 'file:C:\\Users\\tester\\Archive\\report.pdf';

    const result = await service.cloneFileChunks(FILE_A, DEST);

    expect(result.count).toBe(3);
    const dest = await service.getChunksForFile(DEST);
    expect(dest.map((c) => c.text)).toEqual(['alpha 0', 'alpha 1', 'alpha 2']);
    const all = await search(db, { term: '', limit: 1000 });
    expect(all.hits.some((h) => h.document.id.startsWith(`chunk:${DEST}.bak`))).toBe(false);
  });

  test('cloneFileChunks is idempotent when the destination already has the chunks', async () => {
    const db = await makeChunkDb();
    const service = makeService(db);
    const DEST = 'file:C:\\Users\\tester\\Archive\\report.pdf';

    await service.cloneFileChunks(FILE_A, DEST);
    await expect(service.cloneFileChunks(FILE_A, DEST)).resolves.toMatchObject({ count: 3 });
    expect((await service.getChunksForFile(DEST)).length).toBe(3);
  });

  test('deleteFileChunks reaches the target behind more than a page of other files\u2019 chunks', async () => {
    const db = await create({
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
    await addChunks(db, FILE_B, 1200, 'beta');
    await addChunks(db, FILE_A, 3, 'alpha');
    const service = makeService(db);

    const deleted = await service.deleteFileChunks(FILE_A);

    expect(deleted).toBe(3);
    expect(await count(db)).toBe(1200);
    expect(await service.getChunksForFile(FILE_A)).toEqual([]);
  }, 30000);
});
