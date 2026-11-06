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
 * the words after it. It also runs across further `/`: the logger cuts a
 * POSIX path at the first whitespace, so `/Users/me/My Drive/passport.pdf`
 * reaches the panel as `[REDACTED_PATH]/My Drive/passport.pdf`, and the
 * rest of the path is part of what must be hidden. A JSON escape (`\"`,
 * `\\`) stays inside the name, and a `"` ends it only where it closes a JSON
 * string (followed by `,` `:` `}` `]`, a cut mark or the end), so dataText
 * keeps its structure while a quote inside a POSIX name in a plain message
 * is still hidden.
 */
const SLASH_NAME = String.raw`(?:(?! =>)${NOT_NEXT_TOKEN}(?:\\.|"(?![,:}\]]|${CUT_MARK}|$)|[^"\\:*?<>|\r\n]))+`;
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
  'domain',
  'url',
  'uri',
  'href',
  'endpoint',
  'baseUrl',
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
 * Bare file names (no redacted-path token before them), e.g. the basename in
 * `[FILE-OPS] Falling back to UUID for tax-return-2025.pdf`. A candidate is
 * a run of characters between whitespace and punctuation that cannot sit
 * inside a name token (quotes, `,;:<>|*?=`, slashes, braces). Brackets and
 * parentheses can be part of a name ("IMG (1).jpg"), so they only come off
 * the ends, together with trailing sentence punctuation and a cut mark. A
 * candidate names a file when it does not start with a dot and ends like
 * one: a dot, a letter, then up to seven letters or digits. Kept readable:
 * web URLs, host names (common top-level domains), model files, camelCase
 * members (`storage.getItem`) and "e.g."-style abbreviations. A name with
 * spaces is hidden from its last space on; nothing here knows where it
 * starts.
 *
 * The classifier (src/main/services/liveLogActivity.js) builds a Problem
 * line's redacted text with the same scan (a test runs both over one set of
 * cases).
 */
const BARE_TOKEN = /[^\s"'`,;:<>|*?=\\/{}]+/gu;
const BARE_LEADING_PUNCTUATION = /^[([]+/u;
const BARE_TRAILING_PUNCTUATION = /[)\].!…]+$/u;
const BARE_FILE_NAME = /^[^.].*\.([A-Za-z][A-Za-z0-9]{0,7})$/u;
const CAMEL_CASE = /[a-z][A-Z]/u;
const WEB_URL = /\b(?:https?|wss?):\/\/?[^\s"'<>]*/giu;
/** Endings that are host names or model files, never user documents. */
const NON_FILE_EXTENSIONS = new Set([
  'com',
  'net',
  'org',
  'io',
  'co',
  'dev',
  'edu',
  'gov',
  'local',
  'localhost',
  'internal',
  'gguf',
  'ggml',
  'onnx'
]);
const ABBREVIATION = /^(?:e\.g|i\.e|a\.m|p\.m)$/iu;

/**
 * Spans (start, end) of the bare file names in `value`, in order.
 * @param {string} value
 * @returns {Array<[number, number]>}
 */
function bareFileNameSpans(value) {
  /** @type {Array<[number, number]>} */
  const urls = [];
  for (const match of value.matchAll(WEB_URL)) {
    const start = match.index ?? 0;
    urls.push([start, start + match[0].length]);
  }
  /** @type {Array<[number, number]>} */
  const spans = [];
  for (const match of value.matchAll(BARE_TOKEN)) {
    const lead = match[0].length - match[0].replace(BARE_LEADING_PUNCTUATION, '').length;
    const start = (match.index ?? 0) + lead;
    const token = match[0].slice(lead).replace(BARE_TRAILING_PUNCTUATION, '');
    const end = start + token.length;
    if (urls.some(([from, to]) => start < to && end > from)) continue;
    const name = BARE_FILE_NAME.exec(token);
    if (!name) continue;
    const extension = name[1];
    if (NON_FILE_EXTENSIONS.has(extension.toLowerCase())) continue;
    if (CAMEL_CASE.test(extension) || ABBREVIATION.test(token)) continue;
    spans.push([start, end]);
  }
  return spans;
}

/**
 * `value` with each bare file name replaced by the redaction label.
 * @param {string} value
 * @returns {string}
 */
export function hideBareFileNames(value) {
  const spans = bareFileNameSpans(value);
  return spans.length > 0 ? replaceSpans(value, spans) : value;
}

/** A JSON escape: `\uXXXX` or a backslash and the character after it. */
const JSON_ESCAPE = /(\\(?:u[0-9a-fA-F]{4}|[\s\S]))/;

/**
 * The body of a JSON string (escapes kept) with each bare file name hidden.
 * Escapes split the text, so in `line\ntax.pdf` the name is `tax.pdf`, not
 * `ntax.pdf`.
 * @param {string} body
 * @returns {string}
 */
function hideBareFileNamesInJsonString(body) {
  if (!body.includes('\\')) return hideBareFileNames(body);
  return body
    .split(JSON_ESCAPE)
    .map((part, index) => (index % 2 === 1 ? part : hideBareFileNames(part)))
    .join('');
}

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
 * on. A Problem line's own `redactedText` is used when it has one;
 * otherwise `file` and each of `files` are hidden at every occurrence
 * (overlapping ones included). The classifier cuts its text at 300 characters (ending in "…")
 * but keeps names whole, so a long name can run past the cut: the start of
 * a name left just before the "…" is hidden as well, when it starts a word.
 * That holds even if the same name also appears whole earlier ("Failed to
 * move X to X…"). Any bare file name the text carries beyond those (see
 * bareFileNameSpans) is hidden too, as a backstop for lines whose names the
 * classifier did not list.
 * @param {LiveActivity} activity
 * @param {boolean} redact
 * @returns {string}
 */
export function redactActivityText(activity, redact) {
  const { text } = activity;
  if (!redact) return text;
  // A Problem line carries its own redacted text, built from the message
  // with each name replaced where it stands (short names never hide letters
  // inside other words). Other activities are hidden by name below.
  if (typeof activity.redactedText === 'string') return hideBareFileNames(activity.redactedText);
  const names = activityFileNames(activity);
  if (names.length === 0) return hideBareFileNames(text);
  const cut = text.endsWith(CUT_MARK);
  const body = cut ? text.slice(0, -CUT_MARK.length) : text;
  /** @type {Array<[number, number]>} */
  const spans = bareFileNameSpans(text);
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
 * to the key before it. Bare file names are hidden everywhere else: in the
 * text between quoted strings (a plain message), inside keys, and inside
 * other values, except under the code/type keys (a model or URL value stays
 * readable).
 * @param {string} text
 * @returns {string}
 */
function redactJsonFileValues(text) {
  let key = '';
  let out = '';
  let cursor = 0;
  for (const match of text.matchAll(JSON_STRING)) {
    const [whole, body, close, colon] = match;
    const at = match.index ?? 0;
    out += hideBareFileNames(text.slice(cursor, at));
    cursor = at + whole.length;
    if (colon) {
      key = body;
      out += `"${hideBareFileNamesInJsonString(body)}${close}${colon}`;
    } else if (isFileValue(key, body)) {
      const cutMark = close === '' && body.endsWith(CUT_MARK) ? CUT_MARK : '';
      out += `"${REDACTED_FILE_LABEL}${cutMark}${close}`;
    } else if (NON_FILE_KEYS.has(key)) {
      out += whole;
    } else {
      out += `"${hideBareFileNamesInJsonString(body)}${close}`;
    }
  }
  return out + hideBareFileNames(text.slice(cursor));
}

/**
 * Raw text (a message or dataText JSON) with file names hidden when `redact`
 * is on: the name after each redacted-path token is dropped (the token
 * stays), quoted values that hold a file name (by key, or by looking like
 * one) become "a file", and so does every bare file name elsewhere in the
 * text (see bareFileNameSpans).
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
