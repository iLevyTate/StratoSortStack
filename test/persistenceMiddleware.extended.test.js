/**
 * Extended persistence middleware coverage tests.
 * Targets: saveWithQuotaHandling degradation paths, fileStates prioritization,
 *          re-entry guard, organized/smart folder change detection,
 *          cleanupPersistence with store, sidebar tracking.
 */

// Use real constants for everything else (FILE_STATES, IPC_CHANNELS,
// IPC_EVENTS, etc.) so production code paths that read from those keys
// don't see undefined. The fileStates-prioritization branch in particular
// compares against FILE_STATES.CATEGORIZED — undefined would silently
// mask broken ordering.
jest.mock('../src/shared/constants', () => ({
  ...jest.requireActual('../src/shared/constants'),
  // Keep the explicit overrides for clarity / test stability:
  PHASES: { WELCOME: 'welcome', DISCOVER: 'discover', ORGANIZE: 'organize' },
  DEFAULT_AI_MODELS: {
    TEXT_ANALYSIS: 'qwen3:0.6b',
    IMAGE_ANALYSIS: 'gemma3:latest',
    EMBEDDING: 'embeddinggemma'
  }
}));

jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

jest.mock('../src/renderer/store/slices/systemSlice', () => ({
  addNotification: jest.fn((data) => ({ type: 'system/addNotification', payload: data }))
}));

describe('persistenceMiddleware extended coverage', () => {
  let persistenceMiddleware;
  let cleanupPersistence;
  let mockStore;
  let mockNext;
  let mockGetState;
  let storageData;

  function createState(overrides = {}) {
    return {
      ui: {
        currentPhase: 'discover',
        showSettings: false,
        sidebarOpen: true,
        ...overrides.ui
      },
      files: {
        selectedFiles: overrides.selectedFiles || [{ path: '/a.pdf' }],
        smartFolders: overrides.smartFolders || [{ id: 'sf1' }],
        organizedFiles: overrides.organizedFiles || [],
        namingConvention: 'original',
        fileStates: overrides.fileStates || {},
        ...overrides.files
      },
      analysis: {
        results: overrides.results || [{ path: '/a.pdf', category: 'test' }],
        isAnalyzing: false,
        analysisProgress: { current: 0, total: 0 },
        currentAnalysisFile: '',
        ...overrides.analysis
      }
    };
  }

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();

    storageData = {};
    const mockLocalStorage = {
      getItem: jest.fn((key) => storageData[key] || null),
      setItem: jest.fn((key, value) => {
        storageData[key] = value;
      }),
      removeItem: jest.fn((key) => {
        delete storageData[key];
      })
    };

    global.window = global.window || {};
    global.window.addEventListener = jest.fn();
    global.window.removeEventListener = jest.fn();
    Object.defineProperty(global, 'localStorage', { value: mockLocalStorage, writable: true });

    const mod = require('../src/renderer/store/middleware/persistenceMiddleware');
    persistenceMiddleware = mod.default;
    cleanupPersistence = mod.cleanupPersistence;

    mockGetState = jest.fn(() => createState());
    mockStore = {
      dispatch: jest.fn(),
      getState: mockGetState
    };
    mockNext = jest.fn((action) => action);
  });

  afterEach(() => {
    jest.useRealTimers();
    if (cleanupPersistence) cleanupPersistence();
  });

  test('saves state when phase changes', () => {
    const handler = persistenceMiddleware(mockStore)(mockNext);

    // First action triggers initial state tracking
    handler({ type: 'ui/setPhase' });

    jest.advanceTimersByTime(1500);

    expect(localStorage.setItem).toHaveBeenCalledWith('stratosort_redux_state', expect.any(String));
  });

  test('tracks organizedFiles count changes', () => {
    let callCount = 0;
    mockGetState.mockImplementation(() => {
      callCount++;
      if (callCount <= 1) return createState({ organizedFiles: [] });
      return createState({ organizedFiles: [{ path: '/a.pdf' }] });
    });

    const handler = persistenceMiddleware(mockStore)(mockNext);

    // First action sets initial tracking values
    handler({ type: 'files/addOrganized' });
    jest.advanceTimersByTime(1500);

    // Second action with changed organizedFiles count should trigger save
    handler({ type: 'files/addOrganized' });
    jest.advanceTimersByTime(1500);

    expect(localStorage.setItem).toHaveBeenCalled();
  });

  test('tracks smartFolders count changes', () => {
    let callCount = 0;
    mockGetState.mockImplementation(() => {
      callCount++;
      if (callCount <= 2) return createState({ smartFolders: [{ id: 'sf1' }] });
      return createState({ smartFolders: [{ id: 'sf1' }, { id: 'sf2' }] });
    });

    const handler = persistenceMiddleware(mockStore)(mockNext);

    handler({ type: 'files/addSmartFolder' });
    jest.advanceTimersByTime(1500);

    handler({ type: 'files/addSmartFolder' });
    jest.advanceTimersByTime(1500);

    expect(localStorage.setItem).toHaveBeenCalled();
  });

  test('tracks sidebarOpen changes', () => {
    let sidebarOpen = true;
    mockGetState.mockImplementation(() =>
      createState({ ui: { currentPhase: 'discover', sidebarOpen } })
    );

    const handler = persistenceMiddleware(mockStore)(mockNext);

    handler({ type: 'ui/toggleSidebar' });
    jest.advanceTimersByTime(1500);

    sidebarOpen = false;
    handler({ type: 'ui/toggleSidebar' });
    jest.advanceTimersByTime(1500);

    expect(localStorage.setItem).toHaveBeenCalled();
  });

  test('skips save when no relevant change detected after initial save', () => {
    // Return the SAME object reference to ensure fileStatesRef comparison works
    const stableState = createState();
    mockGetState.mockReturnValue(stableState);

    const handler = persistenceMiddleware(mockStore)(mockNext);

    // First action triggers initial save (all tracking values are -1/null)
    handler({ type: 'files/addFile' });
    jest.advanceTimersByTime(1500);

    // Confirm initial save happened
    expect(localStorage.setItem).toHaveBeenCalled();
    localStorage.setItem.mockClear();

    // Second action with identical state (same ref) - should skip save
    handler({ type: 'files/addFile' });
    jest.advanceTimersByTime(1500);

    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  test('skips during welcome phase without durable data', () => {
    mockGetState.mockReturnValue(
      createState({
        ui: { currentPhase: 'welcome', sidebarOpen: true },
        organizedFiles: [],
        smartFolders: []
      })
    );

    const handler = persistenceMiddleware(mockStore)(mockNext);
    handler({ type: 'ui/init' });
    jest.advanceTimersByTime(1500);

    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  test('saves during welcome phase when durable data exists', () => {
    mockGetState.mockReturnValue(
      createState({
        ui: { currentPhase: 'welcome', sidebarOpen: true },
        organizedFiles: [{ path: '/organized.pdf' }]
      })
    );

    const handler = persistenceMiddleware(mockStore)(mockNext);
    handler({ type: 'files/addFile' });
    jest.advanceTimersByTime(1500);

    expect(localStorage.setItem).toHaveBeenCalled();
  });

  test('skips setLoading actions', () => {
    const handler = persistenceMiddleware(mockStore)(mockNext);
    handler({ type: 'ui/setLoading' });
    jest.advanceTimersByTime(1500);

    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  describe('saveWithQuotaHandling', () => {
    test('handles QuotaExceededError with reduced save', () => {
      let attempts = 0;
      localStorage.setItem.mockImplementation((key, value) => {
        attempts++;
        if (attempts <= 1) {
          const err = new Error('Quota exceeded');
          err.name = 'QuotaExceededError';
          throw err;
        }
        storageData[key] = value;
      });

      const handler = persistenceMiddleware(mockStore)(mockNext);
      handler({ type: 'files/addFile' });
      jest.advanceTimersByTime(1500);

      expect(localStorage.setItem).toHaveBeenCalledTimes(2);
      // Should dispatch degradation notification
      expect(mockStore.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'system/addNotification',
          payload: expect.objectContaining({ severity: 'warning' })
        })
      );
    });

    test('falls back to minimal state when reduced save fails', () => {
      let attempts = 0;
      localStorage.setItem.mockImplementation((key, value) => {
        attempts++;
        if (attempts <= 2) {
          const err = new Error('Quota exceeded');
          err.name = 'QuotaExceededError';
          throw err;
        }
        storageData[key] = value;
      });

      const handler = persistenceMiddleware(mockStore)(mockNext);
      handler({ type: 'files/addFile' });
      jest.advanceTimersByTime(1500);

      expect(localStorage.setItem).toHaveBeenCalledTimes(3);
    });

    test('falls back to emergency state when minimal save fails', () => {
      let attempts = 0;
      localStorage.setItem.mockImplementation((key, value) => {
        attempts++;
        if (attempts <= 3) {
          const err = new Error('Quota exceeded');
          err.name = 'QuotaExceededError';
          throw err;
        }
        storageData[key] = value;
      });

      const handler = persistenceMiddleware(mockStore)(mockNext);
      handler({ type: 'files/addFile' });
      jest.advanceTimersByTime(1500);

      // Should have attempted: full, reduced, minimal, then emergency (after removeItem)
      expect(localStorage.setItem.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    test('logs a warn breadcrumb when intermediate retry attempts fail', () => {
      // Regression guard: prior to this fix, attempts 1 (reduced) and 2
      // (minimal) used `catch {}` and silently swallowed any non-quota
      // error. SecurityError (storage disabled) and DOMException (private
      // browsing) hitting attempt 1 or 2 would make the user's "settings
      // never persist" symptoms invisible to a postmortem unless attempt
      // 3 also failed. This test asserts both intermediate catches now
      // emit a warn-level breadcrumb with error message + name so a log
      // search for "save failed" reveals the full ladder.
      const { logger } = require('../src/shared/logger');
      logger.warn.mockClear();

      let attempts = 0;
      localStorage.setItem.mockImplementation((key, value) => {
        attempts++;
        // Attempts 1, 2, and 3 all throw quota-exceeded so we exercise the
        // reduced AND minimal catches; attempt 4 (emergency) succeeds.
        if (attempts <= 3) {
          const err = new Error('Quota exceeded');
          err.name = 'QuotaExceededError';
          throw err;
        }
        storageData[key] = value;
      });

      const handler = persistenceMiddleware(mockStore)(mockNext);
      handler({ type: 'files/addFile' });
      jest.advanceTimersByTime(1500);

      const warnMessages = logger.warn.mock.calls.map((c) => c[0]);
      expect(
        warnMessages.some((m) => typeof m === 'string' && m.includes('Reduced-state save failed'))
      ).toBe(true);
      expect(
        warnMessages.some((m) => typeof m === 'string' && m.includes('Minimal-state save failed'))
      ).toBe(true);
    });

    test('restores the previous persisted blob when even the emergency save fails', () => {
      // Regression guard: attempt 3 removeItem()s the live blob BEFORE the
      // emergency setItem. If that final setItem also fails, the previously
      // persisted state must be put back — otherwise the user's last good
      // (if stale) snapshot is destroyed and the next boot starts fresh.
      const previousBlob = JSON.stringify({ _version: 3, _marker: 'previous-good' });
      storageData.stratosort_redux_state = previousBlob;

      // Simulate quota exhaustion where only the already-stored blob fits:
      // every NEW payload throws, restoring the exact previous blob succeeds.
      localStorage.setItem.mockImplementation((key, value) => {
        if (value === previousBlob) {
          storageData[key] = value;
          return;
        }
        const err = new Error('Quota exceeded');
        err.name = 'QuotaExceededError';
        throw err;
      });

      const handler = persistenceMiddleware(mockStore)(mockNext);
      handler({ type: 'files/addFile' });
      jest.advanceTimersByTime(1500);

      expect(storageData.stratosort_redux_state).toBe(previousBlob);
    });
  });

  describe('fileStates prioritization', () => {
    test('prioritizes error and analyzing states over completed', () => {
      const fileStates = {};
      // Create more than 100 entries
      for (let i = 0; i < 110; i++) {
        fileStates[`/file${i}.pdf`] = { state: 'completed' };
      }
      // Add a few priority states
      fileStates['/error.pdf'] = { state: 'error' };
      fileStates['/analyzing.pdf'] = { state: 'analyzing' };
      fileStates['/pending.pdf'] = { state: 'pending' };

      mockGetState.mockReturnValue(createState({ fileStates }));

      const handler = persistenceMiddleware(mockStore)(mockNext);
      handler({ type: 'files/updateState' });
      jest.advanceTimersByTime(1500);

      expect(localStorage.setItem).toHaveBeenCalled();
      const savedData = JSON.parse(localStorage.setItem.mock.calls[0][1]);
      const savedStates = savedData.files.fileStates;

      // Priority states should be present
      expect(savedStates['/error.pdf']).toBeDefined();
      expect(savedStates['/analyzing.pdf']).toBeDefined();
      expect(savedStates['/pending.pdf']).toBeDefined();

      // Total should be <= 100
      expect(Object.keys(savedStates).length).toBeLessThanOrEqual(100);
    });
  });

  describe('force immediate save after MAX_DEBOUNCE_WAIT', () => {
    test('forces save after 5s of debouncing', () => {
      let phase = 'discover';
      let count = 0;
      mockGetState.mockImplementation(() => {
        count++;
        return createState({
          ui: { currentPhase: phase, sidebarOpen: true },
          selectedFiles: Array.from({ length: count }, (_, i) => ({ path: `/f${i}.pdf` }))
        });
      });

      const handler = persistenceMiddleware(mockStore)(mockNext);

      // Rapid-fire actions for 6 seconds
      for (let i = 0; i < 12; i++) {
        handler({ type: 'files/addFile' });
        jest.advanceTimersByTime(500);
      }

      // Should have been saved at least once due to MAX_DEBOUNCE_WAIT
      expect(localStorage.setItem).toHaveBeenCalled();
    });
  });

  describe('cleanupPersistence', () => {
    test('forces final save when store provided and pending data exists', () => {
      const handler = persistenceMiddleware(mockStore)(mockNext);

      // Start a debounced save
      handler({ type: 'files/addFile' });
      // Don't advance timers - pending save exists

      cleanupPersistence(mockStore);

      expect(localStorage.setItem).toHaveBeenCalledWith(
        'stratosort_redux_state',
        expect.any(String)
      );
    });

    test('removes beforeunload handler', () => {
      persistenceMiddleware(mockStore);
      cleanupPersistence();

      expect(global.window.removeEventListener).toHaveBeenCalledWith(
        'beforeunload',
        expect.any(Function)
      );
    });

    test('resets all tracking state', () => {
      const handler = persistenceMiddleware(mockStore)(mockNext);

      handler({ type: 'files/addFile' });
      jest.advanceTimersByTime(1500);

      localStorage.setItem.mockClear();
      cleanupPersistence();

      // After cleanup, same state should trigger a new save
      const handler2 = persistenceMiddleware(mockStore)(mockNext);
      handler2({ type: 'files/addFile' });
      jest.advanceTimersByTime(1500);

      expect(localStorage.setItem).toHaveBeenCalled();
    });
  });

  describe('fileStates reference tracking', () => {
    test('detects fileStates reference change', () => {
      const states1 = { '/a.pdf': { state: 'completed' } };
      const states2 = { '/a.pdf': { state: 'completed' } }; // Same content, different ref

      let callCount = 0;
      mockGetState.mockImplementation(() => {
        callCount++;
        return createState({ fileStates: callCount <= 2 ? states1 : states2 });
      });

      const handler = persistenceMiddleware(mockStore)(mockNext);
      handler({ type: 'files/updateState' });
      jest.advanceTimersByTime(1500);

      localStorage.setItem.mockClear();

      handler({ type: 'files/updateState' });
      jest.advanceTimersByTime(1500);

      // Should trigger save because reference changed even though content is same
      expect(localStorage.setItem).toHaveBeenCalled();
    });
  });
});
