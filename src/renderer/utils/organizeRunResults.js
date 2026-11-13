// @ts-check
/**
 * The per-file record of an organize run: one row for every file the run was
 * asked to move, saying where that file is now and, when it did not move, why.
 * The Complete screen, the Organize screen's "Last organize run" list and the
 * CSV export all read this one shape, so they cannot tell different stories.
 */

import { toCanonicalPath } from './canonicalPath';
import { describeDuplicateRemoval } from './duplicateRemoval';
import { mapErrorToNotification } from './errorMapping';

/**
 * - moved: the file is at `finalPath`
 * - duplicate: not moved; an identical copy was already at `finalPath`, so
 *   this copy was removed
 * - failed: the move was refused or went wrong; the file is still at
 *   `originalPath`
 * - notMoved: the run ended, or was stopped, before this file; or the run's
 *   result never came back, so whether this file moved is not known
 * - restored: moved, then returned when main rolled the run back
 * - leftAtDestination: moved, and the rollback could not return it
 * @typedef {'moved' | 'duplicate' | 'failed' | 'notMoved' | 'restored' | 'leftAtDestination'} RunOutcome
 */

/**
 * @typedef {object} RunResultRow
 * @property {string} name - the file's name before the run
 * @property {string} originalPath
 * @property {string} [plannedPath] - where the run meant to put it
 * @property {string | null} finalPath - where it is now, when that is not
 *   `originalPath`; the kept copy for a duplicate
 * @property {RunOutcome} outcome
 * @property {string} reason - why it did not move, in plain words; '' for a
 *   moved file
 * @property {boolean} [renamedOnCollision] - the planned name was taken, so
 *   the file got a numbered one
 */

/** @type {readonly RunOutcome[]} */
export const RUN_OUTCOMES = Object.freeze([
  'moved',
  'duplicate',
  'failed',
  'notMoved',
  'restored',
  'leftAtDestination'
]);

/**
 * The most rows a run keeps. The renderer collects at most this many result
 * rows from main, and the preload refuses longer arrays.
 */
export const MAX_RUN_RESULT_ROWS = 10000;

/** Outcomes whose file is at `finalPath`. */
const AT_FINAL_PATH = new Set(['moved', 'duplicate', 'leftAtDestination']);
/** Outcomes whose file did not move and is still at `originalPath`. */
const STAYED_PUT = new Set(['failed', 'notMoved', 'restored']);

/**
 * True for a row main reports as done without a move: the destination already
 * held the same content, so the source was removed instead.
 * @param {any} row
 * @returns {boolean}
 */
export function isDuplicateSkip(row) {
  return Boolean(row && row.success && row.skipped && row.reason === 'duplicate');
}

/**
 * Last segment of a path ("C:\Docs\a.pdf" -> "a.pdf").
 * @param {any} p
 * @returns {string}
 */
function baseName(p) {
  if (typeof p !== 'string' || !p) return '';
  const trimmed = p.replace(/[\\/]+$/, '');
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
}

/**
 * The folder part of a path, in its own spelling, or '' when it has none.
 * @param {any} p
 * @returns {string}
 */
export function parentFolder(p) {
  if (typeof p !== 'string' || !p) return '';
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return cut > 0 ? p.slice(0, cut) : '';
}

/**
 * @param {string} sourceRemoval
 * @returns {string}
 */
function duplicateReason(sourceRemoval) {
  return describeDuplicateRemoval({
    duplicateRemoval: sourceRemoval === 'trashed' ? 'trashed' : 'deleted'
  });
}

const OUTCOME_UNKNOWN_REASON =
  'The run stopped with an error before this file was confirmed. It may have moved: check its destination folder.';

/**
 * The row for one result main returned. First match wins: a rollback outcome
 * overrides the move it undid.
 * @param {any} op - the operation the renderer sent, or null
 * @param {any} r - main's result row, or null when main sent none for it
 * @param {string} [batchError] - the error that ended the batch early
 * @param {boolean} [outcomeUnknown] - the run's result never came back, so a
 *   file without a row may have moved
 * @returns {RunResultRow}
 */
function toRow(op, r, batchError, outcomeUnknown) {
  const originalPath = String(op?.source || r?.source || '');
  const plannedPath = typeof op?.destination === 'string' ? op.destination : undefined;
  const landedAt = String(r?.destination || plannedPath || '') || null;
  /** @type {RunResultRow} */
  const row = {
    name: baseName(originalPath),
    originalPath,
    plannedPath,
    finalPath: null,
    outcome: 'notMoved',
    reason: ''
  };
  if (!r) {
    row.reason = outcomeUnknown
      ? OUTCOME_UNKNOWN_REASON
      : batchError
        ? mapErrorToNotification({ error: batchError }).message
        : 'The run ended before this file.';
  } else if (r.rollbackFailed) {
    row.outcome = 'leftAtDestination';
    row.finalPath = landedAt;
    row.reason =
      'Could not be returned when the run was undone. It is still in the destination folder.';
  } else if (r.rolledBack) {
    row.outcome = 'restored';
    row.reason = 'Returned to its original folder when the run was undone.';
  } else if (isDuplicateSkip(r)) {
    row.outcome = 'duplicate';
    row.finalPath = landedAt;
    row.reason = duplicateReason(r.sourceRemoval);
  } else if (r.success) {
    row.outcome = 'moved';
    row.finalPath = landedAt;
  } else if (r.notAttempted) {
    row.reason = 'The run stopped before this file.';
  } else if (r.cancelled) {
    row.reason = 'You stopped the run before this file.';
  } else if (r.interrupted) {
    row.reason = 'The run was interrupted. It moves the next time StratoSort starts.';
  } else {
    row.outcome = 'failed';
    row.reason = mapErrorToNotification({ error: r.error, errorCode: r.errorCode }).message;
  }
  if (row.outcome === 'moved') {
    row.renamedOnCollision =
      Boolean(plannedPath && row.finalPath) &&
      baseName(plannedPath).normalize('NFC') !== baseName(row.finalPath).normalize('NFC');
  }
  return row;
}

/**
 * One row per operation of a run, in the order the user's files were sent,
 * each matched to main's result by its source path. Main finishes files
 * concurrently and rewrites each source to its validated form, so results
 * are matched by canonical path, not by position. A result that matches no
 * operation is still reported, after the others. With `outcomeUnknown` (the
 * batch call itself failed, and main may still be moving files) a file
 * without a row is not said to have stayed put.
 * @param {{ operations: any[], rows: any[], batchError?: string, outcomeUnknown?: boolean }} run
 * @returns {RunResultRow[]}
 */
export function buildRunResultRows({ operations, rows, batchError, outcomeUnknown }) {
  /** @type {Map<string, any[]>} */
  const bySource = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') continue;
    const key = toCanonicalPath(r.source);
    const queue = bySource.get(key);
    if (queue) queue.push(r);
    else bySource.set(key, [r]);
  }
  /** @type {RunResultRow[]} */
  const out = [];
  for (const op of Array.isArray(operations) ? operations : []) {
    if (!op || typeof op !== 'object') continue;
    const r = bySource.get(toCanonicalPath(op.source))?.shift() || null;
    out.push(toRow(op, r, batchError, outcomeUnknown));
  }
  for (const leftover of bySource.values()) {
    for (const r of leftover) out.push(toRow(null, r, batchError, outcomeUnknown));
  }
  return out.slice(0, MAX_RUN_RESULT_ROWS);
}

/**
 * The row for an organized-history entry (`files.organizedFiles`), which only
 * holds files that were moved or removed as duplicates.
 * @param {any} entry
 * @returns {RunResultRow}
 */
export function organizedEntryToRow(entry) {
  const safe = entry && typeof entry === 'object' ? entry : {};
  const duplicate = Boolean(safe.duplicateRemoval);
  const originalPath = typeof safe.originalPath === 'string' ? safe.originalPath : '';
  const finalPath = typeof safe.path === 'string' && safe.path ? safe.path : null;
  return {
    name: safe.originalName || baseName(originalPath) || safe.newName || baseName(finalPath),
    originalPath,
    finalPath,
    outcome: duplicate ? 'duplicate' : 'moved',
    reason: duplicate ? describeDuplicateRemoval(safe) : ''
  };
}

/**
 * How many files moved, how many were removed as duplicates, and how many
 * stayed where they were (failed, not reached, or returned by a rollback).
 * A file a rollback could not return is counted as moved: it is at its
 * destination.
 * @param {RunResultRow[]} rows
 * @returns {{ moved: number, duplicates: number, notMoved: number }}
 */
export function countRunOutcomes(rows) {
  const counts = { moved: 0, duplicates: 0, notMoved: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    if (row.outcome === 'duplicate') counts.duplicates += 1;
    else if (AT_FINAL_PATH.has(row.outcome)) counts.moved += 1;
    else if (STAYED_PUT.has(row.outcome)) counts.notMoved += 1;
  }
  return counts;
}

/**
 * The folders files went to, with how many were moved there and how many
 * duplicates already had their copy there. Busiest folder first. One folder
 * spelled two ways on Windows is one entry, shown as first seen.
 * @param {RunResultRow[]} rows
 * @returns {Array<{ folder: string, moved: number, duplicates: number }>}
 */
export function destinationTotals(rows) {
  /** @type {Map<string, { folder: string, moved: number, duplicates: number }>} */
  const totals = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !AT_FINAL_PATH.has(row.outcome)) continue;
    const folder = parentFolder(row.finalPath);
    if (!folder) continue;
    const key = toCanonicalPath(folder);
    let entry = totals.get(key);
    if (!entry) {
      entry = { folder, moved: 0, duplicates: 0 };
      totals.set(key, entry);
    }
    if (row.outcome === 'duplicate') entry.duplicates += 1;
    else entry.moved += 1;
  }
  return Array.from(totals.values()).sort(
    (a, b) => b.moved - a.moved || b.duplicates - a.duplicates || a.folder.localeCompare(b.folder)
  );
}

/**
 * The path to show in the file manager for a row: where the file is now.
 * @param {RunResultRow} row
 * @returns {string}
 */
export function revealPathFor(row) {
  if (!row) return '';
  if (AT_FINAL_PATH.has(row.outcome) && row.finalPath) return row.finalPath;
  return row.originalPath;
}

/**
 * Rows in their stored shape: anything that is not a run result is dropped
 * (a damaged persisted value), and the list is capped at `max`.
 * @param {any} value
 * @param {number} [max]
 * @returns {RunResultRow[]}
 */
export function normalizeRunResultRows(value, max = MAX_RUN_RESULT_ROWS) {
  if (!Array.isArray(value)) return [];
  /** @type {RunResultRow[]} */
  const out = [];
  for (const row of value) {
    if (out.length >= max) break;
    if (!row || typeof row !== 'object') continue;
    if (!RUN_OUTCOMES.includes(row.outcome)) continue;
    if (typeof row.originalPath !== 'string') continue;
    /** @type {RunResultRow} */
    const clean = {
      name: typeof row.name === 'string' ? row.name : baseName(row.originalPath),
      originalPath: row.originalPath,
      finalPath: typeof row.finalPath === 'string' && row.finalPath ? row.finalPath : null,
      outcome: row.outcome,
      reason: typeof row.reason === 'string' ? row.reason : ''
    };
    if (typeof row.plannedPath === 'string') clean.plannedPath = row.plannedPath;
    if (row.renamedOnCollision === true) clean.renamedOnCollision = true;
    out.push(clean);
  }
  return out;
}

const STILL_LISTED = ' Files that were not moved are still listed.';
const NO_LONGER_LISTED =
  ' The files that were not moved are no longer in the queue. They are still in their original folders.';

/**
 * The run summary to show beside the queue. A run that left files unmoved
 * says they "are still listed"; once none of them is in the queue (the user
 * removed them, or started over) that sentence says where they are instead.
 * @template {{ outcome: string, detail: string } | null} T
 * @param {T} summary
 * @param {RunResultRow[]} rows - the run's rows
 * @param {Iterable<string>} queuePaths - paths of the files in the queue
 * @returns {T}
 */
export function withQueueNote(summary, rows, queuePaths) {
  if (!summary || (summary.outcome !== 'partial' && summary.outcome !== 'none')) return summary;
  if (typeof summary.detail !== 'string' || !summary.detail.includes(STILL_LISTED.trim())) {
    return summary;
  }
  const unmoved = (Array.isArray(rows) ? rows : []).filter(
    (row) => row && (row.outcome === 'failed' || row.outcome === 'notMoved')
  );
  if (unmoved.length === 0) return summary;
  const queued = new Set();
  for (const p of queuePaths || []) queued.add(toCanonicalPath(p));
  if (unmoved.some((row) => queued.has(toCanonicalPath(row.originalPath)))) return summary;
  return {
    ...summary,
    detail: summary.detail.includes(STILL_LISTED)
      ? summary.detail.replace(STILL_LISTED, NO_LONGER_LISTED)
      : summary.detail.replace(STILL_LISTED.trim(), NO_LONGER_LISTED.trim())
  };
}
