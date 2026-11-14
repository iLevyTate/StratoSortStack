// @ts-check
/**
 * Feedback Memory Utilities
 *
 * Parse natural-language feedback into structured rules.
 */

const { randomUUID } = require('crypto');
const { normalizePathForIndex } = require('../../../shared/pathSanitization');
const { ALL_SUPPORTED_EXTENSIONS } = require('../../../shared/constants');
const { isUncategorizedFolder } = require('../../../shared/uncategorizedFolder');

const MAX_TEXT_LENGTH = 500;

/** File types a rule may name without a dot ("CSV files go to Bing"). */
const KNOWN_EXTENSIONS = new Set(
  ALL_SUPPORTED_EXTENSIONS.map((ext) => String(ext).replace(/^\./, '').toLowerCase())
);

/** "CSV files", "files csv", or the whole left side ("xlsx", "all xlsx"). */
const BARE_EXTENSION_PATTERNS = [
  /\b([a-z0-9]{2,5})\s+files?\b/i,
  /\bfiles?\s+([a-z0-9]{2,5})\b/i,
  /^(?:all\s+)?([a-z0-9]{2,5})$/i
];

function normalizeText(/** @type {any} */ text) {
  return String(text || '')
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

function extractExtension(/** @type {any} */ token) {
  if (!token) return null;
  const trimmed = token.trim().toLowerCase();
  if (trimmed.startsWith('.')) {
    return trimmed.slice(1);
  }
  if (/^[a-z0-9]{2,6}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

function extractTargetFolder(/** @type {any} */ value) {
  if (!value) return null;
  return value
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?]+$/g, '')
    .trim();
}

/**
 * The file type the left side of a rule names, or null. A dotted ".pdf" or an
 * explicit "extension pdf" is taken as written. A bare word ("CSV files",
 * "xlsx") counts only when it is a file type StratoSort knows, so "Client
 * files" and "Files like ..." name none.
 * @param {string} left
 * @returns {string|null}
 */
function findRuleExtension(left) {
  const explicit =
    left.match(/(?:\.[a-z0-9]{2,6})/i) || left.match(/(?:extension|file type)\s+([a-z0-9]{2,6})/i);
  if (explicit) return extractExtension(explicit[1] || explicit[0]);

  for (const pattern of BARE_EXTENSION_PATTERNS) {
    const token = left.match(pattern)?.[1]?.toLowerCase();
    if (token && KNOWN_EXTENSIONS.has(token)) return token;
  }
  return null;
}

/**
 * @param {any} text
 * @param {{ allowRules?: boolean }} [options] - false for text StratoSort
 *   wrote itself (correction notes): only what the user typed becomes a rule.
 */
function parseRuleFromText(text, { allowRules = true } = {}) {
  const normalized = normalizeText(text);
  if (!normalized) return { rules: [], targetFolder: null };

  const ruleMatch = normalized.match(
    /(.+?)\s*(?:->|=>|\bshould go to\b|\bgoes to\b|\bgo to\b|\bto\b)\s*(.+)$/i
  );
  if (!ruleMatch) {
    return { rules: [], targetFolder: null };
  }

  const left = ruleMatch[1].trim();
  const right = ruleMatch[2].trim();
  const targetFolder = extractTargetFolder(right);

  const extension = allowRules ? findRuleExtension(left) : null;

  if (extension && targetFolder) {
    return {
      targetFolder,
      rules: [
        {
          type: 'extension_to_folder',
          extension,
          folder: targetFolder,
          confidence: 1
        }
      ]
    };
  }

  return { rules: [], targetFolder: targetFolder || null };
}

/**
 * @typedef {{ extension: string, category: string|null, correctFolder: string, correctFolderId?: string, correctFolderPath?: string }} MemoryCorrection
 */

/** @param {any} value @returns {string} lowercase, no leading dot */
function normalizeExtension(value) {
  return String(value || '')
    .trim()
    .replace(/^\./, '')
    .toLowerCase();
}

/** @param {any} value @returns {string} */
function normalizeLabel(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * What a correction was about: a file of this type, which the analysis
 * labeled this, went to `correctFolder` instead of the memory's targetFolder.
 * The folder's id and path, when known, tell apart two smart folders with the
 * same name.
 * @param {any} correction
 * @returns {MemoryCorrection|null}
 */
function normalizeCorrection(correction) {
  if (!correction || typeof correction !== 'object') return null;
  const extension = normalizeExtension(correction.extension);
  const correctFolder =
    typeof correction.correctFolder === 'string' ? correction.correctFolder.trim() : '';
  if (!extension || !correctFolder) return null;
  const id = typeof correction.correctFolderId === 'string' ? correction.correctFolderId : '';
  const folderPath =
    typeof correction.correctFolderPath === 'string' ? correction.correctFolderPath : '';
  return {
    extension,
    category: normalizeLabel(correction.category) || null,
    correctFolder,
    ...(id ? { correctFolderId: id } : {}),
    ...(folderPath ? { correctFolderPath: folderPath } : {})
  };
}

/** @param {any} value @returns {string} a folder path compared as an index key */
function folderPathKey(value) {
  if (typeof value !== 'string' || !value) return '';
  return (normalizePathForIndex(value) || value).replace(/\/+$/, '');
}

/**
 * The smart folder a correction went to: by recorded id, then by recorded
 * path, then the first one with its name.
 * @param {MemoryCorrection} correction
 * @param {any[]} smartFolders
 * @returns {any|null}
 */
function resolveCorrectionFolder(correction, smartFolders) {
  const valid = smartFolders.filter((f) => f && typeof f === 'object');
  if (correction.correctFolderId) {
    const byId = valid.find((f) => f.id === correction.correctFolderId);
    if (byId) return byId;
  }
  const wantedPath = folderPathKey(correction.correctFolderPath);
  if (wantedPath) {
    const byPath = valid.find((f) => folderPathKey(f.path) === wantedPath);
    if (byPath) return byPath;
  }
  const name = correction.correctFolder.toLowerCase();
  return (
    valid.find((f) => typeof f.name === 'string' && f.name.trim().toLowerCase() === name) || null
  );
}

/**
 * @param {any} text
 * @param {{ targetFolder?: string, scope?: any, source?: string, filePath?: string, correction?: any }} [metadata]
 */
function buildMemoryEntry(text, metadata = {}) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }
  const { rules, targetFolder } = parseRuleFromText(normalized, {
    allowRules: (metadata.source || 'manual') === 'manual'
  });
  const now = new Date().toISOString();
  // Provenance (F-202): a correction memory records which file it was about,
  // so undoing that file's organize can remove it again.
  const filePath =
    typeof metadata.filePath === 'string' && metadata.filePath
      ? normalizePathForIndex(metadata.filePath) || metadata.filePath
      : null;
  // Item 16: what was corrected, so findLearnedCorrection can match it
  // without embeddings.
  const correction = normalizeCorrection(metadata.correction);
  return {
    id: randomUUID(),
    text: normalized,
    rules,
    targetFolder: metadata.targetFolder || targetFolder || null,
    scope: metadata.scope || { type: 'global' },
    source: metadata.source || 'manual',
    filePath,
    ...(correction ? { correction } : {}),
    createdAt: now,
    updatedAt: now
  };
}

/**
 * Labels that say nothing about where a file belongs. Learning from them
 * would send every "document" to wherever one was last moved. Same list as
 * the label suggestion's generic categories, plus 'unknown'.
 */
const GENERIC_LABELS = new Set([
  'document',
  'documents',
  'image',
  'images',
  'file',
  'files',
  'media',
  'misc',
  'miscellaneous',
  'other',
  'uncategorized',
  'unknown'
]);

/**
 * A correction the user has made often enough to act on (item 16): at least
 * `minFiles` different files with this type and this (non-generic) label were
 * moved away from `fromFolder` into the same other folder, and that folder is
 * strictly ahead of every other folder they went to, and of the files with
 * this type and label later corrected away from it. The folder must still be
 * a smart folder and not the catch-all. Memories without a structured
 * `correction` (recorded before it existed) are ignored.
 *
 * Pure: reads only what it is given, needs no embeddings.
 *
 * @param {{ memories?: any, extension?: any, category?: any, fromFolder?: any, smartFolders?: any, minFiles?: number }} [params]
 * @returns {{ folder: any, files: number } | null} the smart folder and how many files taught it
 */
function findLearnedCorrection({
  memories,
  extension,
  category,
  fromFolder,
  smartFolders,
  minFiles = 2
} = {}) {
  if (!Array.isArray(memories) || !Array.isArray(smartFolders)) return null;
  const ext = normalizeExtension(extension);
  const label = normalizeLabel(category);
  const from = normalizeLabel(fromFolder);
  if (!ext || !label || GENERIC_LABELS.has(label) || !from) return null;

  /** @type {Array<{ targetFolder: string, correction: MemoryCorrection, fileKey: string }>} */
  const relevant = [];
  for (const entry of memories) {
    if (!entry || typeof entry !== 'object' || entry.source !== 'feedback_reject') continue;
    const correction = normalizeCorrection(entry.correction);
    if (!correction || correction.extension !== ext || correction.category !== label) continue;
    if (typeof entry.filePath !== 'string' || !entry.filePath) continue;
    relevant.push({
      targetFolder: normalizeLabel(entry.targetFolder),
      correction,
      fileKey: normalizePathForIndex(entry.filePath) || entry.filePath
    });
  }

  // Grouped by the smart folder each went to (by id, then path, then name),
  // so two folders with the same name are counted apart. A folder that is no
  // longer a smart folder still competes, under its name.
  /** @type {Map<any, { folder: any, files: Set<string> }>} */
  const groups = new Map();
  for (const { targetFolder, correction, fileKey } of relevant) {
    if (targetFolder !== from) continue;
    if (correction.correctFolder.toLowerCase() === from) continue;
    const folder = resolveCorrectionFolder(correction, smartFolders);
    const key = folder || `name:${correction.correctFolder.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { folder, files: new Set() });
    /** @type {{ files: Set<string> }} */ (groups.get(key)).files.add(fileKey);
  }

  let best = null;
  let bestFiles = 0;
  let runnerUp = 0;
  for (const group of groups.values()) {
    if (group.files.size > bestFiles) {
      runnerUp = bestFiles;
      best = group.folder;
      bestFiles = group.files.size;
    } else if (group.files.size > runnerUp) {
      runnerUp = group.files.size;
    }
  }
  if (!best || bestFiles < Math.max(1, minFiles) || bestFiles <= runnerUp) return null;
  if (isUncategorizedFolder(best)) return null;

  // Corrections away from that folder, for the same type and label, count
  // against it: the user changed their mind (moved overridden files back, or
  // on to a third folder). Without this the override could not be unlearned,
  // since those corrections are keyed to the override folder, not `from`.
  const bestName = String(best.name || '')
    .trim()
    .toLowerCase();
  const contrary = new Set(
    relevant.filter((item) => item.targetFolder === bestName).map((item) => item.fileKey)
  );
  if (bestFiles <= contrary.size) return null;
  return { folder: best, files: bestFiles };
}

/** @param {{ fileExtension?: string, suggestionFolder?: string, rules?: any[] }} args */
function applyMemoryRuleAdjustments({ fileExtension, suggestionFolder, rules }) {
  if (!fileExtension || !suggestionFolder || !Array.isArray(rules)) {
    return { boost: 0, penalty: 0 };
  }
  const ext = fileExtension.replace('.', '').toLowerCase();
  const normalizedFolder = suggestionFolder.toLowerCase();

  let boost = 0;
  let penalty = 0;

  for (const rule of rules) {
    if (rule.type !== 'extension_to_folder') continue;
    if (rule.extension?.toLowerCase() !== ext) continue;
    if (rule.folder?.toLowerCase() === normalizedFolder) {
      boost = Math.max(boost, 0.2);
    } else {
      penalty = Math.max(penalty, 0.1);
    }
  }

  return { boost, penalty };
}

module.exports = {
  normalizeText,
  parseRuleFromText,
  buildMemoryEntry,
  applyMemoryRuleAdjustments,
  findLearnedCorrection
};
