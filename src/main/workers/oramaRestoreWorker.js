// @ts-check
'use strict';

/**
 * oramaRestoreWorker
 *
 * worker_threads entry that reads one saved Orama collection (or its
 * embedding sidecar) off the main thread: file read, LZ4 decode, JSON.parse
 * and the prototype-pollution strip all happen here. The format of what it
 * sends back, and why, is in oramaRestoreLoader.js; OramaVectorService
 * starts one of these per file and falls back to the same loader in-process
 * when it cannot.
 */

const { parentPort, workerData } = require('worker_threads');
const { runRestoreWorker } = require('./oramaRestoreLoader');

if (parentPort) {
  runRestoreWorker(parentPort, workerData);
}
