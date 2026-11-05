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
});
