// @ts-check
const { LLAMA } = require('../../shared/performanceConstants');
const { getModel } = require('../../shared/modelRegistry');

const DEFAULT_CHARS_PER_TOKEN = 3.5;
const DEFAULT_HEADROOM_RATIO = 0.85;

/**
 * Latency-sane ceiling applied to a model's *advertised* context window when
 * deriving an embedding budget. Embedding a full 8k-token document on CPU is
 * needlessly slow and the marginal folder-routing/recall gain past ~2k tokens
 * is small. An explicitly configured `embeddingContextSize` bypasses this
 * ceiling (the user opted in), but the model-derived default never exceeds it.
 */
const EMBEDDING_INPUT_MAX_TOKENS = 2048;

/**
 * @param {any} text
 * @param {number} [charsPerToken]
 */
function estimateTokens(text, charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  if (!text) return 0;
  const safe = typeof text === 'string' ? text : String(text);
  const divisor = charsPerToken > 0 ? charsPerToken : DEFAULT_CHARS_PER_TOKEN;
  return Math.ceil(safe.length / divisor);
}

/**
 * @param {number | undefined} explicitLimit
 * @param {string | undefined} [modelName]
 */
function getEmbeddingTokenLimit(explicitLimit, modelName) {
  let base = LLAMA.CONTEXT_EMBEDDINGS || 512;

  if (typeof explicitLimit === 'number' && explicitLimit > 0) {
    base = explicitLimit;
  } else if (modelName) {
    const modelInfo = getModel(modelName);
    if (modelInfo?.contextLength) {
      // Clamp the model's full context window to a latency-sane ceiling. Without
      // this, callers that pass only a model name (e.g. the embedding-summary
      // builder) would otherwise inherit the historical 512-token floor because
      // they never threaded the model through -- the bug this fixes -- while an
      // unclamped 8192 window would swing too far the other way on CPU.
      base = Math.min(modelInfo.contextLength, EMBEDDING_INPUT_MAX_TOKENS);
    }
  }

  return Math.max(32, Math.floor(base * DEFAULT_HEADROOM_RATIO));
}

/**
 * @param {any} text
 * @param {number} maxTokens
 * @param {number} [charsPerToken]
 */
function truncateToTokenLimit(text, maxTokens, charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  const safe = typeof text === 'string' ? text : String(text || '');
  const maxChars = Math.max(0, Math.floor(maxTokens * charsPerToken));
  if (safe.length <= maxChars) {
    return { text: safe, wasTruncated: false, maxChars };
  }
  return { text: safe.slice(0, maxChars), wasTruncated: true, maxChars };
}

/**
 * @param {any} text
 * @param {{ maxTokens?: number, modelName?: string, charsPerToken?: number }} [options]
 */
function capEmbeddingInput(text, options = {}) {
  const maxTokens = getEmbeddingTokenLimit(options.maxTokens, options.modelName);
  const estimatedTokens = estimateTokens(text, options.charsPerToken);
  const capped = truncateToTokenLimit(text, maxTokens, options.charsPerToken);
  return {
    text: capped.text,
    wasTruncated: capped.wasTruncated,
    estimatedTokens,
    maxTokens,
    maxChars: capped.maxChars
  };
}

/**
 * Tokenizer-accurate variant of `capEmbeddingInput`. When the caller can
 * provide a `tokenize(text) => number[]` (or async equivalent) bound to
 * the actual embedding model, this routine binary-searches the exact
 * character slice that fits under `maxTokens`, avoiding both:
 *   - the 3.5 char/token heuristic underestimating CJK / emoji-heavy
 *     content and overflowing the model context, and
 *   - the heuristic overestimating code/markdown and truncating perfectly
 *     good input.
 *
 * Falls back to the heuristic path when no tokenizer is supplied or the
 * tokenize call throws (e.g. model unloaded mid-call during shutdown).
 *
 * @param {string} text
 * @param {Object} options
 * @param {(text: string) => (number[]|Promise<number[]>)} [options.tokenize]
 * @param {number} [options.maxTokens]
 * @param {string} [options.modelName]
 */
async function capEmbeddingInputWithTokenizer(text, options = {}) {
  const maxTokens = getEmbeddingTokenLimit(options.maxTokens, options.modelName);
  const safe = typeof text === 'string' ? text : String(text || '');
  const tokenize = typeof options.tokenize === 'function' ? options.tokenize : null;

  if (!tokenize || safe.length === 0) {
    const heuristic = capEmbeddingInput(safe, options);
    return { ...heuristic, tokenizerUsed: false };
  }

  let tokens;
  try {
    tokens = await tokenize(safe);
  } catch {
    const heuristic = capEmbeddingInput(safe, options);
    return { ...heuristic, tokenizerUsed: false, tokenizeFailed: true };
  }
  const actualTokens = Array.isArray(tokens) ? tokens.length : 0;
  if (actualTokens <= maxTokens) {
    return {
      text: safe,
      wasTruncated: false,
      estimatedTokens: actualTokens,
      maxTokens,
      maxChars: safe.length,
      tokenizerUsed: true
    };
  }

  // Binary search the char boundary whose tokenization fits under
  // maxTokens. Bounded to O(log n) tokenize calls (~12 for a 4k-char
  // input) so the overhead is negligible vs the embedding itself.
  let lo = 0;
  let hi = safe.length;
  let best = '';
  let bestTokens = 0;
  const MAX_ITER = 20;
  for (let i = 0; i < MAX_ITER && lo < hi; i++) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const candidate = safe.slice(0, mid);
    let candidateTokens;
    try {
      candidateTokens = await tokenize(candidate);
    } catch {
      break;
    }
    const candidateLen = Array.isArray(candidateTokens) ? candidateTokens.length : 0;
    if (candidateLen <= maxTokens) {
      best = candidate;
      bestTokens = candidateLen;
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  if (!best) {
    // All splits overflowed (e.g. first char is a multi-token glyph). Fall
    // back to heuristic truncation so the caller still gets *something*.
    const heuristic = capEmbeddingInput(safe, options);
    return { ...heuristic, tokenizerUsed: true, tokenizerExhausted: true };
  }

  return {
    text: best,
    wasTruncated: true,
    estimatedTokens: bestTokens,
    maxTokens,
    maxChars: best.length,
    tokenizerUsed: true
  };
}

module.exports = {
  capEmbeddingInput,
  capEmbeddingInputWithTokenizer,
  estimateTokens,
  getEmbeddingTokenLimit,
  truncateToTokenLimit,
  EMBEDDING_INPUT_MAX_TOKENS
};
