/**
 * useAnalysis and Smart Folder definitions:
 *  - each result is stamped with the definitions it was analyzed under
 *    (analysis.smartFolderHash), so Organize can tell a result made under
 *    old definitions from a current one;
 *  - a sample run (origin 'sample') shows its results in the sample dialog,
 *    so it ends without the completion notice and without moving on to
 *    Organize. A normal run still does both.
 */
import * as React from 'react';
import { renderHook, act, cleanup } from '@testing-library/react';

const mockState = {
  analysis: { isAnalyzing: false, progress: null },
  files: { smartFolders: [] }
};

jest.mock('react-redux', () => ({
  useStore: jest.fn(() => ({ getState: jest.fn(() => mockState) }))
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

const { getFolderDefinitionsHash } = require('../src/shared/smartFolderDefinitions');

const FOLDERS = [
  {
    id: 'f-inv',
    name: 'Invoices',
    description: 'Bills and invoices from suppliers',
    path: '/Users/alex/Library/Invoices'
  }
];

function useStoreBackedAnalysis(baseOptions) {
  const [analysisResults, setResults] = React.useState([]);
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
  return { hook, analysisResults };
}

describe('useAnalysis with Smart Folder definitions', () => {
  let baseOptions;

  beforeEach(() => {
    jest.useFakeTimers();
    mockState.files.smartFolders = FOLDERS;
    global.window.electronAPI = {
      files: {
        analyze: jest.fn(async () => ({ category: 'Invoices', suggestedName: 'invoice.pdf' }))
      },
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
      namingSettings: {
        convention: 'keep-original',
        separator: '-',
        dateFormat: 'YYYY-MM-DD',
        caseConvention: 'none'
      },
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
      getCurrentPhase: () => 'discover'
    };
  });

  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  async function runAndSettle(result, files, runOptions) {
    await act(async () => {
      const run = result.current.hook.analyzeFiles(files, runOptions);
      await jest.advanceTimersByTimeAsync(1000);
      await run;
      // Past the 2 s auto-advance delay.
      await jest.advanceTimersByTimeAsync(3000);
    });
  }

  const files = [
    { path: '/Users/alex/Inbox/a.pdf', name: 'a.pdf' },
    { path: '/Users/alex/Inbox/b.pdf', name: 'b.pdf' }
  ];

  test('each result carries the folder definitions it was analyzed under', async () => {
    const { result } = renderHook(() => useStoreBackedAnalysis(baseOptions));
    await runAndSettle(result, files);

    const expected = getFolderDefinitionsHash(FOLDERS);
    expect(expected).toMatch(/^sf-/);
    expect(result.current.analysisResults).toHaveLength(2);
    for (const r of result.current.analysisResults) {
      expect(r.analysis.smartFolderHash).toBe(expected);
    }
  });

  test('a sample run ends without the completion notice or the move to Organize', async () => {
    const { result } = renderHook(() => useStoreBackedAnalysis(baseOptions));
    await runAndSettle(result, files, { origin: 'sample' });

    expect(result.current.analysisResults).toHaveLength(2);
    expect(baseOptions.setters.setIsAnalyzing).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ origin: 'sample' })
    );
    const completionCalls = baseOptions.addNotification.mock.calls.filter(
      (call) => call[3] === 'analysis-complete'
    );
    expect(completionCalls).toHaveLength(0);
    expect(baseOptions.actions.advancePhase).not.toHaveBeenCalled();
  });

  test('a normal run still reports completion and moves on to Organize', async () => {
    const { result } = renderHook(() => useStoreBackedAnalysis(baseOptions));
    await runAndSettle(result, files);

    const completionCalls = baseOptions.addNotification.mock.calls.filter(
      (call) => call[3] === 'analysis-complete'
    );
    expect(completionCalls).toHaveLength(1);
    expect(baseOptions.actions.advancePhase).toHaveBeenCalledWith('organize');
  });
});
