// @ts-check
/**
 * useFileEditing Hook
 *
 * File editing, selection, and state display logic.
 *
 * @module organize/useFileEditing
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import PropTypes from 'prop-types';
import { debounce } from '../../utils/performance';
import { isWindows } from '../../utils/platform';
import { toCanonicalPath } from '../../utils/canonicalPath';

// Inline SVG Icons (keep UI visuals)
function CheckCircleIcon(/** @type {{ className?: string }} */ { className }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

function RefreshCwIcon(/** @type {{ className?: string }} */ { className }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
      />
    </svg>
  );
}

function XCircleIcon(/** @type {{ className?: string }} */ { className }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

function FolderOpenIcon(/** @type {{ className?: string }} */ { className }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z"
      />
    </svg>
  );
}

function ClockIcon(/** @type {{ className?: string }} */ { className }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

const iconPropTypes = {
  className: PropTypes.string
};

CheckCircleIcon.propTypes = iconPropTypes;
RefreshCwIcon.propTypes = iconPropTypes;
XCircleIcon.propTypes = iconPropTypes;
FolderOpenIcon.propTypes = iconPropTypes;
ClockIcon.propTypes = iconPropTypes;

/**
 * Hook for file state display
 * @param {Object} fileStates - File states object
 * @returns {Object} File state helpers
 */
export function useFileStateDisplay(fileStates) {
  const safeFileStates = useMemo(
    () =>
      fileStates && typeof fileStates === 'object' && !Array.isArray(fileStates) ? fileStates : {},
    [fileStates]
  );
  // Canonical-key lookup: fileStates keys originate from multiple IPC
  // sources and may differ from the grid's paths in case/separator style;
  // a raw lookup misrenders ready files as "Pending".
  const stateByCanonical = useMemo(
    () => new Map(Object.entries(safeFileStates).map(([p, info]) => [toCanonicalPath(p), info])),
    [safeFileStates]
  );
  const getFileState = useCallback(
    (/** @type {any} */ filePath) =>
      stateByCanonical.get(toCanonicalPath(filePath))?.state || 'pending',
    [stateByCanonical]
  );

  const getFileStateDisplay = useCallback(
    (/** @type {any} */ filePath, /** @type {any} */ hasAnalysis, isProcessed = false) => {
      if (isProcessed)
        return {
          icon: <CheckCircleIcon className="w-4 h-4" />,
          iconSymbol: '✅',
          label: 'Organized',
          color: 'text-stratosort-success',
          spinning: false
        };
      const state = getFileState(filePath);
      if (state === 'analyzing')
        return {
          icon: <RefreshCwIcon className="w-4 h-4" />,
          iconSymbol: '🔄',
          label: 'Analyzing...',
          color: 'text-stratosort-blue',
          spinning: true
        };
      // Files with usable analysis data are actionable in the organize phase,
      // even if the analysis hit an error (fallback analysis provides name/category).
      if (hasAnalysis)
        return {
          icon: <FolderOpenIcon className="w-4 h-4" />,
          iconSymbol: '📂',
          label: 'Ready',
          color: 'text-stratosort-blue',
          spinning: false
        };
      if (state === 'error')
        return {
          icon: <XCircleIcon className="w-4 h-4" />,
          iconSymbol: '❌',
          label: 'Error',
          color: 'text-stratosort-danger',
          spinning: false
        };
      if (state === 'pending')
        return {
          icon: <ClockIcon className="w-4 h-4" />,
          iconSymbol: '🕒',
          label: 'Pending',
          color: 'text-yellow-600',
          spinning: false
        };
      return {
        icon: <XCircleIcon className="w-4 h-4" />,
        iconSymbol: '❌',
        label: 'Failed',
        color: 'text-stratosort-danger',
        spinning: false
      };
    },
    [getFileState]
  );

  return { getFileState, getFileStateDisplay };
}

/**
 * Hook for file editing
 * @param {Object} options - Hook options
 * @param {Function} [options.onEditChange] - Callback when an edit occurs (filePath, field, value)
 * @returns {Object} File editing state and handlers
 */
/** @param {{ onEditChange?: Function }} [args] */
export function useFileEditing({ onEditChange } = {}) {
  const [editingFiles, setEditingFiles] = useState(/** @type {Record<string, any>} */ ({}));

  const handleEditFile = useCallback(
    (/** @type {any} */ filePath, /** @type {any} */ field, /** @type {any} */ value) => {
      const key = toCanonicalPath(filePath);
      if (!key) return;
      setEditingFiles((prev) => ({
        ...prev,
        [key]: { ...prev[key], [field]: value }
      }));
      if (onEditChange) {
        onEditChange(filePath, field, value);
      }
    },
    [onEditChange]
  );

  const getFileWithEdits = useCallback(
    (/** @type {any} */ file, /** @type {any} */ _index) => {
      const key = toCanonicalPath(file?.path);
      const edits = key ? editingFiles[key] : undefined;
      if (!edits) return file;
      const updatedCategory = edits.category ?? file.analysis?.category;
      return {
        ...file,
        analysis: {
          ...file.analysis,
          suggestedName: edits.suggestedName ?? file.analysis?.suggestedName,
          category: updatedCategory
        }
      };
    },
    [editingFiles]
  );

  return { editingFiles, setEditingFiles, handleEditFile, getFileWithEdits };
}

/**
 * Hook for file selection keyed by canonical path (not array index).
 * @param {any[] | number} files - File list (or legacy length; path-keyed when given files)
 * @returns {Object} Selection state and handlers
 */
export function useFileSelection(files) {
  const [selectedFiles, setSelectedFiles] = useState(() => new Set());

  const fileKeys = useMemo(() => {
    if (Array.isArray(files)) {
      return files
        .map((/** @type {any} */ file) =>
          toCanonicalPath(typeof file === 'string' ? file : file?.path)
        )
        .filter(Boolean);
    }
    return [];
  }, [files]);

  // Drop keys that left the visible list so "Move N selected" cannot target a
  // stale path after a concurrent removal (SW-81).
  useEffect(() => {
    const live = new Set(fileKeys);
    setSelectedFiles((prev) => {
      let changed = false;
      const next = new Set();
      for (const key of prev) {
        if (live.has(key)) next.add(key);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [fileKeys]);

  // This keeps toggleFileSelection stable across renders, preventing unnecessary re-renders
  // of memoized child components like ReadyFileItem
  const toggleFileSelection = useCallback((/** @type {any} */ filePath) => {
    const key = toCanonicalPath(filePath);
    if (!key) return;
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  const selectAllFiles = useCallback(() => {
    setSelectedFiles((prev) => {
      const allSelected =
        fileKeys.length > 0 &&
        prev.size === fileKeys.length &&
        fileKeys.every((key) => prev.has(key));
      return allSelected ? new Set() : new Set(fileKeys);
    });
  }, [fileKeys]);

  const clearSelection = useCallback(() => {
    setSelectedFiles(new Set());
  }, []);

  return {
    selectedFiles,
    setSelectedFiles,
    toggleFileSelection,
    selectAllFiles,
    clearSelection
  };
}

/**
 * Hook for bulk operations
 * @param {{ selectedFiles: any[], editingFiles: Record<string, any>, setEditingFiles: Function, setSelectedFiles: Function, addNotification: Function }} params
 * @returns {Record<string, any>} Bulk operation state and handlers
 */
export function useBulkOperations({
  selectedFiles,
  editingFiles,
  setEditingFiles,
  setSelectedFiles,
  addNotification
}) {
  const [bulkEditMode, setBulkEditMode] = useState(false);
  const [bulkCategory, setBulkCategory] = useState('');

  const selectedFilesRef = useRef(selectedFiles);
  const editingFilesRef = useRef(editingFiles);
  const bulkCategoryRef = useRef(bulkCategory);
  const addNotificationRef = useRef(addNotification);

  // Keep refs in sync with latest values
  useEffect(() => {
    selectedFilesRef.current = selectedFiles;
  }, [selectedFiles]);
  useEffect(() => {
    editingFilesRef.current = editingFiles;
  }, [editingFiles]);
  useEffect(() => {
    bulkCategoryRef.current = bulkCategory;
  }, [bulkCategory]);
  useEffect(() => {
    addNotificationRef.current = addNotification;
  }, [addNotification]);

  // Debounced bulk category change ref
  const debouncedBulkCategoryChangeRef = useRef(null);

  // Initialize debounced function once - uses refs for latest values
  useEffect(() => {
    debouncedBulkCategoryChangeRef.current = debounce(() => {
      const category = bulkCategoryRef.current;
      const selected = /** @type {Set<any>} */ (/** @type {unknown} */ (selectedFilesRef.current));
      const edits = editingFilesRef.current;
      const notify = addNotificationRef.current;

      if (!category) return;
      /** @type {Record<string, any>} */
      const newEdits = {};
      selected.forEach((/** @type {any} */ i) => {
        const existingEdit = edits[i] || {};
        newEdits[i] = { ...existingEdit, category };
      });
      setEditingFiles((/** @type {any} */ prev) => ({ ...prev, ...newEdits }));
      setBulkEditMode(false);
      setBulkCategory('');
      setSelectedFiles(new Set());
      notify(`Applied category "${category}" to ${selected.size} files`, 'success');
    }, 300);

    return () => {
      if (debouncedBulkCategoryChangeRef.current) {
        debouncedBulkCategoryChangeRef.current.cancel?.();
        debouncedBulkCategoryChangeRef.current = null;
      }
    };
  }, [setEditingFiles, setSelectedFiles]); // Only stable setters needed

  const applyBulkCategoryChange = useCallback(() => {
    if (!bulkCategoryRef.current) return;
    debouncedBulkCategoryChangeRef.current?.();
  }, []);

  return {
    bulkEditMode,
    setBulkEditMode,
    bulkCategory,
    setBulkCategory,
    applyBulkCategoryChange
  };
}

/**
 * Hook for processed files tracking
 * @param {any[]} organizedFiles - Array of organized files
 * @returns {Record<string, any>} Processed files state and handlers
 */
export function useProcessedFiles(organizedFiles) {
  const [processedFileIds, setProcessedFileIds] = useState(new Set());

  // This ensures undo/redo operations work correctly regardless of path separators or case
  const normalizePath = useCallback((/** @type {any} */ p) => {
    const normalized = (p || '').replace(/[\\/]+/g, '/');
    return isWindows ? normalized.toLowerCase() : normalized;
  }, []);

  const markFilesAsProcessed = useCallback(
    (/** @type {any} */ filePaths) =>
      setProcessedFileIds((prev) => {
        const next = new Set(prev);
        filePaths.forEach((/** @type {any} */ path) => next.add(normalizePath(path)));
        return next;
      }),
    [normalizePath]
  );

  const unmarkFilesAsProcessed = useCallback(
    (/** @type {any} */ filePaths) =>
      setProcessedFileIds((prev) => {
        const next = new Set(prev);
        filePaths.forEach((/** @type {any} */ path) => next.delete(normalizePath(path)));
        return next;
      }),
    [normalizePath]
  );

  // Compute unprocessed and processed files
  const getFilteredFiles = useCallback(
    (/** @type {any} */ filesWithAnalysis) => {
      const safeFiles = Array.isArray(filesWithAnalysis) ? filesWithAnalysis : [];
      const unprocessedFiles = safeFiles.filter(
        (file) =>
          file && file.path && file.analysis && !processedFileIds.has(normalizePath(file.path))
      );
      const processedFiles = Array.isArray(organizedFiles)
        ? organizedFiles.filter((file) => {
            const candidates = [file?.originalPath, file?.path, file?.currentPath].filter(Boolean);
            return candidates.some((p) => processedFileIds.has(normalizePath(p)));
          })
        : [];
      return { unprocessedFiles, processedFiles };
    },
    [processedFileIds, organizedFiles, normalizePath]
  );

  return {
    processedFileIds,
    setProcessedFileIds,
    markFilesAsProcessed,
    unmarkFilesAsProcessed,
    getFilteredFiles,
    normalizePath
  };
}

export default {
  useFileStateDisplay,
  useFileEditing,
  useFileSelection,
  useBulkOperations,
  useProcessedFiles
};
