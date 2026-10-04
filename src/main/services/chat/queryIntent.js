// @ts-check
/**
 * Query-intent detectors for chat.
 *
 * Pure classification of the user's query text (and retrieved sources for
 * contradiction detection) — no service state. Extracted from ChatService;
 * the facade keeps thin `_is*` delegations so behavior-level oracles in
 * ChatService.extended.test.js stay valid.
 */

const CONVERSATIONAL_EXACT_PHRASES = new Set([
  'hello',
  'hi',
  'hey',
  'thanks',
  'thank you',
  'good morning',
  'good afternoon',
  'good evening',
  'who are you',
  'what can you do',
  'what do you do',
  'help',
  'help me',
  'yo',
  'sup',
  'howdy',
  'bye',
  'goodbye',
  'see ya',
  'test',
  'testing',
  'you there',
  'anyone there',
  'is anyone there'
]);

function isConversational(/** @type {any} */ query) {
  // Chat queries shouldn't be conversational if they're over 100 chars.
  if (query.length > 100) return false;
  const clean = query
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .trim();
  if (!clean) return false;

  if (CONVERSATIONAL_EXACT_PHRASES.has(clean)) return true;

  // Pattern-match capability / meta questions (safe, bounded patterns)
  // Anchored at both ends (the query is already lower-cased, stripped of
  // punctuation and under 100 chars) so that a question about documents
  // that merely starts the same way ("what can you tell me about the Q3
  // report", "can you help me find my W-2", "what is your take on the
  // lease") still goes through retrieval.
  const capabilityPatterns = [
    /^what can you (?:do|help(?: me)? with|offer)$/,
    /^what (?:do|does|will) you do$/,
    /^how (?:can|do) you help(?: me)?$/,
    /^how does this work$/,
    /^what are you$/,
    /^what (?:is|are) your (?:name|purpose|role|job|capabilities|features)$/,
    /^(?:can|could) you help(?: me)?$/,
    /^tell me (?:about yourself|what you do)$/,
    /^what (?:kind|type) of (?:things|help|questions) can you (?:do|answer|help with)$/,
    /^how do i use (?:this|you|chat|the chat|the app|stratosort)$/
  ];
  if (capabilityPatterns.some((rx) => rx.test(clean))) return true;

  // Status-check patterns: "are you up and running", "are you there", etc.
  // These are meta queries about the assistant, not document queries.
  if (
    /^are you\s+(?:up|there|alive|working|online|ready|awake|listening|ok|okay|running)\b/.test(
      clean
    )
  )
    return true;
  if (/^(?:you|u)\s+(?:there|up|alive|working|ready|awake)\b/.test(clean)) return true;

  return false;
}

function isComparisonQuery(/** @type {any} */ query) {
  const q = String(query || '').toLowerCase();
  if (!q || q.length > 300) return false;
  return (
    /\bcompar(?:e|ing|ison)\b/.test(q) ||
    /\bdifferences?\s+between\b/.test(q) ||
    /\bhow\s+(?:does|do)\s+.+\s+differ\b/.test(q) ||
    /\bvs\.?\b/.test(q) ||
    /\bside[\s-]by[\s-]side\b/.test(q) ||
    /\bcontrast\b/.test(q)
  );
}

function isGapAnalysisQuery(/** @type {any} */ query) {
  const q = String(query || '').toLowerCase();
  if (!q || q.length > 300) return false;
  return (
    /\bgap(?:s)?\s+(?:in|analysis)\b/.test(q) ||
    /\bwhat(?:'s|\s+is)\s+missing\b/.test(q) ||
    /\bwhat\s+(?:questions?|topics?)\s+(?:can't|cannot|aren't|are\s+not)\b/.test(q) ||
    /\bnot\s+covered\b/.test(q) ||
    /\bonly\s+(?:one|1|single)\s+source\b/.test(q) ||
    /\bcoverage\b/.test(q) ||
    /\bblind\s+spots?\b/.test(q)
  );
}

function isHolisticSynthesisQuery(/** @type {any} */ query) {
  const q = String(query || '').toLowerCase();
  if (!q) return false;
  return (
    /\ball\b.*\bdocs?\b/.test(q) ||
    /\bacross\b.*\bdocs?\b/.test(q) ||
    /\bholistic\b/.test(q) ||
    /\bbig picture\b/.test(q) ||
    /\bdig deeper\b/.test(q) ||
    /\bprofile\b/.test(q) ||
    /\bbased on\b.*\bdocuments?\b/.test(q)
  );
}

function isCorrectionFeedback(/** @type {any} */ query) {
  const q = String(query || '').toLowerCase();
  if (!q) return false;
  return (
    /\bnot correct\b/.test(q) ||
    /\bwrong\b/.test(q) ||
    /\bregenerate\b/.test(q) ||
    /\bretry\b/.test(q) ||
    /\bdig deeper\b/.test(q) ||
    /\bholistic\b/.test(q)
  );
}

function detectContradictions(/** @type {any} */ sources) {
  if (!sources || sources.length < 2) return [];

  const contradictions = [];

  for (let i = 0; i < sources.length - 1; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      const a = sources[i];
      const b = sources[j];

      // Check for shared entities/tags that might indicate topical overlap
      const aTags = new Set([
        ...(a.tags || []).map((/** @type {any} */ t) => t.toLowerCase()),
        ...(a.entity ? [a.entity.toLowerCase()] : []),
        ...(a.category ? [a.category.toLowerCase()] : [])
      ]);
      const bTags = new Set([
        ...(b.tags || []).map((/** @type {any} */ t) => t.toLowerCase()),
        ...(b.entity ? [b.entity.toLowerCase()] : []),
        ...(b.category ? [b.category.toLowerCase()] : [])
      ]);

      const sharedTopics = [...aTags].filter((t) => bTags.has(t));
      if (sharedTopics.length === 0) continue;

      // Check for date divergence (different dates suggest potential evolution/contradiction)
      const aDate = a.documentDate || '';
      const bDate = b.documentDate || '';
      const hasDifferentDates = aDate && bDate && aDate !== bDate;

      // Only flag as potential contradiction if there's topical overlap
      // AND some signal of divergence (different dates, different entities, etc.)
      if (hasDifferentDates || (a.entity && b.entity && a.entity !== b.entity)) {
        contradictions.push({
          docA: {
            id: a.id,
            name: a.name,
            date: aDate,
            snippet: (a.snippet || a.summary || '').slice(0, 200)
          },
          docB: {
            id: b.id,
            name: b.name,
            date: bDate,
            snippet: (b.snippet || b.summary || '').slice(0, 200)
          },
          sharedTopics,
          reason: hasDifferentDates ? 'different_dates' : 'different_entities'
        });
      }
    }
  }

  return contradictions.slice(0, 5);
}

module.exports = {
  CONVERSATIONAL_EXACT_PHRASES,
  isConversational,
  isComparisonQuery,
  isGapAnalysisQuery,
  isHolisticSynthesisQuery,
  isCorrectionFeedback,
  detectContradictions
};
