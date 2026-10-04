// @ts-check
'use strict';

/**
 * node-llama-cpp runs a tokenize -> detokenize round-trip sanity check when it
 * loads a model and logs a `warn` when the result differs from the input
 * (LlamaModel.getWarnings() -> `_llama._log(LlamaLogLevel.warn, ...)`). That
 * check assumes a reversible tokenizer (LLaMA SentencePiece/BPE). BERT
 * WordPiece embedding models such as nomic-embed-text are intentionally lossy
 * on the reverse path (lowercasing, accent stripping, whitespace collapsing),
 * so they always trip it even though only the forward tokenize -> encode path
 * is used to produce embeddings. The warning is therefore a benign
 * false-positive for that model class.
 *
 * createFilteredLlamaLogger builds a logger for getLlama({ logger }) that drops
 * that one message and forwards every other log to Llama.defaultConsoleLogger,
 * so genuine warnings/errors stay visible and untouched.
 */

const TOKENIZER_ROUNDTRIP_MARKER =
  'to tokenize text and then detokenize it resulted in a different text';

/**
 * @param {unknown} message
 * @returns {boolean} true when the message is the benign tokenizer round-trip warning
 */
function isBenignTokenizerRoundtripWarning(message) {
  return typeof message === 'string' && message.includes(TOKENIZER_ROUNDTRIP_MARKER);
}

/**
 * Build a node-llama-cpp logger that suppresses the benign tokenizer
 * round-trip warning and delegates all other logs to the library default.
 *
 * @param {{ Llama?: { defaultConsoleLogger?: Function } }} [nodeLlamaModule]
 *   The dynamically-imported node-llama-cpp namespace (ESM-only).
 * @returns {(level: string, message: string) => void}
 */
function createFilteredLlamaLogger(nodeLlamaModule) {
  const Llama = nodeLlamaModule?.Llama;
  const forward =
    typeof Llama?.defaultConsoleLogger === 'function'
      ? Llama.defaultConsoleLogger.bind(Llama)
      : (/** @type {string} */ level, /** @type {string} */ message) => {
          // Defensive: only reached if the library default is unavailable
          // (e.g. an unexpected import shape). A throwing logger would break
          // model load, so mirror node-llama-cpp's console routing instead.
          const consoleAny = /** @type {any} */ (console);
          // eslint-disable-next-line no-console
          const sink = typeof consoleAny[level] === 'function' ? consoleAny[level] : console.log;
          sink(`[node-llama-cpp] ${message}`);
        };

  return (/** @type {string} */ level, /** @type {string} */ message) => {
    if (isBenignTokenizerRoundtripWarning(message)) return;
    forward(level, message);
  };
}

module.exports = {
  createFilteredLlamaLogger,
  isBenignTokenizerRoundtripWarning,
  TOKENIZER_ROUNDTRIP_MARKER
};
