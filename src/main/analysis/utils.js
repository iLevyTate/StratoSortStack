// @ts-check
/** @typedef {import('../../shared/analysisSchema').AnalysisResult} AnalysisResult */
const { ANALYSIS_SCHEMA_PROMPT } = require('../../shared/analysisSchema');
// Coerce a non-numeric confidence shape into a number on the caller's
// existing scale. Models routinely return numeric strings ("0.85"),
// percent strings ("85%"), or categorical tokens ("high"/"medium"/"low")
// — previously any non-number shape collapsed to the fallback (0), so
// the image-analysis path (which hand-parsed these) and the document
// path diverged for identical model output. We deliberately DO NOT
// rescale raw numbers: upstream callers (document LLM, image LLM, tests,
// DB rows) use both the 0-1 and 0-100 scales depending on the route,
// and silently normalizing would change confidence gates across the
// codebase. Categorical tokens map onto a normalized 0-1 value the
// caller's fallback scale tends to tolerate; numeric strings preserve
// the emitted magnitude so "85" stays "85" and "0.85" stays "0.85".
/** @param {unknown} value */
function _coerceConfidence(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return null;
    if (trimmed === 'high' || trimmed === 'very high') return 0.9;
    if (trimmed === 'medium' || trimmed === 'moderate') return 0.7;
    if (trimmed === 'low') return 0.4;
    if (trimmed === 'very low' || trimmed === 'none') return 0.2;
    const percentMatch = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*%$/);
    if (percentMatch) {
      const pct = Number(percentMatch[1]);
      if (Number.isFinite(pct)) return pct;
    }
    const num = Number(trimmed);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

/**
 * @param {any} raw
 * @param {AnalysisResult} [fallback]
 * @returns {AnalysisResult}
 */
function normalizeAnalysisResult(raw, fallback = {}) {
  /** @type {AnalysisResult} */
  const result = raw && typeof raw === 'object' ? { ...raw } : {};
  const rawType = typeof result.type === 'string' ? result.type.trim() : '';
  const isGenericType = ['image', 'document', 'file', 'unknown'].includes(rawType.toLowerCase());
  const coercedConfidence = _coerceConfidence(result.confidence);
  const coercedFallback = _coerceConfidence(fallback.confidence);
  const normalized = {
    category:
      typeof result.category === 'string' && result.category.trim()
        ? result.category
        : fallback.category || 'document',
    keywords: Array.isArray(result.keywords) ? result.keywords : fallback.keywords || [],
    keyEntities: Array.isArray(result.keyEntities)
      ? result.keyEntities.filter(Boolean)
      : fallback.keyEntities || [],
    confidence:
      coercedConfidence !== null
        ? coercedConfidence
        : coercedFallback !== null
          ? coercedFallback
          : 0,
    suggestedName:
      typeof result.suggestedName === 'string'
        ? result.suggestedName
        : fallback.suggestedName || null,
    extractionMethod: result.extractionMethod || fallback.extractionMethod || null,
    contentLength:
      typeof result.contentLength === 'number'
        ? result.contentLength
        : fallback.contentLength || null,
    documentType:
      typeof result.documentType === 'string' && result.documentType.trim()
        ? result.documentType
        : rawType && !isGenericType
          ? rawType
          : fallback.documentType || null,
    documentDate:
      typeof result.documentDate === 'string' && result.documentDate.trim()
        ? result.documentDate
        : typeof result.date === 'string' && result.date.trim()
          ? result.date
          : fallback.documentDate || null
  };
  return { ...result, ...normalized };
}

// Filler words left out when comparing a model's answer with the prompt.
const ECHO_STOPWORDS = new Set(
  'a an and are as at be by e g for from in into is it its of on or that the this to with'.split(
    ' '
  )
);
const ECHO_FIELDS = ['summary', 'purpose', 'project', 'reasoning', 'type', 'entity'];
// The prompt asks for the reasoning to cite the chosen folder's description,
// so it is only checked against the schema instructions.
const ECHO_SCHEMA_ONLY_FIELDS = new Set(['reasoning']);
// A value is an echo when nearly all of its words come from one source text
// AND it reproduces a good part of that text. The second test keeps a real
// answer that merely shares vocabulary ("A logo for a company or
// organization") from reading as a copy of a longer instruction.
const ECHO_CONTAINMENT = 0.8;
const ECHO_SOURCE_COVERAGE = 0.4;
const ECHO_MIN_WORDS = 4;
// Same ceiling as a filename-only guess (fallbackUtils FILENAME_ONLY_CONFIDENCE).
const ECHO_CONFIDENCE_CAP = 50;

/** @param {unknown} text @returns {string[]} */
function echoWords(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !ECHO_STOPWORDS.has(w));
}

/**
 * Drop answers a model copied out of its own prompt instead of writing.
 *
 * Small vision models in particular fill a field with the schema's
 * instruction for it ("A concise summary of the document's content.") or
 * with a smart folder's description ("Art, graphic design, images not
 * related to other categories, logos"). Kept, those read as real summaries,
 * feed the embedding, and the category picked alongside them looked certain
 * (one such answer filed a banner under Research at 90%). Copied fields are
 * cleared; when any was copied, the confidence is capped like a filename
 * guess so the file is flagged for review. Same idea as
 * normalizeImageContentType, applied to the free-text fields.
 *
 * A well-described folder shares its vocabulary with the files that belong
 * in it: a GSC export's summary names the same queries, clicks and
 * impressions the folder's description lists. When the caller has the
 * document's text, a word the document itself contains is the model reading
 * the file, not the folder description, so it is not counted as copied from
 * one. Callers without text (images, media) keep the stricter check. The
 * schema instructions are generic words any long document contains, so
 * they are always checked in full.
 *
 * @param {Record<string, any>} result - Model output (mutated copy returned)
 * @param {Array<{ description?: string }>} [smartFolders]
 * @param {string | null} [documentText] - The file's extracted text and name
 * @returns {Record<string, any>}
 */
function dropPromptEchoes(result, smartFolders = [], documentText = null) {
  if (!result || typeof result !== 'object') return result;
  /** @param {string[]} texts */
  const toSources = (texts) =>
    texts.map((text) => new Set(echoWords(text))).filter((source) => source.size > 0);
  // The instructions without their "(e.g., ...)" examples: an example like
  // 'sunset_beach' is a legitimate thing for a picture to show.
  const schemaSources = toSources(
    Object.values(ANALYSIS_SCHEMA_PROMPT)
      .filter((v) => typeof v === 'string')
      .map((v) => v.replace(/\(e\.g\.[^)]*\)/gi, ' '))
  );
  const folderSources = toSources(
    (Array.isArray(smartFolders) ? smartFolders : [])
      .map((f) => f?.description)
      .filter((d) => typeof d === 'string' && d.trim())
  );
  /** @type {Set<string>} */
  const documentWords = new Set(
    typeof documentText === 'string' && documentText ? echoWords(documentText) : []
  );

  /**
   * @param {Set<string>} words
   * @param {Set<string>[]} sources
   * @param {Set<string>} [grounded] - Words not counted as shared
   */
  const copiesAny = (words, sources, grounded) =>
    sources.some((source) => {
      let shared = 0;
      for (const word of words) if (source.has(word) && !grounded?.has(word)) shared += 1;
      return (
        shared / words.size >= ECHO_CONTAINMENT && shared / source.size >= ECHO_SOURCE_COVERAGE
      );
    });

  /** @param {string} field */
  const isEcho = (field) => {
    const value = result[field];
    if (typeof value !== 'string') return false;
    // Compared without "(e.g., ...)" on both sides: a copied instruction
    // carries its examples along.
    const words = new Set(echoWords(value.replace(/\(e\.g\.[^)]*\)/gi, ' ')));
    if (words.size < ECHO_MIN_WORDS) return false;
    return (
      copiesAny(words, schemaSources) ||
      (!ECHO_SCHEMA_ONLY_FIELDS.has(field) && copiesAny(words, folderSources, documentWords))
    );
  };

  const echoed = ECHO_FIELDS.filter(isEcho);
  if (echoed.length === 0) return result;

  const cleaned = { ...result };
  for (const field of echoed) cleaned[field] = null;
  const confidence = _coerceConfidence(cleaned.confidence);
  if (confidence !== null) {
    // Callers use both scales; cap on the one the value is on.
    cleaned.confidence =
      confidence > 1 ? Math.min(confidence, ECHO_CONFIDENCE_CAP) : Math.min(confidence, 0.5);
  }
  cleaned.promptEchoFields = echoed;
  return cleaned;
}

/**
 * Read the STRATOSORT_ANALYSIS_EMBEDDING_QUEUE_WAIT env flag in a single
 * canonical way. Three analysis modules (image, media, semanticFolderMatcher)
 * previously each had their own one-liner that re-read process.env and
 * lowercased the string — renaming the env var would have meant a triple
 * grep. Centralizing here so future renames touch one place.
 *
 * Off by default: BatchAnalysisService already backpressures on queue depth,
 * so the per-call wait is opt-in for diagnostic / replay scenarios.
 *
 * @returns {boolean}
 */
function isPipelineEmbeddingQueueWaitEnabled() {
  return (
    String(process.env.STRATOSORT_ANALYSIS_EMBEDDING_QUEUE_WAIT || '').toLowerCase() === 'true'
  );
}

module.exports = {
  normalizeAnalysisResult,
  dropPromptEchoes,
  isPipelineEmbeddingQueueWaitEnabled
};
