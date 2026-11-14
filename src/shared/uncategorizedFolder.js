// @ts-check
/**
 * One test for "this is the Uncategorized catch-all", shared by main and the
 * renderer. Main seeds the folder with the name Uncategorized,
 * `category: 'uncategorized'` and `isDefault: true`. Older profiles may have
 * only the name; profiles where the user renamed it before the name was
 * locked keep the category and the default flag. Either one identifies it,
 * so a rename can never turn the catch-all into an ordinary, deletable
 * folder.
 *
 * The category alone is not enough: the AI enhancement for a new folder used
 * to be able to give a user's folder the category 'uncategorized', and that
 * folder must stay an ordinary folder.
 */

const UNCATEGORIZED_FOLDER_NAME = 'Uncategorized';
const UNCATEGORIZED_CATEGORY = 'uncategorized';

/**
 * @param {{ category?: unknown, name?: unknown, isDefault?: unknown } | null | undefined} folder
 * @returns {boolean}
 */
function isUncategorizedFolder(folder) {
  const category = typeof folder?.category === 'string' ? folder.category.trim().toLowerCase() : '';
  const name = typeof folder?.name === 'string' ? folder.name.trim().toLowerCase() : '';
  if (name === UNCATEGORIZED_CATEGORY) return true;
  return category === UNCATEGORIZED_CATEGORY && folder?.isDefault === true;
}

module.exports = { isUncategorizedFolder, UNCATEGORIZED_FOLDER_NAME, UNCATEGORIZED_CATEGORY };
