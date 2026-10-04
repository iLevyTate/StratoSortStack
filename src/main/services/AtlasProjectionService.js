// @ts-check
'use strict';

/**
 * AtlasProjectionService
 *
 * Owns the latent-space "Atlas" projection: it pulls every file (and folder)
 * embedding from OramaVectorService, projects the high-dim vectors to 2D via
 * UMAP (in a worker_thread), caches the result, and serves it to the renderer
 * in pages.
 *
 * Design notes:
 *  - Raw embeddings never cross IPC. Only 2D coords + short color keys do, and
 *    even those are paged (≤ PAGE_LIMIT) so a large corpus stays under the
 *    preload payload guards (10k array items).
 *  - The projection is cached in memory and on disk, keyed on
 *    `{model, dim, corpusSignature}`. `model`/`dim` come from the persisted
 *    embedding-index metadata, so a model swap — even one that keeps the same
 *    dimension (e.g. nomic-embed → embeddinggemma, both 768) — invalidates the
 *    cache and forces a refit. This is stricter than the store's own restore
 *    check, which only compares dimension.
 *  - While a full embedding rebuild is in flight (`rebuildInProgress`), we serve
 *    a `rebuilding` status instead of a half-populated map.
 *  - Incremental: the worker keeps the fitted model for the session, so when
 *    only new documents appear we `.transform()` just those and append, avoiding
 *    a full refit. Removals or a model change fall back to a full fit.
 */

const path = require('path');
const fs = require('fs').promises;
const EventEmitter = require('events');
const { app } = require('electron');
const { Worker } = require('worker_threads');
const { createLogger } = require('../../shared/logger');
const { atomicWriteFile, loadJsonFile } = require('../../shared/atomicFile');
const { readEmbeddingIndexMetadata } = require('./vectorDb/embeddingIndexMetadata');
const { resolveWorkerPath } = require('../utils/workerPools');
const { findContainingSmartFolder } = require('../../shared/folderUtils');

const logger = createLogger('AtlasProjectionService');

const WORKER_NAME = 'umapProjectionWorker';
const PAGE_LIMIT = 5000;
const FIT_TIMEOUT_MS = Number(process.env.STRATOSORT_ATLAS_FIT_TIMEOUT_MS) || 180000;
const TRANSFORM_TIMEOUT_MS = 60000;

/**
 * @typedef {Object} AtlasCache
 * @property {string} signature
 * @property {string} model
 * @property {number} dim
 * @property {string[]} ids
 * @property {Set<string>} idSet
 * @property {number[]} x
 * @property {number[]} y
 * @property {string[]} folderKeys
 * @property {string[]} categoryKeys
 * @property {string[]} tagKeys
 * @property {string[]} kinds
 * @property {number} builtAt
 */

/** @param {string} filePath @returns {string} */
function parentFolderName(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return '';
  const dir = path.dirname(filePath);
  const base = path.basename(dir);
  return base || dir;
}

const UNCATEGORIZED_KEY = '(uncategorized)';

/**
 * @param {any} value
 * @returns {boolean}
 */
function isUncategorizedLabel(value) {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  return lower === 'uncategorized' || lower === UNCATEGORIZED_KEY;
}

/**
 * The file's semantic home for Atlas colouring.
 *
 * Prefer durable organize truth over stale embedding metadata:
 * 1. Explicit smartFolder (when it is a real folder, not Uncategorized)
 * 2. Smart folder inferred from the file's current path (covers moves where
 *    Orama still has empty/Uncategorized category metadata)
 * 3. AI-assigned category
 * 4. Explicit Uncategorized labels / empty → "(uncategorized)"
 *
 * This is what makes the map legible — points read as
 * "Work / Financial / Research" instead of raw source directories like
 * "Downloads / TEMP".
 * @param {{ smartFolder?: string, category?: string, filePath?: string }} file
 * @param {any[]} [smartFolders]
 * @returns {string}
 */
function semanticCategoryKey(file, smartFolders = []) {
  const smart = typeof file?.smartFolder === 'string' ? file.smartFolder.trim() : '';
  if (smart && !isUncategorizedLabel(smart)) return smart;

  if (Array.isArray(smartFolders) && smartFolders.length > 0 && file?.filePath) {
    const folder = findContainingSmartFolder(file.filePath, smartFolders);
    const inferred = typeof folder?.name === 'string' ? folder.name.trim() : '';
    if (inferred) return inferred;
  }

  const cat = typeof file?.category === 'string' ? file.category.trim() : '';
  if (cat && !isUncategorizedLabel(cat)) return cat;
  if (smart) return smart;
  if (cat) return cat;
  return UNCATEGORIZED_KEY;
}

/**
 * Order-independent hash of an id set (FNV-1a over the sorted, joined ids), so
 * the same corpus yields the same signature regardless of iteration order.
 * @param {string[]} ids
 * @returns {string}
 */
function hashIds(ids) {
  const joined = [...ids].sort().join('\u0000');
  let h = 0x811c9dc5;
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16) + ':' + ids.length;
}

class AtlasProjectionService extends EventEmitter {
  constructor() {
    super();
    /** @type {AtlasCache|null} */
    this._cache = null;
    /** @type {Worker|null} */
    this._worker = null;
    this._workerFitted = false;
    this._nextOpId = 1;
    /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
    this._pending = new Map();
    /** @type {Promise<any>|null} */
    this._buildInFlight = null;
    this._forceQueued = false;
    this._initialized = false;
    this._includeFolders = true;
  }

  /** Lazy one-time setup: load disk cache, subscribe to model-change events. */
  async _init() {
    if (this._initialized) return;
    this._initialized = true;
    try {
      const orama = this._getOrama();
      // A model/dimension change wipes the store and re-embeds; the projection
      // built on the old model's geometry is meaningless, so drop it.
      orama?.on?.('embedding-model-change', () => this.invalidate('embedding-model-change'));
    } catch (err) {
      logger.debug('[Atlas] Could not subscribe to embedding-model-change', {
        error: err?.message
      });
    }
    await this._loadDisk();
  }

  _getOrama() {
    // Resolve the same singleton the IPC handlers use.
    return require('./OramaVectorService').getInstance();
  }

  /**
   * Best-effort smart-folder list for path→category inference on Atlas.
   * Empty on failure so projection still builds without ServiceContainer.
   * @returns {any[]}
   */
  _getSmartFolders() {
    try {
      const { container, ServiceIds } = require('./ServiceContainer');
      if (typeof container?.has === 'function' && !container.has(ServiceIds.LEARNING_FEEDBACK)) {
        return [];
      }
      const lfs =
        typeof container?.tryResolve === 'function'
          ? container.tryResolve(ServiceIds.LEARNING_FEEDBACK)
          : container?.resolve?.(ServiceIds.LEARNING_FEEDBACK);
      const folders = lfs?.getSmartFolders?.();
      return Array.isArray(folders) ? folders : [];
    } catch {
      return [];
    }
  }

  _cachePath() {
    return path.join(app.getPath('userData'), 'atlas', 'projection.json');
  }

  async _loadDisk() {
    try {
      const raw = await loadJsonFile(this._cachePath(), { description: 'atlas projection' });
      if (
        raw &&
        Array.isArray(raw.ids) &&
        Array.isArray(raw.x) &&
        Array.isArray(raw.y) &&
        raw.ids.length === raw.x.length &&
        raw.ids.length === raw.y.length
      ) {
        this._cache = {
          signature: String(raw.signature || ''),
          model: String(raw.model || 'unknown'),
          dim: Number(raw.dim) || 0,
          ids: raw.ids,
          idSet: new Set(raw.ids),
          x: raw.x,
          y: raw.y,
          folderKeys: raw.folderKeys || [],
          categoryKeys: raw.categoryKeys || [],
          tagKeys: raw.tagKeys || [],
          kinds: raw.kinds || [],
          builtAt: Number(raw.builtAt) || 0
        };
        logger.debug('[Atlas] Loaded cached projection from disk', { count: raw.ids.length });
      }
    } catch {
      // No cache yet — fine.
    }
  }

  async _saveDisk() {
    if (!this._cache) return;
    try {
      await fs.mkdir(path.dirname(this._cachePath()), { recursive: true });
      await atomicWriteFile(
        this._cachePath(),
        {
          signature: this._cache.signature,
          model: this._cache.model,
          dim: this._cache.dim,
          ids: this._cache.ids,
          x: this._cache.x,
          y: this._cache.y,
          folderKeys: this._cache.folderKeys,
          categoryKeys: this._cache.categoryKeys,
          tagKeys: this._cache.tagKeys,
          kinds: this._cache.kinds,
          builtAt: this._cache.builtAt
        },
        { pretty: false }
      );
    } catch (err) {
      logger.debug('[Atlas] Failed to persist projection cache', { error: err?.message });
    }
  }

  /**
   * Drop the projection and mark the worker's fitted model stale.
   * @param {string} [reason]
   */
  invalidate(reason) {
    logger.info('[Atlas] Invalidating projection', { reason });
    this._cache = null;
    this._workerFitted = false;
    fs.rm(this._cachePath(), { force: true }).catch(() => {});
  }

  // ---- worker plumbing ----

  _ensureWorker() {
    if (this._worker) return this._worker;
    const workerPath = resolveWorkerPath(WORKER_NAME);
    if (!workerPath) throw new Error(`${WORKER_NAME} bundle not found`);
    const worker = new Worker(workerPath);
    worker.on('message', (/** @type {any} */ msg) => {
      if (msg?.type === 'progress') {
        this.emit('progress', { epoch: msg.epoch });
        return;
      }
      const entry = this._pending.get(msg?.id);
      if (!entry) return;
      this._pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.type === 'error') entry.reject(new Error(msg.error || 'UMAP worker error'));
      else entry.resolve(msg.coords);
    });
    // Identity guards: _terminateWorker nulls _worker before the old worker's
    // exit event fires, so a replacement spawned in the meantime must not have
    // its pending ops failed (or its _worker slot nulled, leaking the thread)
    // by the stale worker's handlers.
    worker.on('error', (err) => {
      if (this._worker !== worker) return;
      this._failAllPending(err);
    });
    worker.on('exit', (code) => {
      if (this._worker !== worker) return;
      if (code !== 0) this._failAllPending(new Error(`UMAP worker exited with code ${code}`));
      this._worker = null;
      this._workerFitted = false;
    });
    this._worker = worker;
    return worker;
  }

  /** @param {any} err */
  _failAllPending(err) {
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this._pending.clear();
    this._workerFitted = false;
  }

  /**
   * @param {{ type: string, vectors: number[][], params?: any, seed?: number }} msg
   * @param {number} timeoutMs
   * @returns {Promise<number[][]>}
   */
  _runWorkerOp(msg, timeoutMs) {
    const worker = this._ensureWorker();
    const id = this._nextOpId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        // A wedged worker can't be trusted for later ops — recycle it.
        this._terminateWorker();
        reject(new Error(`UMAP ${msg.type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this._pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, ...msg });
    });
  }

  _terminateWorker() {
    if (!this._worker) return;
    try {
      this._worker.terminate().catch(() => {});
    } catch {
      /* ignore */
    }
    this._worker = null;
    this._workerFitted = false;
  }

  /**
   * Project all vectors (full fit). Uses the worker; falls back to in-process
   * UMAP if the worker can't be spawned (e.g. asar packaging quirk).
   * @param {number[][]} vectors
   * @returns {Promise<number[][]>}
   */
  async _fitAll(vectors) {
    try {
      this._ensureWorker();
    } catch (err) {
      // Worker can't even be constructed (missing bundle / asar packaging
      // quirk). Only this case may fall back to an in-process fit: re-running
      // a fit that timed out or crashed the worker would block the main
      // thread at least as long, freezing every IPC consumer.
      logger.warn('[Atlas] UMAP worker unavailable; falling back to in-process UMAP', {
        error: err?.message
      });
      this._workerFitted = false;
      return this._fitInProcess(vectors);
    }
    try {
      const coords = await this._runWorkerOp(
        { type: 'fit', vectors, params: {}, seed: 42 },
        FIT_TIMEOUT_MS
      );
      this._workerFitted = true;
      return coords;
    } catch (err) {
      this._workerFitted = false;
      throw err;
    }
  }

  /** @param {number[][]} vectors @returns {Promise<number[][]>} */
  async _fitInProcess(vectors) {
    const n = vectors.length;
    if (n < 3) {
      if (n === 0) return [];
      if (n === 1) return [[0, 0]];
      return vectors.map((_, i) => [
        Math.cos((2 * Math.PI * i) / n),
        Math.sin((2 * Math.PI * i) / n)
      ]);
    }
    const { UMAP } = require('umap-js');
    const model = new UMAP({ nComponents: 2, nNeighbors: Math.max(2, Math.min(15, n - 1)) });
    // Synchronous fit here (blocks the caller) — _fitAll only routes here when
    // the worker can't be constructed at all, never after a timeout/crash, so
    // keeping it simple beats async epoch yields.
    return /** @type {number[][]} */ (model.fit(vectors));
  }

  // ---- projection build ----

  /**
   * Ensure a projection covering the current corpus exists, building or
   * refreshing it as needed. Concurrent callers share one in-flight build.
   * @param {{ force?: boolean }} [opts]
   * @returns {Promise<{ status: string, meta: any }>}
   */
  async ensureProjection({ force = false } = {}) {
    await this._init();
    if (this._buildInFlight) {
      // A forced rebuild must not be silently downgraded to the in-flight
      // normal build (the caller forces because the embedding space changed);
      // queue ONE forced rebuild behind the current build. Further force
      // callers share that queued rebuild — N callers must not enqueue N
      // sequential full UMAP fits.
      if (!force) return this._buildInFlight;
      if (this._forceQueued) return this._buildInFlight;
      this._forceQueued = true;
      const chained = this._buildInFlight
        .catch(() => {})
        .then(() => {
          this._forceQueued = false;
          return this._doEnsure({ force: true });
        })
        .finally(() => {
          if (this._buildInFlight === chained) this._buildInFlight = null;
        });
      this._buildInFlight = chained;
      return chained;
    }
    const build = this._doEnsure({ force }).finally(() => {
      if (this._buildInFlight === build) this._buildInFlight = null;
    });
    this._buildInFlight = build;
    return build;
  }

  /** @param {{ force: boolean }} opts */
  async _doEnsure({ force }) {
    let meta = null;
    try {
      meta = await readEmbeddingIndexMetadata();
    } catch {
      /* metadata is optional */
    }
    if (meta?.rebuildInProgress) {
      return { status: 'rebuilding', meta: this._metaOut(meta) };
    }

    const orama = this._getOrama();
    if (!orama) return { status: 'unavailable', meta: this._metaOut(meta) };
    await orama.initialize?.();

    const files = await orama.getAllFileEmbeddings();
    const folders = this._includeFolders ? await orama.getAllFolderEmbeddings() : [];
    const smartFolders = this._getSmartFolders();
    /** @type {Array<{ id: string, embedding: number[], kind: string, folderKey: string, categoryKey: string, tagKey: string }>} */
    const items = [];
    for (const f of files) {
      const folderName = parentFolderName(f.filePath);
      items.push({
        id: f.id,
        embedding: f.embedding,
        kind: 'file',
        folderKey: folderName,
        categoryKey: semanticCategoryKey(f, smartFolders),
        tagKey: Array.isArray(f.tags) && f.tags.length ? String(f.tags[0]) : ''
      });
    }
    for (const d of folders) {
      const folderName = d.folderName || parentFolderName(d.folderPath);
      items.push({
        id: `folder:${d.id}`,
        embedding: d.embedding,
        kind: 'folder',
        folderKey: folderName,
        // A folder point's own name is its most meaningful bucket in category mode.
        categoryKey: folderName || UNCATEGORIZED_KEY,
        tagKey: ''
      });
    }

    if (items.length === 0) {
      this._cache = null;
      return { status: 'empty', meta: this._metaOut(meta) };
    }

    const dim = items[0].embedding.length;
    const model = String(meta?.model || 'unknown');
    const ids = items.map((i) => i.id);
    const signature = `${model}:${dim}:${hashIds(ids)}`;

    if (!force && this._cache && this._cache.signature === signature) {
      // Coordinates are still valid, but a file's category/folder can change
      // (e.g. after organizing) without changing the id set / signature. Refresh
      // the cheap display keys from current metadata so colours stay honest, and
      // migrate caches persisted before categoryKeys existed. Persist only when
      // something actually changed so paging (many cache-hit calls) doesn't
      // write the disk cache on every page.
      if (this._refreshDisplayKeys(items)) await this._saveDisk();
      return { status: 'ready', meta: this._metaOut(meta) };
    }

    // Incremental: only additions since the fitted cache -> transform + append.
    if (
      !force &&
      this._cache &&
      this._workerFitted &&
      this._cache.model === model &&
      this._cache.dim === dim &&
      this._isSupersetOfCache(ids)
    ) {
      const newItems = items.filter((i) => !this._cache?.idSet.has(i.id));
      if (newItems.length > 0) {
        try {
          const newCoords = await this._runWorkerOp(
            { type: 'transform', vectors: newItems.map((i) => i.embedding) },
            TRANSFORM_TIMEOUT_MS
          );
          this._appendToCache(newItems, newCoords, signature);
          // Refresh keys for pre-existing points too, in case their metadata
          // changed since the last fit.
          this._refreshDisplayKeys(items);
          await this._saveDisk();
          return { status: 'ready', meta: this._metaOut(meta) };
        } catch (err) {
          logger.warn('[Atlas] Incremental transform failed; doing a full refit', {
            error: err?.message
          });
        }
      }
    }

    const coords = await this._fitAll(items.map((i) => i.embedding));
    this._cache = {
      signature,
      model,
      dim,
      ids,
      idSet: new Set(ids),
      x: coords.map((c) => c[0]),
      y: coords.map((c) => c[1]),
      folderKeys: items.map((i) => i.folderKey),
      categoryKeys: items.map((i) => i.categoryKey),
      tagKeys: items.map((i) => i.tagKey),
      kinds: items.map((i) => i.kind),
      builtAt: Date.now()
    };
    await this._saveDisk();
    return { status: 'ready', meta: this._metaOut(meta) };
  }

  /**
   * Rebuild the cheap categorical key arrays (folder / category / tag / kind)
   * in place from the current corpus metadata, aligned to the cached point
   * order. The expensive UMAP coordinates are untouched — only labels/colours
   * are refreshed, so a category change after organizing is reflected without a
   * refit, and caches persisted before `categoryKeys` existed are migrated.
   * @param {Array<{ id: string, kind: string, folderKey: string, categoryKey: string, tagKey: string }>} items
   * @returns {boolean} whether any key actually changed (callers persist only then)
   */
  _refreshDisplayKeys(items) {
    if (!this._cache) return false;
    const byId = new Map(items.map((it) => [it.id, it]));
    const n = this._cache.ids.length;
    const folderKeys = new Array(n);
    const categoryKeys = new Array(n);
    const tagKeys = new Array(n);
    const kinds = new Array(n);
    let changed = this._cache.categoryKeys.length !== n; // migration / length drift
    for (let i = 0; i < n; i++) {
      const it = byId.get(this._cache.ids[i]);
      folderKeys[i] = it ? it.folderKey : this._cache.folderKeys[i] || '';
      categoryKeys[i] = it ? it.categoryKey : this._cache.categoryKeys?.[i] || UNCATEGORIZED_KEY;
      tagKeys[i] = it ? it.tagKey : this._cache.tagKeys[i] || '';
      kinds[i] = it ? it.kind : this._cache.kinds[i] || 'file';
      if (
        !changed &&
        (folderKeys[i] !== this._cache.folderKeys[i] ||
          categoryKeys[i] !== this._cache.categoryKeys[i] ||
          tagKeys[i] !== this._cache.tagKeys[i] ||
          kinds[i] !== this._cache.kinds[i])
      ) {
        changed = true;
      }
    }
    this._cache.folderKeys = folderKeys;
    this._cache.categoryKeys = categoryKeys;
    this._cache.tagKeys = tagKeys;
    this._cache.kinds = kinds;
    return changed;
  }

  /** @param {string[]} ids */
  _isSupersetOfCache(ids) {
    if (!this._cache) return false;
    const set = new Set(ids);
    for (const id of this._cache.ids) {
      if (!set.has(id)) return false; // an id was removed -> not a pure addition
    }
    return true;
  }

  /**
   * @param {Array<{ id: string, kind: string, folderKey: string, categoryKey: string, tagKey: string }>} newItems
   * @param {number[][]} newCoords
   * @param {string} signature
   */
  _appendToCache(newItems, newCoords, signature) {
    if (!this._cache) return;
    for (let i = 0; i < newItems.length; i++) {
      const it = newItems[i];
      const c = newCoords[i] || [0, 0];
      this._cache.ids.push(it.id);
      this._cache.idSet.add(it.id);
      this._cache.x.push(c[0]);
      this._cache.y.push(c[1]);
      this._cache.folderKeys.push(it.folderKey);
      this._cache.categoryKeys.push(it.categoryKey);
      this._cache.tagKeys.push(it.tagKey);
      this._cache.kinds.push(it.kind);
    }
    this._cache.signature = signature;
    this._cache.builtAt = Date.now();
  }

  /** @param {any} meta */
  _metaOut(meta) {
    return {
      model: this._cache?.model || meta?.model || 'unknown',
      dim: this._cache?.dim || meta?.dims || 0,
      count: this._cache?.ids.length || 0,
      builtAt: this._cache?.builtAt || 0
    };
  }

  // ---- public API (used by IPC handlers) ----

  /**
   * Build (if needed) and return a page of the projection.
   * @param {{ offset?: number, limit?: number, force?: boolean }} [opts]
   */
  async getProjectionPage({ offset = 0, limit = PAGE_LIMIT, force = false } = {}) {
    const start = Math.max(0, offset | 0);
    let result;
    if (start > 0 && !force && this._cache) {
      // Follow-up pages of a page-through are served straight from the cache
      // the page-0 ensure built. Re-running ensureProjection per page cost
      // O(pages x corpus) (the full embedding export just to recompute the
      // signature) and could swap the cache to a NEW fit mid-pagination, so
      // the renderer stitched pages from two coordinate spaces. The echoed
      // signature below covers the remaining cross-caller swap case.
      result = { status: 'ready', meta: this._metaOut(null) };
    } else {
      result = await this.ensureProjection({ force });
    }
    if (result.status !== 'ready' || !this._cache) {
      return {
        status: result.status,
        offset: 0,
        total: 0,
        ids: /** @type {string[]} */ ([]),
        x: /** @type {number[]} */ ([]),
        y: /** @type {number[]} */ ([]),
        folderKeys: /** @type {string[]} */ ([]),
        categoryKeys: /** @type {string[]} */ ([]),
        tagKeys: /** @type {string[]} */ ([]),
        kinds: /** @type {string[]} */ ([]),
        meta: result.meta
      };
    }
    const safeLimit = Math.min(Math.max(1, limit | 0), PAGE_LIMIT);
    const end = Math.min(this._cache.ids.length, start + safeLimit);
    return {
      status: 'ready',
      offset: start,
      total: this._cache.ids.length,
      // Fit identity for this page. A renderer accumulating pages restarts
      // when it changes mid-pagination instead of mixing two fits.
      signature: this._cache.signature,
      ids: this._cache.ids.slice(start, end),
      x: this._cache.x.slice(start, end),
      y: this._cache.y.slice(start, end),
      folderKeys: this._cache.folderKeys.slice(start, end),
      categoryKeys: this._cache.categoryKeys.slice(start, end),
      tagKeys: this._cache.tagKeys.slice(start, end),
      kinds: this._cache.kinds.slice(start, end),
      meta: result.meta
    };
  }

  async getStatus() {
    await this._init();
    let meta = null;
    try {
      meta = await readEmbeddingIndexMetadata();
    } catch {
      /* metadata is optional */
    }
    return {
      hasCache: Boolean(this._cache),
      rebuildInProgress: Boolean(meta?.rebuildInProgress),
      ...this._metaOut(meta)
    };
  }

  async rebuild() {
    return this.ensureProjection({ force: true });
  }

  async shutdown() {
    this._terminateWorker();
  }
}

/** @type {AtlasProjectionService|null} */
let _instance = null;

function getInstance() {
  if (!_instance) _instance = new AtlasProjectionService();
  return _instance;
}

function resetInstance() {
  if (_instance) {
    try {
      _instance.shutdown();
    } catch {
      /* ignore */
    }
  }
  _instance = null;
}

module.exports = { AtlasProjectionService, getInstance, resetInstance, PAGE_LIMIT };
