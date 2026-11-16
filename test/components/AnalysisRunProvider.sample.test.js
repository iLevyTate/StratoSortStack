/**
 * @jest-environment jsdom
 *
 * The provider hands Discover an analyzeFiles behind the sample offer: a
 * large batch of added files opens the "Try a few files first?" dialog
 * instead of starting a two-hour run on folders nobody has tried yet.
 */
import React from 'react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { render, screen, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import uiReducer from '../../src/renderer/store/slices/uiSlice';
import filesReducer, { setSmartFolders } from '../../src/renderer/store/slices/filesSlice';
import analysisReducer from '../../src/renderer/store/slices/analysisSlice';

const mockAnalyzeFiles = jest.fn(async () => ({ started: true }));

jest.mock('../../src/renderer/contexts/NotificationContext', () => ({
  useNotification: () => ({ addNotification: jest.fn() })
}));

jest.mock('../../src/renderer/phases/discover/useDiscoverState', () => {
  const actions = { setPhaseData: jest.fn(), advancePhase: jest.fn() };
  return {
    useDiscoverState: () => ({
      selectedFiles: [],
      analysisResults: [],
      isAnalyzing: false,
      analysisProgress: { current: 0, total: 0 },
      fileStates: {},
      namingSettings: {},
      setIsAnalyzing: jest.fn(),
      setAnalysisProgress: jest.fn(),
      setCurrentAnalysisFile: jest.fn(),
      setAnalysisResults: jest.fn(),
      setFileStates: jest.fn(),
      updateFileState: jest.fn(),
      resetAnalysisState: jest.fn(),
      actions,
      getCurrentPhase: () => 'discover'
    })
  };
});

jest.mock('../../src/renderer/phases/discover/useAnalysis', () => ({
  useAnalysis: () => ({
    analyzeFiles: mockAnalyzeFiles,
    cancelAnalysis: jest.fn(),
    clearAnalysisQueue: jest.fn(),
    retryFailedFiles: jest.fn(),
    reanalyzeFiles: jest.fn(),
    pruneBatchResultsForPath: jest.fn(),
    resetAnalysisState: jest.fn()
  })
}));

import {
  AnalysisRunProvider,
  useAnalysisRun
} from '../../src/renderer/phases/discover/AnalysisRunProvider';

const files = Array.from({ length: 25 }, (_, i) => ({
  path: `/Users/alex/Inbox/scan-${i}.pdf`,
  name: `scan-${i}.pdf`
}));

function setup() {
  const store = configureStore({
    reducer: {
      ui: uiReducer,
      files: filesReducer,
      analysis: analysisReducer,
      system: () => ({ redactPaths: false, redactPathsLoaded: true })
    },
    middleware: (getDefault) => getDefault({ serializableCheck: false, immutableCheck: false })
  });
  store.dispatch(
    setSmartFolders([
      {
        id: 'f-inv',
        name: 'Invoices',
        description: 'Bills and invoices from suppliers',
        path: '/Users/alex/Library/Invoices'
      }
    ])
  );
  let run;
  function Probe() {
    run = useAnalysisRun();
    return null;
  }
  render(
    <Provider store={store}>
      <AnalysisRunProvider>
        <Probe />
      </AnalysisRunProvider>
    </Provider>
  );
  return { store, getRun: () => run };
}

afterEach(() => mockAnalyzeFiles.mockClear());

test('a large batch opens the sample offer instead of starting the run', async () => {
  const { getRun } = setup();
  let result;
  await act(async () => {
    result = await getRun().analyzeFiles(files);
  });
  expect(result).toEqual({ started: false, reason: 'sample-offered' });
  expect(mockAnalyzeFiles).not.toHaveBeenCalled();
  expect(screen.getByText('Try a few files first?')).toBeInTheDocument();
});

test('skipping from the dialog starts the whole batch', async () => {
  const { store, getRun } = setup();
  await act(async () => {
    await getRun().analyzeFiles(files);
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Analyze all 25 files' }));
  });
  expect(mockAnalyzeFiles).toHaveBeenCalledWith(files);
  expect(screen.queryByText('Try a few files first?')).not.toBeInTheDocument();
  expect(store.getState().ui.smartFolderSampleHash).toMatch(/^sf-/);
});
