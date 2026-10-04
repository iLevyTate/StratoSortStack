// @ts-check
/**
 * Review hold (decision D2, 2026-09-29)
 *
 * A file the engine cannot place confidently is held where it is and listed
 * for review; it is never moved. Before this, every such branch moved the file
 * somewhere (Uncategorized, or an extension-based fallback folder at a made-up
 * confidence of 0.1 to 0.3), which left it moved and still unorganized and
 * contradicted "suggest, confirm, move".
 *
 * @module autoOrganize/reviewHold
 */

const path = require('path');
const { sanitizeFile } = require('./fileTypeUtils');

/**
 * Add `file` to `results.needsReview`. When a rule could have placed it
 * (`fallbackDestination`), that folder becomes the suggestion the reviewer is
 * offered instead of a move.
 *
 * @param {Record<string, any>} results - organize results; needsReview is created if absent
 * @param {any} file
 * @param {{ confidence?: number, suggestion?: any, alternatives?: any[],
 *   explanation: string, fallbackDestination?: string | null }} details
 */
function holdForReview(results, file, details) {
  const {
    confidence = 0,
    suggestion = null,
    alternatives = [],
    explanation,
    fallbackDestination = null
  } = details;
  const fallbackSuggestion =
    typeof fallbackDestination === 'string' && fallbackDestination
      ? {
          folder: path.basename(path.dirname(fallbackDestination)),
          path: path.dirname(fallbackDestination),
          method: 'fallback'
        }
      : null;
  if (!Array.isArray(results.needsReview)) results.needsReview = [];
  results.needsReview.push({
    file: sanitizeFile(file),
    suggestion: suggestion || fallbackSuggestion,
    alternatives: Array.isArray(alternatives) ? alternatives : [],
    confidence,
    explanation
  });
}

module.exports = { holdForReview };
