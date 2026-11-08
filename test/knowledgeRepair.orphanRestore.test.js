/**
 * Startup repair against the REAL vector store: a row that search orphan-marked
 * (stale path) but whose file is on disk again keeps its vector, so the repair
 * un-flags it instead of re-embedding it through the model. Only a row whose
 * stored vector is missing or all zeros is re-embedded.
 *
 * The store's own usability check (hasUsableVector) reads an orphan-marked row
 * as unusable, which is what sent every orphaned row to the embedder before.
 */

jest.mock('electron', () => ({ app: { getPath: jest.fn(() => '/tmp') } }));

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
  getEmbeddingModel: jest.fn(() => 'all-MiniLM-L6-v2'),
  loadLlamaConfig: jest.fn().mockResolvedValue({}),
  getLlamaService: jest.fn(() => null)
}));

const { create, insert } = require('@orama/orama');
const { OramaVectorService } = require('../src/main/services/OramaVectorService');
const { repairKnowledge } = require('../src/main/services/embedding/knowledgeRepair');
const { getSemanticFileId } = require('../src/shared/fileIdUtils');

const DIR = '/home/me/Share';
const INTACT = `${DIR}/intact.pdf`;
const ZEROED = `${DIR}/zeroed.pdf`;

async function makeService(rows) {
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
      orphanedAt: 'string',
      fileHash: 'string'
    }
  });
  for (const { filePath, embedding } of rows) {
    await insert(files, {
      id: getSemanticFileId(filePath),
      embedding,
      hasVector: true,
      filePath,
      fileName: filePath.split('/').pop(),
      fileType: 'document',
      analyzedAt: '2026-09-01T00:00:00.000Z',
      suggestedName: '',
      keywords: [],
      tags: [],
      isOrphaned: false,
      orphanedAt: '',
      fileHash: ''
    });
  }
  const service = new OramaVectorService();
  service.initialize = jest.fn().mockResolvedValue();
  service._schedulePersist = jest.fn();
  service._emitSearchDataMutated = jest.fn();
  service._invalidateCacheForFile = jest.fn();
  service._databases.files = files;
  service._collectionDimensions.files = 3;
  service._dimension = 3;
  service._embeddingStore.files = new Map();
  return service;
}

const entryFor = (filePath) => ({ originalPath: filePath, analysis: { summary: 'notes' } });

describe('repairKnowledge restores orphan-marked rows in the real store', () => {
  test('an orphan-marked row with an intact vector is un-flagged, not re-embedded', async () => {
    const service = await makeService([{ filePath: INTACT, embedding: [1, 0, 0] }]);
    const id = getSemanticFileId(INTACT);
    await service.markEmbeddingsOrphaned([id]);
    expect(await service.getFile(id)).toMatchObject({ isOrphaned: true, hasVector: true });
    expect(await service.hasUsableVector(id)).toBe(false);

    const embedEntry = jest.fn(async () => ({ action: 'enqueued' }));
    const summary = await repairKnowledge({
      entries: { e1: entryFor(INTACT) },
      vectorDb: service,
      embedEntry,
      fileExists: async () => true,
      checkPassages: false
    });

    expect(embedEntry).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ restored: 1, embedded: 0, checked: 1 });
    expect(await service.getFile(id)).toMatchObject({ isOrphaned: false });
    expect(await service.hasUsableVector(id)).toBe(true);
  });

  test('an orphan-marked row whose vector is all zeros is re-embedded', async () => {
    const service = await makeService([
      { filePath: INTACT, embedding: [1, 0, 0] },
      { filePath: ZEROED, embedding: [0, 0, 0] }
    ]);
    await service.markEmbeddingsOrphaned([getSemanticFileId(INTACT), getSemanticFileId(ZEROED)]);

    const embedEntry = jest.fn(async () => ({ action: 'enqueued' }));
    const summary = await repairKnowledge({
      entries: { e1: entryFor(INTACT), e2: entryFor(ZEROED) },
      vectorDb: service,
      embedEntry,
      fileExists: async () => true,
      checkPassages: false
    });

    expect(embedEntry).toHaveBeenCalledTimes(1);
    expect(embedEntry.mock.calls[0][0].filePath).toBe(ZEROED);
    expect(summary).toMatchObject({ embedded: 1 });
    expect(await service.hasUsableVector(getSemanticFileId(INTACT))).toBe(true);
  });

  test('an orphan-marked row whose file is still gone stays orphaned', async () => {
    const service = await makeService([{ filePath: INTACT, embedding: [1, 0, 0] }]);
    const id = getSemanticFileId(INTACT);
    await service.markEmbeddingsOrphaned([id]);

    const embedEntry = jest.fn(async () => ({ action: 'enqueued' }));
    const summary = await repairKnowledge({
      entries: { e1: entryFor(INTACT) },
      vectorDb: service,
      embedEntry,
      fileExists: async () => false,
      checkPassages: false
    });

    expect(embedEntry).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ restored: 0, skippedMissing: 1 });
    expect(await service.getFile(id)).toMatchObject({ isOrphaned: true });
  });
});
