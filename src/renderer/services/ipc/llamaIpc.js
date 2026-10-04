// @ts-check
import { requireElectronAPI } from './electronApi';

/**
 * LlamaIpc - IPC interface for in-process LLM operations
 *
 * In-process node-llama-cpp based LlamaService.
 * No external server required - all operations are local.
 */
export const llamaIpc = {
  /**
   * Get list of downloaded GGUF models
   */
  getModels() {
    return requireElectronAPI().llama.getModels();
  },

  /**
   * Get current LlamaService configuration
   */
  getConfig() {
    return requireElectronAPI().llama.getConfig();
  },

  /**
   * Update LlamaService configuration
   * @param {Record<string, any>} config
   */
  updateConfig(config) {
    return requireElectronAPI().llama.updateConfig(config);
  },

  /**
   * Test if LlamaService is ready (model loaded)
   */
  testConnection() {
    return requireElectronAPI().llama.testConnection();
  },

  /**
   * Fire-and-forget: warm the text model in the background so the next text
   * inference (e.g. smart-folder AI description) skips the cold-load wait.
   * Best-effort — callers should not await the result.
   */
  warm() {
    return requireElectronAPI().llama.warm();
  },

  /**
   * Download a GGUF model
   * @param {string} modelName
   */
  downloadModel(modelName) {
    return requireElectronAPI().llama.downloadModel(modelName);
  },

  /**
   * Delete a downloaded model
   * @param {string} modelName
   */
  deleteModel(modelName) {
    return requireElectronAPI().llama.deleteModel(modelName);
  },

  /**
   * Get download status for models
   */
  getDownloadStatus() {
    return requireElectronAPI().llama.getDownloadStatus();
  },

  /**
   * Cancel an in-progress model download
   * @param {string} modelName
   */
  cancelDownload(modelName) {
    return requireElectronAPI().llama.cancelDownload(modelName);
  }
};
