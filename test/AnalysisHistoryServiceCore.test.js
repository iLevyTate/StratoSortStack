/**
 * Tests for AnalysisHistoryServiceCore
 * Tests the core analysis history service functionality
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
  }),
  closeSqliteStore: jest.fn()
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

describe('AnalysisHistoryServiceCore', () => {
  let AnalysisHistoryServiceCore;
  let service;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();

    AnalysisHistoryServiceCore = require('../src/main/services/analysisHistory/AnalysisHistoryServiceCore');
    service = new AnalysisHistoryServiceCore();
  });

  describe('constructor', () => {
    test('initializes with correct paths', () => {
      expect(service.userDataPath).toBe('/mock/userData');
      expect(service.historyPath).toContain('analysis-history.json');
      expect(service.indexPath).toContain('analysis-index.json');
      expect(service.configPath).toContain('analysis-config.json');
    });

    test('initializes with null state', () => {
      expect(service.analysisHistory).toBeNull();
      expect(service.analysisIndex).toBeNull();
      expect(service.config).toBeNull();
      expect(service.initialized).toBe(false);
    });

    test('sets schema version', () => {
      expect(service.SCHEMA_VERSION).toBe('1.0.0');
    });

    test('creates cache store', () => {
      expect(service._cache).toBeDefined();
    });
  });

  describe('getDefaultConfig', () => {
    test('returns default configuration', () => {
      const config = service.getDefaultConfig();

      expect(config.schemaVersion).toBe('1.0.0');
      expect(config.retentionDays).toBe(365);
      expect(config.enableRAG).toBe(true);
      expect(config.enableFullTextSearch).toBe(true);
      expect(config.backupEnabled).toBe(true);
      expect(config.createdAt).toBeDefined();
      expect(config.updatedAt).toBeDefined();
    });
  });

  describe('createEmptyHistory', () => {
    test('returns empty history structure', () => {
      const history = service.createEmptyHistory();

      expect(history.schemaVersion).toBe('1.0.0');
      expect(history.totalAnalyzed).toBe(0);
      expect(history.totalSize).toBe(0);
      expect(history.entries).toEqual({});
      expect(history.metadata).toBeDefined();
      expect(history.createdAt).toBeDefined();
    });
  });

  describe('initialize', () => {
    test('initializes successfully', async () => {
      await service.initialize();

      expect(service.initialized).toBe(true);
    });

    test('skips if already initialized', async () => {
      // First call initializes
      await service.initialize();

      const { loadConfig } = require('../src/main/services/analysisHistory/persistence');
      const callCount = loadConfig.mock.calls.length;

      // Second call should skip (already initialized via init guard)
      await service.initialize();

      expect(loadConfig).toHaveBeenCalledTimes(callCount);
    });

    test('creates default structures on error', async () => {
      const {
        loadConfig,
        createDefaultStructures
      } = require('../src/main/services/analysisHistory/persistence');
      loadConfig.mockRejectedValueOnce(new Error('Load failed'));

      await service.initialize();

      expect(createDefaultStructures).toHaveBeenCalled();
      expect(service.initialized).toBe(true);
    });

    test('recovers from transient-error read-only mode on second initialize()', async () => {
      const { loadConfig } = require('../src/main/services/analysisHistory/persistence');

      // First init: transient error → enters read-only mode
      const transientError = new Error('Disk temporarily unavailable');
      transientError.transient = true;
      loadConfig.mockRejectedValueOnce(transientError);

      await service.initialize();

      expect(service.initialized).toBe(true);
      expect(service._readOnly).toBe(true);
      expect(service._readOnlyReason).toBe('Disk temporarily unavailable');

      // Second init: succeeds → clears read-only
      // loadConfig returns default resolved value (mock restores after mockRejectedValueOnce)
      await service.initialize();

      expect(service.initialized).toBe(true);
      expect(service._readOnly).toBe(false);
      expect(service._readOnlyReason).toBeNull();
    });

    test('stays in read-only mode when second initialize also fails with transient error', async () => {
      const { loadConfig } = require('../src/main/services/analysisHistory/persistence');

      // First init: transient error
      const err1 = new Error('Disk error 1');
      err1.transient = true;
      loadConfig.mockRejectedValueOnce(err1);
      await service.initialize();

      expect(service._readOnly).toBe(true);
      expect(service._readOnlyReason).toBe('Disk error 1');

      // Second init: also transient → remains read-only with updated reason
      const err2 = new Error('Disk error 2');
      err2.transient = true;
      loadConfig.mockRejectedValueOnce(err2);
      await service.initialize();

      expect(service.initialized).toBe(true);
      expect(service._readOnly).toBe(true);
      expect(service._readOnlyReason).toBe('Disk error 2');
    });

    test('clears read-only when transient error is followed by non-transient (createDefaultStructures)', async () => {
      const {
        loadConfig,
        createDefaultStructures
      } = require('../src/main/services/analysisHistory/persistence');

      // First init: transient error → enters read-only
      const transientErr = new Error('Temporary disk failure');
      transientErr.transient = true;
      loadConfig.mockRejectedValueOnce(transientErr);
      await service.initialize();

      expect(service._readOnly).toBe(true);

      // Second init: non-transient error → createDefaultStructures runs, clears read-only
      loadConfig.mockRejectedValueOnce(new Error('Corrupt config'));
      await service.initialize();

      expect(createDefaultStructures).toHaveBeenCalled();
      expect(service.initialized).toBe(true);
      expect(service._readOnly).toBe(false);
      expect(service._readOnlyReason).toBeNull();
    });
  });

  describe('recordAnalysis', () => {
    const mockFileInfo = {
      path: '/test/file.pdf',
      size: 1024,
      lastModified: '2024-01-01T00:00:00Z',
      mimeType: 'application/pdf'
    };

    const mockAnalysisResults = {
      subject: 'Test Document',
      category: 'documents',
      tags: ['test', 'pdf'],
      confidence: 0.85,
      summary: 'A test document',
      model: 'test-model',
      processingTime: 500
    };

    beforeEach(async () => {
      jest.useFakeTimers();
      await service.initialize();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    // Helper to flush write buffer - need to run timers and allow async to complete
    const flushWriteBuffer = async () => {
      // Run all pending timers
      jest.runAllTimers();
      // Allow microtasks to flush using Promise.resolve chain
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    };

    test('records analysis entry', async () => {
      const recordPromise = service.recordAnalysis(mockFileInfo, mockAnalysisResults);
      await flushWriteBuffer();
      const id = await recordPromise;

      expect(id).toBeDefined();
      expect(typeof id).toBe('string');
    });

    // The writer (analysisUtils.recordAnalysisResult) stamps provenance and
    // media fields; the store used to drop them in its entry literal, so the
    // watcher's provisional retry (F-195 / D7) never fired and transcript
    // export always reported "No timestamped transcript segments". Drive the
    // REAL writer into the real store: both halves were only ever tested
    // against a mocked other half.
    test('keeps the provenance and media fields the writer stamps', async () => {
      const { recordAnalysisResult } = require('../src/main/ipc/analysisUtils');
      const segments = [
        { start: 0, end: 2.5, text: 'Welcome to the quarterly review.' },
        { start: 2.5, end: 5, text: 'Revenue grew nine percent.' }
      ];

      const recording = recordAnalysisResult({
        filePath: '/media/review.mp4',
        result: {
          category: 'Meetings',
          summary: 'Quarterly review recording',
          extractionMethod: 'filename',
          fallbackReason: 'vision model missing',
          transcript: 'Welcome to the quarterly review. Revenue grew nine percent.',
          transcriptSegments: segments,
          durationSeconds: 5,
          detectedLanguage: 'en',
          keyframes: [{ t: 1, path: '/tmp/kf1.jpg' }],
          mediaKind: 'video'
        },
        processingTime: 10,
        modelType: 'llm',
        analysisHistory: service,
        logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        fileStats: { size: 2048, mtimeMs: 1790639260670.4954 }
      });
      // The writer awaits a prior-entry lookup before it queues the write,
      // so keep flushing until the buffered write has landed.
      let settled = false;
      recording.finally(() => {
        settled = true;
      });
      for (let i = 0; i < 50 && !settled; i++) await flushWriteBuffer();
      await recording;

      const entry = Object.values(service.analysisHistory.entries).find(
        (e) => e.originalPath === '/media/review.mp4'
      );
      expect(entry).toBeDefined();
      expect(entry.analysis).toEqual(
        expect.objectContaining({
          provisional: true,
          provisionalRetries: 0,
          fallbackReason: 'vision model missing',
          transcriptSegments: segments,
          durationSeconds: 5,
          detectedLanguage: 'en',
          keyframes: [{ t: 1, path: '/tmp/kf1.jpg' }],
          mediaKind: 'video'
        })
      );
      expect(entry.analysis.transcript).toContain('quarterly review');
    });

    test('updates history totals', async () => {
      const recordPromise = service.recordAnalysis(mockFileInfo, mockAnalysisResults);
      await flushWriteBuffer();
      await recordPromise;

      expect(service.analysisHistory.totalAnalyzed).toBe(1);
      expect(service.analysisHistory.totalSize).toBe(1024);
    });

    // F-208 (K-09): every record used to add a fresh UUID row and merely
    // re-point the path index, so re-analysis left dead duplicate rows behind
    // (and reanalyze-all, now non-destructive per F-189, would pile them up).
    test('recording the same path again replaces the prior entry instead of duplicating it', async () => {
      const { getAnalysisByPath } = require('../src/main/services/analysisHistory/queries');
      const { removeFromIndexes } = require('../src/main/services/analysisHistory/indexManager');
      const prior = {
        id: 'prior-1',
        originalPath: mockFileInfo.path,
        fileHash: 'old-hash',
        fileSize: 1024,
        timestamp: '2024-01-01T00:00:00Z',
        accessCount: 7,
        analysis: { category: 'old' }
      };
      service.analysisHistory.entries[prior.id] = prior;
      service.analysisHistory.totalAnalyzed = 1;
      service.analysisHistory.totalSize = 1024;
      service.analysisHistory.metadata.totalEntries = 1;
      getAnalysisByPath.mockReturnValueOnce(prior);

      const recordPromise = service.recordAnalysis(mockFileInfo, mockAnalysisResults);
      await flushWriteBuffer();
      const id = await recordPromise;

      expect(id).not.toBe('prior-1');
      expect(service.analysisHistory.entries['prior-1']).toBeUndefined();
      expect(Object.keys(service.analysisHistory.entries)).toEqual([id]);
      expect(service.analysisHistory.totalAnalyzed).toBe(1);
      expect(service.analysisHistory.metadata.totalEntries).toBe(1);
      expect(service.analysisHistory.totalSize).toBe(1024);
      expect(removeFromIndexes).toHaveBeenCalledWith(expect.anything(), prior);
      // Usage history carries over to the replacement row.
      expect(service.analysisHistory.entries[id].accessCount).toBe(7);
    });

    test('updates indexes', async () => {
      const { updateIndexes } = require('../src/main/services/analysisHistory/indexManager');

      const recordPromise = service.recordAnalysis(mockFileInfo, mockAnalysisResults);
      await flushWriteBuffer();
      await recordPromise;

      expect(updateIndexes).toHaveBeenCalled();
    });

    test('invalidates caches', async () => {
      const {
        invalidateCachesOnAdd
      } = require('../src/main/services/analysisHistory/cacheManager');

      const recordPromise = service.recordAnalysis(mockFileInfo, mockAnalysisResults);
      await flushWriteBuffer();
      await recordPromise;

      expect(invalidateCachesOnAdd).toHaveBeenCalled();
    });

    test('saves history and index once the coalescing window passes', async () => {
      const {
        saveHistory,
        saveIndex
      } = require('../src/main/services/analysisHistory/persistence');

      const recordPromise = service.recordAnalysis(mockFileInfo, mockAnalysisResults);
      await flushWriteBuffer();
      await recordPromise;
      await jest.advanceTimersByTimeAsync(service.HISTORY_SAVE_QUIET_MS);

      expect(saveHistory).toHaveBeenCalled();
      expect(saveIndex).toHaveBeenCalled();
    });

    test('performs maintenance if needed', async () => {
      const {
        performMaintenanceIfNeeded
      } = require('../src/main/services/analysisHistory/maintenance');

      const recordPromise = service.recordAnalysis(mockFileInfo, mockAnalysisResults);
      await flushWriteBuffer();
      await recordPromise;

      expect(performMaintenanceIfNeeded).toHaveBeenCalled();
    });

    test('rejects when write buffer is full', async () => {
      service.MAX_PENDING_WRITES = 1;
      const firstRecord = service.recordAnalysis(mockFileInfo, mockAnalysisResults);

      await expect(service.recordAnalysis(mockFileInfo, mockAnalysisResults)).rejects.toMatchObject(
        { code: 'WRITE_BUFFER_FULL' }
      );

      await flushWriteBuffer();
      await firstRecord;
    });

    test('rejects with WRITE_LOCK_TIMEOUT instead of racing the holder', async () => {
      // Previously _acquireWriteLock logged "forcing acquisition" and returned
      // a release function, which let two writers into the same critical
      // section and corrupted the history + SQLite side-tables. The fix
      // rejects the waiter so the caller can surface the error (and retry
      // on its own schedule) rather than silently racing.
      service._writeLock = new Promise(() => {});

      const acquirePromise = service._acquireWriteLock('test-timeout');
      // Attach the rejection handler BEFORE advancing timers so the
      // microtask queue doesn't log an unhandledRejection warning during
      // the `await Promise.resolve()` settle.
      const assertion = expect(acquirePromise).rejects.toMatchObject({
        code: 'WRITE_LOCK_TIMEOUT'
      });
      jest.advanceTimersByTime(100);
      await Promise.resolve();
      await assertion;

      // After rejection the timed-out waiter should unwind cleanly so the
      // next caller isn't chained onto a dead promise.
      expect(service._writeLockMeta).toBeNull();
      expect(service._writeLock).toBeNull();
    });

    test('persists embedding policy/status updates by path', async () => {
      const recordPromise = service.recordAnalysis(mockFileInfo, mockAnalysisResults);
      await flushWriteBuffer();
      await recordPromise;

      const before = Object.values(service.analysisHistory?.entries || {}).find(
        (e) =>
          e?.originalPath === mockFileInfo.path || e?.organization?.actual === mockFileInfo.path
      );
      expect(before).toBeTruthy();

      await service.updateEmbeddingStateByPath(mockFileInfo.path, {
        policy: 'web_only',
        status: 'skipped',
        model: 'nomic-embed-text'
      });

      const after = Object.values(service.analysisHistory?.entries || {}).find(
        (e) =>
          e?.originalPath === mockFileInfo.path || e?.organization?.actual === mockFileInfo.path
      );
      expect(after?.embedding).toBeTruthy();
      expect(after.embedding.policy).toBe('web_only');
      expect(after.embedding.status).toBe('skipped');
      expect(after.embedding.model).toBe('nomic-embed-text');
      expect(typeof after.embedding.updatedAt).toBe('string');
    });

    test('persists analysis.date into documentDate when documentDate is absent (EXIF/content dates)', async () => {
      const fileInfo = {
        path: '/test/photo.jpg',
        size: 2048,
        lastModified: '2024-01-01T00:00:00Z',
        mimeType: 'image/jpeg'
      };
      const analysisResults = {
        subject: 'Vacation photo',
        category: 'photos',
        date: '2019-06-14'
        // deliberately no documentDate
      };

      const recordPromise = service.recordAnalysis(fileInfo, analysisResults);
      await flushWriteBuffer();
      await recordPromise;

      const entry = Object.values(service.analysisHistory?.entries || {}).find(
        (e) => e?.originalPath === fileInfo.path
      );
      expect(entry).toBeTruthy();
      expect(entry.analysis.documentDate).toBe('2019-06-14');
    });

    test('persists mediaKind through normalization', async () => {
      const fileInfo = {
        path: '/test/video.mp4',
        size: 4096,
        lastModified: '2024-01-02T00:00:00Z',
        mimeType: 'video/mp4'
      };
      const analysisResults = {
        subject: 'Tutorial video',
        category: 'videos',
        mediaKind: 'video'
      };

      const recordPromise = service.recordAnalysis(fileInfo, analysisResults);
      await flushWriteBuffer();
      await recordPromise;

      const entry = Object.values(service.analysisHistory?.entries || {}).find(
        (e) => e?.originalPath === fileInfo.path
      );
      expect(entry).toBeTruthy();
      expect(entry.analysis.mediaKind).toBe('video');
    });
  });

  describe('searchAnalysis', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    test('delegates to search helper', async () => {
      const { searchAnalysis } = require('../src/main/services/analysisHistory/search');
      searchAnalysis.mockResolvedValueOnce([{ id: 'result-1' }]);

      const results = await service.searchAnalysis('test query');

      expect(searchAnalysis).toHaveBeenCalled();
      expect(results).toEqual([{ id: 'result-1' }]);
    });

    test('passes options to search', async () => {
      const { searchAnalysis } = require('../src/main/services/analysisHistory/search');

      await service.searchAnalysis('query', { limit: 10 });

      expect(searchAnalysis).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        'query',
        { limit: 10 }
      );
    });
  });

  describe('removeEntriesByPath', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    test('removes entries that match originalPath or organization.actual', async () => {
      // Seed history with two entries pointing to the same current file via different fields.
      service.analysisHistory.entries = {
        a: {
          id: 'a',
          fileHash: 'h1',
          timestamp: new Date().toISOString(),
          originalPath: '/old/file.pdf',
          fileName: 'file.pdf',
          fileSize: 1,
          analysis: { tags: [] },
          organization: { actual: '/new/file.pdf' }
        },
        b: {
          id: 'b',
          fileHash: 'h2',
          timestamp: new Date().toISOString(),
          originalPath: '/new/file.pdf',
          fileName: 'file.pdf',
          fileSize: 1,
          analysis: { tags: [] },
          organization: {}
        }
      };

      const res = await service.removeEntriesByPath('/new/file.pdf');
      expect(res.removed).toBe(2);
      expect(Object.keys(service.analysisHistory.entries)).toHaveLength(0);
    });
  });

  describe('getAnalysisByPath', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    test('returns analysis for path', async () => {
      const { getAnalysisByPath } = require('../src/main/services/analysisHistory/queries');
      getAnalysisByPath.mockResolvedValueOnce({ id: 'entry-1' });

      const result = await service.getAnalysisByPath('/test/file.pdf');

      expect(result).toEqual({ id: 'entry-1' });
    });
  });

  describe('getAnalysisByCategory', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    test('returns entries for category', async () => {
      const { getAnalysisByCategory } = require('../src/main/services/analysisHistory/queries');
      getAnalysisByCategory.mockResolvedValueOnce([{ id: 'entry-1' }]);

      const results = await service.getAnalysisByCategory('documents');

      expect(results).toEqual([{ id: 'entry-1' }]);
    });
  });

  describe('getAnalysisByTag', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    test('returns entries for tag', async () => {
      const { getAnalysisByTag } = require('../src/main/services/analysisHistory/queries');
      getAnalysisByTag.mockResolvedValueOnce([{ id: 'entry-1' }]);

      const results = await service.getAnalysisByTag('important');

      expect(results).toEqual([{ id: 'entry-1' }]);
    });
  });

  describe('getRecentAnalysis', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    test('returns recent entries with defaults', async () => {
      const { getRecentAnalysis } = require('../src/main/services/analysisHistory/queries');
      getRecentAnalysis.mockResolvedValueOnce([{ id: 'recent-1' }]);

      const results = await service.getRecentAnalysis();

      expect(getRecentAnalysis).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        50,
        0
      );
      expect(results).toEqual([{ id: 'recent-1' }]);
    });

    test('respects limit and offset', async () => {
      const { getRecentAnalysis } = require('../src/main/services/analysisHistory/queries');

      await service.getRecentAnalysis(20, 10);

      expect(getRecentAnalysis).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        20,
        10
      );
    });
  });

  describe('getStatistics', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    test('returns statistics', async () => {
      const { getStatistics } = require('../src/main/services/analysisHistory/statistics');
      getStatistics.mockResolvedValueOnce({ totalFiles: 100 });

      const stats = await service.getStatistics();

      expect(stats).toEqual({ totalFiles: 100 });
    });
  });

  describe('getQuickStats', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    test('returns quick stats', async () => {
      const { getQuickStats } = require('../src/main/services/analysisHistory/statistics');
      getQuickStats.mockResolvedValueOnce({ totalFiles: 50 });

      const stats = await service.getQuickStats();

      expect(stats).toEqual({ totalFiles: 50 });
    });
  });

  describe('getAnalysisByDateRange', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    test('returns entries in date range', async () => {
      const { getAnalysisByDateRange } = require('../src/main/services/analysisHistory/queries');
      getAnalysisByDateRange.mockResolvedValueOnce([{ id: 'entry-1' }]);

      const results = await service.getAnalysisByDateRange(
        new Date('2024-01-01'),
        new Date('2024-12-31')
      );

      expect(results).toEqual([{ id: 'entry-1' }]);
    });
  });

  describe('getCategories', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    test('returns available categories', async () => {
      const { getCategories } = require('../src/main/services/analysisHistory/queries');
      getCategories.mockResolvedValueOnce(['documents', 'images']);

      const categories = await service.getCategories();

      expect(categories).toEqual(['documents', 'images']);
    });
  });

  describe('getTags', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    test('returns available tags', async () => {
      const { getTags } = require('../src/main/services/analysisHistory/queries');
      getTags.mockResolvedValueOnce(['important', 'work']);

      const tags = await service.getTags();

      expect(tags).toEqual(['important', 'work']);
    });
  });

  describe('warmCache', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    test('warms cache', async () => {
      const { warmCache } = require('../src/main/services/analysisHistory/cacheManager');

      await service.warmCache();

      expect(warmCache).toHaveBeenCalled();
    });
  });

  describe('clearCaches', () => {
    test('clears all caches', () => {
      const { clearCaches } = require('../src/main/services/analysisHistory/cacheManager');

      service.clearCaches();

      expect(clearCaches).toHaveBeenCalled();
    });
  });

  // Regression: a resume was analyzed and the LLM put it in the wrong category
  // ("AVA", an unrelated schoolwork folder). The user corrected the destination
  // to "RESUMES" during organize. Before the fix, `updateEntryPaths` migrated
  // the path but left `analysis.category` at "AVA" — so SearchService.enrichResults
  // kept showing the wrong category long after the file was physically moved.
  describe('updateEntryPaths — category sync', () => {
    const seedEntry = (overrides = {}) => {
      const entry = {
        id: 'entry-1',
        originalPath: '/inbox/resume.docx',
        fileName: 'resume.docx',
        organization: { actual: '/inbox/resume.docx' },
        analysis: { category: 'AVA', confidence: 95 },
        ...overrides
      };
      service.analysisHistory.entries[entry.id] = entry;
      return entry;
    };

    beforeEach(async () => {
      await service.initialize();
    });

    test('refreshes analysis.category and records correctedFrom when caller passes newCategory', async () => {
      const entry = seedEntry();

      const result = await service.updateEntryPaths([
        {
          oldPath: '/inbox/resume.docx',
          newPath: '/RESUMES/master-sergeant.docx',
          newName: 'master-sergeant.docx',
          newCategory: 'RESUMES',
          newSmartFolder: 'RESUMES',
          newSmartFolderPath: '/RESUMES'
        }
      ]);

      expect(result.updated).toBe(1);
      expect(result.notFound).toBe(0);
      expect(entry.organization.actual).toBe('/RESUMES/master-sergeant.docx');
      expect(entry.analysis.category).toBe('RESUMES');
      expect(entry.analysis.correctedFrom).toBe('AVA');
      expect(entry.analysis.smartFolder).toBe('RESUMES');
      expect(entry.analysis.smartFolderPath).toBe('/RESUMES');
      expect(result.divergences).toEqual([
        {
          entryId: 'entry-1',
          filePath: '/RESUMES/master-sergeant.docx',
          oldCategory: 'AVA',
          newCategory: 'RESUMES'
        }
      ]);
    });

    test('omits divergence and does not set correctedFrom when category already matches destination', async () => {
      const entry = seedEntry({ analysis: { category: 'RESUMES', confidence: 90 } });

      const result = await service.updateEntryPaths([
        {
          oldPath: '/inbox/resume.docx',
          newPath: '/RESUMES/resume.docx',
          newName: 'resume.docx',
          newCategory: 'RESUMES'
        }
      ]);

      expect(result.updated).toBe(1);
      expect(result.divergences).toEqual([]);
      expect(entry.analysis.category).toBe('RESUMES');
      expect(entry.analysis.correctedFrom).toBeUndefined();
    });

    test('skips category sync entirely when caller omits newCategory (back-compat)', async () => {
      const entry = seedEntry();

      const result = await service.updateEntryPaths([
        { oldPath: '/inbox/resume.docx', newPath: '/elsewhere/resume.docx' }
      ]);

      expect(result.updated).toBe(1);
      expect(result.divergences).toEqual([]);
      // Pre-existing analysis stays untouched when no category is supplied
      expect(entry.analysis.category).toBe('AVA');
      expect(entry.analysis.correctedFrom).toBeUndefined();
      expect(entry.organization.actual).toBe('/elsewhere/resume.docx');
    });
  });

  // Every save rewrites the whole history + index blob. Saving per analyzed
  // file (and again per embedding-status flip) grew analysis-history.db to
  // megabytes with a bigger WAL in one session, so writes are coalesced.
  describe('coalesced disk save', () => {
    const fileAt = (name) => ({
      path: `/batch/${name}`,
      size: 10,
      lastModified: '2024-01-01T00:00:00Z'
    });
    let persistence;

    beforeEach(async () => {
      jest.useFakeTimers();
      persistence = require('../src/main/services/analysisHistory/persistence');
      await service.initialize();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    // recordAnalysis buffers for WRITE_BUFFER_MS before the in-memory commit.
    const record = async (name) => {
      const pending = service.recordAnalysis(fileAt(name), { category: 'docs' });
      await jest.advanceTimersByTimeAsync(service.WRITE_BUFFER_MS);
      return pending;
    };

    test('files analyzed a few seconds apart share disk writes', async () => {
      // Serial analysis: one file every 3 s. The old 100 ms buffer saved
      // after every file (4 saves); now the first save lands when things go
      // quiet and the rest wait for the minimum spacing.
      for (const name of ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf']) {
        await record(name);
        await jest.advanceTimersByTimeAsync(3000 - service.WRITE_BUFFER_MS);
      }
      await jest.advanceTimersByTimeAsync(15000);

      expect(persistence.saveHistory).toHaveBeenCalledTimes(2);
      expect(persistence.saveIndex).toHaveBeenCalledTimes(2);
      expect(Object.keys(service.analysisHistory.entries)).toHaveLength(4);
      expect(service.hasUnsavedChanges()).toBe(false);
    });

    test('a change is never held longer than the max wait during constant activity', async () => {
      // A change every second never goes quiet for 2 s; the max wait still
      // forces a write about 10 s after the first unsaved change.
      for (let i = 0; i < 11; i += 1) {
        await record(`busy-${i}.pdf`);
        await jest.advanceTimersByTimeAsync(1000 - service.WRITE_BUFFER_MS);
      }
      expect(persistence.saveHistory).toHaveBeenCalledTimes(1);
    });

    test('recordAnalysis resolves from memory, and a failed write keeps the entry and retries', async () => {
      persistence.saveHistory.mockRejectedValueOnce(new Error('disk full'));

      const id = await record('keep.pdf');
      expect(typeof id).toBe('string');
      expect(persistence.saveHistory).not.toHaveBeenCalled();
      expect(service.analysisHistory.entries[id]).toBeDefined();

      // First write fails: nothing is rolled back and no reload is forced.
      await jest.advanceTimersByTimeAsync(service.HISTORY_SAVE_QUIET_MS);
      expect(persistence.saveHistory).toHaveBeenCalledTimes(1);
      expect(service.analysisHistory.entries[id]).toBeDefined();
      expect(service.initialized).toBe(true);
      expect(service.hasUnsavedChanges()).toBe(true);

      // The retry waits out the minimum spacing, then succeeds.
      await jest.advanceTimersByTimeAsync(service.HISTORY_SAVE_MIN_INTERVAL_MS);
      expect(persistence.saveHistory).toHaveBeenCalledTimes(2);
      expect(service.hasUnsavedChanges()).toBe(false);
    });

    test('a disk-full history save raises the storage-full banner, and a good save clears it', async () => {
      const tracker = require('../src/main/services/DegradedStateTracker');
      tracker.getInstance()._reset();
      persistence.saveHistory.mockRejectedValueOnce(
        Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      );

      await record('full.pdf');
      await jest.advanceTimersByTimeAsync(service.HISTORY_SAVE_QUIET_MS);
      expect(tracker.isStorageFull()).toBe(true);

      await jest.advanceTimersByTimeAsync(service.HISTORY_SAVE_MIN_INTERVAL_MS);
      expect(service.hasUnsavedChanges()).toBe(false);
      expect(tracker.isStorageFull()).toBe(false);
    });

    test('a history save that fails for another reason does not claim the disk is full', async () => {
      const tracker = require('../src/main/services/DegradedStateTracker');
      tracker.getInstance()._reset();
      persistence.saveHistory.mockRejectedValueOnce(
        Object.assign(new Error('locked'), { code: 'EBUSY' })
      );
      await record('busy.pdf');
      await jest.advanceTimersByTimeAsync(service.HISTORY_SAVE_QUIET_MS);
      expect(tracker.isStorageFull()).toBe(false);
    });

    // The shipped history store is SQLite: better-sqlite3 reports a full disk
    // as SQLITE_FULL, never ENOSPC, so a check on errno codes never fired.
    test('a SQLite SQLITE_FULL history save raises the storage-full banner', async () => {
      const tracker = require('../src/main/services/DegradedStateTracker');
      tracker.getInstance()._reset();
      persistence.saveHistory.mockRejectedValueOnce(
        Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' })
      );

      await record('sqlite-full.pdf');
      await jest.advanceTimersByTimeAsync(service.HISTORY_SAVE_QUIET_MS);

      expect(tracker.isStorageFull()).toBe(true);
      expect(tracker.getInstance().list()[0].message).toMatch(/analysis history/);
    });

    test('an immediate save (an organize move) that succeeds lifts history’s hold', async () => {
      const tracker = require('../src/main/services/DegradedStateTracker');
      tracker.getInstance()._reset();
      persistence.saveHistory.mockRejectedValueOnce(
        Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      );
      await record('moved.pdf');
      await jest.advanceTimersByTimeAsync(service.HISTORY_SAVE_QUIET_MS);
      expect(tracker.isStorageFull()).toBe(true);

      // Space freed; the next history write is a move, saved immediately. It
      // also cancels the coalesced retry, which used to be the only clear.
      const result = await service.updateEntryPaths([
        { oldPath: '/batch/moved.pdf', newPath: '/docs/moved.pdf', newName: 'moved.pdf' }
      ]);
      expect(result.updated).toBe(1);
      expect(tracker.isStorageFull()).toBe(false);
    });

    test('a good history save does not lift the vector store’s hold', async () => {
      const tracker = require('../src/main/services/DegradedStateTracker');
      tracker.getInstance()._reset();
      // The vector store cannot save (its own source on the shared flag)...
      tracker.raiseStorageFull(tracker.STORAGE_FULL_SOURCES.VECTOR_STORE, { errno: 'ENOSPC' });
      // ...and history fails too, then saves once a little space frees.
      persistence.saveHistory.mockRejectedValueOnce(
        Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      );
      await record('both.pdf');
      await jest.advanceTimersByTimeAsync(service.HISTORY_SAVE_QUIET_MS);
      await jest.advanceTimersByTimeAsync(service.HISTORY_SAVE_MIN_INTERVAL_MS);
      expect(service.hasUnsavedChanges()).toBe(false);

      // Background analysis must stay held: the search index still cannot save.
      expect(tracker.isStorageFull()).toBe(true);
      expect(tracker.getInstance().sourcesOf(tracker.STORAGE_FULL_CODE)).toEqual([
        tracker.STORAGE_FULL_SOURCES.VECTOR_STORE
      ]);
      expect(tracker.getInstance().list()[0].message).toMatch(/search index/);
      expect(tracker.getInstance().list()[0].message).not.toMatch(/analysis history/);
    });

    test('embedding-state updates join the coalesced save instead of writing immediately', async () => {
      await record('embed.pdf');
      await jest.advanceTimersByTimeAsync(service.HISTORY_SAVE_QUIET_MS);
      persistence.saveHistory.mockClear();

      await service.updateEmbeddingStateByPath('/batch/embed.pdf', { status: 'pending' });
      await service.updateEmbeddingStateByPath('/batch/embed.pdf', { status: 'done' });
      await service.updateEmbeddingStateByPath('/batch/embed.pdf', { model: 'embed-model' });
      expect(persistence.saveHistory).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(service.HISTORY_SAVE_MIN_INTERVAL_MS);
      expect(persistence.saveHistory).toHaveBeenCalledTimes(1);
      const entry = Object.values(service.analysisHistory.entries)[0];
      expect(entry.embedding).toEqual(
        expect.objectContaining({ status: 'done', model: 'embed-model' })
      );
    });

    test('flushPendingSaves writes buffered and unsaved changes immediately', async () => {
      // Still inside the 100 ms buffer: not even in memory yet.
      const pending = service.recordAnalysis(fileAt('now.pdf'), { category: 'docs' });

      await expect(service.flushPendingSaves()).resolves.toBe(true);
      await pending;
      expect(persistence.saveHistory).toHaveBeenCalledTimes(1);
      expect(service.hasUnsavedChanges()).toBe(false);
    });

    test('shutdown writes what the coalesced save was still holding', async () => {
      await record('late.pdf');
      await jest.advanceTimersByTimeAsync(service.HISTORY_SAVE_QUIET_MS);
      persistence.saveHistory.mockClear();
      await service.updateEmbeddingStateByPath('/batch/late.pdf', { status: 'done' });

      await service.shutdown();

      expect(persistence.saveHistory).toHaveBeenCalledTimes(1);
      expect(service.hasUnsavedChanges()).toBe(false);
      expect(persistence.closeSqliteStore).toHaveBeenCalled();
    });

    test('a path update still writes immediately and fails closed, carrying unsaved changes', async () => {
      await record('move-me.pdf');
      const entry = Object.values(service.analysisHistory.entries)[0];
      expect(service.hasUnsavedChanges()).toBe(true);

      await service.updateEntryPaths([{ oldPath: entry.originalPath, newPath: '/moved/a.pdf' }]);
      expect(persistence.saveHistory).toHaveBeenCalledTimes(1);
      expect(service.hasUnsavedChanges()).toBe(false);

      // FilePathCoordinator rolls back its other stores only if this throws.
      persistence.saveHistory.mockRejectedValueOnce(new Error('disk gone'));
      await expect(
        service.updateEntryPaths([{ oldPath: '/moved/a.pdf', newPath: '/moved/b.pdf' }])
      ).rejects.toMatchObject({ code: 'HISTORY_PERSIST_FAILED' });
      expect(service.initialized).toBe(false);
    });
  });
});
