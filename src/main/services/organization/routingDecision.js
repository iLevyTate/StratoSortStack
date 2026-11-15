// @ts-check
/**
 * Needs-review routing: is the engine's best folder a confident match?
 *
 * Every candidate the engine ranks clears some floor (semantic matches only
 * need 0.4), so a file that fits no folder still landed in whichever folder
 * came out on top. A file is routed to a Smart Folder only when one of these
 * holds for that folder:
 *
 *   - learned: a learned pattern, a learned correction or a saved feedback
 *     rule points there
 *   - content: what the file contains matches it at CONFIDENT_CONTENT_SCORE
 *     or more, and no other folder comes within AMBIGUOUS_MARGIN
 *   - name: the folder claims the file's extension, is named outright by the
 *     file's type, or (in the routing modes that rank by the analysis label)
 *     is named outright by that label or by the file's vendor, organization,
 *     sender, entity or project
 *
 * Otherwise the file needs review: it goes to the default folder when one
 * exists, and stays unassigned when none does. Template strategies (date,
 * project, workflow) never decide: they describe naming and subfolders, not
 * which folder a file belongs in.
 *
 * @module services/organization/routingDecision
 */

const path = require('path');
const { THRESHOLDS } = require('../../../shared/performanceConstants');
const {
  findSmartFolderNamedByLabel,
  findSmartFolderForExtension,
  isDefaultCategoryName
} = require('../../../shared/categoryFolderMatching');
const { isFallbackAnalysis } = require('../../../shared/analysisProvenance');
const { normalizePathForIndex } = require('../../../shared/pathSanitization');
const { getFileTypeCategory } = require('../autoOrganize/fileTypeUtils');

/**
 * Content score a folder needs before it counts as a confident match. The
 * analysis step already treats this as a confident folder match
 * (THRESHOLDS.FOLDER_MATCH_CONFIDENCE), and Hybrid routing asks the text model
 * for help below it (hybridLLMThreshold). The engine's own floor for listing
 * a semantic candidate at all is 0.4, which is where an unrelated file could
 * still pick up a folder.
 */
const CONFIDENT_CONTENT_SCORE = THRESHOLDS.FOLDER_MATCH_CONFIDENCE ?? 0.55;

/**
 * Two folders whose content scores are closer than this cannot be told
 * apart. Same value the analysis step uses for "no spread" between its top
 * two folders (CONFIDENCE_CALIBRATION.NO_SPREAD_THRESHOLD), where it caps the
 * file's confidence for the same reason.
 */
const AMBIGUOUS_MARGIN = THRESHOLDS.CONFIDENCE_CALIBRATION?.NO_SPREAD_THRESHOLD ?? 0.03;

/**
 * A folder chosen by name alone, with no ranked evidence of its own, is
 * capped below the auto-organize default (0.75): it routes the file in
 * Organize, but it never moves a file unattended.
 */
const NAME_ONLY_MAX_CONFIDENCE = 0.7;

const ROUTING_BASIS = Object.freeze({
  LEARNED: 'learned',
  CONTENT: 'content_match',
  NAME: 'name_match',
  NEEDS_REVIEW: 'needs_review'
});

const REVIEW_REASONS = Object.freeze({
  NO_MATCH: 'no_match',
  WEAK_MATCH: 'weak_match',
  AMBIGUOUS: 'ambiguous'
});

/** Analysis fields whose value can name a folder outright. */
const NAME_FIELDS = ['category', 'vendor', 'organization', 'entity', 'sender', 'project'];

/**
 * @param {any} suggestion
 * @returns {string} same smart folder → same key
 */
function folderKey(suggestion) {
  if (suggestion?.folderId) return `id:${suggestion.folderId}`;
  if (typeof suggestion?.path === 'string' && suggestion.path) {
    return `path:${normalizePathForIndex(suggestion.path)}`;
  }
  return `name:${String(suggestion?.folder || suggestion?.name || '').toLowerCase()}`;
}

/**
 * @param {any} folder - smart folder record
 * @returns {string[]} every key a suggestion for this folder may carry
 */
function folderKeys(folder) {
  const keys = [];
  if (folder?.id) keys.push(`id:${folder.id}`);
  if (typeof folder?.path === 'string' && folder.path) {
    keys.push(`path:${normalizePathForIndex(folder.path)}`);
  }
  keys.push(`name:${String(folder?.name || '').toLowerCase()}`);
  return keys;
}

/**
 * @param {any} a - suggestion
 * @param {any} b - suggestion or smart folder record
 */
function isSameFolder(a, b) {
  if (!a || !b) return false;
  const bId = b.folderId || b.id;
  if (a.folderId && bId) return a.folderId === bId;
  const bPath = typeof b.path === 'string' ? b.path : '';
  if (typeof a.path === 'string' && a.path && bPath) {
    return normalizePathForIndex(a.path) === normalizePathForIndex(bPath);
  }
  return (
    String(a.folder || a.name || '').toLowerCase() ===
    String(b.folder || b.name || '').toLowerCase()
  );
}

/**
 * @param {any} suggestion
 * @returns {boolean} the default catch-all (it is never a match on its own)
 */
function isDefaultFolderSuggestion(suggestion) {
  return (
    suggestion?.source === 'default' ||
    suggestion?.isDefault === true ||
    isDefaultCategoryName(suggestion?.folder)
  );
}

/**
 * @param {any} suggestion
 * @returns {boolean} a smart folder the engine could send the file to
 */
function isDestinationCandidate(suggestion) {
  return Boolean(
    suggestion &&
    suggestion.isSmartFolder &&
    !suggestion.unresolvedSmartFolder &&
    suggestion.source !== 'improvement' &&
    suggestion.folder &&
    !isDefaultFolderSuggestion(suggestion)
  );
}

/**
 * Best content score per folder, from the per-source suggestions before they
 * are merged. Content evidence is the semantic match, the text model's own
 * folder picks, and cluster membership. The analysis label (method
 * llm_category) is not: its score is lifted to 0.95 whenever it names a
 * folder, so it is judged by the name rule instead.
 *
 * @param {any[]} sourceSuggestions - canonicalized, source-tagged suggestions
 * @returns {Map<string, number>}
 */
function buildContentScores(sourceSuggestions) {
  /** @type {Map<string, number>} */
  const scores = new Map();
  for (const suggestion of Array.isArray(sourceSuggestions) ? sourceSuggestions : []) {
    if (!isDestinationCandidate(suggestion)) continue;
    const isContent =
      suggestion.source === 'semantic' ||
      suggestion.source === 'cluster' ||
      (suggestion.source === 'llm' && suggestion.method !== 'llm_category');
    if (!isContent) continue;
    const raw = Number(suggestion.score);
    if (!Number.isFinite(raw)) continue;
    const score = Math.max(0, Math.min(1, raw));
    const key = folderKey(suggestion);
    scores.set(key, Math.max(scores.get(key) || 0, score));
  }
  return scores;
}

/**
 * @param {Map<string, number>} contentScores
 * @param {any} suggestion
 */
function contentScoreOf(contentScores, suggestion) {
  return contentScores.get(folderKey(suggestion)) || 0;
}

/**
 * @param {Map<string, number>} contentScores
 * @param {any} suggestion
 * @returns {number} the best content score of any other folder
 */
function bestOtherContentScore(contentScores, suggestion) {
  const own = folderKey(suggestion);
  let best = 0;
  for (const [key, score] of contentScores) {
    if (key !== own && score > best) best = score;
  }
  return best;
}

/**
 * The folder the file names outright, if any: its extension, then its
 * analysis label and entity fields, then its file type.
 *
 * The label and entity fields count only when `useLabels` is set, which the
 * engine does in the routing modes that rank by the label (LLM-only, and
 * Hybrid when embeddings are weak). Embedding routing leaves the label out on
 * purpose: the analysis model is shown the folder list and told to answer
 * with one of its names, so its label names a folder almost every time,
 * including for files that fit none.
 *
 * @param {any} file
 * @param {any[]} smartFolders
 * @param {{ useLabels?: boolean }} [options]
 * @returns {{ folder: any, kind: 'extension'|'label'|'type', field?: string, value?: string } | null}
 */
function findNameMatch(file, smartFolders, { useLabels = true } = {}) {
  const folders = (Array.isArray(smartFolders) ? smartFolders : []).filter(
    (f) => f?.name && !f.isDefault && !isDefaultCategoryName(f.name)
  );
  if (folders.length === 0) return null;

  const extension = String(file?.extension || path.extname(file?.name || file?.path || ''))
    .replace(/^\./, '')
    .toLowerCase();

  const claimed = extension ? findSmartFolderForExtension(extension, folders) : null;
  if (claimed) return { folder: claimed, kind: 'extension', value: extension };

  const analysis = file?.analysis && typeof file.analysis === 'object' ? file.analysis : {};
  // A fallback analysis guessed its label from the file name, and an
  // embedding override replaced the model's label with the folder the
  // content matched (judged by the content rule). Neither is a name.
  const labelsUsable =
    useLabels && !isFallbackAnalysis(analysis) && analysis.categorySource !== 'embedding_override';
  if (labelsUsable) {
    for (const field of NAME_FIELDS) {
      const value = analysis[field];
      if (typeof value !== 'string' || !value.trim()) continue;
      const named = findSmartFolderNamedByLabel(value, folders);
      if (named) return { folder: named, kind: 'label', field, value: value.trim() };
    }
  }

  if (extension) {
    const typeName = getFileTypeCategory(extension);
    if (typeName && typeName !== 'Files') {
      const typed = findSmartFolderNamedByLabel(typeName, folders);
      if (typed) return { folder: typed, kind: 'type', value: typeName };
    }
  }
  return null;
}

/**
 * @param {any} candidate
 * @param {Set<string>} learnedKeys
 * @returns {boolean}
 */
function isLearned(candidate, learnedKeys) {
  if (!candidate) return false;
  if (candidate.method === 'learned_correction' || candidate.source === 'user_pattern') {
    return true;
  }
  const memory = candidate.memoryAdjustment;
  if (memory && Number(memory.boost) > Number(memory.penalty || 0)) return true;
  return learnedKeys.has(folderKey(candidate));
}

/**
 * @typedef {Object} RoutingDecision
 * @property {boolean} needsReview
 * @property {string} basis - one of ROUTING_BASIS
 * @property {string|null} reason - one of REVIEW_REASONS when needsReview
 * @property {any|null} candidate - the suggestion to route to (null when needsReview)
 * @property {{ kind: string, field?: string, value?: string }|null} nameMatch
 * @property {{ folder: string, score: number }|null} best - best content match
 * @property {{ folder: string, score: number }|null} runnerUp - next folder by content
 */

/**
 * Decide where a file goes, or that it needs review.
 *
 * @param {Object} params
 * @param {any} params.file
 * @param {any[]} params.ranked - final ranked suggestions (after memory and learned corrections)
 * @param {any[]} params.sourceSuggestions - canonicalized per-source suggestions, before merging
 * @param {any[]} [params.patternMatches] - learned user-pattern suggestions
 * @param {any[]} params.smartFolders
 * @param {boolean} [params.useLabels] - the routing mode ranks by the analysis label
 * @returns {RoutingDecision}
 */
function decideRouting({
  file,
  ranked,
  sourceSuggestions,
  patternMatches = [],
  smartFolders,
  useLabels = true
}) {
  const candidates = (Array.isArray(ranked) ? ranked : []).filter(isDestinationCandidate);
  const contentScores = buildContentScores(sourceSuggestions);
  const learnedKeys = new Set(
    (Array.isArray(patternMatches) ? patternMatches : [])
      .filter((match) => match?.method === 'user_pattern' && match.folder)
      .map((match) => {
        const folder = (Array.isArray(smartFolders) ? smartFolders : []).find(
          (f) => f?.name && String(f.name).toLowerCase() === String(match.folder).toLowerCase()
        );
        return folder ? folderKeys(folder) : [folderKey(match)];
      })
      .flat()
  );
  const nameMatch = findNameMatch(file, smartFolders, { useLabels });

  /** @param {any} candidate */
  const isContentConfident = (candidate) => {
    const score = contentScoreOf(contentScores, candidate);
    return (
      score >= CONFIDENT_CONTENT_SCORE &&
      score - bestOtherContentScore(contentScores, candidate) >= AMBIGUOUS_MARGIN
    );
  };
  /** @param {any} candidate */
  const isNamed = (candidate) => Boolean(nameMatch && isSameFolder(candidate, nameMatch.folder));

  // Content summary for logs and the review message.
  /** @type {{ key: string, score: number }[]} */
  const byContent = [...contentScores.entries()]
    .map(([key, score]) => ({ key, score }))
    .sort((a, b) => b.score - a.score);
  /** @param {{ key: string, score: number }|undefined} entry */
  const describe = (entry) => {
    if (!entry) return null;
    const match = candidates.find((c) => folderKey(c) === entry.key);
    return match ? { folder: match.folder, score: Math.round(entry.score * 100) / 100 } : null;
  };
  const best = describe(byContent[0]);
  const runnerUp = describe(byContent[1]);

  /**
   * @param {any} candidate
   * @param {string} basis
   * @returns {RoutingDecision}
   */
  const route = (candidate, basis) => ({
    needsReview: false,
    basis,
    reason: null,
    candidate,
    nameMatch: basis === ROUTING_BASIS.NAME && nameMatch ? stripFolder(nameMatch) : null,
    best,
    runnerUp
  });

  const top = candidates[0] || null;
  if (top) {
    // The folder already in front keeps its place whenever it is confident,
    // so confident matches and learned corrections route as before.
    if (isLearned(top, learnedKeys)) return route(top, ROUTING_BASIS.LEARNED);
    if (isContentConfident(top)) return route(top, ROUTING_BASIS.CONTENT);
    if (isNamed(top)) return route(top, ROUTING_BASIS.NAME);
  }

  const learned = candidates.find((candidate) => isLearned(candidate, learnedKeys));
  if (learned) return route(learned, ROUTING_BASIS.LEARNED);

  const contentBest = byContent[0]
    ? candidates.find((candidate) => folderKey(candidate) === byContent[0].key)
    : null;
  if (contentBest && isContentConfident(contentBest)) {
    return route(contentBest, ROUTING_BASIS.CONTENT);
  }

  if (nameMatch) {
    const rankedNamed = candidates.find(isNamed);
    return route(rankedNamed || buildNameCandidate(nameMatch, file), ROUTING_BASIS.NAME);
  }

  const topContent = byContent[0]?.score || 0;
  /** @type {string} */
  let reason = REVIEW_REASONS.NO_MATCH;
  if (topContent >= CONFIDENT_CONTENT_SCORE) reason = REVIEW_REASONS.AMBIGUOUS;
  else if (candidates.length > 0) reason = REVIEW_REASONS.WEAK_MATCH;
  return {
    needsReview: true,
    basis: ROUTING_BASIS.NEEDS_REVIEW,
    reason,
    candidate: null,
    nameMatch: null,
    best: best || (top ? { folder: top.folder, score: 0 } : null),
    runnerUp
  };
}

/**
 * @param {{ folder: any, kind: string, field?: string, value?: string }} nameMatch
 */
function stripFolder(nameMatch) {
  const { kind, field, value } = nameMatch;
  return { kind, ...(field ? { field } : {}), ...(value ? { value } : {}) };
}

/**
 * A suggestion for a folder chosen by name alone. Its confidence is the
 * analysis's own, capped at NAME_ONLY_MAX_CONFIDENCE.
 *
 * @param {{ folder: any, kind: string }} nameMatch
 * @param {any} file
 */
function buildNameCandidate(nameMatch, file) {
  const folder = nameMatch.folder;
  const raw = Number(file?.analysis?.confidence);
  const own = Number.isFinite(raw) ? (raw > 1 ? raw / 100 : raw) : NAME_ONLY_MAX_CONFIDENCE;
  const confidence = Math.max(0, Math.min(NAME_ONLY_MAX_CONFIDENCE, own));
  return {
    folder: folder.name,
    path: folder.path,
    folderId: folder.id || null,
    description: folder.description || '',
    score: confidence,
    confidence,
    method: 'name_match',
    source: 'name',
    isSmartFolder: true
  };
}

module.exports = {
  CONFIDENT_CONTENT_SCORE,
  AMBIGUOUS_MARGIN,
  NAME_ONLY_MAX_CONFIDENCE,
  ROUTING_BASIS,
  REVIEW_REASONS,
  decideRouting,
  findNameMatch,
  isDestinationCandidate
};
