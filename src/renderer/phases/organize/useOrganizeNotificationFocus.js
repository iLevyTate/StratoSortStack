// @ts-check
import { useEffect, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { clearOrganizeFocus } from '../../store/slices/uiSlice';
import { findFileByPathOrName, findFileIndexByPathOrName } from '../../utils/findFileInList';
import { toCanonicalPath } from '../../utils/canonicalPath';
import { isMac, isWindows } from '../../utils/platform';
import { createLogger } from '../../../shared/logger';

const logger = createLogger('OrganizeNotificationFocus');

/** What the OS calls the window a revealed file is shown in. */
function fileManagerName() {
  if (isMac) return 'Finder';
  if (isWindows) return 'File Explorer';
  return 'your file manager';
}

/**
 * When the user clicks a download/watcher notification, jump to the matching
 * file in Organize (scroll + select + details), or reveal it in the file manager.
 */
/**
 * @param {{ unprocessedFiles: any[], processedFiles: any[], setSelectedFiles: Function, setFocusFileIndex: Function, setViewingFileDetails: Function, setShowHistoryModal: Function, addNotification: Function, revealFile: Function }} args
 */
export function useOrganizeNotificationFocus({
  unprocessedFiles,
  processedFiles,
  setSelectedFiles,
  setFocusFileIndex,
  setViewingFileDetails,
  setShowHistoryModal,
  addNotification,
  revealFile
}) {
  const dispatch = useAppDispatch();
  const organizeFocusRequest = useAppSelector(
    (/** @type {any} */ state) => state.ui.organizeFocusRequest
  );
  const handledRequestAtRef = useRef(0);

  // The lookup below outlives the render that started it. Organize replaces
  // the file lists right after mount (and whenever results stream in), so
  // they are read through refs: a new list must not cancel a lookup that is
  // still waiting on history or Explorer.
  const unprocessedFilesRef = useRef(unprocessedFiles);
  const processedFilesRef = useRef(processedFiles);
  const addNotificationRef = useRef(addNotification);
  const revealFileRef = useRef(revealFile);
  useEffect(() => {
    unprocessedFilesRef.current = unprocessedFiles;
    processedFilesRef.current = processedFiles;
    addNotificationRef.current = addNotification;
    revealFileRef.current = revealFile;
  });

  useEffect(() => {
    if (!organizeFocusRequest?.requestedAt) return;
    if (handledRequestAtRef.current === organizeFocusRequest.requestedAt) return;

    handledRequestAtRef.current = organizeFocusRequest.requestedAt;

    const { filePath, fileName, openDetails = true } = organizeFocusRequest;

    const finish = () => dispatch(clearOrganizeFocus());

    /** Focus the file if it is in the queue or the organized list. */
    const focusInLists = () => {
      const unprocessed = unprocessedFilesRef.current;
      const unprocessedIndex = findFileIndexByPathOrName(unprocessed, filePath, fileName);
      if (unprocessedIndex >= 0) {
        setSelectedFiles(new Set([toCanonicalPath(unprocessed[unprocessedIndex].path)]));
        setFocusFileIndex(unprocessedIndex);
        if (openDetails) {
          setViewingFileDetails(unprocessed[unprocessedIndex]);
        }
        return true;
      }

      const processedMatch = findFileByPathOrName(processedFilesRef.current, filePath, fileName);
      if (processedMatch) {
        setShowHistoryModal(true);
        if (openDetails) {
          setViewingFileDetails({
            name: fileName || processedMatch.originalName || processedMatch.name,
            path: filePath || processedMatch.path || processedMatch.currentPath,
            analysis: processedMatch.analysis || null
          });
        }
        return true;
      }
      return false;
    };

    if (focusInLists()) {
      finish();
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        if (filePath && typeof window.electronAPI?.analysisHistory?.getFileHistory === 'function') {
          const history = await window.electronAPI.analysisHistory.getFileHistory(filePath);
          if (cancelled) return;

          // On a fresh mount the organized list is still empty when the
          // request arrives; it is filled by the time history answers.
          if (focusInLists()) return;

          const entry = Array.isArray(history) ? history[0] : history;
          if (entry && typeof entry === 'object') {
            setViewingFileDetails({
              name: fileName || entry.fileName || entry.suggestedName,
              path: filePath,
              analysis: entry
            });
            return;
          }
        }

        const reveal = revealFileRef.current;
        if (filePath && typeof reveal === 'function') {
          await reveal(filePath);
          if (!cancelled) {
            addNotificationRef.current(
              `Opened ${fileName || 'file'} in ${fileManagerName()}`,
              'info',
              3500
            );
          }
        } else if (fileName) {
          addNotificationRef.current(`Could not locate ${fileName} in Organize`, 'warning', 4500);
        }
      } catch (error) {
        logger.warn('Failed to focus file from notification', { error: error?.message, filePath });
        if (!cancelled) {
          addNotificationRef.current(
            'Could not open the file from this notification',
            'warning',
            4500
          );
        }
      } finally {
        if (!cancelled) finish();
      }
    })();

    // Runs on unmount or when a newer request replaces this one.
    return () => {
      cancelled = true;
    };
  }, [
    organizeFocusRequest,
    setSelectedFiles,
    setFocusFileIndex,
    setViewingFileDetails,
    setShowHistoryModal,
    dispatch
  ]);
}

export default useOrganizeNotificationFocus;
