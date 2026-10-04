// @ts-check
import { requireElectronAPI } from './electronApi';

export const eventsIpc = {
  /**
   * @param {(...args: any[]) => void} callback
   * @returns {() => void} unsubscribe function
   */
  onOperationProgress(callback) {
    return requireElectronAPI().events.onOperationProgress(callback);
  }
};
