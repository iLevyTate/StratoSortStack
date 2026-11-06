// @ts-check
/**
 * Renderer side of the Live Activity feed (src/main/services/liveLogFeed.js).
 *
 * Subscribes while `enabled` (the panel stays subscribed when minimized so
 * its activity dot keeps working), merges the backlog and pushed batches by
 * entry id, keeps at most MAX_RENDERER_ENTRIES, and while paused holds new
 * entries aside (counted, not shown; the held list and its count both stop
 * at MAX_RENDERER_ENTRIES) until resume. Unsubscribes on unmount.
 * Supports one consumer per window: main keeps one subscription per window,
 * so a second mounted hook's unmount would end the first one's feed.
 *
 * Ordering:
 * - The batch listener is registered before subscribing, so a batch pushed
 *   before the subscribe reply is kept; it is applied after the backlog
 *   (ids only grow, so the backlog must go first) and overlaps are dropped
 *   by id.
 * - A new subscription waits for the previous one's unsubscribe to settle
 *   (`previousRelease`, shared by every mount), so a fresh view never
 *   inherits the old one's dropped carry, and an unmount while subscribe is
 *   pending unsubscribes once it settles. Batches that arrive during that
 *   wait belong to the old subscription (they share one ordered IPC pipe
 *   with the unsubscribe reply) and are ignored.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { systemIpc } from '../services/ipc';

/**
 * The entry shape is the batch payload built by the main-process feed.
 * @typedef {import('../../main/services/liveLogFeed').LiveLogEntry} LiveLogEntry
 * @typedef {import('../../main/services/liveLogFeed').LiveActivity} LiveActivity
 * @typedef {'idle' | 'connecting' | 'live' | 'unavailable'} LiveFeedStatus
 * @typedef {{ entries: unknown[], dropped: number }} ValidBatch
 */

export const MAX_RENDERER_ENTRIES = 500;
export const RECENT_ACTIVITY_MS = 3000;

/**
 * Settles when the last mount's subscription has been released (its
 * unsubscribe resolved or failed). Never rejects.
 * @type {Promise<void>}
 */
let previousRelease = Promise.resolve();

function noop() {}

/** Test hook: forget any release still pending from an earlier test. */
export function __resetLiveLogFeedForTests() {
  previousRelease = Promise.resolve();
}

/**
 * Best-effort unsubscribe that never throws or rejects.
 * @returns {Promise<void>}
 */
function releaseSubscription() {
  try {
    return Promise.resolve(systemIpc.unsubscribeLiveLog()).then(noop, noop);
  } catch {
    return Promise.resolve();
  }
}

/**
 * A pushed batch is validated only in main; anything without an entries
 * array and a non-negative dropped count is not a batch.
 * @param {unknown} payload
 * @returns {ValidBatch | null}
 */
function asBatch(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const { entries, dropped } = /** @type {{ entries?: unknown, dropped?: unknown }} */ (payload);
  if (!Array.isArray(entries)) return null;
  if (typeof dropped !== 'number' || !Number.isFinite(dropped) || dropped < 0) return null;
  return { entries, dropped };
}

/**
 * Entries with an id above `lastSeenId`, in arrival order.
 * @param {unknown} incoming
 * @param {number} lastSeenId
 * @returns {{ fresh: LiveLogEntry[], lastSeenId: number }}
 */
export function selectFreshEntries(incoming, lastSeenId) {
  /** @type {LiveLogEntry[]} */
  const fresh = [];
  let seen = lastSeenId;
  if (!Array.isArray(incoming)) return { fresh, lastSeenId: seen };
  for (const candidate of incoming) {
    if (
      candidate &&
      typeof candidate === 'object' &&
      typeof candidate.id === 'number' &&
      candidate.id > seen
    ) {
      fresh.push(/** @type {LiveLogEntry} */ (candidate));
      seen = candidate.id;
    }
  }
  return { fresh, lastSeenId: seen };
}

/**
 * @param {LiveLogEntry[]} list
 * @param {number} [max]
 * @returns {LiveLogEntry[]}
 */
export function capEntries(list, max = MAX_RENDERER_ENTRIES) {
  return list.length > max ? list.slice(list.length - max) : list;
}

/**
 * @param {{ enabled?: boolean }} [options]
 */
export function useLiveLogFeed({ enabled = true } = {}) {
  const [entries, setEntries] = useState(/** @type {LiveLogEntry[]} */ ([]));
  const [status, setStatus] = useState(
    /** @type {LiveFeedStatus} */ (enabled ? 'connecting' : 'idle')
  );
  const [paused, setPaused] = useState(false);
  const [pausedCount, setPausedCount] = useState(0);
  const [dropped, setDropped] = useState(0);
  const [recentlyActive, setRecentlyActive] = useState(false);

  const pausedRef = useRef(false);
  const lastSeenIdRef = useRef(-1);
  const heldRef = useRef(/** @type {LiveLogEntry[]} */ ([]));
  /** Batches pushed before the subscribe reply; emptied by clear(). */
  const earlyRef = useRef(/** @type {ValidBatch[]} */ ([]));
  const activityTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));

  const markActive = useCallback(() => {
    setRecentlyActive(true);
    if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
    activityTimerRef.current = setTimeout(() => {
      activityTimerRef.current = null;
      setRecentlyActive(false);
    }, RECENT_ACTIVITY_MS);
  }, []);

  const receive = useCallback(
    (/** @type {unknown} */ incoming, /** @type {number} */ droppedCount) => {
      if (droppedCount > 0) setDropped((total) => total + droppedCount);
      const { fresh, lastSeenId } = selectFreshEntries(incoming, lastSeenIdRef.current);
      if (fresh.length === 0) return;
      lastSeenIdRef.current = lastSeenId;
      markActive();
      if (pausedRef.current) {
        heldRef.current = capEntries(heldRef.current.concat(fresh));
        setPausedCount((count) => Math.min(MAX_RENDERER_ENTRIES, count + fresh.length));
        return;
      }
      setEntries((list) => capEntries(list.concat(fresh)));
    },
    [markActive]
  );

  const pause = useCallback(() => {
    pausedRef.current = true;
    setPaused(true);
  }, []);

  const resume = useCallback(() => {
    pausedRef.current = false;
    setPaused(false);
    const held = heldRef.current;
    heldRef.current = [];
    setPausedCount(0);
    if (held.length > 0) setEntries((list) => capEntries(list.concat(held)));
  }, []);

  const clear = useCallback(() => {
    heldRef.current = [];
    earlyRef.current.length = 0;
    setEntries([]);
    setPausedCount(0);
    setDropped(0);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      return undefined;
    }
    let cancelled = false;
    let ready = false;
    /** @type {Promise<unknown> | null} */
    let subscribing = null;
    let settled = false;
    /** @type {ValidBatch[]} */
    const early = [];
    earlyRef.current = early;
    setStatus('connecting');

    /** @type {() => void} */
    let off = noop;
    try {
      off = systemIpc.onLiveLogBatch((/** @type {unknown} */ payload) => {
        // Never throw from here: preload logs a throwing handler, that log
        // line comes back as a feed entry, and the handler runs again.
        try {
          if (cancelled) return;
          // Still waiting on the previous release: this batch is the old
          // subscription's.
          if (!subscribing) return;
          const batch = asBatch(payload);
          if (!batch) return;
          if (!ready) {
            early.push(batch);
            return;
          }
          receive(batch.entries, batch.dropped);
        } catch {
          // Swallowed on purpose (see above).
        }
      });
    } catch {
      setStatus('unavailable');
      return () => {
        cancelled = true;
      };
    }

    const start = async () => {
      await previousRelease;
      if (cancelled) return;
      subscribing = Promise.resolve().then(() => systemIpc.subscribeLiveLog());
      try {
        const reply = /** @type {{ entries?: unknown }} */ (await subscribing);
        settled = true;
        if (cancelled) return;
        receive(reply?.entries, 0);
        ready = true;
        for (const batch of early.splice(0)) receive(batch.entries, batch.dropped);
        setStatus('live');
      } catch {
        settled = true;
        if (!cancelled) setStatus('unavailable');
      }
    };
    start();

    return () => {
      cancelled = true;
      early.length = 0;
      try {
        off();
      } catch {
        // The bridge is going away with us; nothing to undo.
      }
      const pending = subscribing;
      if (!pending) return; // Never subscribed (still waiting on the previous release).
      previousRelease = settled
        ? releaseSubscription()
        : pending.then(releaseSubscription, releaseSubscription);
    };
  }, [enabled, receive]);

  useEffect(
    () => () => {
      if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
      activityTimerRef.current = null;
    },
    []
  );

  return {
    entries,
    status,
    paused,
    pausedCount,
    dropped,
    recentlyActive,
    pause,
    resume,
    clear
  };
}
