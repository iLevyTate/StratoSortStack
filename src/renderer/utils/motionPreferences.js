// @ts-check
import { useSyncExternalStore } from 'react';

/**
 * Canonical helpers for respecting `prefers-reduced-motion: reduce`.
 *
 * Historically only `PhaseRenderer` consulted framer-motion's
 * `useReducedMotion` and `getScrollBehavior` was a stand-alone helper. That
 * left modals, side panels, and any JS-driven animation timing (e.g. the
 * 140 ms close-out timer in `Modal`) blind to the OS-level preference — they
 * relied purely on CSS `@media (prefers-reduced-motion: reduce)` rules,
 * which cannot shorten JavaScript `setTimeout` durations.
 *
 * This module is the single source of truth for both the synchronous check
 * and the React hook, so every component — phase shell, modals, spinners,
 * scrolls — gets the same answer and the same reactive updates.
 */

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function getMediaQueryList() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null;
  }
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY);
  } catch {
    return null;
  }
}

/**
 * Synchronous read. Safe to call from event handlers, effects, and SSR
 * (returns `false` outside the browser).
 */
export function prefersReducedMotion() {
  const mql = getMediaQueryList();
  return mql ? mql.matches === true : false;
}

function subscribeToReducedMotion(/** @type {any} */ onChange) {
  const mql = getMediaQueryList();
  if (!mql) return () => {};

  // Some older Safari builds still only expose the legacy `addListener` API.
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }
  if (typeof mql.addListener === 'function') {
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }
  return () => {};
}

function getReducedMotionSnapshot() {
  return prefersReducedMotion();
}

function getReducedMotionServerSnapshot() {
  return false;
}

/**
 * React hook that returns the current value of `prefers-reduced-motion`
 * and re-renders when the user toggles the OS setting at runtime.
 *
 * Prefer this over framer-motion's `useReducedMotion` in non-framer code
 * so we don't force components to import the animation library solely for
 * the hook.
 */
export function useReducedMotion() {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot
  );
}

export function getScrollBehavior() {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}

/**
 * Read a CSS motion-duration custom property from `:root` and return it as
 * milliseconds. Falls back to `fallbackMs` when the property is missing or
 * cannot be parsed (e.g. SSR, very early during boot, or a renamed token).
 *
 * Used by JavaScript timers that must mirror CSS animation durations — e.g.
 * `Modal`'s exit-animation cleanup `setTimeout`. Reading on each call (rather
 * than memoizing at module load) keeps the value in lockstep with HMR token
 * edits and any runtime stylesheet swaps without forcing a refresh.
 *
 * Token names map: 'fast' → --motion-duration-fast, 'standard' →
 * --motion-duration-standard, 'slow' → --motion-duration-slow. Anything else
 * is treated as a literal property name (caller passes the full `--name`).
 */
export function getMotionDurationMs(/** @type {any} */ token, /** @type {any} */ fallbackMs) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return fallbackMs;
  }
  const propName = token.startsWith('--') ? token : `--motion-duration-${token}`;
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(propName).trim();
    if (!raw) return fallbackMs;
    // Values look like '220ms' or (rarely) '0.22s'. Parse both.
    if (raw.endsWith('ms')) {
      const ms = Number.parseFloat(raw);
      return Number.isFinite(ms) ? ms : fallbackMs;
    }
    if (raw.endsWith('s')) {
      const s = Number.parseFloat(raw);
      return Number.isFinite(s) ? s * 1000 : fallbackMs;
    }
    const numeric = Number.parseFloat(raw);
    return Number.isFinite(numeric) ? numeric : fallbackMs;
  } catch {
    return fallbackMs;
  }
}
