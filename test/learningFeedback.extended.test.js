/**
 * Extended tests for LearningFeedbackService class
 * Covers: recordFilePlacement, recordFileMove, deduplication,
 * _isValidSmartFolder, learnFromExistingFiles, stats, cleanup, shutdown
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

// Mock folderUtils
const mockFindSmartFolder = jest.fn();
jest.mock('../src/shared/folderUtils', () => ({
  findContainingSmartFolder: mockFindSmartFolder
}));

// Mock performanceConstants
jest.mock('../src/shared/performanceConstants', () => ({
  DEBOUNCE: {
    LEARNING_DEDUPE_WINDOW: 5000
  }
}));

// Mock ServiceContainer
jest.mock('../src/main/services/ServiceContainer', () => ({
  container: {
    has: jest.fn().mockReturnValue(false),
    resolve: jest.fn()
  },
  ServiceIds: {
    LEARNING_FEEDBACK: 'learningFeedback'
  }
}));

// Mock fs for _scanFolderFiles
jest.mock('fs', () => ({
  promises: {
    readdir: jest.fn().mockResolvedValue([])
  }
}));

const {
  LearningFeedbackService,
  FEEDBACK_SOURCES,
  buildFileMetadata,
  getInstance,
  resetInstance
} = require('../src/main/services/organization/learningFeedback');

describe('LearningFeedbackService', () => {
  let service;
  let mockSuggestionService;
  let mockGetSmartFolders;
  const smartFolders = [
    { id: 'sf1', name: 'Documents', path: '/home/user/Documents' },
    { id: 'sf2', name: 'Photos', path: '/home/user/Photos' }
  ];

  beforeEach(() => {
    jest.clearAllMocks();

    mockSuggestionService = {
      recordFeedback: jest.fn().mockResolvedValue(undefined),
      recordFeedbackNote: jest.fn().mockResolvedValue({ id: 'mem-1' }),
      patternMatcher: {
        incrementFolderUsage: jest.fn()
      }
    };

    mockGetSmartFolders = jest.fn().mockReturnValue(smartFolders);

    service = new LearningFeedbackService({
      suggestionService: mockSuggestionService,
      getSmartFolders: mockGetSmartFolders
    });
  });

  afterEach(() => {
    resetInstance();
  });

  // F-202 (K-12): undoing a batch move must take back the learning that move
  // recorded — otherwise the feedback memory learns from moves the user
  // rejected.
  describe('retractFileFeedback [F-202]', () => {
    beforeEach(() => {
      mockFindSmartFolder.mockImplementation((p) =>
        String(p).includes('/Documents/') ? smartFolders[0] : null
      );
      mockSuggestionService.retractFeedback = jest.fn().mockResolvedValue({ retracted: true });
      // Memories store the index key buildMemoryEntry writes (case-folded on
      // Windows/macOS only), so the fixture uses the same normalizer.
      const { normalizePathForIndex } = jest.requireActual('../src/shared/pathSanitization');
      mockSuggestionService.listFeedbackMemory = jest.fn().mockResolvedValue([
        {
          id: 'mem-a',
          source: 'feedback_reject',
          filePath: normalizePathForIndex('/home/user/Documents/q1.pdf')
        },
        {
          id: 'mem-b',
          source: 'feedback_reject',
          filePath: normalizePathForIndex('/home/user/Documents/other.pdf')
        },
        { id: 'mem-c', source: 'manual', filePath: null }
      ]);
      mockSuggestionService.deleteFeedbackMemory = jest.fn().mockResolvedValue(true);
    });

    test('retracts the placement pattern and deletes the correction memories for that file', async () => {
      const filePath = '/home/user/Documents/q1.pdf';
      const result = await service.retractFileFeedback(filePath);

      expect(mockSuggestionService.retractFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ extension: 'pdf', name: 'q1.pdf' }),
        expect.objectContaining({ folder: 'Documents' })
      );
      expect(mockSuggestionService.deleteFeedbackMemory).toHaveBeenCalledTimes(1);
      expect(mockSuggestionService.deleteFeedbackMemory).toHaveBeenCalledWith('mem-a');
      expect(result).toEqual({ patternRetracted: true, memoriesRemoved: 1 });
    });

    test('a file outside every smart folder only clears its correction memories', async () => {
      const result = await service.retractFileFeedback('/elsewhere/q1.pdf');
      expect(mockSuggestionService.retractFeedback).not.toHaveBeenCalled();
      expect(result).toEqual({ patternRetracted: false, memoriesRemoved: 0 });
    });

    test('lets the same file be learned again afterwards (dedupe window cleared)', async () => {
      const filePath = '/home/user/Documents/q1.pdf';
      await service.recordFileMove('/downloads/q1.pdf', filePath);
      await service.retractFileFeedback(filePath);
      mockSuggestionService.recordFeedback.mockClear();
      const learnedAgain = await service.recordFileMove('/downloads/q1.pdf', filePath);
      expect(learnedAgain).toBe(true);
      expect(mockSuggestionService.recordFeedback).toHaveBeenCalledTimes(1);
    });

    test('never throws when the suggestion service is missing or fails', async () => {
      mockSuggestionService.listFeedbackMemory = jest.fn().mockRejectedValue(new Error('x'));
      await expect(service.retractFileFeedback('/home/user/Documents/q1.pdf')).resolves.toEqual(
        expect.objectContaining({ memoriesRemoved: 0 })
      );
      service.suggestionService = null;
      await expect(service.retractFileFeedback('/home/user/Documents/q1.pdf')).resolves.toEqual({
        patternRetracted: false,
        memoriesRemoved: 0
      });
    });
  });

  describe('recordCorrection', () => {
    test('records a feedback_reject note against the wrong folder', async () => {
      const result = await service.recordCorrection({
        filePath: '/home/user/Documents/report.pdf',
        wrongFolder: 'Photos',
        correctFolder: 'Documents',
        oldCategory: 'Image'
      });

      expect(result).toBe(true);
      // accepted=false → a feedback_reject memory that penalizes the wrong folder
      // for semantically-similar future files.
      expect(mockSuggestionService.recordFeedbackNote).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'report.pdf', extension: 'pdf' }),
        expect.objectContaining({ folder: 'Photos' }),
        false,
        expect.stringContaining('Documents'),
        // F-202: the memory is attributed to the file so an undo can remove it.
        expect.objectContaining({ filePath: '/home/user/Documents/report.pdf' })
      );
    });

    test('no-op when wrong and correct folders are equivalent', async () => {
      const result = await service.recordCorrection({
        filePath: '/a/b.pdf',
        wrongFolder: 'Documents',
        correctFolder: 'documents'
      });

      expect(result).toBe(false);
      expect(mockSuggestionService.recordFeedbackNote).not.toHaveBeenCalled();
    });

    test('returns false when required fields are missing', async () => {
      expect(
        await service.recordCorrection({ filePath: '', wrongFolder: 'X', correctFolder: 'Y' })
      ).toBe(false);
      expect(
        await service.recordCorrection({ filePath: '/a', wrongFolder: '', correctFolder: 'Y' })
      ).toBe(false);
      expect(mockSuggestionService.recordFeedbackNote).not.toHaveBeenCalled();
    });

    test('returns false when suggestionService lacks recordFeedbackNote', async () => {
      service.suggestionService = { recordFeedback: jest.fn() };
      const result = await service.recordCorrection({
        filePath: '/a/b.pdf',
        wrongFolder: 'Photos',
        correctFolder: 'Documents'
      });

      expect(result).toBe(false);
    });
  });

  describe('recordFilePlacement', () => {
    test('records feedback for valid file placement', async () => {
      const result = await service.recordFilePlacement({
        filePath: '/home/user/Documents/report.pdf',
        smartFolder: smartFolders[0],
        analysis: { category: 'Work', keywords: ['finance'] },
        source: FEEDBACK_SOURCES.MANUAL_MOVE
      });

      expect(result).toBe(true);
      expect(mockSuggestionService.recordFeedback).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'report.pdf',
          extension: 'pdf',
          category: 'Work'
        }),
        expect.objectContaining({
          folder: 'Documents',
          path: '/home/user/Documents',
          method: 'implicit_feedback'
        }),
        true
      );
    });

    test('returns false for missing filePath', async () => {
      const result = await service.recordFilePlacement({
        filePath: null,
        smartFolder: smartFolders[0]
      });

      expect(result).toBe(false);
    });

    test('returns false for missing smartFolder', async () => {
      const result = await service.recordFilePlacement({
        filePath: '/some/file.txt',
        smartFolder: null
      });

      expect(result).toBe(false);
    });

    test('returns false for smartFolder without path', async () => {
      const result = await service.recordFilePlacement({
        filePath: '/some/file.txt',
        smartFolder: { name: 'Test' }
      });

      expect(result).toBe(false);
    });

    test('returns false when folder is not in registered smart folders', async () => {
      const result = await service.recordFilePlacement({
        filePath: '/some/file.txt',
        smartFolder: { id: 'unknown', name: 'Unknown', path: '/unknown/path' }
      });

      expect(result).toBe(false);
    });

    test('returns false when suggestion service is not available', async () => {
      service.suggestionService = null;

      const result = await service.recordFilePlacement({
        filePath: '/home/user/Documents/file.txt',
        smartFolder: smartFolders[0]
      });

      expect(result).toBe(false);
    });

    test('deduplicates within time window', async () => {
      const params = {
        filePath: '/home/user/Documents/file.txt',
        smartFolder: smartFolders[0],
        source: FEEDBACK_SOURCES.MANUAL_MOVE
      };

      const first = await service.recordFilePlacement(params);
      const second = await service.recordFilePlacement(params);

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(mockSuggestionService.recordFeedback).toHaveBeenCalledTimes(1);
    });

    test('allows re-learning after dedupe window expires', async () => {
      const params = {
        filePath: '/home/user/Documents/file.txt',
        smartFolder: smartFolders[0],
        source: FEEDBACK_SOURCES.MANUAL_MOVE
      };

      await service.recordFilePlacement(params);

      // Manually expire the dedupe entry (keys are normalized path-index form)
      const [dedupeKey] = [...service._recentlyLearned.keys()];
      service._recentlyLearned.set(dedupeKey, Date.now() - 10000);

      const second = await service.recordFilePlacement(params);
      expect(second).toBe(true);
    });

    test('uses correct confidence weight per source', async () => {
      await service.recordFilePlacement({
        filePath: '/home/user/Documents/a.txt',
        smartFolder: smartFolders[0],
        source: FEEDBACK_SOURCES.STARTUP_SCAN
      });

      expect(mockSuggestionService.recordFeedback).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          confidence: expect.closeTo(0.85 * 0.4, 2)
        }),
        true
      );
    });

    test('uses default weight for unknown source', async () => {
      await service.recordFilePlacement({
        filePath: '/home/user/Documents/b.txt',
        smartFolder: smartFolders[0],
        source: 'unknown_source'
      });

      expect(mockSuggestionService.recordFeedback).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          confidence: expect.closeTo(0.85 * 0.5, 2)
        }),
        true
      );
    });

    test('increments folder usage on pattern matcher', async () => {
      await service.recordFilePlacement({
        filePath: '/home/user/Documents/c.txt',
        smartFolder: smartFolders[0],
        source: FEEDBACK_SOURCES.MANUAL_MOVE
      });

      expect(mockSuggestionService.patternMatcher.incrementFolderUsage).toHaveBeenCalledWith('sf1');
    });

    test('handles missing patternMatcher gracefully', async () => {
      mockSuggestionService.patternMatcher = null;

      const result = await service.recordFilePlacement({
        filePath: '/home/user/Documents/d.txt',
        smartFolder: smartFolders[0]
      });

      expect(result).toBe(true);
    });

    test('handles suggestionService.recordFeedback error', async () => {
      mockSuggestionService.recordFeedback.mockRejectedValueOnce(
        new Error('Pattern storage failed to load')
      );

      const result = await service.recordFilePlacement({
        filePath: '/home/user/Documents/e.txt',
        smartFolder: smartFolders[0]
      });

      expect(result).toBe(false);
    });

    test('updates stats on successful recording', async () => {
      await service.recordFilePlacement({
        filePath: '/home/user/Documents/f.txt',
        smartFolder: smartFolders[0],
        source: FEEDBACK_SOURCES.MANUAL_MOVE
      });

      const stats = service.getStats();
      expect(stats.totalLearned).toBe(1);
      expect(stats.bySource[FEEDBACK_SOURCES.MANUAL_MOVE]).toBe(1);
      expect(stats.lastLearnedAt).toBeTruthy();
    });
  });

  describe('recordFileMove', () => {
    test('auto-detects smart folder and records placement', async () => {
      mockFindSmartFolder.mockReturnValue(smartFolders[0]);

      const result = await service.recordFileMove(
        '/old/path/file.txt',
        '/home/user/Documents/file.txt',
        { category: 'Work' },
        FEEDBACK_SOURCES.MANUAL_MOVE
      );

      expect(result).toBe(true);
      expect(mockFindSmartFolder).toHaveBeenCalledWith(
        '/home/user/Documents/file.txt',
        smartFolders
      );
    });

    test('returns false when destination is not a smart folder', async () => {
      mockFindSmartFolder.mockReturnValue(null);

      const result = await service.recordFileMove('/old/file.txt', '/random/destination/file.txt');

      expect(result).toBe(false);
    });
  });

  describe('_isValidSmartFolder', () => {
    test('returns false for null folder', () => {
      expect(service._isValidSmartFolder(null)).toBe(false);
    });

    test('returns false for folder without path', () => {
      expect(service._isValidSmartFolder({ name: 'Test' })).toBe(false);
    });

    test('returns false when getSmartFolders returns empty', () => {
      mockGetSmartFolders.mockReturnValue([]);
      expect(service._isValidSmartFolder({ path: '/some/path' })).toBe(false);
    });

    test('matches by path', () => {
      expect(service._isValidSmartFolder({ path: '/home/user/Documents' })).toBe(true);
    });

    test('matches by id', () => {
      expect(service._isValidSmartFolder({ id: 'sf2', path: '/different/path' })).toBe(true);
    });

    test('returns false for unregistered folder', () => {
      expect(service._isValidSmartFolder({ id: 'unknown', path: '/unknown/path' })).toBe(false);
    });
  });

  describe('_cleanupDedupeCache', () => {
    test('removes entries older than twice the dedupe window', () => {
      const now = Date.now();
      service._recentlyLearned.set('/old/file.txt', now - 20000);
      service._recentlyLearned.set('/recent/file.txt', now - 1000);
      service._recentlyLearned.set('/fresh/file.txt', now);

      service._cleanupDedupeCache(now);

      expect(service._recentlyLearned.has('/old/file.txt')).toBe(false);
      expect(service._recentlyLearned.has('/recent/file.txt')).toBe(true);
      expect(service._recentlyLearned.has('/fresh/file.txt')).toBe(true);
    });
  });

  describe('dedupe cache overflow triggers cleanup', () => {
    test('cleans cache when it exceeds 1000 entries', async () => {
      // Fill cache with 1000 old entries
      const oldTime = Date.now() - 20000;
      for (let i = 0; i < 1001; i++) {
        service._recentlyLearned.set(`/file${i}.txt`, oldTime);
      }

      // This should trigger cleanup
      await service.recordFilePlacement({
        filePath: '/home/user/Documents/trigger.txt',
        smartFolder: smartFolders[0]
      });

      // Old entries should be cleaned
      expect(service._recentlyLearned.size).toBeLessThan(1001);
    });
  });

  describe('learnFromExistingFiles', () => {
    test('returns zeros when no smart folders', async () => {
      mockGetSmartFolders.mockReturnValue([]);

      const result = await service.learnFromExistingFiles(null);

      expect(result).toEqual({ scanned: 0, learned: 0 });
    });

    test('scans folders and learns from files with analysis', async () => {
      const mockFs = require('fs').promises;
      mockFs.readdir.mockResolvedValue([
        { name: 'report.pdf', isFile: () => true },
        { name: 'photo.jpg', isFile: () => true },
        { name: '.hidden', isFile: () => true },
        { name: 'subfolder', isFile: () => false }
      ]);

      const mockAnalysisHistoryService = {
        getAnalysisByPath: jest
          .fn()
          .mockResolvedValueOnce({ category: 'Work' })
          .mockResolvedValueOnce(null) // No analysis for photo.jpg
      };

      const result = await service.learnFromExistingFiles(mockAnalysisHistoryService, {
        onlyWithAnalysis: true
      });

      // 2 smart folders * 2 visible files per folder = 4 scanned
      // Only files with analysis are learned (1 per folder with mock setup)
      expect(result.scanned).toBe(4);
      expect(result.learned).toBeGreaterThanOrEqual(1);
    });

    test('learns from all files when onlyWithAnalysis is false', async () => {
      const mockFs = require('fs').promises;
      mockFs.readdir.mockResolvedValue([
        { name: 'file1.txt', isFile: () => true },
        { name: 'file2.txt', isFile: () => true }
      ]);

      const result = await service.learnFromExistingFiles(null, {
        onlyWithAnalysis: false
      });

      expect(result.scanned).toBe(4); // 2 files x 2 folders
      expect(result.learned).toBeGreaterThanOrEqual(0);
    });

    test('skips folders with null path', async () => {
      mockGetSmartFolders.mockReturnValue([
        { id: 'sf1', name: 'Good', path: '/good' },
        { id: 'sf2', name: 'Bad', path: null },
        null
      ]);

      const mockFs = require('fs').promises;
      mockFs.readdir.mockResolvedValue([]);

      const result = await service.learnFromExistingFiles(null);

      expect(result.scanned).toBe(0);
    });

    test('handles folder scan errors gracefully', async () => {
      const mockFs = require('fs').promises;
      mockFs.readdir.mockRejectedValue(new Error('Permission denied'));

      const result = await service.learnFromExistingFiles(null);

      expect(result.scanned).toBe(0);
      expect(result.learned).toBe(0);
    });

    test('respects maxFilesPerFolder option', async () => {
      const mockFs = require('fs').promises;
      const manyFiles = Array.from({ length: 200 }, (_, i) => ({
        name: `file${i}.txt`,
        isFile: () => true
      }));
      mockFs.readdir.mockResolvedValue(manyFiles);

      const result = await service.learnFromExistingFiles(null, {
        maxFilesPerFolder: 5,
        onlyWithAnalysis: false
      });

      // Should only scan up to 5 per folder (2 folders = 10 max)
      expect(result.scanned).toBeLessThanOrEqual(10);
    });
  });

  describe('getStats and resetStats', () => {
    test('returns copy of stats', () => {
      const stats = service.getStats();
      stats.totalLearned = 999; // Mutating the copy

      expect(service.getStats().totalLearned).toBe(0); // Original unchanged
    });

    test('resetStats clears all stats', async () => {
      await service.recordFilePlacement({
        filePath: '/home/user/Documents/file.txt',
        smartFolder: smartFolders[0]
      });

      service.resetStats();

      const stats = service.getStats();
      expect(stats.totalLearned).toBe(0);
      expect(stats.bySource).toEqual({});
      expect(stats.lastLearnedAt).toBeNull();
    });
  });

  describe('shutdown', () => {
    test('clears dedupe cache', () => {
      service._recentlyLearned.set('/file.txt', Date.now());

      service.shutdown();

      expect(service._recentlyLearned.size).toBe(0);
    });
  });

  describe('getInstance / resetInstance', () => {
    test('returns null when no deps and no container', () => {
      resetInstance();
      const inst = getInstance();
      expect(inst).toBeNull();
    });

    test('creates instance when deps provided', () => {
      resetInstance();
      const inst = getInstance({
        suggestionService: mockSuggestionService,
        getSmartFolders: mockGetSmartFolders
      });

      expect(inst).toBeInstanceOf(LearningFeedbackService);
    });

    test('returns same instance on subsequent calls', () => {
      resetInstance();
      const inst1 = getInstance({
        suggestionService: mockSuggestionService,
        getSmartFolders: mockGetSmartFolders
      });
      const inst2 = getInstance();

      expect(inst2).toBe(inst1);
    });
  });
});
