// @ts-check
/**
 * One short hash of what the user's Smart Folders say: each folder's name,
 * description and path. The AI reads exactly these to pick a folder, so two
 * folder sets with the same hash route files the same way, and any edit to a
 * name, a description or a location gives a new hash.
 *
 * Used by the renderer for two things:
 * - the sample run before a large batch (remembered per hash, so the offer
 *   comes back only after the folders change), and
 * - stale-result detection in Organize (each analysis is stamped with the
 *   hash it was made under; a different current hash means the folder it
 *   picked came from the old definitions).
 *
 * Order does not matter, and surrounding spaces, the path separator style
 * and a trailing separator are ignored. Ids and keywords are left out: a
 * folder recreated with the same words is the same definition.
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizePath(value) {
  return text(value).replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * cyrb53: a small, fast 53-bit string hash. Not for security, only to tell
 * two folder sets apart without storing their full text.
 * @param {string} input
 * @returns {string} 14 hex characters
 */
function cyrb53(input) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return value.toString(16).padStart(14, '0');
}

/**
 * @param {unknown} folders - the Smart Folder list
 * @returns {string} '' when there are no folders, else 'sf-' and 14 hex characters
 */
function getFolderDefinitionsHash(folders) {
  if (!Array.isArray(folders)) return '';
  const entries = [];
  for (const folder of folders) {
    if (!folder || typeof folder !== 'object') continue;
    const record = /** @type {Record<string, unknown>} */ (folder);
    const name = text(record.name);
    const path = normalizePath(record.path);
    if (!name && !path) continue;
    entries.push(JSON.stringify([name, text(record.description), path]));
  }
  if (entries.length === 0) return '';
  entries.sort();
  return `sf-${cyrb53(entries.join('\n'))}`;
}

module.exports = { getFolderDefinitionsHash };
