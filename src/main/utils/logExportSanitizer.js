// @ts-check
const path = require('path');
const { deepSanitizeForExport } = require('../../shared/exportRedaction');

const TEXT_LOG_EXTENSIONS = new Set(['.log', '.txt', '.json', '.jsonl', '.ndjson']);

/** @param {string} filePath */
function isTextLogFile(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return false;
  }
  const extension = path.extname(filePath).toLowerCase();
  return TEXT_LOG_EXTENSIONS.has(extension);
}

/** @param {string} line */
function sanitizeLogLine(line) {
  if (typeof line !== 'string' || line.length === 0) {
    return line;
  }

  const trimmed = line.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        return JSON.stringify(deepSanitizeForExport(parsed));
      }
    } catch {
      // Not valid JSON, sanitize as plain text line.
    }
  }

  return deepSanitizeForExport(line);
}

/** @param {string} content */
function sanitizeLogContent(content) {
  if (typeof content !== 'string' || content.length === 0) {
    return content;
  }

  // Preserve original line endings while sanitizing each textual line.
  return content.replace(/[^\r\n]+/g, (line) => /** @type {string} */ (sanitizeLogLine(line)));
}

module.exports = {
  isTextLogFile,
  sanitizeLogContent,
  _sanitizeLogLine: sanitizeLogLine
};
