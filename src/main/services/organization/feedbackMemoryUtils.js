// @ts-check
/**
 * Feedback Memory Utilities
 *
 * Parse natural-language feedback into structured rules.
 */

const { randomUUID } = require('crypto');
const { normalizePathForIndex } = require('../../../shared/pathSanitization');

const MAX_TEXT_LENGTH = 500;

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

function parseRuleFromText(/** @type {any} */ text) {
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

  const extensionMatch =
    left.match(/(?:\.[a-z0-9]{2,6})/i) ||
    left.match(/(?:extension|file type|files)\s+([a-z0-9]{2,6})/i);
  const extensionToken = extensionMatch ? extensionMatch[1] || extensionMatch[0] : null;
  const extension = extractExtension(extensionToken);

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
 * @param {any} text
 * @param {{ targetFolder?: string, scope?: any, source?: string, filePath?: string }} [metadata]
 */
function buildMemoryEntry(text, metadata = {}) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }
  const { rules, targetFolder } = parseRuleFromText(normalized);
  const now = new Date().toISOString();
  // Provenance (F-202): a correction memory records which file it was about,
  // so undoing that file's organize can remove it again.
  const filePath =
    typeof metadata.filePath === 'string' && metadata.filePath
      ? normalizePathForIndex(metadata.filePath) || metadata.filePath
      : null;
  return {
    id: randomUUID(),
    text: normalized,
    rules,
    targetFolder: metadata.targetFolder || targetFolder || null,
    scope: metadata.scope || { type: 'global' },
    source: metadata.source || 'manual',
    filePath,
    createdAt: now,
    updatedAt: now
  };
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
  applyMemoryRuleAdjustments
};
