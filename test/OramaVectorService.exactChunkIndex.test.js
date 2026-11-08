/**
 * repair-storage-4: one file's chunk rows are found through an exact
 * fileId -> chunk ids index instead of a scan of the whole chunk collection.
 *
 * Orama's string `where` filter is token based, so `where: { fileId }` pages
 * through most of the collection. Startup passage repair asked it once per
 * file (describeFileChunks, then deleteFileChunks for a file with no rows),
 * so a launch that repaired many files paid files x chunks. These tests run
 * against the REAL Orama chunk collection.
 */

jest.mock('electron', () => ({ app: { getPath: jest.fn(() => 'C:/tmp') } }));

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })
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
  loadLlamaConfig: jest.fn().mockResolvedValue({}),
  getLlamaService: jest.fn(() => null)
}));

jest.mock('../src/main/services/SettingsService', () => ({
  getInstance: () => ({ load: async () => ({}) })
}));

jest.mock('../src/main/services/embedding/embeddingGate', () => ({
  shouldEmbed: jest.fn(async () => ({ shouldEmbed: true })),
  shouldEmbedForRepair: jest.fn(async () => ({ shouldEmbed: true }))
}));

const { create, insert: rawInsert, remove: rawRemove } = require('@orama/orama');
const { OramaVectorService } = require('../src/main/services/OramaVectorService');
const {
  repairKnowledge,
  repairStoredPassages
} = require('../src/main/services/embedding/knowledgeRepair');
const { getSemanticFileId } = require('../src/shared/fileIdUtils');

// Real-looking paths: the shared `file:` prefix and path segments are what
// make Orama's string filter match other files' chunks.
const BS = String.fromCharCode(92);
const DIR = ['C:', 'Users', 'tester', 'Documents', ''].join(BS);
const pathOf = (name) => `${DIR}${name}`;
const idOf = (name) => getSemanticFileId(pathOf(name));

const CHUNK_SCHEMA = {
  id: 'string',
  embedding: 'vector[3]',
  fileId: 'string',
  chunkIndex: 'number',
  content: 'string',
  startOffset: 'number',
  endOffset: 'number'
};

async function makeService() {
  const service = new OramaVectorService();
  service.initialize = jest.fn().mockResolvedValue();
  service._schedulePersist = jest.fn();
  service._emitSearchDataMutated = jest.fn();
  service.persistAll = jest.fn(async () => ({ success: true }));
  service._dimension = 3;
  service._schemas = { ...(service._schemas || {}), fileChunks: CHUNK_SCHEMA };
  service._databases.fileChunks = await create({ schema: CHUNK_SCHEMA });
  service.getFile = jest.fn(async (id) => ({ id, isOrphaned: false, hasVector: true }));
  service.hasUsableVector = jest.fn(async () => true);
  return service;
}

/** Chunk payloads for batchUpsertFileChunks. */
function payloadsFor(fileId, n, vector = [0.5, 0.5, 0.5]) {
  return Array.from({ length: n }, (_, i) => ({
    id: `chunk:${fileId}:${i}`,
    vector,
    meta: { fileId, chunkIndex: i, content: `passage ${i} of ${fileId}`, startOffset: i * 10 },
    document: `passage ${i}`
  }));
}

/**
 * Rows written straight into Orama (what a restore leaves): 'ok' has a real
 * sidecar vector, 'placeholder' an all-zero one.
 */
function addRawChunks(service, fileId, states) {
  const store = service._chunkVectorStore();
  states.forEach((state, i) => {
    const id = `chunk:${fileId}:${i}`;
    rawInsert(service._databases.fileChunks, {
      id,
      embedding: state === 'placeholder' ? [0, 0, 0] : [1, 0, 0],
      fileId,
      chunkIndex: i,
      content: `passage ${i} of ${fileId}`,
      startOffset: i * 800,
      endOffset: i * 800 + 1000
    });
    store.set(id, state === 'placeholder' ? [0, 0, 0] : [0.5, 0.5, 0.5]);
  });
}

const entryFor = (name) => ({
  originalPath: pathOf(name),
  analysis: { summary: 's', extractedText: `${name} `.repeat(60) }
});

describe('passage repair cost does not grow with files x chunks', () => {
  test('repairing N files scans the chunk collection a constant number of times', async () => {
    const service = await makeService();
    const names = Array.from({ length: 6 }, (_, i) => `doc${i}.pdf`);
    for (const name of names) addRawChunks(service, idOf(name), ['ok', 'placeholder']);
    const entries = Object.fromEntries(
      [...names, 'unbuilt.pdf'].map((name) => [name, entryFor(name)])
    );
    const embed = jest.fn(async () => ({ vector: [0.1, 0.2, 0.3], model: 'm' }));
    const scans = jest.spyOn(service, '_paginatedSearch');

    const summary = await repairKnowledge({
      entries,
      vectorDb: service,
      embedEntry: jest.fn(async () => ({ action: 'enqueued' })),
      repairPassages: ({ entry, filePath }) =>
        repairStoredPassages({ entry, filePath, embedText: embed, vectorDb: service }),
      fileExists: jest.fn(async () => true)
    });

    expect(summary.passages).toBe(7);
    // One health snapshot plus one build of the exact index; before, one
    // more full scan per repaired file and another for the unbuilt file's
    // delete-before-rebuild.
    expect(scans.mock.calls.length).toBeLessThanOrEqual(2);
    for (const name of names) {
      expect(await service.describeFileChunks(idOf(name))).toEqual({
        count: 2,
        placeholderCount: 0,
        missingVectorCount: 0
      });
    }
    expect((await service.describeFileChunks(idOf('unbuilt.pdf'))).count).toBeGreaterThan(0);
    expect(scans.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe('exact per-file chunk lookup', () => {
  test('returns only the file’s own rows when other ids share its tokens', async () => {
    const service = await makeService();
    const a = idOf('report.pdf');
    const b = idOf('report.pdf.bak');
    const c = idOf(`report${BS}report.pdf`);
    await service.batchUpsertFileChunks([
      ...payloadsFor(a, 3),
      ...payloadsFor(b, 2),
      ...payloadsFor(c, 4)
    ]);

    const hits = await service._collectExactFileChunkHits(a, 'test');
    expect(hits.map((h) => h.document.id).sort()).toEqual([0, 1, 2].map((i) => `chunk:${a}:${i}`));
    expect(hits.every((h) => h.document.fileId === a)).toBe(true);
    // Same hit shape as a search: the vector comes from the sidecar only.
    expect(hits[0].document.embedding).toBeNull();
    expect((await service.describeFileChunks(c)).count).toBe(4);
  });

  test('stays exact across upserts, deletes, clones and a reset', async () => {
    const service = await makeService();
    const a = idOf('a.pdf');
    const b = idOf('b.pdf');
    await service.batchUpsertFileChunks(payloadsFor(a, 3));
    expect((await service.describeFileChunks(a)).count).toBe(3);

    // New rows after the index was built.
    await service.batchUpsertFileChunks(payloadsFor(b, 2));
    expect((await service.describeFileChunks(b)).count).toBe(2);
    // Re-upserting the same ids (insert fails, update replaces) adds nothing.
    await service.batchUpsertFileChunks(payloadsFor(a, 3));
    expect((await service.describeFileChunks(a)).count).toBe(3);

    await service.cloneFileChunks(a, idOf('moved.pdf'));
    expect((await service.describeFileChunks(idOf('moved.pdf'))).count).toBe(3);

    expect(await service.deleteFileChunks(a)).toBe(3);
    expect((await service.describeFileChunks(a)).count).toBe(0);
    expect(await service.hasFileChunks(a)).toBe(false);
    expect((await service.describeFileChunks(b)).count).toBe(2);

    await service.resetFileChunks();
    expect((await service.describeFileChunks(b)).count).toBe(0);
    await service.batchUpsertFileChunks(payloadsFor(b, 1));
    expect((await service.describeFileChunks(b)).count).toBe(1);
  });

  test('a write that bypassed the service is picked up, never answered wrongly', async () => {
    const service = await makeService();
    const a = idOf('a.pdf');
    await service.batchUpsertFileChunks(payloadsFor(a, 2));
    expect((await service.describeFileChunks(a)).count).toBe(2);

    for (const i of [2, 9]) {
      rawInsert(service._databases.fileChunks, {
        id: `chunk:${a}:${i}`,
        embedding: [1, 0, 0],
        fileId: a,
        chunkIndex: i,
        content: 'x',
        startOffset: 0,
        endOffset: 1
      });
    }
    expect((await service.describeFileChunks(a)).count).toBe(4);

    rawRemove(service._databases.fileChunks, `chunk:${a}:9`);
    expect((await service.describeFileChunks(a)).count).toBe(3);
  });

  test('getChunksForFile keeps chunk order from the exact lookup', async () => {
    const service = await makeService();
    const a = idOf('ordered.pdf');
    await service.batchUpsertFileChunks(payloadsFor(a, 4).reverse());
    const chunks = await service.getChunksForFile(a);
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2, 3]);
  });
});
