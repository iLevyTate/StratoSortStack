// @ts-check
/**
 * Central access point for `window.electronAPI`.
 * Keeps feature-detection and errors consistent across the renderer.
 * @returns {Window['electronAPI'] | null}
 */
export function getElectronAPI() {
  if (typeof window === 'undefined') return null;
  return window.electronAPI || null;
}

/** @returns {Window['electronAPI']} */
export function requireElectronAPI() {
  const api = getElectronAPI();
  if (!api) {
    throw new Error('Electron API not available. Please restart the application.');
  }
  return api;
}
