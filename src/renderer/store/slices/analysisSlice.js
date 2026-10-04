// @ts-check
import { createSlice } from '@reduxjs/toolkit';
import { logger } from '../../../shared/logger';

// Lowercase the WHOLE Windows-style path (not just the drive prefix). On the
// dominant Windows case-insensitive volume, drag-and-drop, settings round-
// trips, and different OS/IPC sources can produce the same logical file
// path with different cases ("Report.PDF" vs "report.pdf"). Folding to
// lowercase keeps them dedup'd. On case-sensitive NTFS volumes (rare —
// requires explicit `fsutil file setCaseSensitiveInfo enable` opt-in or
// WSL2 mounts) this CAN over-conflate distinct files, but that population
// is small enough that the trade-off favors the dominant case. Track in
// the audit plan as a known edge case if a case-sensitive NTFS user reports
// missing files in the analysis history.
import { toCanonicalPath } from '../../utils/canonicalPath';

/**
 * Maximum number of analysis results to retain in the store.
 * When this limit is exceeded, the oldest entries are trimmed.
 * Uses a hardcoded default as a safety net in case the import fails
 * (performanceConstants is a CommonJS module).
 */
let MAX_ANALYSIS_RESULTS = 5000;
try {
  const { LIMITS } = require('../../../shared/performanceConstants');
  if (LIMITS && typeof LIMITS.MAX_ANALYSIS_RESULTS === 'number') {
    MAX_ANALYSIS_RESULTS = LIMITS.MAX_ANALYSIS_RESULTS;
  }
} catch {
  // Use default if import fails
}

/**
 * Trim the results array to the maximum allowed size by removing the oldest entries.
 * Oldest entries are those at the beginning of the array (earliest push order).
 */
function enforceResultsLimit(/** @type {any} */ results) {
  if (results.length > MAX_ANALYSIS_RESULTS) {
    const excess = results.length - MAX_ANALYSIS_RESULTS;
    results.splice(0, excess);
  }
}

/** @type {any} */
const initialState = {
  isAnalyzing: false,
  currentAnalysisFile: '',
  analysisProgress: {
    current: 0,
    total: 0,
    lastActivity: 0
  },
  results: [] // Analysis results
};

const analysisSlice = createSlice({
  name: 'analysis',
  initialState,
  reducers: {
    startAnalysis: (state, action) => {
      state.isAnalyzing = true;
      // Merge rather than replace the total: callers that don't know the batch
      // size (or read it from a stale ref) must not zero a total that a prior
      // updateProgress already established — that collapsed the progress bar
      // to 0/0 at the exact moment analysis started.
      const payloadTotal = action.payload?.total;
      state.analysisProgress = {
        current: 0,
        total:
          typeof payloadTotal === 'number' && payloadTotal > 0
            ? payloadTotal
            : state.analysisProgress?.total || 0,
        lastActivity: action.payload?.timestamp || Date.now()
      };
      // Optionally clear previous results if new batch
      if (action.payload?.clearPrevious) {
        state.results = [];
      }
    },
    updateProgress: (state, action) => {
      const payload = action.payload;
      const current = state.analysisProgress;
      // analysisProgress carries a fixed shape: { current, total, lastActivity }.
      // IPC payloads commonly include `currentFile` and `timestamp` too, which
      // were previously spread into analysisProgress, polluting the shape.
      // Selectors hid the pollution but persisted snapshots and devtools
      // carried it. Pull only the known progress keys; route currentFile to
      // its own slice field below.
      const PROGRESS_KEYS = ['current', 'total'];
      const meaningfulChange = PROGRESS_KEYS.some(
        (key) => key in payload && current[key] !== payload[key]
      );
      const nextLastActivity = payload.timestamp || payload.lastActivity || Date.now();
      if (meaningfulChange || !current.lastActivity) {
        const nextProgress = { ...current, lastActivity: nextLastActivity };
        for (const key of PROGRESS_KEYS) {
          if (key in payload) nextProgress[key] = payload[key];
        }
        state.analysisProgress = nextProgress;
      } else {
        // Always keep lastActivity fresh for liveness detection, even when
        // progress counts haven't changed. Without this, heartbeat-only
        // updates are silently discarded and the stale-lock detector at
        // useAnalysis.js:700-715 can false-trigger during slow inference.
        state.analysisProgress = { ...current, lastActivity: nextLastActivity };
      }
      if (payload.currentFile) {
        state.currentAnalysisFile = payload.currentFile;
      }
    },
    stopAnalysis: (state) => {
      state.isAnalyzing = false;
      state.currentAnalysisFile = '';
    },
    setAnalysisResults: (state, action) => {
      state.results = action.payload;
      enforceResultsLimit(state.results);
    },
    mergeAnalysisResults: (state, action) => {
      const incoming = Array.isArray(action.payload) ? action.payload : [];
      if (incoming.length === 0) return;

      const indexByPath = new Map();
      state.results.forEach((/** @type {any} */ result, /** @type {any} */ index) => {
        const canon = toCanonicalPath(result?.path);
        if (canon) {
          indexByPath.set(canon, index);
        }
      });

      incoming.forEach((/** @type {any} */ result) => {
        const resultPath = result?.path;
        if (typeof resultPath !== 'string' || resultPath.length === 0) return;

        const canonicalPath = toCanonicalPath(resultPath);
        const existingIndex = indexByPath.get(canonicalPath);
        if (existingIndex === undefined) {
          state.results.push(/** @type {any} */ result);
          indexByPath.set(canonicalPath, state.results.length - 1);
          return;
        }
        state.results[existingIndex] = result;
      });

      enforceResultsLimit(state.results);
    },
    updateAnalysisResult: (state, action) => {
      const { path, changes } = action.payload;
      // Canonicalize both sides so case/separator variants of the same logical
      // path on Windows resolve to the same record. Sibling reducers
      // (mergeAnalysisResults, removeAnalysisResultsByPaths) already do this;
      // raw === comparison silently dropped updates when paths arrived in
      // different shapes from different IPC sources.
      const target = toCanonicalPath(path);
      const index = state.results.findIndex(
        (/** @type {any} */ r) => toCanonicalPath(r?.path) === target
      );
      if (index >= 0) {
        // Initialize analysis to empty object if absent (e.g., failed analysis stored with null)
        if (!state.results[index].analysis) {
          state.results[index].analysis = {};
        }
        state.results[index].analysis = {
          ...state.results[index].analysis,
          ...changes
        };
      }
    },
    updateEmbeddingState: (state, action) => {
      const { path, embeddingPolicy, embeddingStatus } = action.payload || {};
      if (!path) return;
      const target = toCanonicalPath(path);
      const index = state.results.findIndex(
        (/** @type {any} */ r) => toCanonicalPath(r?.path) === target
      );
      if (index < 0) return;
      if (embeddingPolicy !== undefined) {
        state.results[index].embeddingPolicy = embeddingPolicy;
        if (state.results[index].analysis) {
          state.results[index].analysis.embeddingPolicy = embeddingPolicy;
        }
      }
      if (embeddingStatus !== undefined) {
        state.results[index].embeddingStatus = embeddingStatus;
        if (state.results[index].analysis) {
          state.results[index].analysis.embeddingStatus = embeddingStatus;
        }
      }
    },
    resetAnalysisState: () => {
      return initialState;
    },
    // Clears in-progress state but preserves existing results
    resetToSafeState: (state) => {
      state.isAnalyzing = false;
      state.currentAnalysisFile = '';
      state.analysisProgress = { current: 0, total: 0, lastActivity: 0 };
      // Keep results - user may want to see what was analyzed before the error
    },
    // This prevents orphaned analysis results that consume memory
    removeAnalysisResultsByPaths: (state, action) => {
      if (!Array.isArray(action.payload)) return;
      const pathsToRemove = new Set(action.payload.map(toCanonicalPath).filter(Boolean));
      state.results = state.results.filter(
        (/** @type {any} */ r) => !pathsToRemove.has(toCanonicalPath(r?.path))
      );
    },
    // Remove single analysis result by path
    removeAnalysisResult: (state, action) => {
      const pathToRemove = action.payload;
      if (!pathToRemove) return;
      const target = toCanonicalPath(pathToRemove);
      state.results = state.results.filter(
        (/** @type {any} */ r) => toCanonicalPath(r?.path) !== target
      );
    },
    // Keeps analysis results in sync with actual file locations
    updateResultPathsAfterMove: (state, action) => {
      const { oldPaths, newPaths } = action.payload;
      if (!Array.isArray(oldPaths) || !Array.isArray(newPaths)) return;

      // Enforce atomicity: never perform partial path remaps.
      if (oldPaths.length !== newPaths.length) {
        logger.error(
          '[analysisSlice] updateResultPathsAfterMove: array length mismatch, skipping',
          {
            oldPathsLength: oldPaths.length,
            newPathsLength: newPaths.length,
            action: 'no-op to preserve state consistency'
          }
        );
        return;
      }

      // Create path mapping only after payload validation passes.
      const pathMap = Object.fromEntries(
        oldPaths
          .map((oldPath, i) => [toCanonicalPath(oldPath), newPaths[i]])
          .filter(([oldPath]) => Boolean(oldPath))
      );

      // Update results array with new paths
      state.results = state.results.map((/** @type {any} */ result) => {
        const newPath = pathMap[toCanonicalPath(result?.path)];
        if (newPath) {
          return {
            ...result,
            path: newPath,
            name: newPath.split(/[\\/]/).pop() || result.name
          };
        }
        return result;
      });
    }
  }
});

export const {
  startAnalysis,
  updateProgress,
  stopAnalysis,
  setAnalysisResults,
  mergeAnalysisResults,
  updateAnalysisResult,
  updateEmbeddingState,
  resetAnalysisState,
  resetToSafeState,
  removeAnalysisResultsByPaths,
  removeAnalysisResult,
  updateResultPathsAfterMove
} = analysisSlice.actions;

export default analysisSlice.reducer;
