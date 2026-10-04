// @ts-check
/**
 * Discover State Hook
 *
 * Custom hook for Redux state bindings and action wrappers.
 * Extracted from DiscoverPhase for better maintainability.
 *
 * @module phases/discover/useDiscoverState
 */

import { useCallback, useMemo, useRef } from 'react';
import { useAppSelector, useAppDispatch } from '../../store/hooks';
import {
  setSelectedFiles as setSelectedFilesAction,
  addSelectedFiles as addSelectedFilesAction,
  releaseOrganizedPaths as releaseOrganizedPathsAction,
  updateFileState as updateFileStateAction,
  setFileStates as setFileStatesAction,
  setNamingConvention as setNamingConventionAction
} from '../../store/slices/filesSlice';
import {
  startAnalysis as startAnalysisAction,
  updateProgress as updateProgressAction,
  stopAnalysis as stopAnalysisAction,
  setAnalysisResults as setAnalysisResultsAction,
  resetAnalysisState as resetAnalysisStateAction
} from '../../store/slices/analysisSlice';
import { setPhase } from '../../store/slices/uiSlice';
import { selectFileStats } from '../../store/selectors';
import { createLogger } from '../../../shared/logger';
import { serializeData } from '../../utils/serialization';
import { normalizeNamingConventionState } from '../../../shared/namingConventions';

const logger = createLogger('DiscoverPhase:State');

/**
 * Custom hook for discover phase Redux state management
 * @returns {Object} State values, setters, and actions
 */
export function useDiscoverState() {
  const dispatch = useAppDispatch();

  // Selectors
  const selectedFiles = useAppSelector((/** @type {any} */ state) => state.files.selectedFiles);
  const analysisResults = useAppSelector((/** @type {any} */ state) => state.analysis.results);
  const isAnalyzing = useAppSelector((/** @type {any} */ state) => state.analysis.isAnalyzing);
  const analysisProgress = useAppSelector(
    (/** @type {any} */ state) => state.analysis.analysisProgress
  );
  const currentAnalysisFile = useAppSelector(
    (/** @type {any} */ state) => state.analysis.currentAnalysisFile
  );
  const fileStates = useAppSelector((/** @type {any} */ state) => state.files.fileStates);
  const namingConventionState = useAppSelector(
    (/** @type {any} */ state) => state.files.namingConvention
  );
  const normalizedNaming = useMemo(
    () => normalizeNamingConventionState(namingConventionState),
    [namingConventionState]
  );

  // Destructure naming convention
  const namingConvention = normalizedNaming.convention;
  const dateFormat = normalizedNaming.dateFormat;
  const caseConvention = normalizedNaming.caseConvention;
  const separator = normalizedNaming.separator;
  const currentPhase = useAppSelector((/** @type {any} */ state) => state.ui.currentPhase);
  const organizedFiles = useAppSelector((/** @type {any} */ state) => state.files.organizedFiles);
  const organizedPathIndex = useAppSelector(
    (/** @type {any} */ state) => state.files.organizedPathIndex
  );
  // Canonical queue counts (excludes already-organized paths). Shared with
  // Dashboard / Organize so ready/failed/pending badges stay in lockstep.
  const fileStats = useAppSelector(selectFileStats);

  // Refs to keep track of latest state for stable callbacks
  // This is safe because ref assignments are idempotent and don't cause side effects.
  // This eliminates 5 effect scheduling/cleanup cycles per state change.
  const selectedFilesRef = useRef(selectedFiles);
  const analysisResultsRef = useRef(analysisResults);
  const fileStatesRef = useRef(fileStates);
  const analysisProgressRef = useRef(analysisProgress);
  const currentPhaseRef = useRef(currentPhase);

  // Sync refs during render (safe for refs, avoids useEffect overhead)
  selectedFilesRef.current = selectedFiles;
  analysisResultsRef.current = analysisResults;
  fileStatesRef.current = fileStates;
  analysisProgressRef.current = analysisProgress;
  currentPhaseRef.current = currentPhase;

  // Stable callback to get current phase (for async operations that need to check phase)
  const getCurrentPhase = useCallback(() => currentPhaseRef.current, []);

  // Redux action wrappers
  const setSelectedFiles = useCallback(
    (/** @type {any} */ files) => {
      // Helper to serialize data before dispatching to avoid non-serializable checks
      const safeDispatch = (/** @type {any} */ payload) => {
        dispatch(setSelectedFilesAction(serializeData(payload)));
      };

      if (typeof files === 'function') {
        // Resolve function with current state, then serialize
        const resolved = files(selectedFilesRef.current);
        safeDispatch(resolved);
      } else {
        safeDispatch(files);
      }
    },
    [dispatch]
  );

  // User-driven adds (dialog / folder scan / drop). Unlike the ready-queue
  // hydration path, which also uses addSelectedFiles, an explicit pick of an
  // already-organized path is intent to work on it again, so release it from
  // the organized index first or every list and count would hide it.
  const addSelectedFiles = useCallback(
    (/** @type {any} */ files) => {
      const list = Array.isArray(files) ? files : [];
      if (list.length === 0) return;
      dispatch(releaseOrganizedPathsAction(list.map((/** @type {any} */ file) => file?.path)));
      dispatch(addSelectedFilesAction(serializeData(list)));
    },
    [dispatch]
  );

  const setAnalysisResults = useCallback(
    (/** @type {any} */ results) => {
      if (typeof results === 'function') {
        const resolved = results(analysisResultsRef.current);
        dispatch(setAnalysisResultsAction(serializeData(resolved)));
      } else {
        dispatch(setAnalysisResultsAction(serializeData(results)));
      }
    },
    [dispatch]
  );

  const setIsAnalyzing = useCallback(
    (/** @type {any} */ val, /** @type {{ total?: number }} */ { total } = {}) => {
      if (val) {
        // Prefer the explicit batch total from the caller. The ref fallback is
        // stale within the dispatching event handler (refs sync on render),
        // so relying on it zeroed the progress total at analysis start.
        dispatch(
          startAnalysisAction({
            total: typeof total === 'number' ? total : analysisProgressRef.current.total
          })
        );
      } else {
        dispatch(stopAnalysisAction());
      }
    },
    [dispatch]
  );

  const setAnalysisProgress = useCallback(
    (/** @type {any} */ val) => dispatch(updateProgressAction(val)),
    [dispatch]
  );

  const setCurrentAnalysisFile = useCallback(
    (/** @type {any} */ val) => dispatch(updateProgressAction({ currentFile: val })),
    [dispatch]
  );

  const setNamingConvention = useCallback(
    (/** @type {any} */ val) => dispatch(setNamingConventionAction({ convention: val })),
    [dispatch]
  );

  const setDateFormat = useCallback(
    (/** @type {any} */ val) => dispatch(setNamingConventionAction({ dateFormat: val })),
    [dispatch]
  );

  const setCaseConvention = useCallback(
    (/** @type {any} */ val) => dispatch(setNamingConventionAction({ caseConvention: val })),
    [dispatch]
  );

  const setSeparator = useCallback(
    (/** @type {any} */ val) => dispatch(setNamingConventionAction({ separator: val })),
    [dispatch]
  );

  const setFileStates = useCallback(
    (/** @type {any} */ val) => {
      if (typeof val === 'function') {
        const resolved = val(fileStatesRef.current);
        if (!resolved || typeof resolved !== 'object') {
          logger.warn('[useDiscoverState] setFileStates updater returned invalid value', {
            type: typeof resolved
          });
          return;
        }
        /** @type {Record<string, any>} */
        const serialized = {};
        Object.entries(resolved).forEach(([path, state]) => {
          serialized[path] = serializeData(state);
        });
        dispatch(setFileStatesAction(serialized));
      } else {
        /** @type {Record<string, any>} */
        const serialized = {};
        if (val && typeof val === 'object') {
          Object.entries(val).forEach(([path, state]) => {
            serialized[path] = serializeData(state);
          });
        }
        dispatch(setFileStatesAction(serialized));
      }
    },
    [dispatch]
  );

  const updateFileState = useCallback(
    (/** @type {any} */ filePath, /** @type {any} */ state, metadata = {}) => {
      const safeMetadata = serializeData(metadata);
      dispatch(
        updateFileStateAction({
          path: filePath,
          state,
          metadata: safeMetadata
        })
      );
    },
    [dispatch]
  );

  const resetAnalysisState = useCallback(
    (/** @type {any} */ reason) => {
      logger.info('Resetting analysis state', { reason });
      dispatch(stopAnalysisAction());
      dispatch(updateProgressAction({ current: 0, total: 0, currentFile: '' }));
      dispatch(resetAnalysisStateAction());

      try {
        localStorage.removeItem('stratosort_workflow_state');
      } catch {
        // Non-fatal
      }
    },
    [dispatch]
  );

  // Memoized actions object
  const actions = useMemo(
    () => ({
      setPhaseData: (/** @type {any} */ key, /** @type {any} */ value) => {
        if (key === 'isAnalyzing') setIsAnalyzing(value);
        if (key === 'analysisProgress') setAnalysisProgress(value);
        if (key === 'currentAnalysisFile') setCurrentAnalysisFile(value);
        if (key === 'selectedFiles') setSelectedFiles(value);
        if (key === 'analysisResults') setAnalysisResults(value);
        if (key === 'namingConvention') dispatch(setNamingConventionAction(value));
        if (key === 'fileStates') setFileStates(value);
        if (key === 'failedFileCount') {
          logger.debug('Failed file count updated', { count: value });
        }
      },
      advancePhase: (/** @type {any} */ phase) => dispatch(setPhase(phase))
    }),
    [
      dispatch,
      setIsAnalyzing,
      setAnalysisProgress,
      setCurrentAnalysisFile,
      setSelectedFiles,
      setAnalysisResults,
      setFileStates
    ]
  );

  // Memoized computed values — derived from selectFileStats so Discover
  // Continue gating matches Dashboard "Ready to organize" / failed chips.
  // Previously readySelectedFilesCount used fileStates==='ready' and did not
  // exclude organizedPathIndex, so moved files could still unlock Continue.
  const successfulAnalysisCount = fileStats.ready;
  const failedAnalysisCount = fileStats.failed;
  const readyAnalysisCount = fileStats.ready;
  const readySelectedFilesCount = fileStats.ready;

  // Naming settings object for hooks
  const namingSettings = useMemo(() => ({ ...normalizedNaming }), [normalizedNaming]);

  return {
    // State values
    selectedFiles,
    analysisResults,
    isAnalyzing,
    analysisProgress,
    currentAnalysisFile,
    fileStates,
    namingConventionState,
    namingConvention,
    dateFormat,
    caseConvention,
    separator,
    namingSettings,
    currentPhase,
    organizedFiles,
    organizedPathIndex,
    fileStats,

    // Setters
    setSelectedFiles,
    addSelectedFiles,
    setAnalysisResults,
    setIsAnalyzing,
    setAnalysisProgress,
    setCurrentAnalysisFile,
    setNamingConvention,
    setDateFormat,
    setCaseConvention,
    setSeparator,
    setFileStates,
    updateFileState,
    resetAnalysisState,

    // Actions
    actions,
    dispatch,

    // Callbacks
    getCurrentPhase,

    // Computed values
    successfulAnalysisCount,
    failedAnalysisCount,
    readyAnalysisCount,
    readySelectedFilesCount
  };
}
