// @ts-check
'use strict';

// Shared with the main-thread extractor so both produce identical RTF and
// HTML text (same tokenizer, same entity table).
const { rtfToText } = require('../analysis/extractors/rtfText');
const { decodeHtmlEntities } = require('../analysis/extractors/htmlEntities');

const REGEX_PATTERNS = {
  scriptTags: /<script[\s\S]*?<\/script>/gi,
  styleTags: /<style[\s\S]*?<\/style>/gi,
  htmlTags: /<[^>]+>/g,
  whitespace: /\s+/g
};

/** @param {string} html */
function extractPlainTextFromHtml(html) {
  try {
    const withoutScripts = html.replace(REGEX_PATTERNS.scriptTags, '');
    const withoutStyles = withoutScripts.replace(REGEX_PATTERNS.styleTags, '');
    const withoutTags = withoutStyles.replace(REGEX_PATTERNS.htmlTags, ' ');
    return decodeHtmlEntities(withoutTags).replace(REGEX_PATTERNS.whitespace, ' ').trim();
  } catch {
    return html;
  }
}

/** @param {string} rtf */
function extractPlainTextFromRtf(rtf) {
  try {
    return rtfToText(rtf);
  } catch {
    return rtf;
  }
}

/** @param {string} sharedStringsXml */
function extractSharedStringsFromXlsxXml(sharedStringsXml) {
  if (!sharedStringsXml || typeof sharedStringsXml !== 'string') return [];
  const strings = [];
  try {
    const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/gi;
    let siMatch;
    while ((siMatch = siRegex.exec(sharedStringsXml)) !== null) {
      const siInner = siMatch[1] || '';
      const parts = [];
      const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/gi;
      let tMatch;
      while ((tMatch = tRegex.exec(siInner)) !== null) {
        parts.push(tMatch[1] || '');
      }
      const rawText = parts.length > 0 ? parts.join('') : siInner;
      strings.push(extractPlainTextFromHtml(rawText));
      if (strings.length > 500000) break;
    }
  } catch {
    return [];
  }
  return strings;
}

/**
 * @param {string} worksheetXml
 * @param {any[]} [sharedStrings]
 * @param {number} [rowBudget]
 */
function extractTextFromXlsxWorksheetXml(worksheetXml, sharedStrings = [], rowBudget) {
  if (!worksheetXml || typeof worksheetXml !== 'string') return { text: '', rowsUsed: 0 };
  const shared = Array.isArray(sharedStrings) ? sharedStrings : [];
  const maxRows = Number.isFinite(rowBudget) ? rowBudget : 10000;

  const lines = [];
  let rowsUsed = 0;
  let approxLength = 0;
  const MAX_TEXT_LENGTH = 500000;

  try {
    const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/gi;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(worksheetXml)) !== null) {
      if (rowsUsed >= maxRows) break;
      const rowXml = rowMatch[1] || '';
      const rowValues = [];

      const cellRegex = /<c\b([^>]*)>([\s\S]*?)<\/c>/gi;
      let cellMatch;
      while ((cellMatch = cellRegex.exec(rowXml)) !== null) {
        const cellAttrs = cellMatch[1] || '';
        const cellInner = cellMatch[2] || '';

        const typeMatch = /\bt=(?:"([^"]+)"|'([^']+)')/i.exec(cellAttrs);
        const cellType = typeMatch ? typeMatch[1] || typeMatch[2] : null;

        if (cellType === 'e') continue;

        const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(cellInner);
        const rawV = vMatch ? vMatch[1] : null;

        if (cellType === 's') {
          const idx = Number.parseInt(String(rawV ?? ''), 10);
          if (Number.isFinite(idx) && idx >= 0 && idx < shared.length) {
            const s = shared[idx];
            if (s) rowValues.push(s);
          } else if (rawV !== null && rawV !== undefined && String(rawV).trim()) {
            rowValues.push(String(rawV).trim());
          }
          continue;
        }

        if (cellType === 'inlineStr') {
          const parts = [];
          const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/gi;
          let tMatch;
          while ((tMatch = tRegex.exec(cellInner)) !== null) {
            parts.push(tMatch[1] || '');
          }
          const inlineText = extractPlainTextFromHtml(parts.join(''));
          if (inlineText) rowValues.push(inlineText);
          continue;
        }

        if (rawV !== null && rawV !== undefined) {
          const cleaned = extractPlainTextFromHtml(String(rawV));
          if (cleaned) rowValues.push(cleaned);
          continue;
        }

        const cellText = extractPlainTextFromHtml(cellInner);
        if (cellText) rowValues.push(cellText);
      }

      if (rowValues.length > 0) {
        const line = rowValues.join(' ');
        lines.push(line);
        rowsUsed += 1;
        approxLength += line.length + 1;
        if (approxLength > MAX_TEXT_LENGTH) break;
      }
    }
  } catch {
    return { text: '', rowsUsed: 0 };
  }

  return { text: lines.join('\n'), rowsUsed };
}

module.exports = function (/** @type {any} */ task) {
  switch (task.type) {
    case 'html':
      return extractPlainTextFromHtml(task.payload.text);
    case 'rtf':
      return extractPlainTextFromRtf(task.payload.text);
    case 'xlsx_shared':
      return extractSharedStringsFromXlsxXml(task.payload.text);
    case 'xlsx_worksheet':
      return extractTextFromXlsxWorksheetXml(
        task.payload.text,
        task.payload.sharedStrings,
        task.payload.rowBudget
      );
    default:
      throw new Error(`Unknown task type: ${task.type}`);
  }
};
