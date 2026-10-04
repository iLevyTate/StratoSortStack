/**
 * Regression: a file organized into a Smart Folder (Housing/lease.pdf) and
 * then undone back to Downloads. FilePathCoordinator now hands
 * `updateEntryPaths` explicit `newSmartFolder: null` / `newSmartFolderPath:
 * null` for that undo. Before the fix the whole folder block was gated on a
 * non-empty `newCategory` string and the assignments accepted only strings,
 * so the history entry kept saying the file lived in 'Housing' after it was
 * back in Downloads — search facets, Organize history and the learning
 * signal all disagreed with the vector row, which had been cleared.
 */

// Mock electron
jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/mock/userData')
  }
}));

// Mock logger
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

// Mock performanceConstants
jest.mock('../src/shared/performanceConstants', () => ({
  LIMITS: {
    MAX_HISTORY_ENTRIES: 10000,
    MAX_QUEUE_SIZE: 3
  },
  TIMEOUTS: {
    MUTEX_ACQUIRE: 50,
    DELAY_LOCK_RETRY: 5
  }
}));

// Mock cacheManager
const mockCacheStore = {
  stats: { data: null, timestamp: 0 },
  recent: { data: null, timestamp: 0 },
  search: new Map(),
  category: new Map(),
  tag: new Map(),
  incrementalStats: null
};

jest.mock('../src/main/services/analysisHistory/cacheManager', () => ({
  createCacheStore: jest.fn(() => ({ ...mockCacheStore })),
  getCacheTTLs: jest.fn(() => ({
    CACHE_TTL_MS: 60000,
    STATS_CACHE_TTL_MS: 30000,
    SEARCH_CACHE_TTL_MS: 10000
  })),
  invalidateCachesOnAdd: jest.fn(),
  invalidateCachesOnRemove: jest.fn(),
  updateIncrementalStatsOnAdd: jest.fn(),
  updateIncrementalStatsOnRemove: jest.fn(),
  clearCaches: jest.fn(),
  warmCache: jest.fn(),
  subscribeToInvalidationBus: jest.fn(() => jest.fn())
}));

// Mock persistence
jest.mock('../src/main/services/analysisHistory/persistence', () => ({
  loadConfig: jest.fn().mockResolvedValue({ schemaVersion: '1.0.0' }),
  saveConfig: jest.fn().mockResolvedValue(undefined),
  loadHistory: jest.fn().mockResolvedValue({
    schemaVersion: '1.0.0',
    entries: {},
    totalAnalyzed: 0,
    totalSize: 0,
    metadata: { totalEntries: 0 }
  }),
  saveHistory: jest.fn().mockResolvedValue(undefined),
  loadIndex: jest.fn().mockResolvedValue({
    schemaVersion: '1.0.0',
    byPath: {},
    byCategory: {},
    byTag: {},
    byDate: {}
  }),
  saveIndex: jest.fn().mockResolvedValue(undefined),
  createDefaultStructures: jest.fn().mockResolvedValue({
    config: { schemaVersion: '1.0.0' },
    history: { entries: {}, totalAnalyzed: 0, totalSize: 0, metadata: {} },
    index: { byPath: {}, byCategory: {}, byTag: {}, byDate: {} }
  })
}));

// Mock indexManager
jest.mock('../src/main/services/analysisHistory/indexManager', () => ({
  createEmptyIndex: jest.fn((version) => ({
    schemaVersion: version,
    byPath: {},
    byCategory: {},
    byTag: {},
    byDate: {}
  })),
  generateFileHash: jest.fn((path, size, lastModified) => `hash-${path}-${size}-${lastModified}`),
  updateIndexes: jest.fn(),
  removeFromIndexes: jest.fn(),
  updatePathIndexForMove: jest.fn()
}));

// Mock search
jest.mock('../src/main/services/analysisHistory/search', () => ({
  searchAnalysis: jest.fn().mockResolvedValue([])
}));

// Mock statistics
jest.mock('../src/main/services/analysisHistory/statistics', () => ({
  getStatistics: jest.fn().mockResolvedValue({
    totalFiles: 0,
    totalSize: 0,
    categories: {}
  }),
  getQuickStats: jest.fn().mockResolvedValue({
    totalFiles: 0,
    recentCount: 0
  })
}));

// Mock queries
jest.mock('../src/main/services/analysisHistory/queries', () => ({
  getAnalysisByPath: jest.fn().mockResolvedValue(null),
  getAnalysisByCategory: jest.fn().mockResolvedValue([]),
  getAnalysisByTag: jest.fn().mockResolvedValue([]),
  getRecentAnalysis: jest.fn().mockResolvedValue([]),
  getAnalysisByDateRange: jest.fn().mockResolvedValue([]),
  getCategories: jest.fn().mockResolvedValue([]),
  getTags: jest.fn().mockResolvedValue([])
}));

// Mock maintenance
jest.mock('../src/main/services/analysisHistory/maintenance', () => ({
  performMaintenanceIfNeeded: jest.fn().mockResolvedValue(undefined),
  migrateHistory: jest.fn((history) => history)
}));

describe('AnalysisHistoryServiceCore.updateEntryPaths — clearing smart-folder fields', () => {
  let service;

  const seedHousedEntry = (overrides = {}) => {
    const entry = {
      id: 'entry-1',
      originalPath: '/Downloads/lease.pdf',
      fileName: 'lease.pdf',
      organization: { actual: '/Housing/lease.pdf' },
      analysis: {
        category: 'Housing',
        smartFolder: 'Housing',
        smartFolderPath: '/Housing',
        confidence: 92
      },
      ...overrides
    };
    service.analysisHistory.entries[entry.id] = entry;
    return entry;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();

    const AnalysisHistoryServiceCore = require('../src/main/services/analysisHistory/AnalysisHistoryServiceCore');
    service = new AnalysisHistoryServiceCore();
    await service.initialize();
  });

  test('explicit nulls clear smartFolder/smartFolderPath and leave the category alone', async () => {
    const entry = seedHousedEntry();

    const result = await service.updateEntryPaths([
      {
        oldPath: '/Housing/lease.pdf',
        newPath: '/Downloads/lease.pdf',
        newSmartFolder: null,
        newSmartFolderPath: null
      }
    ]);

    expect(result.updated).toBe(1);
    expect(result.notFound).toBe(0);
    expect(entry.organization.actual).toBe('/Downloads/lease.pdf');
    expect(entry.analysis.smartFolder).toBeNull();
    expect(entry.analysis.smartFolderPath).toBeNull();
    // The category is the analysis verdict, not a folder property.
    expect(entry.analysis.category).toBe('Housing');
    expect(entry.analysis.correctedFrom).toBeUndefined();
    expect(result.divergences).toEqual([]);
  });

  test('explicit nulls on an entry with no analysis block create it with cleared folder fields', async () => {
    const entry = seedHousedEntry({ analysis: undefined });

    const result = await service.updateEntryPaths([
      {
        oldPath: '/Housing/lease.pdf',
        newPath: '/Downloads/lease.pdf',
        newSmartFolder: null,
        newSmartFolderPath: null
      }
    ]);

    expect(result.updated).toBe(1);
    expect(entry.analysis).toEqual({ smartFolder: null, smartFolderPath: null });
  });

  test('an update carrying no folder fields leaves smartFolder/smartFolderPath untouched', async () => {
    const entry = seedHousedEntry();

    const result = await service.updateEntryPaths([
      {
        oldPath: '/Housing/lease.pdf',
        newPath: '/Housing/renamed-lease.pdf',
        newName: 'renamed-lease.pdf'
      }
    ]);

    expect(result.updated).toBe(1);
    expect(entry.organization.actual).toBe('/Housing/renamed-lease.pdf');
    expect(entry.analysis.smartFolder).toBe('Housing');
    expect(entry.analysis.smartFolderPath).toBe('/Housing');
    expect(entry.analysis.category).toBe('Housing');
  });

  test('string folder fields alongside newCategory still behave as before', async () => {
    const entry = seedHousedEntry();

    const result = await service.updateEntryPaths([
      {
        oldPath: '/Housing/lease.pdf',
        newPath: '/Finance/lease.pdf',
        newCategory: 'Finance',
        newSmartFolder: 'Finance',
        newSmartFolderPath: '/Finance'
      }
    ]);

    expect(result.updated).toBe(1);
    expect(entry.analysis.category).toBe('Finance');
    expect(entry.analysis.correctedFrom).toBe('Housing');
    expect(entry.analysis.smartFolder).toBe('Finance');
    expect(entry.analysis.smartFolderPath).toBe('/Finance');
    expect(result.divergences).toEqual([
      {
        entryId: 'entry-1',
        filePath: '/Finance/lease.pdf',
        oldCategory: 'Housing',
        newCategory: 'Finance'
      }
    ]);
  });
});
