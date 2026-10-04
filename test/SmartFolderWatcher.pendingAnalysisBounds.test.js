/**
 * @jest-environment node
 *
 * Regression: pendingAnalysis Map must stay bounded during burst activity.
 */

jest.mock('fs', () => ({
  promises: {
    stat: jest.fn(),
    readFile: jest.fn(),
    access: jest.fn(),
    readdir: jest.fn()
  }
}));

jest.mock('chokidar', () => ({
  watch: jest.fn(() => {
    const EventEmitter = require('events');
    const w = new EventEmitter();
    w.close = jest.fn().mockResolvedValue();
    w.add = jest.fn();
    w.unwatch = jest.fn();
    process.nextTick(() => w.emit('ready'));
    return w;
  })
}));

const mockPendingWatcherLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  setContext: jest.fn()
};

jest.mock('../src/shared/logger', () => ({
  logger: mockPendingWatcherLogger,
  createLogger: () => mockPendingWatcherLogger
}));

jest.mock('../src/shared/constants', () => ({
  ANALYSIS_SUPPORTED_EXTENSIONS: ['.pdf', '.txt'],
  AI_DEFAULTS: {
    EMBEDDING: { DIMENSION: 768 },
    TEXT: {}
  }
}));

jest.mock('../src/shared/performanceConstants', () => ({
  CHUNKING: { MAX_CHUNK_SIZE: 4000 },
  TIMEOUTS: { AI_ANALYSIS: 60000 },
  LIMITS: { ANALYSIS_QUEUE_SIZE: 5 },
  TEMP_FILE_PATTERNS: [/\.tmp$/],
  isTemporaryFile: jest.fn(() => false),
  RETRY: { MAX_ATTEMPTS_MEDIUM: 3 }
}));

jest.mock('../src/shared/errorClassifier', () => ({
  isNotFoundError: jest.fn((err) => err?.code === 'ENOENT')
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
  generateSuggestedNameFromAnalysis: jest.fn(() => 'suggested-name')
}));

jest.mock('../src/main/services/analysisHistory/indexManager', () => ({
  generateFileHash: jest.fn(() => 'mock-hash')
}));

jest.mock('../src/main/services/confidence/watcherConfidence', () => ({
  deriveWatcherConfidencePercent: jest.fn(() => 85)
}));

jest.mock('../src/main/ipc/analysisUtils', () => ({
  recordAnalysisResult: jest.fn().mockResolvedValue()
}));

jest.mock('../src/main/utils/textChunking', () => ({
  chunkText: jest.fn((text) => [text])
}));

jest.mock('../src/main/analysis/embeddingSummary', () => ({
  buildEmbeddingSummary: jest.fn(() => 'summary')
}));

jest.mock('../src/shared/fileOperationTracker', () => ({
  getInstance: jest.fn(() => ({
    wasRecentlyOperated: jest.fn(() => false),
    markOperation: jest.fn(),
    recordOperation: jest.fn()
  }))
}));

jest.mock('../src/shared/pathSanitization', () => ({
  normalizePathForIndex: jest.fn((p) => p),
  getCanonicalFileId: jest.fn((p) => p.toLowerCase())
}));

jest.mock('../src/shared/fileIdUtils', () => ({
  isImagePath: jest.fn(() => false)
}));

jest.mock('../src/shared/crossPlatformUtils', () => ({
  isUNCPath: jest.fn(() => false)
}));

jest.mock('../src/shared/normalization', () => ({
  normalizeKeywords: jest.fn((kw) => kw)
}));

jest.mock('../src/main/services/organization/learningFeedback', () => ({
  getInstance: jest.fn(() => null),
  FEEDBACK_SOURCES: { WATCHER: 'watcher' }
}));

jest.mock('../src/shared/promiseUtils', () => ({
  withTimeout: jest.fn((promise) => promise),
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
  shouldEmbed: jest.fn(() => true)
}));

jest.mock('../src/main/services/LlamaResilience', () => ({
  resetLlamaCircuit: jest.fn()
}));

jest.mock('../src/main/analysis/semanticFolderMatcher', () => ({
  clearSmartFolderUpsertCache: jest.fn()
}));

jest.mock('../src/main/analysis/embeddingModelOptions', () => ({
  resolveEmbeddingModelOptions: jest.fn().mockResolvedValue({})
}));

const SmartFolderWatcher = require('../src/main/services/SmartFolderWatcher');

function createWatcher() {
  const mockDeps = {
    getSmartFolders: jest.fn(() => [{ id: 'f1', name: 'Docs', path: '/docs' }]),
    analysisHistoryService: {
      getHistory: jest.fn(() => ({ entries: {} })),
      getEntry: jest.fn(() => null),
      setEntry: jest.fn(),
      deleteEntry: jest.fn(),
      getIndex: jest.fn(() => ({ categoryIndex: {}, tagIndex: {} }))
    },
    analyzeDocumentFile: jest.fn().mockResolvedValue({ success: true, result: {} }),
    analyzeImageFile: jest.fn().mockResolvedValue({ success: true, result: {} }),
    settingsService: {
      get: jest.fn(() => true),
      getAll: jest.fn(() => ({})),
      load: jest.fn().mockResolvedValue({})
    },
    vectorDbService: {
      upsert: jest.fn().mockResolvedValue(),
      search: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue()
    },
    filePathCoordinator: null,
    folderMatcher: {
      generateEmbedding: jest.fn().mockResolvedValue({ embedding: new Array(768).fill(0.1) })
    },
    notificationService: {
      notifyFileAnalyzed: jest.fn(),
      // The at-capacity drop path calls notifyWatcherError(...).catch(...),
      // so the mock must model the real promise-returning surface.
      notifyWatcherError: jest.fn().mockResolvedValue(undefined)
    }
  };
  return new SmartFolderWatcher(mockDeps);
}

describe('SmartFolderWatcher pendingAnalysis bounds', () => {
  let watcher;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    watcher = createWatcher();
  });

  afterEach(async () => {
    jest.useRealTimers();
    if (watcher?.isRunning) await watcher.stop();
    if (watcher?.queueTimer) clearInterval(watcher.queueTimer);
  });

  test('drops new file events when pendingAnalysis is at capacity', () => {
    const t = Date.now();
    jest.setSystemTime(t);
    for (let i = 0; i < 5; i++) {
      watcher.pendingAnalysis.set(`/p/${i}.pdf`, {
        mtime: t,
        timeout: null,
        eventType: 'add',
        firstEventAt: t
      });
    }
    expect(watcher.pendingAnalysis.size).toBe(5);

    watcher._handleFileEvent('add', '/p/new.pdf', { mtime: new Date(t) });

    expect(watcher.stats.queueDropped).toBe(1);
    expect(watcher.pendingAnalysis.has('/p/new.pdf')).toBe(false);
  });

  test('still updates an existing pending path when map is full', () => {
    const t = Date.now();
    jest.setSystemTime(t);
    for (let i = 0; i < 5; i++) {
      watcher.pendingAnalysis.set(`/p/${i}.pdf`, {
        mtime: t,
        timeout: null,
        eventType: 'add',
        firstEventAt: t
      });
    }

    watcher._handleFileEvent('change', '/p/2.pdf', { mtime: new Date(t) });

    expect(watcher.stats.queueDropped).toBe(0);
    expect(watcher.pendingAnalysis.has('/p/2.pdf')).toBe(true);
  });

  test('rate-limits drop warnings by QUEUE_DROP_LOG_INTERVAL_MS', () => {
    mockPendingWatcherLogger.warn.mockClear();
    const t = 1_000_000;
    jest.setSystemTime(t);
    for (let i = 0; i < 5; i++) {
      watcher.pendingAnalysis.set(`/p/${i}.pdf`, {
        mtime: t,
        timeout: null,
        eventType: 'add',
        firstEventAt: t
      });
    }

    watcher._handleFileEvent('add', '/drop1.pdf', { mtime: new Date(t) });
    watcher._handleFileEvent('add', '/drop2.pdf', { mtime: new Date(t) });
    expect(mockPendingWatcherLogger.warn).toHaveBeenCalledTimes(1);

    jest.setSystemTime(t + 11_000);
    watcher._handleFileEvent('add', '/drop3.pdf', { mtime: new Date(t) });
    expect(mockPendingWatcherLogger.warn).toHaveBeenCalledTimes(2);
  });
});
