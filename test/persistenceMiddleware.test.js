/**
 * Tests for Persistence Middleware
 * Tests Redux middleware for state persistence to localStorage
 */

// Mock the logger module
jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

// Mock constants
jest.mock('../src/shared/constants', () => ({
  PHASES: {
    WELCOME: 'welcome',
    SETUP: 'setup',
    DISCOVER: 'discover',
    ORGANIZE: 'organize',
    COMPLETE: 'complete'
  },
  DEFAULT_AI_MODELS: {
    TEXT_ANALYSIS: 'qwen3:0.6b',
    IMAGE_ANALYSIS: 'gemma3:latest',
    EMBEDDING: 'embeddinggemma'
  }
}));

describe('persistenceMiddleware', () => {
  let persistenceMiddleware;
  let cleanupPersistence;
  let cancelPendingPersistence;
  let mockStore;
  let mockNext;
  let mockStorage;
  let mockLocalStorage;

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();

    // Set up localStorage mock before importing module
    mockStorage = {};
    mockLocalStorage = {
      getItem: jest.fn((key) => mockStorage[key] || null),
      setItem: jest.fn((key, value) => {
        mockStorage[key] = value;
      }),
      removeItem: jest.fn((key) => {
        delete mockStorage[key];
      }),
      clear: jest.fn(() => {
        mockStorage = {};
      })
    };

    // Use Object.defineProperty to properly override localStorage
    Object.defineProperty(global, 'localStorage', {
      value: mockLocalStorage,
      writable: true,
      configurable: true
    });

    // Import module fresh each test
    const persistenceModule = require('../src/renderer/store/middleware/persistenceMiddleware');
    persistenceMiddleware = persistenceModule.default;
    cleanupPersistence = persistenceModule.cleanupPersistence;
    cancelPendingPersistence = persistenceModule.cancelPendingPersistence;

    // Default mock state - must include all properties the middleware accesses
    const defaultState = {
      ui: {
        currentPhase: 'discover',
        sidebarOpen: true,
        showSettings: false
      },
      files: {
        selectedFiles: [],
        organizedFiles: [],
        smartFolders: [],
        namingConvention: 'default',
        fileStates: {}
      },
      analysis: {
        results: [],
        isAnalyzing: false,
        analysisProgress: { current: 0, total: 0 },
        currentAnalysisFile: ''
      }
    };

    mockStore = {
      dispatch: jest.fn(),
      getState: jest.fn().mockReturnValue(defaultState)
    };
    mockNext = jest.fn((action) => action);
  });

  afterEach(() => {
    if (cleanupPersistence) {
      cleanupPersistence();
    }
    jest.useRealTimers();
  });

  describe('middleware setup', () => {
    test('returns a function', () => {
      expect(typeof persistenceMiddleware).toBe('function');
    });

    test('returns next middleware in chain', () => {
      const middleware = persistenceMiddleware(mockStore);
      expect(typeof middleware).toBe('function');

      const nextHandler = middleware(mockNext);
      expect(typeof nextHandler).toBe('function');
    });

    test('passes action through the chain', () => {
      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);
      const action = { type: 'TEST_ACTION' };

      const result = nextHandler(action);

      expect(mockNext).toHaveBeenCalledWith(action);
      expect(result).toEqual(action);
    });
  });

  describe('state persistence', () => {
    test('saves state after debounce period', () => {
      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      nextHandler({ type: 'SOME_ACTION' });

      // Before debounce
      expect(mockLocalStorage.setItem).not.toHaveBeenCalled();

      // After debounce
      jest.advanceTimersByTime(1000);

      expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
        'stratosort_redux_state',
        expect.any(String)
      );
    });

    test('does not save in WELCOME phase', () => {
      mockStore.getState.mockReturnValue({
        ui: { currentPhase: 'welcome', sidebarOpen: true, showSettings: false },
        files: {
          selectedFiles: [],
          organizedFiles: [],
          smartFolders: [],
          fileStates: {},
          namingConvention: 'default'
        },
        analysis: {
          results: [],
          isAnalyzing: false,
          analysisProgress: { current: 0, total: 0 },
          currentAnalysisFile: ''
        }
      });

      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      nextHandler({ type: 'SOME_ACTION' });
      jest.advanceTimersByTime(2000);

      expect(mockLocalStorage.setItem).not.toHaveBeenCalled();
    });

    test('does not save on setLoading actions', () => {
      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      nextHandler({ type: 'ui/setLoading' });
      jest.advanceTimersByTime(2000);

      expect(mockLocalStorage.setItem).not.toHaveBeenCalled();
    });

    test('debounces multiple rapid actions', () => {
      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      nextHandler({ type: 'ACTION_1' });
      jest.advanceTimersByTime(500);
      nextHandler({ type: 'ACTION_2' });
      jest.advanceTimersByTime(500);
      nextHandler({ type: 'ACTION_3' });
      jest.advanceTimersByTime(1000);

      // Should only save once after final debounce
      expect(mockLocalStorage.setItem).toHaveBeenCalledTimes(1);
    });
  });

  describe('change detection', () => {
    test('skips save when state has not changed', () => {
      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      // First action triggers save
      nextHandler({ type: 'ACTION_1' });
      jest.advanceTimersByTime(1000);
      expect(mockLocalStorage.setItem).toHaveBeenCalledTimes(1);

      // Second action with same state should not trigger save
      nextHandler({ type: 'ACTION_2' });
      jest.advanceTimersByTime(1000);
      expect(mockLocalStorage.setItem).toHaveBeenCalledTimes(1);
    });

    test('saves when phase changes', () => {
      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      nextHandler({ type: 'ACTION_1' });
      jest.advanceTimersByTime(1000);
      mockLocalStorage.setItem.mockClear();

      // Change phase
      mockStore.getState.mockReturnValue({
        ui: { currentPhase: 'organize', sidebarOpen: true, showSettings: false },
        files: {
          selectedFiles: [],
          organizedFiles: [],
          smartFolders: [],
          fileStates: {},
          namingConvention: 'default'
        },
        analysis: {
          results: [],
          isAnalyzing: false,
          analysisProgress: { current: 0, total: 0 },
          currentAnalysisFile: ''
        }
      });

      nextHandler({ type: 'ACTION_2' });
      jest.advanceTimersByTime(1000);

      expect(mockLocalStorage.setItem).toHaveBeenCalled();
    });

    test('saves when files count changes', () => {
      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      nextHandler({ type: 'ACTION_1' });
      jest.advanceTimersByTime(1000);
      mockLocalStorage.setItem.mockClear();

      // Add files
      mockStore.getState.mockReturnValue({
        ui: { currentPhase: 'discover', sidebarOpen: true, showSettings: false },
        files: {
          selectedFiles: [{ path: '/file.txt' }],
          organizedFiles: [],
          smartFolders: [],
          fileStates: {},
          namingConvention: 'default'
        },
        analysis: {
          results: [],
          isAnalyzing: false,
          analysisProgress: { current: 0, total: 0 },
          currentAnalysisFile: ''
        }
      });

      nextHandler({ type: 'ACTION_2' });
      jest.advanceTimersByTime(1000);

      expect(mockLocalStorage.setItem).toHaveBeenCalled();
    });
  });

  describe('viewMode persistence', () => {
    test('includes viewMode in the saved snapshot', () => {
      mockStore.getState.mockReturnValue({
        ui: {
          currentPhase: 'discover',
          sidebarOpen: true,
          showSettings: false,
          viewMode: 'dashboard'
        },
        files: {
          selectedFiles: [],
          organizedFiles: [],
          smartFolders: [],
          fileStates: {},
          namingConvention: 'default'
        },
        analysis: {
          results: [],
          isAnalyzing: false,
          analysisProgress: { current: 0, total: 0 },
          currentAnalysisFile: ''
        }
      });

      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      nextHandler({ type: 'ui/setViewMode' });
      jest.advanceTimersByTime(1000);

      const savedData = JSON.parse(mockLocalStorage.setItem.mock.calls[0][1]);
      expect(savedData.ui.viewMode).toBe('dashboard');
    });

    test('normalizes an unknown viewMode to phased in the snapshot', () => {
      mockStore.getState.mockReturnValue({
        ui: {
          currentPhase: 'discover',
          sidebarOpen: true,
          showSettings: false,
          viewMode: 'grid'
        },
        files: {
          selectedFiles: [],
          organizedFiles: [],
          smartFolders: [],
          fileStates: {},
          namingConvention: 'default'
        },
        analysis: {
          results: [],
          isAnalyzing: false,
          analysisProgress: { current: 0, total: 0 },
          currentAnalysisFile: ''
        }
      });

      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      nextHandler({ type: 'ACTION' });
      jest.advanceTimersByTime(1000);

      const savedData = JSON.parse(mockLocalStorage.setItem.mock.calls[0][1]);
      expect(savedData.ui.viewMode).toBe('phased');
    });

    test('persists the first-run view-mode choice on welcome even with no durable data', () => {
      // Welcome + no smart folders/organized files normally short-circuits the
      // save (see "does not save in WELCOME phase"); the setViewMode exception
      // must let the first-run choice through so it survives a reload.
      mockStore.getState.mockReturnValue({
        ui: {
          currentPhase: 'welcome',
          sidebarOpen: true,
          showSettings: false,
          viewMode: 'dashboard'
        },
        files: {
          selectedFiles: [],
          organizedFiles: [],
          smartFolders: [],
          fileStates: {},
          namingConvention: 'default'
        },
        analysis: {
          results: [],
          isAnalyzing: false,
          analysisProgress: { current: 0, total: 0 },
          currentAnalysisFile: ''
        }
      });

      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      nextHandler({ type: 'ui/setViewMode' });
      jest.advanceTimersByTime(1000);

      expect(mockLocalStorage.setItem).toHaveBeenCalled();
      const savedData = JSON.parse(mockLocalStorage.setItem.mock.calls[0][1]);
      expect(savedData.ui.viewMode).toBe('dashboard');
    });
  });

  describe('selectedTheme persistence', () => {
    test('includes selectedTheme in the saved snapshot', () => {
      mockStore.getState.mockReturnValue({
        ui: {
          currentPhase: 'discover',
          sidebarOpen: true,
          showSettings: false,
          selectedTheme: 'dark'
        },
        files: {
          selectedFiles: [],
          organizedFiles: [],
          smartFolders: [],
          fileStates: {},
          namingConvention: 'default'
        },
        analysis: {
          results: [],
          isAnalyzing: false,
          analysisProgress: { current: 0, total: 0 },
          currentAnalysisFile: ''
        }
      });

      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      nextHandler({ type: 'ui/setSelectedTheme' });
      jest.advanceTimersByTime(1000);

      const savedData = JSON.parse(mockLocalStorage.setItem.mock.calls[0][1]);
      expect(savedData.ui.selectedTheme).toBe('dark');
    });

    test('normalizes an unknown theme to primary in the snapshot', () => {
      mockStore.getState.mockReturnValue({
        ui: {
          currentPhase: 'discover',
          sidebarOpen: true,
          showSettings: false,
          selectedTheme: 'solarized'
        },
        files: {
          selectedFiles: [],
          organizedFiles: [],
          smartFolders: [],
          fileStates: {},
          namingConvention: 'default'
        },
        analysis: {
          results: [],
          isAnalyzing: false,
          analysisProgress: { current: 0, total: 0 },
          currentAnalysisFile: ''
        }
      });

      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      nextHandler({ type: 'ACTION' });
      jest.advanceTimersByTime(1000);

      const savedData = JSON.parse(mockLocalStorage.setItem.mock.calls[0][1]);
      expect(savedData.ui.selectedTheme).toBe('primary');
    });

    test('persists a theme choice on welcome even with no durable data', () => {
      mockStore.getState.mockReturnValue({
        ui: {
          currentPhase: 'welcome',
          sidebarOpen: true,
          showSettings: false,
          selectedTheme: 'light'
        },
        files: {
          selectedFiles: [],
          organizedFiles: [],
          smartFolders: [],
          fileStates: {},
          namingConvention: 'default'
        },
        analysis: {
          results: [],
          isAnalyzing: false,
          analysisProgress: { current: 0, total: 0 },
          currentAnalysisFile: ''
        }
      });

      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      nextHandler({ type: 'ui/setSelectedTheme' });
      jest.advanceTimersByTime(1000);

      expect(mockLocalStorage.setItem).toHaveBeenCalled();
      const savedData = JSON.parse(mockLocalStorage.setItem.mock.calls[0][1]);
      expect(savedData.ui.selectedTheme).toBe('light');
    });
  });

  describe('ui.settings change detection', () => {
    test('persists a settings-only change such as workflowRestoreMaxAge', () => {
      const files = {
        selectedFiles: [],
        organizedFiles: [],
        smartFolders: [],
        fileStates: {},
        namingConvention: 'default'
      };
      const analysis = {
        results: [],
        isAnalyzing: false,
        analysisProgress: { current: 0, total: 0 },
        currentAnalysisFile: ''
      };
      mockStore.getState.mockReturnValue({
        ui: {
          currentPhase: 'discover',
          sidebarOpen: true,
          showSettings: false,
          selectedTheme: 'primary',
          settings: { workflowRestoreMaxAge: 1 }
        },
        files,
        analysis
      });

      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);
      nextHandler({ type: 'ui/updateSettings' });
      jest.advanceTimersByTime(1000);
      mockLocalStorage.setItem.mockClear();

      mockStore.getState.mockReturnValue({
        ui: {
          currentPhase: 'discover',
          sidebarOpen: true,
          showSettings: false,
          selectedTheme: 'primary',
          settings: { workflowRestoreMaxAge: 99 }
        },
        files,
        analysis
      });
      nextHandler({ type: 'ui/updateSettings' });
      jest.advanceTimersByTime(1000);

      expect(mockLocalStorage.setItem).toHaveBeenCalled();
      const savedData = JSON.parse(mockLocalStorage.setItem.mock.calls[0][1]);
      expect(savedData.ui.settings.workflowRestoreMaxAge).toBe(99);
    });
  });

  describe('quota handling', () => {
    test('handles QuotaExceededError gracefully', () => {
      let callCount = 0;
      mockLocalStorage.setItem.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          const error = new Error('Quota exceeded');
          error.name = 'QuotaExceededError';
          throw error;
        }
        // Subsequent calls succeed
      });

      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      expect(() => {
        nextHandler({ type: 'ACTION_1' });
        jest.advanceTimersByTime(1000);
      }).not.toThrow();
    });

    test('attempts reduced state save on quota error', () => {
      let callCount = 0;
      mockLocalStorage.setItem.mockImplementation(() => {
        callCount++;
        if (callCount <= 1) {
          const error = new Error('Quota exceeded');
          error.name = 'QuotaExceededError';
          throw error;
        }
      });

      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      nextHandler({ type: 'ACTION_1' });
      jest.advanceTimersByTime(1000);

      // Should have attempted multiple times
      expect(mockLocalStorage.setItem.mock.calls.length).toBeGreaterThan(1);
    });

    test('dispatches degradation notification when state is pre-truncated for size', () => {
      const oversizedPath = `/huge/${'x'.repeat(2_200_000)}.txt`;
      mockStore.getState.mockReturnValue({
        ui: { currentPhase: 'discover', sidebarOpen: true, showSettings: false },
        files: {
          selectedFiles: [{ path: oversizedPath }],
          organizedFiles: [],
          smartFolders: [],
          namingConvention: 'default',
          fileStates: {}
        },
        analysis: {
          results: [],
          isAnalyzing: false,
          analysisProgress: { current: 0, total: 0 },
          currentAnalysisFile: ''
        }
      });

      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      nextHandler({ type: 'ACTION_1' });
      jest.advanceTimersByTime(1000);

      expect(mockStore.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: expect.stringContaining('addNotification'),
          payload: expect.objectContaining({
            severity: 'warning'
          })
        })
      );
    });
  });

  describe('cleanupPersistence', () => {
    test('clears pending save timeout', () => {
      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      nextHandler({ type: 'ACTION_1' });

      // Don't advance time - timeout still pending
      cleanupPersistence();

      // Now advance time
      jest.advanceTimersByTime(2000);

      // Save should not have happened
      expect(mockLocalStorage.setItem).not.toHaveBeenCalled();
    });

    test('resets tracking variables', () => {
      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      // Trigger initial save
      nextHandler({ type: 'ACTION_1' });
      jest.advanceTimersByTime(1000);
      mockLocalStorage.setItem.mockClear();

      // Cleanup and reinitialize
      cleanupPersistence();

      // Same state should now trigger save since tracking is reset
      nextHandler({ type: 'ACTION_2' });
      jest.advanceTimersByTime(1000);

      expect(mockLocalStorage.setItem).toHaveBeenCalled();
    });
  });

  describe('cancelPendingPersistence', () => {
    test('is exported as a function', () => {
      expect(typeof cancelPendingPersistence).toBe('function');
    });

    test('drops a pending debounced save without flushing it', () => {
      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      // A durable action schedules a debounced save.
      nextHandler({ type: 'SOME_ACTION' });

      // "Start over" cancels the pending writer before it fires.
      cancelPendingPersistence();

      // Even across the full max-wait window nothing is written: a cancelled
      // writer must not resurrect state that "Start over" just cleared. Unlike
      // cleanupPersistence(store), this never force-saves.
      jest.advanceTimersByTime(5000);
      expect(mockLocalStorage.setItem).not.toHaveBeenCalled();
    });

    test('preserves the beforeunload handler so autosave survives Start over', () => {
      const removeSpy = jest.spyOn(window, 'removeEventListener');

      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);
      nextHandler({ type: 'SOME_ACTION' });

      cancelPendingPersistence();

      // Unlike cleanupPersistence, it must NOT remove the unload flush — the
      // window is still open after Start over.
      expect(removeSpy).not.toHaveBeenCalledWith('beforeunload', expect.any(Function));

      // Trackers were reset, so a later change still schedules and saves.
      nextHandler({ type: 'SOME_ACTION' });
      jest.advanceTimersByTime(1000);
      expect(mockLocalStorage.setItem).toHaveBeenCalled();

      removeSpy.mockRestore();
    });
  });

  describe('max debounce wait', () => {
    test('forces save after max wait time', () => {
      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      // First, trigger an initial save to set lastSaveAttempt
      nextHandler({ type: 'INITIAL_ACTION' });
      jest.advanceTimersByTime(1000);
      expect(mockLocalStorage.setItem).toHaveBeenCalledTimes(1);
      mockLocalStorage.setItem.mockClear();

      // Now trigger many rapid actions that keep resetting the debounce
      // MAX_DEBOUNCE_WAIT_MS is 5000ms, so after 5 seconds of debouncing, it should force save
      for (let i = 0; i < 10; i++) {
        mockStore.getState.mockReturnValue({
          ui: { currentPhase: 'discover', sidebarOpen: true, showSettings: false },
          files: {
            selectedFiles: Array(i + 1).fill({}),
            organizedFiles: [],
            smartFolders: [],
            fileStates: {},
            namingConvention: 'default'
          },
          analysis: {
            results: [],
            isAnalyzing: false,
            analysisProgress: { current: 0, total: 0 },
            currentAnalysisFile: ''
          }
        });
        nextHandler({ type: `ACTION_${i}` });
        jest.advanceTimersByTime(600);
      }

      // Should have saved at least once due to max wait (6000ms > MAX_DEBOUNCE_WAIT_MS of 5000ms)
      expect(mockLocalStorage.setItem).toHaveBeenCalled();
    });

    // F-057: the forced "immediate" save once the 5s ceiling is exceeded must run
    // SYNCHRONOUSLY, not via a clearable 0ms timer. A sustained back-to-back
    // synchronous dispatch burst keeps calling clearTimeout before the event loop
    // can run a 0ms macrotask, so the old code never fired the forced save and the
    // ceiling was starved. Here we advance the virtual wall clock past the ceiling
    // WITHOUT advancing jest timers — under the old code setItem is never called.
    test('forces a synchronous save when the 5s ceiling is exceeded mid-burst (timers never advanced)', () => {
      let virtualNow = 1_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => virtualNow);

      // Fresh selectedFiles ref each dispatch so change-detection always fires.
      const stateAt = (n) => ({
        ui: { currentPhase: 'discover', sidebarOpen: true, showSettings: false },
        files: {
          selectedFiles: Array(n + 1).fill({}),
          organizedFiles: [],
          smartFolders: [],
          fileStates: {},
          namingConvention: 'default'
        },
        analysis: {
          results: [],
          isAnalyzing: false,
          analysisProgress: { current: 0, total: 0 },
          currentAnalysisFile: ''
        }
      });

      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      // Sustained burst: each dispatch advances the wall clock by 1s but never
      // yields the event loop (no advanceTimersByTime). After ~6s the forced
      // save must fire synchronously.
      for (let i = 0; i < 8; i++) {
        mockStore.getState.mockReturnValue(stateAt(i));
        nextHandler({ type: `BURST_${i}` });
        virtualNow += 1000;
      }

      // No jest timers were advanced, so a 0ms setTimeout would still be parked.
      expect(mockLocalStorage.setItem).toHaveBeenCalled();

      nowSpy.mockRestore();
    });
  });

  describe('state serialization', () => {
    test('limits selectedFiles to 200 items', () => {
      const largeFilesList = Array(300)
        .fill()
        .map((_, i) => ({ path: `/file${i}.txt` }));

      mockStore.getState.mockReturnValue({
        ui: { currentPhase: 'discover', sidebarOpen: true, showSettings: false },
        files: {
          selectedFiles: largeFilesList,
          organizedFiles: [],
          fileStates: {},
          smartFolders: [],
          namingConvention: 'default'
        },
        analysis: {
          results: [],
          isAnalyzing: false,
          analysisProgress: { current: 0, total: 0 },
          currentAnalysisFile: ''
        }
      });

      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      nextHandler({ type: 'ACTION' });
      jest.advanceTimersByTime(1000);

      const savedData = JSON.parse(mockLocalStorage.setItem.mock.calls[0][1]);
      expect(savedData.files.selectedFiles.length).toBeLessThanOrEqual(200);
    });

    test('keeps the newest selectedFiles and results when capping (SW-72)', () => {
      const largeFilesList = Array.from({ length: 300 }, (_, i) => ({ path: `/file${i}.txt` }));
      const largeResults = Array.from({ length: 300 }, (_, i) => ({ path: `/result${i}.txt` }));

      mockStore.getState.mockReturnValue({
        ui: { currentPhase: 'discover', sidebarOpen: true, showSettings: false },
        files: {
          selectedFiles: largeFilesList,
          organizedFiles: [],
          fileStates: {},
          smartFolders: [],
          namingConvention: 'default'
        },
        analysis: {
          results: largeResults,
          isAnalyzing: false,
          analysisProgress: { current: 0, total: 0 },
          currentAnalysisFile: ''
        }
      });

      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      nextHandler({ type: 'ACTION' });
      jest.advanceTimersByTime(1000);

      const savedData = JSON.parse(mockLocalStorage.setItem.mock.calls[0][1]);
      expect(savedData.files.selectedFiles).toEqual(largeFilesList.slice(-200));
      expect(savedData.analysis.results).toEqual(largeResults.slice(-200));
      expect(savedData.files.selectedFiles[0].path).toBe('/file100.txt');
      expect(savedData.analysis.results[0].path).toBe('/result100.txt');
    });

    test('limits fileStates to 100 entries', () => {
      const largeFileStates = {};
      for (let i = 0; i < 150; i++) {
        largeFileStates[`/file${i}.txt`] = { state: 'analyzed' };
      }

      mockStore.getState.mockReturnValue({
        ui: { currentPhase: 'discover', sidebarOpen: true, showSettings: false },
        files: {
          selectedFiles: [],
          organizedFiles: [],
          fileStates: largeFileStates,
          smartFolders: [],
          namingConvention: 'default'
        },
        analysis: {
          results: [],
          isAnalyzing: false,
          analysisProgress: { current: 0, total: 0 },
          currentAnalysisFile: ''
        }
      });

      const middleware = persistenceMiddleware(mockStore);
      const nextHandler = middleware(mockNext);

      nextHandler({ type: 'ACTION' });
      jest.advanceTimersByTime(1000);

      const savedData = JSON.parse(mockLocalStorage.setItem.mock.calls[0][1]);
      expect(Object.keys(savedData.files.fileStates).length).toBeLessThanOrEqual(100);
    });
  });

  describe('organizedPathIndex durability', () => {
    test('keeps compact organizedPathIndex when rich organizedFiles history is truncated', () => {
      const buildStateSnapshot =
        require('../src/renderer/store/middleware/persistenceMiddleware').buildStateSnapshot;
      expect(typeof buildStateSnapshot).toBe('function');

      const organizedFiles = Array.from({ length: 450 }, (_, i) => ({
        originalPath: `C:\\Downloads\\file-${i}.pdf`,
        path: `C:\\Docs\\file-${i}.pdf`,
        organizedAt: new Date().toISOString()
      }));
      const organizedPathIndex = organizedFiles.flatMap((entry) => [
        entry.originalPath.replace(/\\/g, '/').toLowerCase(),
        entry.path.replace(/\\/g, '/').toLowerCase()
      ]);

      const snapshot = buildStateSnapshot({
        ui: {
          currentPhase: 'organize',
          previousPhase: 'discover',
          sidebarOpen: true,
          settings: null,
          graphTourDismissed: false,
          graphInsightsSection: null,
          graphLegendHintDismissed: false,
          graphInsightsDockCollapsed: false,
          viewMode: 'phased',
          selectedTheme: 'primary'
        },
        files: {
          selectedFiles: [],
          organizedFiles,
          organizedPathIndex,
          smartFolders: [],
          namingConvention: {
            convention: 'subject-date',
            dateFormat: 'YYYY-MM-DD',
            caseConvention: 'kebab-case',
            separator: '-'
          },
          fileStates: {}
        },
        analysis: {
          results: [],
          isAnalyzing: false,
          analysisProgress: { current: 0, total: 0, lastActivity: 0 },
          currentAnalysisFile: ''
        }
      });

      // Rich history stays capped for localStorage budget…
      expect(snapshot.files.organizedFiles).toHaveLength(200);
      // …but the compact index retains the full organize set so Discover
      // does not resurrect already-moved files as "waiting" after restart.
      expect(snapshot.files.organizedPathIndex.length).toBe(organizedPathIndex.length);
      expect(snapshot.files.organizedPathIndex).toEqual(
        expect.arrayContaining([
          'c:/downloads/file-0.pdf',
          'c:/docs/file-0.pdf',
          'c:/downloads/file-449.pdf',
          'c:/docs/file-449.pdf'
        ])
      );
    });
  });
});
