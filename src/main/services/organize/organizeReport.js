// @ts-check

/**
 * Turns an organize run's per-file rows (renderer utils/organizeRunResults)
 * into the CSV the user saves from the Complete screen or the "Last organize
 * run" list. Pure: no I/O.
 *
 * The file starts with a UTF-8 byte order mark so Excel shows names such as
 * "Rechnung Maerz.xlsx" with an umlaut correctly, and lines end in CRLF
 * (RFC 4180).
 */

const { csvCell } = require('../../../shared/csvUtils');

const HEADER = ['File', 'Outcome', 'Details', 'Original location', 'Final location'];

/** @type {Record<string, string>} */
const OUTCOME_WORDS = {
  moved: 'Moved',
  duplicate: 'Duplicate removed',
  failed: 'Failed',
  notMoved: 'Not moved',
  restored: 'Returned',
  leftAtDestination: 'Not returned'
};

const RENAMED_NOTE = 'Renamed: a file with this name was already there.';
const DUPLICATE_NOTE = 'An identical copy was already there.';

/**
 * @typedef {object} OrganizeReportRow
 * @property {string} name
 * @property {string} originalPath
 * @property {string | null} [finalPath]
 * @property {string} outcome
 * @property {string} [reason]
 * @property {boolean} [renamedOnCollision]
 */

/**
 * @param {OrganizeReportRow} row
 * @returns {string}
 */
function detailsFor(row) {
  const reason = typeof row.reason === 'string' ? row.reason.trim() : '';
  if (row.outcome === 'moved') return row.renamedOnCollision ? RENAMED_NOTE : '';
  if (row.outcome === 'duplicate') return reason ? `${DUPLICATE_NOTE} ${reason}` : DUPLICATE_NOTE;
  return reason;
}

/**
 * @param {OrganizeReportRow[]} rows
 * @returns {string} the CSV document: BOM, header, one line per row, trailing CRLF
 */
function toOrganizeReportCsv(rows) {
  const lines = [HEADER.join(',')];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    lines.push(
      [
        row.name,
        OUTCOME_WORDS[row.outcome] || row.outcome,
        detailsFor(row),
        row.originalPath,
        row.finalPath || ''
      ]
        .map((value) => csvCell(value))
        .join(',')
    );
  }
  return `\ufeff${lines.join('\r\n')}\r\n`;
}

module.exports = { toOrganizeReportCsv, OUTCOME_WORDS };
