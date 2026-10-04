// @ts-check
'use strict';

/**
 * parseSettingsImportJson
 *
 * Spawns a short-lived Worker thread to run `JSON.parse` on a user-supplied
 * settings export. See `workers/settingsImportParserWorker.js` for the
 * rationale. The wrapper:
 *
 *   1. Enforces a default 5-second timeout (configurable). On timeout, the
 *      worker is terminated so a pathological input can't hang the IPC
 *      handler.
 *   2. Falls back to in-process `JSON.parse` if spawning the worker fails
 *      (e.g. asar packaging quirks, worker_threads disabled). Better to
 *      block briefly than to fail the user's import silently.
 *   3. Wraps every error in a consistent shape the IPC handler can bubble
 *      up to the user:  { ok, value?, error? }.
 *
 * This module is intentionally standalone — no shared state, no lazy
 * singletons — so it's easy to unit-test with a real worker.
 */

const { Worker } = require('worker_threads');
const { createLogger } = require('../../shared/logger');
const { resolveWorkerPath } = require('../utils/workerPools');

const logger = createLogger('SettingsImportParser');

const DEFAULT_TIMEOUT_MS = 5000;
// Resolved like every other worker (a webpack entry emitted next to main.js
// and unpacked from the asar), not from a source-tree path: main is bundled
// with `__dirname` left as-is, so a path built from it pointed at
// `<app>/workers/…`, which exists in neither dev nor packaged builds. The
// missing file surfaced as an async 'error', so the in-process fallback
// below never ran and every import failed as "Invalid JSON".
const WORKER_NAME = 'settingsImportParserWorker';

/**
 * @param {string} jsonText  The UTF-8 string loaded from disk.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ ok: true, value: unknown } | { ok: false, error: string }>}
 */
async function parseSettingsImportJson(jsonText, opts = {}) {
  if (typeof jsonText !== 'string') {
    return { ok: false, error: 'Expected a string payload' };
  }
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  let worker;
  try {
    const workerPath = resolveWorkerPath(WORKER_NAME);
    if (!workerPath) {
      throw new Error(`${WORKER_NAME} bundle not found`);
    }
    worker = new Worker(workerPath, { workerData: { jsonText } });
  } catch (spawnErr) {
    // Fall back in-process — the 1 MB size cap means the worst case is a
    // short main-thread stall, far preferable to failing the import.
    logger.warn('[SettingsImportParser] Failed to spawn worker, falling back to main thread', {
      error: spawnErr && spawnErr.message
    });
    try {
      return { ok: true, value: JSON.parse(jsonText) };
    } catch (parseErr) {
      return { ok: false, error: parseErr.message || String(parseErr) };
    }
  }

  return new Promise((resolve) => {
    let settled = false;
    const resolveOnce = (/** @type {any} */ result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        worker.removeAllListeners();
        worker.terminate().catch(() => {
          /* ignore: we've already resolved */
        });
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      logger.warn('[SettingsImportParser] JSON parse exceeded timeout; terminating worker', {
        timeoutMs
      });
      resolveOnce({
        ok: false,
        error: `Settings import parse timed out after ${timeoutMs}ms`
      });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    worker.once('message', (msg) => {
      if (msg && msg.ok === true) {
        resolveOnce({ ok: true, value: msg.value });
      } else {
        resolveOnce({ ok: false, error: (msg && msg.error) || 'Unknown parse error' });
      }
    });
    worker.once('error', (err) => {
      resolveOnce({ ok: false, error: err.message || String(err) });
    });
    worker.once('exit', (code) => {
      if (code !== 0) {
        resolveOnce({
          ok: false,
          error: `Settings import worker exited with code ${code}`
        });
      }
    });
  });
}

module.exports = {
  parseSettingsImportJson,
  DEFAULT_TIMEOUT_MS
};
