// @ts-check
/**
 * LLM answer parsing + citation reconciliation for chat.
 *
 * Everything the model returns passes through here before reaching the UI
 * or session memory. Output caps bound the impact of a successful
 * jailbreak (item count, per-item length, citation count), and citations
 * are intersected with the KNOWN source ids so a model that hallucinates
 * or echoes attacker-supplied citations can't point the UI at unrelated
 * documents. Extracted from ChatService; the facade keeps thin
 * delegations.
 */

const { createLogger } = require('../../../shared/logger');
const { extractAndParseJSON } = require('../../utils/jsonRepair');
const { INVISIBLE_INJECTION_CHARS, CONTROL_CHARS_EXCEPT_NEWLINE } = require('./promptSanitizers');

const logger = createLogger('CitationExtractor');

const MAX_ANSWER_ITEM_CHARS = 8000;
const MAX_ANSWER_ITEMS = 20;
const MAX_FOLLOWUPS = 10;
const MAX_FOLLOWUP_CHARS = 400;
const MAX_CITATIONS_PER_ITEM = 20;

// Matches an inline citation token like `[doc-3]`, optionally with the leading
// space the model puts before it, capturing the numeric id. Used to reconcile
// inline citations in answer text against the actual retrieved sources so a
// hallucinated/out-of-range number never reaches the UI as a broken `[?]`.
const INLINE_CITATION_RE = /[ \t]*\[doc-(\d+)\]/g;

function clampAnswerText(/** @type {any} */ text) {
  if (typeof text !== 'string') return '';
  // Strip invisible/bidi injection chars from model output too; these can
  // survive a round trip through the LLM and render as hidden text in the
  // UI that reads differently from what's displayed.
  const cleaned = text
    .replace(INVISIBLE_INJECTION_CHARS, '')
    .replace(CONTROL_CHARS_EXCEPT_NEWLINE, ' ');
  if (cleaned.length <= MAX_ANSWER_ITEM_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_ANSWER_ITEM_CHARS)}…`;
}

/**
 * Remove inline `[doc-N]` citation tokens whose id isn't among the retrieved
 * sources. The model occasionally over-counts or invents citation numbers;
 * those tokens previously survived into the answer text and rendered as a
 * broken `[?]` in the UI (the renderer has no source to resolve them to).
 * Stripping them keeps the prose clean while every surviving citation still
 * resolves to a real, numbered source. Leftover double spaces / spaces before
 * punctuation from removed tokens are collapsed.
 *
 * @param {string} text Answer text that may contain inline citations.
 * @param {Set<string>} sourceIds Set of valid `doc-N` ids for this turn.
 * @returns {string} Text with only resolvable citation tokens retained.
 */
function reconcileInlineCitations(text, sourceIds) {
  if (typeof text !== 'string' || !text.includes('[doc-')) return text;
  let stripped = 0;
  const reconciled = text
    .replace(INLINE_CITATION_RE, (match, num) => {
      if (sourceIds.has(`doc-${num}`)) return match;
      stripped += 1;
      return '';
    })
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (stripped > 0) {
    logger.debug('[CitationExtractor] Stripped unresolved inline citations from answer text', {
      stripped,
      knownSources: sourceIds.size
    });
  }
  return reconciled;
}

function parseResponse(/** @type {any} */ rawResponse, /** @type {any} */ sources) {
  /** @type {{ documentAnswer: any[], modelAnswer: any[], followUps: any[] }} */
  const fallback = {
    documentAnswer: [],
    modelAnswer: rawResponse ? [{ text: clampAnswerText(String(rawResponse)) }] : [],
    followUps: []
  };

  const parsed = /** @type {Record<string, any>} */ (
    extractAndParseJSON(rawResponse, fallback) || fallback
  );
  const sourceIds = new Set((sources || []).map((/** @type {any} */ s) => s.id));

  const documentAnswer = Array.isArray(parsed.documentAnswer) ? parsed.documentAnswer : [];
  const modelAnswer = Array.isArray(parsed.modelAnswer) ? parsed.modelAnswer : [];
  const followUps = Array.isArray(parsed.followUps) ? parsed.followUps : [];

  // Output caps: these bound the impact of a successful jailbreak by
  // capping item count, per-item length, and citation count. Citations
  // are also intersected with the known source IDs so a model that
  // hallucinates or echoes attacker-supplied citations can't point the
  // UI at unrelated documents.
  const normalizedDocs = documentAnswer
    .slice(0, MAX_ANSWER_ITEMS)
    .map((/** @type {any} */ item) => ({
      // Reconcile inline [doc-N] tokens against the real sources so a
      // hallucinated/out-of-range citation never renders as a broken [?].
      text:
        typeof item?.text === 'string'
          ? reconcileInlineCitations(clampAnswerText(item.text.trim()), sourceIds)
          : '',
      citations: Array.isArray(item?.citations)
        ? item.citations
            .filter((/** @type {any} */ id) => sourceIds.has(id))
            .slice(0, MAX_CITATIONS_PER_ITEM)
        : []
    }))
    .filter((/** @type {any} */ item) => item.text.length > 0);

  const normalizedModel = modelAnswer
    .slice(0, MAX_ANSWER_ITEMS)
    .map((/** @type {any} */ item) => ({
      text: typeof item?.text === 'string' ? clampAnswerText(item.text.trim()) : ''
    }))
    .filter((/** @type {any} */ item) => item.text.length > 0);

  return {
    documentAnswer: normalizedDocs,
    modelAnswer: normalizedModel,
    followUps: followUps
      .filter((/** @type {any} */ q) => typeof q === 'string' && q.trim().length > 0)
      .slice(0, MAX_FOLLOWUPS)
      .map((/** @type {any} */ q) => {
        const t = q.trim();
        return t.length > MAX_FOLLOWUP_CHARS ? `${t.slice(0, MAX_FOLLOWUP_CHARS)}…` : t;
      })
  };
}

function formatForMemory(/** @type {any} */ parsed, /** @type {any} */ sources = []) {
  const docs = parsed.documentAnswer?.map((/** @type {any} */ d) => d.text).filter(Boolean) || [];
  const model = parsed.modelAnswer?.map((/** @type {any} */ d) => d.text).filter(Boolean) || [];
  const combined = [...docs, ...model].join('\n');
  if (!combined) return 'No answer produced.';

  // Include source names so follow-up questions like "tell me more about
  // the tax return" can be grounded. Without this, the flat history loses
  // all context about which documents were referenced.
  const sourceNames = (sources || [])
    .filter((/** @type {any} */ s) => s?.name)
    .slice(0, 6)
    .map((/** @type {any} */ s) => s.name);
  if (sourceNames.length > 0) {
    return `${combined}\n[Referenced: ${sourceNames.join(', ')}]`;
  }
  return combined;
}

module.exports = {
  parseResponse,
  clampAnswerText,
  reconcileInlineCitations,
  formatForMemory,
  MAX_ANSWER_ITEM_CHARS,
  MAX_ANSWER_ITEMS,
  MAX_FOLLOWUPS,
  MAX_FOLLOWUP_CHARS,
  MAX_CITATIONS_PER_ITEM,
  INLINE_CITATION_RE
};
