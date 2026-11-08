// @ts-check
'use strict';

/**
 * Reading a saved Orama collection and its embedding sidecar back from disk.
 *
 * One implementation, two places to run it:
 *
 *   - in-process (`loadPersistedCollection`, `loadPersistedSidecar`): the
 *     fallback, and the default under tests;
 *   - in a worker_thread (`loadInWorker` on the main side, `runRestoreWorker`
 *     in oramaRestoreWorker.js): the same functions run in the worker, and
 *     only their results cross the thread boundary.
 *
 * Why a worker: read + LZ4 decode + JSON.parse + the prototype-pollution strip
 * of a 264 MB collection took ~1.1 s of uninterrupted main-thread time, and a
 * large library restores several collections at startup. In the worker that
 * time is off the main thread. What comes back is built to be cheap to take
 * in:
 *
 *   - Documents arrive in batches of DOC_BATCH_SIZE, one batch per request
 *     from the main side (it asks for the next one from a setImmediate, so
 *     IPC and timers run between batches). Node delivers queued port
 *     messages back to back, so pushing every batch at once would have put
 *     the whole structured-clone deserialization into one block again.
 *   - Each batch's embedding arrays travel as one transferred Float64Array
 *     (zero copy); the documents carry `embedding: null` in its place, and
 *     the main side writes a plain number[] back in (the stored form Orama
 *     and the on-disk JSON both need). Float64 keeps every value exactly as
 *     JSON.parse produced it.
 *   - The sidecar travels as one Float64Array plus its ids, and the main side
 *     builds a vector only when restore asks for it: most documents carry
 *     their own embedding, so most sidecar vectors are never materialized.
 *
 * The on-disk format and every outcome the restore code distinguishes (file
 * missing, unreadable, too large for a string, decodes to nothing, does not
 * parse, parses without documents) are the same either way: the worker runs
 * these same functions and sends the outcome back with the error's name,
 * message and code intact.
 *
 * @module workers/oramaRestoreLoader
 */

const fs = require('fs').promises;
const { tryParseLarge } = require('../../shared/safeJsonOps');
const lz4 = require('../../shared/lz4Codec');

// Documents per message from the worker. A batch of 512 768-dim documents
// is ~3 MB of vectors (transferred, not copied) plus their metadata; taking
// one in costs the main thread about a millisecond.
const DOC_BATCH_SIZE = 512;
// The main side gives up on a worker that sends nothing for this long and
// reads in-process instead. Generous: the first message waits for the whole
// read + parse of the largest file.
const WORKER_IDLE_TIMEOUT_MS = 120_000;

/**
 * @typedef {'ok' | 'read-error' | 'empty' | 'parse-error'} LoadStatus
 *   read-error: the file could not be read or decoded (ENOENT included).
 *   empty: it read, and decoded to no text at all.
 *   parse-error: it read, and the text is not JSON.
 */

/**
 * @typedef {object} CollectionLoad
 * @property {LoadStatus} status
 * @property {any} error - set unless status is 'ok'
 * @property {any[] | null} docList - the saved documents (`docs.docs` values
 *   with a truthy id), or null when the JSON holds no documents object
 * @property {string} [text] - the decoded text; in-process loads only
 */

/**
 * @typedef {object} SidecarVectors
 * @property {number} size
 * @property {(id: string) => number[] | undefined} get
 * @property {() => Iterable<string>} ids - in the saved file's key order
 */

/**
 * Normalize persisted embedding payloads to plain numeric arrays.
 * Handles Array, TypedArray, and object-with-numeric-keys shapes.
 * @param {any} value
 * @param {any} [expectedDim]
 * @returns {number[] | null}
 */
function normalizeEmbeddingVector(value, expectedDim = null) {
  let vector = null;
  if (Array.isArray(value)) {
    vector = value;
  } else if (ArrayBuffer.isView(value)) {
    vector = Array.from(/** @type {any} */ (value));
  } else if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      keys.sort((a, b) => Number(a) - Number(b));
      vector = keys.map((k) => value[k]);
    }
  }

  if (!Array.isArray(vector) || vector.length === 0) return null;
  if (Number.isFinite(expectedDim) && expectedDim > 0 && vector.length !== expectedDim) return null;

  const normalized = vector.map((n) => Number(n));
  if (normalized.some((n) => !Number.isFinite(n))) return null;
  return normalized;
}

/**
 * @param {string} filePath
 * @param {boolean} decompress - the file is an LZ4 frame
 * @returns {Promise<string>}
 */
async function readPersistedText(filePath, decompress) {
  if (decompress) {
    const compressed = await fs.readFile(filePath);
    return (await lz4.uncompress(compressed)).toString('utf8');
  }
  const raw = await fs.readFile(filePath, 'utf-8');
  return typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
}

/**
 * The documents of a parsed collection: `docs.docs` of the compact save
 * (`{ docs: { docs, count } }`) and of Orama's full export alike. The rest of
 * a full export (its indexes, a second copy of every vector) is never read.
 * @param {any} parsed
 * @returns {any[] | null}
 */
function extractDocList(parsed) {
  const rawDocs = parsed?.docs?.docs;
  if (!rawDocs || typeof rawDocs !== 'object') return null;
  return Object.values(rawDocs).filter((d) => d && d.id);
}

/**
 * Read, decode and parse one saved collection file.
 * @param {string} filePath
 * @param {{ decompress: boolean, keepText?: boolean }} options
 * @returns {Promise<CollectionLoad>}
 */
async function loadPersistedCollection(filePath, { decompress, keepText = true }) {
  let text;
  try {
    text = await readPersistedText(filePath, decompress);
  } catch (error) {
    return { status: 'read-error', error, docList: null };
  }
  const parse = tryParseLarge(text);
  if (text === '') return { status: 'empty', error: parse.error, docList: null };
  if (!parse.success) {
    return {
      status: 'parse-error',
      error: parse.error || new Error('Unknown persistence parse failure'),
      docList: null
    };
  }
  /** @type {CollectionLoad} */
  const result = { status: 'ok', error: null, docList: extractDocList(parse.value) };
  if (keepText) result.text = text;
  return result;
}

/**
 * @param {Record<string, number[]>} vectors
 * @returns {SidecarVectors}
 */
function objectSidecar(vectors) {
  return {
    size: Object.keys(vectors).length,
    get: (id) => (Object.prototype.hasOwnProperty.call(vectors, id) ? vectors[id] : undefined),
    ids: () => Object.keys(vectors)
  };
}

/**
 * The normalized vectors of a sidecar file, or null when it is missing,
 * unreadable or does not parse to an object (a sidecar is a repair source,
 * never required).
 * @param {string} filePath
 * @param {number | null} dimension
 * @returns {Promise<Record<string, number[]> | null>}
 */
async function readSidecarVectors(filePath, dimension) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    // Persisted, user-writable state: strip prototype-pollution keys.
    const parsed = tryParseLarge(typeof raw === 'string' ? raw : String(raw)).value;
    if (!parsed || typeof parsed !== 'object') return null;
    /** @type {Record<string, number[]>} */
    const normalized = {};
    for (const [docId, emb] of Object.entries(parsed)) {
      const vector = normalizeEmbeddingVector(emb, dimension);
      if (vector) normalized[docId] = vector;
    }
    return normalized;
  } catch {
    return null;
  }
}

/**
 * @param {string} filePath
 * @param {{ dimension: number | null }} options
 * @returns {Promise<SidecarVectors | null>}
 */
async function loadPersistedSidecar(filePath, { dimension }) {
  const vectors = await readSidecarVectors(filePath, dimension);
  return vectors ? objectSidecar(vectors) : null;
}

// ---------------------------------------------------------------------------
// Crossing the thread boundary

/** @param {any} error */
function serializeError(error) {
  if (!error) return null;
  return {
    name: typeof error.name === 'string' ? error.name : 'Error',
    message: typeof error.message === 'string' ? error.message : String(error),
    code: error.code
  };
}

/** @type {Record<string, ErrorConstructor>} */
const BUILTIN_ERRORS = { RangeError, SyntaxError, TypeError };

/**
 * Rebuild an error so the restore code classifies it as it would the
 * original: same message and code, and still a RangeError (or SyntaxError,
 * TypeError) where V8 raised one; isStringTooLongError checks both.
 * @param {any} data
 */
function deserializeError(data) {
  if (!data) return null;
  const ErrorType = BUILTIN_ERRORS[data.name] || Error;
  const error = new ErrorType(data.message);
  if (data.code !== undefined) Object.assign(error, { code: data.code });
  return error;
}

/** @param {any} value */
function isPackableVector(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'number') return false;
  }
  return true;
}

/**
 * Move a batch's numeric embedding arrays into one Float64Array. Each packed
 * document keeps its `embedding` key (set to null), so unpacking restores the
 * key order too. Anything that is not a non-empty all-number array is left
 * on the document for structured clone to copy as is.
 * @param {any[]} docs - mutated
 */
function packDocBatch(docs) {
  const lens = new Int32Array(docs.length).fill(-1);
  const starts = new Float64Array(docs.length);
  let total = 0;
  for (let i = 0; i < docs.length; i++) {
    const embedding = docs[i].embedding;
    if (!isPackableVector(embedding)) continue;
    lens[i] = embedding.length;
    starts[i] = total;
    total += embedding.length;
  }
  const values = new Float64Array(total);
  for (let i = 0; i < docs.length; i++) {
    if (lens[i] < 0) continue;
    values.set(docs[i].embedding, starts[i]);
    docs[i].embedding = null;
  }
  return { docs, starts, lens, values };
}

/**
 * @param {Float64Array} values
 * @param {number} start
 * @param {number} length
 * @returns {number[]}
 */
function vectorAt(values, start, length) {
  const out = new Array(length);
  for (let j = 0; j < length; j++) out[j] = values[start + j];
  return out;
}

/**
 * @param {{ docs: any[], starts: Float64Array, lens: Int32Array, values: Float64Array }} batch
 * @param {any[]} out - the unpacked documents are appended here
 */
function unpackDocBatch(batch, out) {
  const { docs, starts, lens, values } = batch;
  for (let i = 0; i < docs.length; i++) {
    if (lens[i] >= 0) docs[i].embedding = vectorAt(values, starts[i], lens[i]);
    out.push(docs[i]);
  }
}

/**
 * @param {Record<string, number[]>} vectors
 */
function packSidecar(vectors) {
  const ids = Object.keys(vectors);
  const lens = new Int32Array(ids.length);
  const starts = new Float64Array(ids.length);
  let total = 0;
  for (let i = 0; i < ids.length; i++) {
    lens[i] = vectors[ids[i]].length;
    starts[i] = total;
    total += lens[i];
  }
  const values = new Float64Array(total);
  for (let i = 0; i < ids.length; i++) values.set(vectors[ids[i]], starts[i]);
  return { ids, starts, lens, values };
}

/**
 * A sidecar whose vectors stay packed until asked for.
 * @param {{ ids: string[], starts: Float64Array, lens: Int32Array, values: Float64Array }} packed
 * @returns {SidecarVectors}
 */
function packedSidecar(packed) {
  const { ids, starts, lens, values } = packed;
  /** @type {Map<string, number> | null} */
  let index = null;
  return {
    size: ids.length,
    get(id) {
      if (!index) {
        index = new Map();
        for (let i = 0; i < ids.length; i++) index.set(ids[i], i);
      }
      const i = index.get(id);
      return i === undefined ? undefined : vectorAt(values, starts[i], lens[i]);
    },
    ids: () => ids
  };
}

/**
 * Worker side: answer one request on `port`, then wait to be terminated.
 * `fatal` means the worker cannot do the job here (the main side reads
 * in-process instead); every outcome of the read itself is a normal reply.
 * @param {any} port - worker_threads parentPort
 * @param {any} request - workerData
 */
async function runRestoreWorker(port, request) {
  try {
    const { kind, filePath } = request || {};
    if (kind === 'sidecar') {
      const vectors = await readSidecarVectors(filePath, request.dimension ?? null);
      if (!vectors) {
        port.postMessage({ type: 'sidecar', present: false });
        return;
      }
      const packed = packSidecar(vectors);
      port.postMessage({ type: 'sidecar', present: true, ...packed }, [
        packed.values.buffer,
        packed.starts.buffer,
        packed.lens.buffer
      ]);
      return;
    }
    if (kind !== 'collection') throw new Error(`Unknown restore request kind: ${kind}`);
    // Without the binding the codec hands back the LZ4 bytes undecoded, which
    // would read as a corrupt file. Let the main side decode it instead.
    if (request.decompress && !lz4.isLz4BindingAvailable) {
      port.postMessage({
        type: 'fatal',
        error: serializeError(
          Object.assign(new Error('LZ4 library unavailable in the restore worker'), {
            cause: lz4.lz4BindingError
          })
        )
      });
      return;
    }
    const result = await loadPersistedCollection(filePath, {
      decompress: Boolean(request.decompress),
      keepText: false
    });
    const docList = result.docList;
    if (result.status !== 'ok' || !docList) {
      port.postMessage({
        type: 'done',
        status: result.status,
        error: serializeError(result.error),
        hasDocs: false
      });
      return;
    }
    const batchSize = Number(request.batchSize) > 0 ? Number(request.batchSize) : DOC_BATCH_SIZE;
    let next = 0;
    const sendNext = () => {
      if (next >= docList.length) {
        port.postMessage({ type: 'done', status: 'ok', error: null, hasDocs: true });
        return;
      }
      const batch = packDocBatch(docList.slice(next, next + batchSize));
      // Drop the worker's references as it goes so its heap shrinks.
      docList.fill(null, next, next + batchSize);
      next += batchSize;
      port.postMessage({ type: 'docs', ...batch }, [
        batch.values.buffer,
        batch.starts.buffer,
        batch.lens.buffer
      ]);
    };
    port.on('message', (/** @type {any} */ message) => {
      if (message === 'next') sendNext();
    });
    sendNext();
  } catch (error) {
    port.postMessage({ type: 'fatal', error: serializeError(error) });
  }
}

/**
 * Main side: run one request in a fresh worker. Resolves with what the
 * in-process function would have returned (a CollectionLoad, or a
 * SidecarVectors / null); rejects only when the worker itself failed (could
 * not start, crashed, replied `fatal`, or went quiet), so the caller can fall
 * back to reading in-process.
 * @param {string} workerPath
 * @param {{ kind: 'collection', filePath: string, decompress: boolean, batchSize?: number } | { kind: 'sidecar', filePath: string, dimension: number | null }} request
 * @param {{ idleTimeoutMs?: number }} [options]
 * @returns {Promise<any>}
 */
function loadInWorker(workerPath, request, options = {}) {
  const { Worker } = require('worker_threads');
  const idleTimeoutMs = options.idleTimeoutMs ?? WORKER_IDLE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    /** @type {any} */
    let worker;
    try {
      worker = new Worker(workerPath, { workerData: request });
    } catch (error) {
      reject(error);
      return;
    }
    /** @type {any[]} */
    const docList = [];
    let settled = false;
    /** @type {any} */
    let idleTimer = null;
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        finish(reject, new Error(`Restore worker sent nothing for ${idleTimeoutMs} ms`));
      }, idleTimeoutMs);
      if (typeof idleTimer.unref === 'function') idleTimer.unref();
    };
    /**
     * @param {(value: any) => void} settle
     * @param {any} value
     */
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      worker.removeAllListeners();
      // A late 'error' with no listener would throw on the main thread.
      worker.on('error', () => {});
      worker.terminate().catch(() => {});
      settle(value);
    };
    worker.on('message', (/** @type {any} */ message) => {
      if (settled) return;
      armIdleTimer();
      try {
        switch (message?.type) {
          case 'docs':
            unpackDocBatch(message, docList);
            // Ask for the next batch from a fresh macrotask, so whatever else
            // is queued (IPC, timers, I/O) runs between batches.
            setImmediate(() => {
              if (!settled) worker.postMessage('next');
            });
            return;
          case 'done':
            finish(
              resolve,
              message.status === 'ok'
                ? { status: 'ok', error: null, docList: message.hasDocs ? docList : null }
                : { status: message.status, error: deserializeError(message.error), docList: null }
            );
            return;
          case 'sidecar':
            finish(resolve, message.present ? packedSidecar(message) : null);
            return;
          case 'fatal':
            finish(reject, deserializeError(message.error));
            return;
          default:
            finish(reject, new Error(`Unexpected restore worker message: ${message?.type}`));
        }
      } catch (error) {
        finish(reject, error);
      }
    });
    worker.on('error', (/** @type {any} */ error) => finish(reject, error));
    worker.on('exit', (/** @type {number} */ code) =>
      finish(reject, new Error(`Restore worker exited with code ${code} before replying`))
    );
    armIdleTimer();
  });
}

module.exports = {
  DOC_BATCH_SIZE,
  normalizeEmbeddingVector,
  loadPersistedCollection,
  loadPersistedSidecar,
  loadInWorker,
  runRestoreWorker
};
