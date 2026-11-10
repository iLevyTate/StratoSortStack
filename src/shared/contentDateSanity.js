// @ts-check

/**
 * Plausibility window for LLM-extracted document content dates.
 *
 * `documentDate` is model output (documents) or OCR-adjacent inference
 * (images): a single hallucinated or misread year — "2103-01-01", an OCR
 * "0201-05-03" — survives `new Date()` parsing and ISO normalization, then
 * permanently pins the timeline's sort order and poisons the knowledge
 * card's oldest/newest range ("201 – 2026 / 1825 years"). Every consumer of
 * the field gates on this window; out-of-range dates fall back to the
 * analyzed-at timestamp (or are simply skipped for range statistics).
 *
 * 1900 predates any plausible personal-document corpus scan; +1 year of
 * future slack admits postdated invoices/contracts without admitting
 * century-scale hallucinations.
 */

const CONTENT_DATE_MIN_YEAR = 1900;
const CONTENT_DATE_FUTURE_SLACK_YEARS = 1;

/**
 * Whether an ISO-leading date string ("YYYY-MM-DD...") carries a plausible
 * content year. Purely lexical on the year — calendar validity is the ISO
 * regex/Date-parse concern of each call site.
 * @param {string|null|undefined} iso
 * @param {Date} [now] - injectable clock for tests
 * @returns {boolean}
 */
function isPlausibleContentDate(iso, now = new Date()) {
  if (typeof iso !== 'string' || iso.length < 4) return false;
  const year = Number(iso.slice(0, 4));
  if (!Number.isInteger(year)) return false;
  return (
    year >= CONTENT_DATE_MIN_YEAR && year <= now.getUTCFullYear() + CONTENT_DATE_FUTURE_SLACK_YEARS
  );
}

const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Strict ISO date-only check (exactly YYYY-MM-DD, no time part). Date-only
 * strings parse as UTC midnight and must be read back with UTC getters to
 * preserve the calendar day; anything else — full timestamps, but also
 * non-ISO strings like "May 5, 2024" that V8 parses as LOCAL time — is a
 * moment in time and belongs to the local calendar. A looser "contains no
 * 'T'" check routed those local-parsed strings through UTC getters,
 * shifting the displayed day east of Greenwich.
 * @param {string|null|undefined} value
 * @returns {boolean}
 */
function isIsoDateOnly(value) {
  return typeof value === 'string' && ISO_DATE_ONLY_RE.test(value);
}

/**
 * Local calendar day (YYYY-MM-DD) for an epoch-ms instant.
 * @param {number} ms
 * @returns {string}
 */
function toLocalCalendarDay(ms) {
  const d = new Date(ms);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The calendar day a written date names (model output such as "2024-05-05"
 * or "May 5, 2024"), as YYYY-MM-DD, or null when it does not parse.
 *
 * A leading YYYY-MM-DD is kept as written, whatever time and offset follow
 * it, and so is a value that is only YYYY or YYYY-MM. Anything else ("May 5,
 * 2024", "2024 May 5") is parsed by V8 as LOCAL time, so its local day is
 * the day written; toISOString moved it back a day east of Greenwich.
 * @param {any} value
 * @returns {string|null}
 */
function toWrittenCalendarDay(value) {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  if (typeof value !== 'string') return toLocalCalendarDay(parsed.getTime());
  const written = value.trim().match(/^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T\s].*)?)?)?$/);
  if (!written) return toLocalCalendarDay(parsed.getTime());
  // Through Date.UTC so "2024-02-31" rolls over the way Date itself reads it.
  const day = new Date(
    Date.UTC(Number(written[1]), Number(written[2] || 1) - 1, Number(written[3] || 1))
  );
  return Number.isNaN(day.getTime()) ? null : day.toISOString().split('T')[0];
}

module.exports = {
  CONTENT_DATE_MIN_YEAR,
  CONTENT_DATE_FUTURE_SLACK_YEARS,
  isPlausibleContentDate,
  isIsoDateOnly,
  toLocalCalendarDay,
  toWrittenCalendarDay
};
