// @ts-check
/**
 * File Actions Hook
 *
 * Custom hook for file action operations (open, reveal, delete).
 * Extracted from DiscoverPhase for better maintainability.
 *
 * @module phases/discover/useFileActions
 */

import { useCallback } from 'react';
import { mapErrorToNotification } from '../../utils/errorMapping';

/**
 * Custom hook for file action operations
 * @param {{ setAnalysisResults: Function, setSelectedFiles: Function, setFileStates: Function, addNotification: Function, showConfirm: Function, phaseData: any, onFileRemoved?: Function }} options
 * @returns {Record<string, any>} File action functions
 */
export function useFileActions({
  setAnalysisResults,
  setSelectedFiles,
  setFileStates,
  addNotification,
  showConfirm,
  phaseData,
  onFileRemoved
}) {
  /**
   * Handle file action (open, reveal, delete, reanalyze)
   */
  const handleFileAction = useCallback(
    async (/** @type {any} */ action, /** @type {any} */ filePath) => {
      if (!window.electronAPI?.files) {
        addNotification('File operations unavailable', 'error', 3000, 'file-actions');
        return;
      }
      try {
        switch (action) {
          case 'open':
            await window.electronAPI.files.open(filePath);
            addNotification(
              `Opened: ${filePath.split(/[\\/]/).pop()}`,
              'success',
              2000,
              'file-actions'
            );
            break;

          case 'reveal': {
            // Check if file exists at current path, if not try originalPath
            // This handles cases where files were organized and then undone
            let pathToReveal = filePath;
            try {
              const stats = await window.electronAPI.files.getStats(filePath);
              if (!stats || !stats.exists) {
                // File doesn't exist at current path, check if it's in organizedFiles
                const organizedFile = phaseData?.organizedFiles?.find(
                  (/** @type {any} */ f) => f.path === filePath || f.originalPath === filePath
                );
                if (organizedFile?.originalPath) {
                  const originalStats = await window.electronAPI.files.getStats(
                    organizedFile.originalPath
                  );
                  if (originalStats?.exists) {
                    pathToReveal = organizedFile.originalPath;
                  }
                }
              }
            } catch {
              // If stats check fails, try original path anyway
              const organizedFile = phaseData?.organizedFiles?.find(
                (/** @type {any} */ f) => f.path === filePath || f.originalPath === filePath
              );
              if (organizedFile?.originalPath) {
                pathToReveal = organizedFile.originalPath;
              }
            }
            await window.electronAPI.files.reveal(pathToReveal);
            addNotification(
              `Revealed: ${pathToReveal.split(/[\\/]/).pop()}`,
              'success',
              2000,
              'file-actions'
            );
            break;
          }

          case 'remove': {
            // Remove from queue without deleting from disk
            const fileName = filePath.split(/[\\/]/).pop();
            setAnalysisResults((/** @type {any} */ prev) =>
              prev.filter((/** @type {any} */ f) => f.path !== filePath)
            );
            setSelectedFiles((/** @type {any} */ prev) =>
              prev.filter((/** @type {any} */ f) => f.path !== filePath)
            );
            setFileStates((/** @type {any} */ prev) => {
              if (!prev) return prev;
              const next = { ...prev };
              delete next[filePath];
              return next;
            });
            onFileRemoved?.(filePath);
            let cleanupWarning = null;
            if (window?.electronAPI?.files?.cleanupAnalysis) {
              try {
                const cleanupResult = await window.electronAPI.files.cleanupAnalysis(filePath);
                if (cleanupResult?.success === false) {
                  cleanupWarning =
                    cleanupResult.warning || cleanupResult.error || 'Cleanup incomplete';
                }
              } catch (cleanupError) {
                cleanupWarning = cleanupError.message || 'Cleanup failed';
              }
            }

            const message = cleanupWarning
              ? `Removed from queue: ${fileName} (cleanup incomplete)`
              : `Removed from queue: ${fileName}`;
            addNotification(message, cleanupWarning ? 'warning' : 'info', 2000, 'file-actions');
            break;
          }

          case 'reanalyze': {
            if (!window.electronAPI?.embeddings?.reanalyzeFile) {
              addNotification('Reanalysis unavailable', 'error', 3000, 'file-actions');
              return;
            }
            const result = await window.electronAPI.embeddings.reanalyzeFile(filePath);
            if (result?.success) {
              addNotification(
                `Reanalysis queued: ${filePath.split(/[\\/]/).pop()}`,
                'success',
                2500,
                'file-actions'
              );
            } else if (result?.errorCode === 'NOT_IN_SMART_FOLDER') {
              // The scope guard rejects files outside any configured Smart
              // Folder root for security (see semantic.js:1723-1740). The
              // generic "not eligible" copy didn't tell the user how to
              // unblock — name the cause and the fix explicitly.
              addNotification(
                'This file is not inside a configured Smart Folder. Add its source folder as a Smart Folder destination to enable reanalysis.',
                'warning',
                6000,
                'file-actions'
              );
            } else {
              addNotification(
                result?.error || 'Reanalysis not eligible for this file',
                'warning',
                4000,
                'file-actions'
              );
            }
            break;
          }

          case 'delete': {
            const fileName = filePath.split(/[\\/]/).pop();
            const confirmDelete = await showConfirm({
              title: 'Delete file',
              message:
                'This file will be moved to the system Trash / Recycle Bin. Are you sure you want to delete it?',
              confirmText: 'Delete',
              cancelText: 'Cancel',
              variant: 'danger',
              fileName
            });
            if (confirmDelete) {
              let result = await window.electronAPI.files.delete(filePath);
              if (!result.success && result.errorCode === 'TRASH_UNAVAILABLE') {
                // The dialog above promised the Trash. The OS could not
                // provide one (no trash on this volume, no gio on Linux),
                // so ask again in plain words before anything irreversible.
                const reason = result.trashError ? ` (${result.trashError})` : '';
                const confirmPermanent = await showConfirm({
                  title: 'Delete permanently?',
                  message: `This file could not be moved to the system Trash${reason}. Deleting it permanently cannot be undone.`,
                  confirmText: 'Delete permanently',
                  cancelText: 'Keep file',
                  variant: 'danger',
                  fileName
                });
                if (!confirmPermanent) break;
                result = await window.electronAPI.files.delete(filePath, { permanent: true });
              }
              if (result.success) {
                setAnalysisResults((/** @type {any} */ prev) =>
                  prev.filter((/** @type {any} */ f) => f.path !== filePath)
                );
                setSelectedFiles((/** @type {any} */ prev) =>
                  prev.filter((/** @type {any} */ f) => f.path !== filePath)
                );
                setFileStates((/** @type {any} */ prev) => {
                  if (!prev) return prev;
                  const next = { ...prev };
                  delete next[filePath];
                  return next;
                });
                addNotification(
                  result.trashed === false
                    ? `Permanently deleted: ${fileName}`
                    : `Moved to Trash: ${fileName}`,
                  'success',
                  3000,
                  'file-actions'
                );
              } else {
                addNotification(`Failed to delete: ${fileName}`, 'error', 4000, 'file-actions');
              }
            }
            break;
          }

          default:
            addNotification(`Unknown action: ${action}`, 'error', 4000, 'file-actions');
        }
      } catch (error) {
        // Route through the shared error mapper so we don't leak raw stack
        // fragments / internal paths into the toast. Falls back to a generic
        // 'Operation failed' when the error doesn't match a known signature.
        const { message, severity } = mapErrorToNotification({
          error,
          operationType: 'Action'
        });
        addNotification(message, severity, 4000, 'file-actions');
      }
    },
    [
      addNotification,
      setSelectedFiles,
      setAnalysisResults,
      setFileStates,
      showConfirm,
      phaseData,
      onFileRemoved
    ]
  );

  return {
    handleFileAction
  };
}
