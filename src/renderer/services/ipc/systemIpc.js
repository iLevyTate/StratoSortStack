// @ts-check
import { requireElectronAPI } from './electronApi';

/** @param {any} result */
function normalizeConfigValueResponse(result) {
  // Expected shape from preload: { success: true, path, value }
  if (
    result &&
    typeof result === 'object' &&
    Object.prototype.hasOwnProperty.call(result, 'success')
  ) {
    if (result.success === false) {
      throw new Error(result.error || 'Failed to read configuration');
    }
    return result.value;
  }
  // Fallback: some implementations might return the raw value directly
  return result;
}

/** @param {any} result */
function isCanceled(result) {
  return result?.canceled === true || result?.cancelled === true;
}

export const systemIpc = {
  async checkForUpdates() {
    const result = await requireElectronAPI().system.checkForUpdates();
    if (result && typeof result === 'object' && result.success === false && !isCanceled(result)) {
      throw new Error(result.error || 'Failed to check for updates');
    }
    return result;
  },
  /** @param {string} path */
  async getConfigValue(path) {
    const result = await requireElectronAPI().system.getConfigValue(path);
    return normalizeConfigValueResponse(result);
  },
  async exportLogs() {
    const result = await requireElectronAPI().system.exportLogs();
    if (result && typeof result === 'object' && result.success === false && !isCanceled(result)) {
      throw new Error(result.error || 'Failed to export logs');
    }
    return result;
  },
  async getDegradedState() {
    const api = requireElectronAPI().system;
    // Guard against older preloads without this method.
    if (typeof api.getDegradedState !== 'function') {
      return { flags: [] };
    }
    const result = await api.getDegradedState();
    if (result && typeof result === 'object' && Array.isArray(result.flags)) {
      return result;
    }
    return { flags: [] };
  },
  /** @param {string} code */
  async dismissDegradedFlag(code) {
    const api = requireElectronAPI().system;
    if (typeof api.dismissDegradedFlag !== 'function') {
      return { success: false };
    }
    return api.dismissDegradedFlag(code);
  },
  /** @returns {Promise<{ entries: any[] }>} */
  async subscribeLiveLog() {
    const api = requireElectronAPI().system;
    if (typeof api.subscribeLiveLog !== 'function') {
      throw new Error('Live activity is unavailable in this build');
    }
    const result = await api.subscribeLiveLog();
    if (result && typeof result === 'object' && result.success === false) {
      // The main handler fails with createErrorResponse ({ error: { code, message } });
      // the preload result validator's fallback uses a plain string `error`.
      const message = typeof result.error === 'string' ? result.error : result.error?.message;
      throw new Error(message || 'Failed to start live activity');
    }
    return { entries: Array.isArray(result?.entries) ? result.entries : [] };
  },
  /** @returns {Promise<void>} */
  async unsubscribeLiveLog() {
    const api = requireElectronAPI().system;
    if (typeof api.unsubscribeLiveLog !== 'function') return;
    await api.unsubscribeLiveLog();
  },
  /**
   * @param {(payload: any) => void} callback
   * @returns {() => void}
   */
  onLiveLogBatch(callback) {
    const api = requireElectronAPI().system;
    if (typeof api.onLiveLogBatch !== 'function') return () => {};
    const off = api.onLiveLogBatch(callback);
    return typeof off === 'function' ? off : () => {};
  },
  async getMetrics() {
    const api = requireElectronAPI().system;
    if (typeof api.getMetrics !== 'function') {
      throw new Error('System metrics are unavailable in this build');
    }
    const result = await api.getMetrics();
    if (result && typeof result === 'object' && result.success === false && !isCanceled(result)) {
      throw new Error(result.error || 'Failed to collect system metrics');
    }
    return result;
  },
  async getRuntimeInfo() {
    const api = requireElectronAPI().system;
    if (typeof api.getRuntimeInfo !== 'function') {
      throw new Error('Runtime info is unavailable in this build');
    }
    const result = await api.getRuntimeInfo();
    if (result && typeof result === 'object' && result.success === false && !isCanceled(result)) {
      throw new Error(result.error || 'Failed to read runtime info');
    }
    return result;
  },
  /** @param {string} kind */
  async openLegalDocument(kind) {
    const api = requireElectronAPI().system;
    if (typeof api.openLegalDocument !== 'function') {
      throw new Error('Legal documents are unavailable in this build');
    }
    const result = await api.openLegalDocument(kind);
    if (result && typeof result === 'object' && result.success === false && !isCanceled(result)) {
      throw new Error(result.error || 'Failed to open legal document');
    }
    return result;
  }
};
