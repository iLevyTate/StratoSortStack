// @ts-check
/**
 * Small helpers for request-version guards.
 * Use with useRef(0) counters to prevent stale async responses
 * from applying state updates after newer requests have started.
 */

export function nextRequestId(/** @type {any} */ counterRef) {
  counterRef.current += 1;
  return counterRef.current;
}

export function isCurrentRequest(/** @type {any} */ counterRef, /** @type {any} */ requestId) {
  return counterRef.current === requestId;
}

export function invalidateRequests(/** @type {any} */ counterRef) {
  counterRef.current += 1;
  return counterRef.current;
}
