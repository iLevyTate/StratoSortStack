// @ts-check
/**
 * Compact durable index of paths that have already been organized.
 *
 * Rich `organizedFiles` history is capped when persisted (localStorage budget).
 * After a large organize + restart, Discover used that truncated history to
 * decide what is still "waiting", so already-moved files reappeared as work.
 * This index stores only canonical path strings (original + destination) so
 * thousands of organized files survive persistence without blowing the quota.
 */

import { toCanonicalPath } from './canonicalPath';

/** Soft ceiling for persisted path keys (~string array; much cheaper than file objects). */
export const MAX_ORGANIZED_PATH_INDEX = 8000;

/**
 * Collect canonical path keys from one or more organized-file entries.
 * @param {any} entries
 * @returns {string[]}
 */
export function collectOrganizedPathKeys(entries) {
  /** @type {string[]} */
  const keys = [];
  if (!Array.isArray(entries)) return keys;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    for (const value of [entry.originalPath, entry.path, entry.currentPath]) {
      const key = toCanonicalPath(value);
      if (key) keys.push(key);
    }
  }
  return keys;
}

/**
 * Merge new organized path keys into an existing index (deduped, capped).
 * Oldest keys drop first when over the ceiling so recent organizes are kept.
 * @param {any} existing
 * @param {any} incomingKeys
 * @param {{ max?: number }} [options]
 * @returns {string[]}
 */
export function mergeOrganizedPathIndex(existing, incomingKeys, options = {}) {
  const max =
    Number.isFinite(options.max) && /** @type {number} */ (options.max) > 0
      ? /** @type {number} */ (options.max)
      : MAX_ORGANIZED_PATH_INDEX;

  /** @type {string[]} */
  const ordered = [];
  const seen = new Set();

  const pushAll = (/** @type {any} */ list) => {
    if (!Array.isArray(list)) return;
    for (const value of list) {
      const key = toCanonicalPath(value);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      ordered.push(key);
    }
  };

  pushAll(existing);
  pushAll(incomingKeys);

  if (ordered.length <= max) return ordered;
  return ordered.slice(-max);
}

/**
 * Remove path keys from the index.
 * @param {any} existing
 * @param {any} keysToRemove
 * @returns {string[]}
 */
export function removeFromOrganizedPathIndex(existing, keysToRemove) {
  if (!Array.isArray(existing) || existing.length === 0) {
    return Array.isArray(existing) ? existing : [];
  }
  const removeSet = new Set(
    (Array.isArray(keysToRemove) ? keysToRemove : [])
      .map((value) => toCanonicalPath(value))
      .filter(Boolean)
  );
  if (removeSet.size === 0) return existing;
  return existing.filter((key) => !removeSet.has(key));
}

/**
 * Normalize a persisted/hydrated index into a clean string array.
 * @param {any} value
 * @param {{ max?: number }} [options]
 * @returns {string[]}
 */
export function normalizeOrganizedPathIndex(value, options = {}) {
  return mergeOrganizedPathIndex([], value, options);
}
