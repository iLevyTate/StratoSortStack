// @ts-check
'use strict';

/**
 * Turn the JSON a model returned for one file into the analysis result the
 * rest of the app stores and acts on. Shared by the document text route
 * (documentLlm) and the cloud video route (cloudMedia) so both get the same
 * checks: only known fields are kept, the category is mapped onto a real
 * smart folder (or "Uncategorized"), and the suggested name is cleaned and
 * given back the file's own extension.
 *
 * Model output is untrusted. A transcript or document can carry instructions,
 * so any extra key the model adds (internal flags, hand-off state) must not
 * reach the stored analysis; that is why the result is built field by field.
 */

const path = require('path');
const { isPlausibleContentDate } = require('../../shared/contentDateSanity');
const { sanitizeSuggestedBaseName } = require('../../shared/pathSanitization');
const FolderMatchingService = require('../services/FolderMatchingService');

/**
 * @param {Record<string, any>} parsedJson the parsed model output (mutated: date and confidence are normalized in place)
 * @param {{
 *   originalFileName: string,
 *   smartFolders?: any[],
 *   textContent?: string,
 *   fileDate?: string | null,
 *   provider?: string,
 *   logger: { info: Function, warn: Function },
 *   source?: string
 * }} context
 * @returns {Record<string, any>}
 */
function buildAnalysisFromModelJson(parsedJson, context) {
  const {
    originalFileName,
    smartFolders = [],
    textContent = '',
    fileDate = null,
    provider,
    logger,
    source = 'documentLlm'
  } = context;

  // Validate and sanitize date field
  if (parsedJson.date) {
    try {
      const dateObj = new Date(parsedJson.date);
      if (isNaN(dateObj.getTime())) {
        delete parsedJson.date;
      } else {
        parsedJson.date = dateObj.toISOString().split('T')[0];
        // A parseable-but-implausible year (hallucinated "2103",
        // OCR-misread "0201") would pin the timeline sort and poison
        // the stats card's year range — drop to the fileDate fallback.
        if (!isPlausibleContentDate(parsedJson.date)) {
          delete parsedJson.date;
        }
      }
    } catch {
      delete parsedJson.date;
    }
  }

  // Use file date if LLM returned no date or invalid date
  if (!parsedJson.date && fileDate) {
    parsedJson.date = fileDate;
  }

  // Validate keywords array
  const finalKeywords = Array.isArray(parsedJson.keywords)
    ? parsedJson.keywords.filter((/** @type {any} */ kw) => typeof kw === 'string' && kw.length > 0)
    : [];

  // Validate confidence: accept any model-provided value in 0-100.
  // Only recalculate when the value is missing or not a finite number —
  // never override a legitimate low-confidence score (e.g. 40 for an
  // ambiguous document) with an inflated field-completeness estimate.
  const rawConfidence = parsedJson.confidence;
  const hasValidConfidence =
    typeof rawConfidence === 'number' &&
    Number.isFinite(rawConfidence) &&
    rawConfidence >= 0 &&
    rawConfidence <= 100;

  if (!hasValidConfidence) {
    // Model did not return a usable confidence value — estimate from
    // field completeness as a reasonable proxy.
    let calculatedConfidence = 70; // Base confidence
    if (
      parsedJson.category &&
      typeof parsedJson.category === 'string' &&
      parsedJson.category.length > 0
    ) {
      calculatedConfidence += 5;
    }
    if (
      parsedJson.purpose &&
      typeof parsedJson.purpose === 'string' &&
      parsedJson.purpose.length > 0
    ) {
      calculatedConfidence += 5;
    }
    if (finalKeywords.length >= 3) {
      calculatedConfidence += 5;
    }
    if (
      parsedJson.project &&
      typeof parsedJson.project === 'string' &&
      parsedJson.project.length > 0
    ) {
      calculatedConfidence += 5;
    }
    if (
      parsedJson.suggestedName &&
      typeof parsedJson.suggestedName === 'string' &&
      parsedJson.suggestedName.length > 0
    ) {
      calculatedConfidence += 5;
    }
    parsedJson.confidence = Math.min(95, calculatedConfidence);
  } else {
    parsedJson.confidence = Math.round(rawConfidence);
  }

  // Build validated result object
  // Include summary, entity, type for rich semantic folder matching
  const rawLlmCategory = typeof parsedJson.category === 'string' ? parsedJson.category : 'document';
  // Use the rich variant so we can surface a "create new folder?" hint when
  // the LLM's category was meaningful (e.g. "marketing", "Labcorp") but
  // didn't match any existing smart folder. Without this, the theme is
  // silently lost when the category normalizes to "Uncategorized".
  const categoryMatch = FolderMatchingService.matchCategoryToFolderWithSuggestion(
    rawLlmCategory,
    smartFolders
  );
  if (categoryMatch.suggestedNewFolder) {
    logger.info('[DocumentLLM] Surfaced new-folder suggestion', {
      fileName: originalFileName,
      rawLlmCategory,
      suggestedNewFolder: categoryMatch.suggestedNewFolder
    });
  }
  return {
    rawText: textContent.substring(0, 2000),
    date: parsedJson.date || undefined,
    // Semantic fields for folder matching - these drive organization decisions
    summary: typeof parsedJson.summary === 'string' ? parsedJson.summary : undefined,
    reasoning: typeof parsedJson.reasoning === 'string' ? parsedJson.reasoning : undefined,
    entity: typeof parsedJson.entity === 'string' ? parsedJson.entity : undefined,
    type: typeof parsedJson.type === 'string' ? parsedJson.type : undefined,
    project: typeof parsedJson.project === 'string' ? parsedJson.project : undefined,
    purpose: typeof parsedJson.purpose === 'string' ? parsedJson.purpose : undefined,
    category: categoryMatch.folder,
    suggestedNewFolder: categoryMatch.suggestedNewFolder || undefined,
    suggestedName: cleanSuggestedName(parsedJson.suggestedName, originalFileName, logger, source),
    keywords: finalKeywords,
    confidence: parsedJson.confidence,
    provider
  };
}

/**
 * @param {unknown} suggested
 * @param {string} originalFileName
 * @param {{ warn: Function }} logger
 * @param {string} source
 * @returns {string | undefined}
 */
function cleanSuggestedName(suggested, originalFileName, logger, source) {
  if (typeof suggested !== 'string') return undefined;
  // Sanitize: reject path traversal characters in suggestedName
  if (/[/\\]/.test(suggested) || suggested.includes('..')) {
    logger.warn(`[${source}] suggestedName contains path traversal characters, rejecting`, {
      suggestedName: suggested,
      fileName: originalFileName
    });
    return undefined;
  }
  // Always strip any LLM-added extension and restore the original.
  // The prompt says "no extension", but some models add one anyway —
  // if a wrong extension slips through (e.g. .docx for a .pdf file)
  // the renamed file becomes unopenable.
  const originalExt = path.extname(originalFileName);
  const llmExt = path.extname(suggested);
  const rawBase = llmExt ? suggested.slice(0, -llmExt.length) : suggested;
  // Separators are rejected above; this covers the rest of the
  // Windows-illegal set (`<>:"|?*`, control chars), trailing dots
  // and reserved device names that would break the later rename.
  const baseName = sanitizeSuggestedBaseName(rawBase);
  if (!baseName) {
    logger.warn(`[${source}] suggestedName has no usable characters, rejecting`, {
      suggestedName: suggested,
      fileName: originalFileName
    });
    return undefined;
  }
  return originalExt ? baseName + originalExt : baseName;
}

module.exports = { buildAnalysisFromModelJson };
