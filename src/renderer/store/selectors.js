// @ts-check
/**
 * Redux Selectors
 *
 * Centralized selectors for computed state. These help prevent disconnections
 * between phases by ensuring data is consistently merged.
 *
 * PERFORMANCE FIX: Uses reference-stable selectors to prevent unnecessary re-renders.
 * Each selector caches its previous result and returns the same reference if the
 * output is deeply equal, preventing React components from re-rendering.
 */

import { createSelector } from '@reduxjs/toolkit';
import { collectOrganizedPathKeys, mergeOrganizedPathIndex } from '../utils/organizedPathIndex';

/**
 * FIX CRIT-3: Simplified stable selector that uses shallow equality checking
 * to return the same reference when output is unchanged.
 *
 * The previous implementation used WeakMap which fails for arrays because
 * array references change even when contents are the same. This simpler
 * approach stores the last result and compares with shallow equality.
 *
 * Large arrays use a correctness-first comparison path:
 * - cheap guards (length + boundary identity) for quick mismatch detection
 * - full shallow verification before reusing cached references
 * This avoids stale results from partial checks while still short-circuiting
 * obvious changes quickly.
 */
const LARGE_ARRAY_THRESHOLD = 1000;

import { toCanonicalPath } from '../utils/canonicalPath';

const createStableSelector = (/** @type {any} */ dependencies, /** @type {any} */ combiner) => {
  const baseSelector = createSelector(dependencies, combiner);

  // Store last result for reference stability
  /** @type {any} */
  let lastResult = null;
  /** @type {any} */
  let lastResetCounter = null;

  /**
   * Shallow equality check for arrays and objects
   */
  const shallowEqual = (/** @type {any} */ a, /** @type {any} */ b) => {
    if (a === b) return true;
    if (a == null || b == null) return false;

    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    }

    if (typeof a === 'object' && typeof b === 'object') {
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);
      if (keysA.length !== keysB.length) return false;
      for (const key of keysA) {
        if (a[key] !== b[key]) return false;
      }
      return true;
    }

    return false;
  };

  return (/** @type {any} */ state) => {
    const resetCounter = state?.ui?.resetCounter;
    if (typeof resetCounter === 'number' && resetCounter !== lastResetCounter) {
      lastResetCounter = resetCounter;
      lastResult = null;
    }

    const result = baseSelector(state);

    // Large arrays use a two-phase compare:
    // 1) quick mismatch guards
    // 2) full shallow verification for correctness
    // Never return cached large-array results unless we verify all items match.
    if (Array.isArray(result) && result.length > LARGE_ARRAY_THRESHOLD) {
      if (result === lastResult) {
        return lastResult;
      }

      if (!Array.isArray(lastResult) || result.length !== lastResult.length) {
        lastResult = result;
        return result;
      }

      const lastIndex = result.length - 1;
      if (result[0] !== lastResult[0] || result[lastIndex] !== lastResult[lastIndex]) {
        lastResult = result;
        return result;
      }

      for (let i = 0; i < result.length; i++) {
        if (result[i] !== lastResult[i]) {
          lastResult = result;
          return result;
        }
      }

      return lastResult;
    }

    // Return cached result if shallowly equal
    if (shallowEqual(result, lastResult)) {
      return lastResult;
    }

    // Store and return new result
    lastResult = result;
    return result;
  };
};

// Base selectors
const selectSelectedFiles = (/** @type {any} */ state) => state.files.selectedFiles;
const selectAnalysisResults = (/** @type {any} */ state) => state.analysis.results;
const selectFileStates = (/** @type {any} */ state) => state.files.fileStates;
const selectSmartFolders = (/** @type {any} */ state) => state.files.smartFolders;
const selectOrganizedFiles = (/** @type {any} */ state) => state.files.organizedFiles;
const selectOrganizedPathIndex = (/** @type {any} */ state) => state.files.organizedPathIndex;

/** @type {any[]} */
const EMPTY_FILES = [];

/**
 * FIX: Merged selector that always returns files with their analysis attached.
 * This prevents the disconnection between DiscoverPhase (which stores analysis separately)
 * and OrganizePhase (which expects files to have analysis property).
 *
 * Returns an array of files with:
 * - All properties from selectedFiles
 * - analysis property merged from analysisResults
 * - extension property guaranteed to exist
 * - Already-organized paths excluded (so Dashboard/Organize do not keep showing
 *   moved files as "ready to organize")
 *
 * NOTE: createSelector memoizes based on input reference equality. The output
 * will only be recomputed when selectedFiles, analysisResults, or fileStates
 * change by reference. However, the output array/objects are always new references.
 * For components that need shallow equality of individual items, consider using
 * React.memo with custom comparison or useRef to track previous values.
 */
export const selectFilesWithAnalysis = createSelector(
  [
    selectSelectedFiles,
    selectAnalysisResults,
    selectFileStates,
    selectOrganizedFiles,
    selectOrganizedPathIndex
  ],
  (selectedFiles, analysisResults, fileStates, organizedFiles, organizedPathIndex) => {
    const organizedKeys = new Set(
      mergeOrganizedPathIndex(organizedPathIndex, collectOrganizedPathKeys(organizedFiles))
    );

    // Early return for empty state - stable empty array reference
    const selected = selectedFiles || [];
    if (selected.length === 0) {
      return selected; // Return original reference for empty arrays
    }

    // Drop files that have already been organized. After a move, selectedFiles
    // + analysis results are path-remapped to the destination but remain in the
    // active queue — without this filter the Dashboard keeps them as "ready".
    // Also collapse duplicate paths (remap onto an already-selected destination).
    let needsFilter = organizedKeys.size > 0;
    if (!needsFilter) {
      const seen = new Set();
      for (const file of selected) {
        const key = toCanonicalPath(file?.path);
        if (!key) {
          needsFilter = true;
          break;
        }
        if (seen.has(key)) {
          needsFilter = true;
          break;
        }
        seen.add(key);
      }
    }

    let files = selected;
    if (needsFilter) {
      const seenPaths = new Set();
      files = [];
      for (const file of selected) {
        if (!file?.path) continue;
        const key = toCanonicalPath(file.path);
        if (!key || seenPaths.has(key)) continue;
        if (organizedKeys.size > 0 && organizedKeys.has(key)) continue;
        seenPaths.add(key);
        files.push(file);
      }
    }
    if (files.length === 0) {
      return EMPTY_FILES;
    }

    const safeAnalysisResults = Array.isArray(analysisResults) ? analysisResults : [];
    const safeFileStates =
      fileStates && typeof fileStates === 'object' && !Array.isArray(fileStates) ? fileStates : {};
    const hasAnalysis = safeAnalysisResults.length > 0;
    const hasStates = Object.keys(safeFileStates).length > 0;
    const needsExtensionExtraction = files.some(
      (/** @type {any} */ file) => !file.extension && file.path
    );

    // Early exit only if no data to merge AND all extensions are already set
    if (!hasAnalysis && !hasStates && !needsExtensionExtraction) {
      return files;
    }

    // Create maps for O(1) lookup by CANONICAL path: analysis results and
    // file states may have been recorded with a different casing/separator
    // style than the selected-file entry (drag-drop vs dialog vs watcher),
    // and a raw-string keyed lookup silently drops the merge.
    const analysisMap = new Map();
    safeAnalysisResults.forEach((result) => {
      if (result && result.path) {
        analysisMap.set(toCanonicalPath(result.path), result);
      }
    });
    const fileStateMap = new Map();
    if (hasStates) {
      for (const [statePath, stateInfo] of Object.entries(safeFileStates)) {
        fileStateMap.set(toCanonicalPath(statePath), stateInfo);
      }
    }

    // This reduces object churn when analysis hasn't changed
    let hasChanges = false;
    const mergedFiles = files.map((/** @type {any} */ file) => {
      const canonicalPath = toCanonicalPath(file.path);
      const analysisResult = analysisMap.get(canonicalPath);
      const fileState = fileStateMap.get(canonicalPath);
      const nextStatus = analysisResult?.status || fileState?.state || file.status || 'pending';
      const nextError = analysisResult?.error || file.error || null;
      const nextAnalyzedAt = analysisResult?.analyzedAt || file.analyzedAt || null;

      // Check if this file needs modification
      const needsAnalysis = analysisResult && file.analysis !== analysisResult.analysis;
      const needsExtension = !file.extension && file.path;
      const needsStatus = nextStatus !== file.status;
      const needsError = nextError !== file.error;
      const needsAnalyzedAt = nextAnalyzedAt !== file.analyzedAt;

      // If no changes needed, return original file object
      if (!needsAnalysis && !needsExtension && !needsStatus && !needsError && !needsAnalyzedAt) {
        return file;
      }

      hasChanges = true;

      // Ensure extension is always set
      let { extension } = file;
      if (!extension && file.path) {
        const fileName = file.name || file.path.split(/[\\/]/).pop() || '';
        const dotIdx = fileName.lastIndexOf('.');
        extension = dotIdx > 0 ? fileName.slice(dotIdx).toLowerCase() : '';
      }

      return {
        ...file,
        extension,
        // Merge analysis from results
        analysis: analysisResult?.analysis || file.analysis || null,
        // Keep error info if present
        error: nextError,
        status: nextStatus,
        analyzedAt: nextAnalyzedAt
      };
    });

    // If no files changed, return original array to maintain reference
    return hasChanges ? mergedFiles : files;
  }
);

/**
 * Returns count statistics for file states
 * PERF: Uses stable selector to prevent re-renders when stats are unchanged.
 * PERF: Single-pass counting instead of multiple filter() calls
 */
/**
 * Canonical active-queue counts for Dashboard / Discover / Organize badges.
 * Counts are derived only from selectFilesWithAnalysis (organized paths already
 * excluded). Invariant: ready + failed + pending === total.
 */
export const selectFileStats = createStableSelector(
  [selectFilesWithAnalysis],
  (/** @type {any} */ filesWithAnalysis) => {
    let ready = 0;
    let failed = 0;
    for (const f of filesWithAnalysis) {
      if (f.error) {
        failed++;
      } else if (f.analysis) {
        ready++;
      }
    }
    const total = filesWithAnalysis.length;
    return { total, ready, failed, pending: total - ready - failed };
  }
);

/** Rich organized-history length (session UI). Prefer over ad-hoc .length reads. */
export const selectOrganizedCount = createSelector(
  [selectOrganizedFiles],
  (/** @type {any} */ organizedFiles) => (Array.isArray(organizedFiles) ? organizedFiles.length : 0)
);

/**
 * Get redactPaths setting from system state
 * PERF: Memoized selector to prevent re-renders across 8+ components
 * that were previously using inline useSelector with Boolean coercion
 */
export const selectRedactPaths = createSelector(
  [(state) => state?.system?.redactPaths, (state) => state?.system?.redactPathsLoaded],
  (redactPaths, redactPathsLoaded) => {
    // Stay privacy-safe until the setting is known, but preserve an explicit
    // cached boolean during reload/retry paths.
    if (!redactPathsLoaded) {
      return typeof redactPaths === 'boolean' ? redactPaths : true;
    }
    return Boolean(redactPaths);
  }
);

/**
 * Get default embedding policy from UI settings with safe fallback.
 * Keeps list components subscribed to one field instead of the full settings object.
 */
export const selectDefaultEmbeddingPolicy = createSelector(
  [(state) => state?.ui?.settings?.defaultEmbeddingPolicy],
  (policy) => (policy === 'embed' || policy === 'skip' || policy === 'web_only' ? policy : 'embed')
);

/**
 * Whether a batch analysis is currently in progress.
 * PERF: Memoized to avoid inline Boolean coercion in multiple components.
 */
export const selectIsAnalyzing = createSelector(
  [(state) => state?.analysis?.isAnalyzing],
  (isAnalyzing) => Boolean(isAnalyzing)
);

/**
 * Current analysis progress object (or null).
 * PERF: Reference-stable so consumers using this in useEffect dep arrays
 * don't re-run on every progress tick. analysisSlice.updateProgress creates
 * a new object reference per IPC tick (~80 ms); without stability, every
 * NavigationBar / DiscoverPhase / OrganizeProgress effect re-fires dozens
 * of times per second during analysis. createStableSelector returns the
 * previous reference when {current, total, lastActivity} are unchanged.
 */
export const selectAnalysisProgress = createStableSelector(
  [(/** @type {any} */ state) => state?.analysis?.analysisProgress],
  (/** @type {any} */ progress) => {
    if (!progress || typeof progress !== 'object') return null;
    return {
      current: Number.isFinite(progress.current) ? progress.current : 0,
      total: Number.isFinite(progress.total) ? progress.total : 0,
      lastActivity: progress.lastActivity ?? 0
    };
  }
);

// Re-export base selectors and constants for convenience
export {
  selectSelectedFiles,
  selectAnalysisResults,
  selectFileStates,
  selectSmartFolders,
  selectOrganizedFiles,
  LARGE_ARRAY_THRESHOLD
};
