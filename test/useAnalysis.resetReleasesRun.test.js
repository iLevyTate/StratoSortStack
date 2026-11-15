/**
 * "Analyze more files" on Complete resets the analysis run through
 * useAnalysis's own resetAnalysisState. A run still going when the user
 * reached Complete used to survive that click: Redux said nothing was
 * analyzing, yet the run kept its lock, so the next files were queued behind
 * a run the user could not see or stop.
 */
import { renderHook, act, cleanup } from '@testing-library/react';

jest.mock('react-redux', () => ({
  useStore: jest.fn(() => ({
    getState: jest.fn(() => ({ analysis: { isAnalyzing: false, progress: null } }))
  }))
}));

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
  validateProgressState: jest.fn(
    (progress) =>
      progress &&
      typeof progress.current === 'number' &&
      typeof progress.total === 'number' &&
      progress.current >= 0 &&
      progress.total >= 0
  ),
  generatePreviewName: jest.fn((name) => name),
  generateSuggestedNameFromAnalysis: jest.fn(({ originalFileName }) => originalFileName),
  makeUniqueFileName: jest.fn((candidate) => candidate),
  extractFileName: jest.fn((filePath) => {
    const parts = String(filePath || '').split(/[\\/]/);
    return parts[parts.length - 1] || String(filePath || '');
  })
}));

import { useAnalysis } from '../src/renderer/phases/discover/useAnalysis';

const group = (folder) =>
  Array.from({ length: 40 }, (_, index) => ({
    path: `${folder}/file-${index}.txt`,
    name: `file-${index}.txt`
  }));

describe('useAnalysis resetAnalysisState (Analyze more files)', () => {
  let electronAPI;
  let addNotification;
  let options;

  beforeEach(() => {
    jest.useFakeTimers();
    addNotification = jest.fn();
    electronAPI = {
      files: { analyze: jest.fn(() => new Promise(() => {})) },
      analysis: {
        // The first batch is the long run still going on Complete.
        batch: jest.fn(() => new Promise(() => {})),
        cancelBatch: jest.fn().mockResolvedValue({ success: true }),
        getReadyQueue: jest.fn().mockResolvedValue({ success: true, readyFiles: [] }),
        clearReadyQueue: jest.fn().mockResolvedValue({ success: true })
      },
      settings: { get: jest.fn().mockResolvedValue({ maxConcurrentAnalysis: 3 }) }
    };
    global.window.electronAPI = electronAPI;
    options = {
      selectedFiles: [],
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
        setIsAnalyzing: jest.fn(),
        setAnalysisProgress: jest.fn(),
        setCurrentAnalysisFile: jest.fn(),
        setAnalysisResults: jest.fn(),
        setFileStates: jest.fn()
      },
      updateFileState: jest.fn(),
      addNotification,
      actions: { setPhaseData: jest.fn(), advancePhase: jest.fn() },
      getCurrentPhase: () => 'discover'
    };
  });

  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  const startHiddenRun = async (result) => {
    await act(async () => {
      void result.current.analyzeFiles(group('/earlier'));
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(electronAPI.analysis.batch).toHaveBeenCalledTimes(1);
  };

  test('without the reset, new files wait behind the earlier run', async () => {
    const { result } = renderHook(() => useAnalysis(options));
    await startHiddenRun(result);

    let outcome;
    await act(async () => {
      outcome = await result.current.analyzeFiles(group('/next'));
    });

    expect(outcome).toEqual({ started: false, reason: 'queued' });
  });

  test('after the reset, the next files start right away', async () => {
    const { result } = renderHook(() => useAnalysis(options));
    await startHiddenRun(result);

    act(() => {
      result.current.resetAnalysisState('Analyze more files');
    });
    // The earlier batch is cancelled in main too, not left running.
    expect(electronAPI.analysis.cancelBatch).toHaveBeenCalledTimes(1);

    let nextRun;
    await act(async () => {
      nextRun = result.current.analyzeFiles(group('/next'));
      await jest.advanceTimersByTimeAsync(1000);
    });

    expect(electronAPI.analysis.batch).toHaveBeenCalledTimes(2);
    expect(electronAPI.analysis.batch.mock.calls[1][0].filePaths[0]).toBe('/next/file-0.txt');
    expect(addNotification).not.toHaveBeenCalledWith(
      'Analysis already running. These files start when it finishes.',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
    // The second run is in flight (its batch never settles), not queued.
    const settled = await Promise.race([nextRun, Promise.resolve('pending')]);
    expect(settled).toBe('pending');
  });

  // The cancelled batch can still answer from main after the reset. A plain
  // reset keeps a snapshot so a Stop keeps the files that finished; starting
  // over must not bring the old run's files back into Discover.
  test.each([
    [{}, true],
    [{ discard: true }, false]
  ])(
    'a late answer from the earlier batch after reset %o is applied: %s',
    async (opts, applied) => {
      let answerEarlierBatch;
      electronAPI.analysis.batch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            answerEarlierBatch = resolve;
          })
      );
      const { result } = renderHook(() => useAnalysis(options));
      await startHiddenRun(result);

      act(() => {
        result.current.resetAnalysisState('Analyze more files', opts);
      });
      options.setters.setAnalysisResults.mockClear();
      options.updateFileState.mockClear();

      await act(async () => {
        answerEarlierBatch({
          success: true,
          results: [
            {
              filePath: '/earlier/file-0.txt',
              success: true,
              result: { category: 'Docs', suggestedName: 'file-0.txt' }
            }
          ]
        });
        await jest.advanceTimersByTimeAsync(1000);
      });

      const touched =
        options.setters.setAnalysisResults.mock.calls.length +
          options.updateFileState.mock.calls.length >
        0;
      expect(touched).toBe(applied);
    }
  );
});
