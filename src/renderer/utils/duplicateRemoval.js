// @ts-check
/**
 * Organized-file entries for a file that was not moved because its
 * destination folder already held an identical copy. useOrganization sets
 * `duplicateRemoval` on those entries; their `path` is the copy that was kept.
 */

/**
 * @param {any} file - an organized-file entry
 * @returns {boolean}
 */
export function isRemovedDuplicate(file) {
  return Boolean(file && typeof file === 'object' && file.duplicateRemoval);
}

/**
 * What became of a removed duplicate, or '' for a file that was moved.
 * @param {any} file - an organized-file entry
 * @returns {string}
 */
export function describeDuplicateRemoval(file) {
  if (!isRemovedDuplicate(file)) return '';
  return file.duplicateRemoval === 'trashed'
    ? 'This copy is in the system Trash.'
    : 'This copy was removed.';
}
