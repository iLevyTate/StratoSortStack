/**
 * Tests for Analysis History Statistics
 * Tests statistics calculation with incremental updates and caching
 */

// Mock dependencies
jest.mock('../src/main/services/analysisHistory/cacheManager', () => ({
  recalculateIncrementalStats: jest.fn()
}));

describe('statistics', () => {
  let statistics;
  let recalculateIncrementalStats;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    recalculateIncrementalStats =
      require('../src/main/services/analysisHistory/cacheManager').recalculateIncrementalStats;
    statistics = require('../src/main/services/analysisHistory/statistics');
  });

  describe('getOldestTimestamp', () => {
    test('returns oldest from sorted cache when valid', () => {
      const cache = {
        sortedEntriesValid: true,
        sortedEntries: [
          { timestamp: '2024-01-20' },
          { timestamp: '2024-01-15' },
          { timestamp: '2024-01-10' }
        ]
      };

      const result = statistics.getOldestTimestamp(cache, []);

      expect(result).toBe('2024-01-10');
    });

    test('finds oldest when cache not valid', () => {
      const cache = { sortedEntriesValid: false };
      const entries = [
        { timestamp: '2024-01-15' },
        { timestamp: '2024-01-10' },
        { timestamp: '2024-01-20' }
      ];

      const result = statistics.getOldestTimestamp(cache, entries);

      expect(result).toBe('2024-01-10');
    });

    test('returns null for empty entries', () => {
      const cache = { sortedEntriesValid: false };

      const result = statistics.getOldestTimestamp(cache, []);

      expect(result).toBeNull();
    });

    test('returns null for null entries', () => {
      const cache = { sortedEntriesValid: false };

      const result = statistics.getOldestTimestamp(cache, null);

      expect(result).toBeNull();
    });
  });

  describe('getNewestTimestamp', () => {
    test('returns newest from sorted cache when valid', () => {
      const cache = {
        sortedEntriesValid: true,
        sortedEntries: [
          { timestamp: '2024-01-20' },
          { timestamp: '2024-01-15' },
          { timestamp: '2024-01-10' }
        ]
      };

      const result = statistics.getNewestTimestamp(cache, []);

      expect(result).toBe('2024-01-20');
    });

    test('finds newest when cache not valid', () => {
      const cache = { sortedEntriesValid: false };
      const entries = [
        { timestamp: '2024-01-15' },
        { timestamp: '2024-01-20' },
        { timestamp: '2024-01-10' }
      ];

      const result = statistics.getNewestTimestamp(cache, entries);

      expect(result).toBe('2024-01-20');
    });

    test('returns null for empty entries', () => {
      const cache = { sortedEntriesValid: false };

      const result = statistics.getNewestTimestamp(cache, []);

      expect(result).toBeNull();
    });
  });

  describe('getTopItems', () => {
    test('returns top items by count', () => {
      const index = {
        documents: [1, 2, 3, 4, 5],
        images: [6, 7],
        audio: [8, 9, 10]
      };

      const result = statistics.getTopItems(index, 2);

      expect(result).toEqual([
        { name: 'documents', count: 5 },
        { name: 'audio', count: 3 }
      ]);
    });

    test('returns all items if limit exceeds count', () => {
      const index = {
        documents: [1],
        images: [2]
      };

      const result = statistics.getTopItems(index, 10);

      expect(result.length).toBe(2);
    });

    test('returns empty array for empty index', () => {
      const result = statistics.getTopItems({}, 5);

      expect(result).toEqual([]);
    });
  });

  describe('getSizeDistribution', () => {
    test('returns size distribution', () => {
      const sizeIndex = {
        tiny: [1, 2],
        small: [3, 4, 5],
        large: [6]
      };

      const result = statistics.getSizeDistribution(sizeIndex);

      expect(result).toEqual({
        tiny: 2,
        small: 3,
        large: 1
      });
    });

    test('returns empty object for empty index', () => {
      const result = statistics.getSizeDistribution({});

      expect(result).toEqual({});
    });
  });

  describe('getStatistics', () => {
    const createAnalysisHistory = () => ({
      entries: {
        1: { timestamp: '2024-01-15' },
        2: { timestamp: '2024-01-20' }
      },
      totalSize: 5000,
      updatedAt: '2024-01-20T10:00:00Z'
    });

    const createAnalysisIndex = () => ({
      categoryIndex: {
        documents: [1],
        images: [2]
      },
      tagIndex: {
        invoice: [1],
        photo: [2]
      },
      sizeIndex: {
        small: [1, 2]
      }
    });

    const createCache = () => ({
      statistics: null,
      statisticsTime: 0,
      incrementalStats: {
        initialized: true,
        totalConfidence: 1.5,
        totalProcessingTime: 300,
        entryCount: 2
      },
      sortedEntriesValid: false
    });

    test('calculates statistics from history', () => {
      const history = createAnalysisHistory();
      const index = createAnalysisIndex();
      const cache = createCache();
      const state = { _statsNeedFullRecalc: false };

      const result = statistics.getStatistics(history, index, cache, state, 30000);

      expect(result.totalFiles).toBe(2);
      expect(result.totalSize).toBe(5000);
      expect(result.categoriesCount).toBe(2);
      expect(result.tagsCount).toBe(2);
      expect(result.averageConfidence).toBe(0.75);
      expect(result.averageProcessingTime).toBe(150);
      expect(result.isEmpty).toBe(false);
    });

    test('uses cached statistics when valid', () => {
      const history = createAnalysisHistory();
      const index = createAnalysisIndex();
      const cachedStats = { totalFiles: 100 };
      const cache = {
        statistics: cachedStats,
        statisticsTime: Date.now(),
        incrementalStats: { initialized: true, entryCount: 100 }
      };
      const state = {};

      const result = statistics.getStatistics(history, index, cache, state, 30000);

      expect(result).toBe(cachedStats);
    });

    test('recalculates when stats need full recalc', () => {
      const history = createAnalysisHistory();
      const index = createAnalysisIndex();
      const cache = {
        statistics: null,
        statisticsTime: 0,
        incrementalStats: { initialized: false },
        sortedEntriesValid: false
      };
      const state = { _statsNeedFullRecalc: true };

      statistics.getStatistics(history, index, cache, state, 30000);

      expect(recalculateIncrementalStats).toHaveBeenCalled();
    });

    test('returns empty statistics for no entries', () => {
      const history = { entries: {}, totalSize: 0, updatedAt: null };
      const index = { categoryIndex: {}, tagIndex: {}, sizeIndex: {} };
      const cache = {
        statistics: null,
        statisticsTime: 0,
        incrementalStats: { initialized: true, entryCount: 0 },
        sortedEntriesValid: false
      };
      const state = {};

      const result = statistics.getStatistics(history, index, cache, state, 30000);

      expect(result.totalFiles).toBe(0);
      expect(result.isEmpty).toBe(true);
      expect(result.averageConfidence).toBe(0);
    });

    test('caches calculated statistics', () => {
      const history = createAnalysisHistory();
      const index = createAnalysisIndex();
      const cache = createCache();
      const state = {};

      statistics.getStatistics(history, index, cache, state, 30000);

      expect(cache.statistics).not.toBeNull();
      expect(cache.statisticsTime).toBeGreaterThan(0);
    });
  });

  describe('content-date range', () => {
    const createCacheWithDates = () => ({
      statistics: null,
      statisticsTime: 0,
      incrementalStats: {
        initialized: true,
        totalConfidence: 0,
        totalProcessingTime: 0,
        entryCount: 3
      },
      sortedEntriesValid: false
    });

    test('returns oldest and newest documentDate, ignoring null', () => {
      const history = {
        entries: {
          a: { timestamp: '2024-01-01', analysis: { documentDate: '2024-12-25' } },
          b: { timestamp: '2024-01-02', analysis: { documentDate: '2019-06-14' } },
          c: { timestamp: '2024-01-03', analysis: { documentDate: null } }
        },
        totalSize: 0,
        updatedAt: null
      };
      const index = { categoryIndex: {}, tagIndex: {}, sizeIndex: {} };
      const cache = createCacheWithDates();
      const state = { _statsNeedFullRecalc: false };

      const result = statistics.getStatistics(history, index, cache, state, 30000);

      expect(result.oldestContentDate).toBe('2019-06-14');
      expect(result.newestContentDate).toBe('2024-12-25');
    });

    test('implausible content years are excluded from the range [F-158]', () => {
      // Pre-fix, one hallucinated/OCR-misread year made the knowledge card
      // headline read like "201 – 2103 / 1902 years".
      const history = {
        entries: {
          a: { timestamp: '2024-01-01', analysis: { documentDate: '2024-12-25' } },
          b: { timestamp: '2024-01-02', analysis: { documentDate: '2103-01-01' } },
          c: { timestamp: '2024-01-03', analysis: { documentDate: '0201-05-03' } },
          d: { timestamp: '2024-01-04', analysis: { documentDate: '2019-06-14' } }
        },
        totalSize: 0,
        updatedAt: null
      };
      const index = { categoryIndex: {}, tagIndex: {}, sizeIndex: {} };
      const cache = createCacheWithDates();
      const state = { _statsNeedFullRecalc: false };

      const result = statistics.getStatistics(history, index, cache, state, 30000);

      expect(result.oldestContentDate).toBe('2019-06-14');
      expect(result.newestContentDate).toBe('2024-12-25');
    });

    test('returns oldest and newest on a second call (cache hit)', () => {
      const history = {
        entries: {
          a: { timestamp: '2024-01-01', analysis: { documentDate: '2024-12-25' } },
          b: { timestamp: '2024-01-02', analysis: { documentDate: '2019-06-14' } },
          c: { timestamp: '2024-01-03', analysis: { documentDate: null } }
        },
        totalSize: 0,
        updatedAt: null
      };
      const index = { categoryIndex: {}, tagIndex: {}, sizeIndex: {} };
      const cache = createCacheWithDates();
      const state = { _statsNeedFullRecalc: false };

      // First call populates cache
      statistics.getStatistics(history, index, cache, state, 30000);
      // Second call returns cached object
      const result = statistics.getStatistics(history, index, cache, state, 30000);

      expect(result.oldestContentDate).toBe('2019-06-14');
      expect(result.newestContentDate).toBe('2024-12-25');
    });

    test('skips non-ISO documentDate strings instead of comparing them lexicographically', () => {
      const history = {
        entries: {
          a: { timestamp: '2024-01-01', analysis: { documentDate: '2024-12-25' } },
          // Would lexicographically dominate any ISO date if not skipped.
          b: { timestamp: '2024-01-02', analysis: { documentDate: '12/31/2019' } },
          c: { timestamp: '2024-01-03', analysis: { documentDate: 'March 2024' } },
          d: { timestamp: '2024-01-04', analysis: { documentDate: '2020-05-01' } }
        },
        totalSize: 0,
        updatedAt: null
      };
      const index = { categoryIndex: {}, tagIndex: {}, sizeIndex: {} };
      const cache = createCacheWithDates();
      const state = { _statsNeedFullRecalc: false };

      const result = statistics.getStatistics(history, index, cache, state, 30000);

      expect(result.oldestContentDate).toBe('2020-05-01');
      expect(result.newestContentDate).toBe('2024-12-25');
    });

    test('accepts year-only and year-month ISO dates', () => {
      const { oldest, newest } = statistics.getContentDateRange({
        a: { analysis: { documentDate: '2019' } },
        b: { analysis: { documentDate: '2024-06' } },
        c: { analysis: { documentDate: '2021-03-14' } }
      });
      expect(oldest).toBe('2019');
      expect(newest).toBe('2024-06');
    });

    test('returns null for both when no entries have documentDate', () => {
      const history = {
        entries: {
          a: { timestamp: '2024-01-01', analysis: {} },
          b: { timestamp: '2024-01-02' }
        },
        totalSize: 0,
        updatedAt: null
      };
      const index = { categoryIndex: {}, tagIndex: {}, sizeIndex: {} };
      const cache = {
        statistics: null,
        statisticsTime: 0,
        incrementalStats: {
          initialized: true,
          totalConfidence: 0,
          totalProcessingTime: 0,
          entryCount: 2
        },
        sortedEntriesValid: false
      };
      const state = { _statsNeedFullRecalc: false };

      const result = statistics.getStatistics(history, index, cache, state, 30000);

      expect(result.oldestContentDate).toBeNull();
      expect(result.newestContentDate).toBeNull();
    });
  });

  describe('getQuickStats', () => {
    test('returns quick stats without full calculation', () => {
      const history = {
        entries: { 1: {}, 2: {}, 3: {} },
        totalSize: 10000,
        updatedAt: '2024-01-20T10:00:00Z'
      };
      const index = {
        categoryIndex: { a: [], b: [] },
        tagIndex: { x: [], y: [], z: [] }
      };

      const result = statistics.getQuickStats(history, index);

      expect(result.totalFiles).toBe(3);
      expect(result.totalSize).toBe(10000);
      expect(result.categoriesCount).toBe(2);
      expect(result.tagsCount).toBe(3);
      expect(result.lastUpdated).toBe('2024-01-20T10:00:00Z');
    });

    // D6 denominator: `embedding.eligibleFiles` is compared against the number
    // of unique file VECTORS in the vector store, so it has to count unique
    // FILES too. Counting history rows made the ratio unreachable on any store
    // with re-analyzed files: 281 rows / 188 unique paths here meant coverage
    // capped at 77% and the "search index is incomplete" banner never cleared.
    describe('embedding tallies count unique files, not history rows', () => {
      const index = { categoryIndex: {}, tagIndex: {} };

      // D7: a fallback analysis is deliberately not embedded until a real
      // re-analysis replaces it, so it must not hold coverage below 95%.
      test('fallback (provisional) analyses are not embedding-eligible', () => {
        const history = {
          entries: {
            real: {
              originalPath: '/docs/report.pdf',
              analysis: { extractionMethod: 'pdf-text' },
              embedding: { status: 'done' }
            },
            filenameOnly: {
              originalPath: '/docs/scan.tiff',
              analysis: { extractionMethod: 'filename' },
              embedding: { status: 'pending' }
            },
            stamped: {
              originalPath: '/docs/model-missing.docx',
              analysis: { provisional: true, extractionMethod: 'content' },
              embedding: { status: 'unknown' }
            },
            whisperSkipped: {
              originalPath: '/media/review.mp4',
              analysis: { extractionMethod: 'media-skipped-no-whisper' },
              embedding: { status: 'pending' }
            }
          }
        };

        const { embedding } = statistics.getQuickStats(history, index);

        expect(embedding.eligibleFiles).toBe(1);
        expect(embedding.doneFiles).toBe(1);
        expect(embedding.skippedFiles).toBe(3);
      });

      test('several rows for one path count once', () => {
        const history = {
          entries: {
            1: { originalPath: '/docs/a.pdf', embedding: { status: 'done' } },
            2: { originalPath: '/docs/a.pdf', embedding: { status: 'pending' } },
            3: { originalPath: '/docs/b.pdf', embedding: { status: 'pending' } }
          },
          totalSize: 0
        };

        const result = statistics.getQuickStats(history, index);

        expect(result.totalFiles).toBe(3);
        expect(result.embedding.eligibleFiles).toBe(2);
        expect(result.embedding.doneFiles).toBe(1);
        expect(result.embedding.pendingFiles).toBe(1);
      });

      test('the organized location wins over the original path', () => {
        const history = {
          entries: {
            1: { originalPath: '/inbox/a.pdf', organization: { actual: '/docs/a.pdf' } },
            2: { originalPath: '/docs/a.pdf' }
          },
          totalSize: 0
        };

        expect(statistics.getQuickStats(history, index).embedding.eligibleFiles).toBe(1);
      });

      test('a file counts as skipped only when every row for it is skipped', () => {
        const history = {
          entries: {
            1: { originalPath: '/docs/a.pdf', embedding: { status: 'skipped' } },
            2: { originalPath: '/docs/a.pdf', embedding: { status: 'done' } },
            3: { originalPath: '/docs/gone.pdf', embedding: { status: 'skipped' } },
            4: { originalPath: '/docs/gone.pdf', embedding: { policy: 'skip' } }
          },
          totalSize: 0
        };

        const result = statistics.getQuickStats(history, index);

        expect(result.embedding.eligibleFiles).toBe(1);
        expect(result.embedding.doneFiles).toBe(1);
        expect(result.embedding.skippedFiles).toBe(1);
      });

      test('entries with no usable path still count individually', () => {
        const history = { entries: { 1: {}, 2: {}, 3: {} }, totalSize: 0 };

        expect(statistics.getQuickStats(history, index).embedding.eligibleFiles).toBe(3);
      });
    });
  });
});
