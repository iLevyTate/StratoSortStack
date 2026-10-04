// @ts-check
import { requireElectronAPI } from './electronApi';

/**
 * @param {string} methodName
 * @param {...any} args
 */
function callSettings(methodName, ...args) {
  const settingsApi = requireElectronAPI()?.settings;
  if (!settingsApi || typeof settingsApi[methodName] !== 'function') {
    throw new Error(`Settings API method unavailable: ${methodName}`);
  }
  return settingsApi[methodName](...args);
}

export const settingsIpc = {
  get() {
    return callSettings('get');
  },
  /** @param {Record<string, any>} settings */
  save(settings) {
    return callSettings('save', settings);
  },
  getConfigurableLimits() {
    return callSettings('getConfigurableLimits');
  },
  getLogsInfo() {
    return callSettings('getLogsInfo');
  },
  openLogsFolder() {
    return callSettings('openLogsFolder');
  },
  /** @param {string} exportPath */
  export(exportPath) {
    return callSettings('export', exportPath);
  },
  /** @param {string} importPath */
  import(importPath) {
    return callSettings('import', importPath);
  },
  createBackup() {
    return callSettings('createBackup');
  },
  listBackups() {
    return callSettings('listBackups');
  },
  /** @param {string} backupPath */
  restoreBackup(backupPath) {
    return callSettings('restoreBackup', backupPath);
  },
  /** @param {string} backupPath */
  deleteBackup(backupPath) {
    return callSettings('deleteBackup', backupPath);
  }
};
