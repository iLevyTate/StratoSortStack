// @ts-check
/**
 * useOrganization Hook
 *
 * Main organization logic for batch file operations.
 *
 * @module organize/useOrganization
 */

import { useState, useCallback, useEffect, useRef } from 'react';
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
import { toCanonicalPath } from '../../utils/canonicalPath';
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
/** Auto-clear inline organize success banner (FI-02) */
const LAST_ORGANIZE_SUMMARY_CLEAR_MS = 12000;
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
  const currentCategory = smartFolder ? smartFolder.name : 'Uncategorized';

  // Always use a validated smart folder path; never build a path from a raw category.
  const resolvedFolder = smartFolder || findSmartFolderForCategory('Uncategorized');
  const destinationDir = resolvedFolder
    ? resolvedFolder.path || joinPath(defaultLocation, resolvedFolder.name || 'Uncategorized')
    : joinPath(defaultLocation, 'Uncategorized');

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
    categoryChanged,
    originalCategory,
    finalCategory: currentCategory,
    suggestion: suggestionForOperation(destination, smartFolders)
  };
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
  setOrganizingState = () => {}
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
  /** Inline success banner on Organize (FI-02); cleared on new run or after timeout */
  const [lastOrganizeSummary, setLastOrganizeSummary] = useState(null);
  useEffect(() => {
    if (!lastOrganizeSummary) return undefined;
    const id = setTimeout(() => setLastOrganizeSummary(null), LAST_ORGANIZE_SUMMARY_CLEAR_MS);
    return () => clearTimeout(id);
  }, [lastOrganizeSummary]);
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

              const operationMap = new Map(
                operations.map((/** @type {any} */ op) => [op.source, op.destination])
              );
              const uiResults = resArray
                .filter((/** @type {any} */ r) => r.success)
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
                    organizedAt: new Date().toISOString()
                  };
                });
              const successfulMoves = resArray
                .filter((/** @type {any} */ r) => r.success && r.source)
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
              if (uiResults.length > 0) {
                addOrganizedFiles(uiResults);

                // Keep ref in sync for other local logic if needed (though Redux is source of truth)
                organizedFilesRef.current = [...organizedFilesRef.current, ...uiResults];

                markFilesAsProcessed(collectPathsForProcessedTracking(uiResults));

                // When some files fail during batch operation, warn user about partial completion
                const failedCount = resArray.filter((/** @type {any} */ r) => !r.success).length;
                if (result?.partialFailure || failedCount > 0) {
                  addNotification(
                    `Organized ${uiResults.length} files with ${failedCount} failures. ${describeFirstFailure(resArray)}`,
                    'warning',
                    8000
                  );
                  logger.warn('[ORGANIZE] Partial failure in batch operation', {
                    successCount: uiResults.length,
                    failCount: failedCount,
                    error: result?.error
                  });
                } else {
                  addNotification(`Organized ${uiResults.length} files`, 'success', 7000);
                }

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

                setLastOrganizeSummary({
                  count: uiResults.length,
                  partial: Boolean(result?.partialFailure || failedCount > 0),
                  failedCount: failedCount || 0
                });

                setBatchProgress({
                  current: filesToProcess.length,
                  total: filesToProcess.length,
                  currentFile: ''
                });
              } else {
                logger.warn('[ORGANIZE] onExecute: No successful results to process');
                if (resArray.length > 0) {
                  // Every file was refused. The reason was logged in main and
                  // never shown; the first refusal names the rule.
                  addNotification(
                    `No files were organized. ${describeFirstFailure(resArray)}`,
                    'error',
                    9000
                  );
                }
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
                  `Undo partially complete: ${successCount} files restored, ${failCount} failed.`,
                  'warning'
                );
              } else if (successCount > 0) {
                addNotification(
                  `Undo complete. ${successCount} files restored to original locations.`,
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
                  `Redo partially complete: ${successCount} files re-organized, ${failCount} failed.`,
                  'warning'
                );
              } else if (successCount > 0) {
                addNotification(`Redo complete. ${successCount} files re-organized.`, 'info');
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
            `Organize ${operations.length} files`,
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
          actions.advancePhase(PHASES?.COMPLETE ?? 'complete');
        } else {
          logger.warn('[ORGANIZE] No successful operations - phase will not advance');
          addNotification(
            'No files were organized successfully. Check the logs for details.',
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
   * Returns the main-process plan or null when the API surface is
   * unavailable. Caller decides how to surface (notification, modal,
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

      const { operations } = buildOperations({
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

      const validOps = operations.filter((/** @type {any} */ op) => op?.source && op?.destination);
      if (validOps.length === 0) return null;

      try {
        return await previewBatchOrganize(validOps);
      } catch (error) {
        logger.warn('[ORGANIZE] Preview failed', { error: error?.message });
        return null;
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

  return {
    isOrganizing,
    batchProgress,
    organizePreview,
    handleOrganizeFiles,
    handlePreviewOrganize,
    setBatchProgress,
    organizeConflicts,
    lastOrganizeSummary,
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
