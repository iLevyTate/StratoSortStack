// @ts-check
import { requireElectronAPI } from './electronApi';

export const filesIpc = {
  /** @param {{ purpose?: 'source'|'destination' }} [options] */
  selectDirectory(options) {
    return requireElectronAPI().files.selectDirectory(options);
  },
  getDocumentsPath() {
    return requireElectronAPI().files.getDocumentsPath();
  },
  /** @param {string} fullPath */
  createFolder(fullPath) {
    return requireElectronAPI().files.createFolder(fullPath);
  },
  /** @param {string} folderPath */
  openFolder(folderPath) {
    return requireElectronAPI().files.openFolder(folderPath);
  },
  /**
   * Save an organize run's per-file rows as CSV through a save dialog.
   * Resolves `{ success, filePath, rowCount }`, `{ success: false, canceled: true }`
   * or `{ success: false, error }`.
   * @param {import('../../utils/organizeRunResults').RunResultRow[]} rows
   */
  exportOrganizeReport(rows) {
    return requireElectronAPI().files.exportOrganizeReport({ rows });
  }
};
