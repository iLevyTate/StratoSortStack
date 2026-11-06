// @ts-check
/**
 * Pure view helpers for the Live Activity panel: level filtering, time
 * formatting, file-name redaction, icon lookup and the copy format. No
 * React, no I/O.
 *
 * Records are already sanitized by the logger (absolute paths become
 * `[REDACTED_PATH]\name.ext` or `[REDACTED_PATH]/name.ext`). With the
 * "Redact paths" setting on, the panel also hides those remaining file names
 * ("a file").
 */

/**
 * The entry shape is the batch payload built by the main-process feed.
 * @typedef {import('../../../main/services/liveLogFeed').LiveLogEntry} LiveLogEntry
 * @typedef {import('../../../main/services/liveLogFeed').LiveActivity} LiveActivity
 * @typedef {'activity' | 'raw'} LiveActivityTab
 */

/** Minimum-level choices offered by the Raw tab. */
export const LEVEL_FILTER_OPTIONS = Object.freeze(['debug', 'info', 'warn', 'error']);

export const REDACTED_FILE_LABEL = 'a file';

const REDACTED_PATH = '[REDACTED_PATH]';
/** The mark the classifier and the feed leave where they cut a string. */
const CUT_MARK = '…';

/** @type {Readonly<Record<string, number>>} */
const LEVEL_RANK = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60
});

/**
 * A file name after `[REDACTED_PATH]\`, matched the way sanitizeLogData in
 * src/shared/logger.js wrote it: it runs to a character Windows forbids in
 * names, so spaces, brackets and parentheses are part of it (hiding a few
 * trailing words too is acceptable). It stops before the " => " the app
 * writes between two paths (`>` cannot be in a name) and before the next
 * redacted-path token, so one name never swallows the token after it.
 * Inside JSON text the name ends at the closing quote, which the class
 * already excludes.
 */
const NOT_NEXT_TOKEN = String.raw`(?!\[REDACTED_PATH\])`;
const WINDOWS_NAME = String.raw`(?:(?! =>)${NOT_NEXT_TOKEN}[^\\/:*?"<>|\r\n])+`;
/**
 * A file name after `[REDACTED_PATH]/`: the logger stops POSIX names at
 * whitespace or `/`. A JSON escape (`\"`, `\\`) stays inside the name, and a
 * `"` ends it only where it closes a JSON string (followed by `,` `:` `}`
 * `]`, a cut mark or the end), so dataText keeps its structure while a quote
 * inside a name in a plain message is still hidden. Like the Windows name,
 * it stops before the next redacted-path token.
 */
const POSIX_NAME = String.raw`(?:${NOT_NEXT_TOKEN}(?:\\.|"(?![,:}\]]|${CUT_MARK}|$)|[^"\\/\s]))+`;
/**
 * The name after a redacted-path token, in a plain message (`\` or `/`) or in
 * JSON text where a Windows `\` is escaped as `\\` (tried first).
 */
const REDACTED_PATH_NAME = new RegExp(
  String.raw`\[REDACTED_PATH\](?:\\\\${WINDOWS_NAME}|\\${WINDOWS_NAME}|\/${POSIX_NAME})`,
  'g'
);

/**
 * String values of JSON fields that hold a file name or a path: `file`,
 * `path`, `fileName`/`filename`, the move/copy endpoints, the suggested name,
 * and any camelCase key ending in Path, File or FileName (`oldPath`,
 * `originalFileName`, ...). Empty values are left as they are.
 */
const FILE_FIELD_VALUE =
  /("(?:file|path|fileName|filename|source|destination|from|to|suggestedName|[a-z][A-Za-z]*(?:Path|File|FileName|Filename))"\s*:\s*")((?:[^"\\]|\\.)+)(")/g;

/**
 * Rank of a log level; unknown levels count as info.
 * @param {string} level
 * @returns {number}
 */
export function levelRank(level) {
  return Object.prototype.hasOwnProperty.call(LEVEL_RANK, level)
    ? LEVEL_RANK[level]
    : LEVEL_RANK.info;
}

/**
 * @param {string} iso
 * @returns {string}
 */
export function formatEntryTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

/**
 * @param {LiveLogEntry[]} entries
 * @returns {LiveLogEntry[]}
 */
export function activityEntries(entries) {
  return entries.filter((entry) => Boolean(entry.activity));
}

/**
 * @param {LiveLogEntry[]} entries
 * @param {string} minLevel
 * @param {string} context - a context name, or 'all'
 * @returns {LiveLogEntry[]}
 */
export function filterRawEntries(entries, minLevel, context) {
  const min = levelRank(minLevel);
  return entries.filter(
    (entry) => levelRank(entry.level) >= min && (context === 'all' || entry.context === context)
  );
}

/**
 * @param {LiveLogEntry[]} entries
 * @returns {string[]}
 */
export function listContexts(entries) {
  return [...new Set(entries.map((entry) => entry.context).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

/**
 * Length of the longest end of `body` that is the start of `name` (0 when
 * none). This is how much of a name survived a cut at the end of a line.
 * @param {string} body
 * @param {string} name
 * @returns {number}
 */
function cutNameLength(body, name) {
  if (!name) return 0;
  const first = name.charCodeAt(0);
  for (let start = Math.max(0, body.length - name.length); start < body.length; start += 1) {
    if (body.charCodeAt(start) === first && name.startsWith(body.slice(start))) {
      return body.length - start;
    }
  }
  return 0;
}

/**
 * `text` with each span (start, end) replaced by the redaction label;
 * overlapping or touching spans become one label.
 * @param {string} text
 * @param {Array<[number, number]>} spans
 * @returns {string}
 */
function replaceSpans(text, spans) {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let out = '';
  let cursor = 0;
  let index = 0;
  while (index < sorted.length) {
    const start = sorted[index][0];
    let end = sorted[index][1];
    index += 1;
    while (index < sorted.length && sorted[index][0] <= end) {
      end = Math.max(end, sorted[index][1]);
      index += 1;
    }
    out += text.slice(cursor, start) + REDACTED_FILE_LABEL;
    cursor = end;
  }
  return out + text.slice(cursor);
}

/**
 * Activity text with `activity.file` hidden when `redact` is on. Every
 * occurrence of the name is hidden, overlapping ones included. The
 * classifier cuts its text at 300 characters (ending in "…") but keeps
 * `file` whole, so a long name can run past the cut: the start of the name
 * left just before the "…" is hidden as well.
 * @param {LiveActivity} activity
 * @param {boolean} redact
 * @returns {string}
 */
export function redactActivityText(activity, redact) {
  const { text, file } = activity;
  if (!redact || !file) return text;
  /** @type {Array<[number, number]>} */
  const spans = [];
  for (let at = text.indexOf(file); at !== -1; at = text.indexOf(file, at + 1)) {
    spans.push([at, at + file.length]);
  }
  if (text.endsWith(CUT_MARK)) {
    const body = text.slice(0, -CUT_MARK.length);
    // The feed may have cut `file` too; only its uncut start can match.
    const name = file.endsWith(CUT_MARK) ? file.slice(0, -CUT_MARK.length) : file;
    const kept = cutNameLength(body, name);
    if (kept > 0) spans.push([body.length - kept, body.length]);
  }
  return spans.length > 0 ? replaceSpans(text, spans) : text;
}

/**
 * Raw text (a message or dataText JSON) with file names hidden when `redact`
 * is on: the name after each redacted-path token is dropped (the token
 * stays), and file/path fields in JSON become "a file".
 * @param {string} text
 * @param {boolean} redact
 * @returns {string}
 */
export function redactRawText(text, redact) {
  if (!redact || !text) return text;
  return text
    .replace(REDACTED_PATH_NAME, REDACTED_PATH)
    .replace(FILE_FIELD_VALUE, `$1${REDACTED_FILE_LABEL}$3`);
}

/**
 * The entry from a fixed icon table for `name`, or `fallback` when the name
 * is empty, unknown, or not the table's own key (`constructor`, ...).
 * @template T
 * @param {Readonly<Record<string, T>>} table
 * @param {string} name
 * @param {T} fallback
 * @returns {T}
 */
export function pickActivityIcon(table, name, fallback) {
  if (!name || !Object.prototype.hasOwnProperty.call(table, name)) return fallback;
  return table[name] || fallback;
}

/**
 * The context tag shown on an Activity row: problem lines name the part of
 * the app they came from (their text leaves it out); other rows have none.
 * @param {LiveLogEntry} entry
 * @returns {string}
 */
export function activityContextTag(entry) {
  return entry.activity && entry.activity.kind === 'problem' && entry.context ? entry.context : '';
}

/**
 * One line of "Copy visible lines" output, as shown on screen.
 * @param {LiveLogEntry} entry
 * @param {LiveActivityTab} tab
 * @param {boolean} redact
 * @returns {string}
 */
export function formatCopyLine(entry, tab, redact) {
  const time = formatEntryTime(entry.time);
  if (tab === 'activity' && entry.activity) {
    const line = `${time} ${redactActivityText(entry.activity, redact)}`;
    const tag = activityContextTag(entry);
    return tag ? `${line} [${tag}]` : line;
  }
  const msg = redactRawText(entry.msg, redact);
  const data = redactRawText(entry.dataText, redact);
  return `${time} ${entry.level.toUpperCase().padEnd(5)} [${entry.context || 'App'}] ${msg}${
    data ? ` ${data}` : ''
  }`;
}
