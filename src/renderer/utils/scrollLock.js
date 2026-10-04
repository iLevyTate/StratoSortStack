// @ts-check
// Ref-counted app-scroll lock with per-surface scoping.
//
// We lock two logical surfaces independently so the permanent splash
// "route scroll through main-content" lock can hold <html>/<body> without
// also freezing <main> (which is the app's designated scroll container
// via Tailwind's `overflow-y-auto`):
//
//   - 'root' surface  = <html> + <body>, locked together
//   - 'main' surface  = #main-content
//
// Each surface has its own ref-count and its own saved-inline-overflow
// snapshot, so overlapping locks with different scopes compose correctly.
// Passing a stable lockId makes repeated calls from the same owner
// idempotent; anonymous callers (no id) keep the legacy "freeze
// everything" semantics so older call sites are unaffected.

const SURFACES = Object.freeze(['root', 'main']);

/** @type {Map<string, Set<string>>} */
const namedLocks = new Map(); // lockId -> Set<surface>
/** @type {Record<string, number>} */
const anonymousCounts = { root: 0, main: 0 };
/** @type {Record<string, number>} */
const namedCounts = { root: 0, main: 0 };
/** @type {Record<string, string>} */
const savedOverflow = { html: '', body: '', main: '' };

function normalizeLockId(/** @type {any} */ lockId) {
  return typeof lockId === 'string' && lockId.trim().length > 0 ? lockId : null;
}

function getTotalCount(/** @type {any} */ surface) {
  return namedCounts[surface] + anonymousCounts[surface];
}

function applySurfaceLock(/** @type {any} */ surface) {
  if (surface === 'root') {
    savedOverflow.html = document.documentElement.style.overflow || '';
    savedOverflow.body = document.body.style.overflow || '';
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return;
  }
  if (surface === 'main') {
    const mainContent = document.getElementById('main-content');
    savedOverflow.main = mainContent?.style.overflow || '';
    if (mainContent) mainContent.style.overflow = 'hidden';
  }
}

function releaseSurfaceLock(/** @type {any} */ surface) {
  if (surface === 'root') {
    document.documentElement.style.overflow = savedOverflow.html || '';
    document.body.style.overflow = savedOverflow.body || '';
    return;
  }
  if (surface === 'main') {
    const mainContent = document.getElementById('main-content');
    if (mainContent) mainContent.style.overflow = savedOverflow.main || '';
  }
}

/**
 * Acquire a ref-counted scroll lock.
 *
 * @param {string | null | undefined} lockId
 *   Stable identifier for idempotency. Repeat calls with the same id are
 *   no-ops until the matching unlockAppScroll(id).
 * @param {{ includeMain?: boolean }} [options]
 *   includeMain (default true): also lock #main-content. Pass false when
 *   you only want to keep <html>/<body> from scrolling (e.g. the permanent
 *   splash root lock) while letting <main> remain the app's scroll
 *   container. Modals/panels should leave this at the default so the
 *   background is fully frozen while they're open.
 */
export function lockAppScroll(lockId, options) {
  if (typeof document === 'undefined') return;

  const includeMain = !(options && options.includeMain === false);
  const surfaces = includeMain ? SURFACES : ['root'];
  const normalizedLockId = normalizeLockId(lockId);

  if (normalizedLockId) {
    if (namedLocks.has(normalizedLockId)) return;
    namedLocks.set(normalizedLockId, new Set(surfaces));
    for (const surface of surfaces) namedCounts[surface] += 1;
  } else {
    for (const surface of surfaces) anonymousCounts[surface] += 1;
  }

  for (const surface of surfaces) {
    if (getTotalCount(surface) === 1) applySurfaceLock(surface);
  }
}

/**
 * Release a previously acquired scroll lock. For named locks we restore
 * the exact set of surfaces the lock had taken; anonymous unlocks
 * decrement the default (root + main) scope to match legacy semantics.
 */
export function unlockAppScroll(/** @type {any} */ lockId) {
  if (typeof document === 'undefined') return;
  const normalizedLockId = normalizeLockId(lockId);

  let surfaces;
  if (normalizedLockId) {
    const entry = namedLocks.get(normalizedLockId);
    if (!entry) return;
    namedLocks.delete(normalizedLockId);
    surfaces = [...entry];
    for (const surface of surfaces) namedCounts[surface] -= 1;
  } else {
    surfaces = [];
    for (const surface of SURFACES) {
      if (anonymousCounts[surface] > 0) {
        anonymousCounts[surface] -= 1;
        surfaces.push(surface);
      }
    }
    if (surfaces.length === 0) return;
  }

  for (const surface of surfaces) {
    if (getTotalCount(surface) === 0) releaseSurfaceLock(surface);
  }
}
