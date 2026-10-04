// @ts-check
import { useEffect, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { clearOrganizeFocus } from '../../store/slices/uiSlice';
import { findFileByPathOrName, findFileIndexByPathOrName } from '../../utils/findFileInList';
import { toCanonicalPath } from '../../utils/canonicalPath';
import { createLogger } from '../../../shared/logger';

const logger = createLogger('OrganizeNotificationFocus');

/**
 * When the user clicks a download/watcher notification, jump to the matching
 * file in Organize (scroll + select + details), or reveal it in Explorer.
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

  useEffect(() => {
    if (!organizeFocusRequest?.requestedAt) return;
    if (handledRequestAtRef.current === organizeFocusRequest.requestedAt) return;

    handledRequestAtRef.current = organizeFocusRequest.requestedAt;

    const { filePath, fileName, openDetails = true } = organizeFocusRequest;

    const finish = () => dispatch(clearOrganizeFocus());

    const unprocessedIndex = findFileIndexByPathOrName(unprocessedFiles, filePath, fileName);
    if (unprocessedIndex >= 0) {
      setSelectedFiles(new Set([toCanonicalPath(unprocessedFiles[unprocessedIndex].path)]));
      setFocusFileIndex(unprocessedIndex);
      if (openDetails) {
        setViewingFileDetails(unprocessedFiles[unprocessedIndex]);
      }
      finish();
      return;
    }

    const processedMatch = findFileByPathOrName(processedFiles, filePath, fileName);
    if (processedMatch) {
      setShowHistoryModal(true);
      if (openDetails) {
        setViewingFileDetails({
          name: fileName || processedMatch.originalName || processedMatch.name,
          path: filePath || processedMatch.path || processedMatch.currentPath,
          analysis: processedMatch.analysis || null
        });
      }
      finish();
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        if (filePath && typeof window.electronAPI?.analysisHistory?.getFileHistory === 'function') {
          const history = await window.electronAPI.analysisHistory.getFileHistory(filePath);
          if (cancelled) return;

          const entry = Array.isArray(history) ? history[0] : history;
          if (entry && typeof entry === 'object') {
            setViewingFileDetails({
              name: fileName || entry.fileName || entry.suggestedName,
              path: filePath,
              analysis: entry
            });
            finish();
            return;
          }
        }

        if (filePath && typeof revealFile === 'function') {
          await revealFile(filePath);
          if (!cancelled) {
            addNotification(
              fileName ? `Opened ${fileName} in Explorer` : 'Opened file in Explorer',
              'info',
              3500
            );
          }
        } else if (fileName) {
          addNotification(`Could not locate ${fileName} in Organize`, 'warning', 4500);
        }
      } catch (error) {
        logger.warn('Failed to focus file from notification', { error: error?.message, filePath });
        if (!cancelled) {
          addNotification('Could not open the file from this notification', 'warning', 4500);
        }
      } finally {
        if (!cancelled) finish();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    organizeFocusRequest,
    unprocessedFiles,
    processedFiles,
    setSelectedFiles,
    setFocusFileIndex,
    setViewingFileDetails,
    setShowHistoryModal,
    addNotification,
    revealFile,
    dispatch
  ]);
}

export default useOrganizeNotificationFocus;
