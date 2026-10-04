// @ts-check

/**
 * Pure helpers that turn a triage session's buckets into a flat report
 * and serialize it as RFC 4180 CSV. No I/O.
 */

const { csvCell } = require('../../../shared/csvUtils');

const BUCKET_ORDER = ['keep', 'trash', 'excluded', 'ambiguous', 'review', 'unmatched'];

const CSV_HEADER = [
  'fileName',
  'filePath',
  'bucket',
  'confidence',
  'signal',
  'why',
  'sizeBytes',
  'modifiedIso',
  'suggestedFolderPath'
];

/**
 * @param {Record<string, any[]>|null|undefined} buckets
 * @returns {Array<Record<string, string|number>>}
 */
function buildReportRows(buckets) {
  if (!buckets || typeof buckets !== 'object') return [];
  /** @type {Array<Record<string, string|number>>} */
  const rows = [];
  for (const bucket of BUCKET_ORDER) {
    const records = Array.isArray(buckets[bucket]) ? buckets[bucket] : [];
    for (const rec of records) {
      if (!rec || typeof rec !== 'object') continue;
      rows.push({
        fileName: typeof rec.fileName === 'string' ? rec.fileName : '',
        filePath: typeof rec.filePath === 'string' ? rec.filePath : '',
        bucket: typeof rec.bucket === 'string' ? rec.bucket : bucket,
        confidence: Number.isFinite(rec.confidence) ? rec.confidence : '',
        signal: typeof rec.signal === 'string' ? rec.signal : '',
        why: typeof rec.why === 'string' ? rec.why : '',
        sizeBytes: Number.isFinite(rec.size) ? rec.size : '',
        modifiedIso: Number.isFinite(rec.mtimeMs) ? new Date(rec.mtimeMs).toISOString() : '',
        suggestedFolderPath:
          typeof rec.suggestedFolder?.path === 'string' ? rec.suggestedFolder.path : ''
      });
    }
  }
  return rows;
}

/**
 * @param {Array<Record<string, string|number>>} rows
 * @returns {string} CSV document (header + rows, trailing newline)
 */
function toTriageCsv(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const lines = [CSV_HEADER.join(',')];
  for (const row of safeRows) {
    lines.push(CSV_HEADER.map((key) => csvCell(row?.[key] ?? '')).join(','));
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { buildReportRows, toTriageCsv, CSV_HEADER };
