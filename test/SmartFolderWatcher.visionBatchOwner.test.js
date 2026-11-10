/**
 * @jest-environment node
 *
 * SmartFolderWatcher as a vision batch owner.
 *
 * The watcher analyzes images in batches of up to 20 under vision batch mode.
 * It used to call exitVisionBatchMode() even when its enter had failed, which
 * dropped another owner's ref and ended that owner's batch mid-run. Its
 * images' text fallbacks must also run as the batch's own work, or they wait
 * for the batch that is waiting for them.
 */

jest.mock('chokidar', () => ({
  watch: jest.fn(() => ({
    on: jest.fn().mockReturnThis(),
    close: jest.fn().mockResolvedValue()
  }))
}));

jest.mock('fs', () => ({
  promises: {
    stat: jest.fn(),
    access: jest.fn(),
    readFile: jest.fn()
  }
}));

jest.mock('../src/shared/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  }
}));

jest.mock('../src/shared/constants', () => ({
  SUPPORTED_IMAGE_EXTENSIONS: ['.png', '.jpg'],
  ANALYSIS_SUPPORTED_EXTENSIONS: ['.pdf', '.txt', '.png', '.jpg'],
  AI_DEFAULTS: { TEXT: { MODEL: 'test-model' } }
}));

jest.mock('../src/shared/performanceConstants', () => ({
  CHUNKING: { MAX_CHUNK_SIZE: 1000, OVERLAP: 100 },
  TIMEOUTS: { AI_ANALYSIS_LONG: 60000, WATCHER_ANALYSIS: 30000 },
  RETRY: { MAX_ATTEMPTS_MEDIUM: 3 },
  LIMITS: { ANALYSIS_QUEUE_SIZE: 1000 },
  TEMP_FILE_PATTERNS: [],
  isTemporaryFile: () => false
}));

jest.mock('../src/shared/errorClassifier', () => ({
  isNotFoundError: jest.fn((e) => e?.code === 'ENOENT')
}));

jest.mock('../src/main/errors/FileSystemError', () => ({
  WatcherError: class WatcherError extends Error {
    constructor(msg) {
      super(msg);
      this.name = 'WatcherError';
    }
  }
}));

jest.mock('../src/main/services/autoOrganize/namingUtils', () => ({
  generateSuggestedNameFromAnalysis: jest.fn(() => 'suggested-name.pdf')
}));

jest.mock('../src/main/services/analysisHistory/indexManager', () => ({
  generateFileHash: jest.fn().mockResolvedValue('abc123')
}));

jest.mock('../src/main/services/confidence/watcherConfidence', () => ({
  deriveWatcherConfidencePercent: jest.fn(() => 85)
}));

jest.mock('../src/main/ipc/analysisUtils', () => ({
  recordAnalysisResult: jest.fn().mockResolvedValue()
}));

jest.mock('../src/main/utils/textChunking', () => ({
  chunkText: jest.fn(() => [{ text: 'chunk1', index: 0 }])
}));

jest.mock('../src/main/analysis/embeddingSummary', () => ({
  buildEmbeddingSummary: jest.fn(() => 'summary text')
}));

jest.mock('../src/main/analysis/semanticFolderMatcher', () => ({
  clearSmartFolderUpsertCache: jest.fn()
}));

jest.mock('../src/main/analysis/embeddingModelOptions', () => ({
  resolveEmbeddingModelOptions: jest.fn().mockResolvedValue({})
}));

jest.mock('../src/shared/fileOperationTracker', () => ({
  getInstance: jest.fn(() => ({
    isBeingProcessed: jest.fn(() => false),
    markProcessing: jest.fn(),
    clearProcessing: jest.fn(),
    recordOperation: jest.fn(),
    wasRecentlyOperated: jest.fn(() => false)
  }))
}));

jest.mock('../src/shared/pathSanitization', () => ({
  normalizePathForIndex: jest.fn((p) => p),
  getCanonicalFileId: jest.fn((p) => `file:${p}`)
}));

jest.mock('../src/shared/crossPlatformUtils', () => ({
  isUNCPath: jest.fn(() => false)
}));

jest.mock('../src/shared/normalization', () => ({
  normalizeKeywords: jest.fn((kw) => kw)
}));

jest.mock('../src/main/services/organization/learningFeedback', () => ({
  getInstance: jest.fn(),
  FEEDBACK_SOURCES: { WATCHER: 'watcher' }
}));

jest.mock('../src/shared/promiseUtils', () => ({
  withTimeout: jest.fn((p) => p),
  createBackgroundWorkTracker: jest.fn(() => ({
    track: jest.fn((p) => p),
    drain: jest.fn(),
    get size() {
      return 0;
    }
  })),
  createInitGuard: jest.fn(() => ({
    isInitialized: () => false,
    initialize: jest.fn(async (fn) => fn()),
    reset: jest.fn(),
    requireInitialized: jest.fn()
  }))
}));

jest.mock('../src/main/services/embedding/embeddingGate', () => ({
  shouldEmbed: jest.fn().mockResolvedValue({ shouldEmbed: true })
}));

const mockLlama = {
  enterVisionBatchMode: jest.fn().mockResolvedValue(undefined),
  exitVisionBatchMode: jest.fn().mockResolvedValue(undefined),
  runAsVisionBatchMember: jest.fn()
};
jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: jest.fn(() => mockLlama)
}));

const SmartFolderWatcher = require('../src/main/services/SmartFolderWatcher');
const {
  claimUserAnalysis,
  _resetUserAnalysisInFlight
} = require('../src/main/analysis/userAnalysisInFlight');

function createWatcher() {
  return new SmartFolderWatcher({
    getSmartFolders: jest.fn(() => [{ name: 'Pictures', path: '/watched/pics' }]),
    analysisHistoryService: {
      getAnalysisByPath: jest.fn().mockResolvedValue(null),
      addEntry: jest.fn().mockResolvedValue(),
      updateEntry: jest.fn().mockResolvedValue()
    },
    analyzeDocumentFile: jest.fn(),
    analyzeImageFile: jest.fn(),
    settingsService: {
      get: jest.fn().mockReturnValue({ watcherEnabled: true }),
      getSettingValue: jest.fn().mockReturnValue(true)
    }
  });
}

function queueImages(watcher, count) {
  for (let i = 0; i < count; i += 1) {
    watcher.analysisQueue.push({
      filePath: `/watched/pics/photo-${i}.png`,
      mtime: Date.now(),
      eventType: 'add'
    });
  }
}

describe('SmartFolderWatcher image batch and vision batch mode', () => {
  let watcher;
  let inBatchScope;
  let scopeAtAnalysis;

  beforeEach(() => {
    jest.clearAllMocks();
    inBatchScope = false;
    scopeAtAnalysis = [];
    mockLlama.enterVisionBatchMode.mockResolvedValue(undefined);
    mockLlama.runAsVisionBatchMember.mockImplementation(async (fn) => {
      inBatchScope = true;
      try {
        return await fn();
      } finally {
        inBatchScope = false;
      }
    });
    watcher = createWatcher();
    watcher._analyzeWithTimeout = jest.fn(async () => {
      scopeAtAnalysis.push(inBatchScope);
    });
  });

  afterEach(async () => {
    await watcher?.stop?.();
  });

  test("analyzes the batch's images as the vision batch's own work", async () => {
    queueImages(watcher, 2);

    await watcher._processQueue();

    expect(mockLlama.enterVisionBatchMode).toHaveBeenCalledTimes(1);
    expect(scopeAtAnalysis).toEqual([true, true]);
    expect(mockLlama.exitVisionBatchMode).toHaveBeenCalledTimes(1);
  });

  test("does not exit (and end another owner's batch) when its own enter failed", async () => {
    mockLlama.enterVisionBatchMode.mockRejectedValueOnce(new Error('no room for vision'));
    queueImages(watcher, 2);

    await watcher._processQueue();

    // The images still run, unbatched and outside the batch scope.
    expect(watcher._analyzeWithTimeout).toHaveBeenCalledTimes(2);
    expect(scopeAtAnalysis).toEqual([false, false]);
    expect(mockLlama.runAsVisionBatchMember).not.toHaveBeenCalled();
    expect(mockLlama.exitVisionBatchMode).not.toHaveBeenCalled();
  });

  describe('when images in the batch need no analysis', () => {
    // _analyzeFile drops an item the history has caught up with, most often
    // the change event that follows the watcher's own read of a file. The
    // batch used to enter vision batch mode before that was known: text and
    // embedding models unloaded, the vision runtime started, the text model
    // loaded again on the way out, and nothing analyzed.
    const fsPromises = require('fs').promises;
    const upToDate = { fileSize: 10, lastModified: 1000 };

    beforeEach(() => {
      fsPromises.stat.mockResolvedValue({ mtimeMs: 1000, size: 10 });
    });
    afterEach(() => {
      fsPromises.stat.mockReset();
    });

    test('does not enter vision batch mode when the history has every image', async () => {
      watcher.analysisHistoryService.getAnalysisByPath.mockResolvedValue(upToDate);
      queueImages(watcher, 2);

      await watcher._processQueue();

      expect(mockLlama.enterVisionBatchMode).not.toHaveBeenCalled();
      expect(mockLlama.exitVisionBatchMode).not.toHaveBeenCalled();
      // The items still go through _analyzeFile, which drops and logs them.
      expect(watcher._analyzeWithTimeout).toHaveBeenCalledTimes(2);
      expect(watcher._inFlightItems.size).toBe(0);
      expect(watcher.analysisQueue).toEqual([]);
    });

    test('enters once when one image of the batch still needs analysis', async () => {
      watcher.analysisHistoryService.getAnalysisByPath.mockImplementation(async (filePath) =>
        filePath.endsWith('photo-1.png') ? null : upToDate
      );
      queueImages(watcher, 3);

      await watcher._processQueue();

      expect(mockLlama.enterVisionBatchMode).toHaveBeenCalledTimes(1);
      expect(scopeAtAnalysis).toEqual([true, true, true]);
      expect(mockLlama.exitVisionBatchMode).toHaveBeenCalledTimes(1);
    });

    test('an embedding retry, which reuses its analysis, does not enter', async () => {
      queueImages(watcher, 1);
      watcher.analysisQueue[0].cachedAnalysis = { category: 'Photos' };

      await watcher._processQueue();

      expect(mockLlama.enterVisionBatchMode).not.toHaveBeenCalled();
      expect(watcher._analyzeWithTimeout).toHaveBeenCalledTimes(1);
    });

    test('an image deleted since it was queued does not enter', async () => {
      fsPromises.stat.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));
      queueImages(watcher, 1);

      await watcher._processQueue();

      expect(mockLlama.enterVisionBatchMode).not.toHaveBeenCalled();
    });

    test('an explicit reanalysis enters although the history has the image', async () => {
      watcher.analysisHistoryService.getAnalysisByPath.mockResolvedValue(upToDate);
      queueImages(watcher, 1);
      watcher.analysisQueue[0].eventType = 'reanalyze';

      await watcher._processQueue();

      expect(mockLlama.enterVisionBatchMode).toHaveBeenCalledTimes(1);
    });
  });

  describe('when a Discover analysis starts during the batch', () => {
    // The queue is held while the user analyzes, but that was only looked at
    // before a batch began: up to 19 more images then ran beside the user.
    const queued = () => watcher.analysisQueue.map((item) => item.filePath);
    let release;

    beforeEach(() => {
      release = null;
      watcher._analyzeWithTimeout = jest.fn(async () => {
        if (!release) release = claimUserAnalysis('/discover/report.pdf');
      });
    });
    afterEach(() => {
      _resetUserAnalysisInFlight();
    });

    test('hands the images it has not started back to the queue', async () => {
      queueImages(watcher, 4);

      await watcher._processQueue();

      expect(watcher._analyzeWithTimeout).toHaveBeenCalledTimes(1);
      expect(queued()).toEqual([
        '/watched/pics/photo-1.png',
        '/watched/pics/photo-2.png',
        '/watched/pics/photo-3.png'
      ]);
      expect(watcher._inFlightItems.size).toBe(0);
      expect(mockLlama.exitVisionBatchMode).toHaveBeenCalledTimes(1);

      // Held for as long as the run lasts, then analyzed.
      await watcher._processQueue();
      expect(watcher._analyzeWithTimeout).toHaveBeenCalledTimes(1);
      release();
      await watcher._processQueue();
      expect(watcher._analyzeWithTimeout).toHaveBeenCalledTimes(4);
      expect(queued()).toEqual([]);
    });

    test('does not queue an image twice when a change to it was queued meanwhile', async () => {
      queueImages(watcher, 3);
      watcher._analyzeWithTimeout.mockImplementationOnce(async () => {
        release = claimUserAnalysis('/discover/report.pdf');
        watcher._enqueueAnalysisItem({
          filePath: '/watched/pics/photo-2.png',
          mtime: 2,
          eventType: 'change'
        });
      });

      await watcher._processQueue();

      expect(queued()).toEqual(['/watched/pics/photo-1.png', '/watched/pics/photo-2.png']);
      expect(watcher.analysisQueue[1].eventType).toBe('change');
    });

    test('a reanalysis it hands back stays one when a change to the file was queued meanwhile', async () => {
      queueImages(watcher, 3);
      Object.assign(watcher.analysisQueue[2], { eventType: 'reanalyze', applyNaming: true });
      watcher._analyzeWithTimeout.mockImplementationOnce(async () => {
        release = claimUserAnalysis('/discover/report.pdf');
        watcher._enqueueAnalysisItem({
          filePath: '/watched/pics/photo-2.png',
          mtime: 2,
          eventType: 'change'
        });
      });

      await watcher._processQueue();

      expect(queued()).toEqual(['/watched/pics/photo-1.png', '/watched/pics/photo-2.png']);
      expect(watcher.analysisQueue[1]).toMatchObject({
        eventType: 'reanalyze',
        applyNaming: true,
        mtime: 2
      });
      expect(watcher.analysisQueue[0].eventType).toBe('add');
    });
  });
});
