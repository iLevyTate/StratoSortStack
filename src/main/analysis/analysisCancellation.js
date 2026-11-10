// @ts-check
/**
 * Ending an analysis the caller cancelled.
 *
 * The analyzers turn almost every failure into a filename fallback, so a file
 * always gets some result. A cancellation is not a failure: the caller asked
 * for the work to stop and will not use a result. Returned as a fallback, it
 * was recorded in the analysis history and the ready queue as if the file had
 * been analyzed.
 *
 * @module analysis/analysisCancellation
 */

const { isFallbackAnalysis } = require('../../shared/analysisProvenance');

/**
 * @param {string} [message]
 * @returns {Error & { code: string }}
 */
function createCancellationError(message = 'Analysis cancelled') {
  return Object.assign(new Error(message), { code: 'OPERATION_CANCELLED' });
}

/**
 * Whether the caller of an analyzer has cancelled: its abort signal fired, or
 * its isCancelled() poll says so.
 * @param {{ abortSignal?: AbortSignal | null, signal?: AbortSignal | null, isCancelled?: (() => boolean) | null } | null | undefined} options
 * @returns {boolean}
 */
function callerCancelled(options) {
  if (options?.abortSignal?.aborted || options?.signal?.aborted) return true;
  if (typeof options?.isCancelled !== 'function') return false;
  try {
    return options.isCancelled() === true;
  } catch {
    return false;
  }
}

/**
 * The error to throw for a failure caught while the caller has cancelled:
 * the failure itself when it already is a cancellation, otherwise a
 * cancellation that names it.
 * @param {any} error
 * @returns {Error & { code?: string }}
 */
function asCancellationError(error) {
  if (error?.code === 'OPERATION_CANCELLED') return error;
  const cancellation = createCancellationError();
  /** @type {any} */ (cancellation).cause = error;
  return cancellation;
}

/**
 * A fallback produced after the caller cancelled is the cancellation's doing
 * (the engine reported the abort as an ordinary failure and the analyzer fell
 * back): throw instead of returning it. A real analysis that finished anyway
 * is kept, the work is done.
 * @template T
 * @param {T} result
 * @param {Parameters<typeof callerCancelled>[0]} options
 * @returns {T}
 */
function rejectFallbackOfCancelledRun(result, options) {
  if (callerCancelled(options) && isFallbackAnalysis(/** @type {any} */ (result))) {
    throw createCancellationError();
  }
  return result;
}

module.exports = {
  createCancellationError,
  callerCancelled,
  asCancellationError,
  rejectFallbackOfCancelledRun
};
