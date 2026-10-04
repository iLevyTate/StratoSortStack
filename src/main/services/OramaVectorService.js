// @ts-check
/**
 * OramaVectorService - In-process vector database using Orama
 *
 * In-process, zero-dependency vector storage.
 * Supports BM25 + vector hybrid search and persistence with a stable service API.
 *
 * @module services/OramaVectorService
 */

const path = require('path');
const fs = require('fs').promises;
const { app } = require('electron');
const { EventEmitter } = require('events');
const { create, insert, search, remove, update, count, getByID } = require('@orama/orama');
// @ts-expect-error @orama/stemmers/english lacks a named export in its declaration; runtime shape is `{ english }`
const { english } = require('@orama/stemmers/english');
const ORAMA_TOKENIZER_CONFIG = { stemmer: english, stemming: true };
const { persist, restore: _restore } = require('@orama/plugin-data-persistence');
const { createLogger } = require('../../shared/logger');
const { createSingletonHelpers } = require('../../shared/singletonFactory');
const { AI_DEFAULTS, IPC_CHANNELS } = require('../../shared/constants');
const { ERROR_CODES } = require('../../shared/errorCodes');
const { attachErrorCode } = require('../../shared/errorHandlingUtils');
const { replaceFileWithRetry } = require('../../shared/atomicFile');
const { tryParse: safeJsonTryParse } = require('../../shared/safeJsonOps');
const { compress, uncompress } = require('../../shared/lz4Codec');
const { resolveEmbeddingDimension } = require('../../shared/embeddingDimensions');
const { cosineSimilarity } = require('../../shared/vectorMath');
const { getEmbeddingModel, loadLlamaConfig, getLlamaService } = require('../llamaUtils');
const { createTimeoutRace, swallow } = require('../../shared/promiseUtils');
const { updateEmbeddingIndexMetadata } = require('./vectorDb/embeddingIndexMetadata');
const { get: getConfig } = require('../../shared/config/index');
const { LRUCache } = require('../../shared/LRUCache');

/**
 * Orama 3.1.x search() NULLS THE VECTOR ON THE STORED DOCUMENT of every hit
 * unless `includeVectors` is set: search-vector.js does
 * `doc[vectorProperty] = null` on `orama.data.docs`, and search-fulltext.js's
 * removeVectorsFromHits reduces into `result.document` itself. Each query
 * therefore erased the vectors of the rows it returned. The in-memory vector
 * index still answered, which hid it, but getByID() then saw `embedding:
 * null` (every chunk clone on a move failed), and the next persist wrote the
 * nulls to disk: after a restart those rows came back as zero placeholders.
 * The sidecar (docs/ORAMA_VECTOR_SIDECAR.md) masked this for files and
 * folders; chunks had no sidecar.
 *
 * Every query here goes through this wrapper: Orama leaves the store alone,
 * and hits are shallow copies. Full-text hits drop the vector on the COPY (as
 * callers saw before); vector-mode hits keep it so the zero-placeholder filter
 * can actually see placeholders.
 * @param {any} db
 * @param {any} params
 * @returns {Promise<{ hits: any[], [key: string]: any }>}
 */
async function searchPreservingStoredVectors(db, params) {
  const result = await search(db, { ...params, includeVectors: true });
  if (params?.includeVectors === true || !Array.isArray(result?.hits)) return result;
  const keepVectors = params?.mode === 'vector';
  result.hits = result.hits.map((/** @type {any} */ hit) =>
    hit?.document
      ? {
          ...hit,
          document: keepVectors ? { ...hit.document } : { ...hit.document, embedding: null }
        }
      : hit
  );
  return result;
}

const logger = createLogger('OramaVectorService');

function getSystemAnalyticsSafe() {
  try {
    return require('../core/systemAnalytics');
  } catch {
    return null;
  }
}

function getDegradedStateTrackerSafe() {
  try {
    return require('./DegradedStateTracker').getInstance();
  } catch {
    return null;
  }
}

const PERSIST_COMPRESSION_ENABLED =
  String(process.env.STRATOSORT_ORAMA_COMPRESS || 'true').toLowerCase() !== 'false';

const writeFileAtomic = async (/** @type {any} */ filePath, /** @type {any} */ data) => {
  const tempPath = `${filePath}.tmp.${require('crypto').randomUUID()}`;
  try {
    await fs.writeFile(tempPath, data);
    await replaceFileWithRetry(tempPath, filePath);
  } catch (error) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
};

// Fallback embedding dimension when the model's own dimension is unknown.
// Follows AI_DEFAULTS.EMBEDDING.DIMENSIONS (384 for the default all-MiniLM
// profile; nomic-embed-text is 768) — the store re-syncs to the real model
// at init, so this only seeds a brand-new collection.
const DEFAULT_EMBEDDING_DIMENSION = AI_DEFAULTS.EMBEDDING?.DIMENSIONS || 384;

// Persistence settings
const PERSIST_DEBOUNCE_MS = 5000; // Debounce persistence writes
const MAX_PERSIST_WAIT_MS = 30000; // Max wait before forcing persistence
const DEFAULT_BATCH_UPSERT_CONCURRENCY = 3;
const MAX_BATCH_UPSERT_CONCURRENCY = 6;
const VECTOR_PRIMARY_VALIDATION_INTERVAL_MS = 60000;
const VECTOR_PRIMARY_MAX_REPAIR_ATTEMPTS = 2;
// Orama's vector search applies a default minimum-similarity cutoff
// (`DEFAULT_SIMILARITY = 0.8`); any candidate whose cosine similarity to the
// query is below it is dropped, so the search can return zero hits even when
// the index is fully populated. Every nearest-neighbour query here must pass
// an explicit floor, or it silently inherits that 0.8:
//
// - Folder routing: a document is rarely 0.8-similar to a folder, so every
//   folder query looked "empty" and the health path "repaired" the index on
//   each analysis.
// - File search: a short query is rarely 0.8-similar to a whole-document
//   vector. When nothing cleared 0.8 the brute-force fallback ran; when one
//   or two files did, ONLY those came back and every 0.6-0.79 match was lost.
// - Chunk search: no fallback at all, so passage recall was usually empty and
//   its fusion weight was spent on nothing.
//
// A floor of 0 returns ranked top-K; callers (FolderMatchingService,
// SearchService fusion and its minScore) own the thresholds.
const VECTOR_SEARCH_MIN_SIMILARITY = 0;
// Correction memories are the exception: their match score scales a routing
// boost/penalty, and they were only ever applied to near-duplicates of the
// corrected file (the inherited 0.8). Kept, but stated.
const FEEDBACK_MEMORY_MIN_SIMILARITY = 0.8;

function resolveBatchUpsertConcurrency() {
  const configured =
    process.env.STRATOSORT_ORAMA_BATCH_UPSERT_CONCURRENCY ??
    getConfig('VECTOR_DB.batchUpsertConcurrency', DEFAULT_BATCH_UPSERT_CONCURRENCY);
  const parsed = Number.parseInt(String(configured), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_BATCH_UPSERT_CONCURRENCY;
  }
  return Math.max(1, Math.min(parsed, MAX_BATCH_UPSERT_CONCURRENCY));
}

/**
 * Build Orama schema with dynamic vector dimension
 * @param {number} dimension - Embedding vector dimension
 * @returns {any} Schema definitions for all collections
 */
function buildSchemas(dimension) {
  return {
    files: {
      id: 'string',
      embedding: `vector[${dimension}]`,
      hasVector: 'boolean',
      filePath: 'string',
      fileName: 'string',
      fileType: 'string',
      analyzedAt: 'string',
      suggestedName: 'string',
      keywords: 'string[]',
      tags: 'string[]',
      isOrphaned: 'boolean',
      orphanedAt: 'string',
      extractionMethod: 'string',
      fileHash: 'string'
    },
    folders: {
      id: 'string',
      embedding: `vector[${dimension}]`,
      folderPath: 'string',
      folderName: 'string',
      description: 'string',
      patterns: 'string[]'
    },
    fileChunks: {
      id: 'string',
      embedding: `vector[${dimension}]`,
      fileId: 'string',
      chunkIndex: 'number',
      content: 'string',
      startOffset: 'number',
      endOffset: 'number'
    },
    feedback: {
      id: 'string',
      embedding: `vector[${dimension}]`,
      text: 'string',
      feedbackType: 'string',
      metadata: 'string'
    },
    learningPatterns: {
      id: 'string',
      embedding: `vector[${dimension}]`,
      document: 'string',
      lastUpdated: 'string',
      patternCount: 'number',
      feedbackCount: 'number',
      folderStatsCount: 'number'
    }
  };
}

/**
 * OramaVectorService - In-process vector database
 *
 * Features:
 * - Zero external dependencies (no server required)
 * - Automatic persistence to disk
 * - Hybrid BM25 + vector search
 * - Stable API for vector storage and search
 */
class OramaVectorService extends EventEmitter {
  constructor() {
    super();
    /** @type {Record<string, any>} */
    this._databases = {};
    this._initialized = false;
    /** @type {any} */
    this._dataPath = null;
    this._dimension = DEFAULT_EMBEDDING_DIMENSION;
    /** @type {any} */
    this._embeddingModel = null;
    /** @type {any} */
    this._schemas = null;

    // Persistence state
    this._persistTimer = null;
    this._persistPending = false;
    this._isPersisting = false;
    this._currentPersistPromise = null;
    this._lastPersist = 0;

    /** @type {Record<string, any>} */
    this._collectionDimensions = {
      files: null,
      folders: null,
      fileChunks: null,
      feedback: null,
      learningPatterns: null
    };

    // Initialization state
    this._initPromise = null;
    this._isInitializing = false;
    this._isShuttingDown = false;
    // Write gate set at the START of cleanup, before the final persist.
    // _isShuttingDown can't serve this purpose because it also gates
    // _doPersist — the final persist must still run while new writes are
    // rejected, otherwise a chatty consumer keeps the persist loop from
    // ever stabilizing and late writes are lost at quit.
    this._writesBlocked = false;

    // Always online (in-process)
    this.isOnline = true;

    // Query cache (shared LRU implementation)
    this._queryCache = new LRUCache({
      maxSize: 200,
      ttlMs: 120000,
      lruStrategy: 'access',
      name: 'OramaQueryCache'
    });

    // Embedding sidecar store – Orama's restore() loses vector data (v3.1.x bug),
    // so we cache embeddings separately, keyed by collection name → Map<docId, number[]>.
    /** @type {Record<string, any>} */
    this._embeddingStore = {};
    this._maxEmbeddingStoreSize = 10000;

    // Bounded concurrency for batch upsert paths to improve throughput without
    // overwhelming DB writes or event-loop latency.
    this._batchUpsertConcurrency = resolveBatchUpsertConcurrency();

    // Tracks whether primary vector retrieval is healthy. Fallback scoring is
    // allowed only when this health check remains degraded after repair.
    this._vectorHealth = {
      primaryHealthy: null,
      lastValidatedAt: 0,
      lastValidationReason: null,
      lastValidationError: null,
      lastRepairAt: 0,
      repairAttempts: 0
    };
    this._vectorHealthPromise = null;
    this._folderVectorHealth = {
      primaryHealthy: null,
      lastValidatedAt: 0,
      lastValidationReason: null,
      lastValidationError: null,
      lastRepairAt: 0,
      repairAttempts: 0
    };
    this._folderVectorHealthPromise = null;
  }

  async _runBoundedBatch(
    /** @type {any} */ items,
    /** @type {any} */ workerFn,
    concurrency = this._batchUpsertConcurrency
  ) {
    const safeConcurrency = Math.max(
      1,
      Math.min(Number.isFinite(concurrency) ? Math.floor(concurrency) : 1, items.length || 1)
    );
    const results = new Array(items.length);
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) break;
        try {
          const value = await workerFn(items[index], index);
          results[index] = { status: 'fulfilled', value };
        } catch (error) {
          results[index] = { status: 'rejected', reason: error };
        }
      }
    };

    const workers = Array.from({ length: safeConcurrency }, () => worker());
    await Promise.allSettled(workers);
    return results;
  }

  _emitSearchDataMutated(
    /** @type {any} */ collection,
    /** @type {any} */ operation,
    details = {}
  ) {
    this.emit('search-data-mutated', {
      collection,
      operation,
      reason: `${collection}:${operation}`,
      timestamp: Date.now(),
      ...details
    });
  }

  /**
   * Normalize persisted embedding payloads to plain numeric arrays.
   * Handles Array, TypedArray, and object-with-numeric-keys shapes.
   * @private
   */
  _normalizeEmbeddingVector(/** @type {any} */ value, /** @type {any} */ expectedDim = null) {
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
    if (Number.isFinite(expectedDim) && expectedDim > 0 && vector.length !== expectedDim)
      return null;

    const normalized = vector.map((n) => Number(n));
    if (normalized.some((n) => !Number.isFinite(n))) return null;
    return normalized;
  }

  _getVectorHealthSnapshot() {
    return { ...this._vectorHealth };
  }

  _setVectorHealth(/** @type {any} */ update) {
    const prevHealthy = this._vectorHealth.primaryHealthy;
    this._vectorHealth = {
      ...this._vectorHealth,
      ...update
    };
    this.emit('vector-health', this._getVectorHealthSnapshot());

    // Broadcast status to renderer on health transitions
    if ('primaryHealthy' in update && update.primaryHealthy !== prevHealthy) {
      if (update.primaryHealthy === true) {
        this._broadcastStatus('online', 'healthy');
      } else if (update.primaryHealthy === false) {
        this._broadcastStatus('error', 'degraded');
      }
    }
  }

  _getFolderVectorHealthSnapshot() {
    return { ...this._folderVectorHealth };
  }

  _setFolderVectorHealth(/** @type {any} */ update) {
    this._folderVectorHealth = {
      ...this._folderVectorHealth,
      ...update
    };
    this.emit('folder-vector-health', this._getFolderVectorHealthSnapshot());
  }

  /**
   * Broadcast vectordb:status-changed to all renderer windows.
   * Called on key health transitions so the UI can update without polling.
   * @param {'online'|'offline'|'error'|'recovering'} status
   * @param {string} [health] - Optional richer health descriptor
   * @private
   */
  _broadcastStatus(/** @type {any} */ status, /** @type {any} */ health) {
    try {
      const { BrowserWindow } = require('electron');
      const channel = IPC_CHANNELS.VECTOR_DB.STATUS_CHANGED;
      const { safeSend } = require('../ipc/ipcWrappers');
      /** @type {Record<string, any>} */
      const payload = { status, timestamp: Date.now() };
      if (health) payload.health = health;

      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (win && !win.isDestroyed() && win.webContents) {
          safeSend(win.webContents, channel, payload);
        }
      }
    } catch (error) {
      logger.debug('[OramaVectorService] Failed to broadcast status:', error?.message);
    }
  }

  /**
   * Iterate every hit that matches `searchParams` by paging Orama with an
   * offset cursor. Replaces hard `limit: 10000` scans that silently truncated
   * results for users with large libraries (bulk imports, PDFs that chunk
   * past 10k pieces). Always bound memory by using `pageSize` and bail out
   * on repeating page fingerprints to avoid infinite loops if the underlying
   * store produces non-deterministic ordering.
   *
   * @param {object} db - Orama database instance
   * @param {object} searchParams - Parameters passed to `search()`; `limit`
   *   and `offset` are always overridden by this helper.
   * @param {object} [options]
   * @param {number} [options.pageSize=1000] - Results per underlying page.
   * @param {number|null} [options.maxResults=null] - Optional soft cap on
   *   total yielded hits (null means exhaustive).
   * @param {string} [options.label='paginated-search'] - Log label for the
   *   infinite-loop guard.
   * @param {(hit: object) => Promise<boolean|void> | boolean | void} [options.onHit]
   *   - Optional per-hit callback. Returning `false` stops iteration early
   *     (useful for streaming delete without buffering every id).
   * @returns {Promise<Array<object>>} Collected hits (empty when onHit handles them).
   */
  async _paginatedSearch(
    /** @type {any} */ db,
    /** @type {any} */ searchParams,
    /** @type {any} */ options = {}
  ) {
    if (!db) return [];
    const pageSize =
      Number.isFinite(options.pageSize) && options.pageSize > 0 ? options.pageSize : 1000;
    const maxResults =
      Number.isFinite(options.maxResults) && options.maxResults > 0 ? options.maxResults : null;
    const label = typeof options.label === 'string' ? options.label : 'paginated-search';
    const onHit = typeof options.onHit === 'function' ? options.onHit : null;
    // mutating=true: caller deletes/updates docs from inside `onHit`. Each page
    // shifts the underlying offset cursor in Orama, so advancing `offset` by
    // `hits.length` would skip a window of survivors. Keep offset=0 and rely
    // on the deletes shrinking the result set until hits.length === 0.
    const mutating = options.mutating === true;

    /** @type {any[]|null} */
    const collected = onHit ? null : [];
    const seenFirstIds = new Set();
    let offset = 0;
    let yielded = 0;
    // Safety cap for mutating loops in case deletes silently fail and the
    // result set never shrinks — bound iteration to (maxResults || a generous
    // ceiling) iterations to avoid spinning forever.
    let iterations = 0;
    const maxIterations = mutating ? Math.max((maxResults || 100000) / pageSize, 1000) : Infinity;

    while (true) {
      iterations++;
      if (iterations > maxIterations) {
        logger.warn('[OramaVectorService] Mutating paged loop exceeded iteration cap; stopping', {
          label,
          pageSize,
          iterations
        });
        break;
      }
      const page = await searchPreservingStoredVectors(
        db,
        /** @type {any} */ ({
          ...searchParams,
          limit: pageSize,
          offset
        })
      );
      const hits = Array.isArray(page?.hits) ? page.hits : [];
      if (hits.length === 0) break;

      const firstId = hits[0]?.document?.id;
      if (!mutating && offset > 0 && firstId && seenFirstIds.has(firstId)) {
        logger.warn(
          '[OramaVectorService] Detected repeating paged search results; stopping to avoid infinite loop',
          { label, offset, pageSize, firstId }
        );
        break;
      }
      if (!mutating && firstId) seenFirstIds.add(firstId);

      let stopped = false;
      for (const hit of hits) {
        if (!hit) continue;
        if (onHit) {
          const cont = await onHit(hit);
          if (cont === false) {
            stopped = true;
            break;
          }
        } else if (collected) {
          collected.push(hit);
        }
        yielded++;
        if (maxResults !== null && yielded >= maxResults) {
          stopped = true;
          break;
        }
      }

      if (stopped) break;
      if (hits.length < pageSize) break;
      // For mutating loops, keep offset=0: each page should see the new
      // "first N matches" after the previous page's deletes shrunk the set.
      // For read-only loops, advance normally.
      if (!mutating) {
        offset += hits.length;
      }
    }

    return collected || [];
  }

  async _getAllFileDocuments() {
    if (!this._databases?.files) return [];

    // Prefer a persistence snapshot so repair/fallback logic is not capped by search limits.
    try {
      const snapshot = /** @type {any} */ (await persist(this._databases.files));
      const docsById = snapshot?.docs?.docs;
      if (docsById && typeof docsById === 'object') {
        return Object.values(docsById).filter((doc) => doc && typeof doc === 'object');
      }
    } catch (error) {
      logger.warn(
        '[OramaVectorService] Failed to snapshot files DB; falling back to paged search',
        {
          error: error?.message
        }
      );
    }

    const pageSize = 1000;
    const docs = [];
    const seenFirstIds = new Set();
    let offset = 0;

    while (true) {
      const page = await searchPreservingStoredVectors(this._databases.files, {
        term: '',
        limit: pageSize,
        offset
      });
      const hits = Array.isArray(page?.hits) ? page.hits : [];
      if (hits.length === 0) break;

      const firstId = hits[0]?.document?.id;
      if (offset > 0 && firstId && seenFirstIds.has(firstId)) {
        logger.warn(
          '[OramaVectorService] Detected repeating paged search results; stopping to avoid infinite loop',
          { offset, pageSize, firstId }
        );
        break;
      }
      if (firstId) seenFirstIds.add(firstId);

      for (const hit of hits) {
        if (hit?.document && typeof hit.document === 'object') {
          docs.push(hit.document);
        }
      }

      if (hits.length < pageSize) break;
      offset += hits.length;
    }

    return docs;
  }

  async _getAllFolderDocuments() {
    if (!this._databases?.folders) return [];

    try {
      const snapshot = /** @type {any} */ (await persist(this._databases.folders));
      const docsById = snapshot?.docs?.docs;
      if (docsById && typeof docsById === 'object') {
        return Object.values(docsById).filter((doc) => doc && typeof doc === 'object');
      }
    } catch (error) {
      logger.warn(
        '[OramaVectorService] Failed to snapshot folders DB; falling back to paged search',
        {
          error: error?.message
        }
      );
    }

    const pageSize = 1000;
    const docs = [];
    const seenFirstIds = new Set();
    let offset = 0;

    while (true) {
      const page = await searchPreservingStoredVectors(this._databases.folders, {
        term: '',
        limit: pageSize,
        offset
      });
      const hits = Array.isArray(page?.hits) ? page.hits : [];
      if (hits.length === 0) break;

      const firstId = hits[0]?.document?.id;
      if (offset > 0 && firstId && seenFirstIds.has(firstId)) {
        logger.warn(
          '[OramaVectorService] Detected repeating folder page results; stopping to avoid infinite loop',
          { offset, pageSize, firstId }
        );
        break;
      }
      if (firstId) seenFirstIds.add(firstId);

      for (const hit of hits) {
        if (hit?.document && typeof hit.document === 'object') {
          docs.push(hit.document);
        }
      }

      if (hits.length < pageSize) break;
      offset += hits.length;
    }

    return docs;
  }

  /**
   * Bulk export of file embeddings + light metadata for the latent-space Atlas.
   * Joins files-collection metadata with the authoritative sidecar vector store
   * (Orama restore drops vectors; the sidecar is the source of truth). Documents
   * without a usable vector are skipped. Raw vectors deliberately stay in the
   * main process — callers project them (UMAP) before anything crosses IPC.
   *
   * `category`/`smartFolder` are the file's semantic home (AI category and the
   * smart folder it was organized into). They are stored on the document via
   * `_buildMetaOverrides` even though they are not indexed schema fields; the
   * Atlas colours/labels points by them so the map reads as topics-and-folders
   * rather than raw source directories.
   * @returns {Promise<Array<{ id: string, embedding: number[], filePath: string, fileName: string, tags: string[], keywords: string[], suggestedName: string, category: string, smartFolder: string }>>}
   */
  async getAllFileEmbeddings() {
    const docs = await this._getAllFileDocuments();
    const embStore = this._embeddingStore?.files;
    /** @type {Array<{ id: string, embedding: number[], filePath: string, fileName: string, tags: string[], keywords: string[], suggestedName: string, category: string, smartFolder: string }>} */
    const out = [];
    for (const doc of docs) {
      if (!doc || typeof doc !== 'object' || !doc.id) continue;
      // Sidecar is authoritative. Without a sidecar vector, honor the doc's
      // hasVector flag: restore writes zero-vector placeholders with
      // hasVector=false, and projecting those piles every unrecovered doc
      // into one identical fake "cluster" at the origin of embedding space.
      const sidecar = embStore?.get(doc.id);
      const embedding = sidecar || (doc.hasVector === false ? null : doc.embedding);
      if (!Array.isArray(embedding) || embedding.length === 0) continue;
      out.push({
        id: doc.id,
        embedding,
        filePath: typeof doc.filePath === 'string' ? doc.filePath : '',
        fileName: typeof doc.fileName === 'string' ? doc.fileName : '',
        tags: Array.isArray(doc.tags) ? doc.tags : [],
        keywords: Array.isArray(doc.keywords) ? doc.keywords : [],
        suggestedName: typeof doc.suggestedName === 'string' ? doc.suggestedName : '',
        category: typeof doc.category === 'string' ? doc.category : '',
        smartFolder: typeof doc.smartFolder === 'string' ? doc.smartFolder : ''
      });
    }
    return out;
  }

  /**
   * Bulk export of folder embeddings + light metadata for the Atlas co-plot.
   * Folders share the files' embedding space, so plotting both lets a file that
   * sits far from its assigned folder read as a "probably mis-filed" signal.
   * @returns {Promise<Array<{ id: string, embedding: number[], folderPath: string, folderName: string }>>}
   */
  async getAllFolderEmbeddings() {
    const docs = await this._getAllFolderDocuments();
    const embStore = this._embeddingStore?.folders;
    /** @type {Array<{ id: string, embedding: number[], folderPath: string, folderName: string }>} */
    const out = [];
    for (const doc of docs) {
      if (!doc || typeof doc !== 'object' || !doc.id) continue;
      // Same hasVector guard as getAllFileEmbeddings: never project a
      // zero-vector restore placeholder.
      const sidecar = embStore?.get(doc.id);
      const embedding = sidecar || (doc.hasVector === false ? null : doc.embedding);
      if (!Array.isArray(embedding) || embedding.length === 0) continue;
      out.push({
        id: doc.id,
        embedding,
        folderPath: typeof doc.folderPath === 'string' ? doc.folderPath : '',
        folderName: typeof doc.folderName === 'string' ? doc.folderName : ''
      });
    }
    return out;
  }

  async _repairFilesVectorIndexFromCurrentState() {
    if (!this._databases?.files) return { repaired: false, reason: 'files-db-unavailable' };

    const sourceDocs = await this._getAllFileDocuments();

    const rebuilt = await create({
      schema: this._schemas.files,
      components: { tokenizer: ORAMA_TOKENIZER_CONFIG }
    });
    const rebuiltEmbeddings = new Map();
    let repairedDocs = 0;
    let placeholders = 0;

    for (const existing of sourceDocs) {
      const normalizedEmbedding = this._normalizeEmbeddingVector(
        this._embeddingStore?.files?.get(existing.id) || existing.embedding,
        this._dimension
      );
      const hasVector =
        Array.isArray(normalizedEmbedding) &&
        normalizedEmbedding.length === this._dimension &&
        !(normalizedEmbedding[0] === 0 && normalizedEmbedding.every((v) => v === 0));
      const embedding = hasVector
        ? normalizedEmbedding
        : Array.from({ length: this._dimension }, () => 0);

      await insert(rebuilt, {
        id: existing.id,
        embedding,
        hasVector,
        filePath: existing.filePath || '',
        fileName: existing.fileName || '',
        fileType: existing.fileType || '',
        analyzedAt: existing.analyzedAt || new Date().toISOString(),
        suggestedName: existing.suggestedName || '',
        keywords: Array.isArray(existing.keywords) ? existing.keywords : [],
        tags: Array.isArray(existing.tags) ? existing.tags : [],
        isOrphaned: Boolean(existing.isOrphaned),
        orphanedAt: existing.orphanedAt || '',
        extractionMethod: existing.extractionMethod || '',
        fileHash: existing.fileHash || ''
      });

      if (hasVector) {
        rebuiltEmbeddings.set(existing.id, embedding);
      } else {
        placeholders++;
      }
      repairedDocs++;
    }

    this._databases.files = rebuilt;
    this._embeddingStore.files = rebuiltEmbeddings;
    this._collectionDimensions.files = this._dimension;
    this._clearQueryCache();
    await this.persistAll();
    this._emitSearchDataMutated('files', 'repair', {
      repairedDocs,
      placeholders,
      embeddingsCached: rebuiltEmbeddings.size
    });

    return {
      repaired: true,
      repairedDocs,
      placeholders,
      embeddingsCached: rebuiltEmbeddings.size
    };
  }

  async _repairFoldersVectorIndexFromCurrentState() {
    if (!this._databases?.folders) return { repaired: false, reason: 'folders-db-unavailable' };

    const sourceDocs = await this._getAllFolderDocuments();
    const rebuilt = await create({
      schema: this._schemas.folders,
      components: { tokenizer: ORAMA_TOKENIZER_CONFIG }
    });
    const rebuiltEmbeddings = new Map();
    let repairedDocs = 0;
    let placeholders = 0;

    for (const existing of sourceDocs) {
      const normalizedEmbedding = this._normalizeEmbeddingVector(
        this._embeddingStore?.folders?.get(existing.id) || existing.embedding,
        this._dimension
      );
      const hasVector =
        Array.isArray(normalizedEmbedding) &&
        normalizedEmbedding.length === this._dimension &&
        !(normalizedEmbedding[0] === 0 && normalizedEmbedding.every((v) => v === 0));
      const embedding = hasVector
        ? normalizedEmbedding
        : Array.from({ length: this._dimension }, () => 0);

      try {
        await insert(rebuilt, {
          id: existing.id,
          embedding,
          folderPath: existing.folderPath || '',
          folderName: existing.folderName || '',
          description: existing.description || '',
          patterns: Array.isArray(existing.patterns) ? existing.patterns : []
        });

        if (hasVector) {
          rebuiltEmbeddings.set(existing.id, embedding);
        } else {
          placeholders++;
        }
        repairedDocs++;
      } catch (err) {
        logger.warn('[OramaVectorService] Failed to insert folder document during repair', {
          id: existing.id,
          error: err.message
        });
      }
    }

    this._databases.folders = rebuilt;
    this._embeddingStore.folders = rebuiltEmbeddings;
    this._collectionDimensions.folders = this._dimension;
    this._invalidateCacheForFolder();
    this._clearQueryCache();
    await this.persistAll();

    return {
      repaired: true,
      repairedDocs,
      placeholders,
      embeddingsCached: rebuiltEmbeddings.size
    };
  }

  async _ensurePrimaryVectorHealth({ reason = 'runtime', force = false, autoRepair = true } = {}) {
    const now = Date.now();
    if (
      !force &&
      this._vectorHealth.lastValidatedAt > 0 &&
      now - this._vectorHealth.lastValidatedAt < VECTOR_PRIMARY_VALIDATION_INTERVAL_MS
    ) {
      return this._getVectorHealthSnapshot();
    }

    if (this._vectorHealthPromise) {
      return this._vectorHealthPromise;
    }

    const HEALTH_CHECK_TIMEOUT_MS = 30000;

    // Build the inner work + timeout race FIRST, then assign once. The
    // previous order (assign inner promise, then wrap with race, then re-assign)
    // had a window where a concurrent caller hitting the early-return at line
    // 718 received the unwrapped inner promise. If Orama deadlocked on a large
    // index, that caller hung forever even after the first caller's timeout
    // fired.
    const innerPromise = (async () => {
      const embStore = this._embeddingStore?.files;
      if (!(embStore instanceof Map) || embStore.size === 0) {
        this._setVectorHealth({
          primaryHealthy: true,
          lastValidatedAt: Date.now(),
          lastValidationReason: `${reason}:no-vectors`,
          lastValidationError: null
        });
        return this._getVectorHealthSnapshot();
      }

      const probeEntry = Array.from(embStore.entries()).find(([_, vector]) => {
        const normalized = this._normalizeEmbeddingVector(vector, this._dimension);
        return (
          Array.isArray(normalized) &&
          normalized.length === this._dimension &&
          !(normalized[0] === 0 && normalized.every((v) => v === 0))
        );
      });

      if (!probeEntry) {
        this._setVectorHealth({
          primaryHealthy: true,
          lastValidatedAt: Date.now(),
          lastValidationReason: `${reason}:no-valid-probe`,
          lastValidationError: null
        });
        return this._getVectorHealthSnapshot();
      }

      const [probeId, probeVector] = probeEntry;
      const runProbe = async () => {
        const probeResults = await searchPreservingStoredVectors(this._databases.files, {
          mode: 'vector',
          vector: { value: probeVector, property: 'embedding' },
          limit: 5,
          where: { isOrphaned: false, hasVector: true }
        });
        return (probeResults.hits || []).some((hit) => hit?.document?.id === probeId);
      };

      try {
        let healthy = await runProbe();
        const healthyWithoutRepair = healthy;
        if (
          !healthy &&
          autoRepair &&
          this._vectorHealth.repairAttempts < VECTOR_PRIMARY_MAX_REPAIR_ATTEMPTS
        ) {
          this._setVectorHealth({
            repairAttempts: this._vectorHealth.repairAttempts + 1,
            lastRepairAt: Date.now()
          });

          logger.warn(
            '[OramaVectorService] Primary vector self-check failed; attempting files index repair',
            {
              reason,
              probeId
            }
          );

          const repair = await this._repairFilesVectorIndexFromCurrentState();
          logger.info('[OramaVectorService] Files vector index repair completed', {
            ...repair,
            reason
          });
          healthy = await runProbe();
        }

        this._setVectorHealth({
          primaryHealthy: healthy,
          lastValidatedAt: Date.now(),
          lastValidationReason: reason,
          lastValidationError: null,
          // Reset the repair budget once the index validates without needing a
          // repair, so VECTOR_PRIMARY_MAX_REPAIR_ATTEMPTS gates a consecutive
          // unhealthy streak rather than the whole process lifetime. Without
          // this, two early transient restore-drift events would permanently
          // disable auto-repair for the session.
          ...(healthyWithoutRepair ? { repairAttempts: 0 } : {})
        });

        return this._getVectorHealthSnapshot();
      } catch (error) {
        this._setVectorHealth({
          primaryHealthy: false,
          lastValidatedAt: Date.now(),
          lastValidationReason: reason,
          lastValidationError: error?.message || String(error)
        });
        logger.warn('[OramaVectorService] Primary vector self-check failed', {
          reason,
          error: error?.message
        });
        return this._getVectorHealthSnapshot();
      }
    })();

    const { promise: timeoutPromise, cleanup } = createTimeoutRace(
      HEALTH_CHECK_TIMEOUT_MS,
      'Vector health check timed out'
    );

    const racedPromise = Promise.race([innerPromise, timeoutPromise])
      .catch((error) => {
        logger.warn('[OramaVectorService] Health check timed out or failed', {
          reason,
          error: error?.message
        });
        this._setVectorHealth({
          primaryHealthy: false,
          lastValidatedAt: Date.now(),
          lastValidationReason: `${reason}:timeout`,
          lastValidationError: error?.message || 'Health check timed out'
        });
        return this._getVectorHealthSnapshot();
      })
      .finally(() => {
        cleanup();
        this._vectorHealthPromise = null;
      });

    this._vectorHealthPromise = racedPromise;
    return this._vectorHealthPromise;
  }

  async _ensurePrimaryFolderVectorHealth({
    reason = 'runtime',
    force = false,
    autoRepair = true
  } = {}) {
    const now = Date.now();
    if (
      !force &&
      this._folderVectorHealth.lastValidatedAt > 0 &&
      now - this._folderVectorHealth.lastValidatedAt < VECTOR_PRIMARY_VALIDATION_INTERVAL_MS
    ) {
      return this._getFolderVectorHealthSnapshot();
    }

    if (this._folderVectorHealthPromise) {
      return this._folderVectorHealthPromise;
    }

    const HEALTH_CHECK_TIMEOUT_MS = 30000;

    // See _ensurePrimaryVectorHealth: build inner + race FIRST, assign once,
    // so a concurrent caller hitting the early-return at line 865 never
    // receives the unwrapped inner promise without the timeout protection.
    const innerFolderPromise = (async () => {
      const embStore = this._embeddingStore?.folders;
      if (!(embStore instanceof Map) || embStore.size === 0) {
        this._setFolderVectorHealth({
          primaryHealthy: true,
          lastValidatedAt: Date.now(),
          lastValidationReason: `${reason}:no-vectors`,
          lastValidationError: null
        });
        return this._getFolderVectorHealthSnapshot();
      }

      const probeEntry = Array.from(embStore.entries()).find(([_, vector]) => {
        const normalized = this._normalizeEmbeddingVector(vector, this._dimension);
        return (
          Array.isArray(normalized) &&
          normalized.length === this._dimension &&
          !(normalized[0] === 0 && normalized.every((v) => v === 0))
        );
      });

      if (!probeEntry) {
        this._setFolderVectorHealth({
          primaryHealthy: true,
          lastValidatedAt: Date.now(),
          lastValidationReason: `${reason}:no-valid-probe`,
          lastValidationError: null
        });
        return this._getFolderVectorHealthSnapshot();
      }

      const [probeId, probeVector] = probeEntry;
      const runProbe = async () => {
        const probeResults = await searchPreservingStoredVectors(this._databases.folders, {
          mode: 'vector',
          vector: { value: probeVector, property: 'embedding' },
          limit: 5
        });
        return (probeResults.hits || []).some((hit) => hit?.document?.id === probeId);
      };

      try {
        let healthy = await runProbe();
        const healthyWithoutRepair = healthy;
        if (
          !healthy &&
          autoRepair &&
          this._folderVectorHealth.repairAttempts < VECTOR_PRIMARY_MAX_REPAIR_ATTEMPTS
        ) {
          this._setFolderVectorHealth({
            repairAttempts: this._folderVectorHealth.repairAttempts + 1,
            lastRepairAt: Date.now()
          });

          logger.warn(
            '[OramaVectorService] Folder vector self-check failed; attempting folders index repair',
            {
              reason,
              probeId
            }
          );

          const repair = await this._repairFoldersVectorIndexFromCurrentState();
          logger.info('[OramaVectorService] Folders vector index repair completed', {
            ...repair,
            reason
          });
          healthy = await runProbe();
        }

        this._setFolderVectorHealth({
          primaryHealthy: healthy,
          lastValidatedAt: Date.now(),
          lastValidationReason: reason,
          lastValidationError: null,
          // Reset the repair budget once the index validates without needing a
          // repair, so VECTOR_PRIMARY_MAX_REPAIR_ATTEMPTS gates a consecutive
          // unhealthy streak rather than the whole process lifetime. Without
          // this, two early transient restore-drift events would permanently
          // disable folder auto-repair, forcing every later query onto cosine
          // fallback (which inflates the embedding pipeline fallback rate).
          ...(healthyWithoutRepair ? { repairAttempts: 0 } : {})
        });
        return this._getFolderVectorHealthSnapshot();
      } catch (error) {
        this._setFolderVectorHealth({
          primaryHealthy: false,
          lastValidatedAt: Date.now(),
          lastValidationReason: reason,
          lastValidationError: error?.message || String(error)
        });
        logger.warn('[OramaVectorService] Folder vector self-check failed', {
          reason,
          error: error?.message
        });
        return this._getFolderVectorHealthSnapshot();
      }
    })();

    const { promise: timeoutPromise, cleanup } = createTimeoutRace(
      HEALTH_CHECK_TIMEOUT_MS,
      'Folder vector health check timed out'
    );

    const racedFolderPromise = Promise.race([innerFolderPromise, timeoutPromise])
      .catch((error) => {
        logger.warn('[OramaVectorService] Folder health check timed out or failed', {
          reason,
          error: error?.message
        });
        this._setFolderVectorHealth({
          primaryHealthy: false,
          lastValidatedAt: Date.now(),
          lastValidationReason: `${reason}:timeout`,
          lastValidationError: error?.message || 'Health check timed out'
        });
        return this._getFolderVectorHealthSnapshot();
      })
      .finally(() => {
        cleanup();
        this._folderVectorHealthPromise = null;
      });

    this._folderVectorHealthPromise = racedFolderPromise;
    return this._folderVectorHealthPromise;
  }

  /**
   * @param {number[]} a
   * @param {number[]} b
   * @param {number} eps
   * @returns {boolean}
   * @private
   */
  _vectorsNearlyEqual(a, b, eps = 1e-5) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i] - b[i]) > eps) {
        return false;
      }
    }
    return true;
  }

  /**
   * Spot-check random documents: compare sidecar embeddings to Orama getByID() (T-07).
   * @param {'files'|'folders'} name
   * @param {number} sampleSize
   * @private
   */
  async _spotCheckSidecarVsOrama(name, sampleSize = 8) {
    const db = this._databases[name];
    const embStore = this._embeddingStore?.[name];
    if (!db || !embStore || embStore.size === 0) {
      return;
    }
    const ids = [...embStore.keys()];
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const n = Math.min(sampleSize, ids.length);
    let mismatches = 0;
    for (let i = 0; i < n; i++) {
      const id = ids[i];
      const side = embStore.get(id);
      if (!Array.isArray(side) || side.length === 0) {
        continue;
      }
      let doc;
      try {
        doc = await getByID(db, id);
      } catch {
        continue;
      }
      const ora = doc?.embedding;
      if (!Array.isArray(ora) || ora.length !== side.length) {
        mismatches++;
        continue;
      }
      const oraAllZero = ora.every((v) => v === 0);
      const sideHasNonZero = side.some((v) => v !== 0);
      if (oraAllZero && sideHasNonZero) {
        mismatches++;
        continue;
      }
      if (!this._vectorsNearlyEqual(ora, side)) {
        mismatches++;
      }
    }
    if (mismatches > 0) {
      logger.warn(
        `[OramaVectorService] ${name}: sidecar vs getByID spot-check found ${mismatches}/${n} mismatches (possible Orama vector restore drift; see docs/ORAMA_VECTOR_SIDECAR.md)`
      );
    }
  }

  /**
   * Resolve the on-disk vector DB directory from the `vectorDbPersistPath`
   * setting. The value is a folder name resolved under userData; one that
   * escapes userData, or an absolute or network path, falls back to the
   * default so the index never leaves the app data directory (SECURITY.md).
   * Read once at initialize();
   * changing the path takes effect on the next launch (relocating a live DB is
   * out of scope and would risk data loss).
   *
   * @returns {Promise<string>} Absolute directory path for vector persistence.
   */
  async _resolveVectorDataPath() {
    const userData = app.getPath('userData');
    const fallback = path.join(userData, 'vector-db');
    let configured = 'vector-db';
    try {
      const SettingsService = require('./SettingsService');
      const svc = SettingsService.getInstance?.();
      if (svc?.load) {
        const settings = await svc.load();
        const raw = settings?.vectorDbPersistPath;
        if (typeof raw === 'string' && raw.trim()) {
          configured = raw.trim();
        }
      }
    } catch (err) {
      logger.debug('[OramaVectorService] Could not read vectorDbPersistPath; using default', {
        error: err?.message
      });
      return fallback;
    }

    try {
      if (
        path.isAbsolute(configured) ||
        path.win32.isAbsolute(configured) ||
        configured.startsWith('\\\\') ||
        configured.startsWith('//')
      ) {
        logger.warn(
          '[OramaVectorService] vectorDbPersistPath is absolute; using the default under userData',
          { configured }
        );
        return fallback;
      }
      const resolved = path.resolve(userData, configured);
      const rel = path.relative(userData, resolved);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        logger.warn(
          '[OramaVectorService] vectorDbPersistPath resolves outside userData; using default',
          { configured }
        );
        return fallback;
      }
      return resolved;
    } catch (err) {
      logger.warn('[OramaVectorService] Failed to resolve vectorDbPersistPath; using default', {
        error: err?.message,
        configured
      });
      return fallback;
    }
  }

  /**
   * Initialize the vector service
   */
  async initialize() {
    if (this._initPromise) {
      return this._initPromise;
    }

    if (this._initialized) {
      return Promise.resolve();
    }

    this._isInitializing = true;

    this._initPromise = (async () => {
      try {
        logger.info('[OramaVectorService] Initializing...');

        // A re-initialize after shutdown() must clear the write gates, or
        // every mutator would silently no-op for the rest of the process
        // lifetime (test restarts, service container resets).
        this._isShuttingDown = false;
        this._writesBlocked = false;

        this._dataPath = await this._resolveVectorDataPath();
        await fs.mkdir(this._dataPath, { recursive: true });

        await this._refreshEmbeddingDimension({ reason: 'initialize' });

        // Initialize dimension cache
        const collectionNames = ['files', 'folders', 'fileChunks', 'feedback', 'learningPatterns'];
        for (const name of collectionNames) {
          this._collectionDimensions[name] = this._dimension;
          this._databases[name] = await this._createOrRestoreDatabase(name, this._schemas[name]);
        }

        await this._spotCheckSidecarVsOrama('files', 8);
        await this._spotCheckSidecarVsOrama('folders', 8);

        this._initialized = true;
        this.isOnline = true;
        this.emit('online', { reason: 'initialized' });
        this._broadcastStatus('online', 'healthy');

        /** @type {Record<string, any>} */
        const counts = {};
        for (const name of collectionNames) {
          counts[name] = await count(this._databases[name]);
        }

        logger.info('[OramaVectorService] Initialized', {
          collections: collectionNames,
          dimension: this._dimension,
          embeddingModel: this._embeddingModel || AI_DEFAULTS.EMBEDDING?.MODEL || 'unknown',
          counts
        });

        await this._ensurePrimaryVectorHealth({
          reason: 'initialize',
          force: true,
          autoRepair: true
        });
        await this._ensurePrimaryFolderVectorHealth({
          reason: 'initialize',
          force: true,
          autoRepair: true
        });

        // NOTE: A previous unconditional "eager folder vector rebuild on init"
        // lived here. It existed because real folder queries returned empty on
        // the first request, which was mis-attributed to an Orama HNSW
        // partial-build / persist-restore vector-loss bug. The true cause was
        // Orama's default vector-search similarity cutoff (0.8) silently
        // dropping every document->folder match (see
        // VECTOR_SEARCH_MIN_SIMILARITY). With an explicit similarity
        // floor the restored index queries correctly, so the eager rebuild was
        // pure startup cost. Genuine corruption is still caught by the
        // _ensurePrimaryFolderVectorHealth self-probe + auto-repair above.

        this._isInitializing = false;
      } catch (error) {
        this._isInitializing = false;
        logger.error('[OramaVectorService] Initialization failed:', error);
        if (!error?.code) {
          error.code = ERROR_CODES.VECTOR_DB_INIT_FAILED;
        }
        throw error;
      } finally {
        // Clear _initPromise on BOTH success and failure. The previous
        // design only cleared on failure, leaving a resolved promise pinned
        // forever. Combined with `if (this._initPromise) return …` at the
        // top of initialize(), any future code path that resets only
        // `_initialized` (without also clearing `_initPromise`) would have
        // gotten the stale resolved promise back instead of a fresh init.
        // Belt-and-suspenders: shutdown() clears both, but defensive
        // cleanup here makes the contract robust.
        this._initPromise = null;
      }
    })();

    return this._initPromise;
  }

  async _resolveEmbeddingConfig(/** @type {any} */ modelOverride) {
    let modelName = modelOverride;
    if (!modelName) {
      try {
        const llamaService = getLlamaService();
        if (llamaService && typeof llamaService.getConfig === 'function') {
          const cfg = await llamaService.getConfig();
          modelName = cfg?.embeddingModel || null;
        }
      } catch (error) {
        logger.debug(
          '[OramaVectorService] Failed to read LlamaService config for dimension resolve',
          {
            error: error.message
          }
        );
      }
    }
    if (!modelName) {
      try {
        await loadLlamaConfig();
      } catch (error) {
        logger.debug('[OramaVectorService] Failed to load Llama config for dimension resolve', {
          error: error.message
        });
      }
      modelName = getEmbeddingModel();
    }

    if (!modelName) {
      modelName = AI_DEFAULTS.EMBEDDING?.MODEL || null;
    }

    const defaultDimension = getConfig('ANALYSIS.embeddingDimension', DEFAULT_EMBEDDING_DIMENSION);
    const dimension = resolveEmbeddingDimension(modelName, { defaultDimension });

    return { modelName, dimension };
  }

  async _refreshEmbeddingDimension(/** @type {any} */ { reason, modelName } = {}) {
    const { modelName: resolvedModel, dimension } = await this._resolveEmbeddingConfig(modelName);
    const previousDimension = this._dimension;
    const previousModel = this._embeddingModel;

    const dimensionChanged =
      Number.isInteger(dimension) && dimension > 0 && dimension !== this._dimension;
    const modelChanged = resolvedModel && resolvedModel !== this._embeddingModel;

    if (dimensionChanged) {
      this._dimension = dimension;
      this._schemas = buildSchemas(this._dimension);
    } else if (!this._schemas) {
      this._schemas = buildSchemas(this._dimension);
    }

    if (modelChanged) {
      this._embeddingModel = resolvedModel;
    } else if (!this._embeddingModel && resolvedModel) {
      this._embeddingModel = resolvedModel;
    }

    if ((dimensionChanged || modelChanged) && reason) {
      logger.info('[OramaVectorService] Embedding config resolved', {
        reason,
        model: resolvedModel,
        dimension,
        previousDimension,
        previousModel
      });
    }

    return {
      modelName: resolvedModel,
      dimension: this._dimension,
      previousDimension,
      previousModel,
      dimensionChanged,
      modelChanged
    };
  }

  /**
   * Reconcile the vector store with a change of embedding model. If the new
   * model's dimension or identity differs, every collection is reset —
   * destructive by design, since stored vectors are incomparable across
   * models — and a degraded-state flag with a one-click rebuild action is
   * raised so the user knows semantic search is empty until re-embedding.
   * Persists index metadata and emits 'embedding-model-change' either way.
   *
   * @param {any} [params]
   * @returns {Promise<any>}
   */
  async handleEmbeddingModelChange({ previousModel, newModel, source } = {}) {
    const resolved = await this._refreshEmbeddingDimension({
      reason: 'model-change',
      modelName: newModel
    });

    const needsReset = resolved.dimensionChanged || resolved.modelChanged;
    if (needsReset) {
      logger.warn('[OramaVectorService] Embedding model changed, resetting collections', {
        previousModel,
        newModel: resolved.modelName || newModel,
        previousDimension: resolved.previousDimension,
        newDimension: this._dimension,
        dimensionChanged: resolved.dimensionChanged,
        modelChanged: resolved.modelChanged
      });
      await this.resetAll();

      // The vector index is now empty while analysis history still has
      // entries — semantic search silently returns nothing until a rebuild
      // re-embeds them with the new model. Raise a persistent flag with a
      // one-click rebuild action; the FULL_REBUILD IPC handler clears it on
      // success.
      try {
        const tracker = require('./DegradedStateTracker').getInstance();
        tracker.raise({
          code: 'embeddings.model-change-reset',
          subsystem: 'vector-db',
          severity: 'warning',
          message:
            'The embedding model changed, so the search index was cleared. Semantic search will return no results until embeddings are rebuilt.',
          detail: {
            previousModel,
            newModel: resolved.modelName || newModel,
            action: {
              code: 'embeddings.full-rebuild',
              label: 'Rebuild embeddings',
              confirm:
                'Rebuild all embeddings now? This re-indexes your analyzed files with the new model and may take a while.'
            }
          }
        });
      } catch (trackerErr) {
        logger.debug('[OramaVectorService] Failed to raise model-change flag', {
          error: trackerErr?.message
        });
      }
    }

    try {
      // Merge-update (NOT full overwrite): a full write here could erase the
      // rebuildInProgress crash marker when this handler runs concurrently
      // with a FULL_REBUILD that changed the model, making a torn index look
      // healthy after a crash.
      await updateEmbeddingIndexMetadata({
        model: resolved.modelName || newModel || previousModel || 'unknown',
        dims: this._dimension,
        source: source || 'model-change'
      });
    } catch (error) {
      logger.debug('[OramaVectorService] Failed to update embedding metadata', {
        error: error.message
      });
    }

    this.emit('embedding-model-change', {
      previousModel,
      newModel: resolved.modelName || newModel,
      previousDimension: resolved.previousDimension,
      newDimension: this._dimension
    });

    return {
      previousModel,
      newModel: resolved.modelName || newModel,
      previousDimension: resolved.previousDimension,
      newDimension: this._dimension,
      dimensionChanged: resolved.dimensionChanged,
      modelChanged: resolved.modelChanged,
      collectionsReset: needsReset
    };
  }

  /**
   * Create or restore a database from persistence.
   *
   * IMPORTANT: Orama v3.1.x `restore()` has a bug where vector data is lost
   * after a persist/restore cycle (getByID returns null embeddings, vector
   * search returns 0 hits). We work around this by parsing the persisted JSON
   * ourselves, creating a fresh DB, and inserting documents one-by-one. This
   * ensures both text indexes and vector indexes are built correctly.
   *
   * @private
   */
  async _createOrRestoreDatabase(/** @type {any} */ name, /** @type {any} */ schema) {
    const persistPath = path.join(this._dataPath, `${name}.json`);
    const compressedPath = `${persistPath}.lz4`;

    try {
      // Try to read persisted data. The chain is:
      //   1. compressed primary  (.json.lz4)
      //   2. uncompressed primary (.json)        — legacy / non-compressed installs
      //   3. .bak of whichever primary just failed — rolling backup written by _doPersist
      //
      // Without the .bak fallback the rolling backup written on each persist was
      // unreachable: a crash that corrupted the primary write left no path to
      // recover and forced a quarantine + reindex.
      let data;
      let usedCompressed = false;
      let dataSource = null; // tracks where `data` came from for accurate quarantine
      try {
        const compressed = await fs.readFile(compressedPath);
        data = (await uncompress(compressed)).toString('utf8');
        usedCompressed = true;
        dataSource = compressedPath;
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          // LZ4 file exists but is corrupt — back it up so it can be inspected,
          // then fall through to the uncompressed JSON fallback.
          logger.error('[OramaVectorService] Compressed persistence corrupt, backing up', {
            name,
            error: error.message
          });
          try {
            const backupPath = `${compressedPath}.corrupt.${Date.now()}`;
            await fs.rename(compressedPath, backupPath);
            logger.info(`[OramaVectorService] Corrupt file backed up to ${backupPath}`);
          } catch (backupErr) {
            logger.warn('[OramaVectorService] Failed to back up corrupt file', {
              error: backupErr.message
            });
          }
        }
      }
      if (!data) {
        try {
          data = await fs.readFile(persistPath, 'utf-8');
          dataSource = persistPath;
        } catch (jsonError) {
          if (jsonError?.code !== 'ENOENT') {
            logger.warn('[OramaVectorService] Uncompressed primary read failed', {
              name,
              error: jsonError.message
            });
          }
        }
      }
      // .bak fallback: try the rolling backup of whichever primary path the
      // current install would use. Only consulted when both primaries above
      // failed — otherwise we'd risk reading stale data over the live primary.
      if (!data) {
        const activePath = PERSIST_COMPRESSION_ENABLED ? compressedPath : persistPath;
        const bakPath = `${activePath}.bak`;
        try {
          if (PERSIST_COMPRESSION_ENABLED) {
            const compressed = await fs.readFile(bakPath);
            data = (await uncompress(compressed)).toString('utf8');
            usedCompressed = true;
          } else {
            data = await fs.readFile(bakPath, 'utf-8');
          }
          dataSource = bakPath;
          logger.warn(
            `[OramaVectorService] Restored ${name} from .bak rolling backup; primary was unreadable`
          );
        } catch (bakError) {
          if (bakError?.code !== 'ENOENT') {
            logger.debug(`[OramaVectorService] .bak fallback failed for ${name}`, {
              error: bakError.message
            });
          }
        }
      }

      // No data found anywhere (compressed, uncompressed, .bak all missing).
      // This is the expected state on a fresh install — return a clean DB
      // without logging error noise.
      if (!data) {
        return await create({ schema, components: { tokenizer: ORAMA_TOKENIZER_CONFIG } });
      }

      // Parse the persisted JSON to extract raw documents.
      // Route through safeJsonOps so any `__proto__` / `constructor` keys
      // injected by on-disk tampering or a bug in an upstream writer are
      // stripped rather than fed back into runtime prototypes.
      let parsed;
      const persistParse = safeJsonTryParse(data);
      if (persistParse.success) {
        parsed = persistParse.value;
      }
      if (!persistParse.success) {
        const parseError = persistParse.error || new Error('Unknown persistence parse failure');
        logger.error(`[OramaVectorService] Failed to parse ${name} persistence`, {
          error: parseError.message,
          dataSource
        });
        // Quarantine the file we ACTUALLY read from. Previously this always
        // renamed `persistPath` (.json) — but if we read from `compressedPath`
        // (.json.lz4) or the .bak fallback, the .json may not exist at all,
        // and the real corrupt source was left untouched. On the next startup
        // the same corrupt file would re-fail in the same way, looping the
        // quarantine + degraded-flag emission forever.
        const quarantineSource = dataSource || persistPath;
        const quarantinePath = `${quarantineSource}.corrupt.${Date.now()}`;
        try {
          await fs.rename(quarantineSource, quarantinePath);
          logger.info(`[OramaVectorService] Quarantined corrupt persistence to ${quarantinePath}`);
        } catch (quarantineErr) {
          logger.warn('[OramaVectorService] Failed to quarantine corrupt persistence', {
            source: quarantineSource,
            error: quarantineErr.message
          });
        }
        const tracker = getDegradedStateTrackerSafe();
        if (tracker) {
          tracker.raise({
            code: `orama.corrupt-persistence:${name}`,
            subsystem: 'vector-db',
            severity: 'error',
            message: `Vector DB persistence "${name}" was unreadable and has been quarantined. Search results will be incomplete until you reindex.`,
            detail: {
              collection: name,
              quarantinePath,
              parseError: parseError.message,
              usedCompressed
            }
          });
        }
        return await create({ schema, components: { tokenizer: ORAMA_TOKENIZER_CONFIG } });
      }

      const rawDocs = parsed?.docs?.docs;
      if (!rawDocs || typeof rawDocs !== 'object') {
        logger.debug(`[OramaVectorService] No documents in ${name} persistence, creating fresh DB`);
        return await create({ schema, components: { tokenizer: ORAMA_TOKENIZER_CONFIG } });
      }

      const docList = Object.values(rawDocs).filter((d) => d && d.id);

      // Detect embedding dimension from the first doc that has a vector
      let restoredDim = null;
      for (const doc of docList) {
        if (doc.embedding && doc.embedding.length > 0) {
          restoredDim = doc.embedding.length;
          break;
        }
      }

      // Check for dimension mismatch. Previous behaviour silently unlink()'d the
      // persisted vectors, so a user who changed embedding model would see their
      // search index empty with no recourse. We now move the files aside first
      // (keeps a backup for re-import / debugging) and raise a degraded flag so
      // the renderer can prompt for a rebuild.
      if (restoredDim && restoredDim !== this._dimension) {
        logger.error(
          `[OramaVectorService] Dimension changed (${restoredDim} → ${this._dimension}) for ${name}. Archiving old store.`
        );
        this._clearQueryCache();
        this._collectionDimensions[name] = null;
        const archiveStamp = Date.now();
        let archivedJsonPath = null;
        let archivedCompressedPath = null;
        try {
          archivedJsonPath = `${persistPath}.dim${restoredDim}.${archiveStamp}.bak`;
          await fs.rename(persistPath, archivedJsonPath).catch(() => {
            archivedJsonPath = null;
          });
        } catch (archiveError) {
          logger.debug(
            `[OramaVectorService] Could not archive ${name} persistence: ${archiveError.message}`
          );
        }
        try {
          archivedCompressedPath = `${compressedPath}.dim${restoredDim}.${archiveStamp}.bak`;
          await fs.rename(compressedPath, archivedCompressedPath).catch(() => {
            archivedCompressedPath = null;
          });
        } catch (archiveError) {
          logger.debug(
            `[OramaVectorService] Could not archive ${name} compressed persistence: ${archiveError.message}`
          );
        }
        // The rolling .bak holds the same old-dimension documents. Left in
        // place, the next launch found no primary, restored from it and hit
        // this branch again, raising the flag on every start until a persist
        // wrote a new primary. Set it aside under the same stamp.
        for (const bakPath of [`${persistPath}.bak`, `${compressedPath}.bak`]) {
          await fs
            .rename(bakPath, `${bakPath}.dim${restoredDim}.${archiveStamp}.bak`)
            .catch((/** @type {any} */ bakError) => {
              if (bakError?.code !== 'ENOENT') {
                logger.debug(`[OramaVectorService] Could not archive ${name} rolling backup`, {
                  error: bakError?.message
                });
              }
            });
        }
        const tracker = getDegradedStateTrackerSafe();
        if (tracker) {
          tracker.raise({
            code: `orama.dimension-changed:${name}`,
            subsystem: 'vector-db',
            severity: 'error',
            message: `Embedding model dimension changed (${restoredDim} → ${this._dimension}) for "${name}". Previous vectors were archived; re-analyse your files to rebuild the index.`,
            detail: {
              collection: name,
              oldDimension: restoredDim,
              newDimension: this._dimension,
              archivedJsonPath,
              archivedCompressedPath
            }
          });
        }
        return await create({ schema, components: { tokenizer: ORAMA_TOKENIZER_CONFIG } });
      }

      if (restoredDim) {
        this._collectionDimensions[name] = restoredDim;
      }

      // Create a fresh DB and insert all documents (bypasses broken restore()).
      // Hydration is O(n) where n can be tens of thousands of docs. Doing this
      // in a tight loop blocks the Node event loop for seconds and starves IPC,
      // making the UI feel frozen on launch. We chunk the inserts and yield the
      // event loop between chunks so status pings, user input, and background
      // workers can make progress. Progress is broadcast so the renderer can
      // render an "indexing" state instead of an empty search UI.
      const db = await create({ schema, components: { tokenizer: ORAMA_TOKENIZER_CONFIG } });
      /** @type {Map<any, any>} */
      const embeddingStore = new Map();
      let insertedCount = 0;
      let failedCount = 0;
      let placeholderEmbeddingCount = 0;
      let restoredMissingFromSidecarCount = 0;

      const totalDocs = docList.length;
      const HYDRATION_YIELD_EVERY = 256;
      const HYDRATION_PROGRESS_EVERY = 1024;
      let processedSinceYield = 0;
      let processedSinceProgress = 0;
      if (totalDocs > 0) {
        this._broadcastStatus('hydrating', 'indexing');
        try {
          this.emit('hydration-progress', {
            collection: name,
            total: totalDocs,
            processed: 0
          });
        } catch {
          // emit is best-effort
        }
      }

      let sidecarData = null;
      try {
        const sidecarPath = path.join(this._dataPath, `${name}.sidecar.json`);
        const sidecarRaw = await fs.readFile(sidecarPath, 'utf-8');
        // Sidecar is persisted, user-writable state: strip prototype-pollution
        // keys during parse.
        const parsedSidecar = safeJsonTryParse(sidecarRaw).value;
        if (parsedSidecar && typeof parsedSidecar === 'object') {
          /** @type {Record<string, any>} */
          const normalizedSidecar = {};
          for (const [docId, emb] of Object.entries(parsedSidecar)) {
            const normalized = this._normalizeEmbeddingVector(emb, this._dimension);
            if (normalized) {
              normalizedSidecar[docId] = normalized;
            }
          }
          sidecarData = normalizedSidecar;
        }
      } catch {
        // No sidecar file or parse error -- not critical
      }

      for (const doc of docList) {
        try {
          let hasVector = true;
          // Missing embeddings are recovered from sidecar when possible.
          // If unavailable, use a zero-vector placeholder so BM25 recall is preserved.
          if (!doc.embedding || !doc.embedding.length) {
            const sidecarEmbedding = sidecarData?.[doc.id];
            if (Array.isArray(sidecarEmbedding) && sidecarEmbedding.length === this._dimension) {
              doc.embedding = sidecarEmbedding;
              restoredMissingFromSidecarCount++;
            } else {
              doc.embedding = new Array(this._dimension).fill(0);
              hasVector = false;
              placeholderEmbeddingCount++;
              logger.warn(
                `[OramaVectorService] Using zero-vector placeholder for ${name} doc missing embedding during restore`,
                {
                  id: doc.id
                }
              );
            }
          } else if (!Array.isArray(doc.embedding)) {
            // Ensure embedding is a plain Array (not TypedArray/object shape) for Orama insert
            const normalizedEmbedding = this._normalizeEmbeddingVector(
              doc.embedding,
              this._dimension
            );
            if (normalizedEmbedding) {
              doc.embedding = normalizedEmbedding;
            } else {
              doc.embedding = new Array(this._dimension).fill(0);
              hasVector = false;
            }
          }

          const isZeroPlaceholderEmbedding =
            doc.embedding[0] === 0 &&
            doc.embedding.every((/** @type {any} */ value) => value === 0);
          if (isZeroPlaceholderEmbedding) {
            hasVector = false;
          }

          if (name === 'files') {
            doc.hasVector = hasVector;
          }

          await insert(db, doc);

          // Do not cache zero placeholders so sidecar repair can detect and replace them.
          if (!isZeroPlaceholderEmbedding) {
            embeddingStore.set(doc.id, doc.embedding);
          }
          insertedCount++;
        } catch (insertError) {
          failedCount++;
          logger.debug(`[OramaVectorService] Failed to restore doc in ${name}`, {
            id: doc.id,
            error: insertError.message
          });
        }

        processedSinceYield++;
        processedSinceProgress++;
        if (processedSinceYield >= HYDRATION_YIELD_EVERY) {
          processedSinceYield = 0;
          // Yield the event loop so IPC handlers, timers, and workers can run
          // while we hydrate. setImmediate is cheap and bounded.
          await new Promise((resolve) => setImmediate(resolve));
        }
        if (processedSinceProgress >= HYDRATION_PROGRESS_EVERY) {
          processedSinceProgress = 0;
          try {
            this.emit('hydration-progress', {
              collection: name,
              total: totalDocs,
              processed: insertedCount + failedCount
            });
          } catch {
            // emit is best-effort
          }
        }
      }

      if (totalDocs > 0) {
        try {
          this.emit('hydration-progress', {
            collection: name,
            total: totalDocs,
            processed: totalDocs,
            complete: true
          });
        } catch {
          // emit is best-effort
        }
      }

      this._embeddingStore[name] = embeddingStore;

      // Attempt to repair zero-placeholder embeddings from persisted sidecar file.
      // The sidecar contains real embeddings saved during prior sessions.
      const lostEmbeddings = insertedCount - embeddingStore.size;
      if (lostEmbeddings > 0) {
        let repaired = 0;
        if (sidecarData && typeof sidecarData === 'object') {
          for (const [docId, emb] of Object.entries(sidecarData)) {
            if (!embeddingStore.has(docId) && Array.isArray(emb) && emb.length > 0) {
              try {
                const updateDoc =
                  name === 'files' ? { embedding: emb, hasVector: true } : { embedding: emb };
                await update(db, docId, updateDoc);
                embeddingStore.set(docId, emb);
                repaired++;
              } catch {
                // doc may not exist in this restore -- skip
              }
            }
          }
          if (repaired > 0) {
            logger.info(
              `[OramaVectorService] ${name}: repaired ${repaired} embeddings from sidecar`
            );
          }
        }

        const stillLost = lostEmbeddings - repaired;
        if (stillLost > 0) {
          logger.warn(
            `[OramaVectorService] ${name}: ${stillLost} document(s) still have zero-placeholder embeddings (Orama v3.1.x vector-loss). Re-embed to restore vector search.`
          );
        }
      }
      if (placeholderEmbeddingCount > 0) {
        logger.warn(
          `[OramaVectorService] ${name}: used placeholder embeddings for ${placeholderEmbeddingCount} document(s) during restore. Re-embed to restore vector search quality.`
        );
      }

      logger.info(`[OramaVectorService] Restored ${name} database`, {
        method: 'insert',
        total: docList.length,
        inserted: insertedCount,
        failed: failedCount,
        placeholderEmbeddings: placeholderEmbeddingCount,
        restoredMissingFromSidecar: restoredMissingFromSidecarCount,
        embeddingsCached: embeddingStore.size
      });

      // Recovery path: the prior session may have raised
      // `orama.corrupt-persistence:${name}` or `orama.dimension-changed:${name}`.
      // If we're now restoring cleanly (no severe loss, dimensions match), the
      // subsystem has recovered and the degraded banner must go away — otherwise
      // it sticks forever once raised, leading users to believe search is still
      // broken after a successful reindex. `clear()` is a no-op if the flag
      // isn't present, so it's safe to call unconditionally on the happy path.
      const _restoreIsHealthy =
        insertedCount > 0 &&
        !(
          failedCount > 50 ||
          (insertedCount + failedCount > 0 && failedCount / (insertedCount + failedCount) > 0.1)
        );
      if (_restoreIsHealthy) {
        const tracker = getDegradedStateTrackerSafe();
        if (tracker) {
          tracker.clear(`orama.corrupt-persistence:${name}`);
          tracker.clear(`orama.dimension-changed:${name}`);
        }
        if (this._hydrationDegraded && this._hydrationDegraded[name]) {
          delete this._hydrationDegraded[name];
        }
      }

      // Surface a degraded-index signal so higher layers (health reporter,
      // UI banner, next bootstrap) can prompt a rebuild. Previously the
      // failed-doc counter was only logged, and partial restores kept
      // silently returning a half-populated DB that misranked searches
      // forever. Thresholds are conservative: a single failure in a large
      // index is expected after a crash; more than 10% or >50 docs lost
      // warrants a rebuild.
      if (failedCount > 0) {
        const totalAttempted = insertedCount + failedCount;
        const failureRatio = totalAttempted > 0 ? failedCount / totalAttempted : 0;
        const severeLoss = failedCount > 50 || failureRatio > 0.1;
        if (severeLoss) {
          this._hydrationDegraded = this._hydrationDegraded || {};
          this._hydrationDegraded[name] = {
            failedCount,
            totalAttempted,
            failureRatio,
            requiresRebuild: true,
            detectedAt: Date.now()
          };
          logger.warn(
            `[OramaVectorService] ${name}: hydration lost ${failedCount}/${totalAttempted} docs (${(failureRatio * 100).toFixed(1)}%) — rebuild recommended`
          );
          try {
            this.emit('hydration-degraded', {
              collection: name,
              failedCount,
              totalAttempted,
              failureRatio,
              requiresRebuild: true
            });
          } catch {
            // emit is best-effort; never fail hydration because a listener threw
          }
        }
      }

      // Handle compression format migration
      if (!PERSIST_COMPRESSION_ENABLED && usedCompressed) {
        try {
          const json = await persist(/** @type {any} */ (db), 'json');
          await writeFileAtomic(persistPath, /** @type {any} */ (json));
          await fs.rename(compressedPath, `${compressedPath}.legacy.${Date.now()}`);
          logger.info(`[OramaVectorService] Migrated ${name} persistence to JSON`);
        } catch (migrateError) {
          logger.debug('[OramaVectorService] Failed to migrate persistence to JSON', {
            error: migrateError.message
          });
        }
      }

      if (PERSIST_COMPRESSION_ENABLED && !usedCompressed) {
        try {
          const compressed = /** @type {any} */ (
            await compress(/** @type {any} */ (Buffer.from(data, 'utf8')))
          );
          await writeFileAtomic(compressedPath, compressed);
          await fs.rename(persistPath, `${persistPath}.legacy.${Date.now()}`);
          logger.info(`[OramaVectorService] Migrated ${name} persistence to LZ4`);
        } catch (migrateError) {
          logger.debug('[OramaVectorService] Failed to migrate persistence to LZ4', {
            error: migrateError.message
          });
        }
      }

      return db;
    } catch (error) {
      // Create new database
      logger.debug(`[OramaVectorService] Creating new ${name} database (${error.message})`);
      const db = await create({ schema, components: { tokenizer: ORAMA_TOKENIZER_CONFIG } });
      return db;
    }
  }

  /**
   * Schedule persistence (debounced)
   * @private
   */
  _schedulePersist() {
    if (this._isShuttingDown) return;

    this._persistPending = true;
    const now = Date.now();

    // Force persist if max wait exceeded
    if (now - this._lastPersist > MAX_PERSIST_WAIT_MS) {
      if (this._persistTimer) {
        clearTimeout(this._persistTimer);
        this._persistTimer = null;
      }
      // true, _doPersist() returns a resolved promise (no-op). Assigning that to
      // _currentPersistPromise would overwrite the reference to the real in-flight
      // persist, causing cleanup() to skip waiting for it and risk data loss.
      // Setting _persistPending = true (above) is sufficient: the running persist's
      // finally block will see the flag and reschedule.
      if (!this._isPersisting) {
        this._currentPersistPromise = this._doPersist();
      }
      return;
    }

    // Debounce
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
    }

    this._persistTimer = setTimeout(() => {
      // if a persist is still running when the timer fires.
      if (!this._isPersisting) {
        this._currentPersistPromise = this._doPersist();
      }
    }, PERSIST_DEBOUNCE_MS);
    // Prevent persist timer from keeping Node.js/Electron alive on shutdown
    if (typeof this._persistTimer?.unref === 'function') this._persistTimer.unref();
  }

  /**
   * Persist all databases to disk
   * @private
   */
  async _doPersist() {
    if (!this._persistPending || this._isShuttingDown) return;
    if (this._isPersisting) return; // prevent concurrent persist runs

    this._isPersisting = true;
    this._persistPending = false;
    this._lastPersist = Date.now();

    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }

    try {
      // Persist embedding sidecar maps before Orama JSON blobs so we always
      // have a recoverable vector source even if persistence is interrupted.
      for (const name of Object.keys(this._databases)) {
        try {
          const embMap = this._embeddingStore?.[name];
          const sidecarPath = path.join(this._dataPath, `${name}.sidecar.json`);
          /** @type {Record<string, any>} */
          const serializableEmbeddings = {};
          if (embMap && typeof embMap.entries === 'function') {
            for (const [docId, emb] of embMap.entries()) {
              const normalized = this._normalizeEmbeddingVector(emb, this._dimension);
              if (normalized) {
                serializableEmbeddings[docId] = normalized;
              }
            }
          }
          const sidecarData = JSON.stringify(serializableEmbeddings);
          await writeFileAtomic(sidecarPath, sidecarData);
          try {
            const metaPath = path.join(this._dataPath, `${name}.meta.json`);
            const metaPayload = JSON.stringify({
              schemaVersion: 1,
              collection: name,
              dimension: this._dimension,
              embeddingSidecarCount: Object.keys(serializableEmbeddings).length,
              updatedAt: Date.now()
            });
            await writeFileAtomic(metaPath, metaPayload);
          } catch (metaError) {
            logger.debug('[OramaVectorService] Failed to persist collection meta', {
              collection: name,
              error: metaError.message
            });
          }
        } catch (sidecarError) {
          logger.debug('[OramaVectorService] Failed to persist sidecar', {
            collection: name,
            error: sidecarError.message
          });
        }
      }

      for (const [name, db] of Object.entries(this._databases)) {
        const persistPath = path.join(this._dataPath, `${name}.json`);
        const compressedPath = `${persistPath}.lz4`;
        const data = /** @type {any} */ (await persist(db, 'json'));
        // Keep a single-generation `.bak` of the active persistence. Previously
        // the rotation `rename(active → active.bak)` happened BEFORE
        // writeFileAtomic, opening a window where neither the active file nor
        // a known-good backup existed. A crash there left the next startup
        // with no readable persistence at all.
        //
        // Fix: copy (not rename) the active file aside FIRST. While the copy
        // is in flight both files exist; if we crash here the active file is
        // still intact and consistent. After writeFileAtomic replaces active,
        // the .bak still holds the previous good version.
        const activePath = PERSIST_COMPRESSION_ENABLED ? compressedPath : persistPath;
        try {
          // Atomic .bak rotation via copy → fsync → rename. fs.copyFile alone
          // is NOT atomic at the destination on Windows: CopyFileW opens dest
          // with CREATE_ALWAYS and writes in chunks, so a concurrent reader
          // can observe a partial .bak. Write to a tmp sibling first, fsync
          // it durably, then rename onto .bak (rename is atomic on the same
          // volume on every supported OS).
          const bakPath = `${activePath}.bak`;
          // PID alone is not enough: a debounced save and a final-shutdown
          // save can fire near-simultaneously for the same collection (same
          // activePath) within one process. They would race on the same
          // tmp file — one truncates while the other is mid-fsync, and
          // rename(tmpBakPath, bakPath) may move the wrong content.
          // Mirror the durableWriteJson tmp-naming pattern.
          const tmpBakPath =
            `${activePath}.bak.tmp.${process.pid}.${Date.now()}.` +
            `${require('crypto').randomBytes(4).toString('hex')}`;
          try {
            await fs.copyFile(activePath, tmpBakPath);
            const fh = await fs.open(tmpBakPath, 'r+');
            try {
              await fh.sync();
            } finally {
              await fh.close();
            }
            await fs.rename(tmpBakPath, bakPath);
          } catch (innerErr) {
            // Best-effort cleanup of the tmp file on failure.
            await swallow(fs.unlink(tmpBakPath), logger, 'cleanup:orama.tmpBakPath');
            throw innerErr;
          }
        } catch (bakError) {
          // ENOENT on first persist (active doesn't exist yet) is expected.
          if (bakError?.code !== 'ENOENT') {
            logger.debug('[OramaVectorService] Failed to rotate persistence .bak', {
              collection: name,
              path: activePath,
              error: bakError.message
            });
          }
        }
        if (PERSIST_COMPRESSION_ENABLED) {
          const compressed = /** @type {any} */ (
            await compress(/** @type {any} */ (Buffer.from(data, 'utf8')))
          );
          await writeFileAtomic(compressedPath, compressed);
          try {
            await fs.unlink(persistPath);
          } catch {
            // Ignore if legacy JSON doesn't exist
          }
        } else {
          await writeFileAtomic(persistPath, data);
        }
      }

      logger.debug('[OramaVectorService] Persisted all databases');
    } catch (error) {
      this._persistRetryCount = (this._persistRetryCount || 0) + 1;
      const maxRetries = 5;
      if (this._persistRetryCount >= maxRetries) {
        logger.error(
          `[OramaVectorService] Persistence failed ${maxRetries} consecutive times, stopping retries`,
          attachErrorCode(error, ERROR_CODES.VECTOR_DB_PERSIST_FAILED)
        );
        this._persistPending = false;
      } else {
        this._persistPending = true;
        logger.error(
          `[OramaVectorService] Persistence failed (attempt ${this._persistRetryCount}/${maxRetries}):`,
          attachErrorCode(error, ERROR_CODES.VECTOR_DB_PERSIST_FAILED)
        );
      }
    } finally {
      this._isPersisting = false;
      // If new writes arrived while we were persisting, the debounce timer that
      // fired during our run was dropped (guard on line 368). Reschedule so
      // those writes are not silently orphaned.
      if (this._persistPending && !this._isShuttingDown) {
        this._persistTimer = setTimeout(() => {
          if (!this._isPersisting) {
            this._currentPersistPromise = this._doPersist();
          }
        }, PERSIST_DEBOUNCE_MS);
        if (typeof this._persistTimer?.unref === 'function') this._persistTimer.unref();
      }
      // Reset retry counter on successful persist
      if (!this._persistPending) {
        this._persistRetryCount = 0;
      }
    }
  }

  /**
   * Force persist all databases immediately.
   * Waits for any in-flight background persist before starting a new one.
   */
  async persistAll() {
    const maxWaitMs = 30_000;
    const pollMs = 50;
    const deadline = Date.now() + maxWaitMs;
    while (this._currentPersistPromise || this._isPersisting) {
      if (Date.now() > deadline) {
        throw new Error('persistAll: timed out waiting for in-flight persist to complete');
      }
      if (this._currentPersistPromise) {
        const inflight = this._currentPersistPromise;
        await inflight;
        if (this._currentPersistPromise === inflight) {
          this._currentPersistPromise = null;
        }
      }
      if (this._isPersisting) {
        await new Promise((r) => setTimeout(r, pollMs));
      }
    }
    this._persistPending = true;
    const myPromise = this._doPersist();
    this._currentPersistPromise = myPromise;
    await myPromise;
    // Only null out if no new persist was scheduled while we were running
    if (this._currentPersistPromise === myPromise) {
      this._currentPersistPromise = null;
    }
  }

  /**
   * Validate embedding dimensions
   * @private
   */
  _validateEmbedding(/** @type {any} */ embedding, collectionType = 'files') {
    if (!Array.isArray(embedding)) {
      throw new Error('Embedding must be an array');
    }
    if (embedding.length === 0) {
      throw new Error('Embedding cannot be empty');
    }
    if (embedding.some((v) => !Number.isFinite(v))) {
      throw new Error('Embedding contains invalid values (NaN or Infinity)');
    }

    // Check against the cached dimension, or the schema's when the
    // collection is empty (see validateEmbeddingDimension).
    const expectedDim = this._collectionDimensions[collectionType] ?? this._schemaDimension();
    if (expectedDim !== null && embedding.length !== expectedDim) {
      const error =
        `Embedding dimension mismatch: collection "${collectionType}" expects ${expectedDim} dimensions but received ${embedding.length}. ` +
        `This typically occurs when changing embedding models. Use "Rebuild Embeddings" to migrate to the new model.`;

      this.emit('dimension-mismatch', {
        collectionType,
        expectedDim,
        actualDim: embedding.length,
        message: error
      });

      throw attachErrorCode(new Error(error), ERROR_CODES.VECTOR_DB_DIMENSION_MISMATCH);
    }

    // Cache dimension on first insert
    if (this._collectionDimensions[collectionType] === null) {
      this._collectionDimensions[collectionType] = embedding.length;
    }
  }

  /**
   * Check if a hit has a zero-placeholder embedding (all zeros).
   * These are inserted during restore when Orama loses vector data.
   * Returns false (keep the hit) if the embedding field is absent from the result.
   * @private
   */
  _isZeroPlaceholderHit(/** @type {any} */ hit) {
    const emb = hit.document?.embedding;
    // If embedding is not present in search result, assume it's valid
    if (!Array.isArray(emb) || emb.length === 0) return false;
    return emb[0] === 0 && emb.every((v) => v === 0);
  }

  /**
   * True only when the store is loaded and `id` has no real vector (absent or
   * a zero placeholder): the file was analyzed but never embedded. O(1)
   * against the in-memory sidecar. Search fusion uses it to tell "not similar
   * to the query" apart from "the vector legs could never have scored this
   * file". Anything uncertain (store not loaded) answers false, which keeps
   * the conservative scoring.
   * @param {string} id
   * @returns {boolean}
   */
  isKnownUnembedded(id) {
    const store = this._embeddingStore?.files;
    if (!(store instanceof Map) || store.size === 0 || typeof id !== 'string') return false;
    const vector = store.get(id);
    return !Array.isArray(vector) || vector.length === 0 || vector.every((v) => v === 0);
  }

  /**
   * Request extra vector hits so placeholder filtering does not starve results.
   * Some restored indexes can contain zero-placeholder vectors that rank highly.
   * @private
   */
  _resolveVectorSearchLimit(/** @type {any} */ topK) {
    const normalizedTopK = Number.isFinite(topK) && topK > 0 ? Math.max(1, Math.floor(topK)) : 10;
    return Math.min(200, Math.max(normalizedTopK, normalizedTopK * 4, normalizedTopK + 25));
  }

  _cosineSimilarity(/** @type {any} */ a, /** @type {any} */ b) {
    return cosineSimilarity(a, b);
  }

  async _fallbackQuerySimilarFiles(/** @type {any} */ queryEmbedding, /** @type {any} */ topK) {
    const normalizedTopK = Number.isFinite(topK) && topK > 0 ? Math.max(1, Math.floor(topK)) : 10;
    const embStore = this._embeddingStore?.files;
    const scored = [];

    // Fast path: use in-memory sidecar vectors and only fetch metadata for top candidates.
    if (embStore instanceof Map && embStore.size > 0) {
      for (const [docId, rawVector] of embStore.entries()) {
        const emb = this._normalizeEmbeddingVector(rawVector, queryEmbedding.length);
        if (!Array.isArray(emb) || emb.length !== queryEmbedding.length) continue;
        if (emb[0] === 0 && emb.every((v) => v === 0)) continue;
        const score = this._cosineSimilarity(queryEmbedding, emb);
        if (!Number.isFinite(score) || score <= 0) continue;
        scored.push({ id: docId, score });
      }

      scored.sort((a, b) => b.score - a.score);
      const candidates = scored.slice(0, Math.max(normalizedTopK * 3, normalizedTopK));
      const results = [];

      for (const candidate of candidates) {
        const doc = await getByID(this._databases.files, candidate.id);
        if (!doc || doc.isOrphaned || doc.hasVector === false) continue;
        results.push({
          id: doc.id,
          score: candidate.score,
          distance: 1 - candidate.score,
          metadata: {
            path: doc.filePath,
            filePath: doc.filePath,
            fileName: doc.fileName,
            fileType: doc.fileType,
            analyzedAt: doc.analyzedAt,
            suggestedName: doc.suggestedName,
            keywords: doc.keywords,
            tags: doc.tags
          }
        });
        if (results.length >= normalizedTopK) break;
      }

      if (results.length > 0) {
        return results;
      }
    }

    // Slow path fallback for edge cases where sidecar map is unavailable.
    const docs = await this._getAllFileDocuments();
    const scoredDocs = [];
    for (const doc of docs) {
      if (doc?.isOrphaned) continue;
      const emb = this._normalizeEmbeddingVector(
        this._embeddingStore?.files?.get(doc.id) || doc.embedding,
        queryEmbedding.length
      );
      if (!Array.isArray(emb) || emb.length !== queryEmbedding.length) continue;
      if (emb[0] === 0 && emb.every((v) => v === 0)) continue;
      const score = this._cosineSimilarity(queryEmbedding, emb);
      if (!Number.isFinite(score) || score <= 0) continue;
      scoredDocs.push({ doc, score });
    }
    scoredDocs.sort((a, b) => b.score - a.score);
    return scoredDocs.slice(0, normalizedTopK).map(({ doc, score }) => ({
      id: doc.id,
      score,
      distance: 1 - score,
      metadata: {
        path: doc.filePath,
        filePath: doc.filePath,
        fileName: doc.fileName,
        fileType: doc.fileType,
        analyzedAt: doc.analyzedAt,
        suggestedName: doc.suggestedName,
        keywords: doc.keywords,
        tags: doc.tags
      }
    }));
  }

  async _fallbackQueryFoldersByEmbedding(
    /** @type {any} */ queryEmbedding,
    /** @type {any} */ topK
  ) {
    const normalizedTopK = Number.isFinite(topK) && topK > 0 ? Math.max(1, Math.floor(topK)) : 5;
    const embStore = this._embeddingStore?.folders;
    const scored = [];

    // Fast path: use in-memory sidecar vectors, then fetch folder metadata for top candidates.
    if (embStore instanceof Map && embStore.size > 0) {
      for (const [docId, rawVector] of embStore.entries()) {
        const emb = this._normalizeEmbeddingVector(rawVector, queryEmbedding.length);
        if (!Array.isArray(emb) || emb.length !== queryEmbedding.length) continue;
        if (emb[0] === 0 && emb.every((v) => v === 0)) continue;
        const score = this._cosineSimilarity(queryEmbedding, emb);
        if (!Number.isFinite(score) || score <= 0) continue;
        scored.push({ id: docId, score });
      }

      scored.sort((a, b) => b.score - a.score);
      const candidates = scored.slice(0, Math.max(normalizedTopK * 3, normalizedTopK));
      const results = [];

      for (const candidate of candidates) {
        const doc = await getByID(this._databases.folders, candidate.id);
        if (!doc) continue;
        results.push({
          id: doc.id,
          score: candidate.score,
          distance: 1 - candidate.score,
          metadata: {
            path: doc.folderPath,
            folderPath: doc.folderPath,
            folderName: doc.folderName,
            description: doc.description,
            patterns: doc.patterns
          }
        });
        if (results.length >= normalizedTopK) break;
      }

      if (results.length > 0) {
        return results;
      }
    }

    // Slow path: enumerate folders and score with sidecar vectors.
    const allFolders = await this.getAllFolders();
    const scoredDocs = [];
    for (const folder of allFolders) {
      const docId = folder?.id;
      if (!docId) continue;
      const doc = await getByID(this._databases.folders, docId);
      if (!doc) continue;
      const emb = this._normalizeEmbeddingVector(
        this._embeddingStore?.folders?.get(doc.id) || doc.embedding,
        queryEmbedding.length
      );
      if (!Array.isArray(emb) || emb.length !== queryEmbedding.length) continue;
      if (emb[0] === 0 && emb.every((v) => v === 0)) continue;
      const score = this._cosineSimilarity(queryEmbedding, emb);
      if (!Number.isFinite(score) || score <= 0) continue;
      scoredDocs.push({ doc, score });
    }

    scoredDocs.sort((a, b) => b.score - a.score);
    return scoredDocs.slice(0, normalizedTopK).map(({ doc, score }) => ({
      id: doc.id,
      score,
      distance: 1 - score,
      metadata: {
        path: doc.folderPath,
        folderPath: doc.folderPath,
        folderName: doc.folderName,
        description: doc.description,
        patterns: doc.patterns
      }
    }));
  }

  _hasRepairableFolderEmbeddings() {
    const embStore = this._embeddingStore?.folders;
    if (!(embStore instanceof Map) || embStore.size === 0) {
      return false;
    }

    return Array.from(embStore.values()).some((vector) => {
      const normalized = this._normalizeEmbeddingVector(vector, this._dimension);
      return (
        Array.isArray(normalized) &&
        normalized.length === this._dimension &&
        !(normalized[0] === 0 && normalized.every((value) => value === 0))
      );
    });
  }

  async _retryFolderPrimaryQueryAfterRepair(
    /** @type {any} */ embedding,
    /** @type {any} */ topK,
    /** @type {any} */ reason
  ) {
    if (!this._hasRepairableFolderEmbeddings()) {
      return null;
    }

    if (this._folderVectorHealth.repairAttempts >= VECTOR_PRIMARY_MAX_REPAIR_ATTEMPTS) {
      return null;
    }

    this._setFolderVectorHealth({
      repairAttempts: this._folderVectorHealth.repairAttempts + 1,
      lastRepairAt: Date.now()
    });

    logger.warn(
      '[OramaVectorService] Empty folder vector query with populated sidecar; attempting folders index repair',
      { reason, topK }
    );

    const repair = await this._repairFoldersVectorIndexFromCurrentState();
    logger.info('[OramaVectorService] Folders vector index repair completed after empty query', {
      ...repair,
      reason
    });

    const result = await searchPreservingStoredVectors(this._databases.folders, {
      mode: 'vector',
      vector: { value: embedding, property: 'embedding' },
      similarity: VECTOR_SEARCH_MIN_SIMILARITY,
      limit: this._resolveVectorSearchLimit(topK)
    });
    const filteredHits = (result?.hits || [])
      .filter((hit) => !this._isZeroPlaceholderHit(hit))
      .slice(0, topK);

    if (filteredHits.length === 0) {
      return null;
    }

    this._setFolderVectorHealth({
      primaryHealthy: true,
      lastValidatedAt: Date.now(),
      lastValidationReason: `${reason}:repaired-empty-query`,
      lastValidationError: null
    });

    getSystemAnalyticsSafe()?.recordPipelineOutcome?.('embedding', 'primary', {
      reason: 'folder_vector_primary_repaired'
    });

    return filteredHits.map((hit) => ({
      id: hit.document.id,
      score: hit.score,
      distance: 1 - hit.score,
      metadata: {
        path: hit.document.folderPath,
        folderPath: hit.document.folderPath,
        folderName: hit.document.folderName,
        description: hit.document.description,
        patterns: hit.document.patterns
      }
    }));
  }

  /**
   * Validate embedding dimension without throwing
   * @param {Array<number>} vector - Embedding vector
   * @param {string} collectionType - Collection name
   * @returns {Promise<{valid: boolean, error?: string, expectedDim?: number, actualDim?: number}>}
   */
  async validateEmbeddingDimension(vector, collectionType) {
    if (!Array.isArray(vector) || vector.length === 0) {
      return { valid: false, error: 'invalid_vector' };
    }

    // An empty collection still has a schema, built for this._dimension.
    // Caching the first arriving vector's length instead let a stale
    // old-model vector from the persisted queue fix the wrong dimension
    // right after resetAll: Orama then rejected it, the wrong cache stayed,
    // and every correct vector after it was refused until restart.
    const expectedDim = this._collectionDimensions[collectionType] ?? this._schemaDimension();

    if (expectedDim !== null && vector.length !== expectedDim) {
      return {
        valid: false,
        error: 'dimension_mismatch',
        expectedDim,
        actualDim: vector.length
      };
    }

    if (this._collectionDimensions[collectionType] === null) {
      this._collectionDimensions[collectionType] = vector.length;
    }
    return { valid: true };
  }

  /**
   * The dimension the collections' schemas were built for, or null when the
   * service has not resolved one yet.
   * @returns {number|null}
   */
  _schemaDimension() {
    return Number.isInteger(this._dimension) && this._dimension > 0 ? this._dimension : null;
  }

  _validateBatchDimensions(/** @type {any} */ items, /** @type {any} */ collectionType) {
    const vectors = (items || [])
      .map((/** @type {any} */ item) => item?.vector)
      .filter((/** @type {any} */ vector) => Array.isArray(vector) && vector.length > 0);

    if (vectors.length === 0) {
      return { valid: true };
    }

    const expectedDim = this._collectionDimensions[collectionType] ?? this._schemaDimension();
    if (expectedDim !== null) {
      const mismatch = vectors.find((/** @type {any} */ vector) => vector.length !== expectedDim);
      if (mismatch) {
        return {
          valid: false,
          error: 'dimension_mismatch',
          expectedDim,
          actualDim: mismatch.length
        };
      }
      if (this._collectionDimensions[collectionType] === null) {
        this._collectionDimensions[collectionType] = expectedDim;
      }
      return { valid: true };
    }

    const expected = vectors[0].length;
    const mismatch = vectors.find((/** @type {any} */ vector) => vector.length !== expected);
    if (mismatch) {
      return {
        valid: false,
        error: 'dimension_mismatch',
        expectedDim: expected,
        actualDim: mismatch.length
      };
    }

    this._collectionDimensions[collectionType] = expected;
    return { valid: true };
  }

  _validateEmbeddingValues(/** @type {any} */ vector, /** @type {any} */ _collectionType) {
    if (!Array.isArray(vector) || vector.length === 0) {
      return { valid: false, error: 'invalid_vector' };
    }
    if (vector.some((v) => !Number.isFinite(v))) {
      return { valid: false, error: 'invalid_vector_values' };
    }
    return { valid: true };
  }

  /**
   * Get collection dimension
   * @param {string} collectionType - Collection name
   * @returns {Promise<number|null>}
   */
  async getCollectionDimension(collectionType) {
    return this._collectionDimensions[collectionType];
  }

  // ==================== FILE OPERATIONS ====================

  /**
   * Get a file document by ID
   * @param {string} id - File ID
   * @returns {Promise<Object|null>} File document or null
   */
  async getFile(id) {
    await this.initialize();
    try {
      const doc = await getByID(this._databases.files, id);
      return doc || null;
    } catch (error) {
      logger.debug('[OramaVectorService] getFile lookup failed', {
        id,
        error: error?.message
      });
      return null;
    }
  }

  /**
   * Find all files with a matching SHA-256 content hash.
   * Used by the Duplicate Finder's EXACT tier and by Downloads Triage's
   * "hash collision with organized file" signal.
   *
   * @param {string} hash
   * @param {any} [options]
   * @returns {Promise<any[]>}
   */
  async findByHash(hash, /** @type {any} */ options = {}) {
    if (typeof hash !== 'string' || hash.length === 0) return [];
    await this.initialize();
    const limit = Math.max(1, Math.min(options.limit || 200, 1000));
    try {
      const result = await searchPreservingStoredVectors(this._databases.files, {
        term: '',
        where: { fileHash: hash },
        limit
      });
      if (!result || !Array.isArray(result.hits)) return [];
      // `where` on a string is token-based, not exact; keep only this hash.
      return result.hits
        .map((hit) => hit.document)
        .filter((/** @type {any} */ doc) => doc && doc.fileHash === hash);
    } catch (err) {
      logger.warn('[OramaVectorService] findByHash failed', {
        hash: hash.slice(0, 8),
        error: err?.message
      });
      return [];
    }
  }

  /**
   * Returns a clone of a file doc with a valid `embedding` array. If the stored
   * embedding is null or non-array (which can happen for rows restored from a
   * sidecar that lost vector data, or persisted before an embedding was
   * computed), substitute a zero-vector of the current dimension. Without this,
   * Orama's vector-schema validator reads `.length` on the null value during
   * `update()` and throws `Cannot read properties of null (reading 'length')`,
   * causing every per-file write that flows through this boundary to fail.
   *
   * @private
   * @param {any} doc - existing file doc from getByID
   * @returns {any} doc with `embedding` guaranteed to be Array<number>
   */
  _normalizeFileDocForUpdate(doc) {
    if (Array.isArray(doc?.embedding)) return doc;
    return { ...doc, embedding: new Array(this._dimension).fill(0) };
  }

  /**
   * Update the stored fileHash for an existing file record without re-embedding.
   * Used by the opportunistic hash backfill (Reindex File Hashes settings action).
   *
   * @param {string} id - File document id
   * @param {string} fileHash - SHA-256 hex digest
   * @returns {Promise<boolean>} true if updated, false if the record didn't exist
   */
  async updateFileHash(id, fileHash) {
    if (!id || typeof fileHash !== 'string') return false;
    // Write gate: the final shutdown persist has already snapshotted state;
    // any write past this point would be silently lost (same contract as
    // upsertFile/batchUpsertFiles/upsertFolder).
    if (this._isShuttingDown || this._writesBlocked) return false;
    await this.initialize();
    try {
      const existing = await getByID(this._databases.files, id);
      if (!existing) return false;
      await update(this._databases.files, id, {
        ...this._normalizeFileDocForUpdate(existing),
        fileHash
      });
      this._invalidateCacheForFile(id);
      this._schedulePersist();
      return true;
    } catch (err) {
      logger.warn('[OramaVectorService] updateFileHash failed', {
        id,
        error: err?.message
      });
      return false;
    }
  }

  /**
   * Get a folder document by ID
   * @param {string} id - Folder ID
   * @returns {Promise<Object|null>} Folder document or null
   */
  async getFolder(id) {
    await this.initialize();
    try {
      return await getByID(this._databases.folders, id);
    } catch {
      return null;
    }
  }

  /**
   * Upsert a file embedding (vector + metadata) into the files collection.
   *
   * @param {any} file
   * @returns {Promise<any>}
   */
  async upsertFile(file) {
    if (!file.id || !file.vector || !Array.isArray(file.vector)) {
      throw new Error('Invalid file data: missing id or vector');
    }

    if (this._isShuttingDown || this._writesBlocked) {
      return { queued: false, fileId: file.id, skipped: true, reason: 'shutdown' };
    }

    await this.initialize();

    // Validate dimensions
    const dimValidation = await this.validateEmbeddingDimension(file.vector, 'files');
    if (!dimValidation.valid) {
      this.emit('embedding-blocked', {
        type: 'dimension_mismatch',
        fileId: file.id,
        expectedDim: dimValidation.expectedDim,
        actualDim: dimValidation.actualDim,
        message: 'Embedding model changed. Run "Rebuild Embeddings" to fix.'
      });
      return {
        success: false,
        fileId: file.id,
        error: 'dimension_mismatch',
        requiresRebuild: true
      };
    }

    const doc = {
      id: file.id,
      embedding: file.vector,
      hasVector: !(file.vector[0] === 0 && file.vector.every((/** @type {any} */ v) => v === 0)),
      filePath: file.meta?.path || file.meta?.filePath || '',
      fileName:
        file.meta?.fileName ||
        file.meta?.name ||
        require('../../shared/crossPlatformUtils').crossPlatformBasename(file.meta?.path || ''),
      fileType: file.meta?.fileType || file.meta?.type || file.meta?.mimeType || '',
      analyzedAt: file.meta?.analyzedAt || new Date().toISOString(),
      suggestedName: file.meta?.suggestedName || '',
      keywords: file.meta?.keywords || [],
      tags: file.meta?.tags || [],
      isOrphaned: false,
      orphanedAt: '',
      extractionMethod: file.meta?.extractionMethod || '',
      fileHash: typeof file.meta?.fileHash === 'string' ? file.meta.fileHash : ''
    };

    try {
      // Try to get existing document
      const existing = await getByID(this._databases.files, file.id);
      if (existing) {
        await update(this._databases.files, file.id, doc);
      } else {
        await insert(this._databases.files, doc);
      }
    } catch {
      // If getByID fails, try insert
      try {
        await insert(this._databases.files, doc);
      } catch {
        // Already exists, try update
        await update(this._databases.files, file.id, doc);
      }
    }

    // Update embedding sidecar store
    if (doc.embedding && doc.embedding.length > 0) {
      if (!this._embeddingStore.files) this._embeddingStore.files = new Map();
      this._embeddingStore.files.set(file.id, doc.embedding);
      // Evict oldest entries if embedding store exceeds cap
      if (this._embeddingStore.files.size > this._maxEmbeddingStoreSize) {
        const iter = this._embeddingStore.files.keys();
        const evictedId = iter.next().value;
        this._embeddingStore.files.delete(evictedId);
        // Mark evicted entry in Orama so repair doesn't assume vector exists
        this._markSidecarEvicted(evictedId);
      }
    }

    this._invalidateCacheForFile(file.id);
    this._schedulePersist();
    this._emitSearchDataMutated('files', 'upsert', { fileId: file.id });

    return { success: true, fileId: file.id };
  }

  /**
   * Batch upsert files
   */
  async batchUpsertFiles(/** @type {any} */ files) {
    if (!files || files.length === 0) {
      return { queued: false, count: 0 };
    }

    if (this._isShuttingDown || this._writesBlocked) {
      return { queued: false, count: 0, skipped: true, reason: 'shutdown' };
    }

    await this.initialize();

    // Validate batch dimensions before upserting any items to avoid partial writes
    const dimValidation = this._validateBatchDimensions(files, 'files');
    if (!dimValidation.valid && dimValidation.error === 'dimension_mismatch') {
      this.emit('embedding-blocked', {
        type: 'dimension_mismatch',
        fileCount: files.length,
        expectedDim: dimValidation.expectedDim,
        actualDim: dimValidation.actualDim,
        message: 'Embedding model changed. Run "Rebuild Embeddings" to fix.'
      });
      return {
        success: false,
        count: 0,
        failed: files.map((/** @type {any} */ f) => ({
          id: f.id || f.path,
          error: 'dimension_mismatch',
          requiresRebuild: true
        })),
        error: 'dimension_mismatch',
        requiresRebuild: true
      };
    }

    let successCount = 0;
    const failed = [];
    const upsertResults = await this._runBoundedBatch(files, (/** @type {any} */ file) =>
      this.upsertFile(file)
    );
    for (let i = 0; i < upsertResults.length; i++) {
      const settled = upsertResults[i];
      const file = files[i];
      if (settled?.status === 'fulfilled') {
        const result = settled.value;
        if (result?.success !== false) {
          successCount++;
        } else {
          failed.push({
            id: file.id,
            error: result?.error || 'upsert_failed',
            requiresRebuild: result?.requiresRebuild === true
          });
        }
      } else {
        const error = settled?.reason || new Error('upsert_failed');
        logger.warn('[OramaVectorService] Failed to upsert file in batch:', {
          fileId: file.id,
          error: error.message
        });
        failed.push({ id: file.id, error: error.message });
      }
    }

    // Sanity-check file vector retrieval after upsert to catch index drift early.
    if (successCount > 0) {
      try {
        await this._ensurePrimaryVectorHealth({
          reason: 'batch-upsert-files',
          force: true,
          autoRepair: true
        });
      } catch (error) {
        logger.warn('[OramaVectorService] File post-upsert health check failed', {
          error: error?.message
        });
      }
    }

    return {
      queued: false,
      count: successCount,
      failed,
      success: failed.length === 0
    };
  }

  /**
   * Query similar files by embedding
   */
  async querySimilarFiles(/** @type {any} */ queryEmbedding, topK = 10) {
    await this.initialize();

    // NaN / negative values are almost always a caller bug (settings parse
    // failure, off-by-one in a reducer) and used to be coerced to 10, masking
    // the bug. Reject loudly so the problem surfaces at the call-site.
    if (!Number.isFinite(topK) || topK < 0) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(`querySimilarFiles: topK must be a non-negative finite number (got ${topK})`)
      );
      err.code = 'INVALID_TOPK';
      throw err;
    }

    // Validate the embedding BEFORE the topK=0 short-circuit so a malformed
    // embedding (wrong dim, NaN values) still produces the loud failure the
    // comment promises, regardless of how many results were requested.
    this._validateEmbedding(queryEmbedding, 'files');

    // Honor topK=0 as an explicit "no results requested" — recall diagnostics
    // sweep collections with a 0-budget. Must come AFTER embedding validation.
    if (topK === 0) return [];

    try {
      const limit = this._resolveVectorSearchLimit(topK);
      const result = await searchPreservingStoredVectors(this._databases.files, {
        mode: 'vector',
        vector: { value: queryEmbedding, property: 'embedding' },
        similarity: VECTOR_SEARCH_MIN_SIMILARITY,
        limit,
        where: { isOrphaned: false, hasVector: true }
      });

      const filtered = result.hits.filter((hit) => !this._isZeroPlaceholderHit(hit)).slice(0, topK);
      if (filtered.length > 0) {
        getSystemAnalyticsSafe()?.recordPipelineOutcome?.('embedding', 'primary', {
          reason: 'vector_primary_query'
        });
        return filtered.map((hit) => ({
          id: hit.document.id,
          score: hit.score,
          distance: 1 - hit.score, // Convert similarity to distance
          metadata: {
            path: hit.document.filePath,
            filePath: hit.document.filePath,
            fileName: hit.document.fileName,
            fileType: hit.document.fileType,
            analyzedAt: hit.document.analyzedAt,
            suggestedName: hit.document.suggestedName,
            keywords: hit.document.keywords,
            tags: hit.document.tags
          }
        }));
      }

      // On empty primary results, check cached health status first (cheap).
      // Only force a full re-validation when the cached status is stale.
      // This avoids running a 30 s health probe + potential index repair on
      // every single search query when Orama's vector index is degraded.
      const health = await this._ensurePrimaryVectorHealth({
        reason: 'query-empty',
        force: false,
        autoRepair: true
      });
      if (health.primaryHealthy === false) {
        logger.warn(
          '[OramaVectorService] Primary vector query unavailable; using fallback scorer',
          { topK, health }
        );
        getSystemAnalyticsSafe()?.recordPipelineOutcome?.('embedding', 'fallback', {
          reason: 'vector_primary_unhealthy'
        });
        return await this._fallbackQuerySimilarFiles(queryEmbedding, topK);
      }

      // Orama v3.1.x can pass its own self-check yet still return empty hits
      // for real queries. Fall back to cosine scorer immediately so the user
      // gets results without waiting for another probe.
      logger.debug(
        '[OramaVectorService] Primary vector query returned no hits; using fallback scorer',
        { topK }
      );
      getSystemAnalyticsSafe()?.recordPipelineOutcome?.('embedding', 'fallback', {
        reason: 'vector_primary_empty'
      });
      return await this._fallbackQuerySimilarFiles(queryEmbedding, topK);
    } catch (error) {
      getSystemAnalyticsSafe()?.recordPipelineOutcome?.('embedding', 'error', {
        reason: error?.message || 'vector_query_failed'
      });
      throw attachErrorCode(error, ERROR_CODES.VECTOR_DB_QUERY_FAILED);
    }
  }

  /**
   * Find files similar to a given file ID within a target directory.
   * Useful for pre-move duplicate detection via embedding similarity.
   *
   * @param {string} fileId - The semantic file ID (e.g., "file:/path/to/file")
   * @param {string} targetDirectory
   * @param {any} [options]
   * @returns {Promise<any[]>}
   */
  async findSimilarInDirectory(fileId, targetDirectory, /** @type {any} */ options = {}) {
    const { threshold = 0.9, topK = 5 } = options;
    await this.initialize();

    if (!fileId || !targetDirectory) return [];

    // Get the source file's embedding
    const sourceEmbedding = await this._getEmbeddingForFile(fileId);
    if (!sourceEmbedding || !Array.isArray(sourceEmbedding) || sourceEmbedding.length === 0) {
      return [];
    }

    try {
      // Query the vector DB for similar files
      const results = await this.querySimilarFiles(sourceEmbedding, topK * 3);

      // Normalize directory path for consistent comparison.
      // Case-insensitive comparison only on Windows (NTFS/exFAT default to
      // case-insensitive). On Linux/macOS-default-APFS the filesystem is
      // case-sensitive, and lowercasing here would let `Foo.pdf` and
      // `foo.pdf` collide as the same neighbour — silently merging two
      // distinct files. RelationshipIndexService and FilePathCoordinator
      // store paths case-preserved; aligning with that here.
      const isWin = process.platform === 'win32';
      const canonicalize = (/** @type {any} */ p) => {
        const slashes = p.replace(/\\/g, '/').replace(/\/+$/, '');
        return isWin ? slashes.toLowerCase() : slashes;
      };
      const normalizedDir = canonicalize(targetDirectory);

      // Filter to files within the target directory and above threshold
      return results
        .filter((result) => {
          if (result.id === fileId) return false; // Exclude self
          const rawFilePath = result.metadata?.filePath || result.metadata?.path || '';
          if (!rawFilePath) return false;
          const filePath = canonicalize(rawFilePath);
          // Check if file is within the target directory
          return filePath.startsWith(normalizedDir + '/') && result.score >= threshold;
        })
        .slice(0, topK)
        .map((result) => ({
          id: result.id,
          score: result.score,
          metadata: result.metadata
        }));
    } catch (error) {
      logger.warn('[OramaVectorService] findSimilarInDirectory failed:', {
        fileId,
        targetDirectory,
        error: error.message
      });
      return [];
    }
  }

  /**
   * Get the stored embedding vector for a file ID.
   * Checks sidecar store first (workaround for Orama vector loss), then falls back
   * to the primary database.
   * @private
   * @param {string} fileId
   * @returns {Promise<number[]|null>}
   */
  async _getEmbeddingForFile(fileId) {
    // Check sidecar store first (preferred, avoids Orama v3.1.x vector loss bug)
    const sidecarEmb = this._embeddingStore?.files?.get(fileId);
    if (Array.isArray(sidecarEmb) && sidecarEmb.length > 0) {
      return sidecarEmb;
    }

    // Fall back to the primary Orama database
    if (this._databases?.files) {
      try {
        const doc = await getByID(this._databases.files, fileId);
        if (doc && Array.isArray(doc.embedding) && doc.embedding.length > 0) {
          return doc.embedding;
        }
      } catch {
        // getByID may throw for missing IDs; treat as not found
      }
    }
    return null;
  }

  /**
   * Delete all file embeddings matching a given absolute filePath. Used by the
   * Duplicate Finder trash handler so records for deleted files don't linger
   * in search results.
   */
  async deleteFileByPath(/** @type {any} */ filePath) {
    if (!filePath) return { deleted: 0 };
    if (this._isShuttingDown || this._writesBlocked) {
      return { deleted: 0, skipped: true, reason: 'shutdown' };
    }
    await this.initialize();
    const { normalizePathForIndex } = require('../../shared/pathSanitization');
    let keys;
    try {
      const norm = normalizePathForIndex(String(filePath));
      keys = Array.from(new Set([String(filePath), norm].filter(Boolean)));
    } catch {
      keys = [String(filePath)];
    }
    const seen = new Set();
    let totalDeleted = 0;
    try {
      // Orama's `where` on a string property is a union over its tokens, so
      // `{ filePath: 'C:\\Users\\me\\Documents\\report (1).pdf' }` also
      // matches every file under Documents or named report/pdf. Trashing one
      // duplicate deleted the vectors of all of them. Collect read-only, keep
      // only rows whose path IS this file, then delete.
      const wanted = new Set(keys);
      /** @type {string[]} */
      const ids = [];
      for (const fp of keys) {
        /** @type {any[]} */
        const hits = await this._paginatedSearch(
          this._databases.files,
          { term: '', where: { filePath: fp } },
          { label: 'delete-file-by-path' }
        );
        for (const hit of hits) {
          const id = hit?.document?.id;
          const docPath = hit?.document?.filePath;
          if (!id || seen.has(id) || typeof docPath !== 'string') continue;
          let docKey = docPath;
          try {
            docKey = normalizePathForIndex(docPath) || docPath;
          } catch {
            // keep the raw path
          }
          if (!wanted.has(docPath) && !wanted.has(docKey)) continue;
          seen.add(id);
          ids.push(id);
        }
      }
      for (const id of ids) {
        try {
          if (await this.deleteFileEmbedding(id)) totalDeleted += 1;
        } catch (err) {
          logger.warn('[OramaVectorService] deleteFileByPath cleanup failed for id', {
            id,
            error: err?.message
          });
        }
      }
      return { deleted: totalDeleted };
    } catch (err) {
      logger.warn('[OramaVectorService] deleteFileByPath failed', {
        filePath,
        error: err?.message
      });
      return { deleted: 0, error: err?.message };
    }
  }

  /**
   * Delete a file embedding
   */
  async deleteFileEmbedding(/** @type {any} */ fileId) {
    if (this._isShuttingDown || this._writesBlocked) return false;
    await this.initialize();

    try {
      await remove(this._databases.files, fileId);
      this._embeddingStore?.files?.delete(fileId);
      this._invalidateCacheForFile(fileId);

      // Cascade-delete exactly this file's chunks (see _collectExactFileChunkHits).
      if (this._databases.fileChunks) {
        try {
          await this._removeExactFileChunks(fileId, 'cascade-delete-chunks');
        } catch {
          logger.debug('[OramaVectorService] Chunk cascade-delete skipped for:', fileId);
        }
      }

      this._schedulePersist();
      this._emitSearchDataMutated('files', 'delete', { fileId });
      return true;
    } catch (error) {
      logger.warn('[OramaVectorService] Delete file embedding failed:', {
        fileId,
        error: error.message
      });
      return false;
    }
  }

  /**
   * Batch delete file embeddings
   */
  async batchDeleteFileEmbeddings(/** @type {any} */ fileIds) {
    if (!fileIds || fileIds.length === 0) {
      return { count: 0, queued: false };
    }
    if (this._isShuttingDown || this._writesBlocked) {
      return { count: 0, queued: false, skipped: true, reason: 'shutdown' };
    }

    await this.initialize();

    let deleted = 0;
    for (const id of fileIds) {
      try {
        await remove(this._databases.files, id);
        this._embeddingStore?.files?.delete(id);
        this._invalidateCacheForFile(id);
        deleted++;

        // Cascade-delete exactly this file's chunks. This path had no
        // fileId guard at all, so deleting one file through it removed the
        // chunks of every file whose id shared a token with it (usually all).
        try {
          await this._removeExactFileChunks(id, 'batch-cascade-delete-chunks');
        } catch {
          // Chunk cleanup is best-effort
        }
      } catch {
        // Continue on error
      }
    }

    this._schedulePersist();
    if (deleted > 0) {
      this._emitSearchDataMutated('files', 'batch-delete', { count: deleted });
    }
    return { queued: false, count: deleted };
  }

  /**
   * Reset files collection
   */
  async resetFiles() {
    await this.initialize();
    this._databases.files = await create({
      schema: this._schemas.files,
      components: { tokenizer: ORAMA_TOKENIZER_CONFIG }
    });
    this._collectionDimensions.files = null;
    this._embeddingStore.files = new Map();
    this._clearQueryCache();
    await this.persistAll();
    this._emitSearchDataMutated('files', 'reset');
    logger.info('[OramaVectorService] Files collection reset');
  }

  /**
   * Update file paths and ids for move and rename operations.
   *
   * @param {Array<{oldId: string, newId: string, newPath?: string, newName?: string, newMeta?: Object}>} pathUpdates - Ordered migration specs
   * @returns {Promise<number>} Count of documents updated
   */
  async updateFilePaths(pathUpdates) {
    if (!pathUpdates || pathUpdates.length === 0) {
      return 0;
    }
    if (this._isShuttingDown || this._writesBlocked) return 0;

    await this.initialize();

    let updated = 0;
    for (const updateSpec of pathUpdates) {
      try {
        const { oldId, newId } = updateSpec || {};
        // Backward-compatible meta handling:
        // Some callers pass { newPath, newName } (legacy),
        // others pass { newMeta: { path, name, ...rest } } (FilePathCoordinator / embeddingSync).
        const _spec = /** @type {any} */ (updateSpec);
        const newPath = _spec?.newPath || _spec?.newMeta?.path || _spec?.newMeta?.filePath || null;
        const newName =
          _spec?.newName ||
          _spec?.newMeta?.name ||
          _spec?.newMeta?.fileName ||
          (newPath
            ? require('../../shared/crossPlatformUtils').crossPlatformBasename(newPath)
            : null);

        if (!oldId) continue;

        // Get existing document
        const existing = /** @type {any} */ (await getByID(this._databases.files, oldId));
        if (!existing) continue;

        // Build merged metadata: start with existing, apply all newMeta fields,
        // then ensure filePath/fileName are correct. This propagates rich metadata
        // (smartFolder, category, tags, summary, etc.) that callers like
        // syncEmbeddingForMove provide, instead of silently dropping them.
        const metaOverrides = this._buildMetaOverrides(_spec?.newMeta, newPath, newName);

        // Resolve a schema-safe embedding before (re)writing the document.
        //
        // Orama's `vector[N]` field is non-nullable: inserting/updating a doc whose
        // `embedding` is null throws "Cannot read properties of null (reading 'length')"
        // inside Orama, which aborts the re-key and leaves the vector entry stale at the
        // old path. Stored docs legitimately carry a null `embedding` because Orama
        // v3.1.x `restore()` loses inline vector data (see `_createOrRestoreDatabase` and
        // the `_embeddingStore` sidecar) — so `existing.embedding` is unreliable. Resolve
        // the vector sidecar-first (the codebase's source of truth) and fall back to a
        // zero-vector placeholder, mirroring the restore/repair paths.
        const sidecarEmbedding = this._embeddingStore?.files?.get(oldId);
        const normalizedEmbedding = this._normalizeEmbeddingVector(
          sidecarEmbedding || existing.embedding,
          this._dimension
        );
        const hasVector =
          Array.isArray(normalizedEmbedding) &&
          !(normalizedEmbedding[0] === 0 && normalizedEmbedding.every((v) => v === 0));
        const safeEmbedding = normalizedEmbedding || new Array(this._dimension).fill(0);

        // If ID changed, insert new then delete old to prevent data loss on insert failure
        if (newId && newId !== oldId) {
          await insert(this._databases.files, {
            ...existing,
            ...metaOverrides,
            id: newId,
            embedding: safeEmbedding,
            hasVector,
            filePath: newPath || existing.filePath,
            fileName: newName || existing.fileName
          });
          await remove(this._databases.files, oldId);

          // Migrate the embedding in the sidecar store. Zero-vector placeholders are
          // intentionally left uncached so the sidecar-repair pass can detect and
          // replace them (matches the restore path's caching policy).
          const embStore = this._embeddingStore?.files;
          if (embStore) {
            if (hasVector) {
              embStore.set(newId, safeEmbedding);
            } else {
              embStore.delete(newId);
            }
            embStore.delete(oldId);
          }
        } else {
          // Just update the path and metadata in-place
          await update(this._databases.files, oldId, {
            ...existing,
            ...metaOverrides,
            embedding: safeEmbedding,
            hasVector,
            filePath: newPath || existing.filePath,
            fileName: newName || existing.fileName
          });

          const embStore = this._embeddingStore?.files;
          if (embStore) {
            if (hasVector) {
              embStore.set(oldId, safeEmbedding);
            } else {
              embStore.delete(oldId);
            }
          }
        }

        this._invalidateCacheForFile(oldId);
        if (newId) this._invalidateCacheForFile(newId);
        updated++;
      } catch (error) {
        logger.warn('[OramaVectorService] Failed to update file path:', {
          oldId: updateSpec?.oldId,
          newId: updateSpec?.newId,
          error: error.message
        });
      }
    }

    this._schedulePersist();
    if (updated > 0) {
      this._emitSearchDataMutated('files', 'update-paths', { count: updated });
    }
    return updated;
  }

  /**
   * Build metadata overrides from newMeta, filtering out internal/id fields
   * and only including non-null values that match the document schema.
   * @private
   * @param {Object|null} newMeta - Metadata from the caller
   * @param {string|null} _newPath - Resolved new path (reserved for future use)
   * @param {string|null} _newName - Resolved new name (reserved for future use)
   * @returns {any} Fields to merge into the document
   */
  _buildMetaOverrides(newMeta, _newPath, _newName) {
    if (!newMeta || typeof newMeta !== 'object') {
      return {};
    }

    // Allowlisted schema fields that callers may update.
    // Excludes 'id', 'embedding', 'hasVector' to prevent accidental overwrites.
    const ALLOWED_META_FIELDS = new Set([
      'fileType',
      'analyzedAt',
      'suggestedName',
      'keywords',
      'tags',
      'isOrphaned',
      'orphanedAt',
      'extractionMethod',
      // Extended metadata from embeddingSync / analysis
      'category',
      'confidence',
      'type',
      'summary',
      'date',
      'entity',
      'project',
      'purpose',
      'reasoning',
      'documentType',
      'keyEntities',
      'extractedText',
      'smartFolder',
      'smartFolderPath',
      'content_type',
      'colors',
      'has_text'
    ]);

    /** @type {Record<string, any>} */
    const overrides = {};
    for (const [key, value] of Object.entries(newMeta)) {
      if (!ALLOWED_META_FIELDS.has(key)) continue;
      if (value === undefined) continue;
      overrides[key] = value;
    }

    return overrides;
  }

  /**
   * Mark embeddings as orphaned
   */
  async markEmbeddingsOrphaned(/** @type {any} */ fileIds) {
    if (this._isShuttingDown || this._writesBlocked) {
      return { marked: 0, failed: 0, skipped: true, reason: 'shutdown' };
    }
    if (!fileIds || fileIds.length === 0) {
      return { marked: 0, failed: 0 };
    }

    await this.initialize();

    let marked = 0;
    let failed = 0;

    for (const id of fileIds) {
      try {
        const existing = await getByID(this._databases.files, id);
        if (existing) {
          await update(this._databases.files, id, {
            ...this._normalizeFileDocForUpdate(existing),
            isOrphaned: true,
            orphanedAt: new Date().toISOString()
          });
          marked++;
        }
      } catch {
        failed++;
      }
    }

    this._schedulePersist();
    if (marked > 0) {
      this._emitSearchDataMutated('files', 'mark-orphaned', { count: marked });
    }
    return { marked, failed };
  }

  /**
   * Undo `markEmbeddingsOrphaned` for rows whose file turned out to exist
   * (F-221): the vector is intact, so the row simply becomes visible to
   * queries again — no re-embed. Ids with no row are reported as `missing`.
   * @param {string[]} fileIds
   * @returns {Promise<{ restored: number, failed: number, missing: number }>}
   */
  async restoreOrphanedEmbeddings(fileIds) {
    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      return { restored: 0, failed: 0, missing: 0 };
    }

    await this.initialize();

    let restored = 0;
    let failed = 0;
    let missing = 0;

    for (const id of fileIds) {
      try {
        const existing = await getByID(this._databases.files, id);
        if (!existing) {
          missing++;
          continue;
        }
        if (!existing.isOrphaned) continue;
        await update(this._databases.files, id, {
          ...this._normalizeFileDocForUpdate(existing),
          isOrphaned: false,
          orphanedAt: ''
        });
        restored++;
      } catch {
        failed++;
      }
    }

    this._schedulePersist();
    if (restored > 0) {
      this._emitSearchDataMutated('files', 'restore-orphaned', { count: restored });
    }
    return { restored, failed, missing };
  }

  /**
   * Get orphaned embeddings
   */
  async getOrphanedEmbeddings(/** @type {any} */ maxAge) {
    await this.initialize();

    // Paginated so installs with >10k orphaned embeddings get a complete
    // cleanup list instead of a silently-truncated prefix.
    const hits = await this._paginatedSearch(
      this._databases.files,
      { term: '', where: { isOrphaned: true } },
      { label: 'get-orphaned-embeddings' }
    );

    if (!maxAge) {
      return hits.map((/** @type {any} */ hit) => hit.document.id);
    }

    const cutoff = Date.now() - maxAge;
    return hits
      .filter((/** @type {any} */ hit) => {
        const orphanedAt = hit.document.orphanedAt;
        if (!orphanedAt) return true;
        return new Date(orphanedAt).getTime() < cutoff;
      })
      .map((/** @type {any} */ hit) => hit.document.id);
  }

  /**
   * Orphan-marked file rows with the path the reaper needs to re-check the
   * disk (F-222). `maxAge` (ms) keeps only rows orphaned at least that long
   * ago; rows without an `orphanedAt` count as old.
   * @param {number} [maxAge]
   * @returns {Promise<Array<{ id: string, path: string, orphanedAt: string }>>}
   */
  async getOrphanedFileDocs(maxAge) {
    await this.initialize();
    const hits = await this._paginatedSearch(
      this._databases.files,
      { term: '', where: { isOrphaned: true } },
      { label: 'get-orphaned-file-docs' }
    );
    const cutoff = maxAge ? Date.now() - maxAge : null;
    return hits
      .map((/** @type {any} */ hit) => hit.document)
      .filter((/** @type {any} */ doc) => {
        if (!doc) return false;
        if (cutoff === null) return true;
        if (!doc.orphanedAt) return true;
        return new Date(doc.orphanedAt).getTime() < cutoff;
      })
      .map((/** @type {any} */ doc) => ({
        id: doc.id,
        path: doc.path || doc.filePath || '',
        orphanedAt: doc.orphanedAt || ''
      }));
  }

  /**
   * Get orphaned chunks (chunks whose parent file no longer exists)
   * @param {any} [_maxAge]
   * @returns {Promise<string[]>}
   */
  async getOrphanedChunks(_maxAge) {
    await this.initialize();

    if (!this._databases.fileChunks) return [];

    // fileChunks schema has no isOrphaned flag, so we find orphans by
    // checking whether each chunk's fileId still exists in the files
    // database. Both scans are paginated so large libraries do not silently
    // miss orphans past the 10k cap.
    const knownFileIds = new Set();
    await this._paginatedSearch(
      this._databases.files,
      { term: '' },
      {
        label: 'orphaned-chunks-known-files',
        onHit: (/** @type {any} */ hit) => {
          if (hit?.document?.id) knownFileIds.add(hit.document.id);
        }
      }
    );

    /** @type {any[]} */
    const orphaned = [];
    await this._paginatedSearch(
      this._databases.fileChunks,
      { term: '' },
      {
        label: 'orphaned-chunks-scan',
        onHit: (/** @type {any} */ hit) => {
          const fileId = hit?.document?.fileId;
          if (!fileId || !knownFileIds.has(fileId)) {
            if (hit?.document?.id) orphaned.push(hit.document.id);
          }
        }
      }
    );

    return orphaned;
  }

  /**
   * Clone a file embedding
   */
  async cloneFileEmbedding(
    /** @type {any} */ sourceId,
    /** @type {any} */ destId,
    /** @type {any} */ newMeta = {}
  ) {
    await this.initialize();

    try {
      const source = /** @type {any} */ (await getByID(this._databases.files, sourceId));
      if (!source) {
        return { success: true, cloned: false };
      }

      const sourceEmb = this._embeddingStore?.files?.get(sourceId);
      const embeddingToClone = this._normalizeEmbeddingVector(
        sourceEmb ?? source.embedding,
        this._dimension
      );
      if (!Array.isArray(embeddingToClone) || embeddingToClone.length !== this._dimension) {
        return {
          success: false,
          cloned: false,
          error: 'Source file has no valid embedding to clone'
        };
      }

      const hasVector = !(embeddingToClone[0] === 0 && embeddingToClone.every((v) => v === 0));

      // Only write fields that exist in the files schema (avoid clonedFrom/clonedAt
      // which are not in the Orama schema and would cause silent drops or errors)
      const { id: _id, ...sourceFields } = source;
      await insert(this._databases.files, {
        ...sourceFields,
        id: destId,
        embedding: embeddingToClone,
        hasVector,
        filePath: newMeta.path || source.filePath,
        fileName: newMeta.fileName || newMeta.name || source.fileName
      });

      // Clone embedding in sidecar store
      if (!this._embeddingStore.files) this._embeddingStore.files = new Map();
      this._embeddingStore.files.set(destId, [...embeddingToClone]);

      this._invalidateCacheForFile(destId);
      this._schedulePersist();
      this._emitSearchDataMutated('files', 'clone', { sourceId, destId });
      return { success: true, cloned: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // ==================== FOLDER OPERATIONS ====================

  /**
   * Upsert a folder embedding
   */
  async upsertFolder(/** @type {any} */ folder) {
    if (!folder.id || !folder.vector || !Array.isArray(folder.vector)) {
      throw new Error('Invalid folder data: missing id or vector');
    }

    if (this._isShuttingDown || this._writesBlocked) {
      return { queued: false, folderId: folder.id, skipped: true, reason: 'shutdown' };
    }

    await this.initialize();
    const valueValidation = this._validateEmbeddingValues(folder.vector, 'folders');
    if (!valueValidation.valid) {
      this.emit('embedding-blocked', {
        type: valueValidation.error,
        folderId: folder.id,
        message: 'Embedding vector contains invalid values.'
      });
      return {
        success: false,
        folderId: folder.id,
        error: valueValidation.error
      };
    }
    const dimValidation = await this.validateEmbeddingDimension(folder.vector, 'folders');
    if (!dimValidation.valid) {
      this.emit('embedding-blocked', {
        type: 'dimension_mismatch',
        folderId: folder.id,
        expectedDim: dimValidation.expectedDim,
        actualDim: dimValidation.actualDim,
        message: 'Embedding model changed. Run "Rebuild Embeddings" to fix.'
      });
      return {
        success: false,
        folderId: folder.id,
        error: 'dimension_mismatch',
        requiresRebuild: true
      };
    }

    // Backward-compatible meta handling:
    // Some callers (legacy services) pass { name, path, description } at the top level.
    // Prefer `meta` when provided, but fall back to top-level fields.
    const meta = folder.meta && typeof folder.meta === 'object' ? folder.meta : {};
    const doc = {
      id: folder.id,
      embedding: folder.vector,
      folderPath: meta.path || meta.folderPath || folder.path || folder.folderPath || '',
      folderName: meta.name || meta.folderName || folder.name || folder.folderName || '',
      description: meta.description || folder.description || '',
      patterns: meta.patterns || folder.patterns || []
    };

    try {
      const existing = await getByID(this._databases.folders, folder.id);
      if (existing) {
        await update(this._databases.folders, folder.id, doc);
      } else {
        await insert(this._databases.folders, doc);
      }
    } catch {
      try {
        await insert(this._databases.folders, doc);
      } catch {
        await update(this._databases.folders, folder.id, doc);
      }
    }

    // Update sidecar embedding store for folders
    if (doc.embedding && doc.embedding.length > 0) {
      if (!this._embeddingStore.folders) this._embeddingStore.folders = new Map();
      this._embeddingStore.folders.set(folder.id, doc.embedding);

      // Prevent unbounded memory growth
      if (this._embeddingStore.folders.size > this._maxEmbeddingStoreSize) {
        const iter = this._embeddingStore.folders.keys();
        const evictedId = iter.next().value;
        this._embeddingStore.folders.delete(evictedId);
      }
    }

    this._invalidateCacheForFolder();
    this._schedulePersist();

    return { success: true, folderId: folder.id };
  }

  /**
   * Batch upsert folders
   */
  async batchUpsertFolders(/** @type {any} */ folders) {
    if (!folders || folders.length === 0) {
      return /** @type {Record<string, any>} */ ({ queued: false, count: 0, skipped: [] });
    }
    if (this._isShuttingDown || this._writesBlocked) {
      return /** @type {Record<string, any>} */ ({
        queued: false,
        count: 0,
        skipped: [],
        reason: 'shutdown'
      });
    }

    await this.initialize();

    // Validate batch dimensions before upserting any items to avoid partial writes
    const dimValidation = this._validateBatchDimensions(folders, 'folders');
    if (!dimValidation.valid && dimValidation.error === 'dimension_mismatch') {
      this.emit('embedding-blocked', {
        type: 'dimension_mismatch',
        fileCount: folders.length,
        expectedDim: dimValidation.expectedDim,
        actualDim: dimValidation.actualDim,
        message: 'Embedding model changed. Run "Rebuild Embeddings" to fix.'
      });
      return {
        success: false,
        count: 0,
        skipped: [],
        failed: folders.map((/** @type {any} */ f) => ({
          id: f.id,
          error: 'dimension_mismatch',
          requiresRebuild: true
        })),
        error: 'dimension_mismatch',
        requiresRebuild: true
      };
    }

    let successCount = 0;
    const skipped = [];
    const failed = [];

    const upsertResults = await this._runBoundedBatch(folders, (/** @type {any} */ folder) =>
      this.upsertFolder(folder)
    );
    for (let i = 0; i < upsertResults.length; i++) {
      const settled = upsertResults[i];
      const folder = folders[i];
      if (settled?.status === 'fulfilled') {
        const result = settled.value;
        if (result?.success !== false) {
          successCount++;
        } else {
          failed.push({
            id: folder.id,
            error: result?.error || 'upsert_failed',
            requiresRebuild: result?.requiresRebuild === true
          });
        }
      } else {
        const error = settled?.reason || new Error('upsert_failed');
        skipped.push({ id: folder.id, error: error.message });
        failed.push({ id: folder.id, error: error.message });
      }
    }

    return {
      queued: false,
      count: successCount,
      skipped,
      failed,
      success: failed.length === 0
    };
  }

  /**
   * Query folders by embedding
   */
  async queryFoldersByEmbedding(/** @type {any} */ embedding, topK = 5) {
    await this.initialize();

    // See querySimilarFiles for rationale: honor topK=0, reject NaN/negative.
    if (!Number.isFinite(topK) || topK < 0) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error(
          `queryFoldersByEmbedding: topK must be a non-negative finite number (got ${topK})`
        )
      );
      err.code = 'INVALID_TOPK';
      throw err;
    }

    // Validate before topK=0 short-circuit so a bad embedding still fails loud.
    this._validateEmbedding(embedding, 'folders');
    if (topK === 0) return [];

    try {
      const limit = this._resolveVectorSearchLimit(topK);
      const result = await searchPreservingStoredVectors(this._databases.folders, {
        mode: 'vector',
        vector: { value: embedding, property: 'embedding' },
        similarity: VECTOR_SEARCH_MIN_SIMILARITY,
        limit
      });
      const rawHitCount = Array.isArray(result?.hits) ? result.hits.length : 0;
      const placeholderHits = Array.isArray(result?.hits)
        ? result.hits.filter((hit) => this._isZeroPlaceholderHit(hit)).length
        : 0;
      const filteredHits = result.hits
        .filter((hit) => !this._isZeroPlaceholderHit(hit))
        .slice(0, topK);
      if (filteredHits.length > 0) {
        getSystemAnalyticsSafe()?.recordPipelineOutcome?.('embedding', 'primary', {
          reason: 'folder_vector_primary_query'
        });
        return filteredHits.map((hit) => ({
          id: hit.document.id,
          score: hit.score,
          distance: 1 - hit.score,
          metadata: {
            path: hit.document.folderPath,
            folderPath: hit.document.folderPath,
            folderName: hit.document.folderName,
            description: hit.document.description,
            patterns: hit.document.patterns
          }
        }));
      }

      const health = await this._ensurePrimaryFolderVectorHealth({
        reason: 'query-empty',
        force: false,
        autoRepair: true
      });

      if (health.primaryHealthy === false) {
        logger.warn(
          '[OramaVectorService] Primary folder vector query unavailable; using fallback scorer',
          { topK, rawHitCount, placeholderHits, health }
        );
        getSystemAnalyticsSafe()?.recordPipelineOutcome?.('embedding', 'fallback', {
          reason: 'folder_vector_primary_unhealthy'
        });
        return await this._fallbackQueryFoldersByEmbedding(embedding, topK);
      }

      if (rawHitCount === 0 || (placeholderHits > 0 && placeholderHits === rawHitCount)) {
        const repairedResults = await this._retryFolderPrimaryQueryAfterRepair(
          embedding,
          topK,
          'query-empty'
        );
        if (Array.isArray(repairedResults) && repairedResults.length > 0) {
          return repairedResults;
        }
      }

      logger.debug(
        '[OramaVectorService] Primary folder vector query returned no hits; using fallback scorer',
        { topK, rawHitCount, placeholderHits }
      );
      getSystemAnalyticsSafe()?.recordPipelineOutcome?.('embedding', 'fallback', {
        reason: 'folder_vector_primary_empty'
      });
      return await this._fallbackQueryFoldersByEmbedding(embedding, topK);
    } catch (error) {
      getSystemAnalyticsSafe()?.recordPipelineOutcome?.('embedding', 'error', {
        reason: error?.message || 'folder_vector_query_failed'
      });
      throw attachErrorCode(error, ERROR_CODES.VECTOR_DB_QUERY_FAILED);
    }
  }

  /**
   * Query folders for a file (gets file embedding first, then queries folders)
   */
  async queryFolders(/** @type {any} */ fileId, topK = 5) {
    await this.initialize();

    // Check cache
    const cacheKey = `folders:${fileId}:${topK}`;
    const cached = this._queryCache.get(cacheKey);
    if (cached) return cached;

    // Get file embedding — prefer sidecar (reliable) over getByID (may be zero-placeholder)
    const sidecarEmb = this._embeddingStore?.files?.get(fileId);
    const file = await getByID(this._databases.files, fileId);
    const embedding = sidecarEmb || file?.embedding;
    if (
      !embedding ||
      embedding.length === 0 ||
      (embedding[0] === 0 && embedding.every((/** @type {any} */ v) => v === 0))
    ) {
      return [];
    }

    const results = await this.queryFoldersByEmbedding(embedding, topK);
    this._queryCache.set(cacheKey, results);
    return results;
  }

  /**
   * Batch query folders for multiple files
   */
  async batchQueryFolders(/** @type {any} */ fileIds, topK = 5) {
    /** @type {Record<string, any>} */
    const results = {};
    for (const fileId of fileIds) {
      results[fileId] = await this.queryFolders(fileId, topK);
    }
    return results;
  }

  /**
   * Get all folders
   */
  async getAllFolders() {
    await this.initialize();

    const hits = await this._paginatedSearch(
      this._databases.folders,
      { term: '' },
      { label: 'get-all-folders' }
    );

    return hits.map((/** @type {any} */ hit) => ({
      id: hit.document.id,
      metadata: {
        path: hit.document.folderPath,
        folderPath: hit.document.folderPath,
        folderName: hit.document.folderName,
        description: hit.document.description,
        patterns: hit.document.patterns
      }
    }));
  }

  /**
   * Delete a folder embedding
   */
  async deleteFolderEmbedding(/** @type {any} */ folderId) {
    if (this._isShuttingDown || this._writesBlocked) {
      return { queued: false, success: false, reason: 'shutdown' };
    }
    await this.initialize();

    try {
      await remove(this._databases.folders, folderId);
      this._embeddingStore?.folders?.delete(folderId);
      this._invalidateCacheForFolder();
      this._schedulePersist();
      return { queued: false, success: true };
    } catch (error) {
      return { queued: false, success: false, error: error.message };
    }
  }

  /**
   * Batch delete folders
   */
  async batchDeleteFolders(/** @type {any} */ folderIds) {
    if (!folderIds || folderIds.length === 0) {
      return { count: 0, queued: false };
    }

    await this.initialize();

    let deleted = 0;
    for (const id of folderIds) {
      try {
        await remove(this._databases.folders, id);
        this._embeddingStore?.folders?.delete(id);
        deleted++;
      } catch {
        // Continue
      }
    }

    this._invalidateCacheForFolder();
    this._schedulePersist();
    return { queued: false, count: deleted };
  }

  /**
   * Reset folders collection
   */
  async resetFolders() {
    await this.initialize();
    this._databases.folders = await create({
      schema: this._schemas.folders,
      components: { tokenizer: ORAMA_TOKENIZER_CONFIG }
    });
    this._collectionDimensions.folders = null;
    this._embeddingStore.folders = new Map();
    this._invalidateCacheForFolder();
    await this.persistAll();
    logger.info('[OramaVectorService] Folders collection reset');
  }

  // ==================== CHUNK OPERATIONS ====================

  /**
   * Batch upsert file chunks
   */
  async batchUpsertFileChunks(/** @type {any} */ chunks) {
    if (!chunks || chunks.length === 0) {
      return 0;
    }
    if (this._isShuttingDown || this._writesBlocked) return 0;

    await this.initialize();

    // Validate first chunk's dimensions
    const firstChunkWithVector = chunks.find(
      (/** @type {any} */ c) => Array.isArray(c.vector) && c.vector.length > 0
    );
    if (firstChunkWithVector) {
      const dimValidation = await this.validateEmbeddingDimension(
        firstChunkWithVector.vector,
        'fileChunks'
      );
      if (!dimValidation.valid && dimValidation.error === 'dimension_mismatch') {
        throw new Error(
          `Chunk embedding dimension mismatch: expected ${dimValidation.expectedDim}, got ${dimValidation.actualDim}. ` +
            `Run "Rebuild Embeddings" to fix.`
        );
      }
    }

    let inserted = 0;
    for (const chunk of chunks) {
      try {
        const content =
          chunk.meta?.content || chunk.meta?.text || chunk.meta?.snippet || chunk.document || '';
        const startOffset =
          typeof chunk.meta?.startOffset === 'number'
            ? chunk.meta.startOffset
            : typeof chunk.meta?.charStart === 'number'
              ? chunk.meta.charStart
              : 0;
        const endOffset =
          typeof chunk.meta?.endOffset === 'number'
            ? chunk.meta.endOffset
            : typeof chunk.meta?.charEnd === 'number'
              ? chunk.meta.charEnd
              : 0;
        const doc = {
          id: chunk.id,
          embedding: chunk.vector,
          fileId: chunk.meta?.fileId || chunk.meta?.parentFileId || '',
          chunkIndex: chunk.meta?.chunkIndex || 0,
          content,
          startOffset,
          endOffset
        };

        try {
          await insert(this._databases.fileChunks, doc);
        } catch {
          await update(this._databases.fileChunks, chunk.id, doc);
        }
        // Sidecar, like files/folders: without it a chunk vector lived only
        // in the Orama doc, which search used to null (see
        // searchPreservingStoredVectors) and restore turns into a placeholder.
        if (Array.isArray(doc.embedding) && doc.embedding.some((v) => v !== 0)) {
          this._chunkVectorStore().set(doc.id, doc.embedding);
        }
        inserted++;
      } catch (error) {
        logger.warn('[OramaVectorService] Failed to upsert chunk:', {
          chunkId: chunk.id,
          error: error.message
        });
      }
    }

    this._schedulePersist();
    if (inserted > 0) {
      this._emitSearchDataMutated('fileChunks', 'batch-upsert', { count: inserted });
    }
    return inserted;
  }

  /**
   * Query similar file chunks
   */
  async querySimilarFileChunks(/** @type {any} */ queryEmbedding, topK = 20) {
    await this.initialize();

    this._validateEmbedding(queryEmbedding, 'fileChunks');

    try {
      const limit = this._resolveVectorSearchLimit(topK);
      const result = await searchPreservingStoredVectors(this._databases.fileChunks, {
        mode: 'vector',
        vector: { value: queryEmbedding, property: 'embedding' },
        similarity: VECTOR_SEARCH_MIN_SIMILARITY,
        limit
      });

      const hits = result.hits.filter((hit) => !this._isZeroPlaceholderHit(hit));
      const mapped = await Promise.all(
        hits.map(async (hit) => {
          const chunkDoc = hit.document || {};
          let parentFile = null;
          if (chunkDoc.fileId) {
            try {
              parentFile = await getByID(this._databases.files, chunkDoc.fileId);
            } catch {
              parentFile = null;
            }
          }
          // Chunks whose parent file record is gone or marked orphaned point
          // at deleted/moved files — surface fresh results in their place.
          if (!parentFile || parentFile.isOrphaned === true) {
            return null;
          }
          const content = chunkDoc.content || '';
          const startOffset =
            typeof chunkDoc.startOffset === 'number' ? chunkDoc.startOffset : undefined;
          const endOffset = typeof chunkDoc.endOffset === 'number' ? chunkDoc.endOffset : undefined;
          return {
            id: chunkDoc.id,
            score: hit.score,
            distance: 1 - hit.score,
            metadata: {
              fileId: chunkDoc.fileId,
              path: parentFile?.filePath || '',
              name: parentFile?.fileName || '',
              type: parentFile?.fileType || 'document',
              chunkIndex: chunkDoc.chunkIndex,
              content,
              snippet: content.slice(0, 240),
              startOffset: startOffset ?? 0,
              endOffset: endOffset ?? 0,
              charStart: startOffset ?? 0,
              charEnd: endOffset ?? 0
            }
          };
        })
      );
      return mapped.filter(Boolean).slice(0, topK);
    } catch (error) {
      throw attachErrorCode(error, ERROR_CODES.VECTOR_DB_QUERY_FAILED);
    }
  }

  /**
   * In-memory sidecar map for chunk vectors (persisted as
   * fileChunks.sidecar.json alongside files/folders). Created on first write
   * when no restore populated it.
   * @private
   * @returns {Map<string, number[]>}
   */
  _chunkVectorStore() {
    if (!(this._embeddingStore.fileChunks instanceof Map)) {
      this._embeddingStore.fileChunks = new Map();
    }
    return this._embeddingStore.fileChunks;
  }

  /**
   * Remove exactly `fileId`'s chunk rows (and their sidecar vectors).
   * Not persisted or announced here; callers do that once per operation.
   * @private
   * @param {string} fileId
   * @param {string} label
   * @returns {Promise<number>} rows removed
   */
  async _removeExactFileChunks(fileId, label) {
    const targets = await this._collectExactFileChunkHits(fileId, label);
    let removed = 0;
    for (const hit of targets) {
      const id = hit.document.id;
      try {
        await remove(this._databases.fileChunks, id);
        removed++;
      } catch {
        // Already gone
      }
      this._embeddingStore?.fileChunks?.delete(id);
    }
    return removed;
  }

  /**
   * Every chunk row that belongs to exactly `fileId`.
   *
   * Orama does not match a `string`-typed property exactly: `where: { fileId }`
   * returns the union over the id's tokens, so it also hands back chunks of
   * other files that share the `file:` prefix or a path segment (often the
   * whole collection). Every chunk operation must go through this exact
   * filter. Read-only pagination: callers that delete collect first, so a
   * page full of other files' chunks can never pin the loop.
   * @private
   * @param {string} fileId
   * @param {string} label
   * @returns {Promise<any[]>} Orama hits whose document.fileId === fileId
   */
  async _collectExactFileChunkHits(fileId, label) {
    if (typeof fileId !== 'string' || !fileId || !this._databases?.fileChunks) return [];
    const hits = await this._paginatedSearch(
      this._databases.fileChunks,
      { term: '', where: { fileId } },
      { label }
    );
    return hits.filter((/** @type {any} */ hit) => hit?.document?.fileId === fileId);
  }

  /**
   * Get all chunks for a file, ordered by chunk index.
   *
   * @param {string} fileId - Parent file id as stored in each chunk's `fileId`
   * @returns {Promise<Array<{chunkIndex: number, text: string, snippet: string}>>}
   */
  async getChunksForFile(fileId) {
    await this.initialize();
    try {
      // Exact filter: search's chunk-context snippets are keyed by chunkIndex,
      // so another file's chunk 3 would otherwise overwrite this file's.
      const hits = await this._collectExactFileChunkHits(fileId, 'get-chunks-for-file');

      const chunks = hits.map((/** @type {any} */ hit) => {
        const doc = hit.document || {};
        return {
          chunkIndex: doc.chunkIndex,
          text: doc.content || '',
          snippet: doc.content || ''
        };
      });

      // Sort by chunk index for ordered context
      chunks.sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));
      return chunks;
    } catch (error) {
      logger.debug('[OramaVectorService] Failed to get chunks for file:', error.message);
      return [];
    }
  }

  /**
   * Delete all chunk rows associated with a parent file embedding id.
   *
   * @param {string} fileId - Parent id prefix (file, image, or path variant as stored in `fileId`)
   * @returns {Promise<number>} Number of chunk documents removed
   */
  async deleteFileChunks(fileId) {
    if (this._isShuttingDown || this._writesBlocked) return 0;
    await this.initialize();

    // Collect the exact rows first, then remove them. The old streaming
    // delete paged with offset pinned at 0; once a page held 1000 other
    // files' chunks (skipped, so never removed) every page was the same
    // page and the target's own chunks were never reached.
    const deleted = await this._removeExactFileChunks(fileId, 'delete-file-chunks');

    this._schedulePersist();
    if (deleted > 0) {
      this._emitSearchDataMutated('fileChunks', 'delete', { fileId, count: deleted });
    }
    return deleted;
  }

  /**
   * Copy every chunk of `sourceId` to `destId` (a move re-keys chunks without
   * re-embedding: the text did not change). Idempotent: a destination chunk
   * that already exists is replaced. Throws when any chunk could not be
   * copied, so FilePathCoordinator keeps the source chunks instead of
   * deleting them and losing that passage.
   */
  async cloneFileChunks(/** @type {any} */ sourceId, /** @type {any} */ destId, _newMeta = {}) {
    await this.initialize();

    const sources = await this._collectExactFileChunkHits(sourceId, 'clone-file-chunks');
    const sourcePrefix = `chunk:${sourceId}:`;
    let cloned = 0;
    let failed = 0;
    for (const hit of sources) {
      try {
        // Orama search() returns null for vector fields; use getByID() for full document
        const fullChunk = await getByID(this._databases.fileChunks, hit.document.id);
        if (!fullChunk) continue;
        const embedding =
          this._embeddingStore?.fileChunks?.get(fullChunk.id) || fullChunk.embedding;
        // A source chunk whose vector is already gone has nothing to carry over.
        if (!Array.isArray(embedding) || embedding.length === 0) continue;

        const newChunkId = fullChunk.id.startsWith(sourcePrefix)
          ? `chunk:${destId}:${fullChunk.id.slice(sourcePrefix.length)}`
          : `chunk:${destId}:${fullChunk.chunkIndex}`;
        if (await getByID(this._databases.fileChunks, newChunkId)) {
          await remove(this._databases.fileChunks, newChunkId);
          this._embeddingStore?.fileChunks?.delete(newChunkId);
        }
        await insert(this._databases.fileChunks, {
          ...fullChunk,
          embedding,
          id: newChunkId,
          fileId: destId
        });
        if (embedding.some((/** @type {number} */ v) => v !== 0)) {
          this._chunkVectorStore().set(newChunkId, embedding);
        }
        cloned++;
      } catch (error) {
        failed++;
        logger.debug('[OramaVectorService] Chunk clone failed', {
          id: hit?.document?.id,
          error: /** @type {any} */ (error)?.message
        });
      }
    }

    this._schedulePersist();
    if (cloned > 0) {
      this._emitSearchDataMutated('fileChunks', 'clone', { sourceId, destId, count: cloned });
    }
    if (failed > 0) {
      throw new Error(
        `cloneFileChunks: ${failed} of ${sources.length} chunks could not be copied from ${sourceId}`
      );
    }
    return { success: true, cloned: cloned > 0, count: cloned };
  }

  /**
   * Reset file chunks collection
   */
  async resetFileChunks() {
    await this.initialize();
    this._databases.fileChunks = await create({
      schema: this._schemas.fileChunks,
      components: { tokenizer: ORAMA_TOKENIZER_CONFIG }
    });
    this._embeddingStore.fileChunks = new Map();
    this._collectionDimensions.fileChunks = null;
    await this.persistAll();
    this._emitSearchDataMutated('fileChunks', 'reset');
    logger.info('[OramaVectorService] File chunks collection reset');
  }

  // ==================== FEEDBACK MEMORY OPERATIONS ====================

  /**
   * Upsert feedback memory
   */
  async upsertFeedbackMemory(/** @type {any} */ { id, vector, metadata = {}, document = '' }) {
    if (!id || !vector || !Array.isArray(vector)) {
      throw new Error('Invalid feedback memory data: missing id or vector');
    }
    if (this._isShuttingDown || this._writesBlocked) {
      return { success: false, feedbackId: id, error: 'shutdown' };
    }

    await this.initialize();
    const valueValidation = this._validateEmbeddingValues(vector, 'feedback');
    if (!valueValidation.valid) {
      this.emit('embedding-blocked', {
        type: valueValidation.error,
        feedbackId: id,
        message: 'Embedding vector contains invalid values.'
      });
      return {
        success: false,
        feedbackId: id,
        error: valueValidation.error
      };
    }
    const dimValidation = await this.validateEmbeddingDimension(vector, 'feedback');
    if (!dimValidation.valid) {
      this.emit('embedding-blocked', {
        type: 'dimension_mismatch',
        feedbackId: id,
        expectedDim: dimValidation.expectedDim,
        actualDim: dimValidation.actualDim,
        message: 'Embedding model changed. Run "Rebuild Embeddings" to fix.'
      });
      return {
        success: false,
        feedbackId: id,
        error: 'dimension_mismatch',
        requiresRebuild: true
      };
    }

    const _meta = /** @type {any} */ (metadata);
    const doc = {
      id,
      embedding: vector,
      text: document,
      feedbackType: _meta.type || '',
      metadata: JSON.stringify(metadata)
    };

    try {
      await insert(this._databases.feedback, doc);
    } catch {
      await update(this._databases.feedback, id, doc);
    }

    this._schedulePersist();
  }

  /**
   * Query feedback memory
   */
  async queryFeedbackMemory(/** @type {any} */ queryEmbedding, topK = 5) {
    await this.initialize();
    this._validateEmbedding(queryEmbedding, 'feedback');

    const totalCount = await count(this._databases.feedback);
    if (totalCount === 0) return [];

    try {
      const limit = this._resolveVectorSearchLimit(topK);
      const result = await searchPreservingStoredVectors(this._databases.feedback, {
        mode: 'vector',
        vector: { value: queryEmbedding, property: 'embedding' },
        similarity: FEEDBACK_MEMORY_MIN_SIMILARITY,
        limit
      });

      return result.hits
        .filter((hit) => !this._isZeroPlaceholderHit(hit))
        .slice(0, topK)
        .map((hit) => {
          let metadata = {};
          try {
            metadata = JSON.parse(hit.document.metadata || '{}');
          } catch (parseError) {
            logger.debug('[OramaVectorService] Malformed feedback metadata', {
              id: hit.document.id,
              error: parseError.message
            });
          }
          return {
            id: hit.document.id,
            score: hit.score,
            metadata,
            document: hit.document.text
          };
        });
    } catch (error) {
      throw attachErrorCode(error, ERROR_CODES.VECTOR_DB_QUERY_FAILED);
    }
  }

  /**
   * Delete feedback memory
   */
  async deleteFeedbackMemory(/** @type {any} */ id) {
    if (this._isShuttingDown || this._writesBlocked) return;
    await this.initialize();
    try {
      await remove(this._databases.feedback, id);
      this._schedulePersist();
    } catch {
      // Ignore
    }
  }

  /**
   * Reset feedback memory
   */
  async resetFeedbackMemory() {
    await this.initialize();
    this._databases.feedback = await create({
      schema: this._schemas.feedback,
      components: { tokenizer: ORAMA_TOKENIZER_CONFIG }
    });
    this._collectionDimensions.feedback = null;
    await this.persistAll();
  }

  // ==================== LEARNING PATTERNS OPERATIONS ====================

  /**
   * Upsert learning patterns
   */
  async upsertLearningPatterns(
    /** @type {any} */ { id, patterns, feedbackHistory, folderUsageStats, lastUpdated }
  ) {
    if (!id) {
      throw new Error('Invalid learning pattern data: missing id');
    }
    if (this._isShuttingDown || this._writesBlocked) return;

    await this.initialize();

    // Use placeholder vector (learning patterns are retrieved by ID, not similarity)
    const dimension =
      this._collectionDimensions.learningPatterns ||
      this._collectionDimensions.files ||
      this._dimension;

    const placeholderVector = new Array(dimension).fill(0);
    placeholderVector[0] = 1;

    const doc = {
      id,
      embedding: placeholderVector,
      document: JSON.stringify({
        patterns: patterns || [],
        feedbackHistory: feedbackHistory || [],
        folderUsageStats: folderUsageStats || []
      }),
      lastUpdated: lastUpdated || new Date().toISOString(),
      patternCount: Array.isArray(patterns) ? patterns.length : 0,
      feedbackCount: Array.isArray(feedbackHistory) ? feedbackHistory.length : 0,
      folderStatsCount: Array.isArray(folderUsageStats) ? folderUsageStats.length : 0
    };

    try {
      await insert(this._databases.learningPatterns, doc);
    } catch {
      await update(this._databases.learningPatterns, id, doc);
    }

    this._schedulePersist();
  }

  /**
   * Get learning patterns
   */
  async getLearningPatterns(/** @type {any} */ id) {
    await this.initialize();

    try {
      const doc = await getByID(this._databases.learningPatterns, id);
      if (!doc) return null;

      const parsed = JSON.parse(doc.document || '{}');
      return {
        id: doc.id,
        patterns: parsed.patterns || [],
        feedbackHistory: parsed.feedbackHistory || [],
        folderUsageStats: parsed.folderUsageStats || [],
        lastUpdated: doc.lastUpdated,
        metadata: {
          patternCount: doc.patternCount,
          feedbackCount: doc.feedbackCount,
          folderStatsCount: doc.folderStatsCount
        }
      };
    } catch {
      return null;
    }
  }

  /**
   * Delete learning patterns
   */
  async deleteLearningPatterns(/** @type {any} */ id) {
    if (this._isShuttingDown || this._writesBlocked) return;
    await this.initialize();
    try {
      await remove(this._databases.learningPatterns, id);
      this._schedulePersist();
    } catch {
      // Ignore
    }
  }

  /**
   * Reset learning patterns
   */
  async resetLearningPatterns() {
    await this.initialize();
    this._databases.learningPatterns = await create({
      schema: this._schemas.learningPatterns,
      components: { tokenizer: ORAMA_TOKENIZER_CONFIG }
    });
    this._collectionDimensions.learningPatterns = null;
    await this.persistAll();
  }

  /**
   * Get a document by ID
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async getDocument(id) {
    await this.initialize();
    try {
      const db = this._databases.files;
      if (!db) return null;
      return await getByID(db, id);
    } catch (error) {
      logger.debug('[OramaVectorService] getDocument lookup failed', {
        id,
        error: error?.message
      });
      return null;
    }
  }

  /**
   * Update tags for a file document
   * @param {string} id - Document ID
   * @param {string[]} tags - New tags
   * @returns {Promise<boolean>}
   */
  async updateDocumentTags(id, tags) {
    if (this._isShuttingDown || this._writesBlocked) return false;
    await this.initialize();

    try {
      const db = this._databases.files;
      if (!db) return false;

      const doc = await getByID(db, id);
      if (!doc) return false;

      // Route through the null-embedding guard like every other per-file
      // update path — a raw spread throws inside Orama's vector validator
      // when the stored embedding was lost (sidecar-restore loss).
      await update(db, id, { ...this._normalizeFileDocForUpdate(doc), tags });

      this._schedulePersist();
      this._emitSearchDataMutated('files', 'update-tags', { fileId: id });
      return true;
    } catch (error) {
      logger.error('[OramaVectorService] Failed to update document tags', { id, error });
      return false;
    }
  }

  // ==================== UTILITY ====================

  /**
   * Reset all collections
   */
  async resetAll() {
    if (this._isResetting) {
      logger.warn('[OramaVectorService] Reset already in progress, skipping');
      return;
    }
    this._isResetting = true;
    try {
      await this._refreshEmbeddingDimension({ reason: 'reset-all' });
      await this.resetFiles();
      await this.resetFileChunks();
      await this.resetFolders();
      await this.resetFeedbackMemory();
      await this.resetLearningPatterns();
      // Clear all sidecar embedding stores
      /** @type {Record<string, any>} */
      this._embeddingStore = {};
      this._setVectorHealth({
        primaryHealthy: true,
        lastValidatedAt: Date.now(),
        lastValidationReason: 'reset-all',
        lastValidationError: null
      });
      this._setFolderVectorHealth({
        primaryHealthy: true,
        lastValidatedAt: Date.now(),
        lastValidationReason: 'reset-all',
        lastValidationError: null
      });
      logger.info('[OramaVectorService] All collections reset');
    } finally {
      this._isResetting = false;
    }
  }

  /**
   * Get statistics
   */
  async getStats() {
    await this.initialize();

    /** @type {Record<string, any>} */
    const counts = {};
    for (const [name, db] of Object.entries(this._databases)) {
      counts[name] = await count(/** @type {any} */ (db));
    }

    const totalDocuments = /** @type {number} */ (
      Object.values(counts).reduce((/** @type {any} */ sum, /** @type {any} */ c) => sum + c, 0)
    );
    return {
      files: counts.files || 0,
      folders: counts.folders || 0,
      fileChunks: counts.fileChunks || 0,
      feedback: counts.feedback || 0,
      learningPatterns: counts.learningPatterns || 0,
      // Aliases expected by IPC vectordb handler
      collections: Object.keys(this._databases).length,
      documents: totalDocuments,
      dbPath: this._dataPath,
      initialized: this._initialized,
      dimension: this._dimension,
      vectorHealth: this._getVectorHealthSnapshot(),
      folderVectorHealth: this._getFolderVectorHealthSnapshot(),
      hydrationDegraded: this._hydrationDegraded ? { ...this._hydrationDegraded } : null,
      queryCache: {
        size: this._queryCache.size,
        maxSize: this._queryCache.maxSize
      }
    };
  }

  /**
   * Single source of truth for "is this file row usable for primary vector
   * search". A row is only usable when it is live (`hasVector`, not orphaned)
   * AND actually carries a real embedding of the right dimension that is not
   * the all-zero placeholder a restore writes for unrecovered documents.
   *
   * Shared by `getFileVectorDiagnostics()` and `hasUsableVector()` so a caller
   * deciding whether to re-embed can never drift from the rule the diagnostics
   * screen reports against.
   *
   * @param {any} doc - A file document as stored in the `files` collection
   * @returns {{hasVector: boolean, isOrphaned: boolean, hasEmbedding: boolean, isPlaceholder: boolean, eligible: boolean}}
   */
  _describeFileVectorEligibility(doc) {
    const hasVector = doc?.hasVector === true;
    const isOrphaned = doc?.isOrphaned === true;
    const embStore = this._embeddingStore?.files;
    const normalizedEmbedding = this._normalizeEmbeddingVector(
      (embStore instanceof Map ? embStore.get(doc?.id) : null) || doc?.embedding,
      this._dimension
    );
    const hasEmbedding =
      Array.isArray(normalizedEmbedding) && normalizedEmbedding.length === this._dimension;
    const isPlaceholder =
      hasEmbedding &&
      normalizedEmbedding[0] === 0 &&
      normalizedEmbedding.every((/** @type {any} */ value) => value === 0);

    return {
      hasVector,
      isOrphaned,
      hasEmbedding,
      isPlaceholder,
      eligible: hasVector && !isOrphaned && hasEmbedding && !isPlaceholder
    };
  }

  /**
   * Does this file id already hold a vector good enough to search with?
   *
   * Callers that backfill (e.g. the `onlyMissing` rebuild) must ask this rather
   * than inspecting `getFile()` fields themselves: a row can have
   * `hasVector: true` and still be unsearchable because its embedding was lost
   * or restored as an all-zero placeholder.
   *
   * @param {string} id - File embedding id
   * @returns {Promise<boolean>} False for unknown ids and unusable rows
   */
  async hasUsableVector(id) {
    if (!id) return false;
    await this.initialize();
    const doc = await this.getFile(id);
    if (!doc) return false;
    return this._describeFileVectorEligibility(doc).eligible;
  }

  /**
   * Whether at least one passage (chunk) row exists for a parent file id.
   * Lets an `onlyMissing` backfill tell "file vector present, passages never
   * built" (the Discover path before chunking was wired in) from "complete".
   * @param {string} fileId
   * @returns {Promise<boolean>}
   */
  async hasFileChunks(fileId) {
    if (!fileId) return false;
    await this.initialize();
    try {
      const hits = await this._collectExactFileChunkHits(fileId, 'has-file-chunks');
      return hits.length > 0;
    } catch (error) {
      logger.debug('[OramaVectorService] hasFileChunks failed:', error.message);
      return false;
    }
  }

  /**
   * Diagnose eligibility for primary file-level vector search.
   * Helps explain cases where file embeddings exist but vector retrieval returns no hits.
   *
   * @param {{ sampleSize?: number }} [options]
   * @returns {Promise<Object>}
   */
  async getFileVectorDiagnostics(options = {}) {
    await this.initialize();

    const sampleSize = Math.max(1, Math.min(Number(options?.sampleSize) || 5, 20));
    const docs = await this._getAllFileDocuments();
    const embStore = this._embeddingStore?.files;
    const sidecarSize = embStore instanceof Map ? embStore.size : 0;

    let hasVectorTrue = 0;
    let hasVectorFalse = 0;
    let orphaned = 0;
    let missingEmbedding = 0;
    let placeholderVectors = 0;
    let eligibleForPrimaryVector = 0;
    const ineligibleSample = [];

    for (const doc of docs) {
      const { hasVector, isOrphaned, hasEmbedding, isPlaceholder, eligible } =
        this._describeFileVectorEligibility(doc);

      if (hasVector) hasVectorTrue++;
      else hasVectorFalse++;
      if (isOrphaned) orphaned++;
      if (!hasEmbedding) missingEmbedding++;
      if (isPlaceholder) placeholderVectors++;

      if (eligible) {
        eligibleForPrimaryVector++;
      } else if (ineligibleSample.length < sampleSize) {
        ineligibleSample.push({
          id: doc?.id,
          hasVector,
          isOrphaned,
          hasEmbedding,
          isPlaceholder
        });
      }
    }

    return {
      totalFiles: docs.length,
      eligibleForPrimaryVector,
      hasVectorTrue,
      hasVectorFalse,
      orphaned,
      missingEmbedding,
      placeholderVectors,
      sidecarEmbeddings: sidecarSize,
      ineligibleSample
    };
  }

  /**
   * Point-in-time copy of primary vector retrieval health for the files
   * collection. SearchService reads this to decide whether fallback cosine
   * scoring is permitted (only while primaryHealthy === false). Mutating the
   * returned object does not affect service state.
   *
   * @returns {{primaryHealthy: boolean|null, lastValidatedAt: number, lastValidationReason: string|null, lastValidationError: string|null, lastRepairAt: number, repairAttempts: number}}
   */
  getVectorHealth() {
    return this._getVectorHealthSnapshot();
  }

  /**
   * Folder-collection counterpart of getVectorHealth(): same snapshot shape
   * and detachment guarantee, tracked independently because folder vectors
   * are validated and repaired on a separate path.
   *
   * @returns {{primaryHealthy: boolean|null, lastValidatedAt: number, lastValidationReason: string|null, lastValidationError: string|null, lastRepairAt: number, repairAttempts: number}}
   */
  getFolderVectorHealth() {
    return this._getFolderVectorHealthSnapshot();
  }

  /**
   * Peek a sample of file embeddings for diagnostics and clustering.
   *
   * Uses the in-memory embedding sidecar store for vectors because Orama's
   * getByID() does not reliably return vector fields after a persist/restore
   * cycle. Text search with term='' enumerates documents.
   *
   * @param {number} [limit=50] - Max number of documents to return
   * @returns {Promise<{ids: string[], embeddings: number[][], metadatas: Object[]}>}
   */
  async peekFiles(limit = 50) {
    await this.initialize();

    try {
      const effectiveLimit = Math.max(1, Math.min(Number(limit) || 50, 10000));
      const result = await searchPreservingStoredVectors(this._databases.files, {
        term: '',
        limit: effectiveLimit,
        where: { isOrphaned: false, hasVector: true }
      });

      const ids = [];
      const embeddings = [];
      const metadatas = [];
      const embStore = this._embeddingStore?.files;

      for (const hit of result.hits || []) {
        const doc = hit.document || {};
        if (doc.isOrphaned === true) {
          continue;
        }
        ids.push(doc.id);

        // Use sidecar embedding store (reliable) instead of getByID (broken for vectors)
        const cachedEmb = embStore?.get(doc.id);
        embeddings.push(cachedEmb && cachedEmb.length > 0 ? cachedEmb : []);

        metadatas.push({
          path: doc.filePath,
          filePath: doc.filePath,
          fileName: doc.fileName,
          fileType: doc.fileType,
          analyzedAt: doc.analyzedAt,
          suggestedName: doc.suggestedName,
          keywords: doc.keywords,
          tags: doc.tags,
          extractionMethod: doc.extractionMethod,
          fileHash: doc.fileHash || '',
          category: doc.category || '',
          date: doc.date || ''
        });
      }

      return { ids, embeddings, metadatas };
    } catch (error) {
      logger.debug('[OramaVectorService] Failed to peek files:', error.message);
      return { ids: [], embeddings: [], metadatas: [] };
    }
  }

  /**
   * Liveness signal for health monitors: true unless primary vector retrieval
   * has been explicitly marked degraded. Unknown (null) counts as healthy —
   * the DB is in-process, so there is no connection that could be down.
   *
   * @returns {Promise<boolean>}
   */
  async checkHealth() {
    return this._vectorHealth.primaryHealthy !== false;
  }

  // ==================== QUERY CACHE ====================

  /**
   * Mark a sidecar-evicted entry in Orama so repair doesn't assume its vector exists.
   * Non-blocking fire-and-forget — eviction is a hot path inside upsertFile.
   */
  _markSidecarEvicted(/** @type {any} */ fileId) {
    if (!this._databases?.files) return;
    (async () => {
      // Orama v3 getByID returns the doc synchronously — the previous
      // `.then()` chain threw a TypeError that propagated up through
      // upsertFile at every sidecar-cap overflow. `await` normalizes
      // sync-or-promise, and the IIFE keeps any failure off the hot path.
      const existing = await getByID(this._databases.files, fileId);
      // Stale-eviction guard: if the id was re-upserted while this task was
      // queued, the sidecar holds a fresh vector again — zeroing the doc now
      // would knock it out of vector search until the next repair pass.
      if (this._embeddingStore.files?.has(fileId)) return;
      if (existing?.hasVector) {
        await update(this._databases.files, fileId, {
          ...existing,
          hasVector: false,
          embedding: Array.from({ length: this._dimension }, () => 0)
        });
      }
    })().catch(() => {
      // Non-fatal: entry may already be removed
    });
  }

  /**
   * Invalidate cache entries related to a specific file.
   * Uses delimiter-aware matching to avoid substring collisions.
   * Cache keys use the format "folders:{fileId}:{topK}".
   */
  _invalidateCacheForFile(/** @type {any} */ fileId) {
    const delimited = `:${fileId}:`;
    const suffix = `:${fileId}`;
    this._queryCache.invalidateWhere(
      (/** @type {any} */ key) => key.includes(delimited) || key.endsWith(suffix) || key === fileId
    );
  }

  /** Invalidate all folder-related cache entries. */
  _invalidateCacheForFolder() {
    this._queryCache.invalidateWhere((/** @type {any} */ key) => key.startsWith('folders:'));
  }

  _clearQueryCache() {
    this._queryCache.clear();
  }

  /**
   * Drop all cached query results so subsequent reads hit Orama directly.
   * Exposed for tests and diagnostics; production invalidation is targeted
   * (per file / per folder) and happens automatically on writes.
   */
  clearQueryCache() {
    this._clearQueryCache();
  }

  /**
   * Hit/miss and occupancy counters from the shared LRU query cache, used to
   * judge whether the 200-entry / 120s-TTL configuration is effective.
   *
   * @returns {any} Stats as reported by LRUCache.getStats()
   */
  getQueryCacheStats() {
    return this._queryCache.getStats();
  }

  // ==================== CLEANUP ====================

  /**
   * Tear down the service without losing data: gates new writes immediately,
   * then runs a bounded final-persist loop that absorbs writes which slipped
   * in mid-persist before clearing in-memory state and broadcasting offline.
   * Idempotent (re-entrance guarded) and never throws — a failed final
   * persist is logged, not propagated, so app quit is never blocked.
   *
   * @returns {Promise<void>}
   */
  async cleanup() {
    // Re-entrance guard: prevent double cleanup from StartupManager + ServiceContainer
    if (this._cleanupInProgress) {
      logger.debug('[OramaVectorService] Cleanup already in progress, skipping');
      return;
    }
    this._cleanupInProgress = true;

    // Gate new writes immediately so the final persist below can stabilize.
    // In-flight writes that already passed the entry guards may still bump
    // _persistPending — the bounded persist loop below absorbs those — but
    // no NEW upserts can enter once this flag is set.
    this._writesBlocked = true;

    // Clear timers first to prevent new debounced persists
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }

    // Final persistence BEFORE setting _isShuttingDown (the guard in _doPersist blocks writes when shutting down)
    if (this._initialized) {
      try {
        // Wait for any in-flight background persist before starting final persist
        if (this._currentPersistPromise) {
          await this._currentPersistPromise;
        }

        // Race guard: writes arriving DURING the await inside _doPersist()
        // call _schedulePersist(), which sets _persistPending=true and
        // schedules a debounced timer. Without a loop here, those late
        // writes get clipped: the scheduled timer is cleared a few lines
        // below, _isShuttingDown becomes true, the in-memory state is
        // wiped — and the late writes never made it to disk. By looping
        // while _persistPending is observed AGAIN after the persist
        // returns, we catch up to a stable point. Bounded by
        // MAX_FINAL_PERSIST_ROUNDS so a chatty consumer can't hang
        // shutdown indefinitely.
        const MAX_FINAL_PERSIST_ROUNDS = 3;
        for (let round = 0; round < MAX_FINAL_PERSIST_ROUNDS; round += 1) {
          this._persistPending = true; // Ensure _doPersist doesn't short-circuit
          await this._doPersist();
          if (!this._persistPending) break;
          logger.warn(
            '[OramaVectorService] Late write detected during final persist; running another round',
            { round: round + 1 }
          );
        }
        if (this._persistPending) {
          logger.error(
            '[OramaVectorService] Final persist did not stabilize after MAX_FINAL_PERSIST_ROUNDS; some writes may not be on disk'
          );
        }
      } catch (error) {
        logger.error('[OramaVectorService] Final persistence failed:', error);
      }
      // Clear any timer the reschedule logic in _doPersist may have created
      // during the final persist (writes arriving mid-persist set _persistPending
      // which triggers a new timer in the finally block).
      if (this._persistTimer) {
        clearTimeout(this._persistTimer);
        this._persistTimer = null;
      }
    }

    this._isShuttingDown = true;
    this.isOnline = false;
    this._broadcastStatus('offline');

    // Clear state
    this._queryCache.clear();
    /** @type {Record<string, any>} */
    this._databases = {};
    this._initialized = false;
    this._initPromise = null;
    this._vectorHealth = {
      primaryHealthy: null,
      lastValidatedAt: 0,
      lastValidationReason: null,
      lastValidationError: null,
      lastRepairAt: 0,
      repairAttempts: 0
    };
    this._vectorHealthPromise = null;

    this.removeAllListeners();
    this._cleanupInProgress = false; // Reset so re-initialization can call cleanup again
    logger.info('[OramaVectorService] Cleanup complete');
  }

  /**
   * Alias for cleanup() so the singleton container's shutdownMethod contract
   * ('shutdown') matches sibling services. Runs the full final-persist and
   * write-gating sequence documented on cleanup().
   *
   * @returns {Promise<void>}
   */
  async shutdown() {
    await this.cleanup();
  }
}

// Singleton helpers
const { getInstance, createInstance, registerWithContainer, resetInstance } =
  createSingletonHelpers({
    ServiceClass: OramaVectorService,
    serviceId: 'ORAMA_VECTOR',
    serviceName: 'OramaVector',
    getContainer: () => require('./ServiceContainer'),
    shutdownMethod: 'shutdown'
  });

module.exports = {
  OramaVectorService,
  getInstance,
  createInstance,
  registerWithContainer,
  resetInstance,
  DEFAULT_EMBEDDING_DIMENSION
};
