/**
 * Ambient declaration for the preload bridge exposed via
 * contextBridge.exposeInMainWorld('electronAPI', ...) in
 * src/preload/preload.js.
 *
 * Shape mirrors the preload bridge; members are filled in incrementally.
 * Kept intentionally loose (namespace -> method -> function) so renderer
 * consumers type-check without hand-maintaining the full bridge surface.
 * NOTE: no import/export statements — this file must stay a global ambient
 * declaration so `window.electronAPI` resolves everywhere.
 */
interface Window {
  electronAPI: {
    [namespace: string]: { [method: string]: (...args: any[]) => any };
  };
}
