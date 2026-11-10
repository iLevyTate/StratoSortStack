/**
 * Tests for useAnalysis Hook
 * Tests file analysis logic and state management
 */

import * as React from 'react';
import { renderHook, act, cleanup } from '@testing-library/react';
// The same module instances the renderer uses; a later test resets the
// registry, after which a require() would load a second React.
import { useAnalysis as useAnalysisOriginal } from '../src/renderer/phases/discover/useAnalysis';

// Mock react-redux
jest.mock('react-redux', () => ({
  useStore: jest.fn(() => ({
    getState: jest.fn(() => ({
      analysis: {
        isAnalyzing: false,
        progress: null
      }
    }))
  }))
}));

// Mock dependencies
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

jest.mock('../src/shared/constants', () => ({
  PHASES: { DISCOVER: 'discover', ORGANIZE: 'organize', COMPLETE: 'complete' },
  FILE_STATES: {
    PENDING: 'pending',
    ANALYZING: 'analyzing',
    CATEGORIZED: 'categorized',
    ERROR: 'error'
  },
  SUPPORTED_AUDIO_EXTENSIONS: ['.mp3', '.wav'],
  SUPPORTED_VIDEO_EXTENSIONS: ['.mp4', '.mov']
}));

jest.mock('../src/renderer/phases/discover/namingUtils', () => ({
  validateProgressState: jest.fn((progress) => {
    return (
      progress &&
      typeof progress.current === 'number' &&
      typeof progress.total === 'number' &&
      progress.current >= 0 &&
      progress.total >= 0
    );
  }),
  generatePreviewName: jest.fn((name) => name),
  generateSuggestedNameFromAnalysis: jest.fn(({ originalFileName }) => originalFileName),
  makeUniqueFileName: jest.fn((candidate) => candidate),
  extractFileName: jest.fn((filePath) => {
    const value = String(filePath || '');
    const parts = value.split(/[\\/]/);
    return parts[parts.length - 1] || value;
  })
}));

// Mock window.electronAPI
const mockElectronAPI = {
  files: {
    analyze: jest.fn()
  },
  analysis: {
    batch: jest.fn(),
    getReadyQueue: jest.fn(),
    clearReadyQueue: jest.fn().mockResolvedValue({ success: true })
  },
  settings: {
    get: jest.fn()
  }
};

// A hook that unmounts in the middle of a run leaves "resume this" in a
// module-level flag for the next mount, and the next mount is the next
// test's. Unmount what the test left mounted, then let a mount with
// nothing selected take the flag: it has nothing to resume.
const dropParkedResume = () => {
  cleanup();
  renderHook(() =>
    useAnalysisOriginal({
      selectedFiles: [],
      fileStates: {},
      analysisResults: [],
      isAnalyzing: false,
      analysisProgress: { current: 0, total: 0 },
      namingSettings: { convention: 'original', separator: '-', dateFormat: 'YYYY-MM-DD' },
      setters: {
        setIsAnalyzing: jest.fn(),
        setAnalysisProgress: jest.fn(),
        setCurrentAnalysisFile: jest.fn(),
        setAnalysisResults: jest.fn(),
        setFileStates: jest.fn()
      },
      updateFileState: jest.fn(),
      addNotification: jest.fn(),
      actions: { setPhaseData: jest.fn(), advancePhase: jest.fn() }
    })
  );
  cleanup();
};

describe('useAnalysis', () => {
  let useAnalysis;
  let mockSetIsAnalyzing;
  let mockSetAnalysisProgress;
  let mockSetCurrentAnalysisFile;
  let mockSetAnalysisResults;
  let mockSetFileStates;
  let mockUpdateFileState;
  let mockAddNotification;
  let mockActions;

  const createMockOptions = (overrides = {}) => ({
    selectedFiles: [{ path: '/test.txt', name: 'test.txt' }],
    fileStates: {},
    analysisResults: [],
    isAnalyzing: false,
    analysisProgress: { current: 0, total: 0 },
    namingSettings: {
      convention: 'original',
      separator: '-',
      dateFormat: 'YYYY-MM-DD',
      caseConvention: 'original'
    },
    setters: {
      setIsAnalyzing: mockSetIsAnalyzing,
      setAnalysisProgress: mockSetAnalysisProgress,
      setCurrentAnalysisFile: mockSetCurrentAnalysisFile,
      setAnalysisResults: mockSetAnalysisResults,
      setFileStates: mockSetFileStates
    },
    updateFileState: mockUpdateFileState,
    addNotification: mockAddNotification,
    actions: mockActions,
    ...overrides
  });

  beforeEach(() => {
    // jest.resetModules(); // Removed - breaks React hooks context
    jest.clearAllMocks();
    jest.useFakeTimers();

    // Set up window.electronAPI fresh each test (test-setup.js may overwrite global.window)
    global.window = global.window || {};
    global.window.electronAPI = mockElectronAPI;

    mockSetIsAnalyzing = jest.fn();
    mockSetAnalysisProgress = jest.fn();
    mockSetCurrentAnalysisFile = jest.fn();
    mockSetAnalysisResults = jest.fn();
    mockSetFileStates = jest.fn();
    mockUpdateFileState = jest.fn();
    mockAddNotification = jest.fn();
    mockActions = {
      setPhaseData: jest.fn(),
      advancePhase: jest.fn()
    };

    mockElectronAPI.files.analyze.mockResolvedValue({
      category: 'documents',
      suggestedName: 'test-document.txt'
    });
    mockElectronAPI.analysis.batch.mockResolvedValue({
      success: true,
      results: [],
      errors: [],
      total: 0,
      successful: 0
    });
    mockElectronAPI.analysis.getReadyQueue.mockResolvedValue({
      success: true,
      readyFiles: []
    });
    mockElectronAPI.settings.get.mockResolvedValue({
      maxConcurrentAnalysis: 3
    });

    useAnalysis = require('../src/renderer/phases/discover/useAnalysis').useAnalysis;
  });

  afterEach(() => {
    dropParkedResume();
    jest.useRealTimers();
  });

  describe('initialization', () => {
    test('returns analyzeFiles function', () => {
      const { result } = renderHook(() => useAnalysis(createMockOptions()));

      expect(typeof result.current.analyzeFiles).toBe('function');
    });

    test('returns cancelAnalysis function', () => {
      const { result } = renderHook(() => useAnalysis(createMockOptions()));

      expect(typeof result.current.cancelAnalysis).toBe('function');
    });

    test('returns clearAnalysisQueue function', () => {
      const { result } = renderHook(() => useAnalysis(createMockOptions()));

      expect(typeof result.current.clearAnalysisQueue).toBe('function');
    });

    test('returns resetAnalysisState function', () => {
      const { result } = renderHook(() => useAnalysis(createMockOptions()));

      expect(typeof result.current.resetAnalysisState).toBe('function');
    });

    test('returns generatePreviewName function', () => {
      const { result } = renderHook(() => useAnalysis(createMockOptions()));

      expect(typeof result.current.generatePreviewName).toBe('function');
    });

    test('returns pruneBatchResultsForPath function', () => {
      const { result } = renderHook(() => useAnalysis(createMockOptions()));

      expect(typeof result.current.pruneBatchResultsForPath).toBe('function');
    });
  });

  describe('analyzeFiles', () => {
    test('does nothing for empty files array', async () => {
      const { result } = renderHook(() => useAnalysis(createMockOptions()));

      let status;
      await act(async () => {
        status = await result.current.analyzeFiles([]);
      });

      expect(status).toEqual({ started: false, reason: 'empty' });
      expect(mockSetIsAnalyzing).not.toHaveBeenCalled();
    });

    test('does nothing for null files', async () => {
      const { result } = renderHook(() => useAnalysis(createMockOptions()));

      let status;
      await act(async () => {
        status = await result.current.analyzeFiles(null);
      });

      expect(status).toEqual({ started: false, reason: 'empty' });
      expect(mockSetIsAnalyzing).not.toHaveBeenCalled();
    });

    // There is no trial gate in the public release: a license snapshot left
    // over from a trial build must not keep analysis from starting.
    test('starts analysis whatever the license snapshot says', async () => {
      const { useStore } = require('react-redux');
      const defaultStore = useStore.getMockImplementation();
      useStore.mockImplementation(() => ({
        getState: jest.fn(() => ({
          analysis: { isAnalyzing: false, progress: null },
          license: { snapshot: { state: 'trial_expired' } }
        }))
      }));
      try {
        const { result } = renderHook(() => useAnalysis(createMockOptions()));
        const files = [{ path: '/a.pdf', name: 'a.pdf' }];

        act(() => {
          result.current.analyzeFiles(files);
        });
        await act(async () => {
          jest.advanceTimersByTime(20);
        });

        expect(mockSetIsAnalyzing).toHaveBeenCalledWith(true, { total: files.length });
      } finally {
        useStore.mockImplementation(defaultStore);
      }
    });

    test('sets isAnalyzing to true when starting', async () => {
      const { result } = renderHook(() => useAnalysis(createMockOptions()));
      const files = [{ path: '/test.txt', name: 'test.txt' }];

      // Don't await - just start the analysis
      act(() => {
        result.current.analyzeFiles(files);
      });

      // Advance through initial timeout
      await act(async () => {
        jest.advanceTimersByTime(20);
      });

      // Carries the real batch total so startAnalysis doesn't zero progress
      expect(mockSetIsAnalyzing).toHaveBeenCalledWith(true, { total: files.length });
    });

    test('updates file state to analyzing', async () => {
      const { result } = renderHook(() => useAnalysis(createMockOptions()));
      const files = [{ path: '/test.txt', name: 'test.txt' }];

      act(() => {
        result.current.analyzeFiles(files);
      });

      await act(async () => {
        jest.advanceTimersByTime(20);
        await Promise.resolve();
      });

      expect(mockUpdateFileState).toHaveBeenCalledWith(
        '/test.txt',
        'analyzing',
        expect.any(Object)
      );
    });

    test('prevents concurrent analysis runs', async () => {
      const { result } = renderHook(() =>
        useAnalysis(
          createMockOptions({
            isAnalyzing: true,
            analysisProgress: { current: 0, total: 1, lastActivity: Date.now() }
          })
        )
      );
      const files = [{ path: '/test.txt', name: 'test.txt' }];

      await act(async () => {
        await result.current.analyzeFiles(files);
      });

      // Should not start analysis when already analyzing
      expect(mockSetIsAnalyzing).not.toHaveBeenCalledWith(true);
    });

    test('uses batch analysis route for large runs', async () => {
      const { result } = renderHook(() => useAnalysis(createMockOptions()));
      const files = Array.from({ length: 40 }, (_, index) => ({
        path: `/batch/file-${index}.txt`,
        name: `file-${index}.txt`
      }));

      mockElectronAPI.analysis.batch.mockResolvedValueOnce({
        success: true,
        results: files.map((file) => ({
          filePath: file.path,
          success: true,
          result: {
            category: 'documents',
            suggestedName: `${file.name}-done`
          }
        })),
        errors: [],
        total: files.length,
        successful: files.length
      });

      await act(async () => {
        const promise = result.current.analyzeFiles(files);
        jest.advanceTimersByTime(50);
        await promise;
      });

      expect(mockElectronAPI.analysis.batch).toHaveBeenCalledWith(
        expect.objectContaining({
          filePaths: files.map((file) => file.path)
        })
      );
    });

    test('a run with a recording uses the batch route even for one file', async () => {
      // The per-file route gives a file 5 minutes, then analyzes it again
      // from the start, and its Stop does not reach the work in main.
      const { result } = renderHook(() => useAnalysis(createMockOptions()));
      const files = [{ path: '/media/meeting.mp4', name: 'meeting.mp4' }];
      mockElectronAPI.analysis.batch.mockResolvedValueOnce({
        success: true,
        results: [
          {
            filePath: files[0].path,
            success: true,
            result: { category: 'video', suggestedName: 'meeting' }
          }
        ],
        errors: [],
        total: 1,
        successful: 1
      });

      await act(async () => {
        const promise = result.current.analyzeFiles(files);
        jest.advanceTimersByTime(50);
        await promise;
      });

      expect(mockElectronAPI.analysis.batch).toHaveBeenCalledWith(
        expect.objectContaining({ filePaths: ['/media/meeting.mp4'] })
      );
      expect(mockElectronAPI.files.analyze).not.toHaveBeenCalled();
    });

    test('a batch that keeps reporting progress is not cut off at 30 minutes', async () => {
      // The batch request had a fixed 30-minute limit. A low-VRAM machine
      // runs every run of 3 or more files as one sequential batch, so a
      // larger folder reached it: the batch was cancelled in main and the
      // rest was analyzed per file.
      const files = Array.from({ length: 40 }, (_, index) => ({
        path: '/long-batch/file-' + index + '.txt',
        name: 'file-' + index + '.txt'
      }));
      let resolveBatch;
      mockElectronAPI.analysis.batch.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveBatch = resolve;
        })
      );
      const { result } = renderHook(() => useAnalysis(createMockOptions({ selectedFiles: files })));

      let analyzePromise;
      await act(async () => {
        analyzePromise = result.current.analyzeFiles(files);
        await jest.advanceTimersByTimeAsync(50);
      });
      const clientBatchId = mockElectronAPI.analysis.batch.mock.calls[0][0].batchId;

      // 35 minutes, one file finishing each minute.
      for (let minute = 1; minute <= 35; minute += 1) {
        await act(async () => {
          await jest.advanceTimersByTimeAsync(60 * 1000);
          window.dispatchEvent(
            new CustomEvent('operation-progress', {
              detail: {
                type: 'batch_analyze',
                batchId: clientBatchId,
                completed: minute,
                total: files.length,
                currentFile: files[minute].path
              }
            })
          );
        });
      }

      expect(mockElectronAPI.files.analyze).not.toHaveBeenCalled();
      expect(mockAddNotification).not.toHaveBeenCalledWith(
        expect.anything(),
        'warning',
        expect.anything(),
        'analysis-batch-fallback'
      );

      await act(async () => {
        resolveBatch({
          success: true,
          results: files.map((file) => ({
            filePath: file.path,
            success: true,
            result: { category: 'documents', suggestedName: file.name + '-done' }
          })),
          errors: [],
          total: files.length,
          successful: files.length
        });
        await jest.advanceTimersByTimeAsync(1000);
        await analyzePromise;
      });
      expect(mockElectronAPI.files.analyze).not.toHaveBeenCalled();
    });

    test('a file that finishes right after another appears without waiting for the next', async () => {
      // Results are applied at most every 200 ms. The second of two files
      // finishing together was held until another file finished, which with
      // a long recording next in line is many minutes later.
      const files = Array.from({ length: 40 }, (_, index) => ({
        path: '/together/file-' + index + '.txt',
        name: 'file-' + index + '.txt'
      }));
      let resolveBatch;
      mockElectronAPI.analysis.batch.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveBatch = resolve;
        })
      );
      const { result } = renderHook(() => useAnalysis(createMockOptions({ selectedFiles: files })));

      let analyzePromise;
      await act(async () => {
        analyzePromise = result.current.analyzeFiles(files);
        await jest.advanceTimersByTimeAsync(50);
      });
      const clientBatchId = mockElectronAPI.analysis.batch.mock.calls[0][0].batchId;
      const finishFile = (file) =>
        window.dispatchEvent(
          new CustomEvent('analysis:file-complete', {
            detail: {
              batchId: clientBatchId,
              item: {
                filePath: file.path,
                success: true,
                result: { category: 'documents', suggestedName: file.name + '-done' }
              }
            }
          })
        );
      const shownPaths = () => {
        const applied = mockSetAnalysisResults.mock.calls
          .map((call) => call[0])
          .filter((value) => Array.isArray(value));
        return applied.length ? applied[applied.length - 1].map((item) => item.path) : [];
      };

      await act(async () => {
        finishFile(files[0]);
        finishFile(files[1]);
        await jest.advanceTimersByTimeAsync(0);
      });
      expect(shownPaths()).toEqual([files[0].path]);

      // No further file finishes; the batch is still running.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1000);
      });
      expect(shownPaths()).toEqual([files[0].path, files[1].path]);

      await act(async () => {
        resolveBatch({
          success: true,
          results: files.map((file) => ({
            filePath: file.path,
            success: true,
            result: { category: 'documents', suggestedName: file.name + '-done' }
          })),
          errors: [],
          total: files.length,
          successful: files.length
        });
        await jest.advanceTimersByTimeAsync(1000);
        await analyzePromise;
      });
    });

    test('a run waiting for an earlier batch is not reset as stuck', async () => {
      // Nothing refreshed the liveness clock while the run waited. After 5
      // minutes it was reset, and the files the earlier batch had not
      // finished were never analyzed.
      const files = Array.from({ length: 40 }, (_, index) => ({
        path: '/waiting/file-' + index + '.txt',
        name: 'file-' + index + '.txt'
      }));
      mockElectronAPI.analysis.batch.mockImplementation(() =>
        Promise.reject(
          Object.assign(new Error('Operation already in progress: analysis:analyze-batch'), {
            code: 'CONCURRENCY_LIMIT'
          })
        )
      );
      try {
        const { result } = renderHook(() =>
          useAnalysis(createMockOptions({ selectedFiles: files }))
        );
        let analyzePromise;
        await act(async () => {
          analyzePromise = result.current.analyzeFiles(files);
          await jest.advanceTimersByTimeAsync(50);
        });
        for (let minute = 0; minute < 12; minute += 1) {
          await act(async () => {
            await jest.advanceTimersByTimeAsync(60 * 1000);
          });
        }

        // Still asking after 12 minutes.
        const triesSoFar = mockElectronAPI.analysis.batch.mock.calls.length;
        await act(async () => {
          await jest.advanceTimersByTimeAsync(60 * 1000);
        });
        expect(mockElectronAPI.analysis.batch.mock.calls.length).toBeGreaterThan(triesSoFar);

        mockElectronAPI.analysis.batch.mockImplementation(async () => ({
          success: true,
          results: files.map((file) => ({
            filePath: file.path,
            success: true,
            result: { category: 'documents', suggestedName: file.name + '-done' }
          })),
          errors: [],
          total: files.length,
          successful: files.length
        }));
        await act(async () => {
          await jest.advanceTimersByTimeAsync(5000);
          await analyzePromise;
        });
        expect(mockElectronAPI.files.analyze).not.toHaveBeenCalled();
      } finally {
        mockElectronAPI.analysis.batch.mockReset();
      }
    });

    test.each([
      ['all of', 40],
      ['part of', 30]
    ])(
      'a run that waited reports every file when the earlier batch did %s it',
      async (_label, readyCount) => {
        // Only the results this run recorded were counted. What the earlier
        // batch finished came from the ready queue, so the run ended with no
        // notice, or with a count that left those files out.
        const files = Array.from({ length: 40 }, (_, index) => ({
          path: '/earlier/file-' + index + '.txt',
          name: 'file-' + index + '.txt'
        }));
        mockElectronAPI.analysis.getReadyQueue.mockResolvedValue({
          success: true,
          readyFiles: files.slice(0, readyCount).map((file) => ({
            path: file.path,
            name: file.name,
            analysis: { category: 'documents', suggestedName: file.name + '-earlier' }
          }))
        });
        mockElectronAPI.analysis.batch
          .mockRejectedValueOnce(
            Object.assign(new Error('Operation already in progress: analysis:analyze-batch'), {
              code: 'CONCURRENCY_LIMIT'
            })
          )
          .mockImplementation(async (payload) => ({
            success: true,
            results: payload.filePaths.map((filePath) => ({
              filePath,
              success: true,
              result: { category: 'documents', suggestedName: 'done' }
            })),
            errors: [],
            total: payload.filePaths.length,
            successful: payload.filePaths.length
          }));
        try {
          const { result } = renderHook(() =>
            useAnalysis(createMockOptions({ selectedFiles: files }))
          );
          await act(async () => {
            const promise = result.current.analyzeFiles(files);
            await jest.advanceTimersByTimeAsync(60 * 1000);
            await promise;
          });

          const sent = mockElectronAPI.analysis.batch.mock.calls.slice(1);
          expect(sent.map((call) => call[0].filePaths.length)).toEqual(
            readyCount === files.length ? [] : [files.length - readyCount]
          );
          expect(mockAddNotification).toHaveBeenCalledWith(
            'Analysis complete! 40 files ready',
            'success',
            4000,
            'analysis-complete'
          );
        } finally {
          mockElectronAPI.analysis.batch.mockReset();
        }
      }
    );

    test.each([
      ['waited for an earlier batch that did 30', 30, { current: 31, total: 40 }],
      ['did not wait', 0, null]
    ])(
      'while its batch is in main, a run that %s has its offset registered',
      async (_label, readyCount, countsOfFirstFile) => {
        // Main counts within the files it was sent. The store shows the run,
        // so the middleware that writes the counts needs what came before.
        const { toRunCounts } = require('../src/renderer/store/analysisRunBase');
        const files = Array.from({ length: 40 }, (_, index) => ({
          path: '/offset/file-' + index + '.txt',
          name: 'file-' + index + '.txt'
        }));
        mockElectronAPI.analysis.getReadyQueue.mockResolvedValue({
          success: true,
          readyFiles: files.slice(0, readyCount).map((file) => ({
            path: file.path,
            name: file.name,
            analysis: { category: 'documents', suggestedName: file.name + '-earlier' }
          }))
        });
        const inMain = [];
        const analyzeSent = async (payload) => {
          inMain.push({ batchId: payload.batchId, counts: toRunCounts(payload.batchId, 1) });
          return {
            success: true,
            results: payload.filePaths.map((filePath) => ({
              filePath,
              success: true,
              result: { category: 'documents', suggestedName: 'done' }
            })),
            errors: [],
            total: payload.filePaths.length,
            successful: payload.filePaths.length
          };
        };
        if (readyCount > 0) {
          mockElectronAPI.analysis.batch.mockRejectedValueOnce(
            Object.assign(new Error('Operation already in progress: analysis:analyze-batch'), {
              code: 'CONCURRENCY_LIMIT'
            })
          );
        }
        mockElectronAPI.analysis.batch.mockImplementation(analyzeSent);
        try {
          const { result } = renderHook(() =>
            useAnalysis(createMockOptions({ selectedFiles: files }))
          );
          await act(async () => {
            const promise = result.current.analyzeFiles(files);
            await jest.advanceTimersByTimeAsync(60 * 1000);
            await promise;
          });

          expect(inMain).toEqual([{ batchId: expect.any(String), counts: countsOfFirstFile }]);
          // Over: nothing stays registered for a later batch to inherit.
          expect(toRunCounts(inMain[0].batchId, 1)).toBeNull();
        } finally {
          mockElectronAPI.analysis.batch.mockReset();
        }
      }
    );

    test('a second call while the first run is starting is queued behind it', async () => {
      // A run writes its first progress a moment after it takes the lock.
      // Until then the store holds what the run before left, which is no
      // activity at all, and that read as a lock gone stale: the second
      // call reset the first run and took its place.
      const group = (folder) =>
        Array.from({ length: 40 }, (_, index) => ({
          path: folder + '/file-' + index + '.txt',
          name: 'file-' + index + '.txt'
        }));
      const first = group('/first');
      const second = group('/second');
      mockElectronAPI.analysis.batch.mockImplementation(async (payload) => ({
        success: true,
        results: payload.filePaths.map((filePath) => ({
          filePath,
          success: true,
          result: { category: 'documents', suggestedName: 'done' }
        })),
        errors: [],
        total: payload.filePaths.length,
        successful: payload.filePaths.length
      }));
      try {
        const { result } = renderHook(() =>
          useAnalysis(createMockOptions({ selectedFiles: [...first, ...second] }))
        );
        let firstCall;
        let secondCall;
        await act(async () => {
          firstCall = result.current.analyzeFiles(first);
          secondCall = result.current.analyzeFiles(second);
          await jest.advanceTimersByTimeAsync(60 * 1000);
          await Promise.all([firstCall, secondCall]);
          await jest.advanceTimersByTimeAsync(60 * 1000);
        });

        expect(await secondCall).toEqual({ started: false, reason: 'queued' });
        expect(await firstCall).toEqual({ started: true });
        const sent = mockElectronAPI.analysis.batch.mock.calls.map((call) => call[0].filePaths[0]);
        expect(sent).toEqual(['/first/file-0.txt', '/second/file-0.txt']);
      } finally {
        mockElectronAPI.analysis.batch.mockReset();
      }
    });

    test('falls back to per-file analysis when batch route fails', async () => {
      const { result } = renderHook(() => useAnalysis(createMockOptions()));
      const files = Array.from({ length: 40 }, (_, index) => ({
        path: `/fallback/file-${index}.txt`,
        name: `file-${index}.txt`
      }));

      mockElectronAPI.analysis.batch.mockRejectedValueOnce(new Error('Batch route failed'));

      await act(async () => {
        const promise = result.current.analyzeFiles(files);
        jest.advanceTimersByTime(50);
        await promise;
      });

      expect(mockElectronAPI.analysis.batch).toHaveBeenCalled();
      expect(mockElectronAPI.files.analyze).toHaveBeenCalled();
    });

    // Starts a run on the per-file path whose files do not finish until
    // released.
    async function startPerFileRun(folder) {
      const files = Array.from({ length: 40 }, (_, index) => ({
        path: folder + '/file-' + index + '.txt',
        name: 'file-' + index + '.txt'
      }));
      const releases = [];
      mockElectronAPI.analysis.batch.mockRejectedValueOnce(new Error('Batch route failed'));
      mockElectronAPI.files.analyze.mockImplementation(
        () =>
          new Promise((resolve) => {
            releases.push(resolve);
          })
      );
      const hook = renderHook(() => useAnalysis(createMockOptions({ selectedFiles: files })));
      let analyzePromise;
      await act(async () => {
        analyzePromise = hook.result.current.analyzeFiles(files);
        await jest.advanceTimersByTimeAsync(50);
      });
      expect(releases.length).toBeGreaterThan(0);
      const finish = async () => {
        await act(async () => {
          releases.forEach((release) => release({ category: 'documents', suggestedName: 'done' }));
          await jest.advanceTimersByTimeAsync(1000);
          await analyzePromise;
        });
      };
      return { hook, finish };
    }
    const noticeTexts = () => mockAddNotification.mock.calls.map((call) => call[0]);

    test('a per-file run stopped by leaving Discover is not reported as cancelled by the user', async () => {
      const { hook, finish } = await startPerFileRun('/left');

      hook.unmount();
      await finish();

      expect(noticeTexts().filter((text) => /cancelled|stopped/i.test(text))).toEqual([]);
    });

    test('a per-file run the user stops is reported once', async () => {
      const { hook, finish } = await startPerFileRun('/stopped');

      act(() => {
        hook.result.current.cancelAnalysis();
      });
      await finish();

      expect(noticeTexts().filter((text) => /cancelled|stopped/i.test(text))).toEqual([
        'Analysis stopped'
      ]);
    });

    test('a slow file on the per-file path fails alone; the run goes on', async () => {
      // A file gets 5 minutes, the same as the no-progress limit, and the
      // run's clock started a moment before the file's. The run was stopped
      // just before the file would have failed and made room for the next.
      const { hook, finish } = await startPerFileRun('/slow');

      for (let minute = 0; minute < 6; minute += 1) {
        await act(async () => {
          await jest.advanceTimersByTimeAsync(60 * 1000);
        });
      }

      expect(
        mockAddNotification.mock.calls.filter((call) => call[3] === 'analysis-timeout')
      ).toEqual([]);

      act(() => {
        hook.result.current.cancelAnalysis();
      });
      await finish();
    });

    // The preload lets one analysis:analyze-media request run per window and
    // refuses a second while it is pending. This stands in for that lock.
    describe('recordings on the per-file path', () => {
      const mediaFiles = (names) => names.map((name) => ({ path: '/rec/' + name, name }));
      // As the renderer receives it: contextBridge copies an Error's message
      // and drops the code the preload set on it.
      const refusal = () =>
        new Error('IPC Error: Operation already in progress: analysis:analyze-media');
      const errorCalls = () => mockUpdateFileState.mock.calls.filter((call) => call[1] === 'error');
      const workers = (count) => {
        mockElectronAPI.system = {
          getRecommendedConcurrency: jest
            .fn()
            .mockResolvedValue({ success: true, maxConcurrent: count })
        };
      };

      beforeEach(() => workers(3));

      afterEach(() => {
        delete mockElectronAPI.system;
      });

      const readyPaths = () =>
        mockUpdateFileState.mock.calls.filter((call) => call[1] === 'ready').map((call) => call[0]);

      test('are analyzed one at a time, none refused as already in progress', async () => {
        const files = mediaFiles(['a.mp3', 'b.mp3', 'c.mp4']);
        let inFlight = 0;
        let mostInFlight = 0;
        let refused = 0;
        const releases = [];
        mockElectronAPI.analysis.batch.mockRejectedValueOnce(new Error('Batch route failed'));
        mockElectronAPI.files.analyze.mockImplementation(() => {
          if (inFlight > 0) {
            refused += 1;
            return Promise.reject(refusal());
          }
          inFlight += 1;
          mostInFlight = Math.max(mostInFlight, inFlight);
          return new Promise((resolve) => {
            releases.push(() => {
              inFlight -= 1;
              resolve({ category: 'audio', suggestedName: 'done' });
            });
          });
        });
        const hook = renderHook(() => useAnalysis(createMockOptions({ selectedFiles: files })));

        let analyzePromise;
        await act(async () => {
          analyzePromise = hook.result.current.analyzeFiles(files);
          await jest.advanceTimersByTimeAsync(50);
        });
        for (let turn = 0; turn < files.length; turn += 1) {
          await act(async () => {
            releases.shift()?.();
            await jest.advanceTimersByTimeAsync(50);
          });
        }
        await act(async () => {
          await jest.advanceTimersByTimeAsync(1000);
          await analyzePromise;
        });

        expect(refused).toBe(0);
        expect(mostInFlight).toBe(1);
        expect(errorCalls()).toEqual([]);
        expect(readyPaths().sort()).toEqual(['/rec/a.mp3', '/rec/b.mp3', '/rec/c.mp4']);
      });

      test('a document is not held back by a recording in progress', async () => {
        const files = [
          { path: '/rec/a.mp3', name: 'a.mp3' },
          { path: '/rec/b.mp3', name: 'b.mp3' },
          { path: '/rec/notes.txt', name: 'notes.txt' }
        ];
        const started = [];
        mockElectronAPI.analysis.batch.mockRejectedValueOnce(new Error('Batch route failed'));
        mockElectronAPI.files.analyze.mockImplementation((filePath) => {
          started.push(filePath);
          return new Promise(() => {});
        });
        const hook = renderHook(() => useAnalysis(createMockOptions({ selectedFiles: files })));

        await act(async () => {
          hook.result.current.analyzeFiles(files);
          await jest.advanceTimersByTimeAsync(50);
        });

        expect(started.sort()).toEqual(['/rec/a.mp3', '/rec/notes.txt']);

        act(() => {
          hook.result.current.cancelAnalysis();
        });
      });

      test('a recording waits for the request of one that timed out to let go', async () => {
        // The first recording runs past its limit. Its request stays pending
        // in the preload a little longer, and the next recording is refused
        // until then.
        const files = mediaFiles(['long.mp3', 'next.mp3']);
        let held = false;
        workers(1);
        mockElectronAPI.analysis.batch.mockRejectedValueOnce(new Error('Batch route failed'));
        mockElectronAPI.files.analyze.mockImplementation((filePath) => {
          if (held) return Promise.reject(refusal());
          if (filePath === '/rec/long.mp3') {
            held = true;
            setTimeout(
              () => {
                held = false;
              },
              5 * 60 * 1000 + 20 * 1000
            );
            return new Promise(() => {});
          }
          return Promise.resolve({ category: 'audio', suggestedName: 'done' });
        });
        const hook = renderHook(() => useAnalysis(createMockOptions({ selectedFiles: files })));

        let analyzePromise;
        await act(async () => {
          analyzePromise = hook.result.current.analyzeFiles(files);
          await jest.advanceTimersByTimeAsync(50);
        });
        for (let step = 0; step < 34; step += 1) {
          await act(async () => {
            await jest.advanceTimersByTimeAsync(10 * 1000);
          });
        }
        await act(async () => {
          await analyzePromise;
        });

        expect(errorCalls().map((call) => call[0])).toEqual(['/rec/long.mp3']);
        expect(readyPaths()).toEqual(['/rec/next.mp3']);
      });

      test('a recording past its limit is not sent again when its request times out', async () => {
        // The preload ends the request 35 s after the file's limit, with a
        // timeout error. Sending the file again then would hold the media
        // request for minutes more and refuse the recordings after it.
        const files = mediaFiles(['long.mp3', 'next.mp3']);
        let held = false;
        workers(1);
        mockElectronAPI.analysis.batch.mockRejectedValueOnce(new Error('Batch route failed'));
        mockElectronAPI.files.analyze.mockImplementation((filePath) => {
          if (held) return Promise.reject(refusal());
          if (filePath === '/rec/long.mp3') {
            held = true;
            return new Promise((resolve, reject) => {
              setTimeout(() => {
                held = false;
                reject(
                  new Error('IPC Error: IPC timeout after 330000ms for analysis:analyze-media')
                );
              }, 330 * 1000);
            });
          }
          return Promise.resolve({ category: 'audio', suggestedName: 'done' });
        });
        const hook = renderHook(() => useAnalysis(createMockOptions({ selectedFiles: files })));

        let analyzePromise;
        await act(async () => {
          analyzePromise = hook.result.current.analyzeFiles(files);
          await jest.advanceTimersByTimeAsync(50);
        });
        for (let step = 0; step < 40; step += 1) {
          await act(async () => {
            await jest.advanceTimersByTimeAsync(10 * 1000);
          });
        }
        await act(async () => {
          await analyzePromise;
        });

        expect(
          mockElectronAPI.files.analyze.mock.calls.filter((call) => call[0] === '/rec/long.mp3')
        ).toHaveLength(1);
        expect(errorCalls().map((call) => call[0])).toEqual(['/rec/long.mp3']);
        expect(readyPaths()).toEqual(['/rec/next.mp3']);
      });

      test('a recording refused for longer than the wait fails with the refusal', async () => {
        const files = mediaFiles(['only.mp3']);
        workers(1);
        mockElectronAPI.analysis.batch.mockRejectedValueOnce(new Error('Batch route failed'));
        mockElectronAPI.files.analyze.mockImplementation(() => Promise.reject(refusal()));
        const hook = renderHook(() => useAnalysis(createMockOptions({ selectedFiles: files })));

        let analyzePromise;
        await act(async () => {
          analyzePromise = hook.result.current.analyzeFiles(files);
          await jest.advanceTimersByTimeAsync(50);
        });
        for (let step = 0; step < 6; step += 1) {
          await act(async () => {
            await jest.advanceTimersByTimeAsync(10 * 1000);
          });
        }
        await act(async () => {
          await analyzePromise;
        });

        expect(errorCalls().map((call) => [call[0], call[2].error])).toEqual([
          ['/rec/only.mp3', 'IPC Error: Operation already in progress: analysis:analyze-media']
        ]);
      });
    });

    test('fallback pool skips files whose results already streamed in [F-154]', async () => {
      const { result } = renderHook(() => useAnalysis(createMockOptions()));
      const files = Array.from({ length: 40 }, (_, index) => ({
        path: `/dup/file-${index}.txt`,
        name: `file-${index}.txt`
      }));

      // The batch invoke streams file-0's result via analysis:file-complete,
      // then rejects. Pre-fix, the fallback pool re-queued ALL files — the
      // already-ready file-0 flipped back to "analyzing", got a second full
      // LLM pass, and its result was double-counted in the completion
      // notification.
      mockElectronAPI.analysis.batch.mockImplementationOnce(async (payload) => {
        window.dispatchEvent(
          new CustomEvent('analysis:file-complete', {
            detail: {
              batchId: payload.batchId,
              item: {
                filePath: files[0].path,
                success: true,
                result: { category: 'documents', suggestedName: 'file-0-done' }
              }
            }
          })
        );
        throw new Error('Batch route failed after streaming');
      });

      await act(async () => {
        const promise = result.current.analyzeFiles(files);
        jest.advanceTimersByTime(50);
        await promise;
      });

      const analyzedPaths = mockElectronAPI.files.analyze.mock.calls.map((call) => call[0]);
      expect(analyzedPaths).not.toContain(files[0].path);
      expect(analyzedPaths).toContain(files[1].path);
    });

    describe('a run that stops making progress', () => {
      // Two checks watched the same clock: one after 5 minutes that reset the
      // run and said nothing, one after 10 that would have said why. The
      // first always won, so the progress bar went away with no word.
      const stalledFiles = Array.from({ length: 40 }, (_, index) => ({
        path: '/stalled/file-' + index + '.txt',
        name: 'file-' + index + '.txt'
      }));
      const timeoutNotices = () =>
        mockAddNotification.mock.calls.filter((call) => call[3] === 'analysis-timeout');
      const startRun = async () => {
        mockElectronAPI.analysis.cancelBatch = jest.fn().mockResolvedValue({ cancelled: true });
        // Main never answers and never reports.
        mockElectronAPI.analysis.batch.mockImplementation(() => new Promise(() => {}));
        const hook = renderHook(() =>
          useAnalysis(createMockOptions({ selectedFiles: stalledFiles }))
        );
        await act(async () => {
          hook.result.current.analyzeFiles(stalledFiles);
          await jest.advanceTimersByTimeAsync(50);
        });
        return hook;
      };
      const passMinutes = async (minutes, eachMinute = () => {}) => {
        for (let minute = 0; minute < minutes; minute += 1) {
          await act(async () => {
            eachMinute();
            await jest.advanceTimersByTimeAsync(60 * 1000);
          });
        }
      };

      afterEach(() => {
        delete mockElectronAPI.analysis.cancelBatch;
        mockElectronAPI.analysis.batch.mockReset();
      });

      test('ends with a notice that says why', async () => {
        await startRun();
        expect(mockElectronAPI.analysis.batch).toHaveBeenCalledTimes(1);

        await passMinutes(6);

        expect(mockSetIsAnalyzing).toHaveBeenLastCalledWith(false);
        expect(timeoutNotices()).toHaveLength(1);
        const [message, severity] = timeoutNotices()[0];
        // No duration: the check runs every 5 minutes, so the wait is
        // anywhere between 5 and 10.
        expect(message).toBe(
          'Analysis was stopped because it stopped making progress. Unfinished files are ready to analyze again.'
        );
        expect(severity).toBe('warning');
      });

      test('main is told to stop the batch', async () => {
        await startRun();
        const { batchId } = mockElectronAPI.analysis.batch.mock.calls[0][0];

        await passMinutes(6);

        expect(mockElectronAPI.analysis.cancelBatch).toHaveBeenCalledWith(
          expect.objectContaining({ batchId })
        );
      });

      test('the notice is shown once, however long the app stays open', async () => {
        await startRun();

        await passMinutes(25);

        expect(timeoutNotices()).toHaveLength(1);
      });

      test('a run that main keeps reporting on is not stopped', async () => {
        await startRun();
        const { batchId } = mockElectronAPI.analysis.batch.mock.calls[0][0];
        mockSetIsAnalyzing.mockClear();

        // A long file: main re-sends its report while it works on it.
        await passMinutes(25, () => {
          window.dispatchEvent(
            new CustomEvent('operation-progress', {
              detail: {
                type: 'batch_analyze',
                batchId,
                completed: 0,
                total: stalledFiles.length,
                currentFile: stalledFiles[0].path
              }
            })
          );
        });

        expect(timeoutNotices()).toHaveLength(0);
        expect(mockSetIsAnalyzing).not.toHaveBeenCalledWith(false);
        expect(mockElectronAPI.analysis.cancelBatch).not.toHaveBeenCalled();
      });
    });

    // O-3: an analysis run is a multi-invoke user action — it must run inside
    // a preload trace session so all its main-process logs share one id.
    describe('correlation trace session (O-3)', () => {
      afterEach(() => {
        delete mockElectronAPI.trace;
      });

      test('wraps a completed batch run in a trace session (begin before, end after)', async () => {
        const end = jest.fn();
        mockElectronAPI.trace = {
          beginSession: jest.fn(() => ({ traceId: 'tr-analysis', end }))
        };
        const { result } = renderHook(() => useAnalysis(createMockOptions()));
        const files = Array.from({ length: 40 }, (_, index) => ({
          path: `/trace/file-${index}.txt`,
          name: `file-${index}.txt`
        }));

        mockElectronAPI.analysis.batch.mockResolvedValueOnce({
          success: true,
          results: files.map((file) => ({
            filePath: file.path,
            success: true,
            result: { category: 'documents', suggestedName: `${file.name}-done` }
          })),
          errors: [],
          total: files.length,
          successful: files.length
        });

        await act(async () => {
          const promise = result.current.analyzeFiles(files);
          jest.advanceTimersByTime(50);
          await promise;
        });

        expect(mockElectronAPI.trace.beginSession).toHaveBeenCalledTimes(1);
        expect(end).toHaveBeenCalledTimes(1);
      });

      test('does not open a session for the empty-selection early return', async () => {
        const end = jest.fn();
        mockElectronAPI.trace = {
          beginSession: jest.fn(() => ({ traceId: 'tr-analysis', end }))
        };
        const { result } = renderHook(() => useAnalysis(createMockOptions()));

        await act(async () => {
          await result.current.analyzeFiles([]);
        });

        expect(mockElectronAPI.trace.beginSession).not.toHaveBeenCalled();
      });

      test('tolerates a missing trace API', async () => {
        delete mockElectronAPI.trace;
        const { result } = renderHook(() => useAnalysis(createMockOptions()));
        const files = Array.from({ length: 40 }, (_, index) => ({
          path: `/no-trace/file-${index}.txt`,
          name: `file-${index}.txt`
        }));

        mockElectronAPI.analysis.batch.mockResolvedValueOnce({
          success: true,
          results: files.map((file) => ({
            filePath: file.path,
            success: true,
            result: { category: 'documents', suggestedName: `${file.name}-done` }
          })),
          errors: [],
          total: files.length,
          successful: files.length
        });

        await act(async () => {
          const promise = result.current.analyzeFiles(files);
          jest.advanceTimersByTime(50);
          await promise;
        });

        expect(mockElectronAPI.analysis.batch).toHaveBeenCalled();
      });
    });
  });

  describe('cancelAnalysis', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('stops analysis and resets state', () => {
      const { result } = renderHook(() => useAnalysis(createMockOptions()));

      act(() => {
        result.current.cancelAnalysis();
      });

      expect(mockSetIsAnalyzing).toHaveBeenCalledWith(false);
      expect(mockSetAnalysisProgress).toHaveBeenCalledWith({
        current: 0,
        total: 0,
        lastActivity: 0
      });

      // File name is cleared after a delay
      act(() => {
        jest.runAllTimers();
      });

      expect(mockSetCurrentAnalysisFile).toHaveBeenCalledWith('');
    });

    test('updates actions phase data', () => {
      const { result } = renderHook(() => useAnalysis(createMockOptions()));

      act(() => {
        result.current.cancelAnalysis();
      });

      // File name phase data is cleared after a delay
      act(() => {
        jest.runAllTimers();
      });

      expect(mockActions.setPhaseData).toHaveBeenCalledWith('currentAnalysisFile', '');
    });

    test('requeues in-flight files to pending when cancelled', () => {
      const { result } = renderHook(() =>
        useAnalysis(
          createMockOptions({
            fileStates: {
              '/inflight.txt': { state: 'analyzing' },
              '/ready.txt': { state: 'ready' }
            }
          })
        )
      );

      act(() => {
        result.current.cancelAnalysis();
      });

      const updaterCalls = mockSetFileStates.mock.calls.filter(
        (call) => typeof call[0] === 'function'
      );
      const updaterCall = updaterCalls[updaterCalls.length - 1];
      expect(updaterCall).toBeDefined();
      const updater = updaterCall[0];
      const updated = updater({
        '/inflight.txt': { state: 'analyzing' },
        '/ready.txt': { state: 'ready' }
      });
      expect(updated['/inflight.txt'].state).toBe('pending');
      expect(updated['/ready.txt'].state).toBe('ready');
    });
  });

  describe('clearAnalysisQueue', () => {
    test('clears all analysis state', async () => {
      const { result } = renderHook(() => useAnalysis(createMockOptions()));

      await act(async () => {
        await result.current.clearAnalysisQueue();
      });

      expect(mockSetAnalysisResults).toHaveBeenCalledWith([]);
      expect(mockSetFileStates).toHaveBeenCalledWith({});
      expect(mockSetAnalysisProgress).toHaveBeenCalledWith({
        current: 0,
        total: 0,
        currentFile: '',
        lastActivity: 0
      });
      expect(mockSetCurrentAnalysisFile).toHaveBeenCalledWith('');
    });

    test('shows notification', async () => {
      const { result } = renderHook(() => useAnalysis(createMockOptions()));

      await act(async () => {
        await result.current.clearAnalysisQueue();
      });

      expect(mockAddNotification).toHaveBeenCalledWith(
        'Analysis queue cleared',
        'info',
        2000,
        'queue-management'
      );
    });
  });

  describe('resetAnalysisState', () => {
    test('resets all analysis state', () => {
      const removeItem = jest.fn();
      global.localStorage = { removeItem };

      const { result } = renderHook(() => useAnalysis(createMockOptions()));

      act(() => {
        result.current.resetAnalysisState('test');
      });

      expect(mockSetIsAnalyzing).toHaveBeenCalledWith(false);
      expect(mockSetAnalysisProgress).toHaveBeenCalledWith({
        current: 0,
        total: 0,
        currentFile: '',
        lastActivity: 0
      });
      expect(mockSetCurrentAnalysisFile).toHaveBeenCalledWith('');
    });

    test('removes workflow state from localStorage', () => {
      const removeItem = jest.fn();
      Object.defineProperty(window, 'localStorage', {
        value: { removeItem },
        writable: true
      });

      const { result } = renderHook(() => useAnalysis(createMockOptions()));

      act(() => {
        result.current.resetAnalysisState('test');
      });

      expect(removeItem).toHaveBeenCalledWith('stratosort_workflow_state');
    });

    test('handles localStorage errors gracefully', () => {
      Object.defineProperty(window, 'localStorage', {
        value: {
          removeItem: () => {
            throw new Error('Storage error');
          }
        },
        writable: true
      });

      const { result } = renderHook(() => useAnalysis(createMockOptions()));

      expect(() => {
        act(() => {
          result.current.resetAnalysisState('test');
        });
      }).not.toThrow();
    });

    test('preserves completed batch subset when reset is triggered mid-run', async () => {
      const files = Array.from({ length: 40 }, (_, index) => ({
        path: `/reset-batch/file-${index}.txt`,
        name: `file-${index}.txt`
      }));

      let resolveBatch;
      const batchPromise = new Promise((resolve) => {
        resolveBatch = resolve;
      });

      mockElectronAPI.settings.get.mockResolvedValueOnce({
        maxConcurrentAnalysis: 1
      });
      mockElectronAPI.analysis.batch.mockReturnValueOnce(batchPromise);

      const { result } = renderHook(() =>
        useAnalysis(
          createMockOptions({
            selectedFiles: files
          })
        )
      );

      let analyzePromise;
      await act(async () => {
        analyzePromise = result.current.analyzeFiles(files);
        jest.advanceTimersByTime(50);
        await Promise.resolve();
      });

      const progressEvent = (completed, currentFile) =>
        new CustomEvent('operation-progress', {
          detail: {
            type: 'batch_analyze',
            batchId: mockElectronAPI.analysis.batch.mock.calls[0][0].batchId,
            completed,
            total: files.length,
            currentFile
          }
        });

      act(() => {
        window.dispatchEvent(progressEvent(1, files[0].path));
        window.dispatchEvent(progressEvent(2, files[1].path));
        result.current.resetAnalysisState('Analysis lock timeout');
      });

      // Main process returns only the 2 files it completed before cancel (partial results)
      const completedCount = 2;
      resolveBatch({
        success: true,
        cancelled: true,
        results: files.slice(0, completedCount).map((file) => ({
          filePath: file.path,
          success: true,
          result: {
            category: 'documents',
            suggestedName: `${file.name}-done`
          }
        })),
        errors: [],
        total: files.length,
        successful: completedCount
      });

      await act(async () => {
        await analyzePromise;
      });

      const resultArrayCalls = mockSetAnalysisResults.mock.calls
        .map((call) => call[0])
        .filter((value) => Array.isArray(value));
      expect(resultArrayCalls.length).toBeGreaterThan(0);
      const lastResults = resultArrayCalls[resultArrayCalls.length - 1];
      expect(lastResults).toHaveLength(2);
      expect(lastResults.map((item) => item.path)).toEqual(files.slice(0, 2).map((f) => f.path));
    });
  });

  describe('generatePreviewName', () => {
    test('calls utility function with naming settings', () => {
      const { result } = renderHook(() => useAnalysis(createMockOptions()));
      const generatePreviewNameUtil =
        require('../src/renderer/phases/discover/namingUtils').generatePreviewName;

      result.current.generatePreviewName('test.txt');

      expect(generatePreviewNameUtil).toHaveBeenCalledWith('test.txt', {
        convention: 'original',
        separator: '-',
        dateFormat: 'YYYY-MM-DD',
        caseConvention: 'original'
      });
    });
  });

  describe('cleanup on unmount', () => {
    test('cleans up intervals and timeouts', () => {
      const { unmount } = renderHook(() => useAnalysis(createMockOptions()));

      // Should not throw
      expect(() => unmount()).not.toThrow();
    });
  });

  describe('a run left behind by leaving Discover', () => {
    // Leaving Discover stops the run, but its batch request returns only
    // when main has let go of the file it was on. Its cleanup runs then.
    const files = Array.from({ length: 40 }, (_, index) => ({
      path: '/left-behind/file-' + index + '.txt',
      name: 'file-' + index + '.txt'
    }));
    const stopped = { success: false, cancelled: true, results: [], errors: [], total: 40 };
    const finishedBatch = {
      success: true,
      results: files.map((file) => ({
        filePath: file.path,
        success: true,
        result: { category: 'documents', suggestedName: 'done' }
      })),
      errors: [],
      total: files.length,
      successful: files.length
    };
    let releases;

    beforeEach(() => {
      releases = [];
      mockElectronAPI.analysis.batch.mockImplementation(
        () =>
          new Promise((resolve) => {
            releases.push(resolve);
          })
      );
    });
    afterEach(() => {
      mockElectronAPI.analysis.batch.mockReset();
    });

    async function startRun(selectedFiles, completed) {
      const hook = renderHook(() => useAnalysis(createMockOptions({ selectedFiles })));
      const sentBefore = releases.length;
      let pending;
      await act(async () => {
        pending = hook.result.current.analyzeFiles(files);
        await jest.advanceTimersByTimeAsync(50);
      });
      expect(releases).toHaveLength(sentBefore + 1);
      if (completed > 0) {
        const { batchId } = mockElectronAPI.analysis.batch.mock.calls[sentBefore][0];
        act(() => {
          window.dispatchEvent(
            new CustomEvent('operation-progress', {
              detail: {
                type: 'batch_analyze',
                batchId,
                completed,
                total: files.length,
                currentFile: files[completed - 1].path
              }
            })
          );
        });
      }
      const settle = async (index, result) => {
        await act(async () => {
          releases[index](result);
          await jest.advanceTimersByTimeAsync(1000);
          await pending;
        });
      };
      return { hook, settle };
    }
    const idleProgress = { current: 0, total: 0, lastActivity: 0 };

    test.each([
      ['had reached its last file', 40],
      ['was part way through', 12]
    ])(
      'does not write over the run a returning Discover started when it %s',
      async (_label, completed) => {
        const first = await startRun(files, completed);
        first.hook.unmount();
        const second = await startRun([], 0);
        mockSetIsAnalyzing.mockClear();
        mockSetAnalysisProgress.mockClear();
        mockSetFileStates.mockClear();

        await first.settle(0, stopped);

        expect(mockSetIsAnalyzing).not.toHaveBeenCalledWith(false);
        expect(mockSetAnalysisProgress).not.toHaveBeenCalledWith(idleProgress);
        expect(mockSetFileStates).not.toHaveBeenCalled();

        // The run that owns the state still clears it when it ends.
        await second.settle(1, finishedBatch);
        expect(mockSetIsAnalyzing).toHaveBeenCalledWith(false);
        expect(mockSetAnalysisProgress).toHaveBeenCalledWith(idleProgress);
        second.hook.unmount();
      }
    );

    test('still tidies up when no other run has started', async () => {
      const first = await startRun(files, 12);
      first.hook.unmount();
      mockSetFileStates.mockClear();

      await first.settle(0, stopped);

      // Files it had marked as in progress go back to waiting.
      expect(mockSetFileStates).toHaveBeenCalledWith(expect.any(Function));
    });
  });

  describe('analysis resume on mount', () => {
    test('resumes analysis for remaining files', async () => {
      const options = createMockOptions({
        isAnalyzing: true,
        selectedFiles: [
          { path: '/test1.txt', name: 'test1.txt' },
          { path: '/test2.txt', name: 'test2.txt' }
        ],
        fileStates: {
          '/test1.txt': { state: 'ready' },
          '/test2.txt': { state: 'pending' }
        }
      });

      renderHook(() => useAnalysis(options));

      // Wait for useEffect
      await act(async () => {
        jest.advanceTimersByTime(100);
      });

      // Should show resume notification
      expect(mockAddNotification).toHaveBeenCalledWith(
        expect.stringContaining('Resuming analysis'),
        'info',
        3000,
        'analysis-resume'
      );
    });

    test('resets if no remaining files', async () => {
      const options = createMockOptions({
        isAnalyzing: true,
        selectedFiles: [{ path: '/test.txt', name: 'test.txt' }],
        fileStates: {
          '/test.txt': { state: 'ready' }
        }
      });

      renderHook(() => useAnalysis(options));

      await act(async () => {
        jest.advanceTimersByTime(100);
      });

      // Should reset since all files are complete
      expect(mockSetIsAnalyzing).toHaveBeenCalledWith(false);
    });

    test('does NOT show "Resuming" notification for fresh analysis started by analyzeFiles', async () => {
      // This tests the fix for the UX bug where selecting a file would show:
      // 1. "Starting AI analysis..." (correct)
      // 2. "Resuming analysis..." (incorrect - should NOT appear for fresh analysis)
      const options = createMockOptions({
        isAnalyzing: false, // Start with analysis not running
        selectedFiles: [],
        fileStates: {}
      });

      const { result } = renderHook(() => useAnalysis(options));

      // Clear any previous notifications
      mockAddNotification.mockClear();

      // Start a fresh analysis (simulating user selecting a file)
      await act(async () => {
        result.current.analyzeFiles([{ path: '/fresh.pdf', name: 'fresh.pdf' }]);
        jest.advanceTimersByTime(100);
      });

      // Should show "Starting" notification but NOT "Resuming" notification
      const notificationCalls = mockAddNotification.mock.calls;
      const startingNotifications = notificationCalls.filter((call) =>
        call[0].includes('Starting AI analysis')
      );
      const resumingNotifications = notificationCalls.filter((call) =>
        call[0].includes('Resuming')
      );

      expect(startingNotifications.length).toBeGreaterThan(0);
      expect(resumingNotifications.length).toBe(0);
    });

    test('preserves already-completed batch results when cancelled', async () => {
      const files = Array.from({ length: 40 }, (_, index) => ({
        path: `/cancelled-batch/file-${index}.txt`,
        name: `file-${index}.txt`
      }));

      let resolveBatch;
      const batchPromise = new Promise((resolve) => {
        resolveBatch = resolve;
      });

      mockElectronAPI.settings.get.mockResolvedValueOnce({
        maxConcurrentAnalysis: 1
      });
      mockElectronAPI.analysis.batch.mockReturnValueOnce(batchPromise);

      const { result } = renderHook(() =>
        useAnalysis(
          createMockOptions({
            selectedFiles: files
          })
        )
      );

      let analyzePromise;
      await act(async () => {
        analyzePromise = result.current.analyzeFiles(files);
        jest.advanceTimersByTime(50);
        await Promise.resolve();
      });

      const progressEvent = (completed, currentFile) =>
        new CustomEvent('operation-progress', {
          detail: {
            type: 'batch_analyze',
            batchId: mockElectronAPI.analysis.batch.mock.calls[0][0].batchId,
            completed,
            total: files.length,
            currentFile
          }
        });

      act(() => {
        window.dispatchEvent(progressEvent(1, files[0].path));
        window.dispatchEvent(progressEvent(2, files[1].path));
        window.dispatchEvent(progressEvent(3, files[2].path));
        result.current.cancelAnalysis();
      });

      // Main process returns only the 3 files it completed before cancel (partial results)
      const completedCount = 3;
      resolveBatch({
        success: true,
        cancelled: true,
        results: files.slice(0, completedCount).map((file) => ({
          filePath: file.path,
          success: true,
          result: {
            category: 'documents',
            suggestedName: `${file.name}-done`
          }
        })),
        errors: [],
        total: files.length,
        successful: completedCount
      });

      await act(async () => {
        await analyzePromise;
      });

      const resultArrayCalls = mockSetAnalysisResults.mock.calls
        .map((call) => call[0])
        .filter((value) => Array.isArray(value));
      expect(resultArrayCalls.length).toBeGreaterThan(0);
      const lastResults = resultArrayCalls[resultArrayCalls.length - 1];
      expect(lastResults).toHaveLength(3);
      expect(lastResults.map((item) => item.path)).toEqual(files.slice(0, 3).map((f) => f.path));
    });

    test('progress from another sender does not take the batch over', async () => {
      // Reanalyze All reported on the same channel with the same type. The
      // batch adopted the first foreign id it saw: its own progress was then
      // dropped and Stop asked main to cancel an id it did not know.
      const files = Array.from({ length: 40 }, (_, index) => ({
        path: `/own-batch/file-${index}.txt`,
        name: `file-${index}.txt`
      }));

      let resolveBatch;
      const batchPromise = new Promise((resolve) => {
        resolveBatch = resolve;
      });
      mockElectronAPI.settings.get.mockResolvedValueOnce({ maxConcurrentAnalysis: 1 });
      mockElectronAPI.analysis.batch.mockReturnValueOnce(batchPromise);
      mockElectronAPI.analysis.cancelBatch = jest.fn().mockResolvedValue({ cancelled: true });

      try {
        const { result } = renderHook(() =>
          useAnalysis(createMockOptions({ selectedFiles: files }))
        );

        let analyzePromise;
        await act(async () => {
          analyzePromise = result.current.analyzeFiles(files);
          jest.advanceTimersByTime(50);
          await Promise.resolve();
        });

        const clientBatchId = mockElectronAPI.analysis.batch.mock.calls[0][0].batchId;
        const progressEvent = (batchId, completed, currentFile) =>
          new CustomEvent('operation-progress', {
            detail: { type: 'batch_analyze', batchId, completed, total: 9, currentFile }
          });

        mockSetCurrentAnalysisFile.mockClear();
        act(() => {
          window.dispatchEvent(progressEvent('reanalyze-all-1', 5, '/elsewhere/other.txt'));
        });
        expect(mockSetCurrentAnalysisFile).not.toHaveBeenCalledWith('other.txt');

        act(() => {
          window.dispatchEvent(progressEvent(clientBatchId, 1, files[0].path));
        });
        expect(mockSetCurrentAnalysisFile).toHaveBeenCalledWith('file-0.txt');

        act(() => {
          result.current.cancelAnalysis();
        });
        expect(mockElectronAPI.analysis.cancelBatch).toHaveBeenCalledWith(
          expect.objectContaining({ batchId: clientBatchId })
        );

        resolveBatch({
          success: true,
          cancelled: true,
          results: [],
          errors: [],
          total: files.length,
          successful: 0
        });
        await act(async () => {
          await analyzePromise;
        });
      } finally {
        delete mockElectronAPI.analysis.cancelBatch;
      }
    });

    test('hydrates completed ready-queue entries immediately when cancelled', async () => {
      const files = Array.from({ length: 40 }, (_, index) => ({
        path: `/cancel-immediate/file-${index}.txt`,
        name: `file-${index}.txt`
      }));

      let resolveBatch;
      const batchPromise = new Promise((resolve) => {
        resolveBatch = resolve;
      });

      mockElectronAPI.settings.get.mockResolvedValueOnce({
        maxConcurrentAnalysis: 1
      });
      mockElectronAPI.analysis.batch.mockReturnValueOnce(batchPromise);
      mockElectronAPI.analysis.getReadyQueue.mockResolvedValueOnce({
        success: true,
        readyFiles: [
          {
            path: files[0].path,
            name: files[0].name,
            size: 123,
            created: null,
            modified: null,
            analyzedAt: '2026-03-23T00:00:00.000Z',
            analysis: {
              category: 'documents',
              suggestedName: `${files[0].name}-done`
            }
          }
        ]
      });

      const { result } = renderHook(() =>
        useAnalysis(
          createMockOptions({
            selectedFiles: files
          })
        )
      );

      await act(async () => {
        result.current.analyzeFiles(files);
        jest.advanceTimersByTime(50);
        await Promise.resolve();
      });

      await act(async () => {
        result.current.cancelAnalysis();
        await Promise.resolve();
        await Promise.resolve();
      });

      const resultArrayCalls = mockSetAnalysisResults.mock.calls
        .map((call) => call[0])
        .filter((value) => Array.isArray(value));

      expect(resultArrayCalls.length).toBeGreaterThan(0);
      const lastResults = resultArrayCalls[resultArrayCalls.length - 1];
      expect(lastResults).toHaveLength(1);
      expect(lastResults[0].path).toBe(files[0].path);

      resolveBatch({
        success: true,
        cancelled: true,
        results: [],
        errors: [],
        total: files.length,
        successful: 1
      });
    });
  });
});

describe('shouldUseBatchAnalysis', () => {
  let shouldUseBatchAnalysis;
  let BATCH_ANALYSIS_MIN_FILES;
  let BATCH_ANALYSIS_LOW_VRAM_MIN_FILES;

  beforeEach(() => {
    jest.resetModules();
    ({
      shouldUseBatchAnalysis,
      BATCH_ANALYSIS_MIN_FILES,
      BATCH_ANALYSIS_LOW_VRAM_MIN_FILES
    } = require('../src/renderer/phases/discover/useAnalysis'));
  });

  test('uses batch path for low-VRAM sequential runs with at least 3 files', () => {
    expect(BATCH_ANALYSIS_LOW_VRAM_MIN_FILES).toBe(3);
    expect(shouldUseBatchAnalysis(19, 1, 1)).toBe(true);
    expect(shouldUseBatchAnalysis(2, 1, 1)).toBe(false);
  });

  test('keeps legacy 40-file threshold when hardware allows higher concurrency', () => {
    expect(BATCH_ANALYSIS_MIN_FILES).toBe(40);
    expect(shouldUseBatchAnalysis(39, 2, 2)).toBe(false);
    expect(shouldUseBatchAnalysis(40, 2, 2)).toBe(true);
    expect(shouldUseBatchAnalysis(40, 3, 2)).toBe(false);
  });

  test('a run with audio or video uses the batch path whatever its size', () => {
    expect(shouldUseBatchAnalysis(1, 3, 3, true)).toBe(true);
    expect(shouldUseBatchAnalysis(1, 3, 3, false)).toBe(false);
    expect(shouldUseBatchAnalysis(0, 3, 3, true)).toBe(false);
  });

  test('recognizes audio and video by extension', () => {
    const { isMediaFilePath } = require('../src/renderer/phases/discover/useAnalysis');
    expect(isMediaFilePath('C:\\Recordings\\Meeting.MP3')).toBe(true);
    expect(isMediaFilePath('/clips/holiday.mov')).toBe(true);
    expect(isMediaFilePath('/docs/notes.txt')).toBe(false);
    expect(isMediaFilePath('/archive.mp4/readme')).toBe(false);
    expect(isMediaFilePath(undefined)).toBe(false);
  });
});

describe('applyAnalysisOutcome naming trust', () => {
  const { resolveDiscoverSuggestedName } = require('../src/shared/namingConventions');

  test('preserves main-process suggestedName when llmSuggestedName is set (null renderer timestamps)', () => {
    const namingSettings = {
      convention: 'subject-date',
      separator: '-',
      dateFormat: 'YYYY-MM-DD',
      caseConvention: 'kebab-case'
    };
    const name = resolveDiscoverSuggestedName({
      originalFileName: 'Timeline 1.mp4',
      analysis: {
        llmSuggestedName: 'Timeline 1',
        suggestedName: 'timeline-1-2026-06-01.mp4',
        category: 'video'
      },
      settings: namingSettings,
      fileTimestamps: { modified: null, created: null },
      trustMainProcess: true
    });
    expect(name).toBe('timeline-1-2026-06-01.mp4');
  });
});

describe('useAnalysis — a run aborted during start-up', () => {
  // Live run (dev build, React StrictMode): Discover remounted, the resume
  // started a run, StrictMode's simulated unmount aborted it during its 10 ms
  // start-up pause, and the run still sent its batch. An aborted run's
  // listeners ignore every event, so no result reached the list ("0 ready")
  // until the 5-minute inactivity lock cancelled the batch.
  const useAnalysis = (opts) => useAnalysisOriginal(opts);
  const files = Array.from({ length: 40 }, (_, i) => ({
    path: `/batch/file-${i}.txt`,
    name: `file-${i}.txt`
  }));
  const setters = () => ({
    setIsAnalyzing: jest.fn(),
    setAnalysisProgress: jest.fn(),
    setCurrentAnalysisFile: jest.fn(),
    setAnalysisResults: jest.fn(),
    setFileStates: jest.fn()
  });
  const options = (overrides = {}) => ({
    selectedFiles: files,
    fileStates: {},
    analysisResults: [],
    isAnalyzing: false,
    analysisProgress: { current: 0, total: 0 },
    namingSettings: { convention: 'original', separator: '-', dateFormat: 'YYYY-MM-DD' },
    setters: setters(),
    updateFileState: jest.fn(),
    addNotification: jest.fn(),
    actions: { setPhaseData: jest.fn(), advancePhase: jest.fn() },
    ...overrides
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    global.window.electronAPI = mockElectronAPI;
    mockElectronAPI.analysis.batch.mockResolvedValue({
      success: true,
      results: files.map((file) => ({
        filePath: file.path,
        success: true,
        result: { category: 'documents', suggestedName: `${file.name}-done` }
      })),
      errors: [],
      total: files.length,
      successful: files.length
    });
    mockElectronAPI.analysis.getReadyQueue.mockResolvedValue({ success: true, readyFiles: [] });
    mockElectronAPI.settings.get.mockResolvedValue({ maxConcurrentAnalysis: 3 });
  });

  afterEach(() => {
    dropParkedResume();
    jest.useRealTimers();
  });

  test('an unmount during the start-up pause sends no batch', async () => {
    const opts = options();
    const { result, unmount } = renderHook(() => useAnalysis(opts));
    let promise;
    await act(async () => {
      promise = result.current.analyzeFiles(files);
    });
    unmount();
    await act(async () => {
      jest.advanceTimersByTime(100);
      await promise;
    });
    expect(mockElectronAPI.analysis.batch).not.toHaveBeenCalled();
    expect(opts.addNotification).not.toHaveBeenCalledWith(
      expect.stringMatching(/complete/i),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  test('under StrictMode a resumed run sends one batch and its results reach the list', async () => {
    const opts = options({
      isAnalyzing: true,
      fileStates: Object.fromEntries(files.map((f) => [f.path, { state: 'pending' }]))
    });
    renderHook(() => useAnalysis(opts), { wrapper: React.StrictMode });
    for (let i = 0; i < 10; i += 1) {
      await act(async () => {
        jest.advanceTimersByTime(500);
      });
    }
    expect(mockElectronAPI.analysis.batch).toHaveBeenCalledTimes(1);
    const applied = opts.setters.setAnalysisResults.mock.calls
      .map((call) => call[0])
      .filter(Array.isArray)
      .pop();
    expect(applied).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: '/batch/file-0.txt' })])
    );
  });

  describe('under StrictMode, the run that replaces the aborted one', () => {
    // The resume on the second mount takes the lock over from the run the
    // simulated unmount aborted. That run was still in its start-up pause,
    // and went on after it as if nothing had happened.
    const { TIMEOUTS } = require('../src/shared/performanceConstants');
    let opts;
    let finishBatch;

    beforeEach(async () => {
      mockElectronAPI.analysis.batch.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishBatch = () => resolve({ success: true, results: [], errors: [] });
          })
      );
      opts = options({
        isAnalyzing: true,
        fileStates: Object.fromEntries(files.map((f) => [f.path, { state: 'pending' }]))
      });
      renderHook(() => useAnalysis(opts), { wrapper: React.StrictMode });
      await act(async () => {
        jest.advanceTimersByTime(500);
      });
      expect(mockElectronAPI.analysis.batch).toHaveBeenCalledTimes(1);
    });

    afterEach(async () => {
      await act(async () => {
        finishBatch();
        await jest.advanceTimersByTimeAsync(1000);
      });
    });

    test('is the only one that reports an analysis as started', () => {
      const started = opts.setters.setIsAnalyzing.mock.calls.filter((call) => call[0] === true);

      expect(started).toEqual([[true, { total: files.length }]]);
    });

    test('keeps its heartbeat', async () => {
      // The aborted run started a heartbeat of its own. Its first tick saw
      // that its run was over and stopped the heartbeat in use, which by
      // then was the replacing run's; and it kept ticking, so it stopped
      // the heartbeat of every run after that as well.
      const batchSentAt = Date.now();
      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          jest.advanceTimersByTime(TIMEOUTS.HEARTBEAT_INTERVAL);
        });
      }

      const beats = opts.setters.setAnalysisProgress.mock.calls
        .map((call) => call[0])
        .filter((progress) => progress?.lastActivity >= batchSentAt + TIMEOUTS.HEARTBEAT_INTERVAL);
      expect(beats.length).toBeGreaterThanOrEqual(2);
    });
  });
});
