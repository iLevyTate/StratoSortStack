// @ts-check
/**
 * One definition of "the user has somewhere for files to go", shared by
 * Welcome, Setup, App (dashboard gate) and the navigation bar.
 *
 * Main seeds an Uncategorized folder on every profile and refuses to delete
 * it, so the smart-folder list is never empty. That folder is the catch-all
 * for files that match nothing; it is not a destination. Any other folder is,
 * including the built-in defaults that "Reset to Defaults" creates (all of
 * them carry `isDefault`, so `isDefault` is not the test).
 */

import { isUncategorizedFolder } from '../../shared/uncategorizedFolder';

/**
 * The catch-all folder: named Uncategorized, or the seeded default
 * (`isDefault`) with `category: 'uncategorized'`. The same test main uses, so
 * both sides agree on which folder it is even after an older build let it be
 * renamed.
 */
export const isUncategorizedBucket = isUncategorizedFolder;

/**
 * Number of smart folders that are real destinations (everything except the
 * Uncategorized catch-all).
 * @param {unknown} folders
 * @returns {number}
 */
export function countDestinationFolders(folders) {
  if (!Array.isArray(folders)) return 0;
  return folders.filter((folder) => folder && !isUncategorizedFolder(folder)).length;
}

/**
 * True once at least one real destination exists.
 * @param {unknown} folders
 * @returns {boolean}
 */
export function hasDestinationFolder(folders) {
  return (
    Array.isArray(folders) && folders.some((folder) => folder && !isUncategorizedFolder(folder))
  );
}
