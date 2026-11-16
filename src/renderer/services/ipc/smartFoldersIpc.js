// @ts-check
import { requireElectronAPI } from './electronApi';

// Description generation can hit a cold-load LLM init (10-20s on slow
// hardware) plus inference. 45s budget is generous; main-side budget
// matches at smartFolders.js generateDescription handler.
const DEFAULT_DESCRIPTION_TIMEOUT_MS = 45000;

/**
 * @param {Promise<any> | any} promise
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
function withDescriptionTimeout(promise, timeoutMs) {
  const effectiveTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_DESCRIPTION_TIMEOUT_MS;

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timeoutId;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({
        success: false,
        error: 'Description generation timed out. Try again.'
      });
    }, effectiveTimeoutMs);
  });

  return Promise.race([Promise.resolve(promise), timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

export const smartFoldersIpc = {
  get() {
    return requireElectronAPI().smartFolders.get();
  },
  /** @param {Record<string, any>} folder */
  add(folder) {
    return requireElectronAPI().smartFolders.add(folder);
  },
  /**
   * @param {string} folderId
   * @param {Record<string, any>} updatedFolder
   * @param {{ pathChange?: 'move' | 'new' }} [options] - the answer to a
   *   PATH_CHANGE_CHOICE_REQUIRED reply: move the old folder and its files to
   *   the new path, or start with a new empty folder there
   */
  edit(folderId, updatedFolder, options) {
    const api = requireElectronAPI().smartFolders;
    return options === undefined
      ? api.edit(folderId, updatedFolder)
      : api.edit(folderId, updatedFolder, options);
  },
  /** @param {string} folderId */
  delete(folderId) {
    return requireElectronAPI().smartFolders.delete(folderId);
  },
  resetToDefaults() {
    return requireElectronAPI().smartFolders.resetToDefaults();
  },
  /**
   * @param {string} folderName
   * @param {{ timeoutMs?: number }} [options]
   */
  generateDescription(folderName, options = {}) {
    const timeoutMs = options?.timeoutMs;
    return withDescriptionTimeout(
      requireElectronAPI().smartFolders.generateDescription(folderName),
      timeoutMs
    );
  }
};
