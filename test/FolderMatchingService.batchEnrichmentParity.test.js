/**
 * Ensures batch folder upserts embed the same enriched text as single-folder upsert
 * (matches cache keys and SMART_FOLDERS.MATCH preview behavior).
 */
const FolderMatchingService = require('../src/main/services/FolderMatchingService');
const { enrichFolderTextForEmbedding } = require('../src/main/analysis/semanticExtensionMap');

jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

const mockLlamaService = {
  generateEmbedding: jest.fn(),
  getConfig: jest.fn().mockResolvedValue({ embeddingModel: 'test-embed-model' })
};

jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: () => mockLlamaService
}));

describe('FolderMatchingService batch vs single folder enrichment parity', () => {
  let mockVectorDb;
  let mockParallelEmbedding;

  beforeEach(() => {
    mockVectorDb = {
      initialize: jest.fn().mockResolvedValue(undefined),
      upsertFolder: jest.fn().mockResolvedValue({ success: true }),
      batchUpsertFolders: jest.fn().mockResolvedValue({
        success: true,
        count: 1,
        failed: []
      })
    };

    const vectorFromText = (text) => [0, String(text).length, String(text).charCodeAt(0) || 0];

    mockParallelEmbedding = {
      embedText: jest.fn(async (text) => ({
        vector: vectorFromText(text),
        model: 'test-embed-model'
      })),
      batchEmbedFolders: jest.fn(async (folders) => ({
        results: folders.map((f) => {
          const t =
            typeof f.embeddingText === 'string' && f.embeddingText.trim()
              ? f.embeddingText
              : [f.name, f.description].filter(Boolean).join(' - ');
          return {
            id: f.id,
            success: true,
            vector: vectorFromText(t),
            model: 'test-embed-model'
          };
        }),
        errors: [],
        stats: {}
      }))
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('batchUpsertFolders passes embeddingText matching enrichFolderTextForEmbedding', async () => {
    const folder = {
      id: 'folder-parity',
      name: '3D Prints',
      description: 'Models for my Ender 3 printer',
      path: '/sorted/3d'
    };
    const expectedText = enrichFolderTextForEmbedding(folder.name, folder.description);

    const service = new FolderMatchingService(mockVectorDb, {
      parallelEmbeddingService: mockParallelEmbedding
    });

    await service.batchUpsertFolders([folder], { forceRefresh: true });
    expect(mockParallelEmbedding.batchEmbedFolders).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          id: folder.id,
          embeddingText: expectedText
        })
      ]),
      expect.anything()
    );
  });

  test('upsertFolderEmbedding calls embedText with same enriched string batch uses as embeddingText', async () => {
    const folder = {
      id: 'folder-parity-2',
      name: '3D Prints',
      description: 'Models for my Ender 3 printer',
      path: '/sorted/3d'
    };
    const expectedText = enrichFolderTextForEmbedding(folder.name, folder.description);

    const service = new FolderMatchingService(mockVectorDb, {
      parallelEmbeddingService: mockParallelEmbedding
    });

    await service.upsertFolderEmbedding(folder);
    expect(mockParallelEmbedding.embedText).toHaveBeenCalledWith(expectedText);

    service.embeddingCache.clear();
    await service.batchUpsertFolders([folder], { forceRefresh: true });
    expect(mockParallelEmbedding.batchEmbedFolders).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ embeddingText: expectedText })]),
      expect.anything()
    );

    const upsertPayload = mockVectorDb.upsertFolder.mock.calls[0][0];
    const batchPayloads = mockVectorDb.batchUpsertFolders.mock.calls[0][0];
    const batchPayload = batchPayloads.find((p) => p.id === folder.id);

    expect(upsertPayload.vector).toEqual(batchPayload.vector);
    expect(upsertPayload.model).toBe(batchPayload.model);
    expect(expectedText.length).toBeGreaterThan(
      [folder.name, folder.description].filter(Boolean).join(' - ').length
    );
  });
});
