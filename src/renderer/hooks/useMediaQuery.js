// @ts-check
import { useSyncExternalStore } from 'react';

/**
 * Subscribe a component to a CSS media query.
 *
 * Returns the current `matches` boolean and re-renders when it flips.
 * Uses `useSyncExternalStore` for tear-free reads under concurrent
 * rendering — preferable to manual useState + useEffect when many
 * components subscribe to the same query (which they do once we use
 * this for responsive collapse across the app).
 *
 * Safe under SSR / non-browser environments: returns `false` when
 * `window.matchMedia` isn't available.
 */
function getServerSnapshot() {
  return false;
}

export function useMediaQuery(/** @type {any} */ query) {
  const subscribe = (/** @type {any} */ onChange) => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return () => {};
    }
    let mql;
    try {
      mql = window.matchMedia(query);
    } catch {
      return () => {};
    }
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    if (typeof mql.addListener === 'function') {
      mql.addListener(onChange);
      return () => mql.removeListener(onChange);
    }
    return () => {};
  };

  const getSnapshot = () => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    try {
      return window.matchMedia(query).matches === true;
    } catch {
      return false;
    }
  };

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
