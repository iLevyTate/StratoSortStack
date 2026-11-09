// @ts-check
/**
 * Files a user-started analysis (Discover's batch or per-file requests) is
 * working on right now.
 *
 * The smart-folder watcher analyzes files it finds in smart folders on its
 * own. When the user analyzes the same files from Discover at the same time,
 * both ran a full analysis: twice the GPU work, and an "analyzed" notification
 * from each. The watcher now defers a file listed here and checks it again
 * afterwards, when the analysis history already has it.
 *
 * Counts, not a set: two overlapping requests for one file must both finish
 * before the file is free again.
 *
 * @module analysis/userAnalysisInFlight
 */

const { normalizePathForIndex } = require('../../shared/pathSanitization');

/** @type {Map<string, number>} */
const counts = new Map();

/**
 * The registry only steers the watcher; it must never break an analysis, so
 * an unusable normalizer falls back to the path as given.
 * @param {string} filePath
 */
function keyOf(filePath) {
  try {
    return (
      (typeof normalizePathForIndex === 'function' && normalizePathForIndex(filePath)) || filePath
    );
  } catch {
    return filePath;
  }
}

/**
 * Mark files as being analyzed by the user. Returns the release function;
 * calling it more than once is harmless.
 * @param {string | string[]} filePaths
 * @returns {() => void}
 */
function claimUserAnalysis(filePaths) {
  const keys = (Array.isArray(filePaths) ? filePaths : [filePaths])
    .filter((p) => typeof p === 'string' && p)
    .map(keyOf);
  for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) {
      const next = (counts.get(key) || 0) - 1;
      if (next > 0) counts.set(key, next);
      else counts.delete(key);
    }
  };
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isUserAnalysisInFlight(filePath) {
  if (typeof filePath !== 'string' || !filePath) return false;
  return counts.has(keyOf(filePath));
}

/**
 * Wrap one analysis call so its file is marked for the call's duration.
 * @template T
 * @param {string} filePath
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
async function withUserAnalysis(filePath, run) {
  const release = claimUserAnalysis(filePath);
  try {
    return await run();
  } finally {
    release();
  }
}

/** Test seam. */
function _resetUserAnalysisInFlight() {
  counts.clear();
}

module.exports = {
  claimUserAnalysis,
  isUserAnalysisInFlight,
  withUserAnalysis,
  _resetUserAnalysisInFlight
};
