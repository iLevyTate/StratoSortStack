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
  }
};
