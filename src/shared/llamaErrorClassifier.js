// @ts-check
/**
 * Shared classifier for Llama model load / inference errors.
 *
 * Both the main process (LlamaService) and the renderer (errorMapping) need to
 * recognise the same small vocabulary of failure signatures so we can surface
 * actionable copy consistently. Keeping the patterns in one place prevents the
 * two sides from drifting.
 *
 * Exported as CommonJS so it can be required from main-side Node code and
 * imported from the renderer via the existing Webpack/Babel pipeline.
 *
 * @module shared/llamaErrorClassifier
 */

const { ERROR_CODES } = require('./errorCodes');

/**
 * Patterns that indicate the native addon crashed because of an unsupported
 * CPU instruction set (or an Electron ABI mismatch that manifests as SIGILL /
 * illegal instruction).
 */
const CPU_INCOMPAT_PATTERNS = [
  /sigill/i,
  /illegal instruction/i,
  /unsupported cpu/i,
  /avx(2|512)?.*required/i,
  /fatal error.*llama_addon\.node/i
];

/**
 * Patterns that indicate the configured model file cannot be located at the
 * expected userData path. Combined with a legacy-path hint, these trigger the
 * path-mismatch actionable copy.
 */
const MODEL_NOT_FOUND_PATTERNS = [
  /model not found/i,
  /enoent.*\.gguf/i,
  /no such file.*\.gguf/i,
  /failed to load model.*enoent/i
];

/**
 * Patterns that indicate the prompt (plus any pending response tokens) has
 * exceeded the loaded model's context window. We previously mislabeled these
 * as generic INFERENCE_FAILED, which sent the user to "retry with same
 * prompt" copy — the only real fix is to shorten the input or switch to a
 * model with a larger context.
 */
const CONTEXT_OVERFLOW_PATTERNS = [
  /context.*(overflow|exceed|too (large|big|long|many tokens))/i,
  /exceeds? (the )?context (window|size|length)/i,
  /n_tokens.*exceeds?.*n_ctx/i,
  /prompt is too long/i,
  /token limit exceeded/i
];

/**
 * Patterns that indicate the GGUF file itself is corrupt or truncated — a
 * partial download, interrupted install, or a version-incompatible model
 * file. These are distinct from "file missing" (MODEL_NOT_FOUND) because the
 * remediation is different: delete and re-download, not pick a different
 * model.
 */
const CORRUPT_GGUF_PATTERNS = [
  /invalid (gguf|magic)/i,
  /gguf.*(magic|header|version).*(mismatch|invalid|bad|unsupported)/i,
  /unexpected end of (file|gguf)/i,
  /failed to (parse|read) gguf/i,
  /truncated (gguf|model)/i,
  /corrupt(ed)? (gguf|model)/i
];

/**
 * Patterns that indicate mmap() or memory-mapped read of the model file
 * failed (insufficient virtual address space on 32-bit processes, a file
 * system that doesn't support mmap — e.g. some NFS/SMB mounts — or the file
 * being deleted out from under the mapping).
 */
const MMAP_FAILED_PATTERNS = [
  /mmap.*(failed|error|not supported)/i,
  /failed to (mmap|memory.?map) (file|model)/i,
  /madvise.*(failed|error)/i,
  /cannot (mmap|memory.?map)/i
];

/**
 * Patterns that indicate the GPU ran out of VRAM while loading or running
 * the model. Distinct from generic OOM so the UI can suggest "reduce
 * gpuLayers or switch to a smaller model / CPU-only build" instead of the
 * generic "reduce concurrency" hint.
 */
const VRAM_EXHAUSTED_PATTERNS = [
  /out of (vram|gpu memory)/i,
  /cuda (error|oom|out of memory)/i,
  /vulkan.*(out of|insufficient).*memory/i,
  /device.?lost/i,
  /vram.*(exhaust|insufficient|not enough)/i,
  /failed to allocate.*(vram|gpu)/i
];

/**
 * @param {unknown} input
 * @returns {string}
 */
function toText(input) {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (typeof (/** @type {any} */ (input).message) === 'string')
    return /** @type {any} */ (input).message;
  try {
    return String(input);
  } catch {
    return '';
  }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function looksLikeCpuIncompatibility(error) {
  const text = toText(error);
  if (!text) return false;
  return CPU_INCOMPAT_PATTERNS.some((re) => re.test(text));
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function looksLikeModelNotFound(error) {
  const anyErr = /** @type {any} */ (error);
  const code = typeof anyErr?.code === 'string' ? anyErr.code : null;
  if (code === ERROR_CODES.LLAMA_MODEL_NOT_FOUND) return true;
  const text = toText(error);
  if (!text) return false;
  return MODEL_NOT_FOUND_PATTERNS.some((re) => re.test(text));
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function looksLikeContextOverflow(error) {
  const text = toText(error);
  if (!text) return false;
  return CONTEXT_OVERFLOW_PATTERNS.some((re) => re.test(text));
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function looksLikeCorruptGguf(error) {
  const text = toText(error);
  if (!text) return false;
  return CORRUPT_GGUF_PATTERNS.some((re) => re.test(text));
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function looksLikeMmapFailure(error) {
  const text = toText(error);
  if (!text) return false;
  return MMAP_FAILED_PATTERNS.some((re) => re.test(text));
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function looksLikeVramExhausted(error) {
  const text = toText(error);
  if (!text) return false;
  return VRAM_EXHAUSTED_PATTERNS.some((re) => re.test(text));
}

/**
 * Inspect a thrown error and return a known Llama error code if one applies.
 * Returns `null` when the error doesn't match any known signature so callers
 * can fall back to their existing classification.
 *
 * Order matters: more specific signatures (CPU, VRAM, corrupt file) are
 * checked before the broader ones (missing model, generic OOM) so the
 * actionable copy downstream doesn't collapse into "try again".
 *
 * @param {unknown} error
 * @returns {string | null}
 */
function classifyLlamaError(error) {
  if (!error) return null;
  const anyErr = /** @type {any} */ (error);
  if (typeof anyErr?.code === 'string' && anyErr.code.startsWith('LLAMA_')) {
    return anyErr.code;
  }
  if (looksLikeCpuIncompatibility(error)) return ERROR_CODES.LLAMA_MODEL_INCOMPATIBLE_CPU;
  if (looksLikeVramExhausted(error)) return ERROR_CODES.LLAMA_GPU_ERROR;
  if (looksLikeCorruptGguf(error)) return ERROR_CODES.LLAMA_MODEL_LOAD_FAILED;
  if (looksLikeMmapFailure(error)) return ERROR_CODES.LLAMA_MODEL_LOAD_FAILED;
  if (looksLikeModelNotFound(error)) return ERROR_CODES.LLAMA_MODEL_NOT_FOUND;
  if (looksLikeContextOverflow(error)) return ERROR_CODES.LLAMA_INFERENCE_FAILED;
  return null;
}

module.exports = {
  classifyLlamaError,
  looksLikeCpuIncompatibility,
  looksLikeModelNotFound,
  looksLikeContextOverflow,
  looksLikeCorruptGguf,
  looksLikeMmapFailure,
  looksLikeVramExhausted,
  CPU_INCOMPAT_PATTERNS,
  MODEL_NOT_FOUND_PATTERNS,
  CONTEXT_OVERFLOW_PATTERNS,
  CORRUPT_GGUF_PATTERNS,
  MMAP_FAILED_PATTERNS,
  VRAM_EXHAUSTED_PATTERNS
};
