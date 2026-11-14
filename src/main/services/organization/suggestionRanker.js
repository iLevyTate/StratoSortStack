// @ts-check
/**
 * Suggestion Ranker
 *
 * Ranking, deduplication, and scoring for organization suggestions.
 * Extracted from OrganizationSuggestionService for better maintainability.
 *
 * @module services/organization/suggestionRanker
 */

/**
 * Source-based weight multipliers
 */
/** @type {Record<string, number>} */
const sourceWeights = {
  llm: 1.5, // LLM content analysis is PRIMARY - semantic understanding first
  user_pattern: 1.2, // User patterns are valuable but don't override content understanding
  semantic: 1.1, // Embedding similarity supports but doesn't dominate
  cluster: 1.1, // Cluster-based suggestions support organization
  pattern: 1.0, // Historical patterns are baseline
  strategy: 1.0, // Strategy-based are standard
  llm_creative: 0.7 // Creative suggestions are experimental
};

/** calculateConfidence multiplies a user pattern's confidence by this. */
const USER_PATTERN_CONFIDENCE_BOOST = 1.3;

/**
 * Rank and deduplicate suggestions
 * @param {Array<any>} suggestions - All suggestions to rank
 * @returns {Array<any>} Ranked and deduplicated suggestions
 */
function rankSuggestions(suggestions) {
  // Deduplicate by folder name
  const uniqueSuggestions = new Map();

  for (const suggestion of suggestions) {
    const key = suggestion.folder?.toLowerCase();
    if (!key) continue;

    if (!uniqueSuggestions.has(key)) {
      uniqueSuggestions.set(key, { ...suggestion });
    } else {
      // Merge scores if duplicate (working on our cloned copy, not caller's object)
      const existing = uniqueSuggestions.get(key);

      // An improvement candidate ("this folder could be enhanced") is an idea,
      // not evidence, and its score carries a +0.2 fit bonus. Merged into a
      // real match it took over that match's source, and the primary filter
      // then ruled the folder out. A real match wins outright either way.
      if (suggestion.source === 'improvement' && existing.source !== 'improvement') continue;
      if (existing.source === 'improvement' && suggestion.source !== 'improvement') {
        uniqueSuggestions.set(key, { ...suggestion });
        continue;
      }

      // Keep the source that ranks higher once weighted (check BEFORE
      // updating). Comparing raw confidence let a content match at 0.61 take
      // a learned folder's source (0.60, weighted higher), so agreeing
      // evidence dropped that folder below its rival.
      if (applySourceWeight(suggestion) > applySourceWeight(existing)) {
        existing.source = suggestion.source;
        existing.method = suggestion.method;
        // The explanation is written from these, so they follow the source.
        existing.strategyName = suggestion.strategyName;
        existing.namedBy = suggestion.namedBy;
      }

      // Then update to max scores
      existing.score = Math.max(existing.score, suggestion.score);
      existing.confidence = Math.max(existing.confidence, suggestion.confidence);
    }
  }

  // Apply weighting based on source
  const weighted = Array.from(uniqueSuggestions.values()).map((s) => ({
    ...s,
    weightedScore: applySourceWeight(s)
  }));

  // Sort by weighted score
  return weighted.sort((a, b) => b.weightedScore - a.weightedScore);
}

/**
 * Apply source-based weighting to scores
 * @param {Record<string, any>} suggestion - Suggestion to weight
 * @returns {number} Weighted score
 */
function applySourceWeight(suggestion) {
  const weight = sourceWeights[suggestion.source] || 1.0;
  return (suggestion.score || 0) * weight;
}

/**
 * Calculate confidence for a suggestion
 * @param {Record<string, any>} suggestion - Suggestion to evaluate
 * @returns {number} Confidence score 0-1
 */
function calculateConfidence(suggestion) {
  if (!suggestion) return 0;

  // Take the HIGHER of the two (F-201 / CP-25): `confidence` carries the
  // calibrated cap (≤ 0.75 in common cases) while `score` carries the
  // "trust the LLM's explicit category" boost (≥ 0.95). Reading confidence
  // first made that boost dead on the auto-organize path.
  const rawConfidence = Number(suggestion.confidence);
  const rawScore = Number(suggestion.score);
  let confidence = Math.max(
    Number.isFinite(rawConfidence) ? rawConfidence : 0,
    Number.isFinite(rawScore) ? rawScore : 0
  );

  // Boost if matches user pattern
  if (suggestion.source === 'user_pattern') {
    confidence = Math.min(1.0, confidence * USER_PATTERN_CONFIDENCE_BOOST);
  }

  // `score` is also the ranking key, and the cluster boost multiplies it past
  // 1. Callers read anything above 1 as a percentage (1.24 became "1%").
  confidence = Math.min(1.0, confidence);

  return Math.round(confidence * 100) / 100;
}

/**
 * A copy of `suggestion` whose score and confidence are lowered so that
 * calculateConfidence returns at most `max` (it boosts a user pattern, so a
 * raw cap alone would not hold). Other fields are kept.
 * @param {Record<string, any>} suggestion
 * @param {number} max
 * @returns {Record<string, any>}
 */
function capSuggestionConfidence(suggestion, max) {
  const boost = suggestion?.source === 'user_pattern' ? USER_PATTERN_CONFIDENCE_BOOST : 1;
  const rawMax = max / boost;
  /** @param {any} value */
  const cap = (value) => {
    const n = Number(value);
    return Math.min(Number.isFinite(n) ? n : 0, rawMax);
  };
  return { ...suggestion, score: cap(suggestion?.score), confidence: cap(suggestion?.confidence) };
}

/**
 * Generate human-readable explanation for suggestion
 * @param {Record<string, any>} suggestion - Suggestion to explain
 * @param {Record<string, any>} file - File being organized
 * @returns {string} Human-readable explanation
 */
function generateExplanation(suggestion, file) {
  if (!suggestion) {
    return 'No clear match found. Consider creating a new folder.';
  }

  // The user's own corrections overrode the folder that ranked first (item 16).
  // Checked before the source: the folder keeps the source of its evidence
  // (usually user_pattern), but the reason it is first is the corrections.
  if (suggestion.method === 'learned_correction' && suggestion.learnedOverride) {
    const { from, files } = suggestion.learnedOverride;
    return `You moved ${files} similar files from "${from}" to "${suggestion.folder}"`;
  }

  // A strategy template names its folder after one part of the file. Say
  // which part when it is known; the template's title describes none of them.
  /** @type {Record<string, string>} */
  const strategyFolderNamedBy = {
    category: `The analysis labeled this file "${suggestion.folder}"`,
    fileType: `"${suggestion.folder}" matches this file's type`,
    purpose: `The analysis described this file as "${suggestion.folder}"`
  };

  /** @type {Record<string, string>} */
  const explanations = {
    semantic: `This file's meaning matches "${suggestion.folder}"`,
    user_pattern: `You've organized similar files this way before`,
    strategy:
      strategyFolderNamedBy[suggestion.namedBy] ||
      `Using ${suggestion.strategyName || 'your preferred'} organization method`,
    llm: `Based on the file's content and purpose`,
    pattern: `This is where ${(file?.extension || 'these').toUpperCase()} files usually go`,
    llm_creative: suggestion.reasoning || 'Alternative way to organize this file',
    folder_improvement: `"${suggestion.folder}" could be enhanced for this type of file`,
    improvement: suggestion.improvement || `Suggested improvement for better organization`,
    default: 'No Smart Folder matched what this file contains',
    new_folder_suggestion: 'A new folder would be perfect for this file type',
    cluster: suggestion.clusterLabel
      ? `This file clusters with ${suggestion.clusterPeersInFolder || 'similar'} files in "${suggestion.folder}" (${suggestion.clusterLabel})`
      : `Similar files are grouped together in "${suggestion.folder}"`,
    cluster_membership: `${suggestion.clusterPeersInFolder || 'Multiple'} similar files from "${suggestion.clusterLabel || 'the same cluster'}" are already in this folder`,
    cluster_label_match: `The "${suggestion.clusterLabel}" cluster matches this folder's purpose`,
    cluster_batch: `Organize this cluster of ${suggestion.clusterSize || 'related'} files together`
  };

  // Add confidence-based prefix (reserved for future use)
  const prefix = '';

  return (
    prefix +
    (explanations[suggestion.source] || explanations[suggestion.method] || 'Based on file analysis')
  );
}

/**
 * Combine suggestions from multiple sources
 * @param {Record<string, any>} sources - Object with suggestion arrays by source
 * @returns {Array<any>} Combined suggestions with source tags
 */
function combineSuggestions(sources) {
  const allSuggestions = [];

  for (const [source, suggestions] of Object.entries(sources)) {
    for (const suggestion of suggestions) {
      allSuggestions.push({ ...suggestion, source });
    }
  }

  return allSuggestions;
}

module.exports = {
  sourceWeights,
  rankSuggestions,
  applySourceWeight,
  calculateConfidence,
  capSuggestionConfidence,
  generateExplanation,
  combineSuggestions
};
