// @ts-check
/**
 * Duplicate sets the user chose to "Keep all". Stored per machine; a set whose
 * membership changes (a new copy appears) has a new signature and shows again.
 *
 * Shared by the resolution dialog, which writes the list, and the graph tab's
 * insight badge, which must not keep counting sets the user already kept.
 */
import { normalizeDuplicateMember } from '../../../shared/memberPathUtils';

export const DISMISSED_STORAGE_KEY = 'stratosort_dismissed_duplicate_groups';
const MAX_DISMISSED = 500;

/** @param {{ members: Array<{ path?: string | null, id?: string }> }} group */
export function duplicateGroupSignature(group) {
  return group.members
    .map((member) => String(member.path || member.id || ''))
    .sort()
    .join('\u0000');
}

/**
 * The signature of a group exactly as the scan returns it, computed the way
 * the dialog does after normalizing its members, so both agree on which sets
 * were kept.
 * @param {any} group
 * @returns {string}
 */
export function signatureForScannedGroup(group) {
  const members = Array.isArray(group) ? group : Array.isArray(group?.members) ? group.members : [];
  const normalized = members
    .map((/** @type {any} */ member, /** @type {number} */ index) =>
      normalizeDuplicateMember(member, index, group?.id)
    )
    .filter((/** @type {any} */ member) => Boolean(member.id));
  return duplicateGroupSignature({ members: normalized });
}

/** @returns {Set<string>} */
export function loadDismissed() {
  try {
    const raw = window.localStorage.getItem(DISMISSED_STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((v) => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

/** @param {Set<string>} dismissed */
export function saveDismissed(dismissed) {
  try {
    const list = [...dismissed].slice(-MAX_DISMISSED);
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable: the choice holds for this session only.
  }
}
