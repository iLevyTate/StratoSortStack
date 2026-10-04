// @ts-check
/**
 * Shared latch so search ghost-cleanup can skip embedding marks while a
 * batch organize is remapping paths (SW-24) — marking an embedding orphaned
 * mid-move would hide it from search results until the post-move re-upsert
 * of the same id clears the flag.
 */

let deferrals = 0;

function deferGhostCleanup() {
  deferrals += 1;
}

function resumeGhostCleanup() {
  deferrals = Math.max(0, deferrals - 1);
}

function isGhostCleanupDeferred() {
  return deferrals > 0;
}

/**
 * Hold the latch for the duration of `fn` (moves + path remap), releasing it
 * on both settle paths.
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withGhostCleanupDeferred(fn) {
  deferGhostCleanup();
  try {
    return await fn();
  } finally {
    resumeGhostCleanup();
  }
}

module.exports = {
  deferGhostCleanup,
  resumeGhostCleanup,
  isGhostCleanupDeferred,
  withGhostCleanupDeferred
};
