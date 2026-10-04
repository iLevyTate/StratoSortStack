// @ts-check
'use strict';

/**
 * settingsImportParserWorker
 *
 * Tiny worker_threads script whose only job is to `JSON.parse` a settings
 * import payload off the Electron main thread.
 *
 * Why a worker for a ~1 MB parse?
 *
 *   The settings file is user-supplied and attacker-controllable on the
 *   *contents* axis (the caller enforces a hard 1 MB size cap before we
 *   ever see it). Even at 1 MB, a maliciously crafted JSON document —
 *   think deeply nested arrays, very long strings, or huge numeric
 *   arrays — can push V8's parser into double-digit-millisecond territory
 *   on low-end hardware. Running the parse inside the main process blocks
 *   IPC, window updates, and the splash heartbeat during that window.
 *
 *   By moving the parse to a short-lived worker we keep the main thread
 *   responsive, and we can enforce a hard timeout on the worker so a
 *   pathological input fails closed instead of silently stalling startup.
 *
 * Contract:
 *   parentPort.postMessage({ ok: true,  value: <parsed> })  on success.
 *   parentPort.postMessage({ ok: false, error: <message> }) on parse failure.
 *
 * The worker intentionally receives the raw string (not a Buffer) — the
 * caller has already validated UTF-8 encoding and the file size, and
 * passing a string lets structured-clone avoid the extra `Buffer.from`
 * allocation inside the worker.
 */

const { parentPort, workerData } = require('worker_threads');

try {
  const { jsonText } = workerData || {};
  if (typeof jsonText !== 'string') {
    parentPort.postMessage({ ok: false, error: 'workerData.jsonText must be a string' });
  } else {
    const value = JSON.parse(jsonText);
    parentPort.postMessage({ ok: true, value });
  }
} catch (err) {
  parentPort.postMessage({
    ok: false,
    error: err && err.message ? err.message : String(err)
  });
}
