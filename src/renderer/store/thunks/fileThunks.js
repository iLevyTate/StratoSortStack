// @ts-check
/**
 * File-related Redux thunks for atomic operations across multiple slices.
 *
 * These thunks ensure that when files are modified, all related state
 * (filesSlice, analysisSlice, etc.) stays in sync.
 */

import { removeSelectedFile, setFileStates } from '../slices/filesSlice';
import { removeAnalysisResult } from '../slices/analysisSlice';
import { atomicRemoveFilesWithCleanup } from '../slices/atomicActions';
import { updateEmbeddingState } from '../slices/analysisSlice';
import { embeddingsIpc } from '../../services/ipc';
import { logger } from '../../../shared/logger';
import { toCanonicalPath } from '../../utils/canonicalPath';

/**
 * Atomically remove a single file from both filesSlice and analysisSlice.
 * This prevents state desynchronization where analysis results would become
 * orphaned after their corresponding files are removed.
 *
 * @param {string} filePath - The path of the file to remove
 */
export const removeFileWithCleanup = (filePath) => (/** @type {any} */ dispatch) => {
  if (!filePath) return;

  // Remove from filesSlice first (includes fileStates cleanup)
  dispatch(removeSelectedFile(filePath));

  // Also remove any analysis results for this file
  dispatch(removeAnalysisResult(filePath));
};

/**
 * Clear all files and their associated analysis results.
 * Use this when starting fresh or resetting the workflow.
 */
export const clearAllFilesWithCleanup =
  () => (/** @type {any} */ dispatch, /** @type {any} */ getState) => {
    const state = getState();
    const selectedFiles = state.files?.selectedFiles || [];

    if (selectedFiles.length > 0) {
      const filePaths = selectedFiles.map((/** @type {any} */ f) => f.path);
      dispatch(atomicRemoveFilesWithCleanup(filePaths));
    }

    // Clear any orphaned fileStates entries not covered by selectedFiles
    // (e.g., from a previous session where files were individually removed)
    const fileStates = state.files?.fileStates;
    if (fileStates && Object.keys(fileStates).length > 0) {
      dispatch(setFileStates({}));
    }
  };

/**
 * Persist per-file embedding policy and update local Redux state.
 *
 * @param {string} filePath
 * @param {'embed'|'skip'|'web_only'} policy
 */
export const setEmbeddingPolicyForFile =
  (filePath, policy) => async (/** @type {any} */ dispatch, /** @type {any} */ getState) => {
    if (!filePath || !policy) return;
    const api = window.electronAPI?.analysisHistory;
    if (!api?.setEmbeddingPolicy) return;

    try {
      const result = await api.setEmbeddingPolicy(filePath, policy);
      if (result?.success) {
        embeddingsIpc.invalidateStatsCache();
        const state = typeof getState === 'function' ? getState() : null;
        // Canonical compare — analysisSlice itself matches results canonically;
        // a raw miss here would reset a 'done' file's status to 'pending'.
        const canonicalTarget = toCanonicalPath(filePath);
        const existing =
          state?.analysis?.results?.find?.(
            (/** @type {any} */ r) => toCanonicalPath(r?.path) === canonicalTarget
          ) || null;
        const prevStatus = existing?.embeddingStatus || existing?.analysis?.embeddingStatus || null;
        const nextStatus =
          policy === 'embed' ? (prevStatus === 'done' ? 'done' : 'pending') : 'skipped';
        dispatch(
          updateEmbeddingState({
            path: filePath,
            embeddingPolicy: policy,
            embeddingStatus: nextStatus
          })
        );
      }
    } catch (err) {
      logger.error('[fileThunks] Failed to set embedding policy', { error: err?.message });
    }
  };
