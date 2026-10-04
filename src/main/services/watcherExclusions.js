// @ts-check
/**
 * Exclusion rules shared by the live watchers and the triage sweep.
 *
 * Settings → Exclusion rules stores glob patterns under
 * `downloadsTriageExclusions`. Until this helper existed only the on-demand
 * Downloads triage sweep honored them; the Downloads watcher and the Smart
 * Folder watchers kept analyzing (and, in the fallback path, renaming) files
 * the user had asked to leave alone. All three consumers now match through
 * `findMatchingExclusion`, so one rule reads the same everywhere.
 *
 * Matching: minimatch with `matchBase` so a bare `*.psd` matches the
 * basename anywhere, `nocase` for Windows and macOS users, and `dot` so
 * `.env*` style rules work. A pattern that contains a slash is also tried
 * against the forward-slashed absolute path. A relative one such as
 * `archived/**` names a folder at any depth BENEATH the root the caller
 * works under (the watched Smart Folder, the Downloads folder, the folder
 * the sweep scans), the way the sweep's directory scanner reads it: it is
 * matched as `**\/archived/**` against the path relative to that root, so a
 * root that itself sits under an `archived` folder is not excluded whole.
 * A caller that passes no root cannot tell the two apart, and the rule is
 * left inert rather than guessed.
 */

const { minimatch } = require('minimatch');
const {
  sanitizeExclusionGlobs,
  getDefaultExclusionGlobs
} = require('../../shared/config/exclusionRulesSchema');

const MATCH_OPTIONS = Object.freeze({ matchBase: true, nocase: true, dot: true });

/**
 * Read the exclusion globs from a settings snapshot. Never throws. The
 * built-in defaults (installers, partial downloads, OS scratch files) are
 * added only when asked for: they describe the Downloads folder, so the
 * Downloads watcher and the triage sweep apply them, while Smart Folder
 * watchers apply the user's own rules on top of their temp-file gates (a
 * Smart Folder may well be the place a user keeps installers).
 * @param {any} settings
 * @param {{ includeDefaults?: boolean }} [options]
 * @returns {string[]}
 */
function readExclusionGlobs(settings, { includeDefaults = false } = {}) {
  const user = sanitizeExclusionGlobs(settings?.downloadsTriageExclusions) || [];
  if (!includeDefaults) return user;
  return Array.from(new Set([...getDefaultExclusionGlobs(), ...user]));
}

/**
 * A slash pattern that names a folder relative to "anywhere": not anchored
 * to the root (`/srv/**`), not already prefixed (`**\/x/**`) and not a
 * Windows drive path (`C:/Users/**`).
 * @param {string} pattern
 */
function isRelativeFolderGlob(pattern) {
  return !pattern.startsWith('/') && !pattern.startsWith('**') && !/^[A-Za-z]:\//.test(pattern);
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function toPosix(filePath) {
  return String(filePath).replace(/\\/g, '/');
}

/**
 * `fullPath` relative to `root`, both already forward-slashed, or null when
 * the file does not lie beneath the root. Case-insensitive like the match
 * itself: the root and the file path come from the same caller, so a case
 * difference is spelling, not a different directory.
 * @param {string} fullPath
 * @param {string} root
 * @returns {string|null}
 */
function relativeToRoot(fullPath, root) {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  if (fullPath.length <= prefix.length) return null;
  if (fullPath.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return null;
  return fullPath.slice(prefix.length);
}

/**
 * First glob that excludes `filePath`, or null when none does.
 * @param {string} filePath
 * @param {string[]} globs
 * @param {{ root?: string|null }} [options]  the folder the caller watches or
 *   scans; relative folder globs (`archived/**`) are read beneath it only
 * @returns {string|null}
 */
function findMatchingExclusion(filePath, globs, { root = null } = {}) {
  if (!filePath || !Array.isArray(globs) || globs.length === 0) return null;
  const fullPath = toPosix(filePath);
  // Basename from the forward-slashed form so a Windows path matched on any
  // host (tests, exported settings) still yields `setup-1.exe`, not the
  // whole string with backslashes minimatch would read as escapes.
  const fileName = fullPath.slice(fullPath.lastIndexOf('/') + 1);
  const rootPath = typeof root === 'string' && root ? toPosix(root) : null;
  const relativePath = rootPath ? relativeToRoot(fullPath, rootPath) : null;
  for (const pattern of globs) {
    if (typeof pattern !== 'string' || !pattern) continue;
    try {
      if (minimatch(fileName, pattern, MATCH_OPTIONS)) return pattern;
      if (pattern.includes('/')) {
        if (minimatch(fullPath, pattern, MATCH_OPTIONS)) return pattern;
        if (
          relativePath &&
          isRelativeFolderGlob(pattern) &&
          minimatch(relativePath, `**/${pattern}`, MATCH_OPTIONS)
        ) {
          return pattern;
        }
      }
    } catch {
      // A malformed glob is the user's typo, not a reason to stop watching.
    }
  }
  return null;
}

/**
 * Convenience for the watchers: globs from settings, then match.
 * @param {string} filePath
 * @param {any} settings
 * @param {{ includeDefaults?: boolean, root?: string|null }} [options]
 * @returns {string|null}
 */
function findUserExclusion(filePath, settings, options = {}) {
  return findMatchingExclusion(filePath, readExclusionGlobs(settings, options), {
    root: options.root
  });
}

module.exports = {
  MATCH_OPTIONS,
  readExclusionGlobs,
  findMatchingExclusion,
  findUserExclusion
};
