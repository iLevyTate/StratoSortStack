// @ts-check
/**
 * Waiting out a batch this window already has running.
 *
 * The preload allows one `analysis:analyze-batch` request per window at a
 * time and rejects a second with `CONCURRENCY_LIMIT` ("Operation already in
 * progress"). That happens when Discover re-mounts (navigation, React
 * StrictMode in development) while the batch it started earlier is still
 * running in the main process: the new run cannot see the old request.
 *
 * Treating that rejection as a batch failure used to start the per-file
 * worker pool, which analyzed the same files a second time in parallel with
 * the running batch: duplicate notifications, two runs fighting over the GPU,
 * and a restart loop when the second run requeued its files. Instead the run
 * waits for the earlier batch to finish and then runs its own; files the
 * earlier batch finished come back from the analysis cache.
 */

/** How often a waiting run tries the batch again. */
export const BATCH_BUSY_RETRY_MS = 3000;

/**
 * @param {any} error
 * @returns {boolean} the batch request was refused because one is already running
 */
export function isBatchAlreadyRunning(error) {
  if (!error) return false;
  if (error.code === 'CONCURRENCY_LIMIT') return true;
  return /Operation already in progress: analysis:analyze-batch/.test(String(error.message || ''));
}

/**
 * @param {number} ms
 * @param {AbortSignal | null | undefined} signal
 * @returns {Promise<void>}
 */
function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', done);
      resolve();
    }
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

/**
 * Run the batch path, waiting while this window's earlier batch is still in
 * progress. Returns without running when this run is superseded or aborted
 * while it waits. Any other error is rethrown for the caller's fallback.
 *
 * @param {{
 *   runBatchPath: () => Promise<any>,
 *   isActiveRun: () => boolean,
 *   abortSignal?: AbortSignal | null,
 *   onWaiting?: () => void,
 *   retryMs?: number,
 *   sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>
 * }} options
 * @returns {Promise<'ran' | 'superseded'>}
 */
export async function runBatchPathWhenFree({
  runBatchPath,
  isActiveRun,
  abortSignal = null,
  onWaiting,
  retryMs = BATCH_BUSY_RETRY_MS,
  sleep = wait
}) {
  let announced = false;
  for (;;) {
    try {
      await runBatchPath();
      return 'ran';
    } catch (error) {
      if (!isBatchAlreadyRunning(error)) throw error;
    }
    if (!isActiveRun() || abortSignal?.aborted) return 'superseded';
    if (!announced) {
      announced = true;
      onWaiting?.();
    }
    await sleep(retryMs, abortSignal);
    if (!isActiveRun() || abortSignal?.aborted) return 'superseded';
  }
}
