// @ts-check
/**
 * Match main-process `DownloadsTriageService.triagePathKey`. Mirrors the
 * `normalizePathForIndex` rules from `src/shared/pathSanitization.js`
 * (NFC unicode + win32/darwin lowercase + forward-slash separator) so
 * renderer selection Sets and main-process bucket lookups agree across
 * NFC/NFD variants, symlinked paths, and Windows separator differences.
 *
 * Inlined rather than imported so the renderer bundle does not pull in
 * the full pathSanitization module (fs/security/etc).
 */
import path from 'path';
import { isMac, isWindows } from './platform';

export function triagePathKey(/** @type {any} */ filePath) {
  if (typeof filePath !== 'string' || !filePath) return '';
  // Separators FIRST: the bundled `path` is path-browserify (posix flavor),
  // whose normalize() treats backslashes as ordinary name characters — a
  // Windows path converted AFTER normalize kept its `..` segments and
  // duplicate separators, diverging from main's win32 normalize.
  let normalized = filePath.replace(/\\/g, '/');
  try {
    normalized = path.normalize(normalized);
  } catch {
    /* keep as-is */
  }
  try {
    normalized = normalized.normalize('NFC');
  } catch {
    /* defensive: invalid surrogate */
  }
  // navigator-derived platform (utils/platform): `process.platform` is
  // undefined under the bundler's process/browser polyfill, so the old
  // check never case-folded in the real renderer and Windows/macOS keys
  // diverged from main's on case variants.
  if (isWindows || isMac) {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}
