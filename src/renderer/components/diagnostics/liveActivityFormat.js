// @ts-check
/**
 * Pure view helpers for the Live Activity panel: level filtering, time
 * formatting, file-name redaction, icon lookup and the copy format. No
 * React, no I/O.
 *
 * Records are already sanitized by the logger (absolute paths become
 * `[REDACTED_PATH]\name.ext`, `[REDACTED_PATH]\\name.ext` inside JSON text,
 * or `[REDACTED_PATH]/name.ext`). With the "Redact paths" setting on, the
 * panel also hides those remaining file names ("a file").
 */

/**
 * The entry shape is the batch payload built by the main-process feed.
 * @typedef {import('../../../main/services/liveLogFeed').LiveLogEntry} LiveLogEntry
 * @typedef {import('../../../main/services/liveLogFeed').LiveActivity} LiveActivity
 * @typedef {import('./liveActivityPanelState').LiveActivityTab} LiveActivityTab
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

/** A name never runs into the next redacted-path token. */
const NOT_NEXT_TOKEN = String.raw`(?!\[REDACTED_PATH\])`;
/**
 * A file name after a run of backslashes (`[REDACTED_PATH]\` in a message,
 * `[REDACTED_PATH]\\` in JSON text), matched the way sanitizeLogData in
 * src/shared/logger.js wrote it: it runs to a character Windows forbids in
 * names, so spaces, brackets and parentheses are part of it (hiding a few
 * trailing words too is acceptable). It stops before the " => " the app
 * writes between two paths (`>` cannot be in a name) and before the next
 * token. In JSON text it ends at the closing quote, which the class excludes.
 */
const BACKSLASH_NAME = String.raw`(?:(?! =>)${NOT_NEXT_TOKEN}[^\\/:*?"<>|\r\n])+`;
/**
 * A file name after a separator run with a `/`. The logger writes both
 * forward-slash drive paths (`C:/Users/...`, whose names keep their spaces)
 * and POSIX paths (cut at whitespace) this way, and the two cannot be told
 * apart, so it is read like a Windows name: a POSIX name errs toward hiding
 * the words after it. A JSON escape (`\"`, `\\`) stays inside the name, and
 * a `"` ends it only where it closes a JSON string (followed by `,` `:` `}`
 * `]`, a cut mark or the end), so dataText keeps its structure while a quote
 * inside a POSIX name in a plain message is still hidden.
 */
const SLASH_NAME = String.raw`(?:(?! =>)${NOT_NEXT_TOKEN}(?:\\.|"(?![,:}\]]|${CUT_MARK}|$)|[^"\\/:*?<>|\r\n]))+`;
/** The name after each redacted-path token and its separator run. */
const REDACTED_PATH_NAME = new RegExp(
  String.raw`\[REDACTED_PATH\](?:\\+${BACKSLASH_NAME}|\\*\/[\\/]*${SLASH_NAME})`,
  'g'
);

/**
 * One JSON string token: its body (escapes kept), its closing quote (empty
 * when a cut ended the text inside it), and the `:` after it when it is a
 * key. Scanning left to right keeps the matches aligned to JSON strings.
 */
const JSON_STRING = /"((?:[^"\\]|\\[\s\S]|\\$)*)("|$)(\s*:)?/g;
/**
 * Keys whose string values hold a file name or a path, as the main process
 * logs them (e.g. `{ original, raw, final }` in ipc/analysis.js, `{ name }`
 * in ipc/semantic.js, `{ dest }` in FilePathCoordinator.js).
 */
const FILE_KEYS = new Set([
  'file',
  'files',
  'path',
  'paths',
  'fileName',
  'filename',
  'fileNames',
  'name',
  'newName',
  'oldName',
  'originalName',
  'suggestedName',
  'original',
  'final',
  'raw',
  'source',
  'destination',
  'dest',
  'target',
  'from',
  'to',
  'entry'
]);
/** camelCase keys ending in Path, File or FileName (`oldPath`, `originalFileName`, ...). */
const FILE_KEY_SUFFIX = /^[a-z][A-Za-z]*(?:Path|File|FileName|Filename)s?$/;
/**
 * Keys whose values are codes, types or names of app parts, never user
 * files: the file-name heuristic leaves them alone (so `storage.full` or a
 * model file name stays readable). File keys above still win.
 */
const NON_FILE_KEYS = new Set([
  'code',
  'type',
  'kind',
  'level',
  'event',
  'eventType',
  'channel',
  'status',
  'state',
  'phase',
  'severity',
  'subsystem',
  'context',
  'service',
  'serviceName',
  'mimeType',
  'mime',
  'contentType',
  'model',
  'modelName',
  'modelId',
  'provider',
  'providerName',
  'host',
  'hostname',
  'method',
  'operation'
]);
/**
 * A string that ends like a file name: a dot, a letter, then up to seven
 * letters or digits ("report.pdf", "IMG_2041.HEIC"). Versions ("1.2.3") and
 * plain words survive; so do strings past MAX_FILE_LIKE_CHARS.
 */
const FILE_LIKE_ENDING = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;
const MAX_FILE_LIKE_CHARS = 300;
const WORD_CHAR = /[\p{L}\p{N}]/u;

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
 * True when a name starting at `start` in `body` starts a word: at the
 * start, after a non-word character, or with a non-word character itself.
 * @param {string} body
 * @param {number} start
 */
function startsWord(body, start) {
  return start === 0 || !WORD_CHAR.test(body[start - 1]) || !WORD_CHAR.test(body[start]);
}

/**
 * Length of the longest end of `body` that starts a word and is the start
 * of `name` (0 when none). This is how much of a name survived a cut at the
 * end of a line; requiring a word start keeps "…folder…" from losing its "r"
 * to "report.pdf".
 * @param {string} body
 * @param {string} name
 * @returns {number}
 */
function cutNameLength(body, name) {
  if (!name) return 0;
  const first = name.charCodeAt(0);
  for (let start = Math.max(0, body.length - name.length); start < body.length; start += 1) {
    if (
      body.charCodeAt(start) === first &&
      startsWord(body, start) &&
      name.startsWith(body.slice(start))
    ) {
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
 * The distinct non-empty names an activity says its text mentions: `file`
 * and every entry of a Problem line's `files`.
 * @param {LiveActivity} activity
 * @returns {string[]}
 */
function activityFileNames(activity) {
  const listed = Array.isArray(activity.files) ? activity.files : [];
  return [...new Set([activity.file, ...listed])].filter(
    /** @returns {name is string} */ (/** @type {unknown} */ name) =>
      typeof name === 'string' && name !== ''
  );
}

/**
 * Activity text with every file name it mentions hidden when `redact` is
 * on: `file` and each of `files`, at every occurrence (overlapping ones
 * included). The classifier cuts its text at 300 characters (ending in "…")
 * but keeps names whole, so a long name can run past the cut: the start of
 * a name left just before the "…" is hidden as well, when it starts a word.
 * That holds even if the same name also appears whole earlier ("Failed to
 * move X to X…").
 * @param {LiveActivity} activity
 * @param {boolean} redact
 * @returns {string}
 */
export function redactActivityText(activity, redact) {
  const { text } = activity;
  if (!redact) return text;
  const names = activityFileNames(activity);
  if (names.length === 0) return text;
  const cut = text.endsWith(CUT_MARK);
  const body = cut ? text.slice(0, -CUT_MARK.length) : text;
  /** @type {Array<[number, number]>} */
  const spans = [];
  for (const name of names) {
    for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
      spans.push([at, at + name.length]);
    }
    if (cut) {
      // The feed may have cut the name too; only its uncut start can match.
      const start = name.endsWith(CUT_MARK) ? name.slice(0, -CUT_MARK.length) : name;
      const kept = cutNameLength(body, start);
      if (kept > 0) spans.push([body.length - kept, body.length]);
    }
  }
  return spans.length > 0 ? replaceSpans(text, spans) : text;
}

/**
 * Whether a JSON string value under `key` holds a file name: a file key, or
 * (outside the code/type keys) a value that ends like a file name.
 * @param {string} key
 * @param {string} value - the string's body, escapes kept
 */
function isFileValue(key, value) {
  if (value === '' || value === REDACTED_FILE_LABEL) return false;
  if (FILE_KEYS.has(key) || FILE_KEY_SUFFIX.test(key)) return true;
  if (NON_FILE_KEYS.has(key)) return false;
  return value.length <= MAX_FILE_LIKE_CHARS && FILE_LIKE_ENDING.test(value);
}

/**
 * JSON string values that hold a file name become "a file" (a value cut at
 * the end of the text keeps its "…"). Keys stay; an array's values belong
 * to the key before it.
 * @param {string} text
 * @returns {string}
 */
function redactJsonFileValues(text) {
  let key = '';
  return text.replace(
    JSON_STRING,
    (
      /** @type {string} */ match,
      /** @type {string} */ body,
      /** @type {string} */ close,
      /** @type {string | undefined} */ colon
    ) => {
      if (colon) {
        key = body;
        return match;
      }
      if (!isFileValue(key, body)) return match;
      const cutMark = close === '' && body.endsWith(CUT_MARK) ? CUT_MARK : '';
      return `"${REDACTED_FILE_LABEL}${cutMark}${close}`;
    }
  );
}

/**
 * Raw text (a message or dataText JSON) with file names hidden when `redact`
 * is on: the name after each redacted-path token is dropped (the token
 * stays), and quoted values that hold a file name (by key, or by looking
 * like one) become "a file".
 * @param {string} text
 * @param {boolean} redact
 * @returns {string}
 */
export function redactRawText(text, redact) {
  if (!redact || !text) return text;
  return redactJsonFileValues(text.replace(REDACTED_PATH_NAME, REDACTED_PATH));
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
