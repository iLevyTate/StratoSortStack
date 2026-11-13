// @ts-check
/**
 * Which Smart Folders an analysis prompt lists.
 *
 * Kept apart from folderUtils (path and category-mapping helpers) so both
 * analysis prompts depend on this one small module.
 *
 * @module shared/promptFolders
 */

const { TRUNCATION } = require('./performanceConstants');
const { isUncategorizedFolder } = require('./uncategorizedFolder');

// Same conservative estimate the document prompt budget uses.
const CHARS_PER_TOKEN = 3;
// What the prompt prints for a folder without a description.
const NO_DESCRIPTION = 'no description provided';

/**
 * Ensure value is an array.
 * @param {any} val
 * @returns {any[]}
 */
function ensureArray(val) {
  if (Array.isArray(val)) return val;
  if (val == null) return [];
  return [val];
}

/**
 * True for the built-in catch-all folder the prompt tells the model to fall
 * back to ("return Uncategorized"). The same test main and the renderer use.
 * @param {any} folder
 * @returns {boolean}
 */
function isCatchAllFolder(folder) {
  return isUncategorizedFolder(folder);
}

/** @param {any} f */
const promptName = (f) => f.name.trim().slice(0, TRUNCATION.NAME_MAX);
/** @param {any} f */
const promptDescription = (f) => String(f.description || '').trim();

/**
 * The longest description length that keeps the folder list within
 * `budgetChars`, counting each line as the prompts print it:
 * `N. "name" — description`. Short descriptions keep their full length and
 * leave the room they do not use to the long ones.
 * @param {any[]} folders
 * @param {number} budgetChars
 * @param {number} descriptionMax
 * @returns {number}
 */
function fitDescriptionLength(folders, budgetChars, descriptionMax) {
  let fixed = 0;
  /** @type {number[]} */
  const lengths = [];
  folders.forEach((f, i) => {
    // `${i + 1}. "` + name + `" — ` + newline
    fixed += String(i + 1).length + 3 + promptName(f).length + 4 + 1;
    const length = Math.min(promptDescription(f).length, descriptionMax);
    if (length > 0) lengths.push(length);
    else fixed += NO_DESCRIPTION.length;
  });
  let remaining = budgetChars - fixed;
  if (remaining <= 0) return 0;
  lengths.sort((a, b) => a - b);
  for (let k = 0; k < lengths.length; k++) {
    const left = lengths.length - k;
    if (lengths[k] * left > remaining) return Math.floor(remaining / left);
    remaining -= lengths[k];
  }
  return descriptionMax;
}

/**
 * Pick the Smart Folders an analysis prompt lists, and trim each one.
 *
 * Folders the user made are kept before the built-in defaults, so a long
 * list drops defaults rather than the folders added last. The catch-all
 * ("Uncategorized") is always kept and listed last, because the prompt's own
 * rule tells the model to return it when nothing fits. Kept folders stay in
 * their stored order otherwise.
 *
 * With `contextTokens` (the model's context size), the list is kept to
 * TRUNCATION.PROMPT_FOLDER_CONTEXT_SHARE of that context: descriptions are
 * shortened first, and when they would get too short to be useful the list
 * falls back to TRUNCATION.PROMPT_FOLDERS_COMPACT_MAX folders. Every listed
 * folder keeps its name.
 *
 * @param {any[] | null | undefined} smartFolders
 * @param {{ max?: number, descriptionMax?: number, contextTokens?: number }} [options]
 * @returns {{ folders: Array<{ name: string, description: string }>, omitted: number }}
 *   `omitted` counts named folders that did not fit.
 */
function selectPromptFolders(
  smartFolders,
  {
    max = TRUNCATION.PROMPT_FOLDERS_MAX,
    descriptionMax = TRUNCATION.PROMPT_FOLDER_DESCRIPTION_MAX,
    contextTokens
  } = {}
) {
  const named = ensureArray(smartFolders).filter(
    (f) => f && typeof f.name === 'string' && f.name.trim().length > 0
  );
  const catchAll = named.find(isCatchAllFolder) || null;
  const others = named.filter((f) => f !== catchAll && !isCatchAllFolder(f));

  /** @param {number} count */
  const pick = (count) => {
    const limit = Math.max(0, Math.floor(Number(count) || 0));
    const room = Math.max(0, limit - (catchAll && limit > 0 ? 1 : 0));
    /** @type {Set<any>} */
    const keep = new Set();
    for (const f of others) if (keep.size < room && f.isDefault !== true) keep.add(f);
    for (const f of others) if (keep.size < room && f.isDefault === true) keep.add(f);
    const ordered = others.filter((f) => keep.has(f));
    if (catchAll && limit > 0) ordered.push(catchAll);
    return ordered;
  };

  let ordered = pick(max);
  let descriptionLength = Math.max(0, Math.floor(Number(descriptionMax) || 0));

  const tokens = Number(contextTokens);
  if (Number.isFinite(tokens) && tokens > 0) {
    const budgetChars = Math.floor(
      tokens * TRUNCATION.PROMPT_FOLDER_CONTEXT_SHARE * CHARS_PER_TOKEN
    );
    const fullLength = descriptionLength;
    descriptionLength = fitDescriptionLength(ordered, budgetChars, fullLength);
    const compactMax = TRUNCATION.PROMPT_FOLDERS_COMPACT_MAX;
    if (
      descriptionLength < Math.min(fullLength, TRUNCATION.PROMPT_FOLDER_DESCRIPTION_MIN) &&
      ordered.length > compactMax
    ) {
      ordered = pick(compactMax);
      descriptionLength = fitDescriptionLength(ordered, budgetChars, fullLength);
    }
  }

  return {
    folders: ordered.map((f) => ({
      name: promptName(f),
      description: promptDescription(f).slice(0, descriptionLength)
    })),
    omitted: named.length - ordered.length
  };
}

module.exports = { selectPromptFolders, isCatchAllFolder };
