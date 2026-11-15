// @ts-check
/**
 * Keep a choice the user made about Smart Folders on those folders, so the
 * app does not ask again: whether a folder they sort may overlap one
 * (`sourceOverlapOk`), and what Organize does with files already in one
 * (`inPlaceFiles`). Each folder is edited with only the changed field; the
 * rest of its settings are left as they are.
 */
import { useCallback } from 'react';
import { createLogger } from '../../shared/logger';
import { useAppDispatch } from '../store/hooks';
import { invalidateSmartFolders } from '../store/slices/filesSlice';
import { smartFoldersIpc } from '../services/ipc';

const logger = createLogger('useRememberSmartFolderChoice');

/**
 * @typedef {{ sourceOverlapOk?: boolean, inPlaceFiles?: 'leave' | 'skip' | null }} SmartFolderChoice
 * @typedef {(folderIds: unknown[], choice: SmartFolderChoice) => Promise<boolean>} RememberSmartFolderChoice
 */

/**
 * @returns {RememberSmartFolderChoice} resolves true when every folder kept
 *   the choice
 */
export function useRememberSmartFolderChoice() {
  const dispatch = useAppDispatch();
  return useCallback(
    async (folderIds, choice) => {
      const ids = Array.from(
        new Set(
          (Array.isArray(folderIds) ? folderIds : []).filter(
            (id) => typeof id === 'string' && id.length > 0
          )
        )
      );
      let allSaved = true;
      // One at a time: each edit rewrites the whole folder list in main.
      for (const id of /** @type {string[]} */ (ids)) {
        try {
          const result = await smartFoldersIpc.edit(id, choice);
          if (!result?.success) {
            allSaved = false;
            logger.warn('Smart Folder choice not saved', { error: result?.error });
          }
        } catch (error) {
          allSaved = false;
          logger.warn('Smart Folder choice not saved', { error: error?.message });
        }
      }
      // Reload the list from main so every screen sees the choice.
      if (ids.length > 0) dispatch(/** @type {any} */ (invalidateSmartFolders()));
      return allSaved;
    },
    [dispatch]
  );
}
