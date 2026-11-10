// @ts-check
/**
 * Shared vision error classification.
 *
 * Keeps decode-pressure and input-data classification consistent across
 * VisionService hint extraction and watcher-level diagnostics.
 *
 * "failed to process image" and "failed to decode image" are classified as
 * decode pressure because llama-server returns these generic messages for ANY
 * image failure -- including KV cache slot exhaustion. Only unambiguously
 * file-level errors belong in the input-data list.
 */

const VISION_DECODE_PRESSURE_PATTERNS = [
  'failed to find a memory slot',
  'kv cache',
  'out of memory',
  'mtmd_helper_eval failed',
  'retrying with smaller batch size',
  'failed to process image',
  'failed to decode image'
];

const VISION_INPUT_DATA_PATTERNS = [
  'unable to make llava embedding',
  'unsupported image format',
  'zero length image',
  'invalid image'
];

function normalizeErrorMessage(/** @type {any} */ errorLike) {
  return String(errorLike?.message || errorLike || '').toLowerCase();
}

function isVisionDecodePressureError(/** @type {any} */ errorLike) {
  const message = normalizeErrorMessage(errorLike);
  return VISION_DECODE_PRESSURE_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * Decode pressure as the vision runtime reports it: in the server's own
 * message, or in the stderr excerpt VisionService attaches to the error
 * (`visionRuntimeHint`). The excerpt stays out of the message because the
 * retry and model-availability classifiers match substrings of it, and the
 * runtime's load banner ("CUDA0", "projector") is in that excerpt.
 * @param {any} errorLike
 * @returns {boolean}
 */
function isVisionRuntimeDecodePressure(errorLike) {
  return (
    isVisionDecodePressureError(errorLike) ||
    isVisionDecodePressureError(String(errorLike?.visionRuntimeHint || ''))
  );
}

function isVisionInputDataError(/** @type {any} */ errorLike) {
  const message = normalizeErrorMessage(errorLike);
  if (isVisionDecodePressureError(message)) {
    return false;
  }
  return VISION_INPUT_DATA_PATTERNS.some((pattern) => message.includes(pattern));
}

function classifyVisionError(/** @type {any} */ errorLike) {
  const message = normalizeErrorMessage(errorLike);
  return {
    message,
    isDecodePressure: isVisionDecodePressureError(message),
    isInputData: isVisionInputDataError(message)
  };
}

module.exports = {
  isVisionRuntimeDecodePressure,
  VISION_DECODE_PRESSURE_PATTERNS,
  VISION_INPUT_DATA_PATTERNS,
  normalizeErrorMessage,
  isVisionDecodePressureError,
  isVisionInputDataError,
  classifyVisionError
};
