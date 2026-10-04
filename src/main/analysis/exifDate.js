// @ts-check
/**
 * EXIF capture-date reading shared by imageAnalysis (main thread) and
 * imagePreprocessWorker (Piscina), so the two paths stay interchangeable.
 *
 * exif-reader 2.x groups tags by IFD (`Photo`, `Image`, `GPSInfo`) and
 * returns Date objects; 1.x used `exif` / `image` and strings such as
 * "2024:01:15 10:30:00". Cameras with an unset clock and some export
 * pipelines write the placeholder "0000:00:00 00:00:00", which exif-reader
 * turns into a real Date in November 1899. A date like that must not become
 * the photo's date: the next candidate is tried, and when none is plausible
 * the caller falls back to the file's own modification time.
 */

// Digital cameras with EXIF did not exist before this; anything earlier is a
// placeholder or a reset clock.
const EARLIEST_PLAUSIBLE_YEAR = 1980;
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * @param {any} exif  parsed exif-reader output (either major version)
 * @returns {any[]}   candidates in preference order (capture, digitization, modification)
 */
function exifDateCandidates(exif) {
  if (!exif || typeof exif !== 'object') return [];
  return [
    exif.Photo?.DateTimeOriginal,
    exif.Photo?.DateTimeDigitized,
    exif.Image?.DateTime,
    exif.exif?.DateTimeOriginal,
    exif.exif?.DateTimeDigitized,
    exif.image?.ModifyDate
  ];
}

/**
 * One EXIF date value as a YYYY-MM-DD day, or null when it is missing,
 * malformed or not a plausible capture date.
 * @param {any} value  Date (exif-reader 2.x) or "YYYY:MM:DD HH:MM:SS" string (1.x)
 * @param {number} [nowMs]
 * @returns {string|null}
 */
function exifDateValueToIsoDay(value, nowMs = Date.now()) {
  if (!value) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    if (Number.isNaN(time)) return null;
    if (value.getUTCFullYear() < EARLIEST_PLAUSIBLE_YEAR) return null;
    if (time > nowMs + FUTURE_SLACK_MS) return null;
    return value.toISOString().split('T')[0];
  }
  const match = String(value).match(/^(\d{4}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < EARLIEST_PLAUSIBLE_YEAR || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const utc = Date.UTC(year, month - 1, day);
  if (utc > nowMs + FUTURE_SLACK_MS) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * First plausible capture date in the EXIF block, as YYYY-MM-DD, or null.
 * @param {any} exif
 * @param {number} [nowMs]
 * @returns {string|null}
 */
function pickExifIsoDay(exif, nowMs = Date.now()) {
  for (const candidate of exifDateCandidates(exif)) {
    const day = exifDateValueToIsoDay(candidate, nowMs);
    if (day) return day;
  }
  return null;
}

/**
 * First raw candidate that yields a plausible date (kept for callers that
 * want the Date itself), or null.
 * @param {any} exif
 * @returns {any}
 */
function pickExifDateValue(exif) {
  for (const candidate of exifDateCandidates(exif)) {
    if (exifDateValueToIsoDay(candidate)) return candidate;
  }
  return null;
}

module.exports = {
  EARLIEST_PLAUSIBLE_YEAR,
  exifDateCandidates,
  exifDateValueToIsoDay,
  pickExifIsoDay,
  pickExifDateValue
};
