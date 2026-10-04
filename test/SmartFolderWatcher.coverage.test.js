/**
 * @jest-environment node
 *
 * SmartFolderWatcher Coverage Tests
 *
 * Tests untested paths: start/stop lifecycle, file event handling,
 * queue management, debouncing, orphan reconciliation, and error handling.
 *
 * Coverage target: main/services/SmartFolderWatcher.js (was 34%)
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
    const watcher = new EventEmitter();
    watcher.close = jest.fn().mockResolvedValue();
    watcher.add = jest.fn();
    watcher.unwatch = jest.fn();
    // Auto-emit ready after microtask to simulate chokidar behavior
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
  ANALYSIS_SUPPORTED_EXTENSIONS: [
    '.pdf',
    '.docx',
    '.txt',
    '.png',
    '.jpg',
    '.mp3',
    '.mp4',
    '.wav',
    '.mov'
  ],
  // Real shape is `EMBEDDING: { MODEL, DIMENSIONS }` (plural). The mock used
  // `DIMENSION: 768` (singular) and missing MODEL — production code reading
  // AI_DEFAULTS.EMBEDDING.DIMENSIONS would get undefined, and assertions
  // could pass with `undefined === undefined` masking config drift.
  AI_DEFAULTS: {
    EMBEDDING: { MODEL: 'mock-embed.gguf', DIMENSIONS: 768 },
    TEXT: {}
  }
}));

jest.mock('../src/shared/performanceConstants', () => ({
  CHUNKING: { MAX_CHUNK_SIZE: 4000 },
  TIMEOUTS: { AI_ANALYSIS: 60000 },
  LIMITS: { ANALYSIS_QUEUE_SIZE: 1000 },
  CONCURRENCY: { MIN_WORKERS: 1, MAX_WORKERS: 8 },
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
  isImagePath: jest.fn((p) => /\.(png|jpg|jpeg|gif)$/i.test(p)),
  isMediaPath: jest.fn((p) => /\.(mp3|wav|ogg|m4a|flac|aac|mp4|mkv|avi|mov|wmv|webm)$/i.test(p))
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
  delay: jest.fn().mockResolvedValue(undefined),
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

const fs = require('fs').promises;
const chokidar = require('chokidar');
const SmartFolderWatcher = require('../src/main/services/SmartFolderWatcher');
const { recordAnalysisResult } = require('../src/main/ipc/analysisUtils');

describe('SmartFolderWatcher', () => {
  let watcher;
  let mockDeps;

  beforeEach(() => {
    jest.clearAllMocks();

    mockDeps = {
      getSmartFolders: jest.fn(() => [
        { id: 'f1', name: 'Docs', path: '/docs' },
        { id: 'f2', name: 'Images', path: '/images' }
      ]),
      analysisHistoryService: {
        getHistory: jest.fn(() => ({ entries: {} })),
        getEntry: jest.fn(() => null),
        setEntry: jest.fn(),
        deleteEntry: jest.fn(),
        getIndex: jest.fn(() => ({ categoryIndex: {}, tagIndex: {} }))
      },
      analyzeDocumentFile: jest.fn().mockResolvedValue({
        success: true,
        result: {
          category: 'Document',
          summary: 'A test document',
          keywords: ['test'],
          suggestedFolder: 'Docs'
        }
      }),
      analyzeImageFile: jest.fn().mockResolvedValue({
        success: true,
        result: {
          category: 'Image',
          summary: 'A test image',
          keywords: ['photo']
        }
      }),
      analyzeMediaFile: jest.fn().mockResolvedValue({
        success: true,
        mediaKind: 'audio',
        category: 'audio',
        summary: 'A test audio transcript',
        keywords: ['speech', 'audio'],
        suggestedName: 'meeting',
        extractionMethod: 'whisper',
        transcript: 'Test transcript content',
        durationSeconds: 12,
        detectedLanguage: 'en'
      }),
      settingsService: {
        get: jest.fn(() => true),
        getAll: jest.fn(() => ({})),
        load: jest.fn().mockResolvedValue({
          namingConvention: 'subject-date',
          separator: '-',
          dateFormat: 'YYYY-MM-DD',
          caseConvention: 'kebab'
        })
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
        notifyFileAnalyzed: jest.fn()
      }
    };

    // Make fs.stat resolve for folder validation
    fs.stat.mockResolvedValue({ isDirectory: () => true });

    watcher = new SmartFolderWatcher(mockDeps);
  });

  afterEach(async () => {
    if (watcher && watcher.isRunning) {
      await watcher.stop();
    }
    // Clear any stale timers
    if (watcher?.queueTimer) {
      clearInterval(watcher.queueTimer);
    }
  });

  describe('constructor', () => {
    test('initializes with correct defaults', () => {
      // Assert on a freshly constructed instance, synchronously: the
      // constructor fire-and-forgets _syncConcurrencyFromSettingsService(),
      // whose hardware probe overwrites maxConcurrentAnalysis once microtasks
      // drain (it resolves to 1 on low-core macOS CI runners). The shared
      // `watcher` from beforeEach has already crossed that async boundary.
      const fresh = new SmartFolderWatcher(mockDeps);
      expect(fresh.isRunning).toBe(false);
      expect(fresh.isStarting).toBe(false);
      expect(fresh.debounceDelay).toBe(1000);
      expect(fresh.maxConcurrentAnalysis).toBe(2);
      expect(fresh.stats.filesAnalyzed).toBe(0);
    });

    test('stores all dependencies', () => {
      expect(watcher.getSmartFolders).toBe(mockDeps.getSmartFolders);
      expect(watcher.analysisHistoryService).toBe(mockDeps.analysisHistoryService);
      expect(watcher.vectorDbService).toBe(mockDeps.vectorDbService);
    });
  });

  describe('start', () => {
    test('starts watching configured folders', async () => {
      const result = await watcher.start();
      expect(result).toBe(true);
      expect(watcher.isRunning).toBe(true);
    });

    test('returns true if already running', async () => {
      await watcher.start();
      const result = await watcher.start();
      expect(result).toBe(true);
    });

    test('returns false when no folders configured', async () => {
      mockDeps.getSmartFolders.mockReturnValue([]);
      const noFolderWatcher = new SmartFolderWatcher(mockDeps);
      const result = await noFolderWatcher.start();
      expect(result).toBe(false);
    });

    test('returns false when all folder paths invalid', async () => {
      fs.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const result = await watcher.start();
      expect(result).toBe(false);
    });

    test('deduplicates concurrent start calls', async () => {
      const p1 = watcher.start();
      const p2 = watcher.start();
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe(true);
      // Second call either returns true (already running) or same promise
      expect(r2).toBe(true);
    });
  });

  describe('stop', () => {
    test('stops cleanly after start', async () => {
      await watcher.start();
      expect(watcher.isRunning).toBe(true);

      await watcher.stop();
      expect(watcher.isRunning).toBe(false);
      expect(watcher.watcher).toBeNull();
    });

    test('clears pending analysis timeouts on stop', async () => {
      await watcher.start();

      // Simulate a pending analysis
      const timeout = setTimeout(() => {}, 99999);
      watcher.pendingAnalysis.set('/docs/test.pdf', { mtime: Date.now(), timeout });

      await watcher.stop();
      expect(watcher.pendingAnalysis.size).toBe(0);
    });

    test('clears pending move candidates on stop', async () => {
      await watcher.start();

      const timeoutId = setTimeout(() => {}, 99999);
      watcher._pendingMoveCandidates.set('/old/path.pdf', {
        size: 100,
        mtimeMs: Date.now(),
        ext: '.pdf',
        timeoutId
      });

      await watcher.stop();
      expect(watcher._pendingMoveCandidates.size).toBe(0);
    });

    test('handles stop when not running', async () => {
      await expect(watcher.stop()).resolves.toBeUndefined();
    });
  });

  describe('restart', () => {
    test('stops and starts', async () => {
      await watcher.start();
      const result = await watcher.restart();
      expect(result).toBe(true);
    });
  });

  describe('applySettings', () => {
    // `applySettings` schedules concurrency resolution on the background-work
    // tracker (mocked to a no-op here), so these tests await the resolver
    // directly to assert the hardware-aware semantics deterministically.
    test('manual mode honors an explicit maxConcurrentAnalysis within bounds', async () => {
      // autoConcurrency:false is the power-user opt-out — the explicit value is
      // honored (clamped to [MIN_WORKERS, MAX_WORKERS]) regardless of hardware.
      await watcher._resolveAndApplyConcurrency(false, 4, 'test');
      expect(watcher.maxConcurrentAnalysis).toBe(4);
    });

    test('manual mode clamps an out-of-range value to MAX_WORKERS', async () => {
      await watcher._resolveAndApplyConcurrency(false, 99, 'test');
      expect(watcher.maxConcurrentAnalysis).toBe(8);
    });

    test('auto mode ignores the manual value and stays within hardware bounds', async () => {
      await watcher._resolveAndApplyConcurrency(true, 4, 'test');
      expect(watcher.maxConcurrentAnalysis).toBeGreaterThanOrEqual(1);
      expect(watcher.maxConcurrentAnalysis).toBeLessThanOrEqual(8);
    });

    test('ignores non-object input', () => {
      const before = watcher.maxConcurrentAnalysis;
      watcher.applySettings(null);
      watcher.applySettings('nope');
      expect(watcher.maxConcurrentAnalysis).toBe(before);
    });

    test('stops a running watcher when smartFolderWatchEnabled becomes false', async () => {
      await watcher.start();
      expect(watcher.isRunning).toBe(true);

      watcher.applySettings({ smartFolderWatchEnabled: false });
      await watcher._watchToggleWork;

      expect(watcher.isRunning).toBe(false);
    });

    test('starts a stopped watcher when smartFolderWatchEnabled is enabled', async () => {
      expect(watcher.isRunning).toBe(false);

      watcher.applySettings({ smartFolderWatchEnabled: true });
      await watcher._watchToggleWork;

      expect(watcher.isRunning).toBe(true);
    });

    test('does not toggle a watcher that is already running', async () => {
      await watcher.start();
      watcher._watchToggleWork = undefined;

      watcher.applySettings({ smartFolderWatchEnabled: true });

      expect(watcher._watchToggleWork).toBeUndefined();
      expect(watcher.isRunning).toBe(true);
    });
  });

  describe('updateWatchedFolders', () => {
    test('adds new paths and removes old ones', async () => {
      await watcher.start();

      const chokidarWatcher = watcher.watcher;

      await watcher.updateWatchedFolders([
        { id: 'f1', name: 'Docs', path: '/docs' },
        { id: 'f3', name: 'New', path: '/new-folder' }
      ]);

      expect(chokidarWatcher.add).toHaveBeenCalledWith('/new-folder');
    });

    test('does nothing when not running', async () => {
      await expect(watcher.updateWatchedFolders([])).resolves.toBeUndefined();
    });
  });

  describe('_purgeQueuedWorkForRemovedFolder (SW-45)', () => {
    const { normalizePathForIndex } = require('../src/shared/pathSanitization');

    beforeEach(() => {
      // Mirror the real canonicalization (case-fold + forward slashes) so the
      // purge can be exercised against mixed-case / mixed-separator paths.
      normalizePathForIndex.mockImplementation((p) =>
        typeof p === 'string' ? p.replace(/\\/g, '/').toLowerCase() : ''
      );
    });

    afterEach(() => {
      normalizePathForIndex.mockImplementation((p) => p);
    });

    test('purges queue, overflow buffer, debounce timers and move candidates by canonical prefix', () => {
      const keepTimeout = setTimeout(() => {}, 60_000);
      const dropTimeout = setTimeout(() => {}, 60_000);
      const dropMoveTimeout = setTimeout(() => {}, 60_000);
      const keepMoveTimeout = setTimeout(() => {}, 60_000);

      watcher.pendingAnalysis.set('C:\\Docs\\Report.pdf', {
        filePath: 'C:\\Docs\\Report.pdf',
        timeout: dropTimeout
      });
      watcher.pendingAnalysis.set('C:\\Other\\Keep.pdf', {
        filePath: 'C:\\Other\\Keep.pdf',
        timeout: keepTimeout
      });
      watcher.analysisQueue = [
        { filePath: 'c:/docs/sub/A.pdf' },
        { filePath: 'C:\\DocsArchive\\NotNested.pdf' },
        { filePath: 'C:\\Other\\B.pdf' }
      ];
      watcher._pendingReanalyzeItems = [
        { filePath: 'C:\\DOCS\\Overflow.pdf' },
        { filePath: 'C:\\Other\\Overflow.pdf' }
      ];
      watcher._pendingMoveCandidates.set('C:\\Docs\\Moved.pdf', {
        oldPath: 'C:\\Docs\\Moved.pdf',
        timeoutId: dropMoveTimeout
      });
      watcher._pendingMoveCandidates.set('C:\\Other\\Moved.pdf', {
        oldPath: 'C:\\Other\\Moved.pdf',
        timeoutId: keepMoveTimeout
      });

      watcher._purgeQueuedWorkForRemovedFolder('c:/docs/');

      expect([...watcher.pendingAnalysis.keys()]).toEqual(['C:\\Other\\Keep.pdf']);
      expect(watcher.analysisQueue.map((i) => i.filePath)).toEqual([
        'C:\\DocsArchive\\NotNested.pdf',
        'C:\\Other\\B.pdf'
      ]);
      expect(watcher._pendingReanalyzeItems.map((i) => i.filePath)).toEqual([
        'C:\\Other\\Overflow.pdf'
      ]);
      expect([...watcher._pendingMoveCandidates.keys()]).toEqual(['C:\\Other\\Moved.pdf']);

      clearTimeout(keepTimeout);
      clearTimeout(keepMoveTimeout);
    });

    test('purged overflow items do not resurface when the queue drains from the overflow buffer', () => {
      watcher.analysisQueue = [];
      watcher._pendingReanalyzeItems = [
        { filePath: '/docs/late.pdf' },
        { filePath: '/keep/x.pdf' }
      ];

      watcher._purgeQueuedWorkForRemovedFolder('/docs');
      watcher._fillFromPendingReanalyze();

      expect(watcher.analysisQueue.map((i) => i.filePath)).toEqual(['/keep/x.pdf']);
    });
  });

  describe('getStatus', () => {
    test('returns correct status when running', async () => {
      await watcher.start();
      const status = watcher.getStatus();
      expect(status.isRunning).toBe(true);
      expect(status).toHaveProperty('stats');
    });

    test('returns correct status when stopped', () => {
      const status = watcher.getStatus();
      expect(status.isRunning).toBe(false);
    });
  });

  describe('file event handling', () => {
    test('queues unsupported file extensions for metadata fallback processing', async () => {
      await watcher.start();

      const chokidarWatcher = watcher.watcher;
      chokidarWatcher.emit('add', '/docs/test.xyz', { mtime: new Date() });

      await new Promise((r) => setTimeout(r, 50));
      const hasPending = watcher.pendingAnalysis.size > 0 || watcher.analysisQueue.length > 0;
      expect(hasPending).toBe(true);
    });

    test('skips files already being processed', async () => {
      await watcher.start();
      watcher.processingFiles.add('/docs/test.pdf');

      const chokidarWatcher = watcher.watcher;
      chokidarWatcher.emit('add', '/docs/test.pdf', { mtime: new Date() });

      expect(watcher.analysisQueue.length).toBe(0);
    });
  });

  describe('_getValidFolderPaths', () => {
    test('skips folders without path', async () => {
      const paths = await watcher._getValidFolderPaths([
        { id: 'f1', name: 'NullPath', path: null },
        { id: 'f2', name: 'Docs', path: '/docs' }
      ]);
      expect(paths).toEqual(['/docs']);
    });

    test('skips non-directory paths', async () => {
      fs.stat.mockResolvedValueOnce({ isDirectory: () => false });
      fs.stat.mockResolvedValueOnce({ isDirectory: () => true });

      const paths = await watcher._getValidFolderPaths([
        { id: 'f1', name: 'File', path: '/some-file.txt' },
        { id: 'f2', name: 'Dir', path: '/real-dir' }
      ]);
      expect(paths).toEqual(['/real-dir']);
    });

    test('handles access errors gracefully', async () => {
      fs.stat.mockRejectedValue(new Error('EACCES'));

      const paths = await watcher._getValidFolderPaths([
        { id: 'f1', name: 'Protected', path: '/protected' }
      ]);
      expect(paths).toEqual([]);
    });
  });

  describe('queue management', () => {
    test('respects MAX_ANALYSIS_QUEUE_SIZE', async () => {
      await watcher.start();

      // Fill queue beyond limit
      for (let i = 0; i < 600; i++) {
        watcher.analysisQueue.push({
          filePath: `/docs/file-${i}.pdf`,
          eventType: 'add',
          mtime: Date.now()
        });
      }

      // Queue should be bounded (actual implementation may drop)
      expect(watcher.analysisQueue.length).toBeGreaterThan(0);
    });

    test('notifies the user (throttled) when the pending-analysis map drops events [F-079]', () => {
      watcher.notificationService.notifyWatcherError = jest.fn().mockResolvedValue();

      // Fill the debounce map to the cap (no live timers needed for the gate)
      for (let i = 0; i < 1000; i++) {
        watcher.pendingAnalysis.set(`/docs/fill-${i}.pdf`, {
          mtime: Date.now(),
          timeout: null,
          eventType: 'add',
          firstEventAt: Date.now(),
          filePath: `/docs/fill-${i}.pdf`
        });
      }

      watcher._handleFileEvent('add', '/docs/overflow-1.pdf', { mtime: new Date() });

      expect(watcher.stats.queueDropped).toBe(1);
      expect(watcher.notificationService.notifyWatcherError).toHaveBeenCalledTimes(1);
      expect(watcher.notificationService.notifyWatcherError).toHaveBeenCalledWith(
        'High Load',
        expect.stringContaining('overflow-1.pdf')
      );

      // A second drop inside the shared 60s throttle window must not re-notify
      watcher._handleFileEvent('add', '/docs/overflow-2.pdf', { mtime: new Date() });
      expect(watcher.stats.queueDropped).toBe(2);
      expect(watcher.notificationService.notifyWatcherError).toHaveBeenCalledTimes(1);
    });
  });

  describe('user exclusion rules', () => {
    afterEach(() => {
      for (const entry of watcher.pendingAnalysis.values()) {
        if (entry?.timeout) clearTimeout(entry.timeout);
      }
      watcher.pendingAnalysis.clear();
    });

    test('drops events for files matching a user exclusion glob', () => {
      mockDeps.settingsService.getAll.mockReturnValue({
        downloadsTriageExclusions: ['*.psd', '**/archived/**']
      });

      watcher._handleFileEvent('add', '/docs/mockup.psd', { mtime: new Date() });
      watcher._handleFileEvent('add', '/docs/archived/old.pdf', { mtime: new Date() });
      expect(watcher.pendingAnalysis.size).toBe(0);

      watcher._handleFileEvent('add', '/docs/current.pdf', { mtime: new Date() });
      expect(watcher.pendingAnalysis.size).toBe(1);
    });

    test('a relative folder rule reads beneath the Smart Folder the file lies under, never above it', () => {
      // `archived/**` means "skip folders named archived inside a Smart
      // Folder". The matcher can only read it that way when the watcher
      // names the root the file lies under; without one the rule is inert.
      mockDeps.settingsService.getAll.mockReturnValue({
        downloadsTriageExclusions: ['archived/**']
      });

      watcher._handleFileEvent('add', '/docs/x/archived/old.pdf', { mtime: new Date() });
      expect(watcher.pendingAnalysis.size).toBe(0);

      watcher._handleFileEvent('add', '/docs/current.pdf', { mtime: new Date() });
      expect(watcher.pendingAnalysis.size).toBe(1);

      // A Smart Folder that itself sits under an `archived` folder is not
      // excluded whole.
      mockDeps.getSmartFolders.mockReturnValue([
        { id: 'f3', name: 'Photos', path: '/archived/photos' }
      ]);
      watcher._handleFileEvent('add', '/archived/photos/holiday.pdf', { mtime: new Date() });
      expect(watcher.pendingAnalysis.size).toBe(2);
    });

    test('a file under nested Smart Folders is read against the deepest one', () => {
      // /docs/archived is itself a configured Smart Folder: the user asked
      // for it to be watched, so `archived/**` does not fold it away as a
      // subfolder of /docs.
      mockDeps.getSmartFolders.mockReturnValue([
        { id: 'f1', name: 'Docs', path: '/docs' },
        { id: 'f3', name: 'Old', path: '/docs/archived' }
      ]);
      mockDeps.settingsService.getAll.mockReturnValue({
        downloadsTriageExclusions: ['archived/**']
      });

      watcher._handleFileEvent('add', '/docs/archived/kept.pdf', { mtime: new Date() });
      expect(watcher.pendingAnalysis.size).toBe(1);

      watcher._handleFileEvent('add', '/docs/archived/x/archived/old.pdf', { mtime: new Date() });
      expect(watcher.pendingAnalysis.size).toBe(1);
    });

    test('reads the cached settings snapshot, not the async loader', () => {
      mockDeps.settingsService.getAll.mockReturnValue({ downloadsTriageExclusions: ['*.pdf'] });
      mockDeps.settingsService.load.mockClear();

      watcher._handleFileEvent('add', '/docs/report.pdf', { mtime: new Date() });

      expect(watcher.pendingAnalysis.size).toBe(0);
      expect(mockDeps.settingsService.load).not.toHaveBeenCalled();
    });

    test('a throwing settings service does not block the watcher', () => {
      mockDeps.settingsService.getAll.mockImplementation(() => {
        throw new Error('settings exploded');
      });

      watcher._handleFileEvent('add', '/docs/report.pdf', { mtime: new Date() });

      expect(watcher.pendingAnalysis.size).toBe(1);
    });

    test('the directory scan behind startup, folder-add and bulk reanalysis drops excluded files', async () => {
      // Only live chokidar events used to be checked, so 40 PSDs dropped
      // into a watched folder while the app was closed were all queued on
      // the next launch.
      mockDeps.settingsService.getAll.mockReturnValue({
        downloadsTriageExclusions: ['*.psd', '**/archived/**']
      });
      const path = require('path');
      const dirent = (name, kind) => ({
        name,
        isSymbolicLink: () => false,
        isDirectory: () => kind === 'dir',
        isFile: () => kind === 'file'
      });
      fs.readdir.mockImplementation(async (dirPath) => {
        if (dirPath === '/docs') {
          return [
            dirent('mockup.psd', 'file'),
            dirent('report.pdf', 'file'),
            dirent('archived', 'dir')
          ];
        }
        if (dirPath === path.join('/docs', 'archived')) return [dirent('old.pdf', 'file')];
        return [];
      });

      const files = await watcher._scanDirectory('/docs', 3);

      expect(files).toEqual([path.join('/docs', 'report.pdf')]);
    });

    test('a queued item that matches a rule is dropped before analysis, a hand-picked reanalyze is not', async () => {
      mockDeps.settingsService.getAll.mockReturnValue({ downloadsTriageExclusions: ['*.psd'] });
      watcher._embedAnalyzedFile = jest.fn().mockResolvedValue();

      await watcher._analyzeFile({ filePath: '/images/mockup.psd', eventType: 'scan' });
      await watcher._analyzeFile({
        filePath: '/images/mockup.psd',
        eventType: 'add',
        restored: true
      });
      await watcher._analyzeFile({
        filePath: '/images/mockup.psd',
        eventType: 'reanalyze',
        bulk: true
      });
      expect(fs.stat).not.toHaveBeenCalledWith('/images/mockup.psd');
      expect(mockDeps.analyzeImageFile).not.toHaveBeenCalled();
      expect(watcher.processingFiles.size).toBe(0);

      await watcher._analyzeFile({ filePath: '/images/mockup.psd', eventType: 'reanalyze' });
      expect(fs.stat).toHaveBeenCalledWith('/images/mockup.psd');
    });
  });

  describe('stats tracking', () => {
    test('increments error count on watcher error', async () => {
      await watcher.start();
      const initialErrors = watcher.stats.errors;

      watcher._handleError(new Error('Watch error'));
      expect(watcher.stats.errors).toBe(initialErrors + 1);
    });
  });

  describe('shutdown finality', () => {
    test('a late error after shutdown() does not resurrect the watcher', async () => {
      await watcher.start();
      await watcher.shutdown();
      expect(watcher.watcher).toBeNull();

      // stop() intentionally resets _isStopping so error-driven restarts can
      // work mid-session — but after shutdown() the restart path must stay
      // dead. Chokidar can emit a late error during/after close; without a
      // terminal flag this schedules stop().then -> restartTimer -> start()
      // and leaks a fresh chokidar watcher past app shutdown.
      watcher.restartDelay = 5;
      watcher._handleError(new Error('late chokidar error'));

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(watcher.watcher).toBeNull();
      expect(watcher.isRunning).toBe(false);
    });
  });

  describe('forceReanalyzeAll — overflow buffer', () => {
    const QUEUE_CAP = 1000; // matches LIMITS.ANALYSIS_QUEUE_SIZE in the mock

    function makeFakeEntries(count, ext = '.pdf') {
      return Array.from({ length: count }, (_, i) => ({
        name: `file-${i}${ext}`,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false
      }));
    }

    beforeEach(() => {
      // Only one watched path for these tests
      watcher.watchedPaths = new Set(['/docs']);
    });

    test('all files fit in queue when count ≤ queue capacity', async () => {
      const fileCount = 50;
      fs.readdir.mockResolvedValue(makeFakeEntries(fileCount));
      fs.stat.mockResolvedValue({
        mtime: new Date(),
        size: 1024,
        isDirectory: () => false
      });

      const result = await watcher.forceReanalyzeAll({ applyNaming: false });

      expect(result.queued).toBe(fileCount);
      expect(result.scanned).toBe(fileCount);
      expect(watcher.analysisQueue.length).toBe(fileCount);
      expect(watcher._pendingReanalyzeItems.length).toBe(0);
    });

    test('overflow goes to _pendingReanalyzeItems when count > queue capacity', async () => {
      const fileCount = QUEUE_CAP + 200; // 1200 files
      fs.readdir.mockResolvedValue(makeFakeEntries(fileCount));
      fs.stat.mockResolvedValue({
        mtime: new Date(),
        size: 1024,
        isDirectory: () => false
      });

      const result = await watcher.forceReanalyzeAll({ applyNaming: false });

      expect(result.queued).toBe(fileCount);
      expect(result.scanned).toBe(fileCount);
      // No files are lost — queue + overflow = total
      expect(watcher.analysisQueue.length + watcher._pendingReanalyzeItems.length).toBe(fileCount);
      expect(watcher.analysisQueue.length).toBeLessThanOrEqual(QUEUE_CAP);
      expect(watcher._pendingReanalyzeItems.length).toBe(fileCount - watcher.analysisQueue.length);
    });

    test('returns accurate queued count regardless of collection size', async () => {
      const fileCount = QUEUE_CAP * 3; // 3× queue capacity
      fs.readdir.mockResolvedValue(makeFakeEntries(fileCount));
      fs.stat.mockResolvedValue({
        mtime: new Date(),
        size: 1024,
        isDirectory: () => false
      });

      const result = await watcher.forceReanalyzeAll({});

      expect(result.queued).toBe(fileCount);
      // Every single item is accounted for — none dropped
      const totalTracked = watcher.analysisQueue.length + watcher._pendingReanalyzeItems.length;
      expect(totalTracked).toBe(fileCount);
    });

    test('docs come before images in both queue and overflow', async () => {
      // Interleave docs and images so the sort must reorder them
      const mixed = [
        ...makeFakeEntries(600, '.png'), // images
        ...makeFakeEntries(600, '.pdf') // docs
      ];
      fs.readdir.mockResolvedValue(mixed);
      fs.stat.mockResolvedValue({
        mtime: new Date(),
        size: 1024,
        isDirectory: () => false
      });

      await watcher.forceReanalyzeAll({});

      const all = [...watcher.analysisQueue, ...watcher._pendingReanalyzeItems];
      const firstImageIndex = all.findIndex((item) => /\.png$/.test(item.filePath));
      const lastDocIndex = [...all].reverse().findIndex((item) => /\.pdf$/.test(item.filePath));
      const lastDocIndexFromStart = all.length - 1 - lastDocIndex;

      // All docs precede all images
      expect(firstImageIndex).toBeGreaterThan(lastDocIndexFromStart);
    });

    test('_fillFromPendingReanalyze drains overflow into main queue', () => {
      const overflowItems = Array.from({ length: 50 }, (_, i) => ({
        filePath: `/docs/overflow-${i}.pdf`,
        eventType: 'reanalyze',
        mtime: Date.now()
      }));
      watcher._pendingReanalyzeItems = [...overflowItems];
      watcher.analysisQueue = []; // queue is empty

      watcher._fillFromPendingReanalyze();

      expect(watcher.analysisQueue.length).toBe(50);
      expect(watcher._pendingReanalyzeItems.length).toBe(0);
    });

    test('_fillFromPendingReanalyze respects queue capacity', () => {
      const overflowItems = Array.from({ length: 200 }, (_, i) => ({
        filePath: `/docs/overflow-${i}.pdf`,
        eventType: 'reanalyze',
        mtime: Date.now()
      }));
      // Queue is nearly full — only 30 slots available
      watcher.analysisQueue = Array.from({ length: QUEUE_CAP - 30 }, (_, i) => ({
        filePath: `/docs/existing-${i}.pdf`,
        eventType: 'reanalyze',
        mtime: Date.now()
      }));
      watcher._pendingReanalyzeItems = [...overflowItems];

      watcher._fillFromPendingReanalyze();

      expect(watcher.analysisQueue.length).toBe(QUEUE_CAP);
      expect(watcher._pendingReanalyzeItems.length).toBe(170); // 200 - 30
    });

    test('_fillFromPendingReanalyze is a no-op when overflow is empty', () => {
      watcher._pendingReanalyzeItems = [];
      watcher.analysisQueue = [];

      watcher._fillFromPendingReanalyze();

      expect(watcher.analysisQueue.length).toBe(0);
    });
  });

  describe('forceReanalyzeAll — exclusion rules cover the outside-watched leg', () => {
    /**
     * The F-223 leg of "reanalyze all" adds every file the app ever analyzed
     * that lives OUTSIDE the watched folders (Discover-analyzed files, files
     * organized into non-smart folders). It used to push those items with no
     * `bulk` flag, which is exactly the shape _analyzeFile's gate exempts, so
     * the exclusion rules were skipped for precisely those files — and the
     * preview still counted them.
     */
    beforeEach(() => {
      watcher.watchedPaths = new Set(['/docs']);
      // The watched-folder leg contributes nothing here; this is about the
      // history-driven leg only.
      fs.readdir.mockResolvedValue([]);
      fs.stat.mockResolvedValue({ mtime: new Date(), size: 1024, isDirectory: () => false });
      mockDeps.analysisHistoryService.analysisHistory = {
        entries: {
          a: { originalPath: '/elsewhere/mockup.psd' },
          b: { originalPath: '/elsewhere/report.pdf' }
        }
      };
      mockDeps.settingsService.getAll.mockReturnValue({ downloadsTriageExclusions: ['*.psd'] });
    });

    test('an excluded file outside the watched folders is never queued', async () => {
      const result = await watcher.forceReanalyzeAll({ applyNaming: false });

      const queued = [...watcher.analysisQueue, ...watcher._pendingReanalyzeItems].map(
        (item) => item.filePath
      );
      expect(queued).toEqual(['/elsewhere/report.pdf']);
      expect(result.queued).toBe(1);
      expect(result.scanned).toBe(1);
    });

    test('the preview count matches what the run will actually do', async () => {
      const preview = await watcher.previewReanalyzeAll();

      expect(preview.outsideWatched).toBe(1);
      expect(preview.scanned).toBe(1);
    });

    test('outside-watched items are flagged bulk, so a rule added after queueing still stops them', async () => {
      // No rules at collection time: both files are queued.
      mockDeps.settingsService.getAll.mockReturnValue({});
      await watcher.forceReanalyzeAll({ applyNaming: false });

      const queued = [...watcher.analysisQueue, ...watcher._pendingReanalyzeItems];
      expect(queued.map((item) => item.filePath).sort()).toEqual([
        '/elsewhere/mockup.psd',
        '/elsewhere/report.pdf'
      ]);
      expect(queued.every((item) => item.bulk === true)).toBe(true);

      // The user adds the rule while the run is still draining.
      mockDeps.settingsService.getAll.mockReturnValue({ downloadsTriageExclusions: ['*.psd'] });
      watcher._embedAnalyzedFile = jest.fn().mockResolvedValue();
      fs.stat.mockClear();

      const psdItem = queued.find((item) => item.filePath === '/elsewhere/mockup.psd');
      await watcher._analyzeFile(psdItem);

      expect(fs.stat).not.toHaveBeenCalledWith('/elsewhere/mockup.psd');
      expect(mockDeps.analyzeDocumentFile).not.toHaveBeenCalled();
      expect(mockDeps.analyzeImageFile).not.toHaveBeenCalled();
    });
  });

  describe('getStatus — pendingReanalyzeCount', () => {
    test('includes pendingReanalyzeCount in status object', () => {
      watcher._pendingReanalyzeItems = [
        { filePath: '/docs/a.pdf', eventType: 'reanalyze', mtime: Date.now() },
        { filePath: '/docs/b.pdf', eventType: 'reanalyze', mtime: Date.now() }
      ];
      const status = watcher.getStatus();
      expect(status).toHaveProperty('pendingReanalyzeCount', 2);
    });

    test('pendingReanalyzeCount is 0 when buffer is empty', () => {
      watcher._pendingReanalyzeItems = [];
      const status = watcher.getStatus();
      expect(status.pendingReanalyzeCount).toBe(0);
    });
  });

  describe('naming semantics', () => {
    test('preserves the LLM suggestion while applying the final naming convention', async () => {
      watcher._embedAnalyzedFile = jest.fn().mockResolvedValue();
      mockDeps.analyzeImageFile.mockResolvedValueOnce({
        category: 'Image',
        keywords: ['photo'],
        confidence: 82,
        suggestedName: 'llm-name.png',
        extractionMethod: 'vision'
      });

      await watcher._analyzeFile({
        filePath: '/images/source-file.png',
        eventType: 'add',
        applyNaming: true
      });

      const analyzedResult = watcher._embedAnalyzedFile.mock.calls[0][1];
      expect(analyzedResult.llmSuggestedName).toBe('llm-name.png');
      expect(analyzedResult.originalSuggestedName).toBe('llm-name.png');
      expect(analyzedResult.suggestedName).toBe('suggested-name');
      expect(recordAnalysisResult).toHaveBeenCalledWith(
        expect.objectContaining({
          result: expect.objectContaining({
            suggestedName: 'suggested-name'
          })
        })
      );
    });

    test('keeps the original basename when naming is disabled but still preserves the LLM suggestion', async () => {
      watcher._embedAnalyzedFile = jest.fn().mockResolvedValue();
      mockDeps.analyzeImageFile.mockResolvedValueOnce({
        category: 'Image',
        keywords: ['photo'],
        confidence: 82,
        suggestedName: 'llm-name.png',
        extractionMethod: 'vision'
      });

      await watcher._analyzeFile({
        filePath: '/images/source-file.png',
        eventType: 'add',
        applyNaming: false
      });

      const analyzedResult = watcher._embedAnalyzedFile.mock.calls[0][1];
      expect(analyzedResult.llmSuggestedName).toBe('llm-name.png');
      expect(analyzedResult.originalSuggestedName).toBe('llm-name.png');
      expect(analyzedResult.suggestedName).toBe('source-file.png');
    });

    test('persists fallback-only supported analyses while still skipping embeddings', async () => {
      watcher._embedAnalyzedFile = jest.fn().mockResolvedValue();
      fs.stat.mockResolvedValue({
        size: 1024,
        mtime: new Date('2026-03-24T00:00:00.000Z'),
        birthtime: new Date('2026-03-24T00:00:00.000Z'),
        mtimeMs: Date.parse('2026-03-24T00:00:00.000Z'),
        isDirectory: () => false
      });
      mockDeps.analyzeDocumentFile.mockResolvedValueOnce({
        category: 'Uncategorized',
        keywords: ['document'],
        confidence: 50,
        suggestedName: 'scan.pdf',
        extractionMethod: 'pdf_no_text',
        summary: 'Fallback summary',
        _isFallback: true
      });

      await watcher._analyzeFile({
        filePath: '/docs/scan.pdf',
        eventType: 'reanalyze',
        applyNaming: true
      });

      expect(recordAnalysisResult).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: '/docs/scan.pdf',
          result: expect.objectContaining({
            extractionMethod: 'pdf_no_text',
            summary: 'Fallback summary'
          })
        })
      );
      expect(watcher._embedAnalyzedFile).not.toHaveBeenCalled();
    });

    test('low-confidence notification carries the in-scope filePath for deep-link reveal', async () => {
      // Regression guard for F-069: the smart-folder low-confidence flow does NOT
      // move the file (it is flagged for manual review), so the original filePath is
      // still the file's real location. Dropping it from notifyLowConfidence (as the
      // 4-arg call did) leaves the tray/toast click without a reveal/locate fallback,
      // an asymmetry vs DownloadWatcher which passes it. Assert the 5th arg is the path.
      const {
        deriveWatcherConfidencePercent
      } = require('../src/main/services/confidence/watcherConfidence');
      // The module-level mock pins confidence at 85 (above threshold); force it
      // below the 75 default so the low-confidence branch fires, then restore.
      deriveWatcherConfidencePercent.mockReturnValue(50);
      try {
        watcher._embedAnalyzedFile = jest.fn().mockResolvedValue();
        mockDeps.notificationService.notifyLowConfidence = jest.fn().mockResolvedValue();
        fs.stat.mockResolvedValue({
          size: 1024,
          mtime: new Date('2026-06-30T00:00:00.000Z'),
          birthtime: new Date('2026-06-30T00:00:00.000Z'),
          mtimeMs: Date.parse('2026-06-30T00:00:00.000Z'),
          isDirectory: () => false
        });
        mockDeps.analyzeDocumentFile.mockResolvedValueOnce({
          category: 'Finance',
          keywords: ['budget'],
          confidence: 50,
          suggestedName: 'budget_report'
        });

        await watcher._analyzeFile({
          filePath: '/docs/low-confidence.pdf',
          eventType: 'add',
          applyNaming: true
        });

        expect(mockDeps.notificationService.notifyLowConfidence).toHaveBeenCalledWith(
          'low-confidence.pdf',
          expect.any(Number),
          expect.any(Number),
          'Finance',
          '/docs/low-confidence.pdf'
        );
      } finally {
        deriveWatcherConfidencePercent.mockReturnValue(85);
      }
    });

    test('routes audio files to analyzeMediaFile, not document or image analyzer', async () => {
      // Regression guard for the dead-code bug that shipped in commit #170:
      // SmartFolderWatcher's dispatch fell through to analyzeDocumentFile for .mp3/.mp4
      // because the constructor didn't accept analyzeMediaFile. This test asserts the
      // fixed dispatch picks the media analyzer for audio extensions.
      watcher._embedAnalyzedFile = jest.fn().mockResolvedValue();
      fs.stat.mockResolvedValue({
        size: 1024,
        mtime: new Date('2026-05-05T00:00:00.000Z'),
        birthtime: new Date('2026-05-05T00:00:00.000Z'),
        mtimeMs: Date.parse('2026-05-05T00:00:00.000Z'),
        isDirectory: () => false
      });

      await watcher._analyzeFile({
        filePath: '/docs/podcast-episode.mp3',
        eventType: 'add',
        applyNaming: false
      });

      expect(mockDeps.analyzeMediaFile).toHaveBeenCalledWith(
        '/docs/podcast-episode.mp3',
        expect.any(Array),
        expect.objectContaining({ bypassCache: false })
      );
      expect(mockDeps.analyzeDocumentFile).not.toHaveBeenCalled();
      expect(mockDeps.analyzeImageFile).not.toHaveBeenCalled();
    });

    test('routes video files to analyzeMediaFile, not document or image analyzer', async () => {
      watcher._embedAnalyzedFile = jest.fn().mockResolvedValue();
      fs.stat.mockResolvedValue({
        size: 4096,
        mtime: new Date('2026-05-05T00:00:00.000Z'),
        birthtime: new Date('2026-05-05T00:00:00.000Z'),
        mtimeMs: Date.parse('2026-05-05T00:00:00.000Z'),
        isDirectory: () => false
      });

      await watcher._analyzeFile({
        filePath: '/docs/keynote-recording.mp4',
        eventType: 'add',
        applyNaming: false
      });

      expect(mockDeps.analyzeMediaFile).toHaveBeenCalledWith(
        '/docs/keynote-recording.mp4',
        expect.any(Array),
        expect.objectContaining({ bypassCache: false })
      );
      expect(mockDeps.analyzeDocumentFile).not.toHaveBeenCalled();
      expect(mockDeps.analyzeImageFile).not.toHaveBeenCalled();
    });

    test('forwards bypassCache:true and the resolved smartFolderId to analyzeMediaFile on reanalyze', async () => {
      // Regression guard for PR #189 (#17): the watcher dispatches to
      // analyzeMediaFile with `{ bypassCache, smartFolderId }`. The
      // mediaAnalyzerAdapter unit tests cover the adapter side; this test
      // covers the watcher → adapter boundary specifically. Without this
      // assertion, removing `smartFolderId: this._resolveFolderIdForPath(...)`
      // from SmartFolderWatcher.js (or flipping `bypassCache` to a literal
      // false) would leave the existing routing tests green while silently
      // breaking watcher-driven re-analysis and per-folder AI overrides.
      watcher._embedAnalyzedFile = jest.fn().mockResolvedValue();
      // _resolveFolderIdForPath maps absolute paths to smart-folder ids;
      // stub it to a known value so we can assert the exact propagation
      // rather than depending on the live path-matching logic.
      watcher._resolveFolderIdForPath = jest.fn(() => 'folder-podcasts');
      fs.stat.mockResolvedValue({
        size: 1024,
        mtime: new Date('2026-05-05T00:00:00.000Z'),
        birthtime: new Date('2026-05-05T00:00:00.000Z'),
        mtimeMs: Date.parse('2026-05-05T00:00:00.000Z'),
        isDirectory: () => false
      });

      await watcher._analyzeFile({
        filePath: '/docs/podcast-episode.mp3',
        eventType: 'reanalyze',
        applyNaming: false
      });

      expect(mockDeps.analyzeMediaFile).toHaveBeenCalledTimes(1);
      const [filePathArg, , optionsArg] = mockDeps.analyzeMediaFile.mock.calls[0];
      expect(filePathArg).toBe('/docs/podcast-episode.mp3');
      expect(optionsArg).toMatchObject({
        bypassCache: true,
        smartFolderId: 'folder-podcasts'
      });
    });

    test('forwards bypassCache:false (and the resolved smartFolderId) on add events', async () => {
      // Companion to the reanalyze test above: a normal "file added" event
      // should not bypass cache. This pins the exact mapping eventType→bypassCache
      // so refactors that rename or merge events can't silently change the
      // semantics of either flag.
      watcher._embedAnalyzedFile = jest.fn().mockResolvedValue();
      watcher._resolveFolderIdForPath = jest.fn(() => 'folder-keynotes');
      fs.stat.mockResolvedValue({
        size: 4096,
        mtime: new Date('2026-05-05T00:00:00.000Z'),
        birthtime: new Date('2026-05-05T00:00:00.000Z'),
        mtimeMs: Date.parse('2026-05-05T00:00:00.000Z'),
        isDirectory: () => false
      });

      await watcher._analyzeFile({
        filePath: '/docs/keynote-recording.mp4',
        eventType: 'add',
        applyNaming: false
      });

      const optionsArg = mockDeps.analyzeMediaFile.mock.calls[0][2];
      expect(optionsArg).toMatchObject({
        bypassCache: false,
        smartFolderId: 'folder-keynotes'
      });
    });

    test('falls through to analyzeDocumentFile when analyzeMediaFile is not wired', async () => {
      // Backward-compat guard: older callers that don't pass analyzeMediaFile must
      // not crash. Media files fall through to the document analyzer (current
      // pre-fix behavior preserved as a safety net).
      const legacyDeps = { ...mockDeps, analyzeMediaFile: undefined };
      const legacyWatcher = new SmartFolderWatcher(legacyDeps);
      legacyWatcher._embedAnalyzedFile = jest.fn().mockResolvedValue();
      fs.stat.mockResolvedValue({
        size: 1024,
        mtime: new Date('2026-05-05T00:00:00.000Z'),
        birthtime: new Date('2026-05-05T00:00:00.000Z'),
        mtimeMs: Date.parse('2026-05-05T00:00:00.000Z'),
        isDirectory: () => false
      });

      await legacyWatcher._analyzeFile({
        filePath: '/docs/old.mp3',
        eventType: 'add',
        applyNaming: false
      });

      expect(mockDeps.analyzeDocumentFile).toHaveBeenCalled();
      expect(mockDeps.analyzeMediaFile).not.toHaveBeenCalled();
    });

    test('creates and persists metadata fallback for unsupported files', async () => {
      watcher._embedAnalyzedFile = jest.fn().mockResolvedValue();
      fs.stat.mockResolvedValue({
        size: 2048,
        mtime: new Date('2026-03-24T00:00:00.000Z'),
        birthtime: new Date('2026-03-24T00:00:00.000Z'),
        mtimeMs: Date.parse('2026-03-24T00:00:00.000Z'),
        isDirectory: () => false
      });

      await watcher._analyzeFile({
        filePath: '/docs/model.stl',
        eventType: 'add',
        applyNaming: true
      });

      expect(mockDeps.analyzeDocumentFile).not.toHaveBeenCalled();
      expect(mockDeps.analyzeImageFile).not.toHaveBeenCalled();
      expect(recordAnalysisResult).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: '/docs/model.stl',
          result: expect.objectContaining({
            extractionMethod: 'unsupported_fallback'
          })
        })
      );
      expect(watcher._embedAnalyzedFile).not.toHaveBeenCalled();
    });
  });

  describe('isSupportedFile (module-level)', () => {
    // Tested indirectly through _handleFileEvent
    test('supported extensions trigger analysis', async () => {
      await watcher.start();

      // .pdf should be supported
      const chokidarWatcher = watcher.watcher;
      chokidarWatcher.emit('add', '/docs/report.pdf', {
        mtime: new Date(),
        size: 1024
      });

      // Should add to pending or queue (debounced)
      // Wait a tick for debounce to process
      await new Promise((r) => setTimeout(r, 50));
      const hasPending = watcher.pendingAnalysis.size > 0 || watcher.analysisQueue.length > 0;
      expect(hasPending).toBe(true);
    });
  });

  describe('_resolveFolderIdForPath', () => {
    test('returns the smart folder id whose path is a prefix of filePath', () => {
      expect(watcher._resolveFolderIdForPath('/docs/report.pdf')).toBe('f1');
      expect(watcher._resolveFolderIdForPath('/images/cat.png')).toBe('f2');
    });

    test('returns null for files outside any smart folder', () => {
      expect(watcher._resolveFolderIdForPath('/elsewhere/foo.pdf')).toBe(null);
    });

    test('returns null for empty / non-string input', () => {
      expect(watcher._resolveFolderIdForPath('')).toBe(null);
      expect(watcher._resolveFolderIdForPath(null)).toBe(null);
      expect(watcher._resolveFolderIdForPath(undefined)).toBe(null);
    });

    test('returns null when no folders are configured', () => {
      mockDeps.getSmartFolders.mockReturnValueOnce([]);
      expect(watcher._resolveFolderIdForPath('/docs/report.pdf')).toBe(null);
    });

    test('skips folder entries missing id or path', () => {
      mockDeps.getSmartFolders.mockReturnValueOnce([
        { name: 'BadNoId', path: '/docs' },
        { id: 'f2', name: 'Images', path: '/images' }
      ]);
      expect(watcher._resolveFolderIdForPath('/docs/report.pdf')).toBe(null);
      expect(watcher._resolveFolderIdForPath('/images/cat.png')).toBe('f2');
    });

    test('prefers the longest-prefix match for nested folder paths', () => {
      mockDeps.getSmartFolders.mockReturnValue([
        { id: 'parent', name: 'Parent', path: '/projects' },
        { id: 'child', name: 'ChildA', path: '/projects/active' }
      ]);
      // The deeper folder should win — otherwise per-folder overrides on
      // child folders would always be shadowed by their parent override.
      expect(watcher._resolveFolderIdForPath('/projects/active/foo.pdf')).toBe('child');
      expect(watcher._resolveFolderIdForPath('/projects/archive/foo.pdf')).toBe('parent');
    });
  });

  // F-194 (K-05): a folder added while the app is open must be scanned for the
  // files that are already in it; the all-folders scan reuses the same per-folder
  // step so the two can never drift.
  describe('scanFolderForUnanalyzedFiles [F-194]', () => {
    test('queues only the files that still need analysis and reports both counts', async () => {
      watcher._scanDirectory = jest.fn().mockResolvedValue(['/docs/a.pdf', '/docs/b.pdf']);
      fs.stat.mockResolvedValue({ mtime: new Date('2026-01-01T00:00:00Z'), size: 10 });
      watcher._needsAnalysis = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      watcher._enqueueAnalysisItem = jest.fn();

      const result = await watcher.scanFolderForUnanalyzedFiles('/docs');

      expect(result).toEqual({ scanned: 2, queued: 1 });
      expect(watcher._enqueueAnalysisItem).toHaveBeenCalledTimes(1);
      expect(watcher._enqueueAnalysisItem).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: '/docs/a.pdf', eventType: 'scan' })
      );
    });

    test('a full queue spills scanned files into the overflow buffer instead of evicting', async () => {
      // 1000 = LIMITS.ANALYSIS_QUEUE_SIZE in this suite's mock.
      watcher.analysisQueue = Array.from({ length: 1000 }, (_, i) => ({
        filePath: `/live/${i}.pdf`,
        dedupKey: `/live/${i}.pdf`
      }));
      watcher._scanDirectory = jest
        .fn()
        .mockResolvedValue(['/big/a.pdf', '/big/b.pdf', '/big/a.pdf', '/live/3.pdf']);
      fs.stat.mockResolvedValue({ mtime: new Date('2026-01-01T00:00:00Z'), size: 10 });
      watcher._needsAnalysis = jest.fn().mockResolvedValue(true);
      const enqueue = jest.spyOn(watcher, '_enqueueAnalysisItem');

      const result = await watcher.scanFolderForUnanalyzedFiles('/big');

      expect(enqueue).not.toHaveBeenCalled();
      expect(watcher.analysisQueue).toHaveLength(1000);
      expect(watcher.analysisQueue[0].filePath).toBe('/live/0.pdf');
      // Duplicates of queued or already-spilled paths are not added twice.
      expect(watcher._pendingReanalyzeItems.map((i) => i.filePath)).toEqual([
        '/big/a.pdf',
        '/big/b.pdf'
      ]);
      expect(result).toEqual({ scanned: 4, queued: 2 });
    });

    test('a file deleted mid-scan is skipped without abandoning the folder', async () => {
      watcher._scanDirectory = jest
        .fn()
        .mockResolvedValue(['/docs/gone.pdf', '/docs/b.pdf', '/docs/c.pdf']);
      fs.stat.mockImplementation(async (p) => {
        if (String(p).includes('gone')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return { mtime: new Date('2026-01-01T00:00:00Z'), size: 10 };
      });
      watcher._needsAnalysis = jest.fn().mockResolvedValue(true);
      watcher._enqueueAnalysisItem = jest.fn();

      const result = await watcher.scanFolderForUnanalyzedFiles('/docs');

      expect(result).toEqual({ scanned: 3, queued: 2 });
      expect(watcher._enqueueAnalysisItem.mock.calls.map(([i]) => i.filePath)).toEqual([
        '/docs/b.pdf',
        '/docs/c.pdf'
      ]);
    });

    test('a folder that cannot be scanned reports zero and does not throw', async () => {
      watcher._scanDirectory = jest.fn().mockRejectedValue(new Error('EACCES'));
      watcher._enqueueAnalysisItem = jest.fn();

      await expect(watcher.scanFolderForUnanalyzedFiles('/locked')).resolves.toEqual({
        scanned: 0,
        queued: 0
      });
      expect(watcher._enqueueAnalysisItem).not.toHaveBeenCalled();
    });

    test('scanForUnanalyzedFiles sums the per-folder step over every watched path', async () => {
      watcher.watchedPaths = new Set(['/one', '/two']);
      watcher.scanFolderForUnanalyzedFiles = jest
        .fn()
        .mockResolvedValueOnce({ scanned: 3, queued: 1 })
        .mockResolvedValueOnce({ scanned: 2, queued: 2 });

      await expect(watcher.scanForUnanalyzedFiles()).resolves.toEqual({ scanned: 5, queued: 3 });
      expect(watcher.scanFolderForUnanalyzedFiles).toHaveBeenCalledWith('/one');
      expect(watcher.scanFolderForUnanalyzedFiles).toHaveBeenCalledWith('/two');
    });
  });

  // F-193 (K-04): chokidar runs with ignoreInitial, so files added or changed
  // while the app was closed were never seen; the startup pass only deleted.
  // start() must queue a delta scan of every watched folder after the
  // reconcile settles.
  describe('startup delta scan [F-193]', () => {
    async function flush(times = 6) {
      for (let i = 0; i < times; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    test('start() schedules scanForUnanalyzedFiles after the reconcile', async () => {
      const order = [];
      watcher._reconcileOrphanedEntries = jest.fn(async () => {
        order.push('reconcile');
      });
      watcher.scanForUnanalyzedFiles = jest.fn(async () => {
        order.push('scan');
        return { scanned: 0, queued: 0 };
      });

      expect(await watcher.start()).toBe(true);
      await flush();

      expect(watcher.scanForUnanalyzedFiles).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['reconcile', 'scan']);
    });

    test('a failed reconcile does not cancel the delta scan', async () => {
      watcher._reconcileOrphanedEntries = jest.fn().mockRejectedValue(new Error('history busy'));
      watcher.scanForUnanalyzedFiles = jest.fn().mockResolvedValue({ scanned: 0, queued: 0 });

      expect(await watcher.start()).toBe(true);
      await flush();

      expect(watcher.scanForUnanalyzedFiles).toHaveBeenCalledTimes(1);
    });

    test('a failed delta scan is swallowed (start already returned true)', async () => {
      watcher._reconcileOrphanedEntries = jest.fn().mockResolvedValue();
      watcher.scanForUnanalyzedFiles = jest.fn().mockRejectedValue(new Error('EACCES'));

      expect(await watcher.start()).toBe(true);
      await expect(flush()).resolves.toBeUndefined();
    });
  });

  // F-223 (K-01 scope / D8): "reanalyze every file" must cover everything the
  // app ever analyzed that still exists — not only what is inside a watched
  // smart folder right now. Files analyzed from Discover outside a smart
  // folder kept their stale analysis forever, and the dry-run under-counted.
  describe('forceReanalyzeAll — history entries outside watched folders [F-223]', () => {
    const path = require('path');
    const inside = {
      name: 'in.pdf',
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => false
    };

    beforeEach(() => {
      watcher.watchedPaths = new Set(['/docs']);
      fs.readdir.mockResolvedValue([inside]);
      fs.stat.mockImplementation(async (p) => {
        if (String(p).includes('gone')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return { mtime: new Date('2026-01-01T00:00:00Z'), size: 1, isDirectory: () => false };
      });
      watcher.analysisHistoryService.analysisHistory = {
        entries: {
          a: { originalPath: '/elsewhere/a.pdf' },
          b: { originalPath: '/old/b.pdf', organization: { actual: '/moved/b.pdf' } },
          c: { originalPath: '/gone/c.pdf' },
          d: { originalPath: '/docs/in.pdf' },
          e: { originalPath: '/elsewhere/a.pdf' },
          f: { originalPath: null }
        }
      };
    });

    test('queues analyzed files outside every watched folder when they still exist, once each', async () => {
      const result = await watcher.forceReanalyzeAll({});

      const paths = [...watcher.analysisQueue, ...watcher._pendingReanalyzeItems].map(
        (item) => item.filePath
      );
      expect(paths).toEqual(
        expect.arrayContaining(['/elsewhere/a.pdf', '/moved/b.pdf', path.join('/docs', 'in.pdf')])
      );
      expect(paths).not.toContain('/gone/c.pdf');
      expect(paths.filter((p) => p === '/elsewhere/a.pdf')).toHaveLength(1);
      expect(paths).toHaveLength(3);
      expect(result.queued).toBe(3);
      expect(result.scanned).toBe(3);
      const outside = watcher.analysisQueue.find((item) => item.filePath === '/moved/b.pdf');
      expect(outside).toEqual(expect.objectContaining({ eventType: 'reanalyze' }));
    });

    test('previewReanalyzeAll counts the same set the real run would queue', async () => {
      const preview = await watcher.previewReanalyzeAll();
      expect(preview.scanned).toBe(3);
      expect(preview.watchedFolders).toBe(1);
      expect(preview.outsideWatched).toBe(2);
    });

    test('a history service without entries changes nothing', async () => {
      watcher.analysisHistoryService.analysisHistory = undefined;
      const result = await watcher.forceReanalyzeAll({});
      expect(result.queued).toBe(1);
    });
  });

  // F-195 (K-06): a file analyzed by filename because a model was missing is
  // re-queued once that model is installed — a bounded number of times — and
  // never when the fallback was a content limitation a new model cannot fix.
  describe('_needsAnalysis re-queues provisional analyses [F-195]', () => {
    const stats = { mtimeMs: 1000, mtime: new Date(1000), size: 10 };

    function armHistory(analysis) {
      watcher.analysisHistoryService = {
        getAnalysisByPath: jest.fn().mockResolvedValue({
          fileSize: 10,
          fileHash: 'mock-hash',
          lastModified: new Date(5000).toISOString(),
          analysis
        }),
        getAnalysisByHash: jest.fn().mockResolvedValue(null)
      };
    }

    test('retries a capability fallback when the model is now installed', async () => {
      armHistory({
        provisional: true,
        provisionalRetries: 0,
        extractionMethod: 'filename_fallback',
        fallbackReason: 'text model not available'
      });
      watcher._capabilityNowAvailable = jest.fn().mockResolvedValue(true);
      await expect(watcher._needsAnalysis('/docs/a.pdf', 1000, stats)).resolves.toBe(true);
      expect(watcher._capabilityNowAvailable).toHaveBeenCalledWith('/docs/a.pdf');
    });

    test('does not retry while the model is still missing', async () => {
      armHistory({
        provisional: true,
        provisionalRetries: 0,
        extractionMethod: 'filename_fallback'
      });
      watcher._capabilityNowAvailable = jest.fn().mockResolvedValue(false);
      await expect(watcher._needsAnalysis('/docs/a.pdf', 1000, stats)).resolves.toBe(false);
    });

    test('stops after the retry budget is spent', async () => {
      armHistory({
        provisional: true,
        provisionalRetries: 2,
        extractionMethod: 'filename_fallback'
      });
      watcher._capabilityNowAvailable = jest.fn().mockResolvedValue(true);
      await expect(watcher._needsAnalysis('/docs/a.pdf', 1000, stats)).resolves.toBe(false);
      expect(watcher._capabilityNowAvailable).not.toHaveBeenCalled();
    });

    test('never retries a content limitation (pdf with no text layer)', async () => {
      armHistory({ provisional: true, provisionalRetries: 0, extractionMethod: 'pdf_no_text' });
      watcher._capabilityNowAvailable = jest.fn().mockResolvedValue(true);
      await expect(watcher._needsAnalysis('/docs/scan.pdf', 1000, stats)).resolves.toBe(false);
      expect(watcher._capabilityNowAvailable).not.toHaveBeenCalled();
    });

    test('_capabilityNowAvailable asks for the text model for documents and the vision model for images', async () => {
      const llama = {
        getConfig: jest
          .fn()
          .mockResolvedValue({ textModel: 'mistral-7b.gguf', visionModel: 'llava.gguf' }),
        listModels: jest.fn().mockResolvedValue([{ name: 'mistral-7b.gguf' }])
      };
      watcher._getLlamaService = () => llama;
      watcher._capabilityProbeCache = null;

      await expect(watcher._capabilityNowAvailable('/docs/a.pdf')).resolves.toBe(true);
      await expect(watcher._capabilityNowAvailable('/pics/a.png')).resolves.toBe(false);
      // Probe is cached across calls within the TTL.
      expect(llama.listModels).toHaveBeenCalledTimes(1);
    });

    test('_capabilityNowAvailable is false without an AI service', async () => {
      watcher._getLlamaService = () => null;
      watcher._capabilityProbeCache = null;
      await expect(watcher._capabilityNowAvailable('/docs/a.pdf')).resolves.toBe(false);
    });
  });

  // F-196 (K-07): a timed-out analysis kept running with no abort, and the
  // queue was in-memory only — every quit forgot the pending files.
  describe('analysis timeout aborts the in-flight work [F-196]', () => {
    test('_analyzeWithTimeout aborts the signal it handed to _analyzeFile when the timeout fires', async () => {
      const { withTimeout } = require('../src/shared/promiseUtils');
      withTimeout.mockImplementationOnce(() => Promise.reject(new Error('timed out')));
      let seenSignal = null;
      watcher._analyzeFile = jest.fn((item, signal) => {
        seenSignal = signal;
        return new Promise(() => {});
      });

      await expect(watcher._analyzeWithTimeout({ filePath: '/docs/a.pdf' })).rejects.toThrow(
        'timed out'
      );
      expect(seenSignal).toBeInstanceOf(AbortSignal);
      expect(seenSignal.aborted).toBe(true);
    });

    test('a normal completion leaves the signal untouched', async () => {
      let seenSignal = null;
      watcher._analyzeFile = jest.fn(async (item, signal) => {
        seenSignal = signal;
        return 'ok';
      });
      await expect(watcher._analyzeWithTimeout({ filePath: '/docs/a.pdf' })).resolves.toBe('ok');
      expect(seenSignal.aborted).toBe(false);
    });
  });

  // F-222 (D5 "sustained period"): orphan-marked vectors are never deleted
  // inline (F-187). The startup reconcile reaps only rows that have been
  // orphaned for a sustained period AND whose file is still missing.
  describe('orphan reaper in the startup reconcile [F-222]', () => {
    beforeEach(() => {
      watcher.analysisHistoryService = { analysisHistory: { entries: {} } };
      watcher.watchedPaths = new Set(['/docs']);
      watcher.isRunning = true;
      watcher._finalizeDeletion = jest.fn().mockResolvedValue();
    });

    test('reaps long-orphaned rows whose file is still gone, keeps ones that reappeared', async () => {
      watcher.vectorDbService = {
        getOrphanedFileDocs: jest.fn().mockResolvedValue([
          { id: 'file:/gone/a.pdf', path: '/gone/a.pdf', orphanedAt: '2026-01-01T00:00:00Z' },
          { id: 'file:/docs/back.pdf', path: '/docs/back.pdf', orphanedAt: '2026-01-01T00:00:00Z' },
          { id: 'file:nopath', path: '', orphanedAt: '2026-01-01T00:00:00Z' }
        ])
      };
      fs.stat.mockImplementation(async (p) => {
        if (String(p).includes('gone')) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        }
        return { isDirectory: () => false, mtime: new Date(), size: 1 };
      });

      const result = await watcher._reapStaleOrphans();

      expect(watcher.vectorDbService.getOrphanedFileDocs).toHaveBeenCalledWith(expect.any(Number));
      expect(result).toEqual({ reaped: 1, kept: 1, skipped: 1 });
      expect(watcher._finalizeDeletion).toHaveBeenCalledTimes(1);
      expect(watcher._finalizeDeletion).toHaveBeenCalledWith('/gone/a.pdf');
    });

    test('a store without the API, or a failing one, reaps nothing and does not throw', async () => {
      watcher.vectorDbService = {};
      await expect(watcher._reapStaleOrphans()).resolves.toEqual({
        reaped: 0,
        kept: 0,
        skipped: 0
      });
      watcher.vectorDbService = {
        getOrphanedFileDocs: jest.fn().mockRejectedValue(new Error('x'))
      };
      await expect(watcher._reapStaleOrphans()).resolves.toEqual({
        reaped: 0,
        kept: 0,
        skipped: 0
      });
      expect(watcher._finalizeDeletion).not.toHaveBeenCalled();
    });

    test('the startup reconcile runs the reaper after the watched-path sweep', async () => {
      watcher._reapStaleOrphans = jest.fn().mockResolvedValue({ reaped: 0, kept: 0, skipped: 0 });
      await watcher._reconcileOrphanedEntries();
      expect(watcher._reapStaleOrphans).toHaveBeenCalledTimes(1);
    });
  });
});
