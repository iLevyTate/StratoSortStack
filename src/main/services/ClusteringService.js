// @ts-check
/**
 * ClusteringService - Semantic Clustering with K-means
 *
 * Computes clusters of semantically similar files using K-means clustering
 * on embedding vectors. Generates LLM-based labels for cluster interpretation.
 *
 * @module services/ClusteringService
 */

const { createLogger } = require('../../shared/logger');
const path = require('path');
const fs = require('fs');
const { tryParse: safeJsonTryParse } = require('../../shared/safeJsonOps');
const {
  cosineSimilarity,
  squaredEuclideanDistance,
  validateEmbeddingDimensions
} = require('../../shared/vectorMath');
const { TIMEOUTS } = require('../../shared/performanceConstants');
const { withAbortableTimeout } = require('../../shared/promiseUtils');
const { getTextModel } = require('../llamaUtils');
const { AI_DEFAULTS } = require('../../shared/constants');
const { isInteractiveTextRequestActive } = require('./textModelActivity');
const { FILE_TYPE_CATEGORIES, getFileTypeSingular } = require('./autoOrganize/fileTypeUtils');
const {
  deriveClusterDisplayLabel,
  isGenericClusterLabel
} = require('../../shared/clusterDisplayLabel');

const logger = createLogger('ClusteringService');
const fsPromises = fs.promises;
const SEMANTIC_ID_PREFIX_RE = /^(file|image):/i;
// -----------------------------------------------------------------------------
// Distinctive term extraction (for "topic" insights)
// -----------------------------------------------------------------------------
const STOPWORDS = new Set(
  [
    // Common English stopwords
    'a',
    'an',
    'and',
    'are',
    'as',
    'at',
    'be',
    'but',
    'by',
    'for',
    'from',
    'has',
    'have',
    'he',
    'her',
    'hers',
    'him',
    'his',
    'i',
    'if',
    'in',
    'into',
    'is',
    'it',
    'its',
    'me',
    'my',
    'no',
    'not',
    'of',
    'on',
    'or',
    'our',
    'ours',
    'she',
    'so',
    'that',
    'the',
    'their',
    'theirs',
    'them',
    'then',
    'there',
    'these',
    'they',
    'this',
    'those',
    'to',
    'too',
    'up',
    'us',
    'was',
    'we',
    'were',
    'what',
    'when',
    'where',
    'which',
    'who',
    'why',
    'with',
    'you',
    'your',
    'yours',
    // Generic file/document words (cluster labels often regress to these)
    'file',
    'files',
    'document',
    'documents',
    'image',
    'images',
    'photo',
    'photos',
    'scan',
    'scans',
    'note',
    'notes',
    'report',
    'reports',
    'draft',
    'final',
    'copy',
    'version',
    'v',
    'tmp',
    'temp',
    'misc',
    'miscellaneous',
    'untitled',
    'unknown',
    // Time filler
    'today',
    'yesterday',
    'tomorrow',
    // Extended filler / function words that leak into graph labels from body text
    'also',
    'just',
    'about',
    'more',
    'other',
    'some',
    'such',
    'very',
    'can',
    'will',
    'should',
    'may',
    'might',
    'been',
    'being',
    'had',
    'get',
    'got',
    'all',
    'any',
    'both',
    'each',
    'few',
    'many',
    'most',
    'own',
    'same',
    'out',
    'over',
    'under',
    'again',
    'further',
    'once',
    'here',
    'how',
    'off',
    'only',
    'could',
    'would',
    'shall',
    'must',
    'need',
    'like',
    'well',
    'even',
    'still',
    'back',
    'much',
    'way',
    'new',
    'old',
    'first',
    'last',
    'next',
    'per',
    'via',
    'make',
    'made',
    'use',
    'used',
    'using',
    'one',
    'two',
    'three',
    'page',
    'pages',
    'pdf',
    'doc'
  ].map((w) => String(w).toLowerCase())
);

const FILE_TYPE_STOPWORDS = (() => {
  try {
    const categories = Object.keys(FILE_TYPE_CATEGORIES || {}).map((k) => String(k).toLowerCase());
    const extensions = Object.values(FILE_TYPE_CATEGORIES || {})
      .flatMap((list) => (Array.isArray(list) ? list : []))
      .map((ext) => String(ext).toLowerCase());
    return new Set([...categories, ...extensions]);
  } catch {
    return new Set();
  }
})();

const normalizeSemanticTerm = (/** @type {any} */ value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');

const isMeaningfulSemanticTerm = (/** @type {any} */ term, { minLength = 2 } = {}) => {
  const normalized = normalizeSemanticTerm(term);
  if (!normalized || normalized.length < minLength) return false;
  if (/^\d+$/.test(normalized)) return false;
  if (STOPWORDS.has(normalized)) return false;
  if (FILE_TYPE_STOPWORDS.has(normalized)) return false;
  return true;
};

const toMeaningfulTermList = (
  /** @type {any} */ terms,
  { maxTerms = Infinity, minLength = 2 } = {}
) => {
  if (!Array.isArray(terms) || terms.length === 0) return [];
  const seen = new Set();
  const result = [];
  for (const term of terms) {
    const normalized = normalizeSemanticTerm(term);
    if (!isMeaningfulSemanticTerm(normalized, { minLength })) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= maxTerms) break;
  }
  return result;
};

const stripSemanticIdPrefix = (/** @type {any} */ value) =>
  String(value || '').replace(SEMANTIC_ID_PREFIX_RE, '');

const coerceIndexedPath = (/** @type {any} */ metadata, /** @type {any} */ id) => {
  const metaPath =
    typeof metadata?.path === 'string' && metadata.path.trim()
      ? metadata.path.trim()
      : typeof metadata?.filePath === 'string' && metadata.filePath.trim()
        ? metadata.filePath.trim()
        : '';
  if (metaPath) return metaPath;

  const fromId = stripSemanticIdPrefix(id).trim();
  if (!fromId) return '';
  if (/^[A-Za-z]:[\\/]/.test(fromId) || fromId.startsWith('/') || /[\\/]/.test(fromId)) {
    return fromId;
  }
  return '';
};

const coerceIndexedName = (
  /** @type {any} */ metadata,
  /** @type {any} */ resolvedPath,
  /** @type {any} */ id
) => {
  const metaName =
    typeof metadata?.name === 'string' && metadata.name.trim()
      ? metadata.name.trim()
      : typeof metadata?.fileName === 'string' && metadata.fileName.trim()
        ? metadata.fileName.trim()
        : '';
  if (metaName) return metaName;

  if (resolvedPath) {
    const base = path.basename(resolvedPath);
    if (base && base !== '.' && base !== resolvedPath) return base;
  }

  const fromId = stripSemanticIdPrefix(id).trim();
  if (fromId) {
    const base = path.basename(fromId);
    if (base && base !== '.' && base !== fromId) return base;
  }

  return String(id || '').trim() || 'Indexed file';
};

const normalizeIndexedMetadata = (/** @type {any} */ metadata, /** @type {any} */ id) => {
  const normalized = metadata && typeof metadata === 'object' ? { ...metadata } : {};
  const resolvedPath = coerceIndexedPath(normalized, id);
  const resolvedName = coerceIndexedName(normalized, resolvedPath, id);
  if (resolvedPath) {
    normalized.path = resolvedPath;
    normalized.filePath = resolvedPath;
  }
  if (resolvedName) {
    normalized.name = resolvedName;
    normalized.fileName = resolvedName;
  }
  return normalized;
};

const canAccessPath = async (/** @type {any} */ filePath) => {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) return true;
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
};

/**
 * Default clustering options
 */
const DEFAULT_OPTIONS = {
  maxIterations: 50,
  minClusterSize: 2,
  maxClusters: 15,
  convergenceThreshold: 0.001
};

/**
 * Maximum number of clusters to compute for a user collection
 * Cap to prevent performance degradation on large datasets
 */
const MAX_USER_CLUSTERS = 100;

class ClusteringService {
  /**
   * Create a new ClusteringService instance
   *
   * @param {any} dependencies
   */
  constructor({ vectorDbService, llamaService }) {
    if (!vectorDbService) {
      throw new Error('ClusteringService requires vectorDbService dependency');
    }

    this.vectorDb = vectorDbService;
    this.llama = llamaService;

    /** @type {any[]} */
    this.clusters = [];
    /** @type {any[]} */
    this.centroids = [];
    this.clusterLabels = new Map();
    this.lastComputedAt = null;

    // User-supplied cluster labels (survives recomputation)
    this.userLabels = new Map(); // clusterIdStr -> newLabel

    // Staleness threshold (30 minutes)
    this.STALE_MS = 30 * 60 * 1000;

    // Lock to prevent concurrent cluster computation (race condition fix)
    this._computePromise = null;
  }

  /**
   * Rename a cluster with a user-supplied label.
   * Persists the label to disk so it survives recomputation.
   *
   * @param {string} clusterIdStr - e.g. "cluster:0"
   * @param {string} newLabel - The new label to use
   * @param {string} [labelsFilePath] - Optional path to the labels JSON file
   */
  async renameCluster(clusterIdStr, newLabel, labelsFilePath) {
    if (!clusterIdStr || !newLabel) return;
    this.userLabels.set(clusterIdStr, newLabel);

    // Apply immediately to the in-memory cluster object
    const numericId = parseInt(String(clusterIdStr).replace(/^cluster:/, ''), 10);
    if (!isNaN(numericId)) {
      const cluster = this.clusters.find((c) => c.id === numericId);
      if (cluster) {
        cluster.label = newLabel;
        cluster.labelConfidence = 'high';
      }
      this.clusterLabels.set(numericId, newLabel);
    }

    // Persist to disk (best-effort)
    if (labelsFilePath) {
      try {
        const obj = Object.fromEntries(this.userLabels);
        await fsPromises.writeFile(labelsFilePath, JSON.stringify(obj, null, 2), 'utf8');
        logger.info('[ClusteringService] User labels persisted');
      } catch (e) {
        logger.warn('[ClusteringService] Failed to persist user labels:', e.message);
      }
    }
  }

  /**
   * Load persisted user labels from disk into memory.
   *
   * @param {string} labelsFilePath - Path to the labels JSON file
   */
  async loadUserLabels(labelsFilePath) {
    try {
      const raw = await fsPromises.readFile(labelsFilePath, 'utf8');
      // safeJsonTryParse both guards against __proto__ pollution and
      // distinguishes corrupt content from missing-file errors. Label files
      // live in userData and are written atomically, but a crash mid-write
      // can leave truncated JSON — treat that as empty rather than throwing.
      const parseResult = safeJsonTryParse(raw);
      if (!parseResult.success) {
        logger.warn('[ClusteringService] Discarding corrupt user labels file', {
          error: parseResult.error?.message
        });
        this.userLabels = new Map();
        return;
      }
      const obj =
        parseResult.value &&
        typeof parseResult.value === 'object' &&
        !Array.isArray(parseResult.value)
          ? parseResult.value
          : {};
      this.userLabels = new Map(Object.entries(obj));
      // Apply to any already-loaded clusters
      this.userLabels.forEach((label, idStr) => {
        const numericId = parseInt(String(idStr).replace(/^cluster:/, ''), 10);
        if (!isNaN(numericId)) {
          const cluster = this.clusters.find((c) => c.id === numericId);
          if (cluster) {
            cluster.label = label;
            cluster.labelConfidence = 'high';
          }
          this.clusterLabels.set(numericId, label);
        }
      });
    } catch {
      // File doesn't exist yet — start with empty map
      this.userLabels = new Map();
    }
  }

  /**
   * Invalidate cached clusters (called when files are moved/deleted)
   * Forces recomputation on next access
   */
  invalidateClusters() {
    logger.info('[ClusteringService] Invalidating cached clusters');
    this.lastComputedAt = null;
    // Don't clear clusters/centroids so UI can still show stale data while recomputing
  }

  /**
   * Check if clusters need recomputation
   *
   * @returns {boolean} True if clusters are stale or missing
   */
  isClustersStale() {
    if (this.clusters.length === 0 || !this.lastComputedAt) {
      return true;
    }
    return Date.now() - this.lastComputedAt > this.STALE_MS;
  }

  /**
   * Get all file embeddings from the vector DB
   *
   * @returns {Promise<any[]>}
   */
  async getAllFileEmbeddings() {
    try {
      await this.vectorDb.initialize();

      const MAX_CLUSTERING_EMBEDDINGS = 10000;
      const result = await this.vectorDb.peekFiles(MAX_CLUSTERING_EMBEDDINGS);

      if (!result || !result.ids) {
        logger.warn('[ClusteringService] File collection not available');
        return [];
      }

      if (result.ids.length >= MAX_CLUSTERING_EMBEDDINGS) {
        logger.warn(
          `[ClusteringService] Clustering limited to ${MAX_CLUSTERING_EMBEDDINGS} embeddings. Some files may be excluded from cluster analysis.`
        );
      }

      const files = [];
      const ids = result.ids || [];
      const embeddings = result.embeddings || [];
      const metadatas = result.metadatas || [];

      let expectedDim = null;
      let skippedCount = 0;

      for (let i = 0; i < ids.length; i++) {
        if (embeddings[i] && embeddings[i].length > 0) {
          if (expectedDim === null) {
            expectedDim = embeddings[i].length;
          } else if (!validateEmbeddingDimensions(embeddings[i], expectedDim)) {
            logger.warn('[ClusteringService] Skipping file with mismatched embedding dimension', {
              fileId: ids[i],
              expected: expectedDim,
              actual: embeddings[i].length
            });
            skippedCount++;
            continue;
          }

          files.push({
            id: ids[i],
            embedding: embeddings[i],
            metadata: metadatas[i] || {}
          });
        }
      }

      if (skippedCount > 0) {
        logger.warn('[ClusteringService] Skipped files due to dimension mismatch', {
          skipped: skippedCount,
          kept: files.length,
          expectedDim
        });
      }

      return files;
    } catch (error) {
      logger.error('[ClusteringService] Failed to get file embeddings:', error);
      return [];
    }
  }

  /**
   * Deterministic PRNG (mulberry32). Seeded k-means++ makes cluster output
   * reproducible across runs with the same file set, which:
   *   1) lets the UI label-memo cache hit between reloads instead of
   *      reshuffling cluster numbers, and
   *   2) makes test assertions against cluster assignments stable
   *      (previously two runs on the same fixture could split differently
   *      because Math.random() is process-global and unseeded).
   * Exposed as a method rather than a closure so callers with their own
   * seed strategy (e.g. deterministic integration tests) can replace it.
   * @private
   */
  _makeSeededRandom(/** @type {any} */ seed) {
    let state = (Number.isFinite(seed) ? Math.floor(seed) : 0x9e3779b9) >>> 0;
    return function next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Initialize centroids using K-means++ algorithm
   *
   * @param {any[]} files - Files with embeddings
   * @param {number} k - Number of clusters
   * @param {any} [options]
   * @returns {number[][]}
   */
  initCentroidsPlusPlus(files, k, /** @type {any} */ options = {}) {
    if (files.length === 0 || k <= 0) return [];

    // Derive a default seed from the input shape (file count + first/last
    // ids when available). Callers supplying an explicit seed override it.
    let seed = options.seed;
    if (!Number.isFinite(seed)) {
      const firstId = files[0]?.id ?? '';
      const lastId = files[files.length - 1]?.id ?? '';
      const hashInput = `${files.length}:${firstId}:${lastId}`;
      let h = 2166136261;
      for (let i = 0; i < hashInput.length; i++) {
        h ^= hashInput.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      seed = h >>> 0;
    }
    const random = this._makeSeededRandom(seed);

    const centroids = [];
    const used = new Set();

    // Pick first centroid deterministically (seeded)
    const firstIdx = Math.floor(random() * files.length);
    centroids.push([...files[firstIdx].embedding]);
    used.add(firstIdx);

    // Pick remaining centroids using D^2 weighting
    while (centroids.length < k && centroids.length < files.length) {
      const distances = [];
      let totalDist = 0;

      for (let i = 0; i < files.length; i++) {
        if (used.has(i)) {
          distances.push(0);
          continue;
        }

        // Find minimum squared distance to any existing centroid
        // Using squared distance avoids sqrt() and we need D^2 anyway
        let minDistSq = Infinity;
        for (const centroid of centroids) {
          const distSq = squaredEuclideanDistance(files[i].embedding, centroid);
          if (distSq < minDistSq) minDistSq = distSq;
        }

        distances.push(minDistSq); // D^2 weighting (already squared)
        totalDist += minDistSq;
      }

      // Weighted random selection
      if (totalDist === 0) break;

      let threshold = random() * totalDist;
      let selected = false;
      for (let i = 0; i < files.length; i++) {
        if (used.has(i)) continue;
        threshold -= distances[i];
        if (threshold <= 0) {
          centroids.push([...files[i].embedding]);
          used.add(i);
          selected = true;
          break;
        }
      }

      // Fallback: if weighted selection failed (floating point edge case),
      // select a random unused point to prevent infinite loop
      if (!selected) {
        const unusedIndices = [];
        for (let i = 0; i < files.length; i++) {
          if (!used.has(i)) unusedIndices.push(i);
        }
        if (unusedIndices.length > 0) {
          const randomIdx = unusedIndices[Math.floor(random() * unusedIndices.length)];
          centroids.push([...files[randomIdx].embedding]);
          used.add(randomIdx);
          logger.debug('[ClusteringService] K-means++ used fallback selection');
        }
      }
    }

    return centroids;
  }

  /**
   * Find the nearest centroid for a point
   * Uses squared distance for efficiency (avoids sqrt)
   *
   * @param {number[]} point - Point embedding
   * @param {number[][]} centroids - Current centroids
   * @returns {number} Index of nearest centroid
   */
  nearestCentroid(point, centroids) {
    let minDistSq = Infinity;
    let minIdx = 0;

    for (let i = 0; i < centroids.length; i++) {
      // Use squared distance - avoids sqrt, same comparison result
      const distSq = squaredEuclideanDistance(point, centroids[i]);
      if (distSq < minDistSq) {
        minDistSq = distSq;
        minIdx = i;
      }
    }

    return minIdx;
  }

  /**
   * Update centroids based on current assignments
   * Handles empty clusters by reinitializing them with the farthest point
   *
   * @param {any[]} files - Files with embeddings
   * @param {number[]} assignments - Cluster assignments
   * @param {number[][]} centroids - Current centroids (modified in place)
   */
  updateCentroids(files, assignments, centroids) {
    const dim = centroids[0]?.length || 0;
    if (dim === 0) return;

    const sums = centroids.map(() => new Array(dim).fill(0));
    const counts = new Array(centroids.length).fill(0);

    for (let i = 0; i < files.length; i++) {
      const cluster = assignments[i];
      counts[cluster]++;
      for (let d = 0; d < dim; d++) {
        sums[cluster][d] += files[i].embedding[d];
      }
    }

    const usedForReinit = new Set();

    for (let c = 0; c < centroids.length; c++) {
      if (counts[c] > 0) {
        // Normal case: update centroid to mean of assigned points
        for (let d = 0; d < dim; d++) {
          centroids[c][d] = sums[c][d] / counts[c];
        }
      } else {
        // Empty cluster fix: reinitialize with the point farthest from its assigned centroid
        // This helps the algorithm recover from pathological cases
        let maxDist = -1;
        let farthestIdx = -1;

        for (let i = 0; i < files.length; i++) {
          if (usedForReinit.has(i)) continue;

          const assignedCentroid = centroids[assignments[i]];
          const dist = squaredEuclideanDistance(files[i].embedding, assignedCentroid);
          if (dist > maxDist) {
            maxDist = dist;
            farthestIdx = i;
          }
        }

        if (farthestIdx >= 0) {
          usedForReinit.add(farthestIdx);
          for (let d = 0; d < dim; d++) {
            centroids[c][d] = files[farthestIdx].embedding[d];
          }
          logger.debug(`[ClusteringService] Reinitialized empty cluster ${c} with farthest point`);
        } else {
          logger.warn(`[ClusteringService] Cannot reinitialize cluster ${c}, no available points`);
        }
      }
    }
  }

  /**
   * Check if two arrays are equal
   *
   * @param {number[]} a - First array
   * @param {number[]} b - Second array
   * @returns {boolean} True if equal
   */
  arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * Run K-means clustering
   *
   * @param {any[]} files - Files with embeddings
   * @param {number} k - Number of clusters
   * @param {any} options - Clustering options
   * @returns {{assignments: number[], centroids: number[][]}}
   */
  kmeans(files, k, options = {}) {
    const { maxIterations = DEFAULT_OPTIONS.maxIterations, seed } = options;

    if (files.length === 0 || k <= 0) {
      return { assignments: [], centroids: [] };
    }

    // Clamp k to valid range
    k = Math.min(k, files.length);

    // Initialize centroids with K-means++ (seeded for reproducibility)
    const centroids = this.initCentroidsPlusPlus(files, k, { seed });
    let assignments = new Array(files.length).fill(0);

    for (let iter = 0; iter < maxIterations; iter++) {
      // Assign points to nearest centroid
      const newAssignments = files.map((f) => this.nearestCentroid(f.embedding, centroids));

      // Check convergence
      if (this.arraysEqual(assignments, newAssignments)) {
        logger.debug('[ClusteringService] K-means converged at iteration', iter);
        break;
      }

      assignments = newAssignments;

      // Update centroids
      this.updateCentroids(files, assignments, centroids);
    }

    return { assignments, centroids };
  }

  /**
   * Determine optimal number of clusters using elbow method
   *
   * @param {any[]} files - Files with embeddings
   * @returns {number} Optimal k value
   */
  estimateOptimalK(files) {
    const n = files.length;

    // Simple heuristic: sqrt(n/2) clamped to [2, maxClusters]
    const estimate = Math.ceil(Math.sqrt(n / 2));
    return Math.max(2, Math.min(DEFAULT_OPTIONS.maxClusters, estimate));
  }

  /**
   * Group files by cluster assignment
   *
   * @param {any[]} files - Files with embeddings
   * @param {number[]} assignments - Cluster assignments
   * @returns {any[]} Array of cluster objects
   */
  groupByCluster(files, assignments) {
    const clusterMap = new Map();

    for (let i = 0; i < files.length; i++) {
      const clusterId = assignments[i];
      if (!clusterMap.has(clusterId)) {
        clusterMap.set(clusterId, {
          id: clusterId,
          members: [],
          label: null
        });
      }
      clusterMap.get(clusterId).members.push(files[i]);
    }

    // Filter out small clusters and convert to array
    return Array.from(clusterMap.values()).filter(
      (c) => c.members.length >= DEFAULT_OPTIONS.minClusterSize
    );
  }

  /**
   * Compute semantic clusters of files
   *
   * @param {string|number} k - Number of clusters or 'auto'
   * @returns {Promise<any>}
   */
  async computeClusters(k = 'auto') {
    // Prevent concurrent cluster computation - return existing promise if computing
    if (this._computePromise) {
      logger.debug('[ClusteringService] Cluster computation already in progress, waiting...');
      return this._computePromise;
    }

    this._computePromise = this._doComputeClusters(k);
    try {
      return await this._computePromise;
    } finally {
      this._computePromise = null;
    }
  }

  /**
   * Internal implementation of cluster computation
   * @private
   */
  async _doComputeClusters(/** @type {any} */ k) {
    try {
      logger.info('[ClusteringService] Computing clusters...', { k });

      const files = await this.getAllFileEmbeddings();

      if (files.length < 3) {
        logger.warn('[ClusteringService] Not enough files for clustering');
        return {
          success: false,
          error: 'Need at least 3 files for clustering',
          clusters: [],
          centroids: []
        };
      }

      let numClusters;
      if (k === 'auto') {
        numClusters = this.estimateOptimalK(files);
      } else {
        numClusters = Math.max(2, Math.min(k, files.length, MAX_USER_CLUSTERS));
        if (k > MAX_USER_CLUSTERS) {
          logger.warn(
            `[ClusteringService] Requested ${k} clusters, capped at ${MAX_USER_CLUSTERS}`
          );
        }
      }

      // Run K-means
      const { assignments, centroids } = this.kmeans(files, numClusters);

      // Group files by cluster
      const clusters = this.groupByCluster(files, assignments);

      // Store results
      this.clusters = clusters;
      this.centroids = centroids;
      this.lastComputedAt = Date.now();

      logger.info('[ClusteringService] Clustering complete', {
        files: files.length,
        k: numClusters,
        clusters: clusters.length
      });

      return {
        success: true,
        clusters: clusters.map((c) => ({
          id: c.id,
          memberCount: c.members.length,
          memberIds: c.members.map((/** @type {any} */ m) => m.id),
          label: c.label
        })),
        centroids: centroids.length
      };
    } catch (error) {
      logger.error('[ClusteringService] Clustering failed:', error);
      return /** @type {any} */ ({
        success: false,
        error: error.message,
        clusters: [],
        centroids: []
      });
    }
  }

  /**
   * Helper: Get most frequent item from array
   * @private
   */
  _getMostFrequent(/** @type {any} */ arr) {
    if (!arr || arr.length === 0) return null;
    /** @type {Record<string, number>} */
    const counts = {};
    arr.forEach((/** @type {any} */ item) => {
      if (item) counts[item] = (counts[item] || 0) + 1;
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted.length > 0 ? { item: sorted[0][0], count: sorted[0][1] } : null;
  }

  /**
   * Helper: Get common tags that appear in at least threshold% of items
   * @private
   */
  _getCommonTags(/** @type {any} */ members, threshold = 0.4) {
    const tagCounts = new Map();
    const displayByNormalized = new Map();
    members.forEach((/** @type {any} */ m) => {
      // Parse tags from JSON string if needed
      let tags = m.metadata?.tags || [];
      if (typeof tags === 'string') {
        try {
          tags = JSON.parse(tags);
        } catch {
          tags = [];
        }
      }
      if (Array.isArray(tags)) {
        tags.forEach((tag) => {
          const normalized = normalizeSemanticTerm(tag);
          if (!isMeaningfulSemanticTerm(normalized, { minLength: 2 })) return;
          const display = String(tag || '').trim();
          if (!displayByNormalized.has(normalized)) {
            displayByNormalized.set(normalized, display || normalized);
          }
          tagCounts.set(normalized, (tagCounts.get(normalized) || 0) + 1);
        });
      }
    });

    const minCount = Math.ceil(members.length * threshold);
    return Array.from(tagCounts.entries())
      .filter(([, count]) => count >= minCount)
      .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
      .map(([normalized]) => displayByNormalized.get(normalized) || normalized);
  }

  /**
   * Tokenize and score distinctive "topic" terms for a member.
   *
   * This is intentionally deterministic and bounded. It does not rely on LLM output.
   *
   * @private
   * @param {any} member
   * @returns {{ tokenSet: Set<string>, tokenCounts: Map<string, number> }}
   */
  _extractMemberTermSignals(member) {
    const tokenCounts = new Map();
    const tokenSet = new Set();

    const addTokens = (/** @type {any} */ text, weight = 1) => {
      if (!text) return;
      const s = String(text);
      // Keep extraction bounded to avoid accidental O(N^2) behavior on huge strings.
      const limited = s.length > 5000 ? s.slice(0, 5000) : s;
      const matches = limited.toLowerCase().match(/[a-z0-9]+/g) || [];

      // Cap tokens per field to avoid pathological filenames/tags.
      const MAX_FIELD_TOKENS = 80;
      for (let i = 0; i < matches.length && i < MAX_FIELD_TOKENS; i++) {
        const raw = matches[i];
        if (!isMeaningfulSemanticTerm(raw, { minLength: 3 })) continue;

        // Normalize common underscore/camel artifacts already handled by regex; just keep.
        tokenSet.add(raw);
        tokenCounts.set(raw, (tokenCounts.get(raw) || 0) + weight);
      }
    };

    const meta = member?.metadata || {};
    const name = meta.name || '';
    const subject = meta.subject || '';
    const summary = meta.summary || meta.description || '';
    const category = meta.category || '';

    // Tags are stored as JSON string; normalize to array of strings.
    let tags = meta.tags || [];
    if (typeof tags === 'string' && tags.trim()) {
      try {
        tags = JSON.parse(tags);
      } catch {
        tags = tags.split(',').map((/** @type {any} */ t) => t.trim());
      }
    }
    if (!Array.isArray(tags)) tags = [];

    // Weights (simple, deterministic): tags > subject > summary > name/category.
    addTokens(tags.join(' '), 3);
    addTokens(subject, 2);
    addTokens(summary, 1);
    addTokens(name, 1);
    addTokens(category, 1);

    return { tokenSet, tokenCounts };
  }

  /**
   * Compute TF-IDF-like distinctive terms for a cluster.
   *
   * score(term) = tf(term) * log((N+1)/(df(term)+1))
   *
   * @private
   * @returns {any}
   */
  _buildClusterTermSignalsContext() {
    /** @type {Map<string, any>} */
    const memberSignals = new Map();
    /** @type {Map<string, number>} */
    const globalDf = new Map();

    for (const cluster of this.clusters) {
      const members = Array.isArray(cluster?.members) ? cluster.members : [];
      for (const m of members) {
        const id = m?.id;
        if (!id || typeof id !== 'string') continue;
        if (memberSignals.has(id)) continue;
        const signals = this._extractMemberTermSignals(m);
        memberSignals.set(id, signals);
        for (const term of signals.tokenSet) {
          globalDf.set(term, (globalDf.get(term) || 0) + 1);
        }
      }
    }

    return { memberSignals, globalDf, totalDocs: memberSignals.size };
  }

  _getDistinctiveTermsForCluster(
    /** @type {any} */ cluster,
    /** @type {any} */ termContext,
    maxTerms = 5
  ) {
    if (!cluster || !termContext) return [];
    const members = Array.isArray(cluster.members) ? cluster.members : [];
    if (members.length === 0) return [];
    const { memberSignals, globalDf, totalDocs } = termContext;
    if (!(memberSignals instanceof Map) || totalDocs <= 0) return [];
    return this._computeDistinctiveTermsForCluster(
      members,
      memberSignals,
      globalDf,
      totalDocs,
      maxTerms
    );
  }

  _resolveDescriptiveClusterLabel(/** @type {any} */ cluster, /** @type {any} */ partial = {}) {
    const topTerms =
      partial.topTerms ||
      cluster?.topTerms ||
      this._getDistinctiveTermsForCluster(cluster, partial.termContext, 5);
    return deriveClusterDisplayLabel({
      label: partial.label ?? cluster?.label,
      clusterId: cluster?.id,
      id: cluster?.id,
      topTerms,
      commonTags: partial.commonTags ?? cluster?.commonTags,
      dominantCategory: partial.dominantCategory ?? cluster?.dominantCategory,
      dominantFileCategoryLabel: partial.dominantFileCategoryLabel,
      dominantFolderName: partial.dominantFolderName,
      memberCount: Array.isArray(cluster?.members) ? cluster.members.length : cluster?.memberCount
    });
  }

  _computeDistinctiveTermsForCluster(
    /** @type {any} */ members,
    /** @type {any} */ memberSignals,
    /** @type {any} */ globalDf,
    /** @type {any} */ totalDocs,
    maxTerms = 10
  ) {
    if (!Array.isArray(members) || members.length === 0) return [];
    if (!(globalDf instanceof Map) || !Number.isFinite(totalDocs) || totalDocs <= 0) return [];

    const tf = new Map();
    for (const m of members) {
      const key = m?.id;
      const signals = key ? memberSignals.get(key) : null;
      const counts = signals?.tokenCounts;
      if (!(counts instanceof Map)) continue;
      for (const [term, count] of counts.entries()) {
        tf.set(term, (tf.get(term) || 0) + count);
      }
    }

    const scored = [];
    for (const [term, count] of tf.entries()) {
      const df = globalDf.get(term) || 0;
      const idf = Math.log((totalDocs + 1) / (df + 1));
      const score = count * idf;
      if (!Number.isFinite(score) || score <= 0) continue;
      scored.push({ term, score });
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.term.localeCompare(b.term);
    });

    return scored.slice(0, Math.max(0, Math.min(50, maxTerms))).map((s) => s.term);
  }

  /**
   * Generate a label for a single cluster using LLM
   * Uses metadata as context to help LLM generate better names
   *
   * @private
   * @param {any} cluster - Cluster object with members
   * @param {any} [options]
   */
  async _generateSingleClusterLabel(/** @type {any} */ cluster, /** @type {any} */ options = {}) {
    const { skipLLM = false, termContext = null } = options;
    const members = cluster.members || [];
    if (members.length === 0) {
      return /** @type {Record<string, any>} */ ({
        label: this._resolveDescriptiveClusterLabel(cluster, { termContext }),
        confidence: 'low',
        dominantCategory: null,
        commonTags: []
      });
    }

    // 1. Extract metadata for context (used to enrich LLM prompt)
    const categories = members.map((/** @type {any} */ m) => m.metadata?.category).filter(Boolean);
    const dominantCategoryResult = this._getMostFrequent(categories);
    const dominantCategory = dominantCategoryResult?.item;

    // 2. Extract common tags (appear in >40% of files)
    const commonTags = this._getCommonTags(members, 0.4);

    // 3. Use LLM to generate cluster name (if available and not skipped)
    if (this.llama && !skipLLM) {
      try {
        const fileNames = members
          .slice(0, 8)
          .map((/** @type {any} */ f) => f.metadata?.name || f.id)
          .filter(Boolean)
          .join(', ');

        const subjects = members
          .slice(0, 5)
          .map((/** @type {any} */ f) => f.metadata?.subject)
          .filter(Boolean)
          .join('; ');

        const descriptions = members
          .slice(0, 3)
          .map((/** @type {any} */ f) => f.metadata?.description || f.metadata?.summary)
          .filter(Boolean)
          .join('; ');

        const prompt = `You are naming a cluster of similar files. Generate a concise, descriptive 2-5 word name that captures what these files have in common.

Files in this cluster: ${fileNames}
${subjects ? `Topics/Subjects: ${subjects}` : ''}
${descriptions ? `Descriptions: ${descriptions}` : ''}
${dominantCategory ? `Detected category: ${dominantCategory}` : ''}
${commonTags.length > 0 ? `Common tags: ${commonTags.join(', ')}` : ''}
File count: ${members.length}

Requirements:
- Be specific and descriptive (not generic like "Documents" or "Files")
- Use title case
- 2-5 words maximum
- No quotes or punctuation

Respond with ONLY the cluster name, nothing else.

Examples of good names: "Q4 Financial Reports", "Employee Onboarding Materials", "Product Launch Assets", "Client Meeting Notes", "Marketing Campaign Images"`;

        const response = await withAbortableTimeout(
          (abortController) =>
            this.llama.generateText({
              model: getTextModel() || AI_DEFAULTS.TEXT.MODEL,
              prompt,
              maxTokens: 30,
              signal: abortController.signal
            }),
          TIMEOUTS.AI_ANALYSIS_SHORT,
          'Clustering label generation'
        );

        const label = (response?.response || response || '')
          .trim()
          .replace(/["']/g, '')
          .replace(/^(Cluster|Group|Category|Collection):\s*/i, '')
          .replace(/\.$/, '');

        if (
          label &&
          label.length > 0 &&
          label.length < 60 &&
          !label.toLowerCase().includes('cluster')
        ) {
          return {
            label,
            confidence: 'high',
            reason: 'LLM generated',
            dominantCategory,
            commonTags
          };
        }
      } catch (llmError) {
        logger.warn('[ClusteringService] LLM label generation failed for cluster', {
          clusterId: cluster.id,
          error: llmError.message
        });
      }
    }

    // 4. Fallback to metadata-based labels if LLM unavailable or failed
    if (dominantCategory && commonTags.length > 0) {
      const tagPart = commonTags.slice(0, 2).join(' ');
      return {
        label: `${tagPart} ${dominantCategory}`.trim(),
        confidence: 'medium',
        reason: 'Based on metadata (LLM unavailable)',
        dominantCategory,
        commonTags
      };
    }

    if (dominantCategory) {
      return {
        label: dominantCategory,
        confidence: 'medium',
        reason: 'Based on dominant category (LLM unavailable)',
        dominantCategory,
        commonTags
      };
    }

    if (commonTags.length > 0) {
      return {
        label: commonTags.slice(0, 3).join(', '),
        confidence: 'low',
        reason: 'Based on common tags (LLM unavailable)',
        dominantCategory,
        commonTags
      };
    }

    const topTerms = this._getDistinctiveTermsForCluster(cluster, termContext, 5);
    const descriptiveLabel = this._resolveDescriptiveClusterLabel(cluster, {
      termContext,
      topTerms,
      commonTags,
      dominantCategory
    });

    // 5. Final fallback — distinctive terms / metadata, not opaque "Cluster N"
    return {
      label: descriptiveLabel,
      confidence: isGenericClusterLabel(descriptiveLabel) ? 'low' : 'medium',
      reason: topTerms.length > 0 ? 'Based on distinctive terms' : 'Limited metadata',
      dominantCategory,
      commonTags,
      topTerms
    };
  }

  _getTextQueuePressure() {
    const queueStats =
      this.llama && typeof this.llama.getQueueStats === 'function'
        ? this.llama.getQueueStats()
        : null;
    const textQueue = queueStats?.text || null;
    const pending = Math.max(0, Number(textQueue?.pending) || 0);
    const queued = Math.max(0, Number(textQueue?.queued) || 0);
    const concurrency = Math.max(1, Number(textQueue?.concurrency) || 1);

    return {
      pending,
      queued,
      concurrency,
      busy: queued > 0 || pending >= concurrency
    };
  }

  /**
   * Generate labels for clusters using LLM
   * Uses metadata as context to help LLM generate descriptive names
   * Falls back to metadata-based labels only if LLM is unavailable
   *
   * @param {any} [options]
   * @returns {Promise<any>}
   */
  async generateClusterLabels(options = {}) {
    if (this.clusters.length === 0) {
      return /** @type {any} */ ({ success: false, error: 'No clusters computed yet' });
    }

    const { concurrency = 3, skipLLM = false } = options;
    const chatActive = isInteractiveTextRequestActive();
    const textQueuePressure = this._getTextQueuePressure();
    const memoryAllowsOptionalText =
      typeof this.llama?.canRunOptionalInference === 'function'
        ? this.llama.canRunOptionalInference('text')
        : false;
    const effectiveSkipLLM =
      skipLLM || chatActive || textQueuePressure.busy || !memoryAllowsOptionalText;
    const effectiveConcurrency = Math.max(1, chatActive ? 1 : concurrency);

    try {
      const labels = new Map();
      const termContext = this._buildClusterTermSignalsContext();

      if (chatActive) {
        logger.info('[ClusteringService] Chat stream active, using fast metadata labels', {
          requestedConcurrency: concurrency,
          effectiveConcurrency
        });
      } else if (!skipLLM && textQueuePressure.busy) {
        logger.info('[ClusteringService] Text queue busy, using fast metadata labels', {
          requestedConcurrency: concurrency,
          pending: textQueuePressure.pending,
          queued: textQueuePressure.queued,
          textConcurrency: textQueuePressure.concurrency
        });
      } else if (!skipLLM && !memoryAllowsOptionalText) {
        logger.info(
          '[ClusteringService] Memory budget tight, using fast metadata labels for clusters'
        );
      }

      // Process clusters in batches
      for (let i = 0; i < this.clusters.length; i += effectiveConcurrency) {
        const batch = this.clusters.slice(i, i + effectiveConcurrency);

        const batchResults = await Promise.allSettled(
          batch.map((cluster) =>
            this._generateSingleClusterLabel(cluster, {
              skipLLM: effectiveSkipLLM,
              termContext
            })
          )
        );

        // Process batch results
        batchResults.forEach((result, idx) => {
          const cluster = batch[idx];
          if (result.status === 'fulfilled') {
            const { label, confidence, reason, dominantCategory, commonTags, topTerms } =
              result.value;
            const resolvedTopTerms =
              Array.isArray(topTerms) && topTerms.length > 0
                ? topTerms
                : this._getDistinctiveTermsForCluster(cluster, termContext, 10);
            const resolvedLabel = isGenericClusterLabel(label)
              ? this._resolveDescriptiveClusterLabel(cluster, {
                  termContext,
                  topTerms: resolvedTopTerms,
                  commonTags,
                  dominantCategory
                })
              : label;
            labels.set(cluster.id, resolvedLabel);

            // Update cluster object with rich metadata
            cluster.label = resolvedLabel;
            cluster.labelConfidence = confidence;
            cluster.labelReason = reason;
            cluster.dominantCategory = dominantCategory;
            cluster.commonTags = commonTags || [];
            if (resolvedTopTerms.length > 0) {
              cluster.topTerms = resolvedTopTerms;
            }
          } else {
            const fallbackLabel = this._resolveDescriptiveClusterLabel(cluster, {
              termContext
            });
            labels.set(cluster.id, fallbackLabel);
            cluster.label = fallbackLabel;
            cluster.labelConfidence = 'low';
          }
        });
      }

      this.clusterLabels = labels;

      logger.info('[ClusteringService] Generated labels for clusters', {
        count: labels.size,
        highConfidence: this.clusters.filter((c) => c.labelConfidence === 'high').length,
        mediumConfidence: this.clusters.filter((c) => c.labelConfidence === 'medium').length
      });

      return {
        success: true,
        labels: Object.fromEntries(labels)
      };
    } catch (error) {
      logger.error('[ClusteringService] Label generation failed:', error);
      return /** @type {any} */ ({ success: false, error: error.message });
    }
  }

  /**
   * Get computed clusters for graph visualization
   *
   * @returns {any[]} Clusters with labels, metadata, and member info
   */
  getClustersForGraph() {
    // Precompute global document-frequency across all cluster members so we can
    // compute *distinctive* (not just frequent) terms per cluster.
    const memberSignals = new Map();
    const globalDf = new Map();

    for (const cluster of this.clusters) {
      const members = Array.isArray(cluster?.members) ? cluster.members : [];
      for (const m of members) {
        const id = m?.id;
        if (!id || typeof id !== 'string') continue;
        if (memberSignals.has(id)) continue;
        const signals = this._extractMemberTermSignals(m);
        memberSignals.set(id, signals);
        // Update global DF once per member.
        for (const term of signals.tokenSet) {
          globalDf.set(term, (globalDf.get(term) || 0) + 1);
        }
      }
    }
    const totalDocs = memberSignals.size;

    const parseDateCandidateMs = (/** @type {any} */ value) => {
      if (!value) return null;
      const ms = Date.parse(String(value));
      return Number.isFinite(ms) ? ms : null;
    };

    const getMemberPath = (/** @type {any} */ member) =>
      coerceIndexedPath(member?.metadata || {}, member?.id || '');

    const getParentFolderBaseName = (/** @type {any} */ filePath) => {
      const rawPath = String(filePath || '').trim();
      if (!rawPath) return '';

      // Fast path for platform-native separators.
      const platformDir = path.dirname(rawPath);
      const platformBase = path.basename(platformDir);
      if (platformBase && platformBase !== '.' && platformBase !== path.sep) {
        return platformBase;
      }

      // Cross-platform fallback: treat both slash styles as valid separators.
      const normalized = rawPath.replace(/\\/g, '/').replace(/\/+$/g, '');
      if (!normalized) return '';

      const segments = normalized.split('/').filter(Boolean);
      if (segments.length < 2) return '';

      const parent = segments[segments.length - 2];
      // Ignore bare drive designators ("C:") as folder labels.
      if (/^[A-Za-z]:$/.test(parent)) return '';
      return parent || '';
    };

    const getExtensionKey = (/** @type {any} */ filePath) => {
      const ext = (path.extname(String(filePath || '')) || '').toLowerCase();
      return ext.replace(/^\./, '');
    };

    const getFileCategoryKey = (/** @type {any} */ extKey) => getFileTypeSingular(extKey);

    const getFileCategoryLabel = (/** @type {any} */ categoryKey) => {
      switch (categoryKey) {
        case 'document':
          return 'Document';
        case 'spreadsheet':
          return 'Spreadsheet';
        case 'presentation':
          return 'Presentation';
        case 'image':
          return 'Image';
        case 'video':
          return 'Video';
        case 'audio':
          return 'Audio';
        case 'code':
          return 'Code';
        case 'archive':
          return 'Archive';
        case 'design':
          return 'Design';
        case 'model':
          return '3D Model';
        default:
          return 'Other';
      }
    };

    const getMostFrequentKey = (/** @type {any} */ items) => {
      const counts = new Map();
      for (const item of items) {
        const key = String(item || '').trim();
        if (!key) continue;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      let bestKey = null;
      let bestCount = 0;
      for (const [key, count] of counts.entries()) {
        if (count > bestCount) {
          bestKey = key;
          bestCount = count;
        }
      }
      return bestKey;
    };

    const getMemberTimestampMs = (/** @type {any} */ member) => {
      const meta = member?.metadata || {};
      // Prefer document dates; fall back to index/analysis time (always present on Orama docs).
      return (
        parseDateCandidateMs(meta.documentDate) ??
        parseDateCandidateMs(meta.date) ??
        parseDateCandidateMs(meta.modified) ??
        parseDateCandidateMs(meta.updatedAt) ??
        parseDateCandidateMs(meta.analyzedAt) ??
        (Number.isFinite(meta.mtimeMs) ? meta.mtimeMs : null) ??
        null
      );
    };

    return this.clusters.map((c) => {
      const memberIds = c.members.map((/** @type {any} */ m) => m.id);

      // Derive a dominant file-category bucket for "Type (file category)" clustering in UI.
      const fileCategoryKeys = c.members.map((/** @type {any} */ m) =>
        getFileCategoryKey(getExtensionKey(getMemberPath(m)))
      );
      const dominantFileCategoryKey = getMostFrequentKey(fileCategoryKeys) || 'other';

      // Derive a dominant folder label for "Tag/Folder" clustering in UI.
      // Use parent directory base name to avoid leaking full paths into cluster labels.
      const parentFolderNames = c.members
        .map((/** @type {any} */ m) => {
          const p = getMemberPath(m);
          if (!p) return '';
          return getParentFolderBaseName(p);
        })
        .filter(Boolean);
      const dominantFolderName = getMostFrequentKey(parentFolderNames) || null;

      // Derive a time range from member metadata when available.
      const memberTimestamps = c.members
        .map((/** @type {any} */ m) => getMemberTimestampMs(m))
        .filter((/** @type {any} */ ms) => Number.isFinite(ms));
      const timeRange =
        memberTimestamps.length > 0
          ? (() => {
              // Avoid spread operator to prevent stack overflow for large clusters
              let startMs = memberTimestamps[0];
              let endMs = memberTimestamps[0];
              for (let t = 1; t < memberTimestamps.length; t++) {
                if (memberTimestamps[t] < startMs) startMs = memberTimestamps[t];
                if (memberTimestamps[t] > endMs) endMs = memberTimestamps[t];
              }
              return {
                start: new Date(startMs).toISOString(),
                end: new Date(endMs).toISOString(),
                startMs,
                endMs
              };
            })()
          : null;

      // Distinctive terms used for cluster explanation and bridge “why”.
      const topTerms = this._computeDistinctiveTermsForCluster(
        c.members,
        memberSignals,
        globalDf,
        totalDocs,
        10
      );
      if (!c.topTerms || c.topTerms.length === 0) {
        c.topTerms = topTerms;
      }

      const storedLabel =
        this.userLabels.get(`cluster:${c.id}`) || c.label || this.clusterLabels.get(c.id) || '';

      return {
        id: `cluster:${c.id}`,
        clusterId: c.id,
        label: deriveClusterDisplayLabel({
          label: storedLabel,
          clusterId: c.id,
          topTerms,
          commonTags: c.commonTags || [],
          dominantCategory: c.dominantCategory || null,
          dominantFileCategoryLabel: getFileCategoryLabel(dominantFileCategoryKey),
          dominantFolderName,
          memberCount: c.members.length
        }),
        memberCount: c.members.length,
        memberIds,
        // Rich metadata for meaningful display
        confidence: c.labelConfidence || 'low',
        reason: c.labelReason || '',
        dominantCategory: c.dominantCategory || null,
        commonTags: c.commonTags || [],
        topTerms,
        // Additional metadata for renderer-side cluster modes
        dominantFileCategory: dominantFileCategoryKey,
        dominantFileCategoryLabel: getFileCategoryLabel(dominantFileCategoryKey),
        dominantFolderName,
        timeRange,
        memberMeta: c.members.map((/** @type {any} */ member) => {
          const memberPath = getMemberPath(member);
          const fileCategoryKey = getFileCategoryKey(getExtensionKey(memberPath));
          let primaryTag = null;
          let tags = member?.metadata?.tags || [];
          if (typeof tags === 'string') {
            try {
              tags = JSON.parse(tags);
            } catch {
              tags = [];
            }
          }
          if (Array.isArray(tags) && tags.length > 0) {
            primaryTag = String(tags[0] || '').trim() || null;
          }
          return {
            id: member.id,
            timeMs: getMemberTimestampMs(member),
            fileCategory: fileCategoryKey,
            fileCategoryLabel: getFileCategoryLabel(fileCategoryKey),
            folderName: memberPath ? getParentFolderBaseName(memberPath) : null,
            primaryTag
          };
        })
      };
    });
  }

  /**
   * Get members of a specific cluster with fresh metadata from the vector DB
   *
   * @param {number} clusterId - Cluster ID
   * @returns {Promise<any[]>}
   */
  async getClusterMembers(clusterId) {
    const cluster = this.clusters.find((c) => c.id === clusterId);
    if (!cluster) return [];

    const memberIds = cluster.members.map((/** @type {any} */ m) => m.id);
    const buildMembers = (/** @type {any} */ freshMetadata = null) =>
      cluster.members.map((/** @type {any} */ member) => ({
        id: member.id,
        metadata: normalizeIndexedMetadata(
          (freshMetadata && freshMetadata.get(member.id)) || member.metadata || {},
          member.id
        )
      }));

    const filterMissingMembers = async (/** @type {any} */ members) => {
      const settled = await Promise.allSettled(
        members.map(async (/** @type {any} */ member) => {
          const resolvedPath = coerceIndexedPath(member?.metadata || {}, member?.id || '');
          const exists = await canAccessPath(resolvedPath);
          return { member, exists };
        })
      );
      const checks = settled.map((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        logger.debug('[ClusteringService] Member path check failed', {
          clusterId,
          index: i,
          reason: r.reason?.message || String(r.reason)
        });
        return { member: members[i], exists: false };
      });
      const existingMembers = checks.filter((item) => item.exists).map((item) => item.member);
      const missingCount = checks.length - existingMembers.length;
      if (missingCount > 0) {
        logger.info('[ClusteringService] Filtered missing cluster members', {
          clusterId,
          removed: missingCount,
          total: checks.length
        });
      }
      return existingMembers;
    };

    // Fetch fresh metadata from the vector DB to get current file paths/names
    try {
      await this.vectorDb.initialize();

      // Batch-fetch fresh metadata via individual getFile() calls
      const freshMetadata = new Map();
      await Promise.allSettled(
        memberIds.map(async (/** @type {any} */ id) => {
          try {
            const doc = await this.vectorDb.getFile(id);
            if (doc) {
              freshMetadata.set(id, {
                path: doc.filePath,
                filePath: doc.filePath,
                name: doc.fileName,
                fileName: doc.fileName,
                fileType: doc.fileType,
                model: doc.extractionMethod || 'unknown'
              });
            }
          } catch {
            // Individual fetch failure is non-critical
          }
        })
      );

      if (freshMetadata.size === 0) {
        logger.warn('[ClusteringService] Vector DB returned no results, using cached metadata');
        return await filterMissingMembers(buildMembers());
      }

      // Return members with fresh metadata (current paths and names)
      return await filterMissingMembers(buildMembers(freshMetadata));
    } catch (error) {
      logger.warn('[ClusteringService] Failed to fetch fresh metadata, using cached:', error);
      // Fallback to cached metadata
      return await filterMissingMembers(buildMembers());
    }
  }

  /**
   * Select a representative subset of members to avoid heavy computations.
   * Uses similarity to the cluster's own centroid to pick the most central items.
   *
   * @private
   * @param {any[]} members - Cluster members with embeddings
   * @param {Array<number>} centroid - Cluster centroid embedding
   * @param {number} maxCandidates - Max candidates to return
   * @returns {any[]} Representative member subset
   */
  _selectBridgeCandidates(members, centroid, maxCandidates) {
    if (!Array.isArray(members) || members.length === 0) return [];
    if (!Array.isArray(centroid) || centroid.length === 0) return [];

    if (members.length <= maxCandidates) {
      return members;
    }

    const scored = [];
    for (const member of members) {
      const vector = member?.embedding;
      if (!Array.isArray(vector) || vector.length !== centroid.length) continue;
      const sim = cosineSimilarity(vector, centroid);
      scored.push({ member, sim });
    }

    scored.sort((a, b) => b.sim - a.sim);
    return scored.slice(0, maxCandidates).map((entry) => entry.member);
  }

  /**
   * Build bridge file samples between two clusters.
   * Picks top files from each cluster that are most similar to the other cluster's centroid.
   *
   * @private
   * @param {any} clusterA
   * @param {any} clusterB
   * @param {Array<number>} centroidA
   * @param {Array<number>} centroidB
   * @param {any} options
   * @returns {Promise<any[]>}
   */
  async _buildBridgeFilesForEdge(
    /** @type {any} */ clusterA,
    /** @type {any} */ clusterB,
    /** @type {any} */ centroidA,
    /** @type {any} */ centroidB,
    /** @type {any} */ options
  ) {
    const {
      maxBridgeFilesPerCluster = 3,
      maxCandidatesPerCluster = 50,
      minBridgeSimilarity = 0.55
    } = options || {};

    if (!clusterA || !clusterB) return [];
    if (!Array.isArray(centroidA) || !Array.isArray(centroidB)) return [];
    const pathExistsCache = new Map();
    const pathExists = async (/** @type {any} */ candidatePath) => {
      if (typeof candidatePath !== 'string' || candidatePath.trim().length === 0) return true;
      if (pathExistsCache.has(candidatePath)) return pathExistsCache.get(candidatePath);
      let exists;
      try {
        await fs.promises.access(candidatePath);
        exists = true;
      } catch {
        exists = false;
      }
      pathExistsCache.set(candidatePath, exists);
      return exists;
    };

    const candidatesA = this._selectBridgeCandidates(
      clusterA.members,
      centroidA,
      maxCandidatesPerCluster
    );
    const candidatesB = this._selectBridgeCandidates(
      clusterB.members,
      centroidB,
      maxCandidatesPerCluster
    );

    const pickTop = async (
      /** @type {any} */ candidates,
      /** @type {any} */ otherCentroid,
      /** @type {any} */ clusterId
    ) => {
      const scored = [];
      for (const member of candidates) {
        const vector = member?.embedding;
        if (!Array.isArray(vector) || vector.length !== otherCentroid.length) continue;
        const sim = cosineSimilarity(vector, otherCentroid);
        if (sim < minBridgeSimilarity) continue;
        const normalizedMeta = normalizeIndexedMetadata(member?.metadata || {}, member?.id || '');
        const resolvedPath = coerceIndexedPath(normalizedMeta, member?.id || '');
        if (resolvedPath && !(await pathExists(resolvedPath))) continue;
        const resolvedName = coerceIndexedName(normalizedMeta, resolvedPath, member?.id || '');
        scored.push({
          id: member.id,
          name: resolvedName,
          path: resolvedPath || null,
          similarity: Math.round(sim * 100) / 100,
          clusterId: `cluster:${clusterId}`
        });
      }
      scored.sort((a, b) => b.similarity - a.similarity);
      return scored.slice(0, maxBridgeFilesPerCluster);
    };

    const bridgeSettled = await Promise.allSettled([
      pickTop(candidatesA, centroidB, clusterA.id),
      pickTop(candidatesB, centroidA, clusterB.id)
    ]);
    const topA = bridgeSettled[0].status === 'fulfilled' ? bridgeSettled[0].value : [];
    const topB = bridgeSettled[1].status === 'fulfilled' ? bridgeSettled[1].value : [];
    bridgeSettled.forEach((r, i) => {
      if (r.status === 'rejected') {
        logger.debug('[ClusteringService] pickTop failed for bridge files', {
          index: i,
          reason: r.reason?.message || String(r.reason)
        });
      }
    });

    return [...topA, ...topB];
  }

  /**
   * Find cross-cluster edges based on centroid similarity
   *
   * @param {number} threshold
   * @param {any} [options]
   * @returns {Promise<any[]>}
   */
  async findCrossClusterEdges(threshold = 0.6, /** @type {any} */ options = {}) {
    const {
      includeBridgeFiles = true,
      maxBridgeFilesPerCluster = 3,
      maxCandidatesPerCluster = 50,
      minBridgeSimilarity = Math.max(0.5, threshold - 0.1)
    } = options;
    const edges = [];

    // Build a set of cluster IDs that actually exist (some may have been filtered)
    const existingClusterIds = new Set(this.clusters.map((c) => c.id));

    for (let i = 0; i < this.centroids.length; i++) {
      // Skip centroids whose clusters were filtered out (below minClusterSize)
      if (!existingClusterIds.has(i)) continue;

      for (let j = i + 1; j < this.centroids.length; j++) {
        if (!existingClusterIds.has(j)) continue;

        const similarity = cosineSimilarity(this.centroids[i], this.centroids[j]);

        if (similarity >= threshold) {
          const clusterA = this.clusters.find((c) => c.id === i);
          const clusterB = this.clusters.find((c) => c.id === j);

          const pickTerms = (/** @type {any} */ cluster) => {
            const t =
              Array.isArray(cluster?.topTerms) && cluster.topTerms.length > 0
                ? cluster.topTerms
                : Array.isArray(cluster?.commonTags) && cluster.commonTags.length > 0
                  ? cluster.commonTags
                  : [];
            return toMeaningfulTermList(t, { maxTerms: 20, minLength: 2 });
          };

          const termsA = pickTerms(clusterA);
          const termsB = pickTerms(clusterB);
          const termsBSet = new Set(termsB.map((t) => t.toLowerCase()));
          const sharedTerms = [];
          for (const t of termsA) {
            if (termsBSet.has(t.toLowerCase())) {
              sharedTerms.push(t);
              if (sharedTerms.length >= 3) break;
            }
          }

          /** @type {Record<string, any>} */
          const edge = {
            source: `cluster:${i}`,
            target: `cluster:${j}`,
            similarity,
            type: 'cross_cluster',
            sharedTerms
          };

          if (includeBridgeFiles) {
            const bridgeFiles = await this._buildBridgeFilesForEdge(
              clusterA,
              clusterB,
              this.centroids[i],
              this.centroids[j],
              {
                maxBridgeFilesPerCluster,
                maxCandidatesPerCluster,
                minBridgeSimilarity
              }
            );
            edge.bridgeFiles = bridgeFiles;
            edge.count = bridgeFiles.length;
          }

          edges.push(edge);
        }
      }
    }

    return edges;
  }

  /**
   * Clear cached clusters
   */
  clearClusters() {
    this.clusters = [];
    this.centroids = [];
    this.clusterLabels.clear();
    this.lastComputedAt = null;
    logger.info('[ClusteringService] Clusters cleared');
  }

  /**
   * Find similarity edges between files for graph visualization
   * Returns edges between files that are semantically similar
   *
   * @param {Array<string>} fileIds
   * @param {any} [options]
   * @returns {Promise<any[]>}
   */
  async findFileSimilarityEdges(fileIds, /** @type {any} */ options = {}) {
    const { threshold = 0.5, maxEdgesPerNode = 3 } = options;

    if (!fileIds || fileIds.length < 2) {
      return [];
    }

    try {
      // Get embeddings for the specified files
      await this.vectorDb.initialize();

      // Fetch each file's embedding individually
      const embeddings = new Map();
      await Promise.allSettled(
        fileIds.map(async (id) => {
          try {
            const doc = await this.vectorDb.getFile(id);
            if (doc && Array.isArray(doc.embedding) && doc.embedding.length > 0) {
              embeddings.set(id, {
                vector: doc.embedding,
                metadata: {
                  path: doc.filePath,
                  filePath: doc.filePath,
                  fileName: doc.fileName,
                  fileType: doc.fileType
                }
              });
            }
          } catch {
            // Individual fetch failure is non-critical
          }
        })
      );

      if (embeddings.size < 2) {
        return [];
      }

      // Compute pairwise similarities
      const edges = [];
      const edgeCounts = new Map();
      const ids = Array.from(embeddings.keys());

      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const idA = ids[i];
          const idB = ids[j];
          const embA = embeddings.get(idA);
          const embB = embeddings.get(idB);

          // Skip if either embedding is missing or malformed
          if (!embA?.vector || !embB?.vector) continue;
          // Skip mismatched dimensions to avoid silent 0-similarity results
          if (embA.vector.length !== embB.vector.length) continue;

          const similarity = cosineSimilarity(embA.vector, embB.vector);

          if (similarity >= threshold) {
            // Check if we've reached max edges for either node
            const countA = edgeCounts.get(idA) || 0;
            const countB = edgeCounts.get(idB) || 0;

            if (countA < maxEdgesPerNode && countB < maxEdgesPerNode) {
              edges.push({
                id: `sim:${idA}->${idB}`,
                source: idA,
                target: idB,
                similarity: Math.round(similarity * 100) / 100,
                type: 'similarity'
              });

              edgeCounts.set(idA, countA + 1);
              edgeCounts.set(idB, countB + 1);
            }
          }
        }
      }

      // Sort by similarity (highest first) and limit total edges
      edges.sort((a, b) => b.similarity - a.similarity);

      logger.debug('[ClusteringService] Found similarity edges', {
        fileCount: fileIds.length,
        edgeCount: edges.length
      });

      return edges;
    } catch (error) {
      logger.error('[ClusteringService] Failed to find similarity edges:', error);
      return [];
    }
  }

  /**
   * Find near-duplicate files across the entire indexed collection, organized
   * into three disjoint tiers:
   *
   *   - EXACT:         byte-identical SHA-256 matches (reason: 'sha256')
   *   - NEAR-IDENTICAL: cosine similarity >= 0.98 (reason: 'embedding>=0.98')
   *   - RELATED:       0.90 <= cosine < 0.98 (reason: 'embedding')
   *
   * Exact members are computed first and subtracted from the embedding input so
   * a file can only appear in one tier. Legacy callers still receive a flattened
   * `groups` array and `totalDuplicates` count covering the union of all tiers.
   *
   * @param {any} [options]
   * @returns {Promise<any>}
   */
  async findNearDuplicates(/** @type {any} */ options = {}) {
    const { DUPLICATE_NEAR_IDENTICAL_MIN, DUPLICATE_RELATED_MIN } =
      require('../../shared/performanceConstants').THRESHOLDS;

    // Low thresholds (e.g., 0.1) would match nearly all files, causing OOM
    const MIN_SAFE_THRESHOLD = 0.7;
    const MAX_PAIRS_LIMIT = 10000; // Prevent memory exhaustion from unbounded pairs
    // Cooperative-abort cadence: how many inner-loop iterations between
    // signal.aborted polls and onProgress emissions. Coarse enough to not
    // bottleneck the math, fine enough to feel responsive (~250ms on a
    // typical pair under cosine, well below the 1s "feels frozen" threshold).
    const PROGRESS_INTERVAL = 1000;

    const {
      threshold: requestedThreshold = DUPLICATE_RELATED_MIN,
      maxResults = 50,
      tierThresholds = {},
      signal = null,
      onProgress = null
    } = options;
    const isAborted = () => Boolean(signal && signal.aborted);
    const emitProgress = (/** @type {any} */ payload) => {
      if (typeof onProgress !== 'function') return;
      try {
        onProgress(payload);
      } catch {
        /* progress callback errors must never abort the scan */
      }
    };
    const makeAbortError = () => {
      const err = /** @type {Error & { code?: string }} */ (
        new Error('findNearDuplicates aborted')
      );
      err.code = 'ABORT_ERR';
      err.name = 'AbortError';
      return err;
    };
    const threshold = Math.max(requestedThreshold, MIN_SAFE_THRESHOLD);
    const nearIdenticalMin = Math.max(
      threshold,
      Number(tierThresholds.nearIdenticalMin) || DUPLICATE_NEAR_IDENTICAL_MIN
    );
    const relatedMin = Math.max(
      MIN_SAFE_THRESHOLD,
      Math.min(nearIdenticalMin, Number(tierThresholds.relatedMin) || threshold)
    );

    if (requestedThreshold < MIN_SAFE_THRESHOLD) {
      logger.warn('[ClusteringService] Threshold increased to minimum safe value', {
        requested: requestedThreshold,
        enforced: threshold
      });
    }

    try {
      await this.vectorDb.initialize();

      // Get file count from stats
      const stats = await this.vectorDb.getStats();
      const fileCount = stats?.files || 0;

      /** @type {Record<string, any>} */
      const emptyResult = {
        success: true,
        tiers: { exact: [], nearIdentical: [], related: [] },
        groups: [],
        totalDuplicates: 0,
        summary: {
          exactCount: 0,
          nearIdenticalCount: 0,
          relatedCount: 0,
          truncated: false
        },
        threshold,
        tierThresholds: {
          nearIdenticalMin,
          relatedMin
        }
      };

      if (fileCount < 2) {
        return emptyResult;
      }

      // Get all embeddings and metadata (limited to prevent memory issues)
      const limit = Math.min(fileCount, 1000);
      const result = await this.vectorDb.peekFiles(limit);

      if (!result.ids || result.ids.length < 2) {
        return emptyResult;
      }

      // Build embedding map (id -> { vector, metadata })
      const embeddings = new Map();
      for (let i = 0; i < result.ids.length; i++) {
        embeddings.set(result.ids[i], {
          vector: result.embeddings?.[i] || null,
          metadata: result.metadatas?.[i] || {}
        });
      }

      // === TIER 1: EXACT (byte-identical via SHA-256) ===
      const exactTier = [];
      const exactMembers = new Set(); // ids consumed by exact tier → excluded from embedding tiers
      const hashGroups = new Map();
      for (const [id, entry] of embeddings) {
        const hash = entry?.metadata?.fileHash;
        if (!hash) continue;
        if (!hashGroups.has(hash)) hashGroups.set(hash, []);
        hashGroups.get(hash).push(id);
      }
      for (const [hash, ids] of hashGroups) {
        if (ids.length < 2) continue;
        const members = ids.map((/** @type {any} */ id) => ({
          id,
          ...embeddings.get(id).metadata
        }));
        exactTier.push({
          id: `dup-exact-${exactTier.length}`,
          tier: 'exact',
          reason: 'sha256',
          hash,
          members,
          memberCount: members.length,
          averageSimilarity: 1
        });
        for (const id of ids) exactMembers.add(id);
      }

      // === TIER 2+3: embedding-based pairs (only over non-exact members) ===
      const embeddingIds = [];
      for (const id of embeddings.keys()) {
        if (exactMembers.has(id)) continue;
        if (embeddings.get(id)?.vector?.length) embeddingIds.push(id);
      }

      /** @type {any[]} */
      const duplicatePairs = [];
      let pairsLimitReached = false;
      const totalFiles = embeddingIds.length;
      // Triangular pair count for progress fraction. May be 0 if totalFiles<2.
      const totalPairs = (totalFiles * (totalFiles - 1)) / 2;
      let pairsCompared = 0;
      let lastProgressEmit = 0;

      // Cooperative-abort early-out before any work starts.
      if (isAborted()) throw makeAbortError();
      emitProgress({ phase: 'compare', pairsCompared: 0, totalPairs, matches: 0 });

      outerLoop: for (let i = 0; i < embeddingIds.length; i++) {
        for (let j = i + 1; j < embeddingIds.length; j++) {
          if (duplicatePairs.length >= MAX_PAIRS_LIMIT) {
            pairsLimitReached = true;
            logger.warn('[ClusteringService] Duplicate detection capped at MAX_PAIRS_LIMIT', {
              limit: MAX_PAIRS_LIMIT,
              filesProcessed: i,
              totalFiles
            });
            break outerLoop;
          }

          // Poll abort + emit progress on a fixed cadence. Doing it in the
          // inner loop keeps responsiveness close to PROGRESS_INTERVAL pairs.
          if (pairsCompared - lastProgressEmit >= PROGRESS_INTERVAL) {
            if (isAborted()) throw makeAbortError();
            emitProgress({
              phase: 'compare',
              pairsCompared,
              totalPairs,
              matches: duplicatePairs.length
            });
            lastProgressEmit = pairsCompared;
          }

          const idA = embeddingIds[i];
          const idB = embeddingIds[j];
          const embA = embeddings.get(idA);
          const embB = embeddings.get(idB);

          pairsCompared += 1;

          if (!embA?.vector || !embB?.vector) continue;
          if (embA.vector.length !== embB.vector.length) continue;

          const similarity = cosineSimilarity(embA.vector, embB.vector);
          if (similarity >= relatedMin) {
            duplicatePairs.push({ source: idA, target: idB, similarity });
          }
        }
      }

      // Final progress event so the UI snaps to 100% before grouping work.
      emitProgress({
        phase: 'compare',
        pairsCompared,
        totalPairs,
        matches: duplicatePairs.length,
        done: true
      });
      if (isAborted()) throw makeAbortError();

      // Union-find on pairs, SPLIT by NEAR-IDENTICAL vs RELATED so each tier
      // has its own disjoint grouping (groups can't span tiers).
      const bucketPair = (/** @type {any} */ similarity) =>
        similarity >= nearIdenticalMin ? 'nearIdentical' : 'related';

      const groupInTier = (/** @type {any} */ tierName) => {
        const tierPairs = duplicatePairs.filter((p) => bucketPair(p.similarity) === tierName);
        const parent = new Map();
        const find = (/** @type {any} */ x) => {
          if (!parent.has(x)) parent.set(x, x);
          if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
          return parent.get(x);
        };
        const union = (/** @type {any} */ a, /** @type {any} */ b) => {
          const rA = find(a);
          const rB = find(b);
          if (rA !== rB) parent.set(rA, rB);
        };
        for (const pair of tierPairs) union(pair.source, pair.target);

        const groupMap = new Map();
        for (const pair of tierPairs) {
          const root = find(pair.source);
          if (!groupMap.has(root)) groupMap.set(root, new Set());
          groupMap.get(root).add(pair.source);
          groupMap.get(root).add(pair.target);
        }

        const groups = [];
        for (const [, memberSet] of groupMap) {
          const members = Array.from(memberSet).map((id) => ({
            id,
            ...embeddings.get(id)?.metadata
          }));
          let totalSim = 0;
          let simCount = 0;
          for (const pair of tierPairs) {
            if (memberSet.has(pair.source) && memberSet.has(pair.target)) {
              totalSim += pair.similarity;
              simCount++;
            }
          }
          const average = simCount > 0 ? Math.round((totalSim / simCount) * 100) / 100 : relatedMin;
          groups.push({
            id: `dup-${tierName}-${groups.length}`,
            tier: tierName,
            reason: tierName === 'nearIdentical' ? 'embedding>=0.98' : 'embedding',
            members,
            memberCount: members.length,
            averageSimilarity: average
          });
        }
        groups.sort((a, b) => b.memberCount - a.memberCount);
        return groups;
      };

      const nearIdenticalTier = groupInTier('nearIdentical');
      const relatedTier = groupInTier('related');

      // Apply maxResults across the union of tiers, preserving tier-internal
      // order. EXACT is shown first, then NEAR-IDENTICAL, then RELATED.
      const flat = [...exactTier, ...nearIdenticalTier, ...relatedTier];
      const limitedFlat = flat.slice(0, maxResults);
      const limitedExact = limitedFlat.filter((g) => g.tier === 'exact');
      const limitedNear = limitedFlat.filter((g) => g.tier === 'nearIdentical');
      const limitedRelated = limitedFlat.filter((g) => g.tier === 'related');
      const totalDuplicates = limitedFlat.reduce((sum, g) => sum + g.memberCount, 0);
      const truncated = pairsLimitReached || flat.length > limitedFlat.length;

      logger.info('[ClusteringService] Found duplicates (tiered)', {
        exactCount: limitedExact.length,
        nearIdenticalCount: limitedNear.length,
        relatedCount: limitedRelated.length,
        pairCount: duplicatePairs.length,
        totalDuplicates,
        truncated
      });

      return {
        success: true,
        tiers: {
          exact: limitedExact,
          nearIdentical: limitedNear,
          related: limitedRelated
        },
        // Back-compat: flattened groups for callers that don't yet know about tiers.
        groups: limitedFlat,
        totalDuplicates,
        summary: {
          exactCount: limitedExact.length,
          nearIdenticalCount: limitedNear.length,
          relatedCount: limitedRelated.length,
          truncated
        },
        threshold,
        tierThresholds: { nearIdenticalMin, relatedMin },
        truncated,
        warning: pairsLimitReached
          ? `Results truncated: exceeded ${MAX_PAIRS_LIMIT} pairs limit. Consider increasing threshold.`
          : undefined
      };
    } catch (error) {
      logger.error('[ClusteringService] Failed to find near-duplicates:', error);
      return {
        success: false,
        error: error.message,
        tiers: { exact: [], nearIdentical: [], related: [] },
        groups: [],
        totalDuplicates: 0,
        summary: {
          exactCount: 0,
          nearIdenticalCount: 0,
          relatedCount: 0,
          truncated: false
        }
      };
    }
  }

  /**
   * Cleanup resources on shutdown
   * Clears all cached data and pending operations
   */
  cleanup() {
    logger.info('[ClusteringService] Cleaning up...');

    // Clear all cached data
    this.clusters = [];
    this.centroids = [];
    this.clusterLabels.clear();
    this.lastComputedAt = null;
    this._computePromise = null;

    logger.info('[ClusteringService] Cleanup complete');
  }

  /**
   * Alias for cleanup (for consistency with other services)
   */
  shutdown() {
    this.cleanup();
  }
}

module.exports = { ClusteringService };
