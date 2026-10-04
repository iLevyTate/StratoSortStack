/**
 * @jest-environment node
 *
 * SmartFolderWatcher watcher-options tests.
 *
 * Locks in the chokidar tuning defaults that affect performance:
 *   - `alwaysStat: false` so chokidar does not `fs.stat` every event before
 *     our early-exit filters run.
 *   - `depth` derived from `STRATOSORT_WATCHER_DEPTH` with a `10` default
 *     (matches `_scanDirectory`'s manual-scan reach so live and manual
 *     code paths agree) and a 0-32 clamp.
 */

jest.mock('fs', () => ({
  promises: {
    stat: jest.fn().mockResolvedValue({ isDirectory: () => true }),
    readFile: jest.fn(),
    access: jest.fn().mockResolvedValue(undefined),
    readdir: jest.fn().mockResolvedValue([])
  }
}));

jest.mock('chokidar', () => ({
  watch: jest.fn(() => {
    const EventEmitter = require('events');
    const watcher = new EventEmitter();
    watcher.close = jest.fn().mockResolvedValue();
    watcher.add = jest.fn();
    watcher.unwatch = jest.fn();
    process.nextTick(() => watcher.emit('ready'));
    return watcher;
  })
}));

jest.mock('../src/shared/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  },
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('../src/shared/constants', () => ({
  ANALYSIS_SUPPORTED_EXTENSIONS: ['.pdf', '.docx', '.txt', '.png', '.jpg'],
  AI_DEFAULTS: { EMBEDDING: { DIMENSION: 768 }, TEXT: {} }
}));

jest.mock('../src/shared/performanceConstants', () => ({
  CHUNKING: { MAX_CHUNK_SIZE: 4000 },
  TIMEOUTS: { AI_ANALYSIS: 60000 },
  LIMITS: { ANALYSIS_QUEUE_SIZE: 1000 },
  TEMP_FILE_PATTERNS: [/\.tmp$/],
  isTemporaryFile: jest.fn(() => false),
  RETRY: { MAX_ATTEMPTS_MEDIUM: 3 },
  CONCURRENCY: {}
}));

jest.mock('../src/shared/errorClassifier', () => ({
  isNotFoundError: jest.fn((err) => err?.code === 'ENOENT')
}));

jest.mock('../src/main/errors/FileSystemError', () => ({
  WatcherError: class WatcherError extends Error {}
}));

jest.mock('../src/main/services/autoOrganize/namingUtils', () => ({
  generateSuggestedNameFromAnalysis: jest.fn()
}));

jest.mock('../src/main/services/analysisHistory/indexManager', () => ({
  generateFileHash: jest.fn(() => 'hash')
}));

jest.mock('../src/main/services/confidence/watcherConfidence', () => ({
  deriveWatcherConfidencePercent: jest.fn(() => 80)
}));

jest.mock('../src/main/ipc/analysisUtils', () => ({
  recordAnalysisResult: jest.fn()
}));

jest.mock('../src/main/utils/textChunking', () => ({ chunkText: (t) => [t] }));

jest.mock('../src/main/analysis/embeddingSummary', () => ({
  buildEmbeddingSummary: jest.fn(() => '')
}));

jest.mock('../src/shared/fileOperationTracker', () => ({
  getInstance: jest.fn(() => ({
    wasRecentlyOperated: () => false,
    markOperation: jest.fn(),
    recordOperation: jest.fn()
  }))
}));

jest.mock('../src/shared/pathSanitization', () => ({
  normalizePathForIndex: (p) => p,
  getCanonicalFileId: (p) => p.toLowerCase()
}));

jest.mock('../src/shared/fileIdUtils', () => ({ isImagePath: () => false }));
jest.mock('../src/shared/crossPlatformUtils', () => ({ isUNCPath: () => false }));
jest.mock('../src/shared/normalization', () => ({ normalizeKeywords: (k) => k }));
jest.mock('../src/main/services/organization/learningFeedback', () => ({
  getInstance: jest.fn(() => null),
  FEEDBACK_SOURCES: { WATCHER: 'watcher' }
}));
jest.mock('../src/shared/promiseUtils', () => ({
  withTimeout: (p) => p,
  delay: jest.fn().mockResolvedValue(undefined),
  createBackgroundWorkTracker: jest.fn(() => ({
    track: (p) => p,
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
  shouldEmbed: () => true
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

function buildDeps() {
  return {
    getSmartFolders: jest.fn(() => [{ id: 'f1', name: 'Docs', path: '/docs' }]),
    analysisHistoryService: {
      getHistory: jest.fn(() => ({ entries: {} })),
      getEntry: jest.fn(() => null),
      setEntry: jest.fn(),
      deleteEntry: jest.fn(),
      getIndex: jest.fn(() => ({ categoryIndex: {}, tagIndex: {} })),
      getAnalysisByPath: jest.fn().mockResolvedValue(null),
      getAnalysisByHash: jest.fn().mockResolvedValue(null)
    },
    analyzeDocumentFile: jest.fn().mockResolvedValue({ success: true, result: {} }),
    analyzeImageFile: jest.fn().mockResolvedValue({ success: true, result: {} }),
    settingsService: {
      getSettings: jest.fn(() => ({ maxConcurrentAnalysis: 2 })),
      on: jest.fn()
    },
    vectorDbService: null,
    filePathCoordinator: null,
    folderMatcher: null,
    notificationService: null
  };
}

async function startWatcherWithDepth(depthEnv) {
  const original = process.env.STRATOSORT_WATCHER_DEPTH;
  if (depthEnv === undefined) delete process.env.STRATOSORT_WATCHER_DEPTH;
  else process.env.STRATOSORT_WATCHER_DEPTH = depthEnv;

  // Re-require in an isolated module registry so the constructor re-reads
  // process.env and the chokidar mock sees the fresh call.
  let watchOptions = null;
  await jest.isolateModulesAsync(async () => {
    const chokidar = require('chokidar');
    const SmartFolderWatcher = require('../src/main/services/SmartFolderWatcher');
    const instance = new SmartFolderWatcher(buildDeps());
    await instance.start();
    const call = chokidar.watch.mock.calls[0];
    watchOptions = call ? call[1] : null;
    await instance.stop?.();
  });

  if (original === undefined) delete process.env.STRATOSORT_WATCHER_DEPTH;
  else process.env.STRATOSORT_WATCHER_DEPTH = original;

  return watchOptions;
}

describe('SmartFolderWatcher watcher options', () => {
  it('disables chokidar alwaysStat so fs.stat is deferred', async () => {
    const options = await startWatcherWithDepth(undefined);
    expect(options).not.toBeNull();
    expect(options.alwaysStat).toBe(false);
  });

  it('defaults watcher depth to 10 (matches manual _scanDirectory reach)', async () => {
    const options = await startWatcherWithDepth(undefined);
    expect(options.depth).toBe(10);
  });

  it('honors STRATOSORT_WATCHER_DEPTH within the 0-32 range', async () => {
    const options = await startWatcherWithDepth('12');
    expect(options.depth).toBe(12);
  });

  it('falls back to the default for non-numeric env values', async () => {
    const options = await startWatcherWithDepth('banana');
    expect(options.depth).toBe(10);
  });

  it('falls back to the default for out-of-range values', async () => {
    const options = await startWatcherWithDepth('999');
    expect(options.depth).toBe(10);
  });

  it('allows depth 0 (watch only the top-level folder)', async () => {
    const options = await startWatcherWithDepth('0');
    expect(options.depth).toBe(0);
  });

  describe('ignored patterns', () => {
    const isIgnored = (options, filePath) =>
      options.ignored.some((pattern) =>
        pattern instanceof RegExp ? pattern.test(filePath) : pattern === filePath
      );

    it('still ignores .git directories and their contents', async () => {
      const options = await startWatcherWithDepth(undefined);
      expect(isIgnored(options, '/docs/project/.git')).toBe(true);
      expect(isIgnored(options, '/docs/project/.git/config')).toBe(true);
      expect(isIgnored(options, 'C:\\docs\\project\\.git\\HEAD')).toBe(true);
    });

    it('watches regular files whose names merely contain ".git" (M12)', async () => {
      const options = await startWatcherWithDepth(undefined);
      expect(isIgnored(options, '/docs/report.github-export.csv')).toBe(false);
      expect(isIgnored(options, '/docs/notes.gitlab.md')).toBe(false);
      expect(isIgnored(options, 'C:\\docs\\foo.github.csv')).toBe(false);
    });
  });
});
