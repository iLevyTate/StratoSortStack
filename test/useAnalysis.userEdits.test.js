/**
 * Edits the user makes in Organize are saved into the analysis results, so
 * they survive an Organize remount. Two paths in useAnalysis used to undo
 * them:
 *  - the naming re-apply effect runs on every mount of the analysis provider
 *    (Dashboard view and back, app launch) and replaced a typed name with
 *    the convention name;
 *  - the end-of-run merge put the run's unedited copy of each result back
 *    over an edit made mid-run on a file the run had already finished.
 */
import * as React from 'react';
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

const mockGenerateName = jest.fn(({ originalFileName }) => originalFileName);

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
  generateSuggestedNameFromAnalysis: (args) => mockGenerateName(args),
  makeUniqueFileName: jest.fn((candidate) => candidate),
  extractFileName: jest.fn((filePath) => {
    const parts = String(filePath || '').split(/[\\/]/);
    return parts[parts.length - 1] || String(filePath || '');
  })
}));

import { useAnalysis } from '../src/renderer/phases/discover/useAnalysis';

const NAMING = {
  convention: 'subject-date',
  separator: '-',
  dateFormat: 'YYYY-MM-DD',
  caseConvention: 'kebab-case'
};

/**
 * Runs useAnalysis against React state standing in for the Redux store, so
 * what the setters write comes back as the next render's props, and the test
 * can make the same kind of edit Organize dispatches.
 */
function useStoreBackedAnalysis(initialResults, baseOptions) {
  const [analysisResults, setResults] = React.useState(initialResults);
  const [fileStates, setStates] = React.useState({});
  const setAnalysisResults = React.useCallback(
    (value) => setResults((prev) => (typeof value === 'function' ? value(prev) : value)),
    []
  );
  const setFileStates = React.useCallback(
    (value) => setStates((prev) => (typeof value === 'function' ? value(prev) : value)),
    []
  );
  const setters = React.useMemo(
    () => ({ ...baseOptions.setters, setAnalysisResults, setFileStates }),
    [baseOptions.setters, setAnalysisResults, setFileStates]
  );
  const hook = useAnalysis({ ...baseOptions, analysisResults, fileStates, setters });
  return { hook, analysisResults, setResults };
}

describe('useAnalysis keeps the user’s Organize edits', () => {
  let baseOptions;

  beforeEach(() => {
    jest.useFakeTimers();
    mockGenerateName.mockImplementation(({ originalFileName }) => originalFileName);
    global.window.electronAPI = {
      files: { analyze: jest.fn() },
      analysis: {
        batch: jest.fn(),
        cancelBatch: jest.fn().mockResolvedValue({ success: true }),
        getReadyQueue: jest.fn().mockResolvedValue({ success: true, readyFiles: [] }),
        clearReadyQueue: jest.fn().mockResolvedValue({ success: true })
      },
      settings: { get: jest.fn().mockResolvedValue({ maxConcurrentAnalysis: 3 }) }
    };
    baseOptions = {
      selectedFiles: [],
      isAnalyzing: false,
      analysisProgress: { current: 0, total: 0 },
      namingSettings: NAMING,
      setters: {
        setIsAnalyzing: jest.fn(),
        setAnalysisProgress: jest.fn(),
        setCurrentAnalysisFile: jest.fn(),
        setAnalysisResults: jest.fn(),
        setFileStates: jest.fn()
      },
      updateFileState: jest.fn(),
      addNotification: jest.fn(),
      actions: { setPhaseData: jest.fn(), advancePhase: jest.fn() },
      getCurrentPhase: () => 'organize'
    };
  });

  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  test('a typed name survives the naming re-apply on remount', () => {
    mockGenerateName.mockReturnValue('2024-03-01-tax-return.pdf');
    const stored = [
      {
        path: '/docs/taxes.pdf',
        name: 'taxes.pdf',
        analysis: {
          category: 'Finance',
          suggestedName: 'My 2024 taxes.pdf',
          userSuggestedName: 'My 2024 taxes.pdf',
          originalSuggestedName: 'tax-return.pdf'
        }
      },
      {
        path: '/docs/receipt.pdf',
        name: 'receipt.pdf',
        analysis: {
          category: 'Finance',
          suggestedName: 'receipt.pdf',
          originalSuggestedName: 'receipt.pdf'
        }
      }
    ];

    const { result } = renderHook(() => useStoreBackedAnalysis(stored, baseOptions));

    const byPath = Object.fromEntries(result.current.analysisResults.map((r) => [r.path, r]));
    expect(byPath['/docs/taxes.pdf'].analysis.suggestedName).toBe('My 2024 taxes.pdf');
    // Names the user did not type still follow the convention.
    expect(byPath['/docs/receipt.pdf'].analysis.suggestedName).toBe('2024-03-01-tax-return.pdf');
  });

  test('the end-of-run merge keeps an edit made on a file the run already finished', async () => {
    const deferred = {};
    window.electronAPI.files.analyze.mockImplementation(
      (filePath) =>
        new Promise((resolve) => {
          deferred[filePath] = resolve;
        })
    );
    const files = [
      { path: '/docs/a.pdf', name: 'a.pdf' },
      { path: '/docs/b.pdf', name: 'b.pdf' }
    ];

    const { result } = renderHook(() => useStoreBackedAnalysis([], baseOptions));

    let run;
    await act(async () => {
      run = result.current.hook.analyzeFiles(files);
      await jest.advanceTimersByTimeAsync(50);
    });
    expect(deferred['/docs/a.pdf']).toBeDefined();

    // The first file finishes and is shown.
    await act(async () => {
      deferred['/docs/a.pdf']({ category: 'Invoices', suggestedName: 'a-invoice.pdf' });
      await jest.advanceTimersByTimeAsync(500);
    });
    const shown = result.current.analysisResults.find((r) => r.path === '/docs/a.pdf');
    expect(shown?.analysis?.category).toBe('Invoices');

    // The user changes its folder and name in Organize while b still runs.
    act(() => {
      result.current.setResults((prev) =>
        prev.map((r) =>
          r.path === '/docs/a.pdf'
            ? {
                ...r,
                analysis: {
                  ...r.analysis,
                  category: 'Taxes',
                  userCategory: 'Taxes',
                  suggestedName: 'My invoice.pdf',
                  userSuggestedName: 'My invoice.pdf'
                }
              }
            : r
        )
      );
    });

    await act(async () => {
      deferred['/docs/b.pdf']({ category: 'Invoices', suggestedName: 'b-invoice.pdf' });
      await jest.advanceTimersByTimeAsync(500);
      await run;
    });

    const byPath = Object.fromEntries(result.current.analysisResults.map((r) => [r.path, r]));
    expect(byPath['/docs/a.pdf'].analysis.userCategory).toBe('Taxes');
    expect(byPath['/docs/a.pdf'].analysis.category).toBe('Taxes');
    expect(byPath['/docs/a.pdf'].analysis.suggestedName).toBe('My invoice.pdf');
    // The file still running when the edit was made is added at the end.
    expect(byPath['/docs/b.pdf'].analysis.category).toBe('Invoices');
    expect(result.current.analysisResults).toHaveLength(2);
  });
});
