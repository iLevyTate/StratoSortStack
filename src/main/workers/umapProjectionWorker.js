// @ts-check
'use strict';

/**
 * UMAP projection worker (worker_threads).
 *
 * Runs UMAP off the main thread so projecting tens of thousands of high-dim
 * embeddings to 2D never blocks Electron's main process. The worker is
 * long-lived and holds the fitted UMAP model for the session, which is what
 * makes incremental `.transform()` of newly-added documents cheap: we fit once
 * on the full corpus, then project only new vectors into the existing space
 * without a full refit.
 *
 * Protocol (parentPort messages):
 *   in  { id, type:'fit',       vectors:number[][], params?, seed? }
 *   in  { id, type:'transform', vectors:number[][] }
 *   out { id, type:'progress',  epoch:number }
 *   out { id, type:'fitDone',   coords:number[][] }
 *   out { id, type:'transformDone', coords:number[][] }
 *   out { id, type:'error',     error:string }
 *
 * The worker never touches disk or IPC — the parent (AtlasProjectionService)
 * owns caching, persistence, and the fitted/unfitted lifecycle.
 */

const { parentPort } = require('worker_threads');

/** @type {import('umap-js').UMAP | null} */
let fittedModel = null;

/**
 * Deterministic PRNG (mulberry32) so a given corpus projects the same way each
 * run — otherwise UMAP's random init would reshuffle the map on every rebuild
 * and users would lose their spatial memory of where things are.
 * @param {number} seed
 * @returns {() => number}
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Trivial deterministic layout for corpora too small for UMAP's neighbour
 * graph (needs several points). Spreads points on a circle.
 * @param {number} n
 * @returns {number[][]}
 */
function smallLayout(n) {
  if (n <= 0) return [];
  if (n === 1) return [[0, 0]];
  const coords = [];
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n;
    coords.push([Math.cos(angle), Math.sin(angle)]);
  }
  return coords;
}

/**
 * @param {number[][]} vectors
 * @param {{ nNeighbors?: number, minDist?: number, nComponents?: number }} [params]
 * @param {number} [seed]
 * @returns {Promise<number[][]>}
 */
async function fit(vectors, params = {}, seed = 42) {
  const n = vectors.length;
  if (n < 3) {
    fittedModel = null;
    return smallLayout(n);
  }

  const { UMAP } = require('umap-js');
  const nNeighbors = Math.max(2, Math.min(params.nNeighbors ?? 15, n - 1));
  const model = new UMAP({
    nComponents: params.nComponents ?? 2,
    nNeighbors,
    minDist: params.minDist ?? 0.1,
    random: mulberry32(seed)
  });

  const coords = await model.fitAsync(vectors, (epoch) => {
    // Throttle progress so we don't flood the parent's message queue.
    if (epoch % 10 === 0) {
      parentPort?.postMessage({ type: 'progress', epoch });
    }
  });
  fittedModel = model;
  return coords;
}

/**
 * @param {number[][]} vectors
 * @returns {number[][]}
 */
function transform(vectors) {
  if (!fittedModel) {
    throw new Error('transform called before a successful fit');
  }
  if (!Array.isArray(vectors) || vectors.length === 0) return [];
  return /** @type {number[][]} */ (fittedModel.transform(vectors));
}

parentPort?.on('message', async (/** @type {any} */ msg) => {
  const id = msg?.id;
  try {
    if (msg?.type === 'fit') {
      const coords = await fit(msg.vectors, msg.params, msg.seed);
      parentPort?.postMessage({ id, type: 'fitDone', coords });
    } else if (msg?.type === 'transform') {
      const coords = transform(msg.vectors);
      parentPort?.postMessage({ id, type: 'transformDone', coords });
    } else {
      parentPort?.postMessage({ id, type: 'error', error: `Unknown message type: ${msg?.type}` });
    }
  } catch (err) {
    parentPort?.postMessage({
      id,
      type: 'error',
      error: (err && /** @type {any} */ (err).message) || String(err)
    });
  }
});
