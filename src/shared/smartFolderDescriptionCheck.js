// @ts-check
/**
 * Smart Folder description check.
 *
 * The AI picks a folder for a file by reading each folder's name and
 * description. A folder with no description, a few words, a description cut
 * off before the AI sees the end, or one that reads like another folder's
 * leaves it guessing, and similar files end up split between folders. This
 * gives the user a plain warning for each of those. It never blocks a save.
 *
 * Shared by the Add Smart Folder dialog and the Smart Folder editor.
 */

const { TRUNCATION } = require('./performanceConstants');

const SHORT_WORD_COUNT = 4;
const SIMILAR_MIN_WORDS = 3;
const SIMILAR_THRESHOLD = 0.5;

// Words that say nothing about which files belong in a folder.
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'files',
  'file',
  'folder',
  'smart',
  'data',
  'documents',
  'other'
]);

/**
 * @typedef {{ code: 'missing' | 'short' | 'long' | 'similar', message: string }} DescriptionIssue
 * @typedef {{ name?: unknown, description?: unknown }} FolderLike
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * True when the description is empty or the "Smart folder for <name>"
 * template filled in when the user left it blank.
 * @param {string} name
 * @param {string} description
 */
function isMissing(name, description) {
  if (!description) return true;
  return description.toLowerCase() === `smart folder for ${name}`.toLowerCase();
}

/**
 * Lowercased words of three or more letters or digits, minus STOP_WORDS.
 * @param {string} description
 * @returns {Set<string>}
 */
function contentWords(description) {
  const words = description.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
  return new Set(words.filter((word) => !STOP_WORDS.has(word)));
}

/**
 * Share of words two sets have in common (Jaccard index).
 * @param {Set<string>} a
 * @param {Set<string>} b
 */
function overlap(a, b) {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Warnings for one folder's description. `otherFolders` are the user's other
 * Smart Folders (not this one), compared for look-alike descriptions.
 * @param {{ name?: unknown, description?: unknown, otherFolders?: unknown, maxChars?: number }} input
 * @returns {DescriptionIssue[]}
 */
function checkFolderDescription({
  name,
  description,
  otherFolders = [],
  maxChars = TRUNCATION.PROMPT_FOLDER_DESCRIPTION_MAX
}) {
  const folderName = text(name);
  const desc = text(description);

  if (isMissing(folderName, desc)) {
    return [
      {
        code: 'missing',
        message:
          'Add a description. Without one, the AI only has the folder name to go on. Say what belongs here, for example: "Bills and invoices from suppliers".'
      }
    ];
  }

  /** @type {DescriptionIssue[]} */
  const issues = [];
  const wordCount = desc.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  if (wordCount < SHORT_WORD_COUNT) {
    issues.push({
      code: 'short',
      message:
        'This description is short. Name the kinds of files that belong here, and what does not.'
    });
  }

  if (desc.length > maxChars) {
    issues.push({
      code: 'long',
      message: `Only the first ${maxChars} characters reach the AI. Put the most telling words first.`
    });
  }

  const words = contentWords(desc);
  if (words.size >= SIMILAR_MIN_WORDS && Array.isArray(otherFolders)) {
    let closest = null;
    let closestScore = 0;
    for (const other of /** @type {FolderLike[]} */ (otherFolders)) {
      const otherName = text(other?.name);
      const otherDesc = text(other?.description);
      if (!otherName || isMissing(otherName, otherDesc)) continue;
      const otherWords = contentWords(otherDesc);
      if (otherWords.size < SIMILAR_MIN_WORDS) continue;
      const score = overlap(words, otherWords);
      if (score >= SIMILAR_THRESHOLD && score > closestScore) {
        closest = otherName;
        closestScore = score;
      }
    }
    if (closest) {
      issues.push({
        code: 'similar',
        message: `This reads much like "${closest}". Say what makes them different, or similar files may be split between the two.`
      });
    }
  }

  return issues;
}

module.exports = { checkFolderDescription };
