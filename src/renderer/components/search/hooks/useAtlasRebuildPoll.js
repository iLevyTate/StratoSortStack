// @ts-check
/**
 * Re-ask for the Atlas projection while the main process says it is
 * rebuilding. No completion signal is pushed for that state, so without a
 * re-poll the overlay's "the map will refresh shortly" promise was a dead end.
 *
 * Each poll flips status rebuilding -> loading -> rebuilding, so the effect
 * re-arms once per cycle; the attempt count lives in a ref so the wait can
 * grow across those re-arms. It starts at REBUILD_POLL_BASE_MS and doubles up
 * to REBUILD_POLL_MAX_MS: a long rebuild (thousands of files) costs one cheap
 * request a minute instead of one every 3 s for as long as it runs. Nothing is
 * asked while the window is hidden; showing it again polls at once.
 */
import { useEffect, useRef } from 'react';

export const REBUILD_POLL_BASE_MS = 3000;
export const REBUILD_POLL_MAX_MS = 60000;

/**
 * @param {number} attempt Polls already made in this rebuild (0 for the first).
 * @returns {number}
 */
export function rebuildPollDelay(attempt) {
  return Math.min(REBUILD_POLL_MAX_MS, REBUILD_POLL_BASE_MS * 2 ** Math.max(0, attempt));
}

/**
 * @param {{ active: boolean, status: string, reload: () => any }} args
 */
export function useAtlasRebuildPoll({ active, status, reload }) {
  const attemptsRef = useRef(0);

  // A rebuild cycle ends when the status leaves rebuilding/loading (ready,
  // empty, error) or the tab is left; the next rebuild starts fast again.
  useEffect(() => {
    if (!active || (status !== 'rebuilding' && status !== 'loading')) {
      attemptsRef.current = 0;
    }
  }, [active, status]);

  useEffect(() => {
    if (!active || status !== 'rebuilding') return undefined;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    const isHidden = () => typeof document !== 'undefined' && document.hidden;

    const fire = () => {
      timer = null;
      // Hidden: wait for the visibility listener instead of polling.
      if (isHidden()) return;
      attemptsRef.current += 1;
      reload();
      // Normally the reload flips the status and this effect re-arms; the
      // chained timer covers an answer that leaves it at 'rebuilding'.
      timer = setTimeout(fire, rebuildPollDelay(attemptsRef.current));
    };
    const onVisibilityChange = () => {
      if (isHidden()) return;
      if (timer) clearTimeout(timer);
      fire();
    };

    timer = setTimeout(fire, rebuildPollDelay(attemptsRef.current));
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [active, status, reload]);
}
