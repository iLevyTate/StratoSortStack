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
 * waits for the earlier batch to finish and then runs only the files it did
 * not finish. Those are read from the durable ready queue, not the analysis
 * cache, which keeps results for only 30 minutes and a few hundred files.
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
 * selectRemaining runs before each retry: it returns the files still to
 * analyze (an empty list ends the run, nothing left), or null to keep the
 * previous list. runBatchPath receives that list (undefined on the first try).
 *
 * @param {{
 *   runBatchPath: (files?: any[]) => Promise<any>,
 *   isActiveRun: () => boolean,
 *   abortSignal?: AbortSignal | null,
 *   onWaiting?: () => void,
 *   selectRemaining?: () => Promise<any[] | null>,
 *   retryMs?: number,
 *   sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>
 * }} options
 * @returns {Promise<'ran' | 'superseded' | 'finished-elsewhere'>}
 */
export async function runBatchPathWhenFree({
  runBatchPath,
  isActiveRun,
  abortSignal = null,
  onWaiting,
  selectRemaining,
  retryMs = BATCH_BUSY_RETRY_MS,
  sleep = wait
}) {
  let announced = false;
  /** @type {any[] | undefined} */
  let files;
  for (;;) {
    // A run aborted before its request went out (Discover unmounted during
    // start-up, React StrictMode in development) must not send it: its
    // listeners ignore every event of an aborted run, so the batch would run
    // with nothing applying its results.
    if (!isActiveRun() || abortSignal?.aborted) return 'superseded';
    try {
      await runBatchPath(files);
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
    if (selectRemaining) {
      const remaining = await selectRemaining();
      if (!isActiveRun() || abortSignal?.aborted) return 'superseded';
      if (Array.isArray(remaining)) {
        if (remaining.length === 0) return 'finished-elsewhere';
        files = remaining;
      }
    }
  }
}

/**
 * The files of a run that the ready queue does not already hold a current
 * result for. A ready entry counts only when the file has not changed since
 * it was analyzed (same modified time, when both are known).
 * @param {any[]} files - the run's files ({ path, modified? })
 * @param {any[]} readyEntries - ready queue entries ({ path, modified?, analysis })
 * @param {(p: string) => string} canonical - path key
 * @returns {any[]}
 */
export function filesNotYetReady(files, readyEntries, canonical) {
  /** @type {Map<string, any>} */
  const ready = new Map();
  for (const entry of Array.isArray(readyEntries) ? readyEntries : []) {
    if (!entry?.path || !entry.analysis) continue;
    ready.set(canonical(entry.path), entry);
  }
  return (Array.isArray(files) ? files : []).filter((file) => {
    const entry = ready.get(canonical(file?.path));
    if (!entry) return true;
    const a = file?.modified ? Date.parse(file.modified) : NaN;
    const b = entry.modified ? Date.parse(entry.modified) : NaN;
    return Number.isFinite(a) && Number.isFinite(b) && a !== b;
  });
}
