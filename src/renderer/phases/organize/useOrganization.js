// @ts-check
/**
 * useOrganization Hook
 *
 * Main organization logic for batch file operations.
 *
 * @module organize/useOrganization
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { IPC_CHANNELS, PHASES } from '../../../shared/constants';
import { createLogger } from '../../../shared/logger';
import { extractExtension } from '../../../shared/namingConventions';
import { createOrganizeBatchAction, previewBatchOrganize } from '../../components/UndoRedoSystem';
import { updateResultPathsAfterMove } from '../../store/slices/analysisSlice';
import { updateFilePathsAfterMove } from '../../store/slices/filesSlice';
import { mapErrorToNotification } from '../../utils/errorMapping';

/**
 * The first failed result's reason, in the words errorMapping uses for its
 * code (a refused destination, a startup folder, an occupied path), or the
 * handler's own message when the code is unknown.
 * @param {any[]} results
 * @returns {string}
 */
function describeFirstFailure(results) {
  const failed = Array.isArray(results)
    ? results.find((r) => r && r.success === false && (r.errorCode || r.error))
    : null;
  if (!failed) return 'Check logs for details.';
  const { message } = mapErrorToNotification({ error: failed.error, errorCode: failed.errorCode });
  return message;
}

/**
 * "1 file", "3 files".
 * @param {number} count
 * @param {string} [noun]
 * @returns {string}
 */
function countOf(count, noun = 'file') {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/**
 * True for a row main reports as done without a move: the destination already
 * held the same content, so the source was removed instead.
 * @param {any} row
 * @returns {boolean}
 */
function isDuplicateSkip(row) {
  return Boolean(row && row.success && row.skipped && row.reason === 'duplicate');
}

/**
 * One sentence on the files that were removed as duplicates instead of
 * moved, or '' when there were none.
 * @param {any[]} duplicateRows
 * @returns {string}
 */
function describeDuplicates(duplicateRows) {
  const count = duplicateRows.length;
  if (count === 0) return '';
  const one = count === 1;
  const where = duplicateRows.every((r) => r.sourceRemoval === 'trashed')
    ? `${one ? 'It is' : 'They are'} in the system Trash.`
    : `${one ? 'It was' : 'They were'} removed.`;
  return `${one ? '1 identical copy was' : `${count} identical copies were`} not moved: the destination already had the same content. ${where}`;
}

/**
 * A run's summary before its finish time is stamped on it.
 * @typedef {Omit<import('../../utils/organizeRunSummary').OrganizeRunSummary, 'finishedAt'>} OrganizeSummary
 */

// Main keeps an interrupted batch's journal open and OrganizeResumeService
// replays it at the next launch.
const INTERRUPTED_REASON =
  'The run was interrupted. The remaining moves resume the next time StratoSort starts.';

/**
 * One sentence on a run main stopped after failures, with the files it never
 * tried. Those files are still at their sources and nothing resumes them.
 * @param {number} failedCount
 * @param {number} notAttemptedCount
 * @returns {string}
 */
function describeStop(failedCount, notAttemptedCount) {
  const after = failedCount > 0 ? ` after ${countOf(failedCount, 'failure')}` : '';
  const untried =
    notAttemptedCount > 0
      ? `; ${countOf(notAttemptedCount)} ${notAttemptedCount === 1 ? 'was' : 'were'} not attempted`
      : '';
  return `The run was stopped${after}${untried}.`;
}

/**
 * The toast and the banner for a run main did not roll back, or null when the
 * run left nothing to report. A row that never started is not a failure: the
 * cancel and pause messages cover the ones the user stopped, an interrupted
 * run is reported as unfinished, and a run main stopped after failures says
 * how many files it did not attempt.
 * @param {object} run
 * @param {any[]} run.rows - the batch's per-op results
 * @param {number} run.movedCount
 * @param {any[]} run.duplicateRows
 * @param {string} [run.batchError] - the error that ended the batch early
 * @param {boolean} [run.interrupted] - stopped by a timeout or shutdown
 * @param {boolean} [run.stoppedOnFailure] - main stopped the run after
 *   failures, before any move of the run was confirmed
 * @returns {{ summary: OrganizeSummary, toast: string, severity: string, duration: number } | null}
 */
function describeFinishedRun({
  rows,
  movedCount,
  duplicateRows,
  batchError,
  interrupted,
  stoppedOnFailure
}) {
  const failedCount = rows.filter(
    (r) => r && !r.success && !r.cancelled && !r.interrupted && !r.notAttempted
  ).length;
  const duplicateNote = describeDuplicates(duplicateRows);
  const tail = duplicateNote ? ` ${duplicateNote}` : '';

  if (failedCount > 0 || batchError || interrupted || stoppedOnFailure) {
    // Nothing failed: the run was only interrupted, and main finishes it at
    // the next launch.
    const resumesAtLaunch = failedCount === 0 && !batchError && !stoppedOnFailure;
    const firstFailure = resumesAtLaunch
      ? INTERRUPTED_REASON
      : describeFirstFailure(batchError ? [...rows, { success: false, error: batchError }] : rows);
    const reason = stoppedOnFailure
      ? `${firstFailure} ${describeStop(failedCount, rows.filter((r) => r && r.notAttempted).length)}`
      : firstFailure;
    if (movedCount === 0) {
      const headline = stoppedOnFailure
        ? 'Organization was stopped; no files were moved'
        : 'No files were organized';
      return {
        summary: {
          outcome: 'none',
          count: 0,
          headline,
          detail: `${reason}${tail}`,
          resumesAtLaunch
        },
        toast: `${headline}. ${reason}${tail}`,
        severity: 'error',
        duration: 9000
      };
    }
    const shortfall =
      failedCount > 0 ? `${failedCount} could not be moved` : 'the run did not finish';
    return {
      summary: {
        outcome: 'partial',
        count: movedCount,
        headline: `Moved ${countOf(movedCount)}; ${shortfall}`,
        detail: `${reason}${tail} Files that were not moved are still listed.`,
        resumesAtLaunch
      },
      toast:
        failedCount > 0
          ? `Organized ${countOf(movedCount)} with ${countOf(failedCount, 'failure')}. ${reason}${tail}`
          : `Organized ${countOf(movedCount)}, but the run did not finish. ${reason}${tail}`,
      severity: 'warning',
      duration: 8000
    };
  }

  if (movedCount > 0) {
    return {
      summary: {
        outcome: 'moved',
        count: movedCount,
        headline: `Moved ${countOf(movedCount)} to ${movedCount === 1 ? 'its destination' : 'their destinations'}`,
        detail: duplicateNote
      },
      toast: `Organized ${countOf(movedCount)}${duplicateNote ? `.${tail}` : ''}`,
      severity: 'success',
      duration: duplicateNote ? 10000 : 7000
    };
  }
  if (duplicateRows.length > 0) {
    return {
      summary: {
        outcome: 'moved',
        count: 0,
        headline: 'No files needed moving',
        detail: duplicateNote
      },
      toast: `No files needed moving. ${duplicateNote}`,
      severity: 'info',
      duration: 10000
    };
  }
  return null;
}

const ROLLBACK_NAMES_SHOWN = 3;
const ROLLED_BACK_HEADLINE = 'Organization was rolled back';

/**
 * What a batch the main process rolled back after a critical error left
 * behind, to follow ROLLED_BACK_HEADLINE. Restored rows come back
 * `success: false, rolledBack: true`; a row whose restore failed keeps
 * `success: true, rollbackFailed: true` because that file is still at its
 * destination, and those files are named so the user can find them. Main
 * deletes the recovery manifest when every restore worked, so its path is
 * only shown when something was left behind.
 * @param {any} result - the batch handler's rollback outcome
 * @param {any[]} rows - its per-op results
 * @returns {string}
 */
function describeRolledBackBatch(result, rows) {
  const list = Array.isArray(rows) ? rows : [];
  // The op that triggered the rollback carries the real error; restored rows
  // only repeat the rollback reason.
  const reason = describeFirstFailure(list.filter((r) => r && !r.rolledBack));
  const leftBehind = list.filter((r) => r && r.rollbackFailed === true);
  const leftBehindCount = Math.max(
    leftBehind.length,
    Number.isInteger(result?.rollbackFailCount) ? result.rollbackFailCount : 0
  );
  // Files the run had not reached when it stopped; they never left their
  // sources, so the rollback had nothing to return for them.
  const notAttemptedCount = list.filter((r) => r && r.notAttempted).length;
  const untried =
    notAttemptedCount > 0
      ? ` ${countOf(notAttemptedCount)} ${notAttemptedCount === 1 ? 'was' : 'were'} not attempted.`
      : '';
  if (leftBehindCount === 0) {
    return `${reason} Files already moved were returned to their original locations.${untried}`;
  }
  const names = leftBehind
    .map((r) =>
      String(r.destination || r.source || '')
        .split(/[\\/]/)
        .pop()
    )
    .filter(Boolean);
  const shown = names.slice(0, ROLLBACK_NAMES_SHOWN).join(', ');
  const more = leftBehindCount - Math.min(names.length, ROLLBACK_NAMES_SHOWN);
  const fileWord = leftBehindCount === 1 ? 'file' : 'files';
  const named = shown ? `: ${shown}${more > 0 ? ` and ${more} more` : ''}` : '';
  const recovery =
    typeof result?.recoveryPath === 'string' && result.recoveryPath
      ? ` Recovery details: ${result.recoveryPath}`
      : '';
  return `${reason} ${leftBehindCount} ${fileWord} could not be returned and remain in the destination folder${named}.${untried}${recovery}`;
}

import { toCanonicalPath, toFolderKey, toParentFolderKey } from '../../utils/canonicalPath';
import { resolveOrganizeDestination, suggestionForOperation } from './organizeDestination';

const logger = createLogger('OrganizePhase-Organization');
const MAX_CHUNKED_RESULTS = 10000;

/** Mark both pre- and post-move paths so Organize/Discover filters stay in sync with Redux path updates. */
function collectPathsForProcessedTracking(/** @type {any} */ records) {
  /** @type {any[]} */
  const out = [];
  if (!Array.isArray(records)) return out;
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    for (const p of [r.originalPath, r.path, r.currentPath]) {
      if (p) out.push(p);
    }
  }
  return Array.from(new Set(out));
}

function collectPathsToUnmarkAfterUndo(
  /** @type {any} */ successfulUndos,
  /** @type {any} */ results
) {
  const paths = new Set(Array.isArray(successfulUndos) ? successfulUndos.filter(Boolean) : []);
  if (Array.isArray(results)) {
    for (const r of results) {
      if (!r?.success) continue;
      for (const p of [r.source, r.destination, r.originalPath, r.newPath]) {
        if (p) paths.add(p);
      }
    }
  }
  return Array.from(paths);
}
/**
 * Hook for progress tracking
 * @returns {Record<string, any>} Progress state and setter
 */
export function useProgressTracking() {
  const [batchProgress, setBatchProgress] = useState({
    current: 0,
    total: 0,
    currentFile: ''
  });
  const [organizePreview, setOrganizePreview] = useState([]);
  const [isOrganizing, setIsOrganizing] = useState(false);
  const [organizeConflicts, setOrganizeConflicts] = useState([]);

  const [chunkedResults, setChunkedResults] = useState([]);
  const chunkedResultsRef = useRef([]);

  // Ref for cleanup
  const progressUnsubscribeRef = useRef(null);
  const chunkEventCleanupRef = useRef(null);

  // Progress listener setup
  useEffect(() => {
    const abortController = new AbortController();

    const setupProgressListener = () => {
      if (abortController.signal.aborted) return;

      if (!window.electronAPI?.events?.onOperationProgress) {
        logger.warn('Progress event system not available - progress updates will not be shown');
        return;
      }

      try {
        progressUnsubscribeRef.current = window.electronAPI.events.onOperationProgress(
          (/** @type {any} */ payload) => {
            if (abortController.signal.aborted) return;

            try {
              if (!payload || payload.type !== 'batch_organize') return;

              const current = Number(payload.current);
              const total = Number(payload.total);

              if (!Number.isFinite(current) || !Number.isFinite(total)) {
                logger.error('Invalid progress data', {
                  current: payload.current,
                  total: payload.total
                });
                return;
              }

              // Reasonable bounds: current >= 0, total >= 0, current <= total, total < 100000
              const MAX_REASONABLE_TOTAL = 100000;
              if (current < 0 || total < 0 || current > total || total > MAX_REASONABLE_TOTAL) {
                logger.warn('Progress data out of bounds, clamping values', {
                  original: { current, total },
                  maxReasonable: MAX_REASONABLE_TOTAL
                });
              }

              // Clamp values to reasonable bounds
              const safeCurrent = Math.max(0, Math.min(current, total, MAX_REASONABLE_TOTAL));
              const safeTotal = Math.max(0, Math.min(total, MAX_REASONABLE_TOTAL));

              setBatchProgress({
                current: safeCurrent,
                total: safeTotal,
                currentFile: payload.currentFile || ''
              });
            } catch (error) {
              logger.error('Error processing progress update', {
                error: error.message,
                stack: error.stack
              });
            }
          }
        );

        if (typeof progressUnsubscribeRef.current !== 'function') {
          logger.error('Progress subscription failed - unsubscribe is not a function');
          progressUnsubscribeRef.current = null;
        }
      } catch (error) {
        logger.error('Failed to subscribe to progress events', {
          error: error.message,
          stack: error.stack
        });
      }
    };

    setupProgressListener();

    const setupChunkListener = () => {
      if (abortController.signal.aborted) return;

      try {
        const onBatchChunk = (/** @type {any} */ event) => {
          const payload = event?.detail;
          if (abortController.signal.aborted) return;

          try {
            if (!payload || !payload.chunk) return;

            logger.debug('[ORGANIZE] Received batch results chunk', {
              batchId: payload.batchId,
              chunkIndex: payload.chunkIndex,
              totalChunks: payload.totalChunks,
              chunkSize: payload.chunk?.length
            });

            // Accumulate chunks (capped to prevent unbounded memory growth)
            if (chunkedResultsRef.current.length < MAX_CHUNKED_RESULTS) {
              const remaining = MAX_CHUNKED_RESULTS - chunkedResultsRef.current.length;
              const chunk = payload.chunk.slice(0, remaining);
              chunkedResultsRef.current = [...chunkedResultsRef.current, ...chunk];
              if (remaining < payload.chunk.length) {
                logger.warn('[ORGANIZE] Chunked results cap reached, dropping excess items', {
                  cap: MAX_CHUNKED_RESULTS,
                  dropped: payload.chunk.length - remaining
                });
              }
            }
            setChunkedResults([...chunkedResultsRef.current]);

            // Update progress based on chunks received
            if (payload.totalChunks > 0) {
              const progress = Math.round(((payload.chunkIndex + 1) / payload.totalChunks) * 100);
              logger.debug('[ORGANIZE] Chunk progress', {
                progress,
                chunkIndex: payload.chunkIndex
              });
            }
          } catch (error) {
            logger.error('Error processing batch results chunk', {
              error: error.message
            });
          }
        };
        window.addEventListener('batch-results-chunk', onBatchChunk);
        chunkEventCleanupRef.current = () => {
          window.removeEventListener('batch-results-chunk', onBatchChunk);
        };
      } catch (error) {
        logger.error('Failed to subscribe to batch-results-chunk events', {
          error: error.message
        });
      }
    };

    setupChunkListener();

    return () => {
      abortController.abort();

      if (typeof progressUnsubscribeRef.current === 'function') {
        try {
          progressUnsubscribeRef.current();
          progressUnsubscribeRef.current = null;
        } catch (error) {
          logger.error('Error unsubscribing from progress events', {
            error: error.message,
            stack: error.stack
          });
        }
      }

      if (typeof chunkEventCleanupRef.current === 'function') {
        try {
          chunkEventCleanupRef.current();
          chunkEventCleanupRef.current = null;
        } catch (error) {
          logger.error('Error unsubscribing from chunk events', {
            error: error.message
          });
        }
      }
    };
  }, []);

  const resetChunkedResults = useCallback(() => {
    chunkedResultsRef.current = [];
    setChunkedResults([]);
  }, []);

  return {
    batchProgress,
    setBatchProgress,
    organizePreview,
    setOrganizePreview,
    isOrganizing,
    setIsOrganizing,
    organizeConflicts,
    setOrganizeConflicts,
    chunkedResults,
    chunkedResultsRef,
    resetChunkedResults
  };
}

/**
 * Process a single file for organization.
 * Shared logic for both operations and preview building.
 *
 * @typedef {{ file: any, editingFiles: Record<string, any>, getFileWithEdits: Function, findSmartFolderForCategory: (label: any) => any, findSmartFolderForFile: ((file: any) => any)|null, defaultLocation: string, smartFolders?: any[], suggestionsByPath?: Map<string, any>|null }} ProcessParams
 */
// Helper to normalize paths for comparison (handles mixed / and \)
const isWindowsPath = (/** @type {any} */ p) => p && (p.includes('\\') || /^[A-Za-z]:/.test(p));
const normalizeForComparison = (/** @type {any} */ path) => {
  if (!path) return '';
  const normalized = path.replace(/[\\/]+/g, '/');
  // Only lowercase on Windows paths (contains backslash or drive letter)
  return isWindowsPath(path) ? normalized.toLowerCase() : normalized;
};

const hasFileExtension = (/** @type {any} */ fileName) => !!extractExtension(fileName);

/**
 * Helper to join paths using the correct separator based on the root
 */
/**
 * @param {string} root
 * @param {...string} parts
 */
const joinPath = (root, ...parts) => {
  const isWindows = root.includes('\\');
  const separator = isWindows ? '\\' : '/';
  const cleanRoot = root.endsWith(separator) ? root.slice(0, -1) : root;
  const cleanParts = parts.map((/** @type {string} */ p) =>
    p.startsWith(separator) ? p.slice(1) : p
  );
  return [cleanRoot, ...cleanParts].join(separator);
};

const UNCATEGORIZED = 'Uncategorized';

/**
 * Where a smart folder's files go: its own path, or a folder of its name
 * under the default location when it has none.
 * @param {any} folder
 * @param {string} defaultLocation
 */
const folderDestinationDir = (folder, defaultLocation) =>
  folder?.path || joinPath(defaultLocation, folder?.name || UNCATEGORIZED);

const sanitizeDestinationFileName = (/** @type {any} */ value, fallback = 'untitled') => {
  const toSafeBaseName = (/** @type {any} */ input) => {
    if (typeof input !== 'string') return '';
    const trimmed = input.trim();
    if (!trimmed) return '';
    const baseName = trimmed.split(/[\\/]/).pop() || '';
    const cleaned = baseName
      // eslint-disable-next-line no-control-regex -- intentionally match Windows-invalid control chars
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/[. ]+$/g, '')
      .trim();
    if (!cleaned || cleaned === '.' || cleaned === '..') return '';
    return cleaned;
  };

  const safe = toSafeBaseName(value);
  if (safe) return safe;
  return toSafeBaseName(fallback) || 'untitled';
};

/** @param {ProcessParams} params */
function processFileForOrganization({
  file,
  editingFiles,
  getFileWithEdits,
  findSmartFolderForCategory,
  findSmartFolderForFile,
  defaultLocation,
  smartFolders = [],
  suggestionsByPath = null
}) {
  const key = toCanonicalPath(file.path);
  const edits = (key && editingFiles[key]) || {};
  const fileWithEdits = getFileWithEdits(file) || file;
  const originalCategory = edits.category || fileWithEdits.analysis?.category;

  // Same resolution the grid card shows: the user's choice, then the
  // engine's ranked primary, then name matching (see organizeDestination.js).
  const destination = resolveOrganizeDestination({
    fileWithEdits,
    edits,
    engineSuggestion: key && suggestionsByPath ? suggestionsByPath.get(key) : null,
    smartFolders,
    findSmartFolderForCategory,
    findSmartFolderForFile
  });
  const smartFolder = destination.folder;
  // Only a fall-through to Uncategorized is a "category changed" notice: a
  // folder the engine or name matching picked is already shown on the card.
  const categoryChanged = !smartFolder && Boolean(originalCategory);
  const currentCategory = smartFolder ? smartFolder.name : UNCATEGORIZED;

  // Always use a validated smart folder path; never build a path from a raw category.
  const resolvedFolder = smartFolder || findSmartFolderForCategory(UNCATEGORIZED);
  const destinationDir = folderDestinationDir(resolvedFolder, defaultLocation);

  const suggestedName = edits.suggestedName || fileWithEdits.analysis?.suggestedName || file.name;
  const safeSuggestedName = sanitizeDestinationFileName(suggestedName, file.name);

  // Preserve compound extensions like .tar.gz when suggested name omits extension
  const originalExt = extractExtension(file.name);
  const hasExtension = hasFileExtension(safeSuggestedName);
  const newName =
    hasExtension || !originalExt ? safeSuggestedName : `${safeSuggestedName}${originalExt}`;

  const dest = joinPath(destinationDir, newName);
  const normalized = window.electronAPI?.files?.normalizePath?.(dest) || dest;

  return {
    newName,
    normalized,
    destinationDir,
    categoryChanged,
    originalCategory,
    finalCategory: currentCategory,
    suggestion: suggestionForOperation(destination, smartFolders)
  };
}

/**
 * A file the plan leaves in the folder it is already in, because that folder
 * is also the smart folder chosen for it. The run renames it there, or leaves
 * it as it is when its name does not change either, and reports it as moved.
 * @typedef {object} InPlaceMove
 * @property {string} sourcePath
 * @property {string} fileName
 * @property {string} folderName - the smart folder it stays in
 * @property {boolean} renamed - whether the run gives it a new name
 */

/**
 * The files whose destination folder is the folder that holds them now.
 * @param {Omit<ProcessParams, 'file'> & { files: any[] }} params
 * @returns {InPlaceMove[]}
 */
export function findInPlaceMoves({ files, smartFolders = [], defaultLocation, ...planParams }) {
  // This runs while the screen renders; without a default location there is
  // no plan to describe yet.
  if (typeof defaultLocation !== 'string' || !defaultLocation) return [];
  // Only a file that sits directly in a folder the plan can send files to can
  // stay where it is. In most queues that is none of them, so the per-file
  // destination is only worked out for those.
  const targetKeys = new Set(
    [
      ...smartFolders.map((folder) => folderDestinationDir(folder, defaultLocation)),
      joinPath(defaultLocation, UNCATEGORIZED)
    ].map(toFolderKey)
  );
  /** @type {InPlaceMove[]} */
  const inPlace = [];
  for (const file of Array.isArray(files) ? files : []) {
    const parentKey = toParentFolderKey(file?.path);
    if (parentKey === null || !targetKeys.has(parentKey)) continue;
    const { newName, destinationDir, finalCategory } = processFileForOrganization({
      ...planParams,
      file,
      smartFolders,
      defaultLocation
    });
    if (toFolderKey(destinationDir) !== parentKey) continue;
    inPlace.push({
      sourcePath: file.path,
      fileName: file.name,
      folderName: finalCategory,
      renamed: newName !== file.name
    });
  }
  return inPlace;
}

/**
 * Build file operations for organization
 * @param {Object} params - Parameters
 * @returns {Object} Object with operations array and categoryChanges array
 */
/** @param {any} params */
function buildOperations({
  filesToProcess,
  unprocessedFiles: _unprocessedFiles,
  editingFiles,
  getFileWithEdits,
  findSmartFolderForCategory,
  findSmartFolderForFile,
  defaultLocation,
  smartFolders = [],
  suggestionsByPath = null
}) {
  /** @type {any[]} */
  const categoryChanges = [];
  const operations = filesToProcess.map((/** @type {any} */ file) => {
    const { normalized, categoryChanged, originalCategory, finalCategory, suggestion } =
      processFileForOrganization({
        file,
        editingFiles,
        getFileWithEdits,
        findSmartFolderForCategory,
        findSmartFolderForFile,
        defaultLocation,
        smartFolders,
        suggestionsByPath
      });

    if (categoryChanged) {
      categoryChanges.push({
        fileName: file.name,
        originalCategory,
        finalCategory
      });
    }

    return {
      type: 'move',
      source: file.path,
      destination: normalized,
      ...(suggestion ? { suggestion } : {})
    };
  });

  return { operations, categoryChanges };
}

/**
 * Build preview list for progress UI
 * @param {any} params
 * @returns {Record<string, any>} Object with preview array and conflicts array
 */
function buildPreview({
  filesToProcess,
  unprocessedFiles: _unprocessedFiles,
  editingFiles,
  getFileWithEdits,
  findSmartFolderForCategory,
  findSmartFolderForFile,
  defaultLocation,
  smartFolders = [],
  suggestionsByPath = null
}) {
  const preview = filesToProcess.map((/** @type {any} */ file) => {
    const { newName, normalized } = processFileForOrganization({
      file,
      editingFiles,
      getFileWithEdits,
      findSmartFolderForCategory,
      findSmartFolderForFile,
      defaultLocation,
      smartFolders,
      suggestionsByPath
    });
    return { fileName: newName, destination: normalized, sourcePath: file.path };
  });

  const destinationMap = new Map();
  preview.forEach((/** @type {any} */ item) => {
    const normalizedDest = normalizeForComparison(item.destination);
    if (!destinationMap.has(normalizedDest)) {
      destinationMap.set(normalizedDest, []);
    }
    destinationMap.get(normalizedDest).push(item);
  });

  const conflicts = [];
  for (const items of destinationMap.values()) {
    if (items.length > 1) {
      conflicts.push({
        destination: items[0].destination, // Use original casing
        files: items.map((/** @type {any} */ i) => ({
          fileName: i.fileName,
          sourcePath: i.sourcePath
        }))
      });
    }
  }

  // NOTE: External file collision checking requires an async check (e.g. IPC to main process)
  // which is generally handled during the actual batch processor execution (makeUniqueFileName).
  // This sync function only detects *internal* batch conflicts where two files want the *same* new name.

  return { preview, conflicts };
}

/**
 * Hook for main organization logic
 * @param {any} params
 * @returns {Record<string, any>} Organization handlers
 */
export function useOrganization({
  unprocessedFiles = [],
  editingFiles = {},
  getFileWithEdits = () => {},
  findSmartFolderForCategory = () => {},
  findSmartFolderForFile = null,
  defaultLocation = '',
  smartFolders = [],
  suggestionsByPath = null,
  analysisResults = [],
  markFilesAsProcessed = () => {},
  unmarkFilesAsProcessed = () => {},
  actions = { setPhaseData: () => {}, advancePhase: () => {} },
  phaseData = {},
  currentPhase = PHASES?.ORGANIZE ?? 'organize',
  addNotification = () => {},
  executeAction = () => {},
  dispatch = null,
  addOrganizedFiles = () => {},
  removeOrganizedFiles = () => {},
  setOrganizingState = () => {},
  setLastOrganizeRun = () => {}
} = {}) {
  const {
    batchProgress,
    setBatchProgress,
    organizePreview,
    setOrganizePreview,
    isOrganizing,
    setIsOrganizing,
    organizeConflicts,
    setOrganizeConflicts,
    chunkedResultsRef,
    resetChunkedResults
  } = useProgressTracking();
  const currentPhaseRef = useRef(currentPhase);
  useEffect(() => {
    currentPhaseRef.current = currentPhase;
  }, [currentPhase]);

  // Cancellation tracking for in-flight organize batches. Previously the user
  // had no way to back out of a long batch — they could only wait for it to
  // finish (and then potentially undo). The cancel flag is checked after the
  // batch returns: if set, we suppress the auto-advance to Complete and emit
  // an explicit "cancelled" notification so completed-before-cancel files are
  // still tracked but the workflow doesn't surprise-navigate.
  const cancelledRef = useRef(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const cancelOrganize = useCallback(() => {
    if (!cancelledRef.current) {
      cancelledRef.current = true;
      setIsCancelling(true);
      // Cooperative soft-stop: signal the in-flight batch-organize invoke so
      // the main handler's abortSignal fires and the batch loop stops moving
      // files. Completed-before-cancel files are still tracked; we also
      // suppress phase advance after the batch returns.
      try {
        window?.electronAPI?.system?.abortInvoke?.({
          channel: IPC_CHANNELS.FILES.PERFORM_OPERATION,
          reason: 'user-cancel-organize'
        });
      } catch {
        /* non-fatal */
      }
    }
  }, []);

  // Pause/resume (UX-4): pause is a distinct abort reason the main handler
  // recognizes — it finalizes completed moves (undo included) and returns
  // {paused:true, batchId}. We park that batch here so resumeOrganize can
  // re-invoke with resumeBatchId; the journal's done-op statuses make the
  // main side skip already-moved files.
  const pausedBatchRef = useRef(null);
  const [isPausing, setIsPausing] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [pausedSummary, setPausedSummary] = useState(null);
  const pauseOrganize = useCallback(() => {
    if (!isPausing && !cancelledRef.current) {
      setIsPausing(true);
      try {
        window?.electronAPI?.system?.abortInvoke?.({
          channel: IPC_CHANNELS.FILES.PERFORM_OPERATION,
          reason: 'user-pause-organize'
        });
      } catch {
        /* non-fatal */
      }
    }
  }, [isPausing]);
  const dismissPausedBatch = useCallback(() => {
    // Local dismiss only: the journal batch stays pausedAt on disk and is
    // finalized (not replayed) by OrganizeResumeService on next launch.
    pausedBatchRef.current = null;
    setIsPaused(false);
    setPausedSummary(null);
  }, []);

  // Sync ref in useEffect instead of during render to prevent race conditions
  const organizedFilesRef = useRef(phaseData?.organizedFiles || []);
  const isMountedRef = useRef(true);
  useEffect(() => {
    organizedFilesRef.current = phaseData?.organizedFiles || [];
  }, [phaseData?.organizedFiles]);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleOrganizeFiles = useCallback(
    async (/** @type {any} */ filesToOrganize = null, /** @type {any} */ organizeOptions = {}) => {
      const actualFilesToOrganize = Array.isArray(filesToOrganize) ? filesToOrganize : null;
      const resumeInfo = organizeOptions.resume ? pausedBatchRef.current : null;
      if (organizeOptions.resume && !resumeInfo) {
        addNotification('No paused batch to resume.', 'warning');
        return;
      }

      logger.info('[ORGANIZE] handleOrganizeFiles called', {
        providedFiles: actualFilesToOrganize?.length ?? 'null',
        unprocessedFilesCount: unprocessedFiles?.length ?? 0,
        resumeBatchId: resumeInfo?.batchId
      });

      // O-3: group every invoke this batch triggers (perform-operation,
      // progress polls, path updates) under a single main-process
      // correlation id. Opened only once we know real work will happen.
      let traceSession = null;

      try {
        setIsOrganizing(true);
        setOrganizingState(true);
        setOrganizeConflicts([]);
        setLastOrganizeRun(null);
        resetChunkedResults();

        const filesToProcess = resumeInfo
          ? []
          : actualFilesToOrganize || unprocessedFiles.filter((/** @type {any} */ f) => f.analysis);

        logger.info('[ORGANIZE] Files to process', {
          count: filesToProcess.length
        });

        if (!resumeInfo && filesToProcess.length === 0) {
          addNotification(
            'No files ready to organize. Please ensure files have been analyzed.',
            'warning'
          );
          logger.warn('[ORGANIZE] No files to process - returning early');
          setIsOrganizing(false);
          setOrganizingState(false);
          return;
        }

        // A new (or resumed) run supersedes any parked paused state.
        setIsPaused(false);
        setPausedSummary(null);
        if (!resumeInfo) {
          pausedBatchRef.current = null;
        }

        traceSession = window.electronAPI?.trace?.beginSession?.() || null;

        setBatchProgress({
          current: 0,
          total: filesToProcess.length,
          currentFile: ''
        });

        // Check if auto-organize with suggestions is available
        const autoOrganizeAvailable = !!window.electronAPI?.organize?.auto;
        logger.info('[ORGANIZE] Auto-organize API available:', autoOrganizeAvailable);

        // IMPORTANT: For the Organize phase, the user has already reviewed/edited
        // the category + name in the UI. Calling auto-organize here can re-run a
        // separate suggestion pipeline and produce a *different* folder than what
        // the UI displays (e.g., UI shows "How To" but auto-organize moves to "3D Print").
        // To prevent that "disconnect", we always build operations locally from:
        // - file.analysis.category/suggestedName
        // - any user edits in editingFiles
        const { operations, categoryChanges } = resumeInfo
          ? { operations: resumeInfo.operations, categoryChanges: [] }
          : buildOperations({
              filesToProcess,
              unprocessedFiles,
              editingFiles,
              getFileWithEdits,
              findSmartFolderForCategory,
              findSmartFolderForFile,
              defaultLocation,
              smartFolders,
              suggestionsByPath
            });

        const invalidOperations = operations.filter(
          (/** @type {any} */ op) => !op?.source || !op?.destination
        );
        if (invalidOperations.length > 0) {
          addNotification(
            `Cannot organize: ${invalidOperations.length} file${invalidOperations.length > 1 ? 's' : ''} had invalid paths.`,
            'error',
            5000,
            'organize-invalid-operations'
          );
          logger.warn('[ORGANIZE] Invalid operations detected', {
            invalidCount: invalidOperations.length,
            sample: invalidOperations.slice(0, 3)
          });
          setIsOrganizing(false);
          setOrganizingState(false);
          setBatchProgress({ current: 0, total: 0, currentFile: '' });
          return;
        }

        if (categoryChanges && categoryChanges.length > 0) {
          const changedCount = categoryChanges.length;
          if (changedCount === 1) {
            addNotification(
              `"${categoryChanges[0].fileName}" category changed from "${categoryChanges[0].originalCategory}" to "${categoryChanges[0].finalCategory}" (no matching smart folder)`,
              'warning',
              5000,
              'category-changed'
            );
          } else {
            addNotification(
              `${changedCount} files had categories changed to "Uncategorized" (no matching smart folders)`,
              'warning',
              5000,
              'category-changed'
            );
          }
          logger.info('[ORGANIZE] Category changes applied:', categoryChanges);
        }

        if (!operations || operations.length === 0) {
          addNotification(
            'No confident file moves were generated. Review files manually before organizing.',
            'info',
            4000,
            'organize-no-operations'
          );
          setIsOrganizing(false);
          setOrganizingState(false);
          setBatchProgress({ current: 0, total: 0, currentFile: '' });
          return;
        }

        // Build preview and detect conflicts
        try {
          const { preview, conflicts } = buildPreview({
            filesToProcess,
            unprocessedFiles,
            editingFiles,
            getFileWithEdits,
            findSmartFolderForCategory,
            findSmartFolderForFile,
            defaultLocation,
            smartFolders,
            suggestionsByPath
          });
          setOrganizePreview(preview);
          setOrganizeConflicts(conflicts);

          if (conflicts.length > 0) {
            const conflictCount = conflicts.reduce(
              (/** @type {any} */ sum, /** @type {any} */ c) => sum + c.files.length,
              0
            );
            addNotification(
              `Cannot organize: ${conflictCount} files have destination conflicts. Rename files to resolve.`,
              'error',
              6000,
              'organize-conflicts'
            );
            logger.warn('[ORGANIZE] Destination conflicts detected:', conflicts);
            setIsOrganizing(false);
            setOrganizingState(false);
            setBatchProgress({ current: 0, total: 0, currentFile: '' });
            return;
          }
        } catch (previewError) {
          logger.warn('[ORGANIZE] Preview generation failed (non-fatal):', previewError.message);
        }

        // How onExecute reported this run, once it has.
        const reported = { outcome: /** @type {OrganizeSummary['outcome'] | null} */ (null) };
        const stateCallbacks = {
          onExecute: (/** @type {any} */ result) => {
            try {
              // When chunkedResults is true, results usually arrive via IPC chunks into chunkedResultsRef.
              // If the ref is empty (ordering edge case), fall back to result.results.
              let resArray;
              if (result?.chunkedResults) {
                if (chunkedResultsRef.current.length > 0) {
                  logger.info('[ORGANIZE] Using chunked results', {
                    chunkedCount: chunkedResultsRef.current.length,
                    totalChunks: result.totalChunks
                  });
                  resArray = chunkedResultsRef.current;
                } else if (Array.isArray(result?.results) && result.results.length > 0) {
                  logger.warn('[ORGANIZE] Chunked batch: ref empty, using result.results fallback');
                  resArray = result.results;
                } else {
                  logger.warn(
                    '[ORGANIZE] Chunked batch completed but no results in ref or result.results'
                  );
                  resArray = [];
                }
              } else {
                resArray = Array.isArray(result?.results) ? result.results : [];
              }

              // A batch main rolled back after a critical error: restored rows
              // (rolledBack) never count as moved; rows whose restore failed
              // keep success:true because those files are at their
              // destination. One error toast below replaces the
              // success/partial/nothing-organized toasts.
              const rolledBackBatch = result?.rolledBack === true;
              const operationMap = new Map(
                operations.map((/** @type {any} */ op) => [op.source, op.destination])
              );
              const uiResults = resArray
                .filter((/** @type {any} */ r) => r.success && !r.rolledBack)
                .map((/** @type {any} */ r) => {
                  const original =
                    analysisResults.find((/** @type {any} */ a) => a.path === r.source) || {};
                  // This ensures notifications show the correct folder (e.g., "Uncategorized" not "3D Print")
                  let actualSmartFolder = 'Organized'; // fallback
                  if (r.destination) {
                    // Get the parent directory name from the destination path
                    const pathParts = r.destination.split(/[\\/]/);
                    // Get the folder name (second-to-last part before filename)
                    if (pathParts.length >= 2) {
                      actualSmartFolder = pathParts[pathParts.length - 2];
                    }
                  }
                  return {
                    originalPath: r.source,
                    path: r.destination || operationMap.get(r.source),
                    originalName:
                      original.name || (original.path ? original.path.split(/[\\/]/).pop() : ''),
                    newName:
                      (r.destination || operationMap.get(r.source) || '').split(/[\\/]/).pop() ||
                      '',
                    smartFolder: actualSmartFolder,
                    organizedAt: new Date().toISOString(),
                    // Not moved: `path` is the identical copy that was kept.
                    ...(isDuplicateSkip(r)
                      ? { duplicateRemoval: r.sourceRemoval === 'trashed' ? 'trashed' : 'deleted' }
                      : {})
                  };
                });
              const duplicateRows = resArray.filter(
                (/** @type {any} */ r) => !r.rolledBack && isDuplicateSkip(r)
              );
              const report = rolledBackBatch
                ? null
                : describeFinishedRun({
                    rows: resArray,
                    movedCount: uiResults.length - duplicateRows.length,
                    duplicateRows,
                    batchError: result?.partialFailure
                      ? String(result.error || 'The batch stopped early')
                      : undefined,
                    interrupted: result?.interrupted === true,
                    stoppedOnFailure: result?.stoppedOnFailure === true
                  });
              const successfulMoves = resArray
                .filter((/** @type {any} */ r) => r.success && !r.rolledBack && r.source)
                .map((/** @type {any} */ r) => ({
                  source: r.source,
                  destination: r.destination || operationMap.get(r.source)
                }))
                .filter((/** @type {any} */ r) => r.destination);
              if (dispatch && successfulMoves.length > 0) {
                const oldPaths = successfulMoves.map((/** @type {any} */ r) => r.source);
                const newPaths = successfulMoves.map((/** @type {any} */ r) => r.destination);
                dispatch(updateResultPathsAfterMove({ oldPaths, newPaths }));
                dispatch(updateFilePathsAfterMove({ oldPaths, newPaths }));
              }

              // One toast and one banner per run. The reason a file was
              // refused is logged in main and shown nowhere else.
              if (rolledBackBatch) {
                logger.warn('[ORGANIZE] Batch rolled back by main', {
                  batchId: result?.batchId,
                  rollbackFailCount: result?.rollbackFailCount
                });
                const detail = describeRolledBackBatch(result, resArray);
                addNotification(`${ROLLED_BACK_HEADLINE}. ${detail}`, 'error', 12000);
                setLastOrganizeRun({
                  outcome: 'rolledBack',
                  count: uiResults.length,
                  headline: ROLLED_BACK_HEADLINE,
                  detail,
                  finishedAt: Date.now()
                });
                reported.outcome = 'rolledBack';
              } else if (report) {
                if (report.summary.outcome !== 'moved') {
                  logger.warn('[ORGANIZE] Batch left files unmoved', {
                    outcome: report.summary.outcome,
                    movedCount: report.summary.count,
                    duplicateCount: duplicateRows.length,
                    error: result?.error
                  });
                }
                // A run the user stopped gets its count from the cancel or
                // pause message; a second toast would only repeat it.
                const stoppedByUser =
                  cancelledRef.current || Boolean(result?.cancelled || result?.paused);
                if (report.summary.outcome !== 'moved' || !stoppedByUser) {
                  addNotification(report.toast, report.severity, report.duration);
                }
                setLastOrganizeRun({ ...report.summary, finishedAt: Date.now() });
                reported.outcome = report.summary.outcome;
              }

              if (uiResults.length > 0) {
                addOrganizedFiles(uiResults);

                // Keep ref in sync for other local logic if needed (though Redux is source of truth)
                organizedFilesRef.current = [...organizedFilesRef.current, ...uiResults];

                markFilesAsProcessed(collectPathsForProcessedTracking(uiResults));

                // Files moved on disk but the search index / history / undo
                // stack could not be fully synced. Without surfacing this,
                // search results and undo silently point at stale paths.
                if (result?.pathIndexUpdated === false || result?.undoRecorded === false) {
                  const degraded = [
                    ...(result?.pathIndexUpdated === false ? ['search index'] : []),
                    ...(result?.undoRecorded === false ? ['undo history'] : [])
                  ].join(' and ');
                  addNotification(
                    `Files moved, but the ${degraded} could not be updated. Re-analyzing the affected folders will restore consistency.`,
                    'warning',
                    9000
                  );
                  logger.warn('[ORGANIZE] Post-batch persistence degraded', {
                    pathIndexUpdated: result?.pathIndexUpdated,
                    undoRecorded: result?.undoRecorded
                  });
                }

                // Only a run that got through every file fills the bar. A
                // cancelled, paused, interrupted, stopped or rolled-back run
                // keeps the count it reached, so it is not shown as done.
                const stoppedEarly =
                  rolledBackBatch ||
                  cancelledRef.current ||
                  Boolean(
                    result?.cancelled ||
                    result?.interrupted ||
                    result?.paused ||
                    result?.stoppedOnFailure
                  );
                if (!stoppedEarly) {
                  setBatchProgress({
                    current: filesToProcess.length,
                    total: filesToProcess.length,
                    currentFile: ''
                  });
                }
              } else if (!rolledBackBatch) {
                logger.warn('[ORGANIZE] onExecute: No successful results to process');
              }
            } catch (callbackError) {
              logger.error('[ORGANIZE] onExecute callback failed:', callbackError.message);
            }
          },
          onUndo: (/** @type {any} */ result) => {
            try {
              logger.info('[ORGANIZE] onUndo called', {
                hasResult: !!result,
                hasResults: !!result?.results,
                resultsCount: result?.results?.length,
                organizedFilesRefCountBefore: organizedFilesRef.current?.length
              });

              // Only rows the main process reported as moved are synced. For undo the
              // file moves FROM the organized path (source) TO the original path
              // (destination); UndoRedoService also populates originalPath.
              const successfulRows = Array.isArray(result?.results)
                ? result.results.filter((/** @type {any} */ r) => r?.success)
                : [];
              if (successfulRows.length === 0 && result?.success !== true) {
                logger.warn('[ORGANIZE] onUndo: nothing restored, leaving state untouched', {
                  code: result?.code,
                  message: result?.message
                });
                return;
              }

              const successfulUndos = successfulRows
                .map((/** @type {any} */ r) => r.destination || r.originalPath || r.newPath)
                .filter(Boolean);

              if (successfulUndos.length > 0) {
                logger.info('[ORGANIZE] onUndo: unmarking files', {
                  successfulUndos,
                  successfulUndosCount: successfulUndos.length
                });

                const undoPathsSet = new Set(successfulUndos.map(normalizeForComparison));

                removeOrganizedFiles(successfulUndos);

                organizedFilesRef.current = organizedFilesRef.current.filter(
                  (/** @type {any} */ of) =>
                    !undoPathsSet.has(normalizeForComparison(of.originalPath))
                );

                unmarkFilesAsProcessed(
                  collectPathsToUnmarkAfterUndo(successfulUndos, successfulRows)
                );
              }

              const remaps = successfulRows.filter(
                (/** @type {any} */ r) => r.source && r.destination
              );
              if (dispatch && remaps.length > 0) {
                const oldPaths = remaps.map((/** @type {any} */ r) => r.source);
                const newPaths = remaps.map((/** @type {any} */ r) => r.destination);

                logger.debug('[ORGANIZE] onUndo: reverting Redux paths', {
                  count: oldPaths.length,
                  sampleOld: oldPaths[0],
                  sampleNew: newPaths[0]
                });

                dispatch(updateResultPathsAfterMove({ oldPaths, newPaths }));
                dispatch(updateFilePathsAfterMove({ oldPaths, newPaths }));
              }

              const successCount = result?.successCount ?? successfulUndos.length;
              const failCount = result?.failCount ?? 0;

              if (failCount > 0) {
                addNotification(
                  `Undo partially complete: ${countOf(successCount)} restored, ${failCount} failed.`,
                  'warning'
                );
              } else if (successCount > 0) {
                addNotification(
                  successCount === 1
                    ? 'Undo complete. 1 file restored to its original location.'
                    : `Undo complete. ${successCount} files restored to original locations.`,
                  'info'
                );
              }
            } catch (undoError) {
              logger.error('[ORGANIZE] onUndo callback failed:', undoError.message);
            }
          },
          onRedo: (/** @type {any} */ result) => {
            try {
              logger.info('[ORGANIZE] onRedo called', {
                hasResult: !!result,
                hasResults: !!result?.results,
                resultsCount: result?.results?.length,
                successCount: result?.successCount,
                organizedFilesRefCount: organizedFilesRef.current?.length
              });

              // Only rows the main process reported as moved are synced; the original
              // operations serve solely as a per-row destination fallback.
              const successfulResults = Array.isArray(result?.results)
                ? result.results.filter((/** @type {any} */ r) => r?.success && r.source)
                : [];
              if (successfulResults.length === 0 && result?.success !== true) {
                logger.warn('[ORGANIZE] onRedo: nothing re-organized, leaving state untouched', {
                  code: result?.code,
                  message: result?.message
                });
                return;
              }

              const operationMap = new Map(
                operations.map((/** @type {any} */ op) => [op.source, op.destination])
              );
              const redoMoves = successfulResults
                .map((/** @type {any} */ r) => ({
                  source: r.source,
                  destination: r.destination || operationMap.get(r.source)
                }))
                .filter((/** @type {any} */ r) => r.destination);
              const organizedAt = new Date().toISOString();
              const uiResults = redoMoves.map(
                (
                  /** @type {{ source: string, destination: string }} */ { source, destination }
                ) => {
                  const pathParts = destination.split(/[\\/]/);
                  return {
                    originalPath: source,
                    path: destination,
                    originalName: source.split(/[\\/]/).pop() || '',
                    newName: pathParts[pathParts.length - 1] || '',
                    smartFolder:
                      pathParts.length >= 2 ? pathParts[pathParts.length - 2] : 'Organized',
                    organizedAt
                  };
                }
              );
              if (dispatch && redoMoves.length > 0) {
                const oldPaths = redoMoves.map((/** @type {any} */ r) => r.source);
                const newPaths = redoMoves.map((/** @type {any} */ r) => r.destination);
                dispatch(updateResultPathsAfterMove({ oldPaths, newPaths }));
                dispatch(updateFilePathsAfterMove({ oldPaths, newPaths }));
              }

              if (uiResults.length > 0) {
                const existingPaths = new Set(
                  organizedFilesRef.current.map((/** @type {any} */ f) =>
                    normalizeForComparison(f.originalPath)
                  )
                );
                const uniqueResults = uiResults.filter(
                  (/** @type {any} */ r) =>
                    !existingPaths.has(normalizeForComparison(r.originalPath))
                );

                logger.debug('[ORGANIZE] onRedo: processing results', {
                  uiResultsCount: uiResults.length,
                  uniqueResultsCount: uniqueResults.length,
                  existingPathsCount: existingPaths.size
                });

                if (uniqueResults.length > 0) {
                  const pathsToMark = collectPathsForProcessedTracking(uniqueResults);
                  logger.info('[ORGANIZE] onRedo: marking files as processed', {
                    pathsToMark,
                    uniqueResultsCount: uniqueResults.length
                  });

                  addOrganizedFiles(uniqueResults);

                  // Sync ref locally
                  organizedFilesRef.current = [...organizedFilesRef.current, ...uniqueResults];

                  markFilesAsProcessed(pathsToMark);
                } else {
                  logger.warn('[ORGANIZE] onRedo: No unique results to process', {
                    existingPathsCount: existingPaths.size,
                    existingPaths: Array.from(existingPaths).slice(0, 5),
                    uiResultPaths: uiResults
                      .map((/** @type {any} */ r) => normalizeForComparison(r.originalPath))
                      .slice(0, 5)
                  });
                }
              }

              const successCount = result?.successCount ?? uiResults.length;
              const failCount = result?.failCount ?? 0;

              if (failCount > 0) {
                addNotification(
                  `Redo partially complete: ${countOf(successCount)} re-organized, ${failCount} failed.`,
                  'warning'
                );
              } else if (successCount > 0) {
                addNotification(`Redo complete. ${countOf(successCount)} re-organized.`, 'info');
              }
            } catch (redoError) {
              logger.error('[ORGANIZE] onRedo callback failed:', redoError.message);
            }
          }
        };

        logger.info('[ORGANIZE] Executing batch action with', {
          operationsCount: operations.length
        });

        const result = await executeAction(
          createOrganizeBatchAction(
            `Organize ${countOf(operations.length)}`,
            operations,
            stateCallbacks,
            resumeInfo ? { resumeBatchId: resumeInfo.batchId } : undefined
          )
        );

        logger.info('[ORGANIZE] Batch action result:', {
          success: result?.success,
          resultsCount: result?.results?.length ?? 0
        });

        const successCount = Number.isInteger(result?.successCount)
          ? result.successCount
          : Array.isArray(result?.results)
            ? result.results.filter((/** @type {any} */ r) => r.success).length
            : result?.chunkedResults
              ? chunkedResultsRef.current.filter((/** @type {any} */ r) => r?.success).length
              : 0;
        const totalResultCount = Number.isInteger(result?.completedOperations)
          ? result.completedOperations
          : Array.isArray(result?.results)
            ? result.results.length
            : chunkedResultsRef.current.length;

        logger.info('[ORGANIZE] Final result:', {
          successCount,
          totalResults: totalResultCount,
          willAdvancePhase: successCount > 0
        });

        if (result?.paused) {
          // Park the batch: journal id + the exact operations we sent, so
          // resume can re-invoke and the main side skips done ops.
          pausedBatchRef.current = { batchId: result.batchId, operations };
          if (isMountedRef.current) {
            setIsPaused(true);
            setPausedSummary({
              completed: successCount,
              remaining: Number.isInteger(result.cancelledCount) ? result.cancelledCount : 0
            });
          }
          addNotification(
            `Organization paused — ${successCount} file${successCount === 1 ? '' : 's'} organized so far. Resume when ready.`,
            'info',
            5000,
            'organize-paused'
          );
          return;
        }
        // A run that finished without pausing supersedes any parked batch.
        pausedBatchRef.current = null;

        // Main rolled the batch back; onExecute already told the user what
        // was restored and what was left behind. Stay on Organize.
        if (result?.rolledBack === true) return;

        if (successCount > 0) {
          // Only auto-advance when user is still on Organize phase.
          // This prevents surprising navigation if they moved elsewhere while the batch completed.
          if (currentPhaseRef.current !== (PHASES?.ORGANIZE ?? 'organize')) {
            logger.info('[ORGANIZE] Skipping auto-advance: phase changed during operation', {
              currentPhase: currentPhaseRef.current
            });
            return;
          }
          // Cancellation was requested mid-batch. Some files completed before
          // the abort signal landed; surface the partial result and stay on
          // the Organize phase so the user can decide whether to undo or keep.
          if (cancelledRef.current || result?.cancelled) {
            const remaining = Number.isInteger(result?.cancelledCount)
              ? result.cancelledCount
              : Math.max(0, totalResultCount - successCount);
            addNotification(
              `Organization cancelled — ${successCount} file${successCount === 1 ? '' : 's'} organized, ${remaining} skipped.`,
              'warning'
            );
            return;
          }
          // Some files were left where they were. Stay on Organize, where the
          // banner says why and those files are still listed; Complete has
          // no place for either.
          if (reported.outcome === 'partial' || reported.outcome === 'none') return;
          actions.advancePhase(PHASES?.COMPLETE ?? 'complete');
        } else if (reported.outcome === null) {
          // onExecute had nothing to report, so this is the only message.
          logger.warn('[ORGANIZE] No successful operations - phase will not advance');
          addNotification(
            cancelledRef.current || result?.cancelled
              ? 'Organization cancelled before any file was moved.'
              : 'No files were organized successfully. Check the logs for details.',
            'warning'
          );
        }
      } catch (error) {
        logger.error('[ORGANIZE] Organization error:', {
          message: error.message,
          stack: error.stack
        });
        if (isMountedRef.current) {
          const { message } = mapErrorToNotification({ error });
          addNotification(`Organization failed: ${message}`, 'error');
        }
      } finally {
        traceSession?.end?.();
        // Always clear global organizing flag even if phase unmounted mid-operation.
        setOrganizingState(false);
        if (isMountedRef.current) {
          setIsOrganizing(false);
          setBatchProgress({ current: 0, total: 0, currentFile: '' });
          setIsCancelling(false);
          setIsPausing(false);
        }
        // Reset cancel flag for the next batch. Done in finally so a thrown
        // batch doesn't leak the flag into the next run and silently suppress
        // the next auto-advance.
        cancelledRef.current = false;
      }
    },
    [
      unprocessedFiles,
      editingFiles,
      getFileWithEdits,
      findSmartFolderForCategory,
      findSmartFolderForFile,
      defaultLocation,
      smartFolders,
      suggestionsByPath,
      analysisResults,
      markFilesAsProcessed,
      unmarkFilesAsProcessed,
      actions,
      addNotification,
      executeAction,
      dispatch,
      addOrganizedFiles,
      removeOrganizedFiles,
      setOrganizingState,
      setLastOrganizeRun,
      setBatchProgress,
      setIsOrganizing,
      setOrganizePreview,
      setOrganizeConflicts,
      resetChunkedResults,
      chunkedResultsRef
    ]
  );

  /**
   * Compute the dry-run plan for the same set of files handleOrganizeFiles
   * would commit. Builds operations identically to the commit path
   * (same buildOperations call) so the previewed destinations match
   * exactly what an immediate Move would do, then invokes
   * previewBatchOrganize which short-circuits the main-process handler
   * before any disk write.
   *
   * Returns the main-process plan plus `sameDestination`, the files this
   * batch sends to one name (the move refuses to start while any exist), or
   * null when no file has a destination to preview. Throws when the request
   * fails or is refused, so the caller can say why instead of reporting an
   * empty preview. Caller decides how to surface (notification, modal,
   * etc.) — this hook intentionally doesn't push UI side-effects so
   * different phases can render the plan their own way.
   */
  const handlePreviewOrganize = useCallback(
    async (/** @type {any} */ filesToOrganize = null) => {
      const filesToProcess =
        Array.isArray(filesToOrganize) && filesToOrganize.length > 0
          ? filesToOrganize
          : unprocessedFiles || [];
      if (filesToProcess.length === 0) return null;

      const planInputs = {
        filesToProcess,
        unprocessedFiles,
        editingFiles,
        getFileWithEdits,
        findSmartFolderForCategory,
        findSmartFolderForFile,
        defaultLocation,
        smartFolders,
        suggestionsByPath
      };
      const { operations } = buildOperations(planInputs);

      const validOps = operations.filter((/** @type {any} */ op) => op?.source && op?.destination);
      if (validOps.length === 0) return null;

      try {
        const plan = await previewBatchOrganize(validOps);
        if (!plan || plan.success === false) {
          throw new Error(plan?.error || 'The preview request was refused');
        }
        return { ...plan, sameDestination: buildPreview(planInputs).conflicts };
      } catch (error) {
        logger.warn('[ORGANIZE] Preview failed', { error: error?.message });
        throw error;
      }
    },
    [
      unprocessedFiles,
      editingFiles,
      getFileWithEdits,
      findSmartFolderForCategory,
      findSmartFolderForFile,
      defaultLocation,
      smartFolders,
      suggestionsByPath
    ]
  );

  const resumeOrganize = useCallback(
    () => handleOrganizeFiles(null, { resume: true }),
    [handleOrganizeFiles]
  );

  // Ready files the plan leaves in the folder they are in, so the screen can
  // say so before the run reports them as moved.
  const inPlaceMoves = useMemo(
    () =>
      findInPlaceMoves({
        files: (unprocessedFiles || []).filter((/** @type {any} */ f) => f && f.analysis),
        editingFiles,
        getFileWithEdits,
        findSmartFolderForCategory,
        findSmartFolderForFile,
        defaultLocation,
        smartFolders,
        suggestionsByPath
      }),
    [
      unprocessedFiles,
      editingFiles,
      getFileWithEdits,
      findSmartFolderForCategory,
      findSmartFolderForFile,
      defaultLocation,
      smartFolders,
      suggestionsByPath
    ]
  );

  return {
    isOrganizing,
    batchProgress,
    organizePreview,
    handleOrganizeFiles,
    handlePreviewOrganize,
    setBatchProgress,
    organizeConflicts,
    inPlaceMoves,
    cancelOrganize,
    isCancelling,
    pauseOrganize,
    resumeOrganize,
    dismissPausedBatch,
    isPausing,
    isPaused,
    pausedSummary
  };
}
