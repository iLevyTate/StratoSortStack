/**
 * @jest-environment jsdom
 *
 * The analysis run lives in AnalysisRunProvider, above the phase screens.
 * Moving from Discover to Organize must not unmount it: when the run lived
 * in Discover, leaving Discover cancelled it, so a long run locked every
 * phase tab and earlier analyzed files could not be organized meanwhile.
 */
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockRunLifecycle = { mounts: 0, unmounts: 0 };
let mockUseAnalysisOptions = null;
const mockAnalyzeFiles = jest.fn();

jest.mock('react-redux', () => ({
  useStore: () => ({ getState: () => ({ analysis: { isAnalyzing: false } }) })
}));

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

jest.mock('../../src/renderer/phases/discover/useAnalysis', () => {
  const React = require('react');
  return {
    useAnalysis: (options) => {
      mockUseAnalysisOptions = options;
      React.useEffect(() => {
        mockRunLifecycle.mounts += 1;
        return () => {
          mockRunLifecycle.unmounts += 1;
        };
      }, []);
      return {
        analyzeFiles: mockAnalyzeFiles,
        cancelAnalysis: jest.fn(),
        clearAnalysisQueue: jest.fn(),
        retryFailedFiles: jest.fn(),
        pruneBatchResultsForPath: jest.fn()
      };
    }
  };
});

import {
  AnalysisRunProvider,
  useAnalysisRun
} from '../../src/renderer/phases/discover/AnalysisRunProvider';

function DiscoverLike() {
  const run = useAnalysisRun();
  return (
    <div>
      Discover
      {run.totalAnalysisFailure && <span>All failed</span>}
    </div>
  );
}

describe('AnalysisRunProvider', () => {
  beforeEach(() => {
    mockRunLifecycle.mounts = 0;
    mockRunLifecycle.unmounts = 0;
    mockUseAnalysisOptions = null;
  });

  test('the run survives leaving Discover for another phase', () => {
    const { rerender } = render(
      <AnalysisRunProvider>
        <DiscoverLike />
      </AnalysisRunProvider>
    );
    expect(mockRunLifecycle.mounts).toBe(1);

    rerender(
      <AnalysisRunProvider>
        <div>Organize</div>
      </AnalysisRunProvider>
    );
    rerender(
      <AnalysisRunProvider>
        <DiscoverLike />
      </AnalysisRunProvider>
    );

    expect(screen.getByText('Discover')).toBeInTheDocument();
    expect(mockRunLifecycle.mounts).toBe(1);
    expect(mockRunLifecycle.unmounts).toBe(0);
  });

  test('Discover reads the run actions from the provider', () => {
    let seen;
    function Probe() {
      seen = useAnalysisRun();
      return null;
    }
    render(
      <AnalysisRunProvider>
        <Probe />
      </AnalysisRunProvider>
    );
    expect(seen.analyzeFiles).toBe(mockAnalyzeFiles);
  });

  test('a total analysis failure reported by the run reaches Discover', () => {
    render(
      <AnalysisRunProvider>
        <DiscoverLike />
      </AnalysisRunProvider>
    );
    expect(screen.queryByText('All failed')).not.toBeInTheDocument();

    act(() => {
      mockUseAnalysisOptions.actions.setPhaseData('totalAnalysisFailure', true);
    });

    expect(screen.getByText('All failed')).toBeInTheDocument();
  });

  test('useAnalysisRun outside the provider fails loudly', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => render(<DiscoverLike />)).toThrow(/inside AnalysisRunProvider/);
    } finally {
      spy.mockRestore();
    }
  });
});
