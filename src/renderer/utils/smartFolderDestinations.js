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

/**
 * The catch-all folder: `category: 'uncategorized'` on the canonical one, or
 * named Uncategorized.
 * @param {{ category?: unknown, name?: unknown } | null | undefined} folder
 * @returns {boolean}
 */
export function isUncategorizedBucket(folder) {
  const category = typeof folder?.category === 'string' ? folder.category.toLowerCase() : '';
  const name = typeof folder?.name === 'string' ? folder.name.trim().toLowerCase() : '';
  return category === 'uncategorized' || name === 'uncategorized';
}

/**
 * Number of smart folders that are real destinations (everything except the
 * Uncategorized catch-all).
 * @param {unknown} folders
 * @returns {number}
 */
export function countDestinationFolders(folders) {
  if (!Array.isArray(folders)) return 0;
  return folders.filter((folder) => folder && !isUncategorizedBucket(folder)).length;
}

/**
 * True once at least one real destination exists.
 * @param {unknown} folders
 * @returns {boolean}
 */
export function hasDestinationFolder(folders) {
  return (
    Array.isArray(folders) && folders.some((folder) => folder && !isUncategorizedBucket(folder))
  );
}
