// @ts-check
/**
 * Live log feed: streams the logger's sanitized records to subscribed
 * renderer windows for the Live Activity panel.
 *
 * - The logger listener is registered only while at least one window is
 *   subscribed; with no subscriber there is no listener, buffer or timer.
 * - A ring buffer keeps the last RING_CAPACITY entries as the backlog a new
 *   subscriber receives. It is cleared on the last unsubscribe.
 * - Entries are pushed in batches every FLUSH_INTERVAL_MS, at most
 *   MAX_BATCH_ENTRIES and MAX_BATCH_CHARS (msg + dataText) per batch; the
 *   oldest entries beyond either cap are dropped and counted in `dropped`.
 *   The backlog handed to a new subscriber keeps the newest entries within
 *   the same character budget.
 * - Each line is bounded: msg MAX_MSG_CHARS, context MAX_CONTEXT_CHARS,
 *   time MAX_TIME_CHARS, and `dataText` (at most MAX_DATA_TEXT_CHARS) comes
 *   from a budgeted serializer: long strings are cut before escaping, arrays
 *   are sliced and objects copied down to what could still fit, and nothing
 *   is descended into once the budget is spent. The walk is bounded by the
 *   budget, but a payload still costs whatever the logger spent building it.
 * - A subscriber is dropped when its webContents is destroyed, its renderer
 *   process goes away, or its main frame navigates (a reload or crash
 *   recovery reuses the same webContents; the new page subscribes again).
 * - Records produced synchronously while a batch is being delivered (e.g.
 *   safeSend's validation / failure logs) are ignored, so a failing send
 *   cannot feed itself. The guard is module-wide: no feed buffers what any
 *   feed's delivery logs.
 * - Activity merge (repeated completion lines only): an entry whose activity
 *   kind is in MERGEABLE_KINDS and whose kind + non-empty file match an
 *   activity still in the backlog from the last ACTIVITY_MERGE_WINDOW_MS
 *   keeps its raw record but gets `activity: null` (the analyzer's "Analyzed
 *   X -> Finance" and the watcher's later "Analyzed X" show as one Activity
 *   line; the Raw tab keeps both). Every other kind is never merged: a second
 *   distinct problem about a file, or "Queued X" then "Analyzing X", is real
 *   news.
 * - The logger listener only classifies and buffers; it never sends. IPC
 *   happens on the flush timer.
 * - Nothing here logs: this code runs inside the logger's listener path.
 */
const { IPC_CHANNELS } = require('../../shared/constants');
const { activityFromLogRecord } = require('./liveLogActivity');

const RING_CAPACITY = 500;
const FLUSH_INTERVAL_MS = 250;
const MAX_BATCH_ENTRIES = 200;
const MAX_BATCH_CHARS = 256_000;
const MAX_MSG_CHARS = 2000;
const MAX_DATA_TEXT_CHARS = 1500;
const MAX_CONTEXT_CHARS = 120;
const MAX_TIME_CHARS = 40;
/** Placeholder for an object or array the data budget has no room left for. */
const DATA_CUT_PLACEHOLDER = '…';
/** Below this much remaining budget an object or array is not descended into. */
const MIN_CONTAINER_ROOM = 8;
const ACTIVITY_MERGE_WINDOW_MS = 10_000;
/**
 * Activity kinds whose repeats for the same file are one event announced
 * twice (analyzer success + watcher completion). Problems and progress
 * ('problem', 'analyze', ...) are never merged.
 */
const MERGEABLE_KINDS = new Set(['analyzed']);
/** Prune expired merge keys once the map grows past this many files. */
const MERGE_MEMORY_SOFT_LIMIT = 1000;
const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
/** webContents events after which the subscribed page no longer exists. */
const DETACH_EVENTS = ['destroyed', 'render-process-gone', 'did-navigate'];

/**
 * @typedef {import('../../shared/logger').LiveLogRecord} LiveLogRecord
 * @typedef {import('./liveLogActivity').LiveActivity} LiveActivity
 * @typedef {{ id: number, time: string, level: string, context: string, msg: string, dataText: string, activity: LiveActivity | null }} LiveLogEntry
 * @typedef {{ entries: LiveLogEntry[], dropped: number }} LiveLogBatch
 * @typedef {(record: LiveLogRecord) => void} RecordListener
 * @typedef {(...args: unknown[]) => void} EventHandler
 * @typedef {object} FeedWebContents The part of Electron's WebContents the feed uses.
 * @property {(channel: string, ...args: unknown[]) => void} send
 * @property {() => boolean} [isDestroyed]
 * @property {(event: string, listener: EventHandler) => unknown} [on]
 * @property {(event: string, listener: EventHandler) => unknown} [removeListener]
 * @typedef {object} LiveLogFeedDeps
 * @property {(listener: RecordListener) => void} [addListener]
 * @property {(listener: RecordListener) => void} [removeListener]
 * @property {(record: LiveLogRecord) => (LiveActivity | null)} [classify]
 * @property {(webContents: FeedWebContents, payload: LiveLogBatch) => unknown} [send]
 * @property {() => number} [now] Clock for the activity merge window (ms).
 */

/**
 * True while any feed is delivering a batch. Module-wide so a record logged
 * by one feed's send (safeSend warns / errors synchronously) never enters
 * any feed's buffer and comes back as another send.
 */
let delivering = false;

/**
 * Cut `value` to at most `max` characters, ending in "…" when cut. Never
 * leaves half of a surrogate pair at the cut.
 * @param {string} value
 * @param {number} max
 */
function truncate(value, max) {
  if (value.length <= max) return value;
  let end = Math.max(max - 1, 0);
  const last = value.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}…`;
}

/**
 * Own enumerable keys of `value`, stopping after `limit + 1` so a huge object
 * is never fully enumerated.
 * @param {object} value
 * @param {number} limit
 */
function firstOwnKeys(value, limit) {
  /** @type {string[]} */
  const keys = [];
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    keys.push(key);
    if (keys.length > limit) break;
  }
  return keys;
}

/**
 * Compact JSON for the Raw tab, never longer than MAX_DATA_TEXT_CHARS. The
 * replacer keeps an approximate running length: long strings are cut before
 * they are escaped, arrays are sliced and objects copied down to what could
 * still fit, and once the budget is spent primitives are omitted and objects
 * or arrays become a short placeholder instead of being descended into. A
 * cut is marked with a trailing "…".
 * @param {unknown} data
 */
function stringifyData(data) {
  if (data === undefined || data === null) return '';
  let budget = MAX_DATA_TEXT_CHARS;
  let cut = false;
  /**
   * @this {unknown}
   * @param {string} key
   * @param {unknown} value
   * @returns {unknown}
   */
  function budgeted(key, value) {
    const isContainer = value !== null && typeof value === 'object';
    if (budget <= 0) {
      cut = true;
      return isContainer ? DATA_CUT_PLACEHOLDER : undefined;
    }
    budget -= Array.isArray(this) ? 1 : key.length + 4;
    if (typeof value === 'string') {
      if (value.length > budget) {
        cut = true;
        const kept = truncate(value, Math.max(budget, 1));
        budget -= kept.length + 2;
        return kept;
      }
      budget -= value.length + 2;
      return value;
    }
    if (!isContainer) {
      budget -= 6;
      return value;
    }
    budget -= 2;
    if (budget < MIN_CONTAINER_ROOM) {
      cut = true;
      budget -= DATA_CUT_PLACEHOLDER.length + 2;
      return DATA_CUT_PLACEHOLDER;
    }
    if (Array.isArray(value)) {
      const room = Math.ceil(budget / 2);
      if (value.length > room) {
        cut = true;
        return value.slice(0, room);
      }
      return value;
    }
    // Each kept property costs at least `"k":0,` (6 characters).
    const room = Math.ceil(budget / 6);
    const keys = firstOwnKeys(value, room);
    if (keys.length <= room) return value;
    cut = true;
    /** @type {Record<string, unknown>} */
    const copy = {};
    const source = /** @type {Record<string, unknown>} */ (value);
    for (const k of keys.slice(0, room)) copy[k] = source[k];
    return copy;
  }
  try {
    const serialized = JSON.stringify(data, budgeted);
    if (typeof serialized !== 'string') return '';
    const marked = cut && !serialized.endsWith('…') ? `${serialized}…` : serialized;
    return marked.length > MAX_DATA_TEXT_CHARS ? truncate(marked, MAX_DATA_TEXT_CHARS) : marked;
  } catch {
    return '[unserializable]';
  }
}

/** @param {LiveLogEntry} entry */
function entryChars(entry) {
  return entry.msg.length + entry.dataText.length;
}

/**
 * @param {FeedWebContents} webContents
 * @param {LiveLogBatch} payload
 */
function defaultSend(webContents, payload) {
  // Lazy: ipcWrappers pulls in the IPC stack; only needed once a batch ships.
  const { safeSend } = require('../ipc/ipcWrappers');
  // TODO(live-activity Task 4): drop this cast once IPC_CHANNELS.SYSTEM
  // declares LIVE_LOG_BATCH; until then nothing subscribes, so it never runs.
  const channels = /** @type {Record<string, string>} */ (IPC_CHANNELS.SYSTEM);
  const target = /** @type {import('electron').WebContents} */ (
    /** @type {unknown} */ (webContents)
  );
  return safeSend(target, channels.LIVE_LOG_BATCH, payload);
}

/**
 * @param {LiveLogFeedDeps} [deps]
 */
function createLiveLogFeed(deps = {}) {
  const addListener = typeof deps.addListener === 'function' ? deps.addListener : () => {};
  const removeListener = typeof deps.removeListener === 'function' ? deps.removeListener : () => {};
  const classify = typeof deps.classify === 'function' ? deps.classify : activityFromLogRecord;
  const send = typeof deps.send === 'function' ? deps.send : defaultSend;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();

  /** Subscribed webContents -> the handler registered for DETACH_EVENTS. @type {Map<FeedWebContents, EventHandler>} */
  const subscribers = new Map();
  /** @type {LiveLogEntry[]} */
  let ring = [];
  /** @type {LiveLogEntry[]} */
  let pending = [];
  let pendingChars = 0;
  let dropped = 0;
  let seq = 0;
  let listening = false;
  /**
   * Last shown activity per kind + file: when it was buffered and its entry
   * id (still in the backlog while id >= the oldest surviving id).
   * @type {Map<string, { at: number, id: number }>}
   */
  let shownActivities = new Map();
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  /**
   * @param {LiveLogRecord} record
   * @returns {LiveLogEntry}
   */
  function toEntry(record) {
    const level = LEVELS.has(record.level) ? record.level : 'info';
    const msg = truncate(
      typeof record.msg === 'string' ? record.msg : String(record.msg ?? ''),
      MAX_MSG_CHARS
    );
    const context = truncate(
      typeof record.context === 'string' ? record.context : '',
      MAX_CONTEXT_CHARS
    );
    /** @type {LiveActivity | null} */
    let activity;
    try {
      activity = classify({ ...record, level, msg, context }) || null;
    } catch {
      activity = null;
    }
    const id = ++seq;
    if (activity && isMergedDuplicate(activity, id)) activity = null;
    return {
      id,
      time:
        typeof record.time === 'string'
          ? truncate(record.time, MAX_TIME_CHARS)
          : new Date(now()).toISOString(),
      level,
      context,
      msg,
      dataText: stringifyData(record.data),
      activity
    };
  }

  /**
   * True when this is a mergeable kind and the same kind + file was shown
   * within the merge window by an entry that survives this entry's push into
   * the backlog. Otherwise records this activity as shown.
   * @param {LiveActivity} activity
   * @param {number} id
   */
  function isMergedDuplicate(activity, id) {
    if (!MERGEABLE_KINDS.has(activity.kind)) return false;
    if (typeof activity.file !== 'string' || activity.file === '') return false;
    const key = `${activity.kind}\u0000${activity.file}`;
    const at = now();
    const previous = shownActivities.get(key);
    // Pushing this entry into a full ring evicts ring[0].
    const oldest = ring.length >= RING_CAPACITY ? ring[1] : ring[0];
    const oldestId = oldest ? oldest.id : id;
    if (previous && at - previous.at <= ACTIVITY_MERGE_WINDOW_MS && previous.id >= oldestId) {
      return true;
    }
    if (shownActivities.size >= MERGE_MEMORY_SOFT_LIMIT) {
      for (const [k, v] of shownActivities) {
        if (at - v.at > ACTIVITY_MERGE_WINDOW_MS || v.id < oldestId) shownActivities.delete(k);
      }
    }
    shownActivities.set(key, { at, id });
    return false;
  }

  /** @type {RecordListener} */
  function onRecord(record) {
    if (delivering || subscribers.size === 0 || !record) return;
    const entry = toEntry(record);
    ring.push(entry);
    if (ring.length > RING_CAPACITY) ring.shift();
    pending.push(entry);
    pendingChars += entryChars(entry);
    while (
      pending.length > 1 &&
      (pending.length > MAX_BATCH_ENTRIES || pendingChars > MAX_BATCH_CHARS)
    ) {
      const oldest = /** @type {LiveLogEntry} */ (pending.shift());
      pendingChars -= entryChars(oldest);
      dropped += 1;
    }
    if (!timer) {
      timer = setTimeout(flush, FLUSH_INTERVAL_MS);
      const handle = /** @type {{ unref?: () => void }} */ (/** @type {unknown} */ (timer));
      if (handle && typeof handle.unref === 'function') handle.unref();
    }
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.length === 0 && dropped === 0) return;
    /** @type {LiveLogBatch} */
    const payload = { entries: pending, dropped };
    pending = [];
    pendingChars = 0;
    dropped = 0;
    // Restore rather than clear: a flush nested inside another feed's send
    // must not lift that outer delivery's guard.
    const wasDelivering = delivering;
    delivering = true;
    try {
      for (const webContents of [...subscribers.keys()]) {
        if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) {
          unsubscribe(webContents);
          continue;
        }
        try {
          send(webContents, payload);
        } catch {
          // A failed send never affects logging or the other subscribers.
        }
      }
    } finally {
      delivering = wasDelivering;
    }
  }

  /** The newest backlog entries whose msg + dataText fit MAX_BATCH_CHARS. */
  function backlog() {
    let chars = 0;
    let start = ring.length;
    while (start > 0) {
      const size = entryChars(ring[start - 1]);
      if (chars + size > MAX_BATCH_CHARS && start < ring.length) break;
      chars += size;
      start -= 1;
    }
    return ring.slice(start);
  }

  /**
   * Subscribe a window. Returns the backlog (newest entries within the batch
   * character budget). Entries buffered but not yet flushed appear both in
   * this backlog and in the next batch, so consumers must dedupe by `id`.
   * Subscribing an already subscribed window only returns the backlog.
   * @param {FeedWebContents | null | undefined} webContents
   * @returns {{ entries: LiveLogEntry[] }}
   */
  function subscribe(webContents) {
    if (!webContents || typeof webContents.send !== 'function') return { entries: [] };
    if (!subscribers.has(webContents)) {
      const onDetach = () => unsubscribe(webContents);
      subscribers.set(webContents, onDetach);
      if (typeof webContents.on === 'function') {
        for (const event of DETACH_EVENTS) webContents.on(event, onDetach);
      }
    }
    if (!listening) {
      addListener(onRecord);
      listening = true;
    }
    return { entries: backlog() };
  }

  /** @param {FeedWebContents | null | undefined} webContents */
  function unsubscribe(webContents) {
    if (!webContents) return;
    const onDetach = subscribers.get(webContents);
    if (!onDetach) return;
    subscribers.delete(webContents);
    if (typeof webContents.removeListener === 'function') {
      for (const event of DETACH_EVENTS) {
        try {
          webContents.removeListener(event, onDetach);
        } catch {
          // A webContents mid-teardown may refuse; the subscriber is gone either way.
        }
      }
    }
    if (subscribers.size === 0) {
      if (listening) {
        removeListener(onRecord);
        listening = false;
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      ring = [];
      pending = [];
      pendingChars = 0;
      dropped = 0;
      shownActivities = new Map();
    }
  }

  function getStats() {
    return {
      subscribers: subscribers.size,
      listening,
      buffered: ring.length,
      pending: pending.length,
      timerActive: timer !== null
    };
  }

  return { subscribe, unsubscribe, flush, getStats };
}

/** @type {ReturnType<typeof createLiveLogFeed> | null} */
let instance = null;

/** The process-wide feed, wired to the shared logger's listener API. */
function getLiveLogFeed() {
  if (!instance) {
    const loggerModule = require('../../shared/logger');
    instance = createLiveLogFeed({
      addListener: loggerModule.addLiveRecordListener,
      removeListener: loggerModule.removeLiveRecordListener
    });
  }
  return instance;
}

module.exports = {
  createLiveLogFeed,
  getLiveLogFeed,
  RING_CAPACITY,
  FLUSH_INTERVAL_MS,
  MAX_BATCH_ENTRIES,
  MAX_BATCH_CHARS,
  MAX_MSG_CHARS,
  MAX_DATA_TEXT_CHARS,
  MAX_CONTEXT_CHARS,
  MAX_TIME_CHARS,
  ACTIVITY_MERGE_WINDOW_MS,
  MERGEABLE_KINDS
};
