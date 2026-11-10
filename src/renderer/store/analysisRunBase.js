// @ts-check
/**
 * What a Discover run had finished before the batch it has in main now.
 *
 * A run that waited for an earlier batch sends main only the files that batch
 * did not finish, and main counts within what it was sent: 1 of 3, for a run
 * of 7 with 4 already done. Those counts go from main to the store through
 * ipcMiddleware, which knows nothing of the run; the run registers its offset
 * here for as long as its batch is in main.
 */

/** @type {{ batchId: string, done: number, total: number } | null} */
let runBase = null;

/**
 * @param {{ batchId: string, done: number, total: number }} base The batch's
 *   id, the files of the run finished before it, and the files in the run.
 */
export function setAnalysisRunBase(base) {
  runBase = { batchId: base.batchId, done: base.done, total: base.total };
}

/**
 * Clears the offset of this batch. A later batch's offset is left alone.
 *
 * @param {string} batchId
 */
export function clearAnalysisRunBase(batchId) {
  if (runBase?.batchId === batchId) runBase = null;
}

/**
 * A batch's own counts as counts of the run it belongs to.
 *
 * @param {any} batchId The id the progress was reported under.
 * @param {number} current
 * @returns {{ current: number, total: number } | null} null for a batch with
 *   no registered offset: its counts are the run's.
 */
export function toRunCounts(batchId, current) {
  if (!runBase || batchId !== runBase.batchId) return null;
  return { current: Math.min(runBase.done + current, runBase.total), total: runBase.total };
}
