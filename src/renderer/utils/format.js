// @ts-check
export function formatBytes(/** @type {any} */ bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const idx = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / 1024 ** idx;
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[idx]}`;
}

export function formatDuration(/** @type {any} */ ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '0s';
  const totalSeconds = Math.round(n / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Timecode-style formatter for media playback durations (audio/video):
 * `mm:ss` under one hour, `hh:mm:ss` once you cross 60 minutes. The
 * legacy `formatDuration(ms)` returns "1h 30m" style output that's fine
 * for elapsed-time labels but ambiguous for playback length, where users
 * read durations as timecodes.
 */
export function formatMediaTimecode(/** @type {any} */ seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return '00:00';
  const total = Math.floor(n);
  const ss = (total % 60).toString().padStart(2, '0');
  const mm = Math.floor((total / 60) % 60)
    .toString()
    .padStart(2, '0');
  const hh = Math.floor(total / 3600);
  if (hh > 0) return `${hh.toString().padStart(2, '0')}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

/**
 * Human-readable duration for mixed sub-second and multi-second values (e.g. stats averages).
 */
export function formatMillisHuman(/** @type {any} */ ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '0s';
  if (n < 1000) return `${Math.round(n)} ms`;
  const sec = n / 1000;
  if (sec < 60) {
    const rounded = Math.round(sec * 10) / 10;
    return Number.isInteger(rounded) ? `${rounded}s` : `${rounded.toFixed(1)}s`;
  }
  return formatDuration(n);
}

// ---- Locale-aware date/time formatting -------------------------------------
//
// Rationale: most of the renderer currently calls `new Date(x).toLocaleString()`
// with no options, which:
//   (1) Depends on the OS locale, making screenshots and support bundles hard
//       to compare across environments.
//   (2) Silently flips between 12-hour and 24-hour time based on the user's
//       system settings, breaking tests that rely on the rendered output.
//   (3) Builds a fresh Intl.DateTimeFormat per call, which is measurably slow
//       in lists (history/undo timeline, search results).
//
// We centralize formatting here. Callers pick the "shape" they want
// (`short`, `datetime`, `time`, `date`) and the helper returns a stable
// string. The explicit locale defaults to the browser's `navigator.language`
// but is resolvable via `setDateLocale(locale)` so tests and QA can pin a
// specific locale without mutating OS settings.

const _cache = new Map();
/** @type {string | null} */
let _currentLocale = null;

function _resolveLocale() {
  if (_currentLocale) return _currentLocale;
  if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
    _currentLocale = navigator.language;
    return _currentLocale;
  }
  _currentLocale = 'en-US';
  return _currentLocale;
}

function _getFormatter(/** @type {any} */ kind) {
  const locale = _resolveLocale();
  const cacheKey = `${locale}::${kind}`;
  let fmt = _cache.get(cacheKey);
  if (fmt) return fmt;

  /** @type {any} */
  let options;
  switch (kind) {
    case 'short':
      options = { dateStyle: 'short' };
      break;
    case 'date':
      options = { dateStyle: 'medium' };
      break;
    case 'time':
      options = { timeStyle: 'short' };
      break;
    case 'datetime':
      options = { dateStyle: 'medium', timeStyle: 'short' };
      break;
    case 'datetime-long':
      options = { dateStyle: 'long', timeStyle: 'medium' };
      break;
    default:
      options = { dateStyle: 'medium', timeStyle: 'short' };
  }
  try {
    fmt = new Intl.DateTimeFormat(locale, options);
  } catch {
    fmt = new Intl.DateTimeFormat('en-US', options);
  }
  _cache.set(cacheKey, fmt);
  return fmt;
}

function _toDate(/** @type {any} */ input) {
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  if (input === null || input === undefined || input === '') return null;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Format a timestamp (Date | number | ISO string) for UI display.
 * @param {*} input      Date / epoch ms / ISO string.
 * @param {string} kind  One of 'short' | 'date' | 'time' | 'datetime' | 'datetime-long'.
 * @param {string} fallback Returned when the input isn't a valid date.
 * @returns {string}
 */
export function formatDateTime(input, kind = 'datetime', fallback = '') {
  const d = _toDate(input);
  if (!d) return fallback;
  try {
    return _getFormatter(kind).format(d);
  } catch {
    return fallback;
  }
}

/** Override the locale used by `formatDateTime`. Primarily for QA / tests. */
export function setDateLocale(/** @type {any} */ locale) {
  _currentLocale = typeof locale === 'string' && locale.length > 0 ? locale : null;
  _cache.clear();
}
