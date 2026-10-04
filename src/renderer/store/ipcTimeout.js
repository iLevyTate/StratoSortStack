// @ts-check
/**
 * Wrap an IPC promise with a timeout to prevent thunks from hanging
 * indefinitely if the main process is unresponsive.
 *
 * @param {Promise<any>} promise - The IPC call promise
 * @param {number} [ms] - Timeout in milliseconds
 * @returns {Promise<any>} - Resolves with the IPC result or rejects on timeout
 */
export const withIpcTimeout = (promise, ms = 10000) => {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('IPC timeout')), ms);
  });
  // Promise.race settles with whichever finishes first; the .finally() clears
  // the timer in both the success and timeout paths, eliminating the leak the
  // previous two-arg .then() form had to clean up manually.
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
};

/**
 * Cold-start options for settings / smart-folders bootstrap. Main can still be
 * wiring services (or the machine can be memory-starved) when the renderer
 * first mounts; a single 10s attempt false-alarms "degraded mode" banners even
 * though the same IPC succeeds a moment later.
 */
export const BOOTSTRAP_IPC_OPTIONS = Object.freeze({
  ms: 15000,
  retries: 3,
  retryDelayMs: 750
});

const isTimeoutError = (/** @type {any} */ error) =>
  /ipc timeout/i.test(String(error?.message || ''));

export const runIpcWithTimeoutRetry = async (
  /** @type {any} */ promiseFactory,
  { ms = 10000, retries = 1, retryDelayMs = 250 } = {}
) => {
  let attempt = 0;
  let lastError = null;

  while (attempt <= retries) {
    try {
      return await withIpcTimeout(promiseFactory(), ms);
    } catch (error) {
      lastError = error;
      if (!isTimeoutError(error) || attempt >= retries) {
        throw error;
      }
      attempt += 1;
      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
      continue;
    }
  }

  throw lastError || new Error('IPC timeout');
};
