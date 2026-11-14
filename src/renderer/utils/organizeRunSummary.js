// @ts-check
/**
 * How the last organize run ended (`files.lastOrganizeRun`). useOrganization
 * writes it when a run finishes; the Organize screen and the Dashboard show it.
 */

/**
 * `count` is the number of files moved; a duplicate that was removed instead
 * is not one of them. For a rolled-back run it is the number of files the
 * rollback could not return, which are still at their destinations.
 * @typedef {object} OrganizeRunSummary
 * @property {'moved' | 'partial' | 'none' | 'rolledBack'} outcome
 * @property {number} count
 * @property {number} [notMovedCount] - files the run did not move: failed,
 *   not reached, stopped, or returned by a rollback. Duplicates removed
 *   instead of moved are not among them.
 * @property {string} headline
 * @property {string} detail
 * @property {number | null} finishedAt - epoch ms; null when it is not known
 * @property {boolean} [resumesAtLaunch] - the run was interrupted and main
 *   finishes its remaining moves the next time the app starts
 */

const OUTCOMES = ['moved', 'partial', 'none', 'rolledBack'];

/**
 * How long the summary of a run that moved everything stays on screen. A run
 * that left files unmoved keeps its summary until it is dismissed or the next
 * run starts.
 */
export const CLEAN_RUN_SUMMARY_MS = 12000;

/**
 * The summary in its stored shape, or null for anything that is not one
 * (a cleared summary, or a persisted value that was damaged).
 * @param {any} value
 * @returns {OrganizeRunSummary | null}
 */
export function normalizeOrganizeRunSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!OUTCOMES.includes(value.outcome)) return null;
  if (typeof value.headline !== 'string' || value.headline.length === 0) return null;
  // Stored only when there is one: a summary without it means none.
  const notMovedCount =
    Number.isInteger(value.notMovedCount) && value.notMovedCount > 0 ? value.notMovedCount : 0;
  return {
    outcome: value.outcome,
    count: Number.isInteger(value.count) && value.count >= 0 ? value.count : 0,
    ...(notMovedCount > 0 ? { notMovedCount } : {}),
    headline: value.headline,
    detail: typeof value.detail === 'string' ? value.detail : '',
    finishedAt: Number.isFinite(value.finishedAt) ? value.finishedAt : null,
    resumesAtLaunch: value.resumesAtLaunch === true
  };
}

/**
 * True when the run left files where they were: some failed, the run stopped
 * early, or it was rolled back.
 * @param {any} summary
 * @returns {boolean}
 */
export function leftFilesUnmoved(summary) {
  return Boolean(summary) && summary.outcome !== 'moved';
}

/**
 * The summary to keep for the next launch, or null. Only a run that left files
 * unmoved is kept, and not an interrupted one: main finishes that at launch,
 * so by then its summary is out of date.
 * @template {OrganizeRunSummary | null} T
 * @param {T} summary
 * @returns {T | null}
 */
export function summaryForNextLaunch(summary) {
  return leftFilesUnmoved(summary) && summary?.resumesAtLaunch !== true ? summary : null;
}

/**
 * Milliseconds the summary still has on screen at `now`: Infinity for a run
 * that left files unmoved, 0 once a clean run's time is up or when its finish
 * time is not known.
 * @param {OrganizeRunSummary | null} summary
 * @param {number} now - epoch ms
 * @returns {number}
 */
export function summaryTimeLeft(summary, now) {
  if (!summary) return 0;
  if (leftFilesUnmoved(summary)) return Infinity;
  if (summary.finishedAt === null) return 0;
  return Math.max(0, summary.finishedAt + CLEAN_RUN_SUMMARY_MS - now);
}
