/**
 * Search vector legs must not inherit Orama's default 0.8 similarity cutoff.
 *
 * Orama 3.x drops every vector hit below `DEFAULT_SIMILARITY = 0.8` unless the
 * caller passes `similarity`. The folder query was fixed for this long ago;
 * the file and chunk legs of hybrid search were not:
 *
 * - file leg: when ONE document cleared 0.8 only that document came back, so
 *   every 0.6-0.79 match was lost; when none did, a brute-force fallback ran.
 * - chunk leg: no fallback, so passage recall returned nothing for ordinary
 *   queries (a short query is rarely 0.8-similar to a passage).
 *
 * Real Orama, no module mock: the defect is Orama's default, which a mocked
 * `search` cannot reproduce.
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

const { create, insert } = require('@orama/orama');
const { OramaVectorService } = require('../src/main/services/OramaVectorService');

const QUERY = [1, 0, 0];
// Unit vectors at a chosen cosine to QUERY.
const at = (cos) => [cos, Math.sqrt(1 - cos * cos), 0];

const FILES = [
  { id: 'file:/docs/near-duplicate.txt', cos: 0.97 },
  { id: 'file:/docs/lease-agreement.pdf', cos: 0.62 },
  { id: 'file:/docs/tenant-letter.docx', cos: 0.45 }
];

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
      isOrphaned: 'boolean'
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
  for (const f of FILES) {
    const filePath = f.id.slice('file:'.length);
    await insert(files, {
      id: f.id,
      embedding: at(f.cos),
      hasVector: true,
      filePath,
      fileName: filePath.split('/').pop(),
      fileType: 'document',
      analyzedAt: '2026-09-01T00:00:00.000Z',
      suggestedName: '',
      keywords: [],
      tags: [],
      isOrphaned: false
    });
    await insert(fileChunks, {
      id: `chunk:${f.id}:0`,
      embedding: at(f.cos - 0.05),
      fileId: f.id,
      chunkIndex: 0,
      content: `passage from ${filePath}`,
      startOffset: 0,
      endOffset: 20
    });
  }

  const service = new OramaVectorService();
  service.initialize = jest.fn().mockResolvedValue();
  service._databases.files = files;
  service._databases.fileChunks = fileChunks;
  service._collectionDimensions.files = 3;
  service._collectionDimensions.fileChunks = 3;
  service._fallbackQuerySimilarFiles = jest.fn(async () => {
    throw new Error('the primary query must answer; the fallback is for a broken index');
  });
  return service;
}

describe('OramaVectorService search legs: no inherited 0.8 similarity cutoff', () => {
  test('the file leg returns mid-similarity matches alongside a near-duplicate', async () => {
    const service = await makeService();

    const results = await service.querySimilarFiles(QUERY, 10);

    expect(results.map((r) => r.id)).toEqual(FILES.map((f) => f.id));
    expect(results[1].score).toBeCloseTo(0.62, 2);
    expect(service._fallbackQuerySimilarFiles).not.toHaveBeenCalled();
  });

  test('the chunk leg returns passages below 0.8 instead of nothing', async () => {
    const service = await makeService();

    const results = await service.querySimilarFileChunks(QUERY, 10);

    expect(results.map((r) => r.metadata.fileId)).toEqual(FILES.map((f) => f.id));
    expect(results.every((r) => r.metadata.path.startsWith('/docs/'))).toBe(true);
  });
});

describe('OramaVectorService.isKnownUnembedded', () => {
  test('is true only for a loaded store that lacks a real vector for the id', () => {
    const service = new OramaVectorService();
    service._embeddingStore.files = new Map([
      ['file:/docs/embedded.pdf', [0.1, 0.2, 0.3]],
      ['file:/docs/placeholder.pdf', [0, 0, 0]]
    ]);

    expect(service.isKnownUnembedded('file:/docs/embedded.pdf')).toBe(false);
    expect(service.isKnownUnembedded('file:/docs/placeholder.pdf')).toBe(true);
    expect(service.isKnownUnembedded('file:/docs/never-embedded.pdf')).toBe(true);
  });

  test('answers false when it cannot know (store not loaded or empty)', () => {
    const service = new OramaVectorService();
    service._embeddingStore.files = undefined;
    expect(service.isKnownUnembedded('file:/docs/a.pdf')).toBe(false);
    service._embeddingStore.files = new Map();
    expect(service.isKnownUnembedded('file:/docs/a.pdf')).toBe(false);
  });
});
