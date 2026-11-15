// @ts-check
/**
 * The names a move gives a file whose name is taken. Shared by the batch
 * handler's move and dry-run preview and by the resume of an interrupted
 * batch, so all three number a file the same way.
 */
const path = require('path');

/**
 * Format the Nth collision-suffixed candidate for a destination path.
 *
 * IMPORTANT: This is the single source of truth for the suffix shape so
 * the dry-run preview and the real move path stay byte-identical. They
 * had drifted post-2.0.9: the executor used `${base}_${N}${ext}` while
 * the preview used `${base} (${N})${ext}`, so the Preview button
 * displayed a destination that did not match what the move would produce.
 *
 * @param {string} originalDestination - The originally requested destination.
 * @param {number} counter - 1-based collision counter.
 * @returns {string} Suffixed candidate path.
 */
function formatNumberedCollisionCandidate(originalDestination, counter) {
  const ext = path.extname(originalDestination);
  // When ext is empty, -ext.length is -0 which equals 0, causing slice(0,0)
  // to return empty string — guard explicitly for the no-extension case.
  const baseName = ext.length > 0 ? originalDestination.slice(0, -ext.length) : originalDestination;
  return `${baseName}_${counter}${ext}`;
}

/**
 * The name a taken destination is numbered from. Organize numbers two files
 * of one batch headed for the same name apart before it sends them
 * (report.pdf, report_1.pdf) and marks the numbered one `renumbered`. When
 * report_1.pdf is then taken on disk, counting goes on from report
 * (report_2.pdf) instead of numbering the number (report_1_1.pdf). Derived
 * from the destination itself, so it is always in the same folder.
 * @param {string} destination
 * @param {boolean} [renumbered]
 * @returns {string}
 */
function numberingBaseOf(destination, renumbered) {
  if (renumbered !== true || typeof destination !== 'string') return destination;
  const ext = path.extname(destination);
  const stem = ext.length > 0 ? destination.slice(0, -ext.length) : destination;
  const number = stem.match(/_[1-9]\d*$/);
  if (!number || number.index === undefined) return destination;
  const baseStem = stem.slice(0, number.index);
  // A name that was only the number (`_1.pdf`) has nothing to count from.
  if (!baseStem || /[\\/]$/.test(baseStem)) return destination;
  return `${baseStem}${ext}`;
}

module.exports = { formatNumberedCollisionCandidate, numberingBaseOf };
