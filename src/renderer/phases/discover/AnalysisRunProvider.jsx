import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { useStore } from 'react-redux';
import { TIMEOUTS } from '../../../shared/performanceConstants';
import { createLogger } from '../../../shared/logger';
import { useNotification } from '../../contexts/NotificationContext';
import { useDiscoverState } from './useDiscoverState';
import { useAnalysis } from './useAnalysis';

const logger = createLogger('AnalysisRunProvider');

const AnalysisRunContext = createContext(null);

/**
 * Owns the analysis run for the phased workflow. It sits in PhaseRenderer,
 * above the phase screens, so moving between Discover, Organize and Complete
 * no longer unmounts the run: files analyzed earlier can be reviewed and
 * organized while later ones are still analyzing. (When the run lived in
 * Discover, leaving Discover cancelled it, so the tabs were locked for the
 * whole run.) The dashboard replaces PhaseRenderer, so switching to it still
 * waits for the run to finish.
 *
 * Discover reads the run's actions through useAnalysisRun().
 */
export function AnalysisRunProvider({ children }) {
  const store = useStore();
  const {
    selectedFiles,
    analysisResults,
    isAnalyzing,
    analysisProgress,
    fileStates,
    namingSettings,
    setIsAnalyzing,
    setAnalysisProgress,
    setCurrentAnalysisFile,
    setAnalysisResults,
    setFileStates,
    updateFileState,
    resetAnalysisState,
    actions,
    getCurrentPhase
  } = useDiscoverState();
  const { addNotification } = useNotification();
  const [totalAnalysisFailure, setTotalAnalysisFailure] = useState(false);

  const extendedActions = useMemo(
    () => ({
      ...actions,
      setPhaseData: (key, value) => {
        if (key === 'totalAnalysisFailure') {
          setTotalAnalysisFailure(value);
        } else {
          actions.setPhaseData(key, value);
        }
      }
    }),
    [actions]
  );

  const {
    analyzeFiles,
    cancelAnalysis,
    clearAnalysisQueue,
    retryFailedFiles,
    pruneBatchResultsForPath
  } = useAnalysis({
    selectedFiles,
    fileStates,
    analysisResults,
    isAnalyzing,
    analysisProgress,
    namingSettings,
    setters: {
      setIsAnalyzing,
      setAnalysisProgress,
      setCurrentAnalysisFile,
      setAnalysisResults,
      setFileStates
    },
    updateFileState,
    addNotification,
    actions: extendedActions,
    getCurrentPhase
  });

  // Stuck-run checks. They belong with the run, not with the Discover
  // screen: a run that keeps going while the user is on Organize still
  // needs its watchdog.
  const initialStuckCheckRef = useRef(false);
  useEffect(() => {
    if (initialStuckCheckRef.current) return;
    initialStuckCheckRef.current = true;

    if (isAnalyzing) {
      const lastActivity = analysisProgress?.lastActivity || Date.now();
      if (Date.now() - lastActivity > 2 * 60 * 1000) {
        logger.info('Detected stuck analysis state on mount, resetting');
        resetAnalysisState('Stuck analysis detected on mount');
      }
    }
  }, [isAnalyzing, analysisProgress, resetAnalysisState]);

  const analysisProgressRef = useRef(analysisProgress);
  analysisProgressRef.current = analysisProgress;

  useEffect(() => {
    if (!isAnalyzing) return undefined;

    const checkStalled = () => {
      // Read the store directly: React pauses rendering while the window is
      // minimized, so props and refs bound to them can be stale.
      const state = /** @type {any} */ (store.getState());
      if (!state.analysis.isAnalyzing) return; // Already finished

      const progress = state.analysis.analysisProgress || analysisProgressRef.current;
      const lastActivity = progress?.lastActivity || Date.now();
      const timeSinceActivity = Date.now() - lastActivity;
      const current = progress?.current || 0;
      const total = progress?.total || 0;

      if (current === 0 && total > 0 && timeSinceActivity > TIMEOUTS.STUCK_ANALYSIS_CHECK) {
        addNotification('Analysis paused. Restarting...', 'info', 3000, 'analysis-stalled');
        resetAnalysisState('Analysis stalled with no progress after 2 minutes');
        return;
      }

      if (timeSinceActivity > TIMEOUTS.ANALYSIS_LOCK) {
        addNotification('Analysis timed out. Ready to retry.', 'info', 3000, 'analysis-auto-reset');
        resetAnalysisState('Stuck analysis state after 5 minutes of inactivity');
      }
    };

    checkStalled();
    // Defer so the interval handler returns quickly (avoids Long Task violations).
    const intervalId = setInterval(() => setTimeout(checkStalled, 0), TIMEOUTS.SERVICE_STARTUP);
    return () => clearInterval(intervalId);
  }, [isAnalyzing, addNotification, resetAnalysisState, store]);

  const value = useMemo(
    () => ({
      analyzeFiles,
      cancelAnalysis,
      clearAnalysisQueue,
      retryFailedFiles,
      pruneBatchResultsForPath,
      totalAnalysisFailure,
      setTotalAnalysisFailure
    }),
    [
      analyzeFiles,
      cancelAnalysis,
      clearAnalysisQueue,
      retryFailedFiles,
      pruneBatchResultsForPath,
      totalAnalysisFailure
    ]
  );

  return <AnalysisRunContext.Provider value={value}>{children}</AnalysisRunContext.Provider>;
}

AnalysisRunProvider.propTypes = {
  children: PropTypes.node
};

/**
 * The analysis run's actions and its total-failure flag. Must be used under
 * AnalysisRunProvider (PhaseRenderer mounts it).
 */
export function useAnalysisRun() {
  const run = useContext(AnalysisRunContext);
  if (!run) {
    throw new Error('useAnalysisRun must be used inside AnalysisRunProvider');
  }
  return run;
}
