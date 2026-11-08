/**
 * G2 callers in FolderMatchingService: a vector-store reset whose save failed
 * resolves `{ persisted: false }` (or `resetPersisted: false` from
 * handleEmbeddingModelChange) instead of rejecting. The service used to log
 * "collections reset" either way; a reset that lives in memory only must be
 * logged as such, since the old index is still on disk.
 */

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../src/shared/logger', () => ({ createLogger: () => mockLogger }));

let mockModelChangeListener = null;
jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: jest.fn(() => ({
    getConfig: jest.fn().mockResolvedValue({ embeddingModel: 'm' }),
    onModelChange: jest.fn((listener) => {
      mockModelChangeListener = listener;
      return jest.fn();
    })
  }))
}));

jest.mock('../src/main/services/ParallelEmbeddingService', () => ({
  getInstance: jest.fn(() => ({}))
}));

jest.mock('../src/shared/config/index', () => ({
  get: jest.fn((key, defaultValue) => defaultValue)
}));

jest.mock('../src/shared/cacheInvalidation', () => ({
  getInstance: jest.fn(() => ({ subscribe: jest.fn(() => jest.fn()), publish: jest.fn() }))
}));

jest.mock('../src/main/services/EmbeddingCache', () =>
  jest.fn().mockImplementation(() => ({
    get: jest.fn(() => null),
    set: jest.fn(),
    clear: jest.fn(),
    invalidateOnModelChange: jest.fn(() => true),
    initialize: jest.fn(),
    initialized: false
  }))
);

const FolderMatchingService = require('../src/main/services/FolderMatchingService');

const RESET_DONE = '[FolderMatchingService] Vector DB collections reset after model change';
const messages = (fn) => fn.mock.calls.map(([msg]) => msg);

beforeEach(() => {
  jest.clearAllMocks();
  mockModelChangeListener = null;
});

async function fireEmbeddingModelChange(vectorDb) {
  new FolderMatchingService(vectorDb, { parallelEmbeddingService: {} });
  expect(typeof mockModelChangeListener).toBe('function');
  await mockModelChangeListener({ type: 'embedding', previousModel: 'old', newModel: 'new' });
}

describe('embedding model change reset', () => {
  test('a reset saved to disk is logged as done', async () => {
    await fireEmbeddingModelChange({
      handleEmbeddingModelChange: jest.fn().mockResolvedValue({ resetPersisted: true })
    });
    expect(messages(mockLogger.info)).toContain(RESET_DONE);
    expect(messages(mockLogger.warn).some((m) => /in memory only/.test(m))).toBe(false);
  });

  test('a reset whose save failed is logged as in memory only, not as done', async () => {
    await fireEmbeddingModelChange({
      handleEmbeddingModelChange: jest.fn().mockResolvedValue({ resetPersisted: false })
    });
    expect(messages(mockLogger.info)).not.toContain(RESET_DONE);
    expect(messages(mockLogger.warn).some((m) => /in memory only/.test(m))).toBe(true);
  });

  test('the resetAll fallback reads its { persisted } result too', async () => {
    await fireEmbeddingModelChange({
      resetAll: jest.fn().mockResolvedValue({ persisted: false, error: new Error('ENOSPC') })
    });
    expect(messages(mockLogger.info)).not.toContain(RESET_DONE);
    expect(messages(mockLogger.warn).some((m) => /in memory only/.test(m))).toBe(true);
  });
});

describe('folder dimension-mismatch self-heal', () => {
  test('a folders reset whose save failed is logged, and the retry still runs', async () => {
    const vectorDb = {
      initialize: jest.fn().mockResolvedValue(undefined),
      resetFolders: jest.fn().mockResolvedValue({ persisted: false }),
      batchUpsertFolders: jest
        .fn()
        .mockResolvedValueOnce({ success: false, count: 0, requiresRebuild: true })
        .mockResolvedValueOnce({ success: true, count: 1, failed: [] })
    };
    const embeddingService = {
      batchEmbedFolders: jest.fn().mockResolvedValue({
        results: [{ id: 'f1', success: true, vector: [0.1, 0.2], model: 'm' }],
        errors: [],
        stats: {}
      })
    };
    const service = new FolderMatchingService(vectorDb, {
      parallelEmbeddingService: embeddingService
    });

    const result = await service.batchUpsertFolders([
      { id: 'f1', name: 'Financial', path: '/sorted/financial', description: 'Money docs' }
    ]);

    expect(vectorDb.batchUpsertFolders).toHaveBeenCalledTimes(2);
    expect(result.count).toBe(1);
    expect(
      messages(mockLogger.warn).some((m) => /Folders collection reset in memory only/.test(m))
    ).toBe(true);
  });
});
