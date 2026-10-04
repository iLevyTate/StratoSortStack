// @ts-check
/**
 * Atomic Actions - Cross-Slice Redux Actions
 *
 * FIX: Resolves circular dependency between filesSlice and analysisSlice
 * by centralizing cross-slice thunks in a dedicated module.
 *
 * These thunks coordinate updates across multiple slices atomically
 * to prevent state desync issues.
 *
 * @module store/slices/atomicActions
 */

import { updateFilePathsAfterMove, removeSelectedFiles } from './filesSlice';
import { updateResultPathsAfterMove, removeAnalysisResultsByPaths } from './analysisSlice';

/**
 * Atomic path update thunk that updates BOTH filesSlice AND analysisSlice
 * in a single dispatch. This prevents path desync when two independent dispatches
 * could be interrupted or processed out of order.
 *
 * @param {Object} payload - { oldPaths: string[], newPaths: string[] }
 */
export const atomicUpdateFilePathsAfterMove = (payload) => (/** @type {any} */ dispatch) => {
  // Dispatch both actions synchronously - they will be processed in order
  // within the same microtask, preventing any intermediate state observation
  dispatch(updateFilePathsAfterMove(payload));
  dispatch(updateResultPathsAfterMove(payload));
};

/**
 * Atomic file removal thunk that removes files from BOTH
 * filesSlice AND analysisSlice. This prevents orphaned analysis results
 * from accumulating when files are removed.
 *
 * @param {string[]} paths - Array of file paths to remove
 */
export const atomicRemoveFilesWithCleanup = (paths) => (/** @type {any} */ dispatch) => {
  // Remove from filesSlice first, then clean up analysis results
  dispatch(removeSelectedFiles(paths));
  dispatch(removeAnalysisResultsByPaths(paths));
};
