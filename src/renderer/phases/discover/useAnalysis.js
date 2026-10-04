// @ts-check
/**
 * Analysis Hook
 *
 * Custom hook for file analysis logic and state management.
 * Extracted from DiscoverPhase for better maintainability.
 *
 * @module phases/discover/useAnalysis
 */

import { useCallback, useRef, useEffect, useState, useMemo, startTransition } from 'react';
import { useStore } from 'react-redux';
import { PHASES, FILE_STATES } from '../../../shared/constants';
import { TIMEOUTS, CONCURRENCY, RETRY } from '../../../shared/performanceConstants';
import { createLogger } from '../../../shared/logger';
import { embeddingsIpc } from '../../services/ipc';
import {
  validateProgressState,
  generatePreviewName as generatePreviewNameUtil,
  generateSuggestedNameFromAnalysis,
  makeUniqueFileName,
  extractFileName
} from './namingUtils';
import {
  buildAnalysisInputForNamingReapply,
  resolveDiscoverSuggestedName
} from '../../../shared/namingConventions';
import {
  mergeReadyQueueIntoState,
  normalizeReadyQueuePayload
} from '../../utils/readyQueueHydration';
import { mapErrorToNotification } from '../../utils/errorMapping';
import { normalizeNamingConventionState } from '../../../shared/namingConventions';
import { toCanonicalPath } from '../../utils/canonicalPath';

const logger = createLogger('DiscoverPhase:Analysis');
const BATCH_ANALYSIS_MIN_FILES = 40;
/** Mixed-modality batch threshold when hardware recommends sequential (low VRAM). */
const BATCH_ANALYSIS_LOW_VRAM_MIN_FILES = 3;
const BATCH_ANALYSIS_PROGRESS_EVENT = 'operation-progress';
// Auto-advance timeout is now stored in a ref within the hook to prevent
// cross-component interference when hook unmounts and remounts

/**
 * Clear auto-advance timeout from ref
 * @param {any} autoAdvanceTimeoutRef - Ref containing timeout ID
 */
function clearAutoAdvanceTimeoutRef(autoAdvanceTimeoutRef) {
  if (autoAdvanceTimeoutRef?.current) {
    clearTimeout(autoAdvanceTimeoutRef.current);
    autoAdvanceTimeoutRef.current = null;
  }
}

/**
 * Analyze a file with retry logic for transient failures.
 * Extracted from analyzeFiles for better testability.
 *
 * @param {string} filePath - Path to the file to analyze
 * @param {number} attempt - Current attempt number (1-based)
 * @returns {Promise<Object>} Analysis result
 */
async function analyzeWithRetry(
  filePath,
  attempt = 1,
  /** @type {any} */ abortSignal = null,
  /** @type {any} */ namingSettings = null
) {
  // Ensure electronAPI is available before attempting analysis
  if (!window.electronAPI?.files?.analyze) {
    throw new Error(
      'File analysis API not available. The application may not have loaded correctly.'
    );
  }

  try {
    const analyzeOptions =
      namingSettings && typeof namingSettings === 'object' ? { namingSettings } : undefined;
    return await window.electronAPI.files.analyze(filePath, analyzeOptions);
  } catch (error) {
    // Analysis is fully local (in-process node-llama-cpp via main IPC); the
    // 'network' / 'ECONNREFUSED' shapes were defensive holdovers from the
    // earlier Ollama-HTTP era and are unreachable today. Keep 'timeout' since
    // the local model can stall under heavy load. Add 'aborted' so a transient
    // service-restart that surfaces as an abort is retried instead of being
    // bubbled up as a hard failure.
    const message = String(error?.message || '');
    const isTransient = message.includes('timeout') || message.includes('aborted');

    if (attempt < RETRY.MAX_ATTEMPTS_MEDIUM && isTransient) {
      // Check abort signal before waiting for retry delay
      if (abortSignal?.aborted) {
        throw new Error('Analysis cancelled by user', { cause: error });
      }
      const delay = RETRY.INITIAL_DELAY * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
      // Check again after delay in case cancellation happened during wait
      if (abortSignal?.aborted) {
        throw new Error('Analysis cancelled by user', { cause: error });
      }
      return analyzeWithRetry(filePath, attempt + 1, abortSignal, namingSettings);
    }
    throw error;
  }
}

function shouldUseBatchAnalysis(
  /** @type {any} */ fileCount,
  /** @type {any} */ concurrency,
  /** @type {any} */ systemRecommended
) {
  if (!Number.isFinite(fileCount) || fileCount <= 0) return false;
  const recommended = Number(systemRecommended);
  if (recommended === 1 && fileCount >= BATCH_ANALYSIS_LOW_VRAM_MIN_FILES) {
    return true;
  }
  if (fileCount < BATCH_ANALYSIS_MIN_FILES) return false;
  return Number(concurrency) <= 2;
}

function withTimeout(
  /** @type {any} */ promise,
  /** @type {any} */ timeoutMs,
  /** @type {any} */ label
) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  /** @type {NodeJS.Timeout | undefined} */
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        Object.assign(new Error(`${label} timed out after ${timeoutMs}ms`), {
          code: 'ANALYSIS_TIMEOUT'
        })
      );
    }, timeoutMs);
  });
  // If the timeout wins the race, the losing promise may still reject later;
  // without an attached handler that becomes an unhandled rejection.
  if (promise && typeof promise.catch === 'function') {
    promise.catch(() => {});
  }
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function hasFallbackSuggestion(/** @type {any} */ analysis) {
  return Boolean(analysis?.suggestedName || analysis?.category);
}

function normalizeAnalysisForUi(/** @type {any} */ analysis) {
  if (!analysis || !analysis.error) return analysis;
  const { error, ...rest } = analysis;
  return {
    ...rest,
    warning: error,
    hadError: true
  };
}

/**
 * Merge new analysis results with existing results.
 *
 * @param {any[]} existingResults - Previous analysis results
 * @param {any[]} newResults - New results to merge
 * @returns {any[]} Merged results array
 */
function mergeAnalysisResults(existingResults, newResults) {
  const resultsByPath = new Map((existingResults || []).map((/** @type {any} */ r) => [r.path, r]));
  newResults.forEach((/** @type {any} */ r) => resultsByPath.set(r.path, r));
  return Array.from(resultsByPath.values());
}

/**
 * De-duplicate suggested names across the current result set.
 * This prevents multiple similar files from ending up with identical suggested names in the UI.
 *
 * NOTE: Actual filesystem collision handling is also performed during organize operations.
 */
function dedupeSuggestedNames(/** @type {any} */ results) {
  const used = new Map();
  let changed = false;

  const next = (results || []).map((/** @type {any} */ r) => {
    if (!r?.analysis?.suggestedName) return r;
    const unique = makeUniqueFileName(r.analysis.suggestedName, used);
    if (unique === r.analysis.suggestedName) return r;
    changed = true;
    return {
      ...r,
      analysis: {
        ...r.analysis,
        suggestedName: unique
      }
    };
  });

  return changed ? next : results;
}

/**
 * Merge file states with new analysis results.
 *
 * @param {Record<string, any>} existingStates - Previous file states
 * @param {any[]} results - Analysis results to merge
 * @returns {Record<string, any>} Merged file states
 */
function mergeFileStates(existingStates, results) {
  /** @type {Record<string, any>} */
  const mergedStates = { ...(existingStates || {}) };
  results.forEach((/** @type {any} */ result) => {
    if (result.analysis && !result.error) {
      mergedStates[result.path] = {
        state: 'ready',
        timestamp: new Date().toISOString(),
        analysis: result.analysis,
        name: result.name,
        size: result.size,
        created: result.created,
        modified: result.modified
      };
    } else if (result.error) {
      mergedStates[result.path] = {
        state: 'error',
        timestamp: new Date().toISOString(),
        error: result.error,
        name: result.name,
        size: result.size,
        created: result.created,
        modified: result.modified
      };
    }
  });
  return mergedStates;
}

/**
 * Show appropriate notification based on analysis results.
 *
/**
 * @param {{ successCount: number, failureCount: number, addNotification: Function, actions: any, getCurrentPhase: Function, autoAdvanceTimeoutRef: any }} params
 */
function showAnalysisCompletionNotification({
  successCount,
  failureCount,
  addNotification,
  actions,
  getCurrentPhase,
  autoAdvanceTimeoutRef
}) {
  if (successCount > 0 && failureCount === 0) {
    addNotification(
      `Analysis complete! ${successCount} files ready`,
      'success',
      4000,
      'analysis-complete'
    );
    clearAutoAdvanceTimeoutRef(autoAdvanceTimeoutRef); // Clear any previous pending timeout
    autoAdvanceTimeoutRef.current = setTimeout(() => {
      autoAdvanceTimeoutRef.current = null;
      // Check if still in DISCOVER phase before auto-advancing
      // This prevents unexpected navigation if user moved away during the delay
      const currentPhase = getCurrentPhase?.();
      if (currentPhase === (PHASES?.DISCOVER ?? 'discover')) {
        actions.advancePhase(PHASES?.ORGANIZE ?? 'organize');
      } else {
        logger.debug('Skipping auto-advance: phase changed during delay', {
          currentPhase,
          expectedPhase: PHASES?.DISCOVER ?? 'discover'
        });
      }
    }, 2000);
  } else if (successCount > 0) {
    addNotification(
      `Analysis complete: ${successCount} successful, ${failureCount} failed`,
      'warning',
      4000,
      'analysis-complete'
    );
    clearAutoAdvanceTimeoutRef(autoAdvanceTimeoutRef); // Clear any previous pending timeout
    autoAdvanceTimeoutRef.current = setTimeout(() => {
      autoAdvanceTimeoutRef.current = null;
      // Check if still in DISCOVER phase before auto-advancing
      const currentPhase = getCurrentPhase?.();
      if (currentPhase === (PHASES?.DISCOVER ?? 'discover')) {
        actions.advancePhase(PHASES?.ORGANIZE ?? 'organize');
      } else {
        logger.debug('Skipping auto-advance: phase changed during delay', {
          currentPhase,
          expectedPhase: PHASES?.DISCOVER ?? 'discover'
        });
      }
    }, 2000);
  } else if (failureCount > 0) {
    addNotification(
      `Analysis failed for all ${failureCount} files.`,
      'error',
      8000,
      'analysis-complete'
    );
    actions.setPhaseData('totalAnalysisFailure', true);
  }
}

export { shouldUseBatchAnalysis, BATCH_ANALYSIS_MIN_FILES, BATCH_ANALYSIS_LOW_VRAM_MIN_FILES };

// Parked resume intent across Discover unmount/remount. Redux `isAnalyzing`
// drives NavigationBar's isBlockedByOperation, so it MUST be cleared when
// Discover unmounts mid-run (otherwise every tab — including the one back to
// Discover — stays blocked with no way to recover). This module flag survives
// the unmount so the resume effect still knows a run was interrupted.
let analysisInterruptedByUnmount = false;

/**
 * Custom hook for analysis operations
 * @param {any} [options] - Hook options
 */
export function useAnalysis(options = {}) {
  const store = useStore();
  const {
    selectedFiles = [],
    fileStates = {},
    analysisResults = [],
    isAnalyzing = false,
    analysisProgress = { current: 0, total: 0 },
    namingSettings: rawNamingSettings = {},
    setters: {
      setIsAnalyzing = () => {},
      setAnalysisProgress = () => {},
      setCurrentAnalysisFile = () => {},
      setAnalysisResults = () => {},
      setFileStates = () => {}
    } = {},
    updateFileState = () => {},
    addNotification = () => {},
    actions = { setPhaseData: () => {}, advancePhase: () => {} },
    getCurrentPhase = () => {}
  } = options;

  // Stabilize naming settings and tolerate legacy string-shaped persisted state.
  const namingSettings = useMemo(
    () => normalizeNamingConventionState(rawNamingSettings),
    [rawNamingSettings]
  );

  // Split responsibilities so React 19 StrictMode remount can retry resume:
  //  - runStartedRef: a real analysis run has started; resume effect must not
  //    fire for the rest of this hook's lifetime.
  //  - hasAttemptedResumeRef: the resume effect has attempted resume on this
  //    specific mount. Reset in the effect's cleanup so a StrictMode remount
  //    gets a fresh chance. Previously both were collapsed into hasResumedRef,
  //    which meant StrictMode's first mount's attempt permanently disabled
  //    resume even if the persisted isAnalyzing state was still valid.
  const runStartedRef = useRef(false);
  const hasAttemptedResumeRef = useRef(false);
  const analysisLockRef = useRef(false);
  const [globalAnalysisActive, setGlobalAnalysisActive] = useState(false);
  const analyzeFilesRef = useRef(null);
  const heartbeatIntervalRef = useRef(null);
  const analysisTimeoutRef = useRef(null);
  const lockTimeoutRef = useRef(null);
  const abortControllerRef = useRef(null);
  const pendingFilesRef = useRef([]);
  const batchCompletedPathsRef = useRef(new Set());
  const cancelledBatchSnapshotRef = useRef(null);
  const batchResultsRef = useRef([]);
  const pendingResultsRef = useRef([]);
  const lastResultsFlushRef = useRef(0);
  const RESULTS_FLUSH_MS = 200;
  const autoAdvanceTimeoutRef = useRef(null);
  const clearCurrentFileTimeoutRef = useRef(null);
  const pendingFilesTimeoutRef = useRef(null);
  // Using a counter ref that workers increment atomically when they complete
  const completedCountRef = useRef(0);
  const lastProgressDispatchRef = useRef(0);
  const PROGRESS_THROTTLE_MS = 50;
  const isMountedRef = useRef(true);

  // Refs to track current state values (prevents stale closures in callbacks)
  // This is safe because ref assignments are idempotent and don't cause side effects.
  const isAnalyzingRef = useRef(isAnalyzing);
  const globalAnalysisActiveRef = useRef(globalAnalysisActive);
  const analysisResultsRef = useRef(analysisResults);
  const fileStatesRef = useRef(fileStates);
  const analysisProgressRef = useRef(analysisProgress);
  const analysisRunIdRef = useRef(0);
  const lastProgressAtRef = useRef(0);
  const activeBatchIdRef = useRef(null);
  const cancelInFlightBatchIdRef = useRef(null);

  const invalidateEmbeddingStatsCache = useCallback(() => {
    try {
      embeddingsIpc.invalidateStatsCache();
    } catch {
      // Non-fatal: stale stats are preferable to interrupting analysis flow.
    }
  }, []);

  // Sync refs during render (avoids useEffect overhead)
  isAnalyzingRef.current = isAnalyzing;
  globalAnalysisActiveRef.current = globalAnalysisActive;
  analysisResultsRef.current = analysisResults;
  fileStatesRef.current = fileStates;
  analysisProgressRef.current = analysisProgress;

  const dispatchProgressUpdate = useCallback(
    (/** @type {any} */ progress, { force = false } = {}) => {
      if (!validateProgressState(progress)) {
        return false;
      }

      const now = Date.now();
      const current = Number(progress?.current) || 0;
      const total = Number(progress?.total) || 0;
      const isTerminalProgress = total > 0 && current >= total;

      if (
        force ||
        isTerminalProgress ||
        now - lastProgressDispatchRef.current >= PROGRESS_THROTTLE_MS
      ) {
        lastProgressDispatchRef.current = now;
        setAnalysisProgress(progress);
        return true;
      }

      return false;
    },
    [setAnalysisProgress]
  );

  const flushPendingResults = useCallback(
    (force = false) => {
      if (!pendingResultsRef.current.length) return;
      if (!isMountedRef.current) return;

      const now = Date.now();
      if (!force && now - lastResultsFlushRef.current < RESULTS_FLUSH_MS) {
        return;
      }

      lastResultsFlushRef.current = now;
      const pending = pendingResultsRef.current;
      pendingResultsRef.current = [];

      const mergedResults = dedupeSuggestedNames(
        mergeAnalysisResults(analysisResultsRef.current, pending)
      );
      const mergedStates = mergeFileStates(fileStatesRef.current, pending);

      // Keep refs in sync to avoid stale merges between flushes
      analysisResultsRef.current = mergedResults;
      fileStatesRef.current = mergedStates;

      setAnalysisResults(mergedResults);
      setFileStates(mergedStates);
    },
    [setAnalysisResults, setFileStates]
  );

  const pruneBatchResultsForPath = useCallback((/** @type {any} */ filePath) => {
    const key = toCanonicalPath(filePath);
    if (!key) return;
    const keep = (/** @type {any} */ result) =>
      toCanonicalPath(result?.path || result?.filePath) !== key;
    batchResultsRef.current = batchResultsRef.current.filter(keep);
    pendingResultsRef.current = pendingResultsRef.current.filter(keep);
  }, []);

  const recordAnalysisResult = useCallback(
    (/** @type {any} */ result) => {
      batchResultsRef.current.push(result);
      pendingResultsRef.current.push(result);
      flushPendingResults();
    },
    [flushPendingResults]
  );

  const hydrateReadyQueueResults = useCallback(async () => {
    // Snapshot the runId at call time. resetAnalysisState bumps
    // analysisRunIdRef, and the mount-tracking flag flips to false on unmount.
    // Either event must make this async work a no-op for state writes: a stale
    // IPC response applied to a remounted or reset component previously caused
    // phantom "hydrated" results and a React act() warning in tests.
    const runIdAtStart = analysisRunIdRef.current;
    try {
      const getReadyQueue = window?.electronAPI?.analysis?.getReadyQueue;
      if (typeof getReadyQueue !== 'function') return 0;

      const response = await getReadyQueue();

      if (!isMountedRef.current || analysisRunIdRef.current !== runIdAtStart) {
        return 0;
      }

      const readyEntries = normalizeReadyQueuePayload(response);
      if (readyEntries.length === 0) return 0;

      const merged = mergeReadyQueueIntoState(
        {
          selectedFiles,
          analysisResults: analysisResultsRef.current,
          fileStates: fileStatesRef.current
        },
        readyEntries,
        namingSettings
      );

      if (merged.hydratedCount <= 0) return 0;

      if (!isMountedRef.current || analysisRunIdRef.current !== runIdAtStart) {
        return 0;
      }

      analysisResultsRef.current = merged.analysisResults;
      fileStatesRef.current = merged.fileStates;
      setAnalysisResults(merged.analysisResults);
      setFileStates(merged.fileStates);

      logger.info('Hydrated completed analyses from ready queue', {
        hydratedCount: merged.hydratedCount
      });

      return merged.hydratedCount;
    } catch (error) {
      logger.warn('Failed to hydrate completed analyses from ready queue', {
        error: error?.message
      });
      return 0;
    }
  }, [selectedFiles, setAnalysisResults, setFileStates, namingSettings]);

  const requeueInFlightFileStates = useCallback(() => {
    setFileStates((/** @type {any} */ prev) => {
      if (!prev || typeof prev !== 'object') return prev;
      let hasChanges = false;
      const next = { ...prev };
      Object.entries(next).forEach(([filePath, stateInfo]) => {
        if (!stateInfo || stateInfo.state !== 'analyzing') return;
        hasChanges = true;
        next[filePath] = {
          ...stateInfo,
          state: FILE_STATES.PENDING
        };
      });
      return hasChanges ? next : prev;
    });
  }, [setFileStates]);

  const captureCancelledBatchSnapshot = useCallback((runId = analysisRunIdRef.current) => {
    cancelledBatchSnapshotRef.current = {
      runId,
      completedAtCancel: Math.max(0, Number(completedCountRef.current) || 0),
      completedPaths: Array.from(batchCompletedPathsRef.current)
    };
  }, []);

  const requestMainBatchCancel = useCallback((/** @type {string} */ reason = 'cancelled') => {
    const batchId = activeBatchIdRef.current;
    const cancelBatchApi = window?.electronAPI?.analysis?.cancelBatch;
    if (!batchId || typeof cancelBatchApi !== 'function') {
      return;
    }
    if (cancelInFlightBatchIdRef.current === batchId) {
      return;
    }

    cancelInFlightBatchIdRef.current = batchId;
    Promise.resolve(cancelBatchApi({ batchId, reason }))
      .then(
        /**
         * @param {any} response
         * @returns {undefined}
         */
        (response) => {
          logger.info('Main-process batch cancel acknowledged', {
            batchId,
            cancelled: Boolean(response?.cancelled),
            notFound: Boolean(response?.notFound)
          });
          return undefined;
        }
      )
      .catch((/** @type {any} */ error) => {
        logger.warn('Main-process batch cancel request failed', {
          batchId,
          reason,
          error: error?.message
        });
      })
      .finally(() => {
        if (cancelInFlightBatchIdRef.current === batchId) {
          cancelInFlightBatchIdRef.current = null;
        }
      });
  }, []);

  /**
   * Reset analysis state
   */
  const resetAnalysisState = useCallback(
    (/** @type {any} */ reason) => {
      logger.info('Resetting analysis state', { reason });
      invalidateEmbeddingStatsCache();
      const activeRunId = analysisRunIdRef.current;
      captureCancelledBatchSnapshot(activeRunId);
      requestMainBatchCancel('reset-analysis-state');
      analysisRunIdRef.current = activeRunId + 1;
      // Ensure any in-flight analysis is stopped and locks are released.
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      analysisLockRef.current = false;
      isAnalyzingRef.current = false;
      setGlobalAnalysisActive(false);
      globalAnalysisActiveRef.current = false;
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
      if (analysisTimeoutRef.current) {
        clearTimeout(analysisTimeoutRef.current);
        analysisTimeoutRef.current = null;
      }
      if (lockTimeoutRef.current) {
        clearTimeout(lockTimeoutRef.current);
        lockTimeoutRef.current = null;
      }
      if (clearCurrentFileTimeoutRef.current) {
        clearTimeout(clearCurrentFileTimeoutRef.current);
        clearCurrentFileTimeoutRef.current = null;
      }
      if (pendingFilesTimeoutRef.current) {
        clearTimeout(pendingFilesTimeoutRef.current);
        pendingFilesTimeoutRef.current = null;
      }
      pendingFilesRef.current = [];
      batchCompletedPathsRef.current.clear();
      activeBatchIdRef.current = null;
      cancelInFlightBatchIdRef.current = null;
      flushPendingResults(true);
      requeueInFlightFileStates();

      setIsAnalyzing(false);
      const clearedProgress = { current: 0, total: 0, currentFile: '', lastActivity: 0 };
      analysisProgressRef.current = clearedProgress;
      setAnalysisProgress(clearedProgress);
      setCurrentAnalysisFile('');
      actions.setPhaseData('currentAnalysisFile', '');

      try {
        localStorage.removeItem('stratosort_workflow_state');
      } catch {
        // Non-fatal
      }
    },
    [
      invalidateEmbeddingStatsCache,
      setIsAnalyzing,
      setAnalysisProgress,
      setCurrentAnalysisFile,
      setGlobalAnalysisActive,
      captureCancelledBatchSnapshot,
      requestMainBatchCancel,
      flushPendingResults,
      requeueInFlightFileStates,
      actions
    ]
  );

  /**
   * Generate preview name with current settings
   */
  const generatePreviewName = useCallback(
    (/** @type {any} */ originalName) => {
      return generatePreviewNameUtil(originalName, namingSettings);
    },
    [namingSettings]
  );

  const generateSuggestedName = useCallback(
    (
      /** @type {any} */ originalFileName,
      /** @type {any} */ analysis,
      /** @type {any} */ fileTimestamps
    ) => {
      return generateSuggestedNameFromAnalysis({
        originalFileName,
        analysis,
        settings: namingSettings,
        fileTimestamps
      });
    },
    [namingSettings]
  );

  const applyAnalysisOutcome = useCallback(
    (
      /** @type {any} */ fileInfo,
      /** @type {any} */ rawAnalysis,
      /** @type {any} */ explicitError = null
    ) => {
      const fileName = fileInfo?.name || extractFileName(fileInfo?.path || '');
      const analyzedAt = new Date().toISOString();

      if (explicitError) {
        recordAnalysisResult({
          ...fileInfo,
          analysis: null,
          error: explicitError,
          status: FILE_STATES.ERROR,
          analyzedAt
        });
        updateFileState(fileInfo.path, 'error', {
          error: explicitError,
          analyzedAt
        });
        return;
      }

      const analysisForUi = normalizeAnalysisForUi(rawAnalysis);
      const shouldTreatAsReady =
        analysisForUi && (!analysisForUi.hadError || hasFallbackSuggestion(analysisForUi));

      if (shouldTreatAsReady) {
        const baseSuggestedName =
          analysisForUi.llmSuggestedName || analysisForUi.suggestedName || fileName;
        const enhancedAnalysis = {
          ...analysisForUi,
          originalSuggestedName: baseSuggestedName,
          suggestedName: resolveDiscoverSuggestedName({
            originalFileName: fileName,
            analysis: analysisForUi,
            settings: namingSettings,
            fileTimestamps: { created: fileInfo.created, modified: fileInfo.modified },
            trustMainProcess: true
          }),
          namingConvention: namingSettings
        };

        recordAnalysisResult({
          ...fileInfo,
          analysis: enhancedAnalysis,
          status: FILE_STATES.CATEGORIZED,
          analyzedAt
        });
        updateFileState(fileInfo.path, 'ready', {
          analysis: enhancedAnalysis,
          analyzedAt,
          name: fileInfo.name,
          size: fileInfo.size,
          created: fileInfo.created,
          modified: fileInfo.modified
        });
        return;
      }

      const errorMessage = analysisForUi?.warning || rawAnalysis?.error || 'Analysis failed';
      recordAnalysisResult({
        ...fileInfo,
        analysis: null,
        error: errorMessage,
        status: FILE_STATES.ERROR,
        analyzedAt
      });
      updateFileState(fileInfo.path, 'error', {
        error: errorMessage,
        analyzedAt
      });
    },
    [namingSettings, recordAnalysisResult, updateFileState]
  );

  /**
   * Re-apply naming convention to existing analyses when settings change.
   * Keeps Discover and Organize screens in sync with the user-selected naming.
   */
  // Track the last applied naming settings to prevent unnecessary re-renders
  const lastAppliedNamingRef = useRef(null);

  useEffect(() => {
    // Compare by primitive values to detect actual changes (avoids JSON.stringify on every run)
    const key = `${namingSettings?.convention ?? ''}|${namingSettings?.separator ?? ''}|${namingSettings?.dateFormat ?? ''}|${namingSettings?.caseConvention ?? ''}`;
    if (lastAppliedNamingRef.current === key) {
      return; // Settings haven't changed, skip update
    }
    lastAppliedNamingRef.current = key;

    setAnalysisResults((/** @type {any} */ prev) => {
      if (!prev || prev.length === 0) return prev;

      // Check if any result actually needs updating
      let hasChanges = false;
      const updated = prev.map((/** @type {any} */ result) => {
        if (!result?.analysis) return result;

        const newName = generateSuggestedName(
          result.name || extractFileName(result.path || ''),
          buildAnalysisInputForNamingReapply(result.analysis),
          { created: result.created, modified: result.modified }
        );

        // Only create new object if name actually changed
        if (result.analysis.suggestedName === newName) {
          return result;
        }

        hasChanges = true;
        return {
          ...result,
          analysis: {
            ...result.analysis,
            suggestedName: newName,
            namingConvention: namingSettings,
            originalSuggestedName:
              result.analysis.originalSuggestedName ||
              result.analysis.suggestedName ||
              result.name ||
              extractFileName(result.path || '')
          }
        };
      });

      // Only return new array if there were actual changes
      const withNamingApplied = hasChanges ? updated : prev;
      return dedupeSuggestedNames(withNamingApplied);
    });

    setFileStates((/** @type {any} */ prev) => {
      if (!prev || Object.keys(prev).length === 0) return prev;

      let hasChanges = false;
      const next = { ...prev };

      Object.entries(next).forEach(([filePath, state]) => {
        if (!state?.analysis) return;

        const newName = generateSuggestedName(
          state.name || extractFileName(filePath),
          buildAnalysisInputForNamingReapply(state.analysis),
          {
            created: state.created,
            modified: state.modified
          }
        );

        // Only update if name actually changed
        if (state.analysis.suggestedName === newName) {
          return;
        }

        hasChanges = true;
        next[filePath] = {
          ...state,
          analysis: {
            ...state.analysis,
            suggestedName: newName,
            namingConvention: namingSettings,
            originalSuggestedName:
              state.analysis.originalSuggestedName ||
              state.analysis.suggestedName ||
              state.name ||
              extractFileName(filePath)
          }
        };
      });

      // Only return new object if there were actual changes
      return hasChanges ? next : prev;
    });
  }, [namingSettings, generateSuggestedName, setAnalysisResults, setFileStates]);

  /**
   * Main analysis function
   */
  const analyzeFiles = useCallback(
    async (/** @type {any} */ files) => {
      if (!files || files.length === 0) {
        addNotification('No files queued for analysis.', 'info', 2000, 'analysis-empty');
        return { started: false, reason: 'empty' };
      }

      // Atomic lock acquisition (use refs to avoid stale closures)
      const tryAcquireLock = () => {
        const state = /** @type {any} */ (store.getState());
        const isReduxAnalyzing = state.analysis.isAnalyzing;
        if (
          analysisLockRef.current ||
          globalAnalysisActiveRef.current ||
          isAnalyzingRef.current ||
          isReduxAnalyzing
        ) {
          logger.debug('Analysis lock not acquired', {
            locked: analysisLockRef.current,
            global: globalAnalysisActiveRef.current,
            isAnalyzing: isAnalyzingRef.current,
            isReduxAnalyzing
          });
          return false;
        }
        analysisLockRef.current = true;
        return true;
      };

      let lockAcquired = tryAcquireLock();

      if (!lockAcquired) {
        const state = /** @type {any} */ (store.getState());
        const progress = state.analysis.analysisProgress || analysisProgressRef.current;
        const lastActivity = Number.isFinite(progress?.lastActivity) ? progress.lastActivity : 0;
        const inactivityMs = lastActivity ? Date.now() - lastActivity : Infinity;
        const staleThreshold = TIMEOUTS.ANALYSIS_LOCK || 5 * 60 * 1000;

        if (inactivityMs > staleThreshold) {
          logger.warn('Stale analysis lock detected, resetting', {
            inactivityMs,
            lastActivity,
            thresholdMs: staleThreshold
          });
          resetAnalysisState('Stale analysis lock detected');
          lockAcquired = tryAcquireLock();
        }
      }

      if (!lockAcquired) {
        // Queue files for analysis when current batch completes
        logger.debug('Lock already held, queueing files for later', {
          fileCount: files.length
        });
        pendingFilesRef.current = [
          ...pendingFilesRef.current,
          ...files.filter(
            (/** @type {any} */ f) => !pendingFilesRef.current.some((p) => p.path === f.path)
          )
        ];
        addNotification(
          'Analysis already running. Files queued to run next.',
          'info',
          2500,
          'analysis-queued'
        );
        return { started: false, reason: 'queued' };
      }

      const runId = ++analysisRunIdRef.current;
      const isActiveRun = () => analysisRunIdRef.current === runId;
      cancelledBatchSnapshotRef.current = null;
      batchCompletedPathsRef.current.clear();

      // This prevents the resume useEffect from showing "Resuming..." notification
      // for a brand new analysis. The resume logic should only trigger when isAnalyzing
      // was already true on component mount (e.g., from persisted state after page refresh).
      // Setting this after lock acquisition ensures we don't permanently disable resume
      // logic when the lock wasn't acquired and we returned early.
      runStartedRef.current = true;
      // Mirror the analyzing state into the ref synchronously: Redux
      // setIsAnalyzing(true) lands several awaits later, and the unmount
      // cleanup keys off isAnalyzingRef to park the resume intent. Without
      // this, a StrictMode simulated unmount (or a very fast navigation)
      // between run start and the Redux commit aborts the run without
      // parking the intent — the run dies and never resumes.
      isAnalyzingRef.current = true;

      setGlobalAnalysisActive(true);
      abortControllerRef.current = new AbortController();
      const abortSignal = abortControllerRef.current.signal;

      if (abortSignal.aborted) {
        analysisLockRef.current = false;
        setGlobalAnalysisActive(false);
        return { started: false, reason: 'aborted' };
      }

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Safety timeout - store in ref for proper cleanup
      const scheduleLockTimeoutCheck = () => {
        lockTimeoutRef.current = setTimeout(() => {
          if (!isActiveRun()) {
            lockTimeoutRef.current = null;
            return;
          }

          const lastProgressAt = Number.isFinite(lastProgressAtRef.current)
            ? lastProgressAtRef.current
            : 0;
          const inactivityMs = lastProgressAt ? Date.now() - lastProgressAt : Infinity;
          const thresholdMs = TIMEOUTS.ANALYSIS_LOCK;

          if (inactivityMs < thresholdMs) {
            scheduleLockTimeoutCheck();
            return;
          }

          logger.warn('Analysis lock timeout, forcing release', {
            inactivityMs,
            lastProgressAt,
            thresholdMs
          });
          resetAnalysisState('Analysis lock timeout');
          lockTimeoutRef.current = null;
        }, TIMEOUTS.ANALYSIS_LOCK);
      };
      scheduleLockTimeoutCheck();

      // This prevents "stuck" progress bars where processed count < total due to internal skipping
      const uniqueFiles = files.filter(
        (/** @type {any} */ file, /** @type {any} */ index, /** @type {any} */ self) =>
          index === self.findIndex((/** @type {any} */ f) => f.path === file.path)
      );

      try {
        const saveSettings = window?.electronAPI?.settings?.save;
        if (typeof saveSettings === 'function') {
          await saveSettings({
            namingConvention: namingSettings.convention,
            separator: namingSettings.separator,
            dateFormat: namingSettings.dateFormat,
            caseConvention: namingSettings.caseConvention
          });
        }
      } catch (syncError) {
        logger.warn('Failed to sync Discover naming settings before analysis', {
          error: syncError?.message
        });
      }

      // Pass the real batch total: setIsAnalyzing's internal ref fallback is
      // stale inside this handler and used to zero the progress total.
      setIsAnalyzing(true, { total: uniqueFiles.length });
      lastProgressAtRef.current = Date.now();
      lastProgressDispatchRef.current = 0;
      const initialProgress = {
        current: 0,
        total: uniqueFiles.length,
        lastActivity: Date.now()
      };
      setAnalysisProgress(initialProgress);
      setCurrentAnalysisFile('');
      // Redux is the single source of truth for isAnalyzing.
      // Avoid redundant dispatch via actions.setPhaseData which can reset totals.

      // This ensures heartbeat and progress updates are consistent with Redux state
      const localAnalyzingRef = { current: true };

      // Heartbeat interval - just updates lastActivity to keep analysis alive.
      // Defer setState to avoid blocking the interval handler (Chrome Long Task violations).
      heartbeatIntervalRef.current = setInterval(() => {
        if (!isActiveRun()) {
          if (heartbeatIntervalRef.current) {
            clearInterval(heartbeatIntervalRef.current);
            heartbeatIntervalRef.current = null;
          }
          return;
        }
        if (localAnalyzingRef.current) {
          const prev = analysisProgressRef.current;
          const currentProgress = {
            current: prev?.current ?? 0,
            total: prev?.total ?? uniqueFiles.length,
            lastActivity: Date.now()
          };

          if (validateProgressState(currentProgress)) {
            // Low-priority update: keeps the interval tick cheap and avoids Chrome attributing
            // a full progress re-render to a nested setTimeout handler.
            startTransition(() => {
              if (localAnalyzingRef.current && isActiveRun()) {
                dispatchProgressUpdate(currentProgress);
              }
            });
          } else {
            logger.warn('Invalid heartbeat progress, resetting');
            if (heartbeatIntervalRef.current) {
              clearInterval(heartbeatIntervalRef.current);
              heartbeatIntervalRef.current = null;
            }
            resetAnalysisState('Invalid heartbeat progress');
          }
        }
      }, TIMEOUTS.HEARTBEAT_INTERVAL);

      // Global analysis watchdog:
      // - inactivity timeout: reset only when there is no progress for GLOBAL_ANALYSIS window
      // - hard cap timeout: absolute upper bound to avoid runaway background loops
      const analysisStartedAt = Date.now();
      const fallbackPerFileMs = 45000;
      const maxHardCapMs = 6 * 60 * 60 * 1000;
      const baselineHardCapMs = Math.max(TIMEOUTS.GLOBAL_ANALYSIS * 6, 60 * 60 * 1000);
      let hardCapMs = baselineHardCapMs;
      let hardCapLabel = `${Math.round(hardCapMs / 60000)} min`;
      const windowLabel = `${Math.round(TIMEOUTS.GLOBAL_ANALYSIS / 60000)} min`;
      const stopAnalysisForTimeout = (/** @type {any} */ reason) => {
        logger.warn('Global analysis timeout', {
          reason,
          windowLabel,
          hardCapLabel
        });
        captureCancelledBatchSnapshot(runId);
        if (analysisRunIdRef.current === runId) {
          analysisRunIdRef.current += 1;
        }
        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current);
          heartbeatIntervalRef.current = null;
        }
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
        }
        analysisLockRef.current = false;
        localAnalyzingRef.current = false;
        setGlobalAnalysisActive(false);
        if (lockTimeoutRef.current) {
          clearTimeout(lockTimeoutRef.current);
          lockTimeoutRef.current = null;
        }
        const timeoutMessage =
          reason === 'hard_cap'
            ? `Analysis exceeded the safety window (${hardCapLabel}). Consider reducing file count per run.`
            : `Analysis was stopped after no progress for ${windowLabel}.`;
        startTransition(() => {
          flushPendingResults(true);
          pendingFilesRef.current = [];
          requeueInFlightFileStates();
          setIsAnalyzing(false);
          setAnalysisProgress({ current: 0, total: 0, lastActivity: 0 });
          setCurrentAnalysisFile('');
          actions.setPhaseData('currentAnalysisFile', '');
          addNotification(timeoutMessage, 'warning', 5000, 'analysis-timeout');
        });
      };
      const scheduleGlobalTimeoutCheck = () => {
        analysisTimeoutRef.current = setTimeout(() => {
          if (!isActiveRun()) {
            analysisTimeoutRef.current = null;
            return;
          }
          const elapsedMs = Date.now() - analysisStartedAt;
          const lastProgressAt = Number.isFinite(lastProgressAtRef.current)
            ? lastProgressAtRef.current
            : 0;
          const inactivityMs = lastProgressAt ? Date.now() - lastProgressAt : Infinity;
          const state = /** @type {any} */ (store.getState());
          const progressState =
            state.analysis.analysisProgress || analysisProgressRef.current || {};
          const hasCompleted =
            Number(progressState.total) > 0 &&
            Number(progressState.current) >= Number(progressState.total);

          if (hasCompleted) {
            analysisTimeoutRef.current = null;
            return;
          }
          if (elapsedMs >= hardCapMs) {
            analysisTimeoutRef.current = null;
            queueMicrotask(() => stopAnalysisForTimeout('hard_cap'));
            return;
          }
          if (inactivityMs >= TIMEOUTS.GLOBAL_ANALYSIS) {
            analysisTimeoutRef.current = null;
            queueMicrotask(() => stopAnalysisForTimeout('inactivity'));
            return;
          }
          scheduleGlobalTimeoutCheck();
        }, TIMEOUTS.GLOBAL_ANALYSIS);
      };
      scheduleGlobalTimeoutCheck();

      batchResultsRef.current = [];
      pendingResultsRef.current = [];
      lastResultsFlushRef.current = 0;
      let maxConcurrent = CONCURRENCY.DEFAULT_WORKERS;
      let autoConcurrency = true;
      let systemRecommended = CONCURRENCY.DEFAULT_WORKERS;

      try {
        // Get system-recommended value based on VRAM (primary source)
        try {
          const getConcurrency = window?.electronAPI?.system?.getRecommendedConcurrency;
          if (typeof getConcurrency === 'function') {
            const recommendation = await getConcurrency();
            if (recommendation?.success && recommendation.maxConcurrent) {
              systemRecommended = recommendation.maxConcurrent;
              logger.info('System-recommended concurrency:', {
                maxConcurrent: recommendation.maxConcurrent,
                reason: recommendation.reason,
                vramMB: recommendation.vramMB
              });
            }
          }
        } catch {
          // Fall back to default if recommendation fails
        }

        // Use system recommendation as the baseline (hardware-aware default)
        maxConcurrent = systemRecommended;

        // Resolve against the user's auto/manual choice:
        // - Auto (default): always use the hardware recommendation.
        // - Manual (autoConcurrency === false): honor the user's explicit value
        //   as a deliberate power-user opt-out of the hardware cap.
        const getSettings = window?.electronAPI?.settings?.get;
        if (typeof getSettings === 'function') {
          const persistedSettings = await getSettings();
          const auto = persistedSettings?.autoConcurrency !== false;
          autoConcurrency = auto;
          if (!auto && persistedSettings?.maxConcurrentAnalysis !== undefined) {
            const userSetting = Number(persistedSettings.maxConcurrentAnalysis);
            if (Number.isFinite(userSetting) && userSetting >= CONCURRENCY.MIN_WORKERS) {
              maxConcurrent = userSetting;
              if (userSetting > systemRecommended) {
                logger.warn('Manual concurrency exceeds hardware recommendation; clamping', {
                  userSetting,
                  systemRecommended
                });
                maxConcurrent = systemRecommended;
                addNotification(
                  `Analysis concurrency clamped to ${systemRecommended} worker${systemRecommended === 1 ? '' : 's'} ` +
                    `(GPU VRAM limit). Enable auto concurrency in Settings to follow hardware recommendations.`,
                  'warning',
                  6000,
                  'analysis-concurrency-clamp'
                );
              }
            }
          }
        }
      } catch {
        // Use default
      }

      const concurrency = Math.max(
        CONCURRENCY.MIN_WORKERS,
        Math.min(Number(maxConcurrent) || CONCURRENCY.DEFAULT_WORKERS, CONCURRENCY.MAX_WORKERS)
      );
      const projectedMs =
        Math.ceil(uniqueFiles.length / Math.max(1, concurrency)) * fallbackPerFileMs +
        15 * 60 * 1000;
      hardCapMs = Math.min(Math.max(baselineHardCapMs, projectedMs), maxHardCapMs);
      hardCapLabel = `${Math.round(hardCapMs / 60000)} min`;

      // O-3: an analysis run is a multi-invoke user action — group all its
      // main-process logs under one correlation id. Opened only after the
      // lock/guards, so no-op calls never create sessions. The run can exceed
      // the default 60s trace budget, so size it to the watchdog hard cap.
      const traceSession =
        window.electronAPI?.trace?.beginSession?.(undefined, { maxDurationMs: hardCapMs }) || null;

      try {
        logger.info('Configured global analysis watchdog', {
          fileCount: uniqueFiles.length,
          concurrency,
          inactivityWindowMin: Math.round(TIMEOUTS.GLOBAL_ANALYSIS / 60000),
          hardCapMin: Math.round(hardCapMs / 60000)
        });
        logger.info(`Starting analysis of ${uniqueFiles.length} files`);
        addNotification(
          `Starting AI analysis of ${uniqueFiles.length} files...`,
          'info',
          3000,
          'analysis-start'
        );

        const processedFiles = new Set();
        // Canonical paths whose results were already applied by the batch
        // path's streamed analysis:file-complete events. When the batch
        // invoke fails AFTER some files streamed in, the per-file fallback
        // pool must skip these — re-queueing the full list flipped ready
        // files back to "analyzing", ran a second LLM pass, and appended
        // duplicate entries to batchResultsRef (inflating the completion
        // notification counts).
        const appliedResultPaths = new Set();
        const fileQueue = [...uniqueFiles];
        completedCountRef.current = 0;
        const fileByPath = new Map(uniqueFiles.map((/** @type {any} */ file) => [file.path, file]));

        const runBatchPath = async () => {
          const batchApi = window?.electronAPI?.analysis?.batch;
          if (typeof batchApi !== 'function') {
            throw new Error('Batch analysis API not available');
          }

          for (const file of uniqueFiles) {
            const fileName = file.name || file.path.split(/[\\/]/).pop();
            updateFileState(file.path, 'analyzing', { fileName });
          }

          const clientBatchId =
            globalThis.crypto?.randomUUID?.() ||
            `analysis_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
          activeBatchIdRef.current = clientBatchId;
          cancelInFlightBatchIdRef.current = null;
          let resolvedBatchId = clientBatchId;
          const onBatchProgress = (/** @type {any} */ event) => {
            if (!isActiveRun() || abortSignal.aborted) return;
            const payload = event?.detail;
            if (!payload || payload.type !== 'batch_analyze') return;
            if (payload.batchId && payload.batchId !== resolvedBatchId) {
              // Accept one-time server-side batch id remap for compatibility.
              if (resolvedBatchId === clientBatchId) {
                resolvedBatchId = payload.batchId;
                activeBatchIdRef.current = payload.batchId;
                cancelInFlightBatchIdRef.current = null;
              } else {
                return;
              }
            }

            const previousCompleted = Number(completedCountRef.current) || 0;
            const current = Math.min(Number(payload.completed) || 0, uniqueFiles.length);
            if (current > previousCompleted && typeof payload.currentFile === 'string') {
              batchCompletedPathsRef.current.add(payload.currentFile);
            }
            completedCountRef.current = current;
            lastProgressAtRef.current = Date.now();

            const currentFileName = payload.currentFile ? extractFileName(payload.currentFile) : '';
            if (currentFileName) {
              setCurrentAnalysisFile(currentFileName);
              actions.setPhaseData('currentAnalysisFile', currentFileName);
            }

            // Progress counts in Redux come from ipcMiddleware (throttled). Avoid a second
            // dispatchProgressUpdate here — it duplicated store writes on every IPC event.
          };

          // Live per-file results streamed from main (analysis:file-complete) so
          // items appear in the review list and the pipeline counter moves as each
          // file finishes, instead of all at once when the batch invoke resolves.
          // streamedPaths dedups against the post-invoke reconciliation loop below.
          const streamedPaths = new Set();
          const onFileStreamed = (/** @type {any} */ event) => {
            if (!isActiveRun() || abortSignal.aborted) return;
            const payload = event?.detail;
            const item = payload?.item;
            const filePath = item?.filePath;
            if (typeof filePath !== 'string' || !filePath) return;
            if (
              payload?.batchId &&
              payload.batchId !== resolvedBatchId &&
              payload.batchId !== clientBatchId
            ) {
              return;
            }
            const canon = toCanonicalPath(filePath);
            if (canon && streamedPaths.has(canon)) return;
            if (canon) {
              streamedPaths.add(canon);
              appliedResultPaths.add(canon);
            }

            // Progress counts (current/total) stay owned by onBatchProgress via
            // the throttled operation-progress events; this handler only owns the
            // per-file results + fileStates transition that drives the review list
            // and the dashboard pending/ready counters.
            const fileInfoRaw = fileByPath.get(filePath) || { path: filePath };
            const fileInfo = {
              ...fileInfoRaw,
              size: fileInfoRaw.size || 0,
              created: fileInfoRaw.created,
              modified: fileInfoRaw.modified
            };
            const resultPayload = item?.result ?? null;
            const explicitError =
              item?.success === false
                ? item?.error || resultPayload?.error || 'Analysis failed'
                : null;
            // applyAnalysisOutcome -> recordAnalysisResult -> flushPendingResults:
            // moves this file pending -> ready and surfaces it in the review list.
            applyAnalysisOutcome(fileInfo, resultPayload, explicitError);
          };

          const abortListener = () => {
            window.removeEventListener(BATCH_ANALYSIS_PROGRESS_EVENT, onBatchProgress);
            requestMainBatchCancel('abort-signal');
          };
          abortSignal.addEventListener('abort', abortListener);

          window.addEventListener(BATCH_ANALYSIS_PROGRESS_EVENT, onBatchProgress);
          window.addEventListener('analysis:file-complete', onFileStreamed);
          try {
            const batchResult = await withTimeout(
              batchApi({
                batchId: clientBatchId,
                filePaths: uniqueFiles.map((/** @type {any} */ file) => file.path),
                options: {
                  concurrency,
                  autoConcurrency,
                  sectionOrder: 'documents-first',
                  enableVisionBatchMode: true,
                  namingSettings
                }
              }),
              TIMEOUTS.AI_ANALYSIS_BATCH,
              `Batch analysis for ${uniqueFiles.length} files`
            );

            if (!batchResult || !Array.isArray(batchResult.results)) {
              throw new Error('Batch analysis returned an invalid result payload');
            }

            const cancelledSnapshot = cancelledBatchSnapshotRef.current;
            const shouldRecoverCancelledBatch =
              (abortSignal.aborted || !isActiveRun()) &&
              cancelledSnapshot &&
              cancelledSnapshot.runId === runId;
            if (shouldRecoverCancelledBatch) {
              // Apply ALL completed results from the batch — batchResult.results is the source
              // of truth. Progress events can be throttled, so completedAtCancel may undercount.
              const completedResults = batchResult.results.filter(
                (/** @type {any} */ item) => item && typeof item.filePath === 'string'
              );
              if (completedResults.length > 0) {
                for (const item of completedResults) {
                  const filePath = item.filePath;
                  const fileInfoRaw = fileByPath.get(filePath) || { path: filePath };
                  const fileInfo = {
                    ...fileInfoRaw,
                    size: fileInfoRaw.size || 0,
                    created: fileInfoRaw.created,
                    modified: fileInfoRaw.modified
                  };
                  const resultPayload = item?.result ?? null;
                  const explicitError =
                    item?.success === false
                      ? item?.error || resultPayload?.error || 'Analysis failed'
                      : null;
                  const recoverCanon = toCanonicalPath(fileInfo.path);
                  if (!recoverCanon || !streamedPaths.has(recoverCanon)) {
                    if (recoverCanon) streamedPaths.add(recoverCanon);
                    applyAnalysisOutcome(fileInfo, resultPayload, explicitError);
                  }
                }
                flushPendingResults(true);
              }
              return;
            }

            const totalResults = batchResult.results.length;
            for (let i = 0; i < totalResults; i += 1) {
              if (!isActiveRun() || abortSignal.aborted) return;
              const item = batchResult.results[i];
              const filePath = item?.filePath;
              const fileInfoRaw = fileByPath.get(filePath) || { path: filePath || '' };
              const fileInfo = {
                ...fileInfoRaw,
                size: fileInfoRaw.size || 0,
                created: fileInfoRaw.created,
                modified: fileInfoRaw.modified
              };
              if (!fileInfo.path) {
                continue;
              }
              const resultPayload = item?.result ?? null;
              const explicitError =
                item?.success === false
                  ? item?.error || resultPayload?.error || 'Analysis failed'
                  : null;

              // Skip files already applied via the live analysis:file-complete
              // stream; re-applying double-counts them in batchResultsRef (used
              // for the success/failure totals in the completion notification).
              const reconcileCanon = toCanonicalPath(fileInfo.path);
              if (!reconcileCanon || !streamedPaths.has(reconcileCanon)) {
                if (reconcileCanon) streamedPaths.add(reconcileCanon);
                applyAnalysisOutcome(fileInfo, resultPayload, explicitError);
              }

              const newCompletedCount = Math.min(i + 1, uniqueFiles.length);
              completedCountRef.current = newCompletedCount;
              lastProgressAtRef.current = Date.now();
              const progress = {
                current: newCompletedCount,
                total: uniqueFiles.length,
                lastActivity: Date.now()
              };
              dispatchProgressUpdate(progress);
            }
          } catch (batchPathError) {
            // A renderer-side failure (most importantly the withTimeout above
            // expiring) does NOT stop the main-process batch — it keeps
            // churning through files. Cancel it HERE, while activeBatchIdRef
            // is still set (the finally below clears it, and the caller's
            // fallback then starts the per-file worker pool — without this
            // cancel, both would run the same files concurrently, doubling
            // inference load on exactly the slow machines that time out).
            requestMainBatchCancel('batch-path-failed');
            throw batchPathError;
          } finally {
            window.removeEventListener(BATCH_ANALYSIS_PROGRESS_EVENT, onBatchProgress);
            window.removeEventListener('analysis:file-complete', onFileStreamed);
            abortSignal.removeEventListener('abort', abortListener);
            if (
              activeBatchIdRef.current === clientBatchId ||
              activeBatchIdRef.current === resolvedBatchId
            ) {
              activeBatchIdRef.current = null;
            }
          }
        };

        const processFile = async (/** @type {any} */ file) => {
          if (!isActiveRun() || abortSignal.aborted) return;
          if (processedFiles.has(file.path)) return;
          // Result already applied by a streamed batch event — nothing left
          // to do for this file (see appliedResultPaths above).
          if (appliedResultPaths.has(toCanonicalPath(file.path))) return;

          const fileName = file.name || file.path.split(/[\\/]/).pop();
          processedFiles.add(file.path);
          updateFileState(file.path, 'analyzing', { fileName });

          // React batches state updates, so we force an immediate update cycle
          // by updating state and flushing phase data synchronously
          setCurrentAnalysisFile(fileName);
          actions.setPhaseData('currentAnalysisFile', fileName);

          // This provides visual feedback during long-running analysis (18-40s per image)
          const progressBeforeAnalysis = {
            current: completedCountRef.current,
            total: uniqueFiles.length,
            currentFile: fileName,
            lastActivity: Date.now()
          };
          dispatchProgressUpdate(progressBeforeAnalysis);

          // Force a microtask yield to allow React to process the state update
          await Promise.resolve();

          const fileInfo = {
            ...file,
            size: file.size || 0,
            created: file.created,
            modified: file.modified
          };

          try {
            const analysis = await withTimeout(
              analyzeWithRetry(file.path, 1, abortSignal, namingSettings),
              TIMEOUTS.AI_ANALYSIS_LONG,
              `Analysis for ${fileName}`
            );

            // This prevents state updates if the user cancelled while analysis was in flight
            if (!isActiveRun() || abortSignal.aborted) return;

            // This prevents race conditions where multiple workers read same value
            const newCompletedCount = ++completedCountRef.current;
            lastProgressAtRef.current = Date.now();
            const progress = {
              current: Math.min(newCompletedCount, uniqueFiles.length),
              total: uniqueFiles.length,
              lastActivity: Date.now()
            };

            // Throttle progress updates to prevent excessive re-renders
            dispatchProgressUpdate(progress);

            if (isActiveRun()) {
              applyAnalysisOutcome(fileInfo, analysis);
            }
          } catch (error) {
            if (!isActiveRun() || abortSignal.aborted) return;
            const newCompletedCount = ++completedCountRef.current;
            lastProgressAtRef.current = Date.now();
            const progress = {
              current: Math.min(newCompletedCount, uniqueFiles.length),
              total: uniqueFiles.length,
              lastActivity: Date.now()
            };
            // Throttle progress updates to prevent excessive re-renders
            dispatchProgressUpdate(progress);

            if (!isActiveRun()) return;
            applyAnalysisOutcome(fileInfo, null, error.message);
          }
        };

        // Use a worker pool pattern for true parallel processing
        // This keeps all workers busy instead of waiting for batches to complete
        const runWorkerPool = async () => {
          const queue = fileQueue.slice().reverse();

          const worker = async () => {
            while (queue.length > 0) {
              if (abortSignal.aborted || !isActiveRun()) {
                return;
              }
              const file = queue.pop();
              if (!file) break;
              await processFile(file);
            }
          };

          // Start all workers in parallel
          const workers = Array(Math.min(concurrency, fileQueue.length))
            .fill(null)
            .map(() => worker());

          // This ensures all workers complete even if some throw unexpectedly
          const workerResults = await Promise.allSettled(workers);

          // Log any worker failures for debugging
          const failedWorkers = workerResults.filter((r) => r.status === 'rejected');
          if (failedWorkers.length > 0) {
            logger.warn('Some analysis workers failed unexpectedly', {
              failed: failedWorkers.length,
              total: workers.length,
              errors: failedWorkers.map((r) => r.reason?.message || 'Unknown error')
            });
          }

          if (!isActiveRun() || abortSignal.aborted) {
            addNotification('Analysis cancelled by user', 'info', 2000);
          }
        };

        const useBatchPath = shouldUseBatchAnalysis(
          uniqueFiles.length,
          concurrency,
          systemRecommended
        );
        if (useBatchPath) {
          try {
            logger.info('Using batch analysis path', {
              fileCount: uniqueFiles.length,
              concurrency,
              systemRecommended,
              lowVramBatch: systemRecommended === 1
            });
            await runBatchPath();
          } catch (batchError) {
            const isLegacyBatchTimeout =
              String(batchError?.message || '').includes('30000ms') &&
              String(batchError?.message || '').includes('analysis:analyze-batch');
            logger.warn('Batch analysis path failed, falling back to per-file worker pool', {
              error: batchError?.message,
              legacyTimeoutDetected: isLegacyBatchTimeout
            });
            addNotification(
              isLegacyBatchTimeout
                ? 'Batch analysis timed out at legacy 30s timeout. Falling back to per-file mode; restart app to load updated preload timeouts.'
                : 'Batch analysis encountered an issue. Falling back to per-file processing.',
              'warning',
              isLegacyBatchTimeout ? 7000 : 3500,
              'analysis-batch-fallback'
            );
            await runWorkerPool();
          }
        } else {
          await runWorkerPool();
        }

        if (!isActiveRun()) return;

        const finalProgress = {
          current: Math.min(completedCountRef.current, uniqueFiles.length),
          total: uniqueFiles.length,
          lastActivity: Date.now()
        };
        dispatchProgressUpdate(finalProgress, { force: true });

        const batchResults = batchResultsRef.current;
        // Merge results using extracted helper functions
        const mergedResults = dedupeSuggestedNames(
          mergeAnalysisResults(analysisResultsRef.current, batchResults)
        );
        setAnalysisResults(mergedResults);

        const mergedStates = mergeFileStates(fileStatesRef.current, mergedResults);
        setFileStates(mergedStates);

        analysisResultsRef.current = mergedResults;
        fileStatesRef.current = mergedStates;

        // Show completion notification
        const successCount = batchResults.filter((r) => r.analysis).length;
        const failureCount = batchResults.length - successCount;
        showAnalysisCompletionNotification({
          successCount,
          failureCount,
          addNotification,
          actions,
          getCurrentPhase,
          autoAdvanceTimeoutRef
        });
      } catch (error) {
        if (error.message !== 'Analysis cancelled by user') {
          const { message } = mapErrorToNotification({ error });
          addNotification(`Analysis failed: ${message}`, 'error', 5000, 'analysis-error');
        }
      } finally {
        traceSession?.end?.();
        const shouldCleanup = isActiveRun();
        if (shouldCleanup) {
          invalidateEmbeddingStatsCache();
          flushPendingResults(true);
          if (heartbeatIntervalRef.current) {
            clearInterval(heartbeatIntervalRef.current);
            heartbeatIntervalRef.current = null;
          }
          if (analysisTimeoutRef.current) {
            clearTimeout(analysisTimeoutRef.current);
            analysisTimeoutRef.current = null;
          }

          // Update local refs to ensure proper lock synchronization
          localAnalyzingRef.current = false;

          const state = /** @type {any} */ (store.getState());
          const progress = state.analysis.analysisProgress || analysisProgressRef.current;
          const trackedTotal =
            Number.isInteger(progress?.total) && progress.total > 0 ? progress.total : files.length;
          const didComplete = trackedTotal > 0 && completedCountRef.current >= trackedTotal;
          if (!didComplete) {
            requeueInFlightFileStates();
          }

          // If we already completed, clear state even if component unmounted to avoid
          // "analysis continuing in background" banners with 100% progress.
          if (isMountedRef.current || didComplete) {
            isAnalyzingRef.current = false;
            setIsAnalyzing(false);

            if (clearCurrentFileTimeoutRef.current) {
              clearTimeout(clearCurrentFileTimeoutRef.current);
            }
            clearCurrentFileTimeoutRef.current = setTimeout(() => {
              if (isMountedRef.current) {
                setCurrentAnalysisFile('');
                actions.setPhaseData('currentAnalysisFile', '');
              }
            }, 500);

            setAnalysisProgress({ current: 0, total: 0, lastActivity: 0 });
            // Redux is the single source of truth for isAnalyzing.
          } else {
            logger.info('Analysis interrupted by navigation - preserving state for resume');
          }

          analysisLockRef.current = false;
          setGlobalAnalysisActive(false);
          if (lockTimeoutRef.current) {
            clearTimeout(lockTimeoutRef.current);
            lockTimeoutRef.current = null;
          }

          try {
            localStorage.removeItem('stratosort_workflow_state');
          } catch {
            // Non-fatal
          }

          // Recover results that landed in the durable ready queue but never
          // made it into renderer state (dropped file-complete events, batch
          // timeout + fallback races, etc.). Without this, Discover can show
          // "waiting for analysis" after main already finished the run.
          void hydrateReadyQueueResults();

          // Process any files that were queued during this analysis batch
          if (pendingFilesRef.current.length > 0) {
            const filesToProcess = [...pendingFilesRef.current];
            pendingFilesRef.current = [];
            logger.info('Processing queued files', {
              fileCount: filesToProcess.length
            });
            // Use setTimeout to allow state to settle before starting next batch
            if (pendingFilesTimeoutRef.current) {
              clearTimeout(pendingFilesTimeoutRef.current);
            }
            pendingFilesTimeoutRef.current = setTimeout(() => {
              if (
                isMountedRef.current &&
                analyzeFilesRef.current &&
                analysisRunIdRef.current === runId
              ) {
                analyzeFilesRef.current(filesToProcess);
              }
            }, 100);
          }
        }
      }
      return { started: true };
    },
    [
      invalidateEmbeddingStatsCache,
      setIsAnalyzing,
      setCurrentAnalysisFile,
      setAnalysisProgress,
      setAnalysisResults,
      setFileStates,
      updateFileState,
      addNotification,
      actions,
      setGlobalAnalysisActive,
      captureCancelledBatchSnapshot,
      requestMainBatchCancel,
      flushPendingResults,
      applyAnalysisOutcome,
      dispatchProgressUpdate,
      requeueInFlightFileStates,
      resetAnalysisState,
      hydrateReadyQueueResults,
      getCurrentPhase,
      store,
      namingSettings
    ]
  );

  // Store analyzeFiles in ref for external access
  analyzeFilesRef.current = analyzeFiles;

  /**
   * Cancel current analysis
   */
  const cancelAnalysis = useCallback(() => {
    invalidateEmbeddingStatsCache();
    requestMainBatchCancel('user-stop');
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      logger.info('Analysis aborted by user');
    }
    captureCancelledBatchSnapshot(analysisRunIdRef.current);
    clearAutoAdvanceTimeoutRef(autoAdvanceTimeoutRef);
    analysisRunIdRef.current += 1;
    // Ensure locks/timeouts are cleared so a new run can start immediately.
    analysisLockRef.current = false;
    isAnalyzingRef.current = false;
    setGlobalAnalysisActive(false);
    globalAnalysisActiveRef.current = false;
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (analysisTimeoutRef.current) {
      clearTimeout(analysisTimeoutRef.current);
      analysisTimeoutRef.current = null;
    }
    if (lockTimeoutRef.current) {
      clearTimeout(lockTimeoutRef.current);
      lockTimeoutRef.current = null;
    }
    if (pendingFilesTimeoutRef.current) {
      clearTimeout(pendingFilesTimeoutRef.current);
      pendingFilesTimeoutRef.current = null;
    }
    activeBatchIdRef.current = null;
    cancelInFlightBatchIdRef.current = null;
    flushPendingResults(true);
    // Clear any pending files when cancelling
    pendingFilesRef.current = [];
    requeueInFlightFileStates();
    void hydrateReadyQueueResults();
    setIsAnalyzing(false);
    const clearedProgress = { current: 0, total: 0, lastActivity: 0 };
    analysisProgressRef.current = clearedProgress;
    setAnalysisProgress(clearedProgress);
    // Redux is the single source of truth for isAnalyzing.

    // Store timeout in ref so it can be cleared on unmount (Bug 17)
    if (clearCurrentFileTimeoutRef.current) {
      clearTimeout(clearCurrentFileTimeoutRef.current);
    }
    clearCurrentFileTimeoutRef.current = setTimeout(() => {
      clearCurrentFileTimeoutRef.current = null;
      setCurrentAnalysisFile('');
      actions.setPhaseData('currentAnalysisFile', '');
    }, 300);

    addNotification('Analysis stopped', 'info', 2000);
  }, [
    invalidateEmbeddingStatsCache,
    setIsAnalyzing,
    setCurrentAnalysisFile,
    setAnalysisProgress,
    actions,
    addNotification,
    captureCancelledBatchSnapshot,
    requestMainBatchCancel,
    flushPendingResults,
    requeueInFlightFileStates,
    hydrateReadyQueueResults
  ]);

  /**
   * Clear analysis queue. Clears both local state and the durable backend queue
   * so items do not reappear on hydration or app restart.
   */
  const clearAnalysisQueue = useCallback(async () => {
    // Clear auto-advance timeout to prevent unexpected navigation
    clearAutoAdvanceTimeoutRef(autoAdvanceTimeoutRef);
    // Clear any pending files
    pendingFilesRef.current = [];
    // Release any in-flight work and reset lock/liveness state.
    resetAnalysisState('Queue cleared');
    // Queue clear is stronger than reset: wipe in-memory results/state too.
    setAnalysisResults([]);
    setFileStates({});
    actions.setPhaseData('selectedFiles', []);
    actions.setPhaseData('analysisResults', []);
    actions.setPhaseData('fileStates', {});

    // Clear durable backend queue so items do not reappear on hydration/restart
    try {
      await window.electronAPI?.analysis?.clearReadyQueue?.();
    } catch (err) {
      logger.warn('Failed to clear backend ready queue', { error: err?.message });
    }
    addNotification('Analysis queue cleared', 'info', 2000, 'queue-management');
  }, [resetAnalysisState, setAnalysisResults, setFileStates, actions, addNotification]);

  /**
   * FIX M-3: Retry failed files - re-analyze files that previously failed
   */
  const retryFailedFiles = useCallback(() => {
    // Canonical-key lookup: fileStates keys and result paths can disagree in
    // case/separator style across IPC sources; a raw lookup misses entries.
    const stateByCanonical = new Map(
      Object.entries(fileStates).map(([p, info]) => [toCanonicalPath(p), info])
    );
    // Find files with error or failed state
    const failedFiles = analysisResults.filter((/** @type {any} */ f) => {
      const state = stateByCanonical.get(toCanonicalPath(f?.path))?.state;
      return state === 'error' || state === 'failed';
    });

    if (failedFiles.length === 0) {
      addNotification('No failed files to retry', 'info', 2000);
      return;
    }

    // Reset states for failed files to pending (resolve the actual stored
    // key through the canonical form so the write hits the existing entry).
    setFileStates((/** @type {any} */ prev) => {
      const keyByCanonical = new Map(Object.keys(prev).map((p) => [toCanonicalPath(p), p]));
      const updated = { ...prev };
      failedFiles.forEach((/** @type {any} */ file) => {
        const key = keyByCanonical.get(toCanonicalPath(file?.path));
        if (key && updated[key]) {
          updated[key] = { ...updated[key], state: 'pending', error: null };
        }
      });
      return updated;
    });

    // Re-analyze the failed files
    addNotification(`Retrying ${failedFiles.length} failed file(s)...`, 'info', 2000);
    if (analyzeFilesRef.current) {
      analyzeFilesRef.current(failedFiles);
    }
  }, [analysisResults, fileStates, setFileStates, addNotification]);

  useEffect(() => {
    // Reset on StrictMode re-mount — refs persist across unmount/remount
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      // Unmounting with an incomplete run: clear Redux isAnalyzing so the
      // navigation bar unblocks (isBlockedByOperation), and park the resume
      // intent in the module flag so the remount resume effect can pick the
      // run back up. Leaving isAnalyzing true here deadlocked navigation.
      if (isAnalyzingRef.current) {
        analysisInterruptedByUnmount = true;
        setIsAnalyzing(false);
        // The abort below kills the in-flight run. Clear runStartedRef so
        // the resume effect on the next mount is allowed to restart it —
        // under StrictMode's simulated unmount the refs persist into the
        // second effect pass, and a stale "run started" would veto resume.
        runStartedRef.current = false;
      }
      // Clear auto-advance timeout
      clearAutoAdvanceTimeoutRef(autoAdvanceTimeoutRef);
      // Clear abort controller
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      // Clear all intervals and timeouts
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
        heartbeatIntervalRef.current = null;
      }
      if (analysisTimeoutRef.current) {
        clearTimeout(analysisTimeoutRef.current);
        analysisTimeoutRef.current = null;
      }
      if (lockTimeoutRef.current) {
        clearTimeout(lockTimeoutRef.current);
        lockTimeoutRef.current = null;
      }
      if (clearCurrentFileTimeoutRef.current) {
        clearTimeout(clearCurrentFileTimeoutRef.current);
        clearCurrentFileTimeoutRef.current = null;
      }
      if (pendingFilesTimeoutRef.current) {
        clearTimeout(pendingFilesTimeoutRef.current);
        pendingFilesTimeoutRef.current = null;
      }
    };
  }, [setIsAnalyzing]);

  // Resume analysis on mount
  useEffect(() => {
    // Consume the one-shot unmount-resume intent on the first run of this
    // effect, whether or not it can be acted on. Clearing it only inside the
    // selectedFiles>0 branch stranded it true when the selection was emptied
    // between unmount and remount — and the next unrelated selection would
    // then auto-start analysis the user never requested.
    const interruptedByUnmount = analysisInterruptedByUnmount;
    analysisInterruptedByUnmount = false;
    if (
      !runStartedRef.current &&
      !hasAttemptedResumeRef.current &&
      // isAnalyzing covers reload-with-persisted-state; the module flag covers
      // unmount-with-incomplete (where isAnalyzing was cleared to unblock nav).
      (isAnalyzing || interruptedByUnmount) &&
      Array.isArray(selectedFiles) &&
      selectedFiles.length > 0
    ) {
      // Canonical-key lookup: fileStates keys and selected paths can disagree
      // in case/separator style; a raw lookup misclassifies done files as
      // pending and re-analyzes them on resume.
      const stateByCanonical = new Map(
        Object.entries(fileStates).map(([p, info]) => [toCanonicalPath(p), info])
      );
      const remaining = selectedFiles.filter((f) => {
        const state = stateByCanonical.get(toCanonicalPath(f?.path))?.state;
        return state !== 'ready' && state !== 'error';
      });

      hasAttemptedResumeRef.current = true;

      if (remaining.length > 0) {
        addNotification(
          `Resuming analysis of ${remaining.length} files...`,
          'info',
          3000,
          'analysis-resume'
        );
        if (analyzeFilesRef.current) {
          analyzeFilesRef.current(remaining);
        }
      } else {
        resetAnalysisState('No remaining files');
      }
    }

    // StrictMode dev-mode remount: clear the per-mount "I attempted resume"
    // flag so the re-mounted effect gets a fresh chance. runStartedRef persists
    // because it represents a real run that has begun.
    return () => {
      hasAttemptedResumeRef.current = false;
    };
  }, [isAnalyzing, selectedFiles, fileStates, addNotification, resetAnalysisState]);

  return {
    analyzeFiles,
    analyzeFilesRef,
    pruneBatchResultsForPath,
    cancelAnalysis,
    clearAnalysisQueue,
    retryFailedFiles,
    resetAnalysisState,
    generatePreviewName
  };
}
