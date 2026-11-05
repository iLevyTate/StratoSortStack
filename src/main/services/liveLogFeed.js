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
 *   MAX_BATCH_ENTRIES per batch (oldest dropped first, counted in `dropped`).
 * - A destroyed webContents unsubscribes itself.
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
const MAX_MSG_CHARS = 2000;
const MAX_DATA_TEXT_CHARS = 4000;
const MAX_CONTEXT_CHARS = 120;
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

/**
 * @typedef {import('../../shared/logger').LiveLogRecord} LiveLogRecord
 * @typedef {import('./liveLogActivity').LiveActivity} LiveActivity
 * @typedef {{ id: number, time: string, level: string, context: string, msg: string, dataText: string, activity: LiveActivity | null }} LiveLogEntry
 * @typedef {{ entries: LiveLogEntry[], dropped: number }} LiveLogBatch
 * @typedef {(record: LiveLogRecord) => void} RecordListener
 * @typedef {object} LiveLogFeedDeps
 * @property {(listener: RecordListener) => void} [addListener]
 * @property {(listener: RecordListener) => void} [removeListener]
 * @property {(record: LiveLogRecord) => (LiveActivity | null)} [classify]
 * @property {(webContents: any, payload: LiveLogBatch) => unknown} [send]
 * @property {() => number} [now] Clock for the activity merge window (ms).
 */

/**
 * True while any feed is delivering a batch. Module-wide so a record logged
 * by one feed's send (safeSend warns / errors synchronously) never enters
 * any feed's buffer and comes back as another send.
 */
let delivering = false;

/**
 * @param {string} value
 * @param {number} max
 */
function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** @param {unknown} data */
function stringifyData(data) {
  if (data === undefined || data === null) return '';
  try {
    const serialized = JSON.stringify(data);
    return typeof serialized === 'string' ? truncate(serialized, MAX_DATA_TEXT_CHARS) : '';
  } catch {
    return '[unserializable]';
  }
}

/**
 * @param {any} webContents
 * @param {LiveLogBatch} payload
 */
function defaultSend(webContents, payload) {
  // Lazy: ipcWrappers pulls in the IPC stack; only needed once a batch ships.
  const { safeSend } = require('../ipc/ipcWrappers');
  // TODO(live-activity Task 4): drop this cast once IPC_CHANNELS.SYSTEM
  // declares LIVE_LOG_BATCH; until then nothing subscribes, so it never runs.
  const channels = /** @type {Record<string, string>} */ (IPC_CHANNELS.SYSTEM);
  return safeSend(webContents, channels.LIVE_LOG_BATCH, payload);
}

/**
 * @param {LiveLogFeedDeps} [deps]
 */
function createLiveLogFeed(deps = {}) {
  const addListener = typeof deps.addListener === 'function' ? deps.addListener : () => {};
  const removeListener = typeof deps.removeListener === 'function' ? deps.removeListener : () => {};
  const classify = typeof deps.classify === 'function' ? deps.classify : activityFromLogRecord;
  const send = typeof deps.send === 'function' ? deps.send : defaultSend;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;

  /** @type {Map<any, () => void>} */
  const subscribers = new Map();
  /** @type {LiveLogEntry[]} */
  let ring = [];
  /** @type {LiveLogEntry[]} */
  let pending = [];
  let dropped = 0;
  let seq = 0;
  let listening = false;
  /**
   * Last shown activity per kind + file: when it was buffered and its entry
   * id (still in the backlog while id >= ring[0].id).
   * @type {Map<string, { at: number, id: number }>}
   */
  let shownActivities = new Map();
  /** @type {any} */
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
      time: typeof record.time === 'string' ? record.time : new Date().toISOString(),
      level,
      context,
      msg,
      dataText: stringifyData(record.data),
      activity
    };
  }

  /**
   * True when this is a mergeable kind and the same kind + file was shown
   * within the merge window by an entry still in the backlog. Otherwise records this activity as shown.
   * @param {LiveActivity} activity
   * @param {number} id
   */
  function isMergedDuplicate(activity, id) {
    if (!MERGEABLE_KINDS.has(activity.kind)) return false;
    if (typeof activity.file !== 'string' || activity.file === '') return false;
    const key = `${activity.kind}\u0000${activity.file}`;
    const at = now();
    const previous = shownActivities.get(key);
    const oldestId = ring.length > 0 ? ring[0].id : Infinity;
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
    if (pending.length > MAX_BATCH_ENTRIES) {
      pending.shift();
      dropped += 1;
    }
    if (!timer) {
      timer = setTimeout(flush, FLUSH_INTERVAL_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
  }

  function flush() {
    timer = null;
    if (pending.length === 0 && dropped === 0) return;
    /** @type {LiveLogBatch} */
    const payload = { entries: pending, dropped };
    pending = [];
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

  /**
   * @param {any} webContents
   * @returns {{ entries: LiveLogEntry[] }}
   */
  function subscribe(webContents) {
    if (!webContents || typeof webContents.send !== 'function') return { entries: [] };
    if (!subscribers.has(webContents)) {
      const onDestroyed = () => unsubscribe(webContents);
      subscribers.set(webContents, onDestroyed);
      if (typeof webContents.once === 'function') webContents.once('destroyed', onDestroyed);
    }
    if (!listening) {
      addListener(onRecord);
      listening = true;
    }
    return { entries: ring.slice() };
  }

  /** @param {any} webContents */
  function unsubscribe(webContents) {
    const onDestroyed = subscribers.get(webContents);
    if (!onDestroyed) return;
    subscribers.delete(webContents);
    if (typeof webContents.removeListener === 'function') {
      try {
        webContents.removeListener('destroyed', onDestroyed);
      } catch {
        // A webContents mid-teardown may refuse; the subscriber is gone either way.
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
  MAX_MSG_CHARS,
  MAX_DATA_TEXT_CHARS,
  ACTIVITY_MERGE_WINDOW_MS,
  MERGEABLE_KINDS
};
