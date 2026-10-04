// @ts-check

/**
 * Dispatch a cancelable window CustomEvent and retry until a listener
 * acknowledges it by calling preventDefault(), or attempts run out.
 *
 * Bridges the dashboard/menu → DiscoverPhase gap: DashboardView and
 * DiscoverPhase are never mounted together, and DiscoverPhase is a lazy
 * chunk — after navigation its listeners may not exist yet, so a single
 * fixed-delay dispatch silently goes nowhere on a cold renderer or slow
 * disk. `dispatchEvent` returns false exactly when a listener called
 * preventDefault(), which doubles as the "someone heard this" ack.
 *
 * @param {string} eventName
 * @param {{ detail?: any, intervalMs?: number, maxAttempts?: number }} [opts]
 * @returns {() => void} cancel function (stops further retries)
 */
export function dispatchAcked(eventName, { detail, intervalMs = 100, maxAttempts = 30 } = {}) {
  let attempts = 0;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  const tryDispatch = () => {
    attempts += 1;
    const unhandled = window.dispatchEvent(
      new CustomEvent(eventName, { detail, cancelable: true })
    );
    if (!unhandled || attempts >= maxAttempts) return;
    timer = setTimeout(tryDispatch, intervalMs);
  };
  // Attempt synchronously first: when the listener is already mounted
  // (dispatch from within the same phase) this behaves exactly like a plain
  // dispatchEvent; otherwise the retries cover the lazy-chunk mount window.
  tryDispatch();
  return () => {
    if (timer) clearTimeout(timer);
  };
}
