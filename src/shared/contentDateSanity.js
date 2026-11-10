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

// A year is exactly four digits: "20255-01-01" is the year 20255, not 2025.
const LEADING_YEAR_RE = /^(\d{4})(?!\d)/;

/**
 * Whether an ISO-leading date string ("YYYY-MM-DD...") carries a plausible
 * content year. Purely lexical on the year — calendar validity is the ISO
 * regex/Date-parse concern of each call site.
 * @param {string|null|undefined} iso
 * @param {Date} [now] - injectable clock for tests
 * @returns {boolean}
 */
function isPlausibleContentDate(iso, now = new Date()) {
  if (typeof iso !== 'string') return false;
  const leading = iso.match(LEADING_YEAR_RE);
  if (!leading) return false;
  const year = Number(leading[1]);
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
 * Epoch ms of a stored date, for the local calendar: the local date
 * formatters, and comparison with file times. A date-only value names a
 * calendar day and is read as local midnight of that day. Date.parse reads
 * it as UTC midnight, which is the evening before west of Greenwich, so a
 * document dated "2024-05-05" was shown as May 4.
 * @param {any} value
 * @returns {number|null}
 */
function toLocalCalendarMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  const dayOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dayOnly) {
    const year = Number(dayOnly[1]);
    const local = new Date(year, Number(dayOnly[2]) - 1, Number(dayOnly[3]));
    // The constructor reads the years 0-99 as 1900-1999.
    if (year < 100) local.setFullYear(year);
    const localMs = local.getTime();
    return Number.isFinite(localMs) ? localMs : null;
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The calendar day a written date names (model output such as "2024-05-05"
 * or "May 5, 2024"), as YYYY-MM-DD, or null when it does not parse.
 *
 * A leading YYYY-MM-DD is kept as written, whatever time and offset follow
 * it, and so is a value that is only YYYY or YYYY-MM, with or without a "Z"
 * after it. Anything else ("May 5, 2024", "2024 May 5") is parsed by V8 as
 * LOCAL time, so its local day is the day written; toISOString moved it back
 * a day east of Greenwich.
 *
 * A year outside 0000-9999 is not a day anyone wrote ("20255-01-01" parses
 * as the year 20255) and gives null.
 * @param {any} value
 * @returns {string|null}
 */
function toWrittenCalendarDay(value) {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) {
    return null;
  }
  // A model that answers {"date": 2024} wrote a year. new Date(2024) is 2024
  // milliseconds after 1970.
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1000 && value <= 9999 ? `${value}-01-01` : null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const written =
    typeof value === 'string'
      ? value.trim().match(/^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T\s].*)?)?)?Z?$/i)
      : null;
  if (!written) {
    const year = parsed.getFullYear();
    return year >= 0 && year <= 9999 ? toLocalCalendarDay(parsed.getTime()) : null;
  }
  // Through the UTC setter so "2024-02-31" rolls over the way Date itself
  // reads it. Not Date.UTC, which reads the years 0-99 as 1900-1999 and
  // would turn a misread "0024-05-05" into a plausible 1924.
  const day = new Date(0);
  day.setUTCFullYear(Number(written[1]), Number(written[2] || 1) - 1, Number(written[3] || 1));
  return Number.isNaN(day.getTime()) ? null : day.toISOString().split('T')[0];
}

module.exports = {
  CONTENT_DATE_MIN_YEAR,
  CONTENT_DATE_FUTURE_SLACK_YEARS,
  isPlausibleContentDate,
  isIsoDateOnly,
  toLocalCalendarDay,
  toLocalCalendarMs,
  toWrittenCalendarDay
};
