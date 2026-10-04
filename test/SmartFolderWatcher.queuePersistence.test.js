/**
 * @jest-environment node
 *
 * SmartFolderWatcher queue persistence (K-07)
 *
 * The analysis queue used to live only in memory, so a shutdown mid-reanalysis
 * lost every queued item and `ignoreInitial: true` meant nothing ever found
 * those files again. These tests pin the injected-store contract: enqueue
 * persists, start restores, stop flushes, and no store is a safe no-op.
 *
 * Mock block mirrors test/SmartFolderWatcher.coverage.test.js.
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
  // Mirrors the real implementation closely enough for prefix containment:
  // lowercase (Windows/macOS) with forward slashes. The coverage test's
  // identity stub would make every watched-path check fail on `C:\...` input.
  normalizePathForIndex: jest.fn((p) =>
    typeof p === 'string' ? p.replace(/\\/g, '/').toLowerCase() : ''
  ),
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

// The real WatcherQueueStore is loaded only for its field filter
// (toPersisted); its durable write pulls in securityConfig, which the
// trimmed constants mock above cannot satisfy.
jest.mock('../src/shared/atomicFileOperations', () => ({
  durableWriteJson: jest.fn().mockResolvedValue(undefined)
}));

const fs = require('fs').promises;
const SmartFolderWatcher = require('../src/main/services/SmartFolderWatcher');
const { toPersisted } = require('../src/main/services/watcher/WatcherQueueStore');

describe('SmartFolderWatcher queue persistence (K-07)', () => {
  const WATCH_ROOT = 'C:\\w';
  // A configured smart folder that is NOT mounted this boot, so it never makes
  // it into watchedPaths (_getValidFolderPaths drops paths that fail to stat).
  const UNMOUNTED_ROOT = 'E:\\usb';

  let baseOptions;

  beforeEach(() => {
    jest.clearAllMocks();

    baseOptions = {
      getSmartFolders: jest.fn(() => [{ id: 'f1', name: 'Docs', path: WATCH_ROOT }]),
      analysisHistoryService: {
        getHistory: jest.fn(() => ({ entries: {} })),
        getEntry: jest.fn(() => null),
        setEntry: jest.fn(),
        deleteEntry: jest.fn(),
        getIndex: jest.fn(() => ({ categoryIndex: {}, tagIndex: {} }))
      },
      analyzeDocumentFile: jest.fn().mockResolvedValue({ success: true, result: {} }),
      analyzeImageFile: jest.fn().mockResolvedValue({ success: true, result: {} }),
      analyzeMediaFile: jest.fn().mockResolvedValue({ success: true }),
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
        notifyWatcherError: jest.fn().mockResolvedValue()
      }
    };

    fs.stat.mockResolvedValue({ isDirectory: () => true });
  });

  const makeStore = (initial = []) => {
    const state = { items: initial, saves: [] };
    return {
      state,
      load: jest.fn(async () => state.items),
      save: jest.fn(async (items) => {
        state.saves.push(items.map((i) => i.filePath));
      })
    };
  };

  /**
   * A watcher whose watched roots are bound, mirroring _doStart: it sets
   * watchedPaths in the chokidar ready handler, before _restoreQueue runs.
   * _restoreQueue scopes restored items to those roots.
   */
  const makeWatcher = (queueStore) => {
    const watcher = new SmartFolderWatcher(
      queueStore ? { ...baseOptions, queueStore } : { ...baseOptions }
    );
    watcher.watchedPaths = new Set([WATCH_ROOT]);
    return watcher;
  };

  test('enqueue persists the queue through the injected store', async () => {
    const queueStore = makeStore();
    const watcher = makeWatcher(queueStore);
    watcher._processQueue = jest.fn().mockResolvedValue(undefined);
    watcher._enqueueAnalysisItem({
      filePath: 'C:\\w\\a.txt',
      mtime: 1,
      eventType: 'add',
      queuedAt: 1
    });
    await watcher._flushQueuePersist();
    expect(queueStore.save).toHaveBeenCalled();
    expect(queueStore.state.saves.at(-1)).toEqual(['C:\\w\\a.txt']);
  });

  test('restoreQueue re-enqueues persisted items once', async () => {
    const queueStore = makeStore([
      { filePath: 'C:\\w\\b.txt', mtime: 1, eventType: 'add', queuedAt: 1 }
    ]);
    const watcher = makeWatcher(queueStore);
    watcher._processQueue = jest.fn().mockResolvedValue(undefined);
    const restored = await watcher._restoreQueue();
    expect(restored).toBe(1);
    expect(watcher.analysisQueue.map((i) => i.filePath)).toEqual(['C:\\w\\b.txt']);
    expect(watcher._processQueue).toHaveBeenCalled();
  });

  test('restoreQueue drops items that a rule added since the queue was written now excludes', async () => {
    const queueStore = makeStore([
      { filePath: 'C:\\w\\keep.txt', mtime: 1, eventType: 'add', queuedAt: 1 },
      { filePath: 'C:\\w\\mockup.psd', mtime: 1, eventType: 'add', queuedAt: 1 }
    ]);
    baseOptions.settingsService.getAll.mockReturnValue({ downloadsTriageExclusions: ['*.psd'] });
    const watcher = makeWatcher(queueStore);
    watcher._processQueue = jest.fn().mockResolvedValue(undefined);

    const restored = await watcher._restoreQueue();

    expect(restored).toBe(1);
    expect(watcher.analysisQueue.map((i) => i.filePath)).toEqual(['C:\\w\\keep.txt']);
  });

  test('restoreQueue keeps the hand-picked single-file reanalyze the analysis gate exempts', async () => {
    // _analyzeFile deliberately lets one hand-picked `reanalyze` through the
    // exclusion rules — an explicit user request beats a standing rule. The
    // restore path dropped it anyway, so the request died silently across the
    // very restart it was waiting on. Bulk reanalysis is NOT exempt.
    //
    // The rows go through the real store's field filter, not the verbatim
    // mock: the bulk flag only protects the restart if it survives the trip
    // to disk, and a mock that hands items back unchanged cannot tell.
    const queueStore = makeStore(
      [
        { filePath: 'C:\\w\\picked.psd', mtime: 1, eventType: 'reanalyze', queuedAt: 1 },
        {
          filePath: 'C:\\w\\bulk.psd',
          mtime: 1,
          eventType: 'reanalyze',
          bulk: true,
          queuedAt: 1
        },
        { filePath: 'C:\\w\\live.psd', mtime: 1, eventType: 'add', queuedAt: 1 }
      ].map(toPersisted)
    );
    baseOptions.settingsService.getAll.mockReturnValue({ downloadsTriageExclusions: ['*.psd'] });
    const watcher = makeWatcher(queueStore);
    watcher._processQueue = jest.fn().mockResolvedValue(undefined);

    const restored = await watcher._restoreQueue();

    expect(restored).toBe(1);
    expect(watcher.analysisQueue.map((i) => i.filePath)).toEqual(['C:\\w\\picked.psd']);
  });

  test('works with no store injected', async () => {
    const watcher = new SmartFolderWatcher({ ...baseOptions });
    watcher._processQueue = jest.fn().mockResolvedValue(undefined);
    watcher._enqueueAnalysisItem({
      filePath: 'C:\\w\\c.txt',
      mtime: 1,
      eventType: 'add',
      queuedAt: 1
    });
    await expect(watcher._flushQueuePersist()).resolves.toBeUndefined();
    await expect(watcher._restoreQueue()).resolves.toBe(0);
  });

  test('stop flushes the queue before returning', async () => {
    const queueStore = makeStore();
    const watcher = makeWatcher(queueStore);
    watcher._processQueue = jest.fn().mockResolvedValue(undefined);
    watcher._enqueueAnalysisItem({
      filePath: 'C:\\w\\d.txt',
      mtime: 1,
      eventType: 'add',
      queuedAt: 1
    });
    await watcher.stop();
    expect(queueStore.state.saves.at(-1)).toEqual(['C:\\w\\d.txt']);
  });

  test('a backlog larger than the queue cap spills into the overflow buffer', async () => {
    // Mirrors the mocked LIMITS.ANALYSIS_QUEUE_SIZE above.
    const MAX_ANALYSIS_QUEUE_SIZE = 1000;
    const persisted = Array.from({ length: MAX_ANALYSIS_QUEUE_SIZE + 5 }, (_, i) => ({
      filePath: `C:\\w\\doc-${i}.txt`,
      mtime: 1,
      eventType: 'reanalyze',
      queuedAt: 1
    }));
    const queueStore = makeStore(persisted);
    const watcher = makeWatcher(queueStore);
    watcher._processQueue = jest.fn().mockResolvedValue(undefined);

    const restored = await watcher._restoreQueue();

    expect(restored).toBe(MAX_ANALYSIS_QUEUE_SIZE + 5);
    expect(watcher.analysisQueue).toHaveLength(MAX_ANALYSIS_QUEUE_SIZE);
    expect(watcher._pendingReanalyzeItems).toHaveLength(5);
    // The old path funnelled every item through _enqueueAnalysisItem, whose
    // overflow branch shifts the OLDEST entry — so the head of the backlog was
    // dropped and queueDropped counted every eviction.
    expect(watcher.stats.queueDropped).toBe(0);
    expect(watcher.analysisQueue[0].filePath).toBe('C:\\w\\doc-0.txt');
    expect(watcher._pendingReanalyzeItems.at(-1).filePath).toBe(
      `C:\\w\\doc-${MAX_ANALYSIS_QUEUE_SIZE + 4}.txt`
    );
  });

  test('a persist scheduled after stop never writes an empty queue', async () => {
    const queueStore = makeStore();
    const watcher = makeWatcher(queueStore);
    watcher._processQueue = jest.fn().mockResolvedValue(undefined);
    // Simulate a watcher that reached READY, so _scheduleQueuePersist is live.
    watcher.isRunning = true;
    watcher._enqueueAnalysisItem({
      filePath: 'C:\\w\\e.txt',
      mtime: 1,
      eventType: 'add',
      queuedAt: 1
    });

    await watcher.stop();
    expect(queueStore.save).toHaveBeenCalledTimes(1);
    expect(queueStore.state.saves.at(-1)).toEqual(['C:\\w\\e.txt']);

    // stop() resets _isStopping on the way out, so a _processQueue that blew
    // through the in-flight wait can still land here. isRunning is already
    // false, so the debounce must refuse to arm.
    jest.useFakeTimers();
    try {
      watcher._scheduleQueuePersist();
      expect(watcher._queuePersistTimer).toBeNull();
      jest.advanceTimersByTime(5000);
    } finally {
      jest.useRealTimers();
    }
    await Promise.resolve();

    expect(queueStore.save).toHaveBeenCalledTimes(1);
    expect(queueStore.state.saves.at(-1)).toEqual(['C:\\w\\e.txt']);
  });

  test('overlapping flushes are chained so the last snapshot wins', async () => {
    // First save is slow, second is instant: unchained, the second would
    // finish first and the slower (older) snapshot would land last.
    const state = { saves: [], delays: [30, 0] };
    let call = 0;
    const queueStore = {
      state,
      load: jest.fn(async () => []),
      save: jest.fn(async (items) => {
        const wait = state.delays[call++] ?? 0;
        await new Promise((resolve) => setTimeout(resolve, wait));
        state.saves.push(items.map((i) => i.filePath));
      })
    };

    const watcher = makeWatcher(queueStore);
    watcher._processQueue = jest.fn().mockResolvedValue(undefined);
    watcher._enqueueAnalysisItem({
      filePath: 'C:\\w\\first.txt',
      mtime: 1,
      eventType: 'add',
      queuedAt: 1
    });
    const firstFlush = watcher._flushQueuePersist();

    watcher._enqueueAnalysisItem({
      filePath: 'C:\\w\\second.txt',
      mtime: 1,
      eventType: 'add',
      queuedAt: 2
    });
    const secondFlush = watcher._flushQueuePersist();

    await Promise.all([firstFlush, secondFlush]);

    expect(state.saves).toEqual([['C:\\w\\first.txt'], ['C:\\w\\first.txt', 'C:\\w\\second.txt']]);
  });

  test('the debounce timer actually writes', async () => {
    const queueStore = makeStore();
    const watcher = makeWatcher(queueStore);
    watcher._processQueue = jest.fn().mockResolvedValue(undefined);
    // Enqueue while stopped so no REAL debounce timer is armed — an armed
    // timer would make the _scheduleQueuePersist() below a no-op and the
    // fake-timer advance would have nothing to fire.
    watcher._enqueueAnalysisItem({
      filePath: 'C:\\w\\debounced.txt',
      mtime: 1,
      eventType: 'add',
      queuedAt: 1
    });
    expect(watcher._queuePersistTimer).toBeNull();
    watcher.isRunning = true;

    jest.useFakeTimers();
    try {
      watcher._scheduleQueuePersist();
      expect(queueStore.save).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1100);
    } finally {
      jest.useRealTimers();
    }
    await new Promise((resolve) => setImmediate(resolve));

    expect(queueStore.save).toHaveBeenCalledTimes(1);
    expect(queueStore.state.saves.at(-1)).toEqual(['C:\\w\\debounced.txt']);
  });

  test('a stop→start cycle does not duplicate the overflow backlog', async () => {
    const MAX_ANALYSIS_QUEUE_SIZE = 1000;
    const queueStore = makeStore();
    const watcher = makeWatcher(queueStore);
    watcher._processQueue = jest.fn().mockResolvedValue(undefined);
    watcher.isRunning = true;

    // Fill past the cap the way forceReanalyzeAll does: queue to capacity,
    // remainder into the overflow buffer.
    const all = Array.from({ length: MAX_ANALYSIS_QUEUE_SIZE + 5 }, (_, i) => ({
      filePath: `C:\\w\\doc-${i}.txt`,
      mtime: 1,
      eventType: 'reanalyze',
      queuedAt: 1
    }));
    watcher.analysisQueue = all.slice(0, MAX_ANALYSIS_QUEUE_SIZE);
    watcher._pendingReanalyzeItems = all.slice(MAX_ANALYSIS_QUEUE_SIZE);

    await watcher.stop();
    // stop() must leave BOTH queues empty, or the restore below stacks on top
    // of a backlog that is already in memory.
    expect(watcher.analysisQueue).toHaveLength(0);
    expect(watcher._pendingReanalyzeItems).toHaveLength(0);

    const saved = queueStore.state.saves.at(-1);
    expect(saved).toHaveLength(MAX_ANALYSIS_QUEUE_SIZE + 5);
    queueStore.state.items = saved.map((filePath) => ({
      filePath,
      mtime: 1,
      eventType: 'reanalyze',
      queuedAt: 1
    }));

    // Restart: stop() clears watchedPaths, and _doStart rebinds it in the
    // chokidar ready handler before calling _restoreQueue.
    watcher.watchedPaths = new Set([WATCH_ROOT]);

    const restored = await watcher._restoreQueue();
    expect(restored).toBe(MAX_ANALYSIS_QUEUE_SIZE + 5);

    const paths = [
      ...watcher.analysisQueue.map((i) => i.filePath),
      ...watcher._pendingReanalyzeItems.map((i) => i.filePath)
    ];
    expect(paths).toHaveLength(MAX_ANALYSIS_QUEUE_SIZE + 5);
    expect(new Set(paths).size).toBe(MAX_ANALYSIS_QUEUE_SIZE + 5);

    // Restoring twice is a no-op, not a second copy of the backlog.
    const again = await watcher._restoreQueue();
    expect(again).toBe(0);
    expect(watcher.analysisQueue.length + watcher._pendingReanalyzeItems.length).toBe(
      MAX_ANALYSIS_QUEUE_SIZE + 5
    );
  });

  test('restored items outside every configured folder are discarded', async () => {
    const queueStore = makeStore([
      { filePath: 'C:\\w\\inside.txt', mtime: 1, eventType: 'add', queuedAt: 1 },
      { filePath: 'C:\\elsewhere\\outside.txt', mtime: 1, eventType: 'add', queuedAt: 1 }
    ]);
    const watcher = makeWatcher(queueStore);
    watcher._processQueue = jest.fn().mockResolvedValue(undefined);
    // baseOptions.getSmartFolders configures WATCH_ROOT only.

    const restored = await watcher._restoreQueue();

    expect(restored).toBe(1);
    expect(watcher.analysisQueue.map((i) => i.filePath)).toEqual(['C:\\w\\inside.txt']);
    expect(watcher._pendingReanalyzeItems).toHaveLength(0);
  });

  test('a configured folder that is not currently watched keeps its backlog', async () => {
    const queueStore = makeStore([
      { filePath: 'C:\\w\\mounted.txt', mtime: 1, eventType: 'add', queuedAt: 1 },
      { filePath: 'E:\\usb\\pending.txt', mtime: 1, eventType: 'add', queuedAt: 1 }
    ]);
    const watcher = makeWatcher(queueStore);
    watcher._processQueue = jest.fn().mockResolvedValue(undefined);
    watcher.isRunning = true;
    // Both folders are configured, but the USB drive failed to stat at start
    // so only WATCH_ROOT reached watchedPaths.
    baseOptions.getSmartFolders.mockReturnValue([
      { id: 'f1', name: 'Docs', path: WATCH_ROOT },
      { id: 'f2', name: 'USB', path: UNMOUNTED_ROOT }
    ]);

    const restored = await watcher._restoreQueue();

    // Scoping to watchedPaths would have discarded the USB item here, and the
    // flush below would then have erased it from the file for good.
    expect(restored).toBe(2);
    expect(watcher.analysisQueue.map((i) => i.filePath)).toEqual(['C:\\w\\mounted.txt']);
    // Parked in its own list, NOT the overflow buffer: the drain never sees it,
    // so it can't be dequeued into _analyzeFile, ENOENT, and vanish silently.
    expect(watcher._pendingReanalyzeItems).toHaveLength(0);
    expect(watcher._parkedItems.map((i) => i.filePath)).toEqual(['E:\\usb\\pending.txt']);

    watcher.analysisQueue = [];
    watcher._fillFromPendingReanalyze();
    expect(watcher.analysisQueue).toHaveLength(0);
    expect(watcher._parkedItems.map((i) => i.filePath)).toEqual(['E:\\usb\\pending.txt']);

    // ...and it is still in the durable record.
    await watcher._flushQueuePersist();
    expect(queueStore.state.saves.at(-1)).toEqual(['E:\\usb\\pending.txt']);
  });

  test('forceReanalyzeAll does not wipe the parked backlog', async () => {
    const queueStore = makeStore([
      { filePath: 'E:\\usb\\pending.txt', mtime: 1, eventType: 'add', queuedAt: 1 }
    ]);
    const watcher = makeWatcher(queueStore);
    watcher._processQueue = jest.fn().mockResolvedValue(undefined);
    watcher.isRunning = true;
    baseOptions.getSmartFolders.mockReturnValue([
      { id: 'f1', name: 'Docs', path: WATCH_ROOT },
      { id: 'f2', name: 'USB', path: UNMOUNTED_ROOT }
    ]);

    await watcher._restoreQueue();
    expect(watcher._parkedItems).toHaveLength(1);

    // forceReanalyzeAll resets _pendingReanalyzeItems wholesale. When parked
    // work lived in that buffer this erased it, and the flush below wrote the
    // loss through to disk.
    watcher.watchedPaths = new Set([WATCH_ROOT]);
    watcher._scanDirectory = jest.fn().mockResolvedValue([]);
    await watcher.forceReanalyzeAll();

    expect(watcher._parkedItems.map((i) => i.filePath)).toEqual(['E:\\usb\\pending.txt']);
    await watcher._flushQueuePersist();
    expect(queueStore.state.saves.at(-1)).toEqual(['E:\\usb\\pending.txt']);
  });

  test('remounting a parked folder drains it and kicks processing', async () => {
    const queueStore = makeStore([
      { filePath: 'E:\\usb\\pending.txt', mtime: 1, eventType: 'add', queuedAt: 1 }
    ]);
    const watcher = makeWatcher(queueStore);
    watcher._processQueue = jest.fn().mockResolvedValue(undefined);
    watcher.isRunning = true;
    const configured = [
      { id: 'f1', name: 'Docs', path: WATCH_ROOT },
      { id: 'f2', name: 'USB', path: UNMOUNTED_ROOT }
    ];
    baseOptions.getSmartFolders.mockReturnValue(configured);

    await watcher._restoreQueue();
    expect(watcher._parkedItems).toHaveLength(1);

    // The drive is back, so _getValidFolderPaths now returns both roots.
    watcher.watcher = { add: jest.fn(), unwatch: jest.fn() };
    watcher._getValidFolderPaths = jest.fn().mockResolvedValue([WATCH_ROOT, UNMOUNTED_ROOT]);
    watcher._processQueue.mockClear();

    await watcher.updateWatchedFolders(configured);

    expect(watcher.watchedPaths.has(UNMOUNTED_ROOT)).toBe(true);
    expect(watcher._parkedItems).toHaveLength(0);
    expect(watcher.analysisQueue.map((i) => i.filePath)).toEqual(['E:\\usb\\pending.txt']);
    expect(watcher._processQueue).toHaveBeenCalled();
  });

  test('removing a folder from config purges its parked items; an unmount does not', async () => {
    const queueStore = makeStore([
      { filePath: 'E:\\usb\\pending.txt', mtime: 1, eventType: 'add', queuedAt: 1 }
    ]);
    const watcher = makeWatcher(queueStore);
    watcher._processQueue = jest.fn().mockResolvedValue(undefined);
    watcher.isRunning = true;
    baseOptions.getSmartFolders.mockReturnValue([
      { id: 'f1', name: 'Docs', path: WATCH_ROOT },
      { id: 'f2', name: 'USB', path: UNMOUNTED_ROOT }
    ]);

    await watcher._restoreQueue();
    expect(watcher._parkedItems).toHaveLength(1);

    watcher.watcher = { add: jest.fn(), unwatch: jest.fn() };
    watcher.watchedPaths = new Set([WATCH_ROOT, UNMOUNTED_ROOT]);

    // Still configured, just unavailable — _getValidFolderPaths drops it from
    // the desired set, but the parked backlog must survive.
    watcher._getValidFolderPaths = jest.fn().mockResolvedValue([WATCH_ROOT]);
    await watcher.updateWatchedFolders([
      { id: 'f1', path: WATCH_ROOT },
      { id: 'f2', path: UNMOUNTED_ROOT }
    ]);
    expect(watcher._parkedItems).toHaveLength(1);

    // Now the user actually deletes the smart folder.
    watcher.watchedPaths = new Set([WATCH_ROOT, UNMOUNTED_ROOT]);
    await watcher.updateWatchedFolders([{ id: 'f1', path: WATCH_ROOT }]);
    expect(watcher._parkedItems).toHaveLength(0);
  });

  test('a dequeued item whose file is missing is dropped without any retry', async () => {
    // This is why unmounted-folder items are PARKED rather than allowed to
    // retry-and-give-up: _analyzeFile short-circuits its catch on not-found
    // errors without rethrowing, so _processQueue never calls
    // _handleAnalysisError and the item disappears on its FIRST dequeue — no
    // retryCount, no give-up log, nothing left in either queue to persist.
    const queueStore = makeStore();
    const watcher = makeWatcher(queueStore);
    watcher.isRunning = true;
    watcher._handleAnalysisError = jest.fn();
    fs.stat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    watcher._enqueueAnalysisItem({
      filePath: 'C:\\w\\gone.txt',
      mtime: 1,
      eventType: 'add',
      queuedAt: 1,
      restored: true
    });
    await watcher._processQueue();

    expect(watcher._handleAnalysisError).not.toHaveBeenCalled();
    expect(baseOptions.analyzeDocumentFile).not.toHaveBeenCalled();
    expect(watcher.analysisQueue).toHaveLength(0);
    expect(watcher._pendingReanalyzeItems).toHaveLength(0);
    expect(watcher._inFlightItems.size).toBe(0);
  });

  test('a restored item re-checks _needsAnalysis; a live event does not', async () => {
    const queueStore = makeStore([
      { filePath: 'C:\\w\\restored.txt', mtime: 1, eventType: 'add', queuedAt: 1 }
    ]);
    const watcher = makeWatcher(queueStore);
    watcher._processQueue = jest.fn().mockResolvedValue(undefined);
    await watcher._restoreQueue();

    const restoredItem = watcher.analysisQueue[0];
    expect(restoredItem.restored).toBe(true);

    // Analyzed by Discover between the crash and this restart.
    watcher._needsAnalysis = jest.fn().mockResolvedValue(false);
    await watcher._analyzeFile(restoredItem);
    expect(watcher._needsAnalysis).toHaveBeenCalledTimes(1);
    expect(baseOptions.analyzeDocumentFile).not.toHaveBeenCalled();

    // A live fs event was already gated by _handleFileEvent, so it must not
    // pay for a second history lookup — it goes straight to the analyzer.
    baseOptions.analyzeDocumentFile.mockRejectedValueOnce(new Error('reached analyzer'));
    await expect(
      watcher._analyzeFile({ filePath: 'C:\\w\\live.txt', mtime: 1, eventType: 'add' })
    ).rejects.toThrow('reached analyzer');
    expect(watcher._needsAnalysis).toHaveBeenCalledTimes(1);
  });

  test('in-flight work stays in the persisted snapshot', async () => {
    const queueStore = makeStore();
    const watcher = makeWatcher(queueStore);
    watcher.isRunning = true;

    /** @type {() => void} */
    let release = () => {};
    watcher._analyzeFile = jest.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );

    watcher._enqueueAnalysisItem({
      filePath: 'C:\\w\\inflight.txt',
      mtime: 1,
      eventType: 'add',
      queuedAt: 1
    });

    // _processQueue splices the item out of analysisQueue synchronously before
    // its first await, so the item now belongs to neither queue.
    const processing = watcher._processQueue();
    expect(watcher.analysisQueue).toHaveLength(0);
    expect(watcher._analyzeFile).toHaveBeenCalled();

    await watcher._flushQueuePersist();
    expect(queueStore.state.saves.at(-1)).toEqual(['C:\\w\\inflight.txt']);

    release();
    await processing;

    // Once it completes it leaves the durable record.
    await watcher._flushQueuePersist();
    expect(queueStore.state.saves.at(-1)).toEqual([]);
  });
});
