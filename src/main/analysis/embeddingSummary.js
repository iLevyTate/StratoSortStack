// @ts-check
const { capEmbeddingInput, getEmbeddingTokenLimit } = require('../utils/embeddingInput');
const { enrichFileTextForEmbedding } = require('./semanticExtensionMap');

/**
 * @param {any} analysis
 * @param {string} [extractedText]
 * @param {string} [fileExtension]
 * @param {string} [type]
 * @param {{ embeddingModel?: string, embeddingContextSize?: number }} [options]
 */
function buildEmbeddingSummary(
  analysis,
  extractedText = '',
  fileExtension,
  type = 'document',
  options = {}
) {
  const safeAnalysis = analysis && typeof analysis === 'object' ? analysis : {};
  const rawType = typeof safeAnalysis.type === 'string' ? safeAnalysis.type.trim() : '';
  const isGenericType = ['image', 'document', 'file', 'unknown'].includes(rawType.toLowerCase());
  const documentType = safeAnalysis.documentType || (!isGenericType && rawType ? rawType : '');
  const documentDate = safeAnalysis.documentDate || safeAnalysis.date || '';
  // Live analyses carry `keywords`; history rows store the same list as `tags`
  // (analysisUtils.recordAnalysisResult). The rebuild, move and backfill routes
  // embed from history, so reading only `keywords` dropped every keyword from
  // vectors built there, and a rebuilt index drifted from the live one (CP-14).
  const keywordList =
    Array.isArray(safeAnalysis.keywords) && safeAnalysis.keywords.length > 0
      ? safeAnalysis.keywords
      : Array.isArray(safeAnalysis.tags)
        ? safeAnalysis.tags
        : [];
  const keywords = keywordList.slice(0, 20).join(' ');
  const keyEntities = Array.isArray(safeAnalysis.keyEntities)
    ? safeAnalysis.keyEntities.slice(0, 15).join(' ')
    : '';

  const baseParts = [
    safeAnalysis.summary,
    safeAnalysis.purpose,
    safeAnalysis.project,
    safeAnalysis.entity,
    documentType,
    documentDate,
    safeAnalysis.reasoning,
    safeAnalysis.subject,
    safeAnalysis.suggestedName,
    keywords,
    keyEntities
  ];

  if (type === 'image') {
    baseParts.push(safeAnalysis.content_type || safeAnalysis.contentType || '');
  }

  const baseText = baseParts.filter(Boolean).join('\n');
  const safeExtension = typeof fileExtension === 'string' ? fileExtension : '';
  const enrichedBase = enrichFileTextForEmbedding(baseText, safeExtension);

  // Add extracted text snippet proportional to remaining embedding budget.
  // Avoids wasting the fixed 2000-char snippet on rich analyses (where it gets
  // truncated anyway) while giving fallback analyses more content to embed.
  //
  // The budget is derived from the *actual* embedding model so we use its real
  // context window (e.g. nomic-embed-text-v1.5 @ 8192, clamped to a sane
  // ceiling) instead of the historical 512-token floor that silently truncated
  // every document to ~1.5k chars. When no model is supplied (legacy callers /
  // unit tests) the cap falls back to that floor, preserving prior behavior.
  const { embeddingModel, embeddingContextSize } = options;
  const explicitContext =
    Number.isFinite(embeddingContextSize) && embeddingContextSize > 0
      ? embeddingContextSize
      : undefined;
  const charBudget = Math.floor(getEmbeddingTokenLimit(explicitContext, embeddingModel) * 3.5);
  const snippetLimit = Math.max(500, charBudget - enrichedBase.length);
  const textSnippet = extractedText ? extractedText.slice(0, snippetLimit) : '';
  const combined = [enrichedBase, textSnippet].filter(Boolean).join('\n');

  return capEmbeddingInput(combined, {
    modelName: embeddingModel,
    maxTokens: explicitContext
  });
}

module.exports = {
  buildEmbeddingSummary
};
