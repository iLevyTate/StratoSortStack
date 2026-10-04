// @ts-check
/**
 * Exclusion rules (Settings → Exclusion rules).
 *
 * Users configure globs that are always skipped regardless of folder
 * position: installer extensions, torrent partials, work-in-progress
 * archives, or personal taste ("never flag *.psd"). The user's list applies
 * to the Downloads watcher, the Smart Folder watchers and the triage sweep
 * (main/services/watcherExclusions.js is the one matcher).
 *
 * The defaults below describe the Downloads folder and apply only to the two
 * consumers that read it, the sweep and the Downloads watcher. Smart Folder
 * watchers apply the user's rules and their own temp-file gates.
 */

const DEFAULT_EXCLUSION_GLOBS = Object.freeze([
  // Installer / disk-image binaries — rarely organized as documents.
  '*.exe',
  '*.msi',
  '*.dmg',
  '*.iso',
  '*.pkg',
  '*.deb',
  '*.rpm',
  // In-progress downloads (Chrome, Firefox, qBittorrent, Safari).
  '*.crdownload',
  '*.part',
  '*.!qB',
  '*.download',
  '*.partial',
  // OS / editor scratch files.
  '*.tmp',
  '*.temp',
  '*.swp',
  '*.lock',
  '*.lck',
  '~$*',
  '.DS_Store',
  'Thumbs.db',
  // Source-control / dep directories (shouldn't appear in Downloads usually,
  // but are easy to hit on ad-hoc scans of other folders).
  'node_modules/**',
  '.git/**'
]);

// Intentionally lazy: downloadsFolderExclusions is loaded per-call rather than
// baked into the settings schema, so existing profiles keep working and the
// settings allowlist stays centralized in one place.
function getDefaultExclusionGlobs() {
  return [...DEFAULT_EXCLUSION_GLOBS];
}

/**
 * Sanitize a user-supplied glob list: trim, drop empties, cap length, dedupe.
 * @param {any} raw
 * @returns {string[]|null}
 */
function sanitizeExclusionGlobs(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > 256) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= 200) break;
  }
  return out;
}

module.exports = {
  DEFAULT_EXCLUSION_GLOBS,
  getDefaultExclusionGlobs,
  sanitizeExclusionGlobs
};
