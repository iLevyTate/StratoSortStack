// @ts-check

/**
 * Flatten date-sorted timeline items into virtualization-ready rows:
 * year headers, month headers, item rows, and a trailing "Undated" section
 * for unparseable dates. Input order is preserved (already sorted desc).
 */

import { isIsoDateOnly } from '../../shared/contentDateSanity';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
];

/**
 * Date-only strings (content dates, `YYYY-MM-DD`) parse as UTC midnight, so
 * they must be read back with UTC getters to preserve the calendar day.
 * Full timestamps (analyzed-at ISO strings with a time part) are moments in
 * time and should group/display in the user's local day — UTC getters shift
 * an evening analysis onto "tomorrow" for anyone west of Greenwich.
 * Strict YYYY-MM-DD match (shared policy in contentDateSanity): a loose
 * "contains no 'T'" check sent local-parsed non-ISO strings ("May 5, 2024")
 * through the UTC path and mangled their display via slice(0,10).
 * @param {string} value
 * @returns {boolean}
 */
export function isDateOnly(value) {
  return isIsoDateOnly(value);
}

/**
 * Calendar day (YYYY-MM-DD) for an effectiveDate, honoring the date-only vs
 * timestamp distinction above. Returns null for unparseable input.
 * @param {string} value
 * @returns {string|null}
 */
export function formatTimelineDay(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  if (isDateOnly(value)) return value.slice(0, 10);
  const d = new Date(ms);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * @param {Array<{id: string, effectiveDate: string}>|null|undefined} items
 * @returns {Array<{type: 'year'|'month'|'undated', label: string}|{type: 'item', item: any}>}
 */
export function buildTimelineRows(items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  /** @type {Array<any>} */
  const rows = [];
  /** @type {Array<any>} */
  const undated = [];
  let currentYear = null;
  let currentMonth = null;
  for (const item of items) {
    if (!item) continue;
    const ms = Date.parse(item.effectiveDate);
    if (!Number.isFinite(ms)) {
      undated.push(item);
      continue;
    }
    const d = new Date(ms);
    const utc = isDateOnly(item.effectiveDate);
    const year = String(utc ? d.getUTCFullYear() : d.getFullYear());
    const month = `${MONTHS[utc ? d.getUTCMonth() : d.getMonth()]} ${year}`;
    if (year !== currentYear) {
      rows.push({ type: 'year', label: year });
      currentYear = year;
      currentMonth = null;
    }
    if (month !== currentMonth) {
      rows.push({ type: 'month', label: month });
      currentMonth = month;
    }
    rows.push({ type: 'item', item });
  }
  if (undated.length > 0) {
    rows.push({ type: 'undated', label: 'Undated' });
    for (const item of undated) rows.push({ type: 'item', item });
  }
  return rows;
}
