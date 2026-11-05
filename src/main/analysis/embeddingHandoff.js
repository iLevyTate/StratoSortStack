// @ts-check
/**
 * What an analysis pass already wrote to the search index, handed to the
 * watcher that runs right after it so the watcher does not redo the work.
 *
 * analyzeDocumentFile and analyzeImageFile attach `_embeddingForPersistence`
 * to their result: the file vector they computed, the metadata it was stored
 * with (including the path it was stored under), and two flags:
 *  - `wasEnqueued`: the file vector went onto the embedding queue, which
 *    persists it on its own.
 *  - `chunksEmbedded`: the file's passage (chunk) vectors were written.
 *
 * Both flags describe one run only. The analysis caches return the very
 * object they stored on a later hit, when nothing was queued or written, so
 * what goes into a cache has both flags cleared (see forAnalysisCache).
 * Without that, a cache hit would tell the watcher "already indexed" for a
 * file whose vectors may since have been removed or moved.
 */

/**
 * @typedef {object} EmbeddingHandoff
 * @property {number[]} [vector]
 * @property {string | null} [model]
 * @property {Record<string, any>} [meta]
 * @property {boolean} [wasEnqueued]
 * @property {boolean} [chunksEmbedded]
 */

/**
 * The hand-off attached to an analysis result, whichever nesting it uses.
 * @param {any} result
 * @returns {EmbeddingHandoff | null}
 */
function getEmbeddingHandoff(result) {
  if (!result || typeof result !== 'object') return null;
  return result._embeddingForPersistence || result.analysis?._embeddingForPersistence || null;
}

/**
 * The copy of an analysis result that may be stored in an analysis cache:
 * the hand-off keeps its vector (a cache hit can still upsert it directly)
 * but loses the this-run flags. Results without a hand-off are returned as
 * they are.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function forAnalysisCache(value) {
  const handoff = /** @type {any} */ (value)?._embeddingForPersistence;
  if (!handoff || typeof handoff !== 'object') return value;
  return /** @type {T} */ ({
    .../** @type {any} */ (value),
    _embeddingForPersistence: { ...handoff, wasEnqueued: false, chunksEmbedded: false }
  });
}

module.exports = {
  getEmbeddingHandoff,
  forAnalysisCache
};
