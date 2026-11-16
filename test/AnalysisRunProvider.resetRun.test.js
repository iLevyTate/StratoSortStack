/**
 * @jest-environment jsdom
 *
 * AnalysisRunProvider hands phases the run's own reset as resetRun. It must
 * be useAnalysis's resetAnalysisState, which aborts the run and releases its
 * lock, not useDiscoverState's, which clears only Redux and would leave the
 * run going unseen.
 */
import React from 'react';
import { render } from '@testing-library/react';

const mockRunReset = jest.fn();
const mockReduxOnlyReset = jest.fn();
let mockAnalysisState = { isAnalyzing: false };

jest.mock('react-redux', () => ({
  useStore: () => ({ getState: () => ({ analysis: mockAnalysisState }) })
}));

jest.mock('../src/renderer/contexts/NotificationContext', () => ({
  useNotification: () => ({ addNotification: jest.fn() })
}));

jest.mock('../src/renderer/phases/discover/useDiscoverState', () => ({
  useDiscoverState: () => ({
    selectedFiles: [],
    analysisResults: [],
    isAnalyzing: mockAnalysisState.isAnalyzing,
    analysisProgress: mockAnalysisState.analysisProgress || { current: 0, total: 0 },
    fileStates: {},
    namingSettings: {},
    setIsAnalyzing: jest.fn(),
    setAnalysisProgress: jest.fn(),
    setCurrentAnalysisFile: jest.fn(),
    setAnalysisResults: jest.fn(),
    setFileStates: jest.fn(),
    updateFileState: jest.fn(),
    resetAnalysisState: mockReduxOnlyReset,
    actions: { setPhaseData: jest.fn(), advancePhase: jest.fn() },
    getCurrentPhase: () => 'complete'
  })
}));

jest.mock('../src/renderer/phases/discover/useAnalysis', () => ({
  useAnalysis: () => ({
    analyzeFiles: jest.fn(),
    cancelAnalysis: jest.fn(),
    clearAnalysisQueue: jest.fn(),
    retryFailedFiles: jest.fn(),
    reanalyzeFiles: jest.fn(),
    pruneBatchResultsForPath: jest.fn(),
    resetAnalysisState: mockRunReset
  })
}));

import {
  AnalysisRunProvider,
  useAnalysisRun
} from '../src/renderer/phases/discover/AnalysisRunProvider';

afterEach(() => {
  mockRunReset.mockReset();
  mockReduxOnlyReset.mockReset();
  mockAnalysisState = { isAnalyzing: false };
});

test('resetRun is the run reset from useAnalysis, not the Redux-only one', () => {
  let run;
  function Probe() {
    run = useAnalysisRun();
    return null;
  }
  render(
    <AnalysisRunProvider>
      <Probe />
    </AnalysisRunProvider>
  );

  run.resetRun('Analyze more files');

  expect(mockRunReset).toHaveBeenCalledWith('Analyze more files');
  expect(mockReduxOnlyReset).not.toHaveBeenCalled();
});

test('the stuck-run watchdog uses the run reset, which keeps finished results', () => {
  // The Redux-only reset returns the slice to its initial state, which wiped
  // every result, and left the run's lock held so a retry was refused.
  mockAnalysisState = {
    isAnalyzing: true,
    analysisProgress: { current: 3, total: 10, lastActivity: Date.now() - 6 * 60 * 1000 }
  };
  const { unmount } = render(
    <AnalysisRunProvider>
      <div />
    </AnalysisRunProvider>
  );

  expect(mockRunReset).toHaveBeenCalledWith(expect.stringMatching(/stuck|stalled/i));
  expect(mockReduxOnlyReset).not.toHaveBeenCalled();
  unmount();
});
