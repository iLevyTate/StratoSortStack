let mockSearch;

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => 'C:/tmp')
  }
}));

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

jest.mock('@orama/orama', () => {
  mockSearch = jest.fn();
  return {
    create: jest.fn(async () => ({})),
    insert: jest.fn(async () => undefined),
    search: (...args) => mockSearch(...args),
    remove: jest.fn(async () => undefined),
    update: jest.fn(async () => undefined),
    count: jest.fn(async () => 0),
    getByID: jest.fn(async (_db, id) => ({
      id,
      folderPath: '/Work',
      folderName: 'Work',
      description: 'Primary folder',
      patterns: []
    }))
  };
});

const { OramaVectorService } = require('../src/main/services/OramaVectorService');

describe('OramaVectorService folder repair on empty primary query', () => {
  test('repairs the folder index when real queries return empty despite healthy sidecar vectors', async () => {
    const service = new OramaVectorService();
    service.initialize = jest.fn().mockResolvedValue();
    service.persistAll = jest.fn().mockResolvedValue();
    service._schedulePersist = jest.fn();
    service._clearQueryCache = jest.fn();
    service._invalidateCacheForFolder = jest.fn();
    service._emitSearchDataMutated = jest.fn();

    service._databases.folders = {};
    service._schemas = { folders: {} };
    service._dimension = 3;
    service._collectionDimensions.folders = 3;
    service._embeddingStore.folders = new Map([['folder-1', [0.5, 0.4, 0.3]]]);
    service._folderVectorHealth = {
      primaryHealthy: true,
      lastValidatedAt: Date.now(),
      lastValidationReason: 'recent',
      lastValidationError: null,
      repairAttempts: 0,
      lastRepairAt: 0
    };

    mockSearch.mockResolvedValueOnce({ hits: [] }).mockResolvedValueOnce({
      hits: [
        {
          score: 0.99,
          document: {
            id: 'folder-1',
            folderPath: '/Work',
            folderName: 'Work',
            description: 'Primary folder',
            patterns: [],
            embedding: [0.5, 0.4, 0.3]
          }
        }
      ]
    });

    const results = await service.queryFoldersByEmbedding([0.5, 0.4, 0.3], 5);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('folder-1');
    expect(service._folderVectorHealth.repairAttempts).toBe(1);
    expect(mockSearch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('OramaVectorService folder query similarity floor', () => {
  // Regression guard: Orama's vector search defaults to a 0.8 minimum-similarity
  // cutoff, which silently dropped legitimate document->folder matches (cosine
  // is rarely >= 0.8 across types) and made every query look "empty", triggering
  // a needless index rebuild on each analysis. queryFoldersByEmbedding must pass
  // an explicit similarity floor of 0 so the restored index answers correctly
  // and no repair fires.
  test('passes similarity:0 to native search and does not repair on a real ranked hit', async () => {
    const service = new OramaVectorService();
    service.initialize = jest.fn().mockResolvedValue();
    service.persistAll = jest.fn().mockResolvedValue();
    service._schedulePersist = jest.fn();
    service._clearQueryCache = jest.fn();
    service._invalidateCacheForFolder = jest.fn();
    service._emitSearchDataMutated = jest.fn();
    service._repairFoldersVectorIndexFromCurrentState = jest.fn();

    service._databases.folders = {};
    service._schemas = { folders: {} };
    service._dimension = 3;
    service._collectionDimensions.folders = 3;
    service._embeddingStore.folders = new Map([['folder-1', [0.5, 0.4, 0.3]]]);
    service._folderVectorHealth = {
      primaryHealthy: true,
      lastValidatedAt: Date.now(),
      lastValidationReason: 'recent',
      lastValidationError: null,
      repairAttempts: 0,
      lastRepairAt: 0
    };

    // A realistic sub-0.8 document->folder match: with the default cutoff Orama
    // would have returned nothing; with similarity:0 it returns the ranked hit.
    mockSearch.mockResolvedValueOnce({
      hits: [
        {
          score: 0.58,
          document: {
            id: 'folder-1',
            folderPath: '/Work',
            folderName: 'Work',
            description: 'Primary folder',
            patterns: [],
            embedding: [0.5, 0.4, 0.3]
          }
        }
      ]
    });

    const results = await service.queryFoldersByEmbedding([0.1, 0.2, 0.9], 5);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('folder-1');
    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockSearch.mock.calls[0][1]).toEqual(expect.objectContaining({ similarity: 0 }));
    expect(service._repairFoldersVectorIndexFromCurrentState).not.toHaveBeenCalled();
    expect(service._folderVectorHealth.repairAttempts).toBe(0);
  });
});

describe('OramaVectorService folder repair budget reset', () => {
  test('resets repairAttempts to 0 when a probe validates without needing repair', async () => {
    const service = new OramaVectorService();
    service.initialize = jest.fn().mockResolvedValue();

    service._databases.folders = {};
    service._schemas = { folders: {} };
    service._dimension = 3;
    service._collectionDimensions.folders = 3;
    service._embeddingStore.folders = new Map([['folder-1', [0.5, 0.4, 0.3]]]);
    // Simulate a session that already exhausted the repair budget on earlier
    // transient drift. A later healthy validation must restore the budget so
    // future drift can still auto-repair.
    service._folderVectorHealth = {
      primaryHealthy: false,
      lastValidatedAt: 0,
      lastValidationReason: 'query-empty',
      lastValidationError: null,
      repairAttempts: 2,
      lastRepairAt: Date.now()
    };

    // Probe succeeds on the first try -> no repair attempted this cycle.
    mockSearch.mockResolvedValueOnce({
      hits: [{ score: 0.99, document: { id: 'folder-1', embedding: [0.5, 0.4, 0.3] } }]
    });

    const snapshot = await service._ensurePrimaryFolderVectorHealth({
      reason: 'query-empty',
      force: true
    });

    expect(snapshot.primaryHealthy).toBe(true);
    expect(service._folderVectorHealth.repairAttempts).toBe(0);
  });

  test('does NOT reset repairAttempts when a repair was required this cycle', async () => {
    const service = new OramaVectorService();
    service.initialize = jest.fn().mockResolvedValue();
    service.persistAll = jest.fn().mockResolvedValue();
    service._schedulePersist = jest.fn();
    service._clearQueryCache = jest.fn();
    service._invalidateCacheForFolder = jest.fn();
    service._emitSearchDataMutated = jest.fn();
    service._repairFoldersVectorIndexFromCurrentState = jest.fn().mockResolvedValue({ rebuilt: 1 });

    service._databases.folders = {};
    service._schemas = { folders: {} };
    service._dimension = 3;
    service._collectionDimensions.folders = 3;
    service._embeddingStore.folders = new Map([['folder-1', [0.5, 0.4, 0.3]]]);
    service._folderVectorHealth = {
      primaryHealthy: true,
      lastValidatedAt: 0,
      lastValidationReason: 'recent',
      lastValidationError: null,
      repairAttempts: 0,
      lastRepairAt: 0
    };

    // First probe empty (unhealthy) -> repair -> second probe healthy.
    mockSearch.mockResolvedValueOnce({ hits: [] }).mockResolvedValueOnce({
      hits: [{ score: 0.99, document: { id: 'folder-1', embedding: [0.5, 0.4, 0.3] } }]
    });

    await service._ensurePrimaryFolderVectorHealth({ reason: 'query-empty', force: true });

    // A repair was consumed; the budget must reflect that (not reset to 0).
    expect(service._folderVectorHealth.repairAttempts).toBe(1);
    expect(service._repairFoldersVectorIndexFromCurrentState).toHaveBeenCalledTimes(1);
  });
});
