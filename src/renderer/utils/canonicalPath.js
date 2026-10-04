// @ts-check
/**
 * Canonical path key for cross-source merges and map lookups.
 *
 * Windows-style paths are case-insensitive and may arrive with mixed
 * separators from different IPC sources (dialog picker, drag-drop, watcher
 * events, persisted state), so raw string equality misses matches for the
 * same file. Canonical form: forward slashes, lowercased when the path is
 * Windows-style.
 *
 * Single source of truth — keep every renderer-side path-keyed map/set
 * (writes AND reads) on this helper so lookups can't miss on key style.
 */

export const isWindowsStylePath = (/** @type {any} */ value) =>
  typeof value === 'string' && (value.includes('\\') || /^[A-Za-z]:[\\/]/.test(value));

export const toCanonicalPath = (/** @type {any} */ value) => {
  if (typeof value !== 'string' || value.length === 0) return '';
  const normalized = value.replace(/[\\/]+/g, '/');
  return isWindowsStylePath(value) ? normalized.toLowerCase() : normalized;
};
