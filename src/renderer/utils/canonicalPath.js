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

/**
 * Key for comparing folders: canonical form, Unicode composed (macOS can list
 * a name decomposed while a saved folder holds it composed), no trailing
 * slash. A root is '' ('/') or its drive ('c:'). Null when there is no path.
 *
 * POSIX paths keep their case, so on a case-insensitive Mac volume two
 * spellings of one folder give different keys. Use this for advice shown to
 * the user, never to decide what a file operation does.
 */
export const toFolderKey = (/** @type {any} */ value) => {
  const canonical = toCanonicalPath(value);
  return canonical ? canonical.normalize('NFC').replace(/\/$/, '') : null;
};

/**
 * The toFolderKey of the folder that directly holds `value`, or null when the
 * path has no folder part.
 */
export const toParentFolderKey = (/** @type {any} */ value) => {
  const canonical = toCanonicalPath(value).normalize('NFC');
  const cut = canonical.lastIndexOf('/');
  return cut < 0 ? null : canonical.slice(0, cut);
};
