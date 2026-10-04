// @ts-check
/**
 * SearchService - Hybrid Search with BM25 + Vector Similarity
 *
 * Combines keyword-based BM25 search with semantic vector search
 * using weighted-sum fusion. Reciprocal Rank Fusion (`reciprocalRankFusion`)
 * remains available for graph-expansion scoring.
 *
 * Enhanced with:
 * - QueryProcessor for spell correction and synonym expansion
 * - ReRankerService for LLM-based re-ranking of top results
 *
 * @module services/SearchService
 */

const { create, insertMultiple, search: oramaSearch } = require('@orama/orama');
// @ts-expect-error @orama/stemmers/english lacks a named export in its declaration; runtime shape is `{ english }`
const { english } = require('@orama/stemmers/english');
const ORAMA_TOKENIZER_CONFIG = { stemmer: english, stemming: true };
const fs = require('fs').promises;
const path = require('path');
const { createLogger } = require('../../shared/logger');
const { THRESHOLDS, TIMEOUTS, SEARCH, CACHE } = require('../../shared/performanceConstants');
const { LRUCache } = require('../../shared/LRUCache');
const { normalizePathForIndex } = require('../../shared/pathSanitization');
const { validateEmbeddingDimensions, padOrTruncateVector } = require('../../shared/vectorMath');
const { getSemanticFileId } = require('../../shared/fileIdUtils');
const { createBackgroundWorkTracker } = require('../../shared/promiseUtils');
const { isGhostCleanupDeferred } = require('../../shared/ghostCleanupGuard');
const systemAnalytics = require('../core/systemAnalytics');

// Optional services for enhanced query processing
const { getInstance: getQueryProcessor } = require('./QueryProcessor');
const { getInstance: getReRanker } = require('./ReRankerService');
const { inferMediaKind } = require('../analysis/mediaAnalysis');

const logger = createLogger('SearchService');
const ENABLE_SEARCH_TRACE_LOGS = process.env.NODE_ENV === 'development';
/**
 * Minimum score threshold for results (filters low-quality matches)
 * Uses MIN_SIMILARITY_SCORE from performanceConstants
 */
const MIN_RESULT_SCORE = THRESHOLDS.MIN_SIMILARITY_SCORE;

/**
 * Vector search timeout before falling back to BM25
 */
const VECTOR_SEARCH_TIMEOUT = TIMEOUTS.SEMANTIC_QUERY;

/**
 * Default search options (from performanceConstants.SEARCH)
 */
const DEFAULT_OPTIONS = {
  topK: SEARCH.DEFAULT_TOP_K,
  mode: 'hybrid', // 'vector', 'bm25', 'hybrid'
  vectorWeight: SEARCH.VECTOR_WEIGHT,
  bm25Weight: SEARCH.BM25_WEIGHT,
  minScore: MIN_RESULT_SCORE, // Minimum score threshold
  // Share the non-BM25 weight between file-level and chunk-level vectors.
  // Chunk results improve deep recall for natural-language queries.
  chunkWeight: 0.5,
  // Query processing options
  expandSynonyms: true, // Expand query with lemma variants
  // Spell correction enabled by default with strict length checks (min 4 chars)
  correctSpelling: true,
  // Re-ranking options (disabled by default — each candidate requires a separate
  // LLM inference call which competes for the single inference slot, causing
  // 30-50 s latency when the model is already busy with analysis/chat).
  rerank: false,
  rerankTopN: 10,
  // Contextual chunk expansion
  chunkContext: SEARCH.CHUNK_CONTEXT_ENABLED,
  chunkContextMaxNeighbors: SEARCH.CHUNK_CONTEXT_MAX_NEIGHBORS,
  chunkContextMaxFiles: SEARCH.CHUNK_CONTEXT_MAX_FILES,
  chunkContextMaxChars: SEARCH.CHUNK_CONTEXT_MAX_CHARS,
  // Graph expansion options (local relationship index)
  graphExpansion: SEARCH.GRAPH_EXPANSION_ENABLED,
  graphExpansionWeight: SEARCH.GRAPH_EXPANSION_WEIGHT,
  graphExpansionMaxSeeds: SEARCH.GRAPH_EXPANSION_MAX_SEEDS,
  graphExpansionMaxEdges: SEARCH.GRAPH_EXPANSION_MAX_EDGES,
  graphExpansionMaxNeighbors: SEARCH.GRAPH_EXPANSION_MAX_NEIGHBORS,
  graphExpansionMinWeight: SEARCH.GRAPH_EXPANSION_MIN_WEIGHT,
  graphExpansionDecay: SEARCH.GRAPH_EXPANSION_DECAY
};

function buildHybridSearchCacheKey(
  /** @type {any} */ normalizedQuery,
  /** @type {any} */ mode,
  /** @type {any} */ topK,
  /** @type {any} */ options
) {
  return JSON.stringify([
    normalizedQuery,
    mode,
    topK,
    options.minScore,
    options.chunkWeight,
    options.chunkTopK,
    options.chunkContext,
    options.chunkContextMaxNeighbors,
    options.chunkContextMaxFiles,
    options.chunkContextMaxChars,
    options.expandSynonyms,
    options.correctSpelling,
    options.rerank,
    options.rerankTopN,
    options.graphExpansion,
    options.graphExpansionWeight,
    options.graphExpansionMaxSeeds,
    options.graphExpansionMaxEdges,
    options.graphExpansionMaxNeighbors,
    options.graphExpansionMinWeight,
    options.graphExpansionDecay
  ]);
}

/**
 * Normalize caller-provided precomputed embedding input.
 * Accepts either:
 * - full embed result object: { vector: number[] }
 * - raw vector array: number[]
 *
 * @param {any} input
 * @returns {{vector: number[]}|null}
 */
function normalizePrecomputedEmbedding(input) {
  if (Array.isArray(input?.vector) && input.vector.length > 0) {
    return { vector: input.vector };
  }
  if (Array.isArray(input) && input.length > 0) {
    return { vector: input };
  }
  return null;
}

class SearchService {
  /**
   * @param {any} [dependencies]
   */
  constructor(
    {
      vectorDbService,
      analysisHistoryService,
      parallelEmbeddingService,
      queryProcessor,
      reRankerService,
      llamaService,
      relationshipIndexService
    } = /** @type {any} */ ({})
  ) {
    const vectorDb = vectorDbService || null;

    // Validate required dependencies
    if (!vectorDb) {
      throw new Error('SearchService requires vectorDbService dependency');
    }
    if (!analysisHistoryService) {
      throw new Error('SearchService requires analysisHistoryService dependency');
    }
    if (!parallelEmbeddingService) {
      throw new Error('SearchService requires parallelEmbeddingService dependency');
    }

    this.vectorDb = vectorDb;
    this.history = analysisHistoryService;
    this.embedding = parallelEmbeddingService;

    // Optional enhanced services - use singletons if not provided
    this.queryProcessor = queryProcessor || null;
    this.reRanker = reRankerService || null;
    this.llamaService = llamaService || null;
    this.relationshipIndex = relationshipIndexService || null;

    // Lazy initialize optional services
    this._queryProcessorInitialized = false;
    this._reRankerInitialized = false;

    this.bm25Index = null;
    this.documentMap = new Map(); // id -> document metadata
    this.indexBuiltAt = null;
    this.indexVersion = 0;

    // Index staleness threshold (15 minutes)
    this.INDEX_STALE_MS = 15 * 60 * 1000;

    // Track fire-and-forget promises
    /** @type {any} */
    this._bgWork = createBackgroundWorkTracker('SearchService');

    // Cached serialized index for faster rebuilds
    this._serializedIndex = null;
    this._serializedDocMap = null;

    // Lock to prevent concurrent index builds (race condition fix)
    this._indexBuildPromise = null;

    // during batch operations (e.g., multi-file move/rename/delete)
    this._rebuildDebounceTimer = null;
    /** @type {any[]} */
    this._rebuildDebounceResolvers = [];
    this._REBUILD_DEBOUNCE_MS = 500;

    // Maximum cache size in bytes (50MB) to prevent unbounded growth
    this._maxCacheSize = 50 * 1024 * 1024;

    // Throttle noisy diagnostics when primary vector retrieval returns no hits.
    this._lastZeroVectorDiagnosticsAt = 0;
    this._ZERO_VECTOR_DIAGNOSTICS_INTERVAL_MS = 60 * 1000;

    // LRU cache for hybridSearch results — avoids redundant BM25/vector work
    // for repeated queries within the TTL window (e.g., tab switches, graph rebuilds).
    this._searchCache = new LRUCache({
      maxSize: 50,
      ttlMs: CACHE.SEARCH_CACHE_TTL_MS,
      name: 'SearchCache'
    });

    // In-flight deduplication: concurrent identical searches share one execution
    this._searchInFlight = new Map();
    this._searchDataRevision = 0;
    this._vectorDbMutationListener = (/** @type {any} */ payload = {}) => {
      this.invalidateSearchResults(payload.reason || payload.operation || 'vector-db-mutation');
    };
    if (typeof this.vectorDb?.on === 'function') {
      this.vectorDb.on('search-data-mutated', this._vectorDbMutationListener);
    }
  }

  /**
   * Drop every cached and in-flight hybridSearch execution so results can
   * never outlive a vector-DB mutation. Bumps a monotonic data revision that
   * in-flight searches compare against before caching, so a result computed
   * pre-mutation is discarded instead of served post-mutation. Wired to the
   * vector DB's 'search-data-mutated' event in the constructor and also
   * called by clearIndex / invalidateIndex.
   *
   * @param {string} [_reason='vector-db-mutation'] - Mutation source (reserved for tracing)
   * @returns {number} The new search-data revision
   */
  invalidateSearchResults(_reason = 'vector-db-mutation') {
    this._searchDataRevision += 1;
    this._searchCache.clear();
    this._searchInFlight.clear();
    return this._searchDataRevision;
  }

  /**
   * Get or initialize QueryProcessor
   * @returns {any}
   */
  _getQueryProcessor() {
    if (this.queryProcessor) return this.queryProcessor;
    if (this._queryProcessorInitialized) return this.queryProcessor;

    try {
      this.queryProcessor = getQueryProcessor();
      this._queryProcessorInitialized = true;

      // Extend vocabulary from analysis history (background)
      if (this.history) {
        this._bgWork.track(
          this.queryProcessor.extendVocabulary(this.history).catch((/** @type {any} */ err) => {
            logger.debug('[SearchService] Vocabulary extension failed:', err.message);
          })
        );
      }

      return this.queryProcessor;
    } catch (error) {
      logger.debug('[SearchService] QueryProcessor not available:', error.message);
      this._queryProcessorInitialized = true;
      return null;
    }
  }

  /**
   * Get or initialize ReRankerService
   * @returns {any}
   */
  _getReRanker() {
    if (this.reRanker) return this.reRanker;
    if (this._reRankerInitialized) return this.reRanker;

    try {
      // Re-ranker needs AI service
      if (!this.llamaService) {
        logger.debug('[SearchService] Re-ranker unavailable: no AI service');
        this._reRankerInitialized = true;
        return null;
      }

      this.reRanker = getReRanker({ llamaService: this.llamaService });
      this._reRankerInitialized = true;
      return this.reRanker;
    } catch (error) {
      logger.debug('[SearchService] ReRanker not available:', error.message);
      this._reRankerInitialized = true;
      return null;
    }
  }

  /**
   * Set AI service for re-ranking (can be set after construction)
   * @param {any} aiService - AI service instance
   */
  setAiService(aiService) {
    this.llamaService = aiService;
    // Reset reranker initialization so it can be created with the new service
    this._reRankerInitialized = false;
    this.reRanker = null;
  }

  /**
   * Check if the BM25 index needs rebuilding
   *
   * @returns {boolean} True if index is stale or missing
   */
  isIndexStale() {
    if (!this.indexBuiltAt) {
      return true;
    }
    if (!this.bm25Index) {
      const entryCount = this.history?.analysisHistory?.metadata?.totalEntries ?? 0;
      if (entryCount > 0) {
        return true;
      }
      // If last build produced an empty index, avoid rebuilding every search.
      const isEmptyIndex = !this.documentMap || this.documentMap.size === 0;
      if (isEmptyIndex) {
        return Date.now() - this.indexBuiltAt > this.INDEX_STALE_MS;
      }
      return true;
    }
    return Date.now() - this.indexBuiltAt > this.INDEX_STALE_MS;
  }

  /**
   * Build or rebuild the BM25 index from analysis history
   * Uses a lock to prevent concurrent builds (race condition safe)
   *
   * @returns {Promise<{success: boolean, indexed: number, error?: string}>}
   */
  async buildBM25Index() {
    // Prevent concurrent index builds - return existing promise if building
    if (this._indexBuildPromise) {
      logger.debug('[SearchService] Index build already in progress, waiting...');
      return this._indexBuildPromise;
    }

    this._indexBuildPromise = this._doBuildBM25Index();
    try {
      return await this._indexBuildPromise;
    } finally {
      this._indexBuildPromise = null;
    }
  }

  /**
   * Internal method to actually build the BM25 index
   * @private
   */
  async _doBuildBM25Index() {
    try {
      logger.info('[SearchService] Building BM25 index...');

      await this.history.initialize();
      const entries = this.history.analysisHistory?.entries || {};
      // De-dupe by canonical file ID (path-based) and prefer the most recent analysis entry.
      // This is required because analysis history uses UUIDs per analysis run, while semantic search uses path IDs.
      const documents = Object.values(entries).sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

      if (documents.length === 0) {
        logger.warn('[SearchService] No documents to index');
        this.bm25Index = null;
        this.documentMap.clear();
        this.indexBuiltAt = Date.now();
        this._serializedIndex = null;
        this._serializedDocMap = null;
        return { success: true, indexed: 0 };
      }

      const normalizeList = (/** @type {any} */ value) => {
        if (!value) return [];
        if (Array.isArray(value)) {
          return value.map((item) => String(item).trim()).filter(Boolean);
        }
        if (typeof value === 'string') {
          const trimmed = value.trim();
          if (!trimmed) return [];
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
              return parsed.map((item) => String(item).trim()).filter(Boolean);
            }
          } catch {
            // Ignore JSON parse errors.
          }
          return trimmed
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
        }
        return [];
      };

      // Release old index and document map before building new ones to avoid
      // holding both old and new data structures in memory simultaneously.
      // This prevents doubling memory usage during rebuilds.
      this.bm25Index = null;
      this.documentMap = new Map();

      // Build index into local variables first so a build failure doesn't leave partial state behind.
      const nextDocumentMap = new Map();
      const seenIds = new Set();
      const nextIndex = await create({
        schema: {
          id: 'string',
          fileName: 'string',
          subject: 'string',
          summary: 'string',
          tags: 'string[]',
          category: 'string',
          entity: 'string',
          project: 'string',
          purpose: 'string',
          documentType: 'string',
          keyEntities: 'string[]',
          documentDate: 'string',
          reasoning: 'string',
          extractedText: 'string'
        },
        components: { tokenizer: ORAMA_TOKENIZER_CONFIG }
      });

      const indexDocs = [];
      for (const doc of documents) {
        const analysis = doc.analysis || {};
        const organization = doc.organization || {};

        // If file was moved/renamed, use the actual destination path
        const currentPath = organization.actual || doc.originalPath;
        const currentName = organization.newName || doc.fileName || '';

        // Use normalizePathForIndex for Windows case-insensitivity consistency
        // This ensures BM25 index keys match vector DB lookups
        const normalizedPath = normalizePathForIndex(currentPath || '');
        const canonicalId = getSemanticFileId(normalizedPath);

        // De-dupe: keep the most recent analysis per canonical file ID
        if (!currentPath || seenIds.has(canonicalId)) {
          continue;
        }
        seenIds.add(canonicalId);

        const normalizedTags = normalizeList(analysis.tags);
        const normalizedKeyEntities = normalizeList(analysis.keyEntities);

        // Media (audio/video) transcripts are 5-10× longer than typical
        // document extracts. A 20-minute podcast is ~15 000 chars; the
        // 5 000 / 3 000 caps below were tuned for documents and would
        // truncate the second half of every podcast before chat / BM25
        // ever saw it. Lift the cap when this entry IS media — using
        // every signal we have so legacy entries (pre-`mediaKind`) that
        // were re-indexed are also detected via mimeType / extension.
        const resolvedMediaKind = inferMediaKind({
          mediaKind: analysis.mediaKind,
          mimeType: doc.mimeType,
          filePath: currentPath
        });
        const isMediaFile = Boolean(resolvedMediaKind);
        const bm25TextCap = isMediaFile ? 20000 : 5000;
        const docMapTextCap = isMediaFile ? 15000 : 3000;

        const indexDoc = {
          id: canonicalId,
          fileName: currentName,
          subject: analysis.subject || '',
          summary: analysis.summary || '',
          tags: normalizedTags,
          category: analysis.category || '',
          entity: analysis.entity || '',
          project: analysis.project || '',
          purpose: analysis.purpose || '',
          documentType: analysis.documentType || analysis.type || '',
          keyEntities: normalizedKeyEntities,
          documentDate: analysis.documentDate || analysis.date || '',
          reasoning: analysis.reasoning || '',
          extractedText: this._truncateText(analysis.extractedText, bm25TextCap)
        };

        indexDocs.push(indexDoc);

        // Store document metadata for result enrichment (including extractedText
        // so the chat/RAG pipeline can feed actual document content to the LLM)
        nextDocumentMap.set(canonicalId, {
          id: canonicalId,
          analysisId: doc.id,
          path: currentPath,
          name: currentName,
          type: doc.mimeType || 'document',
          mediaKind: resolvedMediaKind || null,
          subject: analysis.subject,
          summary: analysis.summary,
          tags: normalizedTags,
          category: analysis.category,
          entity: analysis.entity || null,
          project: analysis.project || null,
          purpose: analysis.purpose || null,
          documentType: analysis.documentType || analysis.type || null,
          documentDate: analysis.documentDate || analysis.date || null,
          reasoning: analysis.reasoning || null,
          confidence: analysis.confidence,
          keyEntities: normalizedKeyEntities,
          dates: analysis.dates || [],
          extractedText: this._truncateText(analysis.extractedText, docMapTextCap) || null
        });
      }

      if (indexDocs.length > 0) {
        await insertMultiple(nextIndex, indexDocs);
      }

      // Commit the new index atomically.
      this.bm25Index = nextIndex;
      this.documentMap = nextDocumentMap;

      this.indexBuiltAt = Date.now();
      this.indexVersion++;

      // Clear legacy serialized caches (Orama index is kept in memory)
      this._serializedIndex = null;
      this._serializedDocMap = null;

      // Log sample of indexed content for debugging
      const sampleDocs = documents.slice(0, 3).map((d) => ({
        fileName: d.fileName,
        subject: d.analysis?.subject?.slice(0, 50),
        tags: d.analysis?.tags?.slice(0, 3)
      }));
      logger.info(`[SearchService] BM25 index built with ${this.documentMap.size} documents`);
      logger.debug('[SearchService] Sample indexed docs:', sampleDocs);
      return { success: true, indexed: this.documentMap.size };
    } catch (error) {
      logger.error('[SearchService] Failed to build BM25 index:', error);
      return { success: false, indexed: 0, error: error.message };
    }
  }

  /**
   * Truncate text to a maximum length for indexing
   *
   * @param {string} text - Text to truncate
   * @param {number} maxLength - Maximum length
   * @returns {string} Truncated text
   */
  _truncateText(text, maxLength) {
    if (!text || typeof text !== 'string') return '';
    return text.length > maxLength ? text.slice(0, maxLength) : text;
  }

  _padOrTruncateVector(/** @type {any} */ vector, /** @type {any} */ expectedDim) {
    return padOrTruncateVector(vector, expectedDim);
  }

  /**
   * Normalize query embedding vector to match the stored collection dimension.
   * STRICT MODE: Fails if dimensions mismatch to prevent semantic garbage.
   *
   * @param {number[]} vector
   * @param {'files'|'fileChunks'} collectionType
   * @returns {Promise<number[]|null>}
   */
  async _normalizeQueryVector(vector, collectionType) {
    if (!Array.isArray(vector) || vector.length === 0) return null;
    try {
      const expectedDim = await this.vectorDb.getCollectionDimension(collectionType);

      // If collection is empty, any dimension is valid
      if (expectedDim == null) return vector;

      // STRICT CHECK: Fail if dimensions mismatch
      if (!validateEmbeddingDimensions(vector, expectedDim)) {
        const errorMsg =
          `Embedding model changed. Your search index uses ${expectedDim}-dimension embeddings, ` +
          `but your current model produces ${vector.length}-dimension embeddings. ` +
          `Please rebuild your search index to use the new model.`;

        logger.error('[SearchService] Embedding dimension mismatch - failing vector search', {
          collectionType,
          expected: expectedDim,
          actual: vector.length,
          reason: 'Model mismatch likely'
        });

        // This allows UI to display actionable message to user
        const err = /** @type {Error & { isDimensionMismatch?: boolean }} */ (new Error(errorMsg));
        err.isDimensionMismatch = true;
        throw err;
      }

      return vector;
    } catch (e) {
      // Other errors (like vector DB unavailable) can fail safely to null
      if (e.isDimensionMismatch) {
        throw e; // Propagate to UI with clear message
      }
      // If dimension check fails for other reasons, log and fail safe
      logger.warn('[SearchService] Failed to validate query vector dimension:', e.message);
      return null;
    }
  }

  /**
   * Search using BM25 keyword matching
   *
   * @param {string} query
   * @param {number} [topK]
   * @returns {Promise<any[]>}
   */
  async bm25Search(query, topK = 20) {
    if (!this.bm25Index) {
      logger.warn('[SearchService] BM25 index not built');
      return [];
    }

    try {
      const trimmedQuery = typeof query === 'string' ? query.trim() : '';
      if (!trimmedQuery) return [];
      logger.debug(`[SearchService] BM25 search query length: ${trimmedQuery.length}`);

      const results = await oramaSearch(this.bm25Index, {
        term: trimmedQuery,
        limit: topK,
        boost: {
          fileName: 3,
          subject: 2,
          summary: 1.5,
          tags: 2,
          category: 1.5,
          entity: 1.4,
          project: 1.4,
          purpose: 1.2,
          documentType: 1.2,
          keyEntities: 1.2,
          documentDate: 0.8,
          reasoning: 0.6,
          extractedText: 2.5
        }
      });
      const hits = Array.isArray(results?.hits) ? results.hits : [];
      logger.debug(`[SearchService] BM25 raw results: ${hits.length}`);

      const queryTerms = this._extractQueryTerms(trimmedQuery);
      const mapped = hits.slice(0, topK).map((result) => {
        const meta = this.documentMap.get(result.id) || {};
        const doc = result.document || {};
        const { matchedFields, matchedTerms } = this._inferMatchDetails(queryTerms, doc);

        return {
          id: result.id,
          score: result.score,
          metadata: {
            path: meta.path,
            name: meta.name,
            type: meta.type,
            tags: meta.tags || [],
            category: meta.category || '',
            subject: meta.subject || '',
            confidence: meta.confidence || 0
          },
          source: 'bm25',
          matchDetails: {
            matchedTerms: matchedTerms.slice(0, 5), // Limit to top 5 terms
            matchedFields
          }
        };
      });

      if (mapped.length) {
        logger.debug('[SearchService] BM25 top candidates', {
          top: mapped.slice(0, 3).map((r) => ({
            score: r.score?.toFixed?.(3),
            id: r.id?.split(/[\\/]/).pop(),
            matchedFields: r.matchDetails?.matchedFields
          }))
        });
      } else {
        logger.debug('[SearchService] BM25 produced no mapped results');
      }

      return mapped;
    } catch (error) {
      logger.error('[SearchService] BM25 search failed:', error);
      return [];
    }
  }

  _extractQueryTerms(/** @type {any} */ query) {
    if (!query || typeof query !== 'string') return [];
    return query
      .toLowerCase()
      .replace(/[^\w\s-]+/g, ' ')
      .split(/\s+/)
      .map((term) => term.trim())
      .filter((term) => term.length > 1);
  }

  _inferMatchDetails(/** @type {any} */ queryTerms, /** @type {any} */ doc = {}) {
    if (!queryTerms.length) {
      return { matchedFields: [], matchedTerms: [] };
    }

    const toText = (/** @type {any} */ value) => {
      if (!value) return '';
      if (Array.isArray(value)) return value.join(' ');
      return String(value);
    };

    const fields = {
      fileName: toText(doc.fileName),
      subject: toText(doc.subject),
      summary: toText(doc.summary),
      tags: toText(doc.tags),
      category: toText(doc.category),
      entity: toText(doc.entity),
      project: toText(doc.project),
      purpose: toText(doc.purpose),
      documentType: toText(doc.documentType),
      keyEntities: toText(doc.keyEntities),
      documentDate: toText(doc.documentDate),
      reasoning: toText(doc.reasoning),
      extractedText: toText(doc.extractedText)
    };

    const matchedFields = [];
    const matchedTerms = new Set();

    for (const [field, rawValue] of Object.entries(fields)) {
      if (!rawValue) continue;
      const value = rawValue.toLowerCase();
      let matched = false;
      for (const term of queryTerms) {
        if (value.includes(term)) {
          matched = true;
          matchedTerms.add(term);
        }
      }
      if (matched) {
        matchedFields.push(field);
      }
    }

    return { matchedFields, matchedTerms: Array.from(matchedTerms) };
  }

  /**
   * Search using vector similarity via the vector DB
   *
   * @param {string} query
   * @param {number} [topK]
   * @param {any} [options]
   * @returns {Promise<any[]>}
   */
  async vectorSearch(query, topK = 20, options = {}) {
    // Abort cooperation: if the caller passes a signal (e.g. from
    // _vectorSearchWithTimeout), check it at each await point so a timeout
    // doesn't block forever waiting on embedding inference or Orama
    // querying. The underlying calls don't honor signal natively; this is
    // a soft cancellation that bails at the next yield.
    const { signal } = options;
    const checkAborted = () => {
      if (signal?.aborted) {
        const err = /** @type {Error & { code?: string }} */ (new Error('vectorSearch aborted'));
        err.code = 'ABORT_ERR';
        err.name = 'AbortError';
        throw err;
      }
    };
    try {
      checkAborted();
      // Reuse precomputed embedding if provided (avoids redundant LLM call in hybrid mode)
      const precomputedEmbedding = normalizePrecomputedEmbedding(options.precomputedEmbedding);
      const embedResult = precomputedEmbedding || (await this.embedding.embedText(query));
      checkAborted();
      if (!embedResult || !embedResult.vector) {
        logger.warn('[SearchService] Failed to generate query embedding');
        return [];
      }
      logger.debug(`[SearchService] Query embedding generated, dim=${embedResult.vector?.length}`);

      // Normalize/Validate vector against collection dimension
      const queryVector = await this._normalizeQueryVector(embedResult.vector, 'files');
      checkAborted();
      if (!queryVector) {
        logger.warn(
          '[SearchService] Aborting vector search due to invalid/mismatched query vector'
        );
        return [];
      }

      // Query Orama
      const vectorResults = await this.vectorDb.querySimilarFiles(queryVector, topK);
      checkAborted();
      logger.debug(`[SearchService] Vector DB returned ${vectorResults?.length || 0} results`);

      if (!vectorResults || !Array.isArray(vectorResults)) {
        logger.warn('[SearchService] Vector DB returned no results or invalid format');
        return [];
      }

      if (vectorResults.length === 0) {
        await this._logZeroVectorDiagnostics(query, topK);
        return [];
      }

      // Extract query words for tag/category matching
      const queryWords = query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2);

      return vectorResults.map((result) => {
        // Vector DB cosine distance is in range [0, 2], convert with: 1 - distance/2
        // Also handle score=0 as a valid score (not falsy fallback)
        const semanticScore =
          typeof result.score === 'number'
            ? result.score
            : Math.max(0, 1 - (result.distance || 0) / 2);
        const metadata = result.metadata || {};

        let tags = [];
        if (Array.isArray(metadata.tags)) {
          tags = metadata.tags;
        } else if (typeof metadata.tags === 'string' && metadata.tags) {
          try {
            const parsed = JSON.parse(metadata.tags);
            tags = Array.isArray(parsed) ? parsed : [];
          } catch {
            // If parsing fails, treat as empty array
            tags = [];
          }
        }

        const queryTermsInTags = tags.filter((/** @type {any} */ tag) =>
          queryWords.some((word) => String(tag).toLowerCase().includes(word))
        );

        // Check if query terms appear in category
        const category = metadata.category || '';
        const queryTermsInCategory = queryWords.some((word) =>
          category.toLowerCase().includes(word)
        );

        return {
          id: result.id,
          score: semanticScore,
          metadata,
          source: 'vector',
          matchDetails: {
            semanticScore,
            queryTermsInTags: queryTermsInTags.slice(0, 3),
            queryTermsInCategory
          }
        };
      });
    } catch (error) {
      // Model-change mismatch carries an actionable "rebuild your index"
      // message — swallowing it into [] leaves search silently keyword-only
      // forever and starves the rebuild-prompt path in ipc/semantic.js.
      if (error?.isDimensionMismatch) throw error;
      // Hybrid search passes propagateErrors so a hard vector failure degrades
      // to the explicit bm25-fallback mode (same as a timeout) instead of
      // silently fusing an empty vector leg — which caps combined scores at
      // the BM25 weight and drops otherwise-valid hits below minScore.
      if (options.propagateErrors) throw error;
      logger.error('[SearchService] Vector search failed:', error);
      return [];
    }
  }

  async _logZeroVectorDiagnostics(/** @type {any} */ query, /** @type {any} */ topK) {
    const now = Date.now();
    if (now - this._lastZeroVectorDiagnosticsAt < this._ZERO_VECTOR_DIAGNOSTICS_INTERVAL_MS) {
      return;
    }
    this._lastZeroVectorDiagnosticsAt = now;

    try {
      const stats =
        typeof this.vectorDb?.getStats === 'function' ? await this.vectorDb.getStats() : null;
      const diagnostics =
        typeof this.vectorDb?.getFileVectorDiagnostics === 'function'
          ? await this.vectorDb.getFileVectorDiagnostics({ sampleSize: 3 })
          : null;
      const vectorHealth =
        stats?.vectorHealth ||
        (typeof this.vectorDb?.getVectorHealth === 'function'
          ? this.vectorDb.getVectorHealth()
          : null);

      logger.warn('[SearchService] Vector search returned zero results', {
        queryLength: typeof query === 'string' ? query.length : 0,
        topK,
        fileEmbeddings: stats?.files ?? null,
        chunkEmbeddings: stats?.fileChunks ?? null,
        vectorHealth,
        diagnostics
      });
    } catch (error) {
      logger.debug('[SearchService] Failed to gather zero-vector diagnostics', {
        error: error?.message
      });
    }
  }

  /**
   * Chunk search: query against extractedText chunk embeddings.
   *
   * Returns file-level candidates aggregated from chunk hits.
   * @param {string} query
   * @param {number} [topKFiles]
   * @param {number} [topKChunks]
   * @param {any} [options]
   * @returns {Promise<any[]>}
   */
  async chunkSearch(query, topKFiles = 20, topKChunks = 80, /** @type {any} */ options = {}) {
    const {
      chunkContext = DEFAULT_OPTIONS.chunkContext,
      chunkContextMaxNeighbors = DEFAULT_OPTIONS.chunkContextMaxNeighbors,
      chunkContextMaxFiles = DEFAULT_OPTIONS.chunkContextMaxFiles,
      chunkContextMaxChars = DEFAULT_OPTIONS.chunkContextMaxChars,
      precomputedEmbedding = null
    } = options;
    try {
      // Inspect chunk collection availability and count
      try {
        const stats = await this.vectorDb.getStats();
        const chunkCount = stats?.fileChunks || 0;

        if (chunkCount === 0) {
          logger.debug('[SearchService] Chunk collection empty; no chunk results available');
          return [];
        }
        logger.debug('[SearchService] Chunk collection ready', { chunkCount, topKChunks });
      } catch (countErr) {
        logger.debug('[SearchService] Unable to get chunk collection count', {
          error: countErr.message
        });
      }

      // Reuse precomputed embedding if provided (avoids redundant LLM call in hybrid mode)
      const normalizedPrecomputedEmbedding = normalizePrecomputedEmbedding(precomputedEmbedding);
      const embedResult = normalizedPrecomputedEmbedding || (await this.embedding.embedText(query));
      if (!embedResult || !embedResult.vector) {
        logger.warn('[SearchService] Failed to generate query embedding for chunk search');
        return [];
      }

      // Normalize/Validate vector against collection dimension
      const queryVector = await this._normalizeQueryVector(embedResult.vector, 'fileChunks');
      if (!queryVector) {
        logger.warn('[SearchService] Aborting chunk search due to invalid/mismatched query vector');
        return [];
      }

      const chunkResults = await this.vectorDb.querySimilarFileChunks(queryVector, topKChunks);
      if (!Array.isArray(chunkResults) || chunkResults.length === 0) {
        logger.debug('[SearchService] Chunk search returned no results');
        return [];
      }

      // Aggregate chunk hits into file candidates (max score wins)
      const byFile = new Map();
      for (const hit of chunkResults) {
        const meta = hit?.metadata || {};
        const fileId = meta.fileId;
        if (!fileId) continue;

        const score = typeof hit.score === 'number' ? hit.score : 0;
        const snippet = meta.snippet || meta.content || hit.document || '';
        const charStart =
          typeof meta.charStart === 'number'
            ? meta.charStart
            : typeof meta.startOffset === 'number'
              ? meta.startOffset
              : undefined;
        const charEnd =
          typeof meta.charEnd === 'number'
            ? meta.charEnd
            : typeof meta.endOffset === 'number'
              ? meta.endOffset
              : undefined;
        const existing = byFile.get(fileId);
        if (!existing || score > existing.score) {
          byFile.set(fileId, {
            id: fileId,
            score,
            metadata: {
              path: meta.path,
              name: meta.name,
              type: meta.type || 'document'
            },
            source: 'chunk',
            matchDetails: {
              chunkScore: score,
              bestSnippet: snippet,
              chunkIndex: meta.chunkIndex,
              charStart,
              charEnd
            }
          });
        }
      }

      const results = Array.from(byFile.values())
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, topKFiles);

      if (chunkContext && chunkContextMaxNeighbors > 0 && results.length > 0) {
        await this._attachChunkContext(results, {
          chunkContextMaxNeighbors,
          chunkContextMaxFiles,
          chunkContextMaxChars
        });
      }

      return results;
    } catch (error) {
      if (error?.isDimensionMismatch) throw error;
      logger.error('[SearchService] Chunk search failed:', error);
      return [];
    }
  }

  async _attachChunkContext(/** @type {any} */ results, /** @type {any} */ options = {}) {
    const {
      chunkContextMaxNeighbors = DEFAULT_OPTIONS.chunkContextMaxNeighbors,
      chunkContextMaxFiles = DEFAULT_OPTIONS.chunkContextMaxFiles,
      chunkContextMaxChars = DEFAULT_OPTIONS.chunkContextMaxChars
    } = options;

    // Requires OramaVectorService.getChunksForFile() to retrieve neighboring chunks
    if (typeof this.vectorDb?.getChunksForFile !== 'function') return;

    const candidates = results
      .filter((/** @type {any} */ r) => Number.isInteger(r?.matchDetails?.chunkIndex))
      .slice(0, chunkContextMaxFiles);

    if (candidates.length === 0) return;

    // Cache chunk maps per file to avoid redundant DB queries
    const chunkMaps = new Map();
    const loadChunkMap = async (/** @type {any} */ fileId) => {
      if (chunkMaps.has(fileId)) return chunkMaps.get(fileId);
      try {
        const chunks = await this.vectorDb.getChunksForFile(fileId);
        const map = new Map();
        for (const chunk of chunks) {
          if (Number.isInteger(chunk.chunkIndex)) {
            const text = chunk.text || chunk.snippet || '';
            if (text.trim().length > 0) {
              map.set(chunk.chunkIndex, text);
            }
          }
        }
        chunkMaps.set(fileId, map);
        return map;
      } catch (error) {
        logger.debug('[SearchService] Failed to load chunk context map', {
          fileId,
          error: error.message
        });
        const empty = new Map();
        chunkMaps.set(fileId, empty);
        return empty;
      }
    };

    // Pre-load all chunk maps in parallel to avoid sequential I/O
    const uniqueFileIds = [
      ...new Set(candidates.map((/** @type {any} */ r) => r?.id).filter(Boolean))
    ];
    await Promise.allSettled(uniqueFileIds.map((id) => loadChunkMap(id)));

    for (const result of candidates) {
      const fileId = result?.id;
      const chunkIndex = result?.matchDetails?.chunkIndex;
      if (!fileId || !Number.isInteger(chunkIndex)) continue;

      const map = chunkMaps.get(fileId);
      if (!map || map.size === 0) continue;

      const snippets = [];
      for (
        let offset = -chunkContextMaxNeighbors;
        offset <= chunkContextMaxNeighbors;
        offset += 1
      ) {
        const neighborIndex = chunkIndex + offset;
        const text = map.get(neighborIndex);
        if (typeof text === 'string' && text.trim().length > 0) {
          snippets.push(text.trim());
        }
      }

      if (snippets.length === 0) continue;

      const combined = this._truncateText(snippets.join('\n'), chunkContextMaxChars);
      result.matchDetails = {
        ...result.matchDetails,
        contextSnippet: combined,
        contextSnippetLength: combined.length
      };
    }
  }

  async _applyGraphExpansion(/** @type {any} */ results = [], /** @type {any} */ options = {}) {
    const {
      graphExpansion = DEFAULT_OPTIONS.graphExpansion,
      graphExpansionWeight = DEFAULT_OPTIONS.graphExpansionWeight,
      graphExpansionMaxSeeds = DEFAULT_OPTIONS.graphExpansionMaxSeeds,
      graphExpansionMaxEdges = DEFAULT_OPTIONS.graphExpansionMaxEdges,
      graphExpansionMaxNeighbors = DEFAULT_OPTIONS.graphExpansionMaxNeighbors,
      graphExpansionMinWeight = DEFAULT_OPTIONS.graphExpansionMinWeight,
      graphExpansionDecay = DEFAULT_OPTIONS.graphExpansionDecay
    } = options;

    const enabled =
      Boolean(graphExpansion) &&
      Number.isFinite(graphExpansionWeight) &&
      graphExpansionWeight > 0 &&
      this.relationshipIndex;

    if (!enabled) {
      return { results, meta: { enabled: false, expanded: false, reason: 'disabled' } };
    }

    const seedResults = (results || [])
      .filter((/** @type {any} */ r) => r?.id)
      .slice(0, graphExpansionMaxSeeds);
    if (seedResults.length === 0) {
      return { results, meta: { enabled: false, expanded: false, reason: 'no-seeds' } };
    }

    const seedScores = new Map(seedResults.map((/** @type {any} */ r) => [r.id, r.score || 0]));
    const seedIds = Array.from(seedScores.keys());
    const seedSet = new Set(seedIds);

    let edgeResponse;
    try {
      edgeResponse = await this.relationshipIndex.getNeighborEdges(seedIds, {
        minWeight: graphExpansionMinWeight,
        maxEdges: graphExpansionMaxEdges,
        maxNeighbors: graphExpansionMaxNeighbors
      });
    } catch (error) {
      logger.debug('[SearchService] Graph expansion failed:', error?.message || error);
      return { results, meta: { enabled: false, expanded: false, reason: 'error' } };
    }

    const edges = Array.isArray(edgeResponse?.edges) ? edgeResponse.edges : [];
    if (edges.length === 0) {
      return {
        results,
        meta: { enabled: true, expanded: false, edgeCount: 0, neighborCount: 0, addedCount: 0 }
      };
    }

    // The spread into Math.max with an empty edges array would yield MIN_EPSILON,
    // but if all weights are literally 0, weightNorm = 0/0 = NaN, corrupting scores.
    const rawMaxWeight = edges.reduce(
      (/** @type {any} */ max, /** @type {any} */ edge) =>
        Math.max(max, typeof edge.weight === 'number' ? edge.weight : 0),
      0
    );
    const maxWeight = Math.max(SEARCH.MIN_EPSILON, rawMaxWeight);

    const neighborScores = new Map();
    const neighborDetails = new Map();

    for (const edge of edges) {
      const sourceIsSeed = seedSet.has(edge.source);
      const targetIsSeed = seedSet.has(edge.target);
      if (!sourceIsSeed && !targetIsSeed) continue;
      if (sourceIsSeed && targetIsSeed) continue;

      const seedId = sourceIsSeed ? edge.source : edge.target;
      const neighborId = sourceIsSeed ? edge.target : edge.source;
      if (!neighborId) continue;

      const seedScore = seedScores.get(seedId) || 0;
      const weight = typeof edge.weight === 'number' ? edge.weight : 0;
      const weightNorm = Math.min(1, weight / maxWeight);
      const graphScore = seedScore * weightNorm * graphExpansionDecay;
      if (graphScore <= 0) continue;

      const existingScore = neighborScores.get(neighborId) || 0;
      if (graphScore > existingScore) {
        neighborScores.set(neighborId, graphScore);
      }

      const connections = neighborDetails.get(neighborId) || [];
      if (connections.length < 3) {
        connections.push({
          seedId,
          weight,
          concepts: Array.isArray(edge.concepts) ? edge.concepts.slice(0, 5) : []
        });
      }
      neighborDetails.set(neighborId, connections);
    }

    const neighborEntries = Array.from(neighborScores.entries())
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, graphExpansionMaxNeighbors);

    const combined = new Map(
      results.map((/** @type {any} */ result) => [
        result.id,
        { ...result, graphScore: result.graphScore || 0 }
      ])
    );

    // Blend rank position AND edge strength so strong direct edges keep
    // outranking weak distant ones. The earlier post-2.0.9 formula
    // (`graphExpansionWeight * rrfContribution` only) ignored edge weight
    // entirely — at default RRF_K=60 the maximum rank-0 lift was
    // `0.2 * 1/61 ≈ 0.003`, which is essentially no boost at all and
    // produced the "Relate tab feels emptier" symptom. v2.0.9 used
    // `graphExpansionWeight * graphContribution` directly, which had the
    // opposite problem: a near-1.0 seed could push a graph-only neighbor
    // above every real match.
    //
    // Hybrid: lift = graphContribution * rrfNormalized, both in [0, 1].
    // - Top rank + strong edge:   1.0 * 1.0 = 1.0     → max lift
    // - Top rank + weak edge:     0.3 * 1.0 = 0.3     → preserves edge weight
    // - Lower rank + strong edge: 1.0 * 0.92 = 0.92   → mild rank decay
    // The graphExpansionWeight scalar still controls how much the graph
    // signal contributes overall, so existing tuning carries through.
    const rrfK = SEARCH.RRF_K;
    const rrfMax = 1 / (rrfK + 1);
    neighborEntries.forEach((entry, rank) => {
      const existing = combined.get(entry.id) || {
        id: entry.id,
        score: 0,
        metadata: this.documentMap.get(entry.id) || {},
        sources: [],
        matchDetails: { sources: [] }
      };

      const sources = new Set([
        ...(existing.sources || []),
        ...(existing.matchDetails?.sources || []),
        'graph'
      ]);

      const rrfContribution = 1 / (rrfK + rank + 1);
      const rrfNormalized = rrfMax > 0 ? rrfContribution / rrfMax : 0;
      const graphContribution = entry.score;
      const lift = graphContribution * rrfNormalized;
      const baseScore = existing.score || 0;
      const updatedScore = baseScore + graphExpansionWeight * lift;

      combined.set(entry.id, {
        ...existing,
        score: updatedScore,
        sources: Array.from(sources),
        graphScore: Math.max(existing.graphScore || 0, graphContribution),
        matchDetails: {
          ...existing.matchDetails,
          graph: {
            score: graphContribution,
            decay: graphExpansionDecay,
            connections: neighborDetails.get(entry.id) || []
          },
          sources: Array.from(sources)
        }
      });
    });

    const expandedResults = Array.from(combined.values()).sort(
      (a, b) => (b.score || 0) - (a.score || 0)
    );
    const addedCount = neighborEntries.filter((e) => !seedSet.has(e.id)).length;
    return {
      results: expandedResults,
      meta: {
        enabled: true,
        expanded: addedCount > 0,
        seedCount: seedIds.length,
        edgeCount: edges.length,
        neighborCount: neighborEntries.length,
        addedCount,
        weight: graphExpansionWeight,
        decay: graphExpansionDecay
      }
    };
  }

  /**
   * Enrich results with metadata from documentMap (AnalysisHistory).
   * This ensures we have the latest category, confidence, extractedText, etc.
   * even if the search source (e.g. vector DB) only stores basic fields.
   *
   * @param {any[]} results - Search results to enrich (mutated in place)
   */
  enrichResults(results) {
    if (!results || !Array.isArray(results) || this.documentMap.size === 0) return;

    for (const r of results) {
      if (!r.id) continue;
      const doc = this.documentMap.get(r.id);
      if (doc) {
        // Merge metadata, preferring documentMap (latest analysis) over vector metadata (embed time)
        // This ensures category, confidence, extractedText, etc. are up to date
        r.metadata = { ...r.metadata, ...doc };
      }
    }
  }

  /**
   * Normalize scores to [0, 1] range using min-max scaling
   *
   * @param {any[]} results - Array of results with scores
   * @returns {any[]} Results with normalized scores
   */
  _normalizeScores(results) {
    if (!results || results.length === 0) return results;

    // Use loop instead of Math.min/max spread to avoid RangeError on large arrays
    let minScore = Infinity;
    let maxScore = -Infinity;
    for (let i = 0; i < results.length; i++) {
      const s = results[i].score || 0;
      if (s < minScore) minScore = s;
      if (s > maxScore) maxScore = s;
    }
    const range = maxScore - minScore;

    // If all scores are identical, preserve the actual score clamped to [0, 1].
    // Returning 1.0 unconditionally would make five 0.1-similarity results look
    // like perfect matches — destroying the absolute quality signal that
    // downstream consumers (especially chat/RAG) rely on.
    if (range === 0) {
      const clamped = Math.min(1.0, Math.max(0, maxScore));
      return results.map((r) => ({ ...r, score: clamped, originalScore: r.score }));
    }

    return results.map((r) => ({
      ...r,
      score: ((typeof r.score === 'number' ? r.score : 0) - minScore) / range,
      originalScore: r.score
    }));
  }

  /**
   * Scale scores by the leg's best score (s / max), clamped to [0, 1].
   *
   * For BM25, whose raw score is a relevance magnitude that starts at 0.
   * Min-max mapped the weakest candidate in the window to exactly 0, so the
   * 40th keyword hit counted as "no keyword match" and two near-tied hits
   * (9.1 and 8.9) became 1.0 and 0.0.
   * @param {any[]} results
   * @returns {any[]}
   */
  _normalizeByMax(results) {
    if (!results || results.length === 0) return results;
    let maxScore = 0;
    for (let i = 0; i < results.length; i++) {
      const s = results[i].score || 0;
      if (s > maxScore) maxScore = s;
    }
    if (!(maxScore > 0)) {
      return results.map((r) => ({ ...r, score: 0, originalScore: r.score }));
    }
    return results.map((r) => {
      const raw = typeof r.score === 'number' ? r.score : 0;
      return { ...r, score: Math.min(1, Math.max(0, raw / maxScore)), originalScore: r.score };
    });
  }

  /**
   * Combine results using Reciprocal Rank Fusion with score normalization
   *
   * RRF formula: score(d) = sum(1 / (k + rank_i(d)))
   * Enhanced with optional weighted score blending for better ranking
   *
   * NOTE: This method is currently unused internally - hybrid search uses weighted sum fusion.
   * Kept for API consumers who may want RRF-style fusion.
   *
   * FIX MEDIUM-8: If calling with pre-normalized results, pass { normalizeScores: false }
   * to avoid double normalization and score distortion.
   *
   * @param {Array<any[]>} resultSets
   * @param {number} [k]
   * @param {any} [options]
   * @returns {any[]}
   */
  reciprocalRankFusion(resultSets, k = SEARCH.RRF_K, /** @type {any} */ options = {}) {
    const { normalizeScores = true, useScoreBlending = true } = options;

    const rrfScores = new Map();
    const originalScores = new Map(); // Track original scores for blending
    const resultData = new Map();
    const matchDetailsMap = new Map(); // Track and merge match details from all sources

    // Normalize scores within each result set for fair comparison
    const normalizedSets = normalizeScores
      ? resultSets.map((set) => this._normalizeScores(set))
      : resultSets;

    for (const results of normalizedSets) {
      for (let rank = 0; rank < results.length; rank++) {
        const result = results[rank];
        const id = result?.id;

        // Skip results with missing ID to prevent corruption
        if (!id) {
          logger.warn('[SearchService] Skipping result with missing id in RRF fusion');
          continue;
        }

        // RRF score contribution
        const rrfContribution = 1 / (k + rank + 1);
        rrfScores.set(id, (rrfScores.get(id) || 0) + rrfContribution);

        // Track normalized scores for blending
        if (useScoreBlending) {
          const currentMax = originalScores.get(id) || 0;
          originalScores.set(id, Math.max(currentMax, result.score || 0));
        }

        // Merge match details from all sources
        const existingDetails = matchDetailsMap.get(id) || { sources: [] };
        const newDetails = result.matchDetails || {};
        matchDetailsMap.set(id, {
          ...existingDetails,
          ...newDetails,
          sources: [...existingDetails.sources, result.source].filter(Boolean)
        });

        // Prefer vector search metadata (has current file names) over BM25 (may have old names)
        // Vector search uses the vector DB which is updated when files are organized
        const existing = resultData.get(id);
        if (!existing || (result.source === 'vector' && existing.source !== 'vector')) {
          resultData.set(id, result);
        }
      }
    }

    // Normalize RRF scores to [0, 1]
    // Use loop instead of Math.max(...spread) to avoid stack overflow on large result sets
    let maxRrf = SEARCH.MIN_EPSILON;
    for (const val of rrfScores.values()) {
      if (val > maxRrf) maxRrf = val;
    }

    // Sort by RRF score
    const fusedResults = Array.from(rrfScores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([id, rrfScore]) => {
        const original = resultData.get(id) || {};
        const normalizedRrf = rrfScore / maxRrf;

        // Blend RRF with original score for better ranking
        let finalScore = normalizedRrf;
        if (useScoreBlending && originalScores.has(id)) {
          const origScore = originalScores.get(id);
          finalScore =
            SEARCH.RRF_NORMALIZED_WEIGHT * normalizedRrf + SEARCH.RRF_ORIGINAL_WEIGHT * origScore;
        }

        return {
          id,
          score: finalScore,
          rrfScore: normalizedRrf,
          metadata: original.metadata || {},
          // instead of only the preferred result's single source
          sources: matchDetailsMap.get(id)?.sources?.filter(Boolean) || ['fused'],
          matchDetails: matchDetailsMap.get(id) || {}
        };
      });

    return fusedResults;
  }

  /**
   * Execute vector search with timeout, falling back to empty results on timeout
   * Properly clears timeout to prevent timer leaks
   *
   * @param {string} query
   * @param {number} topK
   * @param {number} [timeout]
   * @param {any} [options]
   * @returns {Promise<any>}
   */
  async _vectorSearchWithTimeout(
    query,
    topK,
    timeout = VECTOR_SEARCH_TIMEOUT,
    /** @type {any} */ options = {}
  ) {
    let timeoutId = null;
    // AbortController so a timeout stops the underlying vectorSearch at
    // the next await checkpoint instead of letting it keep running and
    // holding inference / model locks long after we've returned [] to the
    // caller. vectorSearch threads this signal through its own awaits.
    const ac = new AbortController();
    const signal = options.signal
      ? // Caller passed a signal — chain ours so either fires.
        (() => {
          const composite = new AbortController();
          const onAbort = () => composite.abort();
          ac.signal.addEventListener('abort', onAbort, { once: true });
          options.signal.addEventListener('abort', onAbort, { once: true });
          if (options.signal.aborted) composite.abort();
          return composite.signal;
        })()
      : ac.signal;

    try {
      const searchPromise = this.vectorSearch(query, topK, { ...options, signal }).then(
        (results) => {
          return { results, timedOut: false };
        }
      );

      searchPromise.catch((err) => {
        logger.debug('[SearchService] Vector search rejected after timeout', {
          error: err?.message || String(err)
        });
      });

      const result = await Promise.race([
        searchPromise,
        new Promise((resolve) => {
          timeoutId = setTimeout(() => resolve({ results: [], timedOut: true }), timeout);
        })
      ]);

      clearTimeout(timeoutId);
      // If we won via timeout, abort the underlying search so it stops
      // holding model/inference locks at its next await checkpoint.
      if (result.timedOut) ac.abort();
      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      ac.abort();
      if (error?.isDimensionMismatch) throw error;
      logger.warn('[SearchService] Vector search error, falling back:', error?.message);
      return { results: [], timedOut: false, error: error?.message || String(error) };
    }
  }

  /**
   * Build the query embedding with timeout protection.
   * Prevents hybrid search from appearing stuck when embedding generation is
   * blocked behind long-running inference jobs.
   *
   * @param {string} query - Query text used for semantic embedding
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<{embedding: {vector:number[]}|null, timedOut: boolean, error: string|null}>}
   */
  async _buildQueryEmbeddingWithTimeout(query, timeout = VECTOR_SEARCH_TIMEOUT) {
    if (!this.embedding || typeof this.embedding.embedText !== 'function') {
      return {
        embedding: null,
        timedOut: false,
        error: 'embedding service unavailable'
      };
    }

    let timeoutId = null;
    try {
      const embeddingPromise = Promise.resolve()
        .then(() => this.embedding.embedText(query))
        .then((rawEmbedding) => {
          const normalized = normalizePrecomputedEmbedding(rawEmbedding);
          if (!normalized) {
            return /** @type {Record<string, any>} */ ({
              embedding: null,
              timedOut: false,
              error: 'invalid embedding response'
            });
          }
          return { embedding: normalized, timedOut: false, error: null };
        });

      // Absorb rejection if timeout wins race (avoids unhandled rejection noise)
      embeddingPromise.catch((error) => {
        logger.debug('[SearchService] Query embedding rejected after timeout', {
          error: error?.message || String(error)
        });
      });

      const result = await Promise.race([
        embeddingPromise,
        new Promise((resolve) => {
          timeoutId = setTimeout(
            () =>
              resolve({
                embedding: null,
                timedOut: true,
                error: 'query embedding timeout'
              }),
            timeout
          );
        })
      ]);

      clearTimeout(timeoutId);
      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      return {
        embedding: null,
        timedOut: false,
        error: error?.message || 'query embedding failed'
      };
    }
  }

  /**
   * Filter results by minimum score threshold
   *
   * @param {any[]} results - Search results
   * @param {number} minScore - Minimum score threshold
   * @returns {any[]} Filtered results
   */
  _filterByScore(results, minScore) {
    if (!minScore || minScore <= 0) return results;
    const filtered = results.filter((r) => (r.score || 0) >= minScore);
    const removedCount = results.length - filtered.length;
    if (removedCount > 0) {
      const topRemoved = results
        .filter((r) => (r.score || 0) < minScore)
        .slice(0, 3)
        .map((r) => ({ score: r.score?.toFixed(3), id: r.id?.slice(-20) }));
      logger.debug(
        `[SearchService] Filtered out ${removedCount} results below minScore ${minScore}:`,
        topRemoved
      );
    }
    return filtered;
  }

  /**
   * Existence-validate score-sorted candidates in windows until `topK`
   * survivors are collected or the candidates run out. Fused hybrid result
   * sets can be far larger than a page; stat-ing every above-threshold hit
   * scaled I/O with corpus size instead of page size. A validation failure
   * degrades to the unvalidated window rather than dropping results.
   *
   * @param {any[]} candidates - Sorted by score, already minScore-filtered
   * @param {number} topK
   * @returns {Promise<any[]>} At most `topK` results in candidate order
   * @private
   */
  async _validateTopCandidates(candidates, topK) {
    /** @type {any[]} */
    const validated = [];
    let offset = 0;
    let ghostCount = 0;
    while (validated.length < topK && offset < candidates.length) {
      const shortfall = topK - validated.length;
      const window = candidates.slice(offset, offset + Math.max(1, shortfall * 2));
      offset += window.length;
      try {
        const outcome = await this._validateFileExistence(window);
        ghostCount += outcome.ghostCount || 0;
        validated.push(...outcome.validResults);
      } catch (validationErr) {
        logger.debug('[SearchService] File validation failed:', validationErr.message);
        validated.push(...window);
      }
    }
    if (ghostCount > 0) {
      logger.info('[SearchService] Removed ghost entries from results', { ghostCount });
    }
    return validated.slice(0, topK);
  }

  /**
   * Validate that files in search results still exist on disk
   * Removes ghost entries from results and, unless disabled, marks their
   * embeddings orphaned in the vector store (D5: never deletes them — see
   * the setImmediate block below).
   * FIX: Prevents returning search results for deleted files
   *
   * @param {any[]} results
   * @param {any} [options]
   * @returns {Promise<any>}
   * @private
   */
  async _validateFileExistence(results, /** @type {any} */ options = {}) {
    const { triggerCleanup = true } = options;
    const allowCleanup = triggerCleanup && !isGhostCleanupDeferred();

    if (!results || !Array.isArray(results) || results.length === 0) {
      return { validResults: [], ghostCount: 0 };
    }

    /** @type {any[]} */
    const validResults = [];
    /** @type {any[]} */
    const ghostIds = [];

    // 20 results previously required 20 serial filesystem round-trips.
    const checks = results.map(async (result) => {
      const filePath = result.metadata?.path;
      if (!filePath) return { result, exists: true }; // No path - can't validate, include anyway
      try {
        await fs.access(filePath);
        return { result, exists: true };
      } catch (err) {
        if (err.code === 'ENOENT') {
          const volumeRoot = path.parse(filePath).root;
          if (volumeRoot) {
            try {
              await fs.access(volumeRoot);
            } catch (volumeErr) {
              if (volumeErr?.code === 'ENOENT' || volumeErr?.code === 'EACCES') {
                logger.debug('[SearchService] Volume inaccessible; not treating ENOENT as ghost', {
                  path: filePath,
                  volumeRoot
                });
                return { result, exists: true };
              }
            }
          }
          return { result, exists: false };
        }
        // Non-ENOENT errors (permission denied, file locked, etc.) —
        // assume file still exists to avoid destroying embeddings for
        // temporarily inaccessible files.
        return { result, exists: true };
      }
    });

    const settled = await Promise.all(checks);

    for (const { result, exists } of settled) {
      if (exists) {
        validResults.push(result);
      } else {
        ghostIds.push(result.id);
        logger.debug('[SearchService] Ghost entry found in results:', {
          id: result.id,
          path: result.metadata?.path
        });
      }
    }

    // Hide ghost entries from future searches without blocking this response.
    // MARK, never delete (F-187 / K-10): a single ENOENT is not proof the file
    // is gone — a move whose path remap has not landed, an unmounted volume,
    // or a sync placeholder all look identical here. Orphaned rows are
    // filtered out of every query (`isOrphaned: false`), so the result is the
    // same for the user, but the vector survives and the next successful
    // re-index of that path clears the flag. Hard deletion is reserved for
    // the watcher's confirmed-unlink path and explicit rebuilds.
    if (allowCleanup && ghostIds.length > 0 && this.vectorDb) {
      // D5 (monotonic store): a search result whose path is missing is MARKED
      // orphaned, never deleted. Search already filters `isOrphaned: false`, and
      // the next upsert of the same id clears the flag — so a pending rename or
      // move no longer costs the user the vector.
      setImmediate(() => {
        (async () => {
          try {
            if (typeof this.vectorDb.markEmbeddingsOrphaned === 'function') {
              const outcome = await this.vectorDb.markEmbeddingsOrphaned(ghostIds);
              const marked = typeof outcome?.marked === 'number' ? outcome.marked : null;
              const failed = typeof outcome?.failed === 'number' ? outcome.failed : null;
              if (marked === 0 && !outcome?.skipped) {
                logger.warn('[SearchService] Ghost entries could not be marked orphaned', {
                  requested: ghostIds.length,
                  failed
                });
              } else if (outcome?.skipped) {
                logger.debug('[SearchService] Ghost marking skipped', {
                  requested: ghostIds.length,
                  reason: outcome.reason
                });
              } else {
                logger.info('[SearchService] Marked ghost entries orphaned', {
                  requested: ghostIds.length,
                  marked: marked ?? 'unknown',
                  failed: failed ?? 'unknown'
                });
              }
            }
          } catch (cleanupErr) {
            logger.warn('[SearchService] Failed to mark ghost entries:', cleanupErr.message);
          }
        })().catch((err) =>
          logger.error('[SearchService] Ghost mark unhandled error:', err.message)
        );
      });
    }

    return {
      validResults,
      ghostCount: ghostIds.length
    };
  }

  /**
   * Perform hybrid search combining BM25 and vector search
   *
   * Features:
   * - Score normalization before RRF fusion
   * - Timeout fallback to BM25-only on vector search timeout
   * - Minimum score filtering for quality control
   *
   * @param {string} query
   * @param {any} [options]
   * @returns {Promise<any>}
   */
  async hybridSearch(query, /** @type {any} */ options = {}) {
    const {
      topK = DEFAULT_OPTIONS.topK,
      mode: requestedMode = DEFAULT_OPTIONS.mode,
      minScore = DEFAULT_OPTIONS.minScore,
      chunkWeight = DEFAULT_OPTIONS.chunkWeight,
      chunkTopK,
      // Contextual chunk expansion
      chunkContext = DEFAULT_OPTIONS.chunkContext,
      chunkContextMaxNeighbors = DEFAULT_OPTIONS.chunkContextMaxNeighbors,
      chunkContextMaxFiles = DEFAULT_OPTIONS.chunkContextMaxFiles,
      chunkContextMaxChars = DEFAULT_OPTIONS.chunkContextMaxChars,
      // Query processing options
      expandSynonyms = DEFAULT_OPTIONS.expandSynonyms,
      correctSpelling = DEFAULT_OPTIONS.correctSpelling,
      // Re-ranking options
      rerank = DEFAULT_OPTIONS.rerank,
      rerankTopN = DEFAULT_OPTIONS.rerankTopN,
      // Graph expansion options
      graphExpansion = DEFAULT_OPTIONS.graphExpansion,
      graphExpansionWeight = DEFAULT_OPTIONS.graphExpansionWeight,
      graphExpansionMaxSeeds = DEFAULT_OPTIONS.graphExpansionMaxSeeds,
      graphExpansionMaxEdges = DEFAULT_OPTIONS.graphExpansionMaxEdges,
      graphExpansionMaxNeighbors = DEFAULT_OPTIONS.graphExpansionMaxNeighbors,
      graphExpansionMinWeight = DEFAULT_OPTIONS.graphExpansionMinWeight,
      graphExpansionDecay = DEFAULT_OPTIONS.graphExpansionDecay
    } = options;
    const mode =
      requestedMode === 'semantic'
        ? 'vector'
        : requestedMode === 'keyword'
          ? 'bm25'
          : requestedMode;
    const safeChunkWeight = Number.isFinite(chunkWeight)
      ? chunkWeight
      : DEFAULT_OPTIONS.chunkWeight;
    const resolvedChunkTopK = Number.isInteger(chunkTopK)
      ? chunkTopK
      : Math.min(topK * (SEARCH.CHUNK_TOP_K_MULTIPLIER || 3), 100);

    if (!query || typeof query !== 'string' || query.trim().length < 2) {
      return { success: false, results: [], error: 'Query too short' };
    }

    // BM25 can use synonym expansion, while vector/chunk search should use
    // spelling-corrected text (without synonym stuffing) for cleaner embeddings.
    const normalizedQuery = query.trim().replace(/\s+/g, ' ');

    // Check search cache — avoid redundant BM25/vector work for repeated queries.
    // Key must include every parameter that can change search results.
    const cacheKey = buildHybridSearchCacheKey(normalizedQuery, mode, topK, {
      minScore,
      chunkWeight: safeChunkWeight,
      chunkTopK: resolvedChunkTopK,
      chunkContext,
      chunkContextMaxNeighbors,
      chunkContextMaxFiles,
      chunkContextMaxChars,
      expandSynonyms,
      correctSpelling,
      rerank,
      rerankTopN,
      graphExpansion,
      graphExpansionWeight,
      graphExpansionMaxSeeds,
      graphExpansionMaxEdges,
      graphExpansionMaxNeighbors,
      graphExpansionMinWeight,
      graphExpansionDecay
    });
    const cached = this._searchCache.get(cacheKey);
    if (cached) {
      logger.debug('[SearchService] Cache hit', { queryLength: normalizedQuery.length });
      return { ...cached, results: cached.results.map((/** @type {any} */ r) => ({ ...r })) };
    }

    const inFlight = this._searchInFlight.get(cacheKey);
    if (inFlight) {
      logger.debug('[SearchService] Joining in-flight search', {
        queryLength: normalizedQuery.length
      });
      const result = await inFlight;
      return {
        ...result,
        results: (result.results || []).map((/** @type {any} */ r) => ({ ...r }))
      };
    }

    const searchDataRevision = this._searchDataRevision;
    const searchPromise = this._executeHybridSearchInternal(query, normalizedQuery, cacheKey, {
      topK,
      mode,
      minScore,
      // Callers that already hold the query embedding (chat retrieval) pass
      // it to skip a redundant inference call — forward it or the internal
      // re-embeds and can time out into bm25-fallback under load.
      precomputedEmbedding: options.precomputedEmbedding,
      safeChunkWeight,
      resolvedChunkTopK,
      chunkContext,
      chunkContextMaxNeighbors,
      chunkContextMaxFiles,
      chunkContextMaxChars,
      expandSynonyms,
      correctSpelling,
      rerank,
      rerankTopN,
      graphExpansion,
      graphExpansionWeight,
      graphExpansionMaxSeeds,
      graphExpansionMaxEdges,
      graphExpansionMaxNeighbors,
      graphExpansionMinWeight,
      graphExpansionDecay,
      searchDataRevision
    });
    this._searchInFlight.set(cacheKey, searchPromise);
    try {
      return await searchPromise;
    } finally {
      if (this._searchInFlight.get(cacheKey) === searchPromise) {
        this._searchInFlight.delete(cacheKey);
      }
    }
  }

  async _executeHybridSearchInternal(
    /** @type {any} */ query,
    /** @type {any} */ normalizedQuery,
    /** @type {any} */ cacheKey,
    /** @type {any} */ options
  ) {
    const {
      topK,
      mode,
      minScore,
      safeChunkWeight,
      resolvedChunkTopK,
      chunkContext,
      chunkContextMaxNeighbors,
      chunkContextMaxFiles,
      chunkContextMaxChars,
      expandSynonyms,
      correctSpelling,
      rerank,
      rerankTopN,
      graphExpansion,
      graphExpansionWeight,
      graphExpansionMaxSeeds,
      graphExpansionMaxEdges,
      graphExpansionMaxNeighbors,
      graphExpansionMinWeight,
      graphExpansionDecay
    } = options;

    systemAnalytics.recordSearchRequest({ mode });

    if (ENABLE_SEARCH_TRACE_LOGS) {
      logger.info('[SearchService] Search started', {
        query: query.substring(0, 100),
        mode,
        topK
      });
    }
    let semanticQuery = normalizedQuery;
    let queryExpanded = false;
    let processedQuery = normalizedQuery;
    let queryMeta = null;

    // Process query through QueryProcessor (spell correction + synonyms)
    // Start with normalized query, then optionally expand with synonyms
    const queryProcessor = this._getQueryProcessor();

    if (queryProcessor) {
      try {
        // Extract filters (years) to boost relevance
        const filters = queryProcessor.extractFilters(query);
        const boostedYear = filters.year ? `${filters.year} ${filters.year}` : '';
        if (filters.year) {
          logger.debug('[SearchService] Detected year filter:', filters.year);
        }

        if (expandSynonyms || correctSpelling) {
          const processed = await queryProcessor.processQuery(query, {
            expandSynonyms,
            correctSpelling,
            maxSynonymsPerWord: 3
          });
          // Use corrected query for vector/chunk semantic retrieval.
          const correctedQuery =
            typeof processed.corrected === 'string' && processed.corrected.trim().length > 0
              ? processed.corrected.trim().replace(/\s+/g, ' ')
              : normalizedQuery;
          semanticQuery = correctedQuery;

          // If we added a year boost, append it to the expanded BM25 query.
          const baseExpanded = processed.expanded || correctedQuery;
          processedQuery = filters.year ? `${baseExpanded} ${boostedYear}` : baseExpanded;
          queryExpanded = processedQuery !== normalizedQuery || semanticQuery !== normalizedQuery;

          queryMeta = {
            original: processed.original,
            corrected: correctedQuery,
            expanded: processed.expanded,
            corrections: processed.corrections,
            synonymsAdded: processed.synonymsAdded?.length || 0,
            filters
          };

          if (processed.corrections?.length > 0) {
            logger.debug('[SearchService] Query corrections applied:', processed.corrections);
          }
        }
      } catch (procErr) {
        logger.debug('[SearchService] Query processing failed, using original:', procErr.message);
      }
    }

    try {
      // Log collection and index status to aid troubleshooting
      try {
        const stats = await this.vectorDb?.getStats?.();
        const bm25Status = this.getIndexStatus();
        logger.debug('[SearchService] Search preflight status', {
          fileEmbeddings: stats?.files || 0,
          chunkEmbeddings: stats?.fileChunks || 0,
          bm25Indexed: bm25Status.documentCount,
          bm25Stale: bm25Status.isStale,
          topK,
          minScore,
          mode,
          chunkTopK: resolvedChunkTopK,
          chunkWeight: safeChunkWeight,
          queryExpanded
        });
      } catch (statusErr) {
        logger.debug('[SearchService] Failed to gather preflight status', {
          error: statusErr.message
        });
      }

      // Ensure BM25 index is up to date
      if (this.isIndexStale()) {
        await this.buildBM25Index();
      }

      // Handle different search modes
      if (mode === 'bm25') {
        // Use expanded query for BM25 (benefits from synonyms)
        const results = await this.bm25Search(processedQuery, topK);
        let filtered = this._filterByScore(results, minScore);
        try {
          const { validResults, ghostCount } = await this._validateFileExistence(filtered);
          if (ghostCount > 0) {
            logger.info('[SearchService] Removed ghost entries from bm25 results', { ghostCount });
            filtered = validResults;
          }
        } catch (validationErr) {
          logger.debug('[SearchService] Ghost-file validation failed for bm25', {
            error: validationErr.message
          });
        }
        return { success: true, results: filtered, mode: 'bm25', queryMeta };
      }

      if (mode === 'vector') {
        const results = await this.vectorSearch(semanticQuery, topK);
        this.enrichResults(results);
        let filtered = this._filterByScore(results, minScore);
        try {
          const { validResults, ghostCount } = await this._validateFileExistence(filtered);
          if (ghostCount > 0) {
            logger.info('[SearchService] Removed ghost entries from vector results', {
              ghostCount
            });
            filtered = validResults;
          }
        } catch (validationErr) {
          logger.debug('[SearchService] Ghost-file validation failed for vector', {
            error: validationErr.message
          });
        }
        return { success: true, results: filtered, mode: 'vector', queryMeta };
      }

      // Hybrid mode: combine both search types with timeout protection
      // generating the same query embedding twice (saves one LLM inference call per search)
      const bm25Promise = this.bm25Search(processedQuery, topK * 2);
      let precomputedEmbedding = normalizePrecomputedEmbedding(options.precomputedEmbedding);
      let embeddingTimedOut = false;
      let embeddingFailureReason = null;
      if (!precomputedEmbedding) {
        const embeddingResult = await this._buildQueryEmbeddingWithTimeout(
          semanticQuery,
          VECTOR_SEARCH_TIMEOUT
        );
        precomputedEmbedding = embeddingResult.embedding;
        embeddingTimedOut = Boolean(embeddingResult.timedOut);
        if (!precomputedEmbedding) {
          embeddingFailureReason = embeddingResult.error || 'query embedding unavailable';
          logger.warn('[SearchService] Query embedding unavailable; using BM25 fallback', {
            reason: embeddingFailureReason,
            timedOut: embeddingTimedOut
          });
        }
      }

      const bm25Results = await bm25Promise;
      if (!precomputedEmbedding) {
        systemAnalytics.recordSearchFallback('query_embedding_unavailable');
        let filtered = this._filterByScore(bm25Results.slice(0, topK), minScore);
        try {
          const { validResults, ghostCount } = await this._validateFileExistence(filtered, {
            triggerCleanup: true
          });
          if (ghostCount > 0) {
            logger.info('[SearchService] Removed ghost entries from BM25 fallback results', {
              ghostCount
            });
            filtered = validResults;
          }
        } catch (validationErr) {
          logger.debug('[SearchService] Ghost-file validation failed for bm25 fallback', {
            error: validationErr.message
          });
        }
        return {
          success: true,
          results: filtered,
          mode: 'bm25-fallback',
          queryMeta,
          meta: {
            fallback: true,
            fallbackReason: embeddingFailureReason || 'query embedding unavailable',
            originalMode: 'hybrid',
            vectorTimedOut: embeddingTimedOut,
            bm25Count: bm25Results.length,
            queryExpanded,
            warnings: [
              {
                type: 'QUERY_EMBEDDING_UNAVAILABLE',
                severity: embeddingTimedOut ? 'high' : 'medium',
                message: embeddingTimedOut
                  ? 'Semantic query embedding timed out; using keyword fallback.'
                  : 'Semantic query embedding unavailable; using keyword fallback.'
              }
            ]
          }
        };
      }

      // Both searches use the same precomputedEmbedding against separate read-only
      // Orama collections — fire them in parallel to eliminate the sequential wait.
      const [{ results: vectorResults, timedOut, error: vectorLegError }, chunkResults] =
        await Promise.all([
          this._vectorSearchWithTimeout(semanticQuery, topK * 2, undefined, {
            precomputedEmbedding,
            propagateErrors: true
          }),
          safeChunkWeight > 0 && resolvedChunkTopK > 0
            ? this.chunkSearch(semanticQuery, topK * 2, resolvedChunkTopK, {
                chunkContext,
                chunkContextMaxNeighbors,
                chunkContextMaxFiles,
                chunkContextMaxChars,
                precomputedEmbedding
              })
            : Promise.resolve([])
        ]);
      const vectorHealth =
        typeof this.vectorDb?.getVectorHealth === 'function'
          ? this.vectorDb.getVectorHealth()
          : null;

      // If the vector leg timed out OR hard-errored, use BM25-only with an
      // explicit degraded mode indicator. Both failure shapes must degrade
      // identically: fusing an empty vector leg as "hybrid" caps combined
      // scores at the BM25 weight and silently drops hits below minScore.
      // An EMPTY vector leg (nothing embedded yet, or an index that shrank to a
      // few rows) is not an error, but fusing it has the same effect: every
      // BM25 hit is scaled by the BM25 weight and dropped by minScore, so
      // search "returns nothing" for files the keyword index knows about
      // (F-207 / K-26). Degrade to BM25-only exactly like a failed leg.
      const vectorLegEmpty =
        !timedOut &&
        !vectorLegError &&
        vectorResults.length === 0 &&
        (!Array.isArray(chunkResults) || chunkResults.length === 0) &&
        bm25Results.length > 0;

      if (timedOut || vectorLegError || vectorLegEmpty) {
        logger.warn(
          timedOut
            ? '[SearchService] Vector search timed out, using BM25-only fallback'
            : vectorLegError
              ? `[SearchService] Vector search failed (${vectorLegError}), using BM25-only fallback`
              : '[SearchService] Vector leg returned no results, using BM25-only fallback'
        );
        systemAnalytics.recordSearchFallback(
          timedOut
            ? 'vector_search_timeout'
            : vectorLegError
              ? 'vector_search_error'
              : 'vector_leg_empty'
        );
        let filtered = this._filterByScore(bm25Results.slice(0, topK), minScore);
        try {
          const { validResults, ghostCount } = await this._validateFileExistence(filtered, {
            triggerCleanup: true
          });
          if (ghostCount > 0) {
            logger.info(
              '[SearchService] Removed ghost entries from BM25 timeout fallback results',
              {
                ghostCount
              }
            );
            filtered = validResults;
          }
        } catch (validationErr) {
          logger.debug('[SearchService] Ghost-file validation failed for bm25 timeout fallback', {
            error: validationErr.message
          });
        }
        return {
          success: true,
          results: filtered,
          mode: 'bm25-fallback',
          queryMeta,
          meta: {
            fallback: true,
            fallbackReason: timedOut
              ? 'vector search timeout'
              : vectorLegError
                ? `vector search error: ${vectorLegError}`
                : 'vector leg empty (nothing embedded yet or index incomplete)',
            originalMode: 'hybrid',
            vectorTimedOut: timedOut,
            ...(vectorLegError && { vectorError: vectorLegError }),
            bm25Count: bm25Results.length,
            queryExpanded
          }
        };
      }

      // Enrich vector/chunk results with up-to-date metadata from documentMap if available
      this.enrichResults(vectorResults);
      this.enrichResults(chunkResults);

      // Log search results for debugging
      logger.debug('[SearchService] Hybrid search results:', {
        vectorCount: vectorResults.length,
        bm25Count: bm25Results.length,
        chunkCount: chunkResults.length
      });

      // Quick peek at top scores/ids for troubleshooting (redacted to last path segment)
      const peek = (/** @type {any} */ arr) =>
        arr.slice(0, 3).map((/** @type {any} */ r) => ({
          score: r.score?.toFixed?.(3),
          id: r.id?.split(/[\\/]/).pop()
        }));
      if (vectorResults.length || bm25Results.length || chunkResults.length) {
        logger.debug('[SearchService] Top candidates preview', {
          vectorTop: peek(vectorResults),
          bm25Top: peek(bm25Results),
          chunkTop: peek(chunkResults)
        });
      }

      // Normalize scores within each source so weights are comparable. BM25 is
      // scaled by its best hit (see _normalizeByMax); the vector legs keep
      // min-max until they are recalibrated against real cosine distributions.
      const normalizedBm25 = this._normalizeByMax(bm25Results).map((r) => ({
        ...r,
        bm25Score: r.score,
        bm25RawScore: r.originalScore ?? r.score
      }));
      const normalizedVector = this._normalizeScores(vectorResults).map((r) => ({
        ...r,
        vectorScore: r.score,
        vectorRawScore: r.originalScore ?? r.score
      }));
      const normalizedChunks = this._normalizeScores(chunkResults).map((r) => ({
        ...r,
        chunkScore: r.score,
        chunkRawScore: r.originalScore ?? r.score
      }));

      // Weighted hybrid fusion (simple weighted sum of normalized scores)
      // Keep BM25 weight as configured; split remaining weight between file-vector and chunk-vector.
      const beta = SEARCH.BM25_WEIGHT;
      const remaining = Math.max(0, 1 - beta);
      const chunkShare = Math.min(1, Math.max(0, Number(safeChunkWeight)));
      const gamma = remaining * chunkShare;
      const alpha = remaining - gamma;
      // Renormalize over the legs that returned anything for THIS query. A leg
      // with no hits (chunk vectors not built yet, no keyword match) kept its
      // weight in the sum, so every score was capped at the weight of the legs
      // that did answer and the minScore floor cut honest matches. The factor
      // is the same for every result, so the ranking does not change.
      const answeringWeight =
        (bm25Results.length > 0 ? beta : 0) +
        (vectorResults.length > 0 ? alpha : 0) +
        (chunkResults.length > 0 ? gamma : 0);
      const queryScale = answeringWeight > 0 ? 1 / answeringWeight : 1;
      const vectorLegsAnswered = vectorResults.length > 0 || chunkResults.length > 0;
      const isKnownUnembedded =
        typeof this.vectorDb?.isKnownUnembedded === 'function'
          ? (/** @type {string} */ id) => this.vectorDb.isKnownUnembedded(id)
          : () => false;
      const combined = new Map();

      const upsert = (/** @type {any} */ entry, /** @type {any} */ source) => {
        if (!entry?.id) return;
        const existing = combined.get(entry.id) || {
          id: entry.id,
          metadata: entry.metadata || {},
          matchDetails: { sources: [] }
        };

        // Prefer vector metadata when available
        const metadata =
          source === 'vector' || source === 'chunk'
            ? entry.metadata || existing.metadata
            : existing.metadata || entry.metadata || {};

        // Merge matchDetails and sources
        const mergedMatchDetails = {
          ...existing.matchDetails,
          ...entry.matchDetails,
          sources: [...(existing.matchDetails.sources || []), source].filter(Boolean)
        };

        combined.set(entry.id, {
          ...existing,
          metadata,
          matchDetails: mergedMatchDetails,
          bm25Score:
            source === 'bm25' ? (entry.bm25Score ?? existing.bm25Score) : existing.bm25Score,
          bm25RawScore:
            source === 'bm25'
              ? (entry.bm25RawScore ?? existing.bm25RawScore)
              : existing.bm25RawScore,
          vectorScore:
            source === 'vector'
              ? (entry.vectorScore ?? existing.vectorScore)
              : existing.vectorScore,
          vectorRawScore:
            source === 'vector'
              ? (entry.vectorRawScore ?? existing.vectorRawScore)
              : existing.vectorRawScore,
          chunkScore:
            source === 'chunk' ? (entry.chunkScore ?? existing.chunkScore) : existing.chunkScore,
          chunkRawScore:
            source === 'chunk'
              ? (entry.chunkRawScore ?? existing.chunkRawScore)
              : existing.chunkRawScore
        });
      };

      normalizedBm25.forEach((r) => upsert(r, 'bm25'));
      normalizedVector.forEach((r) => upsert(r, 'vector'));
      normalizedChunks.forEach((r) => upsert(r, 'chunk'));

      const fusedResults = Array.from(combined.values())
        .map((item) => {
          const semantic = item.vectorScore ?? 0;
          const chunk = item.chunkScore ?? 0;
          const keyword = item.bm25Score ?? 0;
          // A file analyzed but never embedded cannot appear in either vector
          // leg, so a zero there means "no data", not "dissimilar". Score it on
          // the one leg that could see it. Otherwise, with partial coverage
          // (11 of 281 files embedded on one real library), every keyword
          // match on the other 270 was capped at the BM25 weight and cut.
          const keywordOnly =
            item.vectorScore === undefined &&
            item.chunkScore === undefined &&
            vectorLegsAnswered &&
            isKnownUnembedded(item.id);
          const combinedScore = keywordOnly
            ? keyword
            : (alpha * semantic + gamma * chunk + beta * keyword) * queryScale;

          return {
            id: item.id,
            score: combinedScore,
            metadata: item.metadata || {},
            sources: item.matchDetails?.sources || ['hybrid'],
            matchDetails: {
              ...item.matchDetails,
              hybrid: {
                semanticScore: semantic,
                chunkScore: chunk,
                keywordScore: keyword,
                combinedScore,
                semanticWeight: alpha,
                chunkWeight: gamma,
                keywordWeight: beta,
                queryScale,
                keywordOnly,
                bm25RawScore: item.bm25RawScore,
                vectorRawScore: item.vectorRawScore,
                chunkRawScore: item.chunkRawScore
              }
            }
          };
        })
        .sort((a, b) => (b.score || 0) - (a.score || 0));

      // Floor the DIRECT matches before graph expansion. A graph-only
      // neighbour scores seed x edge x decay x weight <= 1 x 1 x 0.6 x 0.2 =
      // 0.12, under the 0.15 floor by construction, so flooring afterwards
      // dropped every neighbour the expansion found while meta.addedCount
      // still reported them. Neighbours rank below direct matches and only
      // fill slots the direct matches leave open.
      // Also BEFORE truncating to topK: filtering after the slice let
      // below-threshold entries occupy topK slots.
      const directMatches = this._filterByScore(fusedResults, minScore);

      const graphExpansionResult = await this._applyGraphExpansion(directMatches, {
        graphExpansion,
        graphExpansionWeight,
        graphExpansionMaxSeeds,
        graphExpansionMaxEdges,
        graphExpansionMaxNeighbors,
        graphExpansionMinWeight,
        graphExpansionDecay
      });

      const scoredResults = graphExpansionResult.results;
      let filteredResults = await this._validateTopCandidates(scoredResults, topK);

      // Apply LLM re-ranking if enabled
      let reranked = false;
      const reRanker = this._getReRanker();

      if (rerank && reRanker && reRanker.isAvailable() && filteredResults.length > 1) {
        try {
          logger.debug('[SearchService] Applying LLM re-ranking to top results', {
            candidateCount: filteredResults.length,
            rerankTopN
          });

          const rerankStartTime = Date.now();
          const RERANK_TIMEOUT_MS = TIMEOUTS.API_REQUEST_SLOW;
          const rerankAbortController = new AbortController();
          let rerankTimeoutId = null;
          try {
            filteredResults = await Promise.race([
              reRanker.rerank(query, filteredResults, {
                topN: rerankTopN,
                signal: rerankAbortController.signal
              }),
              new Promise((_, reject) => {
                rerankTimeoutId = setTimeout(() => {
                  rerankAbortController.abort();
                  reject(new Error('Re-ranking timed out'));
                }, RERANK_TIMEOUT_MS);
                if (typeof rerankTimeoutId.unref === 'function') {
                  rerankTimeoutId.unref();
                }
              })
            ]);
          } finally {
            if (rerankTimeoutId) {
              clearTimeout(rerankTimeoutId);
            }
          }
          reranked = true;

          logger.debug('[SearchService] Re-ranking complete', {
            latencyMs: Date.now() - rerankStartTime
          });
        } catch (rerankErr) {
          logger.warn('[SearchService] Re-ranking failed, using fusion order:', rerankErr.message);
        }
      }

      // Build diagnostic warnings for common issues
      const diagnosticWarnings = [];

      // CRITICAL: Vector search returning 0 results when BM25 has results indicates dimension mismatch
      if (
        vectorResults.length === 0 &&
        bm25Results.length > 0 &&
        vectorHealth?.primaryHealthy === false
      ) {
        diagnosticWarnings.push({
          type: 'VECTOR_SEARCH_EMPTY',
          severity: 'critical',
          message:
            'Vector search returned 0 results while primary vector path is degraded. Run "Rebuild Embeddings" to restore semantic search quality.'
        });
        logger.warn('[SearchService] Vector search empty and vector path degraded', {
          bm25Count: bm25Results.length,
          queryLength: typeof query === 'string' ? query.length : 0,
          vectorHealth
        });

        // Auto-run full diagnostics when critical issue detected
        this._autoRunDiagnostics(
          'Vector search returned 0 results while vector health is degraded'
        );
      }

      // Vector + BM25 both empty: check if embeddings exist but are orphaned or unavailable
      if (vectorResults.length === 0 && bm25Results.length === 0) {
        try {
          const stats = await this.vectorDb.getStats();
          const fileCount = stats?.files || 0;
          if (fileCount === 0) {
            diagnosticWarnings.push({
              type: 'VECTOR_DB_EMPTY',
              severity: 'medium',
              message: 'No embeddings are available yet. Analyze files or run "Rebuild Embeddings".'
            });
          } else {
            diagnosticWarnings.push({
              type: 'VECTOR_SEARCH_EMPTY',
              severity: 'high',
              message:
                'Search returned no results while embeddings exist. This can indicate all embeddings are orphaned or the embedding model is unavailable.'
            });
            try {
              const orphaned = await this.vectorDb.getOrphanedEmbeddings();
              if (orphaned.length >= fileCount) {
                diagnosticWarnings.push({
                  type: 'ALL_EMBEDDINGS_ORPHANED',
                  severity: 'high',
                  message:
                    'All embeddings appear orphaned. Run "Rebuild Embeddings" or rescan your folders.'
                });
              }
            } catch (orphanErr) {
              // why-silent: orphan check is diagnostic-only; failure here just
              // means we can't add the ALL_EMBEDDINGS_ORPHANED warning. The
              // outer VECTOR_DB_EMPTY warning is still reported. Log so an
              // ops-visible vector-DB outage shows up in JSONL during the
              // user's empty-search session.
              logger.debug?.('[SearchService] Orphan-embedding check failed (diagnostic only)', {
                code: orphanErr?.code,
                error: orphanErr?.message
              });
            }
            this._autoRunDiagnostics('Search returned no results while embeddings exist');
          }
        } catch (outerErr) {
          // why-silent: outer block also runs diagnostic enrichment only;
          // primary search result above is already returned. Debug-log so a
          // breaking change in the diagnostic stmt's API is at least visible.
          logger.debug?.('[SearchService] Diagnostic enrichment failed', {
            code: outerErr?.code,
            error: outerErr?.message
          });
        }
      }

      // Chunk search empty when file embeddings exist indicates chunks weren't built
      if (chunkResults.length === 0 && vectorResults.length > 0) {
        // Only warn if file collection has entries (otherwise chunk collection being empty is expected)
        try {
          const stats = await this.vectorDb.getStats();
          const chunkCount = stats?.fileChunks || 0;
          if (chunkCount === 0) {
            diagnosticWarnings.push({
              type: 'CHUNKS_NOT_BUILT',
              severity: 'medium',
              message:
                'Chunk embeddings not built. Deep text search unavailable. Run "Rebuild Embeddings" to enable.'
            });
          }
        } catch {
          // Non-critical
        }
      }

      // High filter rate indicates potential score calibration issues
      if (fusedResults.length > 0 && filteredResults.length === 0) {
        diagnosticWarnings.push({
          type: 'ALL_RESULTS_FILTERED',
          severity: 'high',
          message: `All ${fusedResults.length} results were filtered out by minScore=${minScore}. Consider lowering the threshold.`
        });
        // Auto-run diagnostics when all results filtered
        this._autoRunDiagnostics(
          `All ${fusedResults.length} results filtered out by minScore=${minScore}`
        );
      } else if (fusedResults.length > filteredResults.length * 2) {
        diagnosticWarnings.push({
          type: 'HIGH_FILTER_RATE',
          severity: 'low',
          message: `${fusedResults.length - filteredResults.length} of ${fusedResults.length} results filtered by minScore=${minScore}.`
        });
      }

      // Detect if vector search effectively failed (dimension mismatch or other issue)
      const vectorSearchFailed =
        vectorResults.length === 0 &&
        bm25Results.length > 0 &&
        vectorHealth?.primaryHealthy === false;
      if (vectorSearchFailed) {
        systemAnalytics.recordSearchFallback('primary_vector_path_degraded');
      }

      // Log the complete search journey for operational observability
      if (ENABLE_SEARCH_TRACE_LOGS) {
        logger.info('[SearchService] Search complete', {
          query: normalizedQuery.substring(0, 100),
          mode: reranked ? 'hybrid-reranked' : 'hybrid',
          resultCount: filteredResults.length,
          vectorResults: vectorResults.length,
          bm25Results: bm25Results.length,
          chunkResults: chunkResults.length,
          fusedBeforeFilter: fusedResults.length,
          weights: { vector: +alpha.toFixed(3), bm25: +beta.toFixed(3), chunk: +gamma.toFixed(3) },
          graphExpanded: graphExpansionResult.meta?.expanded || false,
          reranked,
          queryExpanded: processedQuery !== query,
          topResult: filteredResults[0]
            ? {
                id: filteredResults[0].id?.split(/[\\/]/).pop(),
                score: +filteredResults[0].score?.toFixed(4)
              }
            : null
        });
      }

      const hybridResult = {
        success: true,
        results: filteredResults,
        mode: reranked ? 'hybrid-reranked' : 'hybrid',
        queryMeta,
        meta: {
          vectorCount: vectorResults.length,
          bm25Count: bm25Results.length,
          chunkCount: chunkResults.length,
          fusedCount: fusedResults.length,
          filteredCount: filteredResults.length,
          minScoreApplied: minScore,
          weights: { vector: alpha, bm25: beta, chunk: gamma },
          queryScale,
          graphExpansion: graphExpansionResult.meta,
          reranked,
          queryExpanded: processedQuery !== query,
          vectorHealth,
          // Signal fallback when vector search effectively unavailable
          ...(vectorSearchFailed && {
            fallback: true,
            fallbackReason: 'primary vector path degraded',
            originalMode: 'hybrid'
          }),
          // Include warnings if any issues detected
          ...(diagnosticWarnings.length > 0 && { warnings: diagnosticWarnings })
        }
      };

      // Cache successful hybrid results for quick re-use
      if (options.searchDataRevision === this._searchDataRevision) {
        this._searchCache.set(cacheKey, hybridResult);
      }

      return hybridResult;
    } catch (error) {
      logger.error('[SearchService] Hybrid search failed:', error);

      // Last resort: try BM25-only on complete failure
      // Use processedQuery (spell-corrected + synonym-expanded) when available; fall back to
      // the raw query only if query processing itself was the source of the error.
      const fallbackQuery = processedQuery || query;
      try {
        const bm25Results = await this.bm25Search(fallbackQuery, topK);
        if (bm25Results.length > 0) {
          logger.info('[SearchService] Falling back to BM25-only after hybrid failure');
          systemAnalytics.recordSearchFallback('hybrid_search_error');
          const filtered = this._filterByScore(bm25Results, minScore);
          return {
            success: true,
            results: filtered,
            mode: 'bm25-fallback',
            queryMeta,
            meta: {
              fallback: true,
              fallbackReason: error.isDimensionMismatch ? error.message : 'hybrid search error',
              originalMode: 'hybrid',
              hybridError: error.message,
              // Surface the model-change mismatch through the diagnostics
              // banner (meta.warnings) instead of degrading silently.
              ...(error.isDimensionMismatch && {
                requiresRebuild: true,
                warnings: [
                  {
                    type: 'VECTOR_DIMENSION_MISMATCH',
                    severity: 'high',
                    message: error.message
                  }
                ]
              })
            }
          };
        }
      } catch (bm25Error) {
        logger.error('[SearchService] BM25 fallback also failed:', bm25Error);
      }

      return /** @type {Record<string, any>} */ ({
        success: false,
        results: [],
        error: error.message
      });
    }
  }

  /**
   * Get the current index status
   *
   * @returns {any} Index status information
   */
  getIndexStatus() {
    return {
      hasIndex: !!this.bm25Index,
      documentCount: this.documentMap.size,
      indexBuiltAt: this.indexBuiltAt,
      indexVersion: this.indexVersion,
      isStale: this.isIndexStale()
    };
  }

  /**
   * Force rebuild the BM25 index
   *
   * @returns {Promise<Object>} Build result
   */
  async rebuildIndex() {
    return this.buildBM25Index();
  }

  /**
   * Clear the BM25 index
   */
  clearIndex() {
    this.bm25Index = null;
    this.documentMap.clear();
    this.indexBuiltAt = null;
    this.invalidateSearchResults('clear-index');
    logger.info('[SearchService] BM25 index cleared');
  }

  /**
   * Invalidate the BM25 index to force rebuild on next search
   * Call this after file moves/deletes to ensure fresh results
   *
   * @param {any} [options]
   */
  invalidateIndex(/** @type {any} */ options = {}) {
    const { reason = 'manual', oldPath, newPath } = options;

    // Mark index as stale by setting indexBuiltAt to past
    if (this.indexBuiltAt) {
      this.indexBuiltAt = 0;
      logger.info('[SearchService] BM25 index invalidated', { reason, oldPath, newPath });
    }

    // Clear serialized cache to force full rebuild
    this._serializedIndex = null;
    this._serializedDocMap = null;

    // Invalidate search result cache — underlying data has changed
    this.invalidateSearchResults(reason);
  }

  /**
   * Invalidate and optionally immediately rebuild the BM25 index
   * Use this for critical path updates where search results must be consistent immediately
   *
   * @param {any} [options]
   * @returns {Promise<any>}
   */
  async invalidateAndRebuild(/** @type {any} */ options = {}) {
    const { immediate = true, reason = 'manual', oldPath, newPath } = options;

    // First invalidate the index
    this.invalidateIndex({ reason, oldPath, newPath });

    if (immediate) {
      // during batch operations (e.g., moving 50 files triggers 50 invalidations).
      // Callers get a promise that resolves once the coalesced rebuild completes.
      return new Promise((resolve) => {
        this._rebuildDebounceResolvers.push(resolve);

        if (this._rebuildDebounceTimer) {
          clearTimeout(this._rebuildDebounceTimer);
        }

        this._rebuildDebounceTimer = setTimeout(async () => {
          this._rebuildDebounceTimer = null;
          const resolvers = this._rebuildDebounceResolvers.splice(0);

          try {
            logger.info('[SearchService] Triggering debounced BM25 rebuild', {
              reason,
              coalescedRequests: resolvers.length
            });
            const result = await this.buildBM25Index();
            const response = {
              success: result.success,
              rebuilt: true,
              indexed: result.indexed,
              error: result.error
            };
            for (const r of resolvers) r(response);
          } catch (error) {
            logger.warn('[SearchService] Debounced rebuild failed', { error: error.message });
            const response = {
              success: false,
              rebuilt: false,
              error: error.message
            };
            for (const r of resolvers) r(response);
          }
        }, this._REBUILD_DEBOUNCE_MS);
      });
    }

    // If not immediate, just return success (index will rebuild on next search)
    return { success: true, rebuilt: false };
  }

  /**
   * Warm up the search service by pre-building indices
   * Call this during app startup for faster first search
   *
   * @param {any} [options]
   * @returns {Promise<any>}
   */
  async warmUp(/** @type {any} */ options = {}) {
    const { buildBM25 = true, warmVectorDb = true } = options;
    const result = { success: true, bm25Indexed: 0, vectorDbReady: false };

    try {
      logger.info('[SearchService] Starting warm-up...');

      const tasks = [];

      // Build BM25 index in background
      if (buildBM25) {
        tasks.push(
          this.buildBM25Index()
            .then((res) => {
              result.bm25Indexed = res.indexed || 0;
              return res;
            })
            .catch((err) => {
              logger.warn('[SearchService] BM25 warm-up failed:', err?.message);
              throw err;
            })
        );
      }

      // Warm vector DB connection
      if (warmVectorDb && this.vectorDb) {
        tasks.push(
          this.vectorDb
            .initialize()
            .then(() => {
              result.vectorDbReady = true;
              return true;
            })
            .catch((/** @type {any} */ err) => {
              logger.warn('[SearchService] Vector DB warm-up failed:', err?.message);
              throw err;
            })
        );
      }

      await Promise.allSettled(tasks);

      logger.info('[SearchService] Warm-up complete', result);
      return result;
    } catch (error) {
      logger.warn('[SearchService] Warm-up failed:', error.message);
      result.success = false;
      return result;
    }
  }

  /**
   * Get search performance metrics
   *
   * @returns {any} Performance metrics
   */
  getPerformanceMetrics() {
    return {
      indexStatus: this.getIndexStatus(),
      hasCachedIndex: !!this._serializedIndex,
      cachedIndexSize: this._serializedIndex?.length || 0,
      documentCount: this.documentMap.size
    };
  }

  /**
   * Get embedding health diagnostics
   * Analyzes vector DB state, model distribution, and orphaned entries
   *
   * @returns {Promise<Object>} Health report
   */
  async getEmbeddingHealth() {
    try {
      const stats = await this.vectorDb.getStats();
      const historyEntries = this.history.analysisHistory?.entries || {};
      const historyCount = Object.keys(historyEntries).length;

      // Get sample of file embeddings to check model/dimensions
      const fileSample = [];
      try {
        const result = await this.vectorDb.peekFiles(50);
        if (result && result.ids && result.ids.length > 0) {
          for (let i = 0; i < result.ids.length; i++) {
            fileSample.push({
              id: result.ids[i],
              embedding: result.embeddings ? result.embeddings[i] : [],
              metadata: result.metadatas ? result.metadatas[i] : {}
            });
          }
        }
      } catch (e) {
        logger.warn('[SearchService] Failed to peek file embeddings:', e.message);
      }

      // Analyze models and dimensions
      /** @type {Record<string, number>} */
      const models = {};
      /** @type {Record<number, number>} */
      const dimensions = {};

      fileSample.forEach((item) => {
        const model = item.metadata?.model || 'unknown';
        models[model] = (models[model] || 0) + 1;

        const dim = Array.isArray(item.embedding) ? item.embedding.length : 0;
        if (dim > 0) {
          dimensions[dim] = (dimensions[dim] || 0) + 1;
        }
      });

      // Check for orphans (files in history but not in vector DB)
      // Note: This is an approximation as history IDs != vector IDs (vector IDs are file paths)
      // We'll skip precise orphan checking here to avoid perf impact on large libraries

      return {
        healthy: true,
        stats: {
          historyCount,
          vectorFileCount: stats.files,
          vectorChunkCount: stats.fileChunks,
          vectorFolderCount: stats.folders
        },
        models,
        dimensions,
        sampleSize: fileSample.length
      };
    } catch (error) {
      logger.error('[SearchService] Health check failed:', error);
      return {
        healthy: false,
        error: error.message
      };
    }
  }

  /**
   * Comprehensive search diagnostics - identifies why search may return partial results
   * Call this when troubleshooting search issues
   *
   * @param {string} [testQuery='test'] - Optional query to test embedding generation
   * @returns {Promise<Object>} Diagnostic report with issues and recommendations
   */
  async diagnoseSearchIssues(testQuery = 'test') {
    /** @type {Record<string, any>} */
    const diagnostics = {
      timestamp: new Date().toISOString(),
      issues: [],
      warnings: [],
      recommendations: [],
      details: {}
    };

    try {
      // 1. Check vector DB collection status
      let fileCount = 0;
      let chunkCount = 0;
      let folderCount = 0;

      try {
        const stats = await this.vectorDb?.getStats?.();
        fileCount = stats?.files || 0;
        chunkCount = stats?.fileChunks || 0;
        folderCount = stats?.folders || 0;
      } catch (e) {
        diagnostics.issues.push({
          type: 'VECTOR_DB_ERROR',
          severity: 'critical',
          message: `Vector DB connection error: ${e.message}`
        });
      }

      diagnostics.details.collections = { fileCount, chunkCount, folderCount };

      if (fileCount === 0) {
        diagnostics.issues.push({
          type: 'EMPTY_FILE_COLLECTION',
          severity: 'critical',
          message: 'File embeddings collection is empty. Vector search will return no results.'
        });
        diagnostics.recommendations.push(
          'Run "Rebuild Embeddings" from Settings to populate the vector database.'
        );
      }

      if (chunkCount === 0 && fileCount > 0) {
        diagnostics.warnings.push({
          type: 'EMPTY_CHUNK_COLLECTION',
          severity: 'medium',
          message:
            'Chunk embeddings collection is empty. Deep text search (chunk search) is unavailable.'
        });
        diagnostics.recommendations.push(
          'Run "Rebuild Embeddings" to enable deep text search from extracted content.'
        );
      }

      // 2. Check BM25 index status
      const bm25Status = this.getIndexStatus();
      diagnostics.details.bm25 = bm25Status;

      if (!bm25Status.hasIndex) {
        diagnostics.issues.push({
          type: 'NO_BM25_INDEX',
          severity: 'high',
          message: 'BM25 keyword search index not built.'
        });
      } else if (bm25Status.documentCount === 0) {
        diagnostics.issues.push({
          type: 'EMPTY_BM25_INDEX',
          severity: 'high',
          message: 'BM25 index has no documents indexed.'
        });
      } else if (bm25Status.isStale) {
        diagnostics.warnings.push({
          type: 'STALE_BM25_INDEX',
          severity: 'low',
          message: 'BM25 index is stale and will be rebuilt on next search.'
        });
      }

      // 3. Check embedding dimension consistency
      let storedDimension = null;
      let queryDimension = null;
      let dimensionMismatch = false;

      try {
        storedDimension = await this.vectorDb.getCollectionDimension('files');
        diagnostics.details.storedDimension = storedDimension;

        // Generate a test embedding to check current model dimensions
        const testResult = await this.embedding.embedText(testQuery);
        if (testResult?.vector && Array.isArray(testResult.vector)) {
          queryDimension = testResult.vector.length;
          diagnostics.details.queryDimension = queryDimension;
          diagnostics.details.embeddingModel = testResult.model || 'unknown';

          if (storedDimension && queryDimension && storedDimension !== queryDimension) {
            dimensionMismatch = true;
            diagnostics.issues.push({
              type: 'DIMENSION_MISMATCH',
              severity: 'critical',
              message: `Embedding dimension mismatch! Stored vectors have ${storedDimension} dimensions, but current model produces ${queryDimension} dimensions. Vector search will fail.`,
              storedDimension,
              queryDimension
            });
            diagnostics.recommendations.push(
              'Run "Full Rebuild" from Settings to regenerate all embeddings with the current model.'
            );
          }
        } else {
          diagnostics.issues.push({
            type: 'EMBEDDING_GENERATION_FAILED',
            severity: 'critical',
            message:
              'Failed to generate test embedding. The AI engine may be unavailable or the embedding model is missing.'
          });
          diagnostics.recommendations.push(
            'Ensure the embedding model is downloaded and available in Settings > Models.'
          );
        }
      } catch (e) {
        diagnostics.warnings.push({
          type: 'DIMENSION_CHECK_ERROR',
          severity: 'medium',
          message: `Could not verify embedding dimensions: ${e.message}`
        });
      }

      // 4. Check chunk collection dimension (for hybrid search)
      if (chunkCount > 0 && !dimensionMismatch) {
        try {
          const chunkDimension = await this.vectorDb.getCollectionDimension('fileChunks');
          diagnostics.details.chunkDimension = chunkDimension;

          if (chunkDimension && queryDimension && chunkDimension !== queryDimension) {
            diagnostics.issues.push({
              type: 'CHUNK_DIMENSION_MISMATCH',
              severity: 'high',
              message: `Chunk collection dimension (${chunkDimension}) differs from current model (${queryDimension}). Chunk search will fail.`
            });
          }
        } catch {
          // Non-critical
        }
      }

      // 5. Compare history count vs embedding count
      try {
        await this.history.initialize();
        const historyEntries = this.history.analysisHistory?.entries || {};
        const historyCount = Object.keys(historyEntries).length;
        diagnostics.details.historyCount = historyCount;

        if (historyCount > 0 && fileCount > 0) {
          diagnostics.details.embeddingCoverage = Number((fileCount / historyCount).toFixed(3));
        }

        if (historyCount > 0 && fileCount === 0) {
          diagnostics.issues.push({
            type: 'HISTORY_WITHOUT_EMBEDDINGS',
            severity: 'high',
            message: `Analysis history has ${historyCount} entries but file embeddings collection is empty.`
          });
          diagnostics.recommendations.push(
            'Run "Rebuild Embeddings" to create embeddings from your analysis history.'
          );
        } else if (historyCount > fileCount * 1.5) {
          diagnostics.warnings.push({
            type: 'EMBEDDINGS_OUT_OF_SYNC',
            severity: 'medium',
            message: `Analysis history (${historyCount}) significantly exceeds file embeddings (${fileCount}). Some files may not be searchable.`
          });
        }
      } catch {
        // Non-critical
      }

      // 6. Check AI engine health status
      try {
        if (this.llamaService?.getHealthStatus) {
          const healthStatus = this.llamaService.getHealthStatus();
          // LlamaService.getHealthStatus() returns { initialized, gpuBackend, metrics, memory }
          diagnostics.details.llama = {
            isHealthy: healthStatus?.initialized ?? false,
            gpuBackend: healthStatus?.gpuBackend || 'none',
            metrics: healthStatus?.metrics || {},
            memory: healthStatus?.memory || {}
          };

          if (!diagnostics.details.llama.isHealthy) {
            diagnostics.issues.push({
              type: 'LLAMA_UNHEALTHY',
              severity: 'critical',
              message: 'AI engine is not initialized. Check model downloads and AI engine status.'
            });
            diagnostics.recommendations.push('Check model downloads and AI engine status.');
          }

          if (
            healthStatus?.memory?.currentMemoryUsage > 0 &&
            healthStatus?.memory?.memoryLimit > 0 &&
            healthStatus.memory.currentMemoryUsage / healthStatus.memory.memoryLimit > 0.9
          ) {
            diagnostics.warnings.push({
              type: 'LLAMA_HIGH_MEMORY',
              severity: 'medium',
              message:
                'AI engine memory usage is above 90%. Consider reducing model sizes or closing other applications.'
            });
          }
        }
      } catch (e) {
        // Non-critical - AI service may not be available
        logger.debug('[SearchService] Could not get AI health status:', e.message);
      }

      // 8. Check vector DB stats
      try {
        const stats = this.vectorDb?.getStats ? await this.vectorDb.getStats() : null;
        if (stats) {
          diagnostics.details.vectorDbStats = {
            files: stats.files || 0,
            folders: stats.folders || 0,
            chunks: stats.fileChunks || 0
          };
        }
      } catch {
        // Non-critical
      }

      // 9. Check query cache stats
      try {
        const cacheStats = this.vectorDb?.getQueryCacheStats?.();
        if (cacheStats) {
          diagnostics.details.queryCache = cacheStats;

          if (cacheStats.totalQueries > 100 && cacheStats.hitRate < 0.1) {
            diagnostics.warnings.push({
              type: 'LOW_CACHE_HIT_RATE',
              severity: 'low',
              message: `Query cache hit rate is very low (${(cacheStats.hitRate * 100).toFixed(1)}%). This may indicate cache misconfiguration.`
            });
          }
        }
      } catch {
        // Non-critical
      }

      // 10. Check embedding queue status
      try {
        const embeddingQueues = require('../analysis/embeddingQueue/queueManager');
        const stats = embeddingQueues.getStats?.();
        if (stats) {
          diagnostics.details.embeddingQueues = stats;

          const summarize = (/** @type {any} */ label, /** @type {any} */ queueStats) => {
            if (!queueStats) return;
            const queueLength = queueStats.queueLength || 0;
            const failedItemCount = queueStats.failedItemCount || 0;
            const deadLetterCount = queueStats.deadLetterCount || 0;
            const capacityPercent = queueStats.capacityPercent || 0;
            const healthStatus = queueStats.healthStatus || 'unknown';

            if (queueLength > 0) {
              diagnostics.warnings.push({
                type: 'PENDING_EMBEDDINGS',
                severity: 'low',
                message: `${label}: ${queueLength} embeddings pending (${Number.isFinite(capacityPercent) ? capacityPercent.toFixed(1) : 0}% capacity).`
              });
            }

            if (failedItemCount > 0) {
              diagnostics.warnings.push({
                type: 'FAILED_EMBEDDINGS',
                severity: 'medium',
                message: `${label}: ${failedItemCount} embeddings failed and awaiting retry.`
              });
            }

            if (deadLetterCount > 0) {
              diagnostics.issues.push({
                type: 'DEAD_LETTER_ITEMS',
                severity: 'high',
                message: `${label}: ${deadLetterCount} embeddings permanently failed (dead letter).`
              });
              diagnostics.recommendations.push(
                'Review dead letter items in Settings > Advanced to identify recurring failures.'
              );
            }

            if (healthStatus === 'critical') {
              diagnostics.issues.push({
                type: 'EMBEDDING_QUEUE_CRITICAL',
                severity: 'high',
                message: `${label}: embedding queue is at critical capacity. New embeddings may be dropped.`
              });
            } else if (healthStatus === 'warning') {
              diagnostics.warnings.push({
                type: 'EMBEDDING_QUEUE_HIGH',
                severity: 'medium',
                message: `${label}: embedding queue is at high capacity. Processing may be slow.`
              });
            }
          };

          summarize('analysisQueue', stats.analysis);
          summarize('organizeQueue', stats.organize);
        }
      } catch {
        // Non-critical - queue module may not be available
      }

      // 11. Check for orphaned embeddings
      try {
        const orphanedFiles = await this.vectorDb?.getOrphanedEmbeddings?.(null);
        const orphanedChunks = await this.vectorDb?.getOrphanedChunks?.(null);

        if (orphanedFiles?.length > 0 || orphanedChunks?.length > 0) {
          diagnostics.details.orphaned = {
            files: orphanedFiles?.length || 0,
            chunks: orphanedChunks?.length || 0
          };

          if ((orphanedFiles?.length || 0) + (orphanedChunks?.length || 0) > 100) {
            diagnostics.warnings.push({
              type: 'ORPHANED_EMBEDDINGS',
              severity: 'low',
              message: `${orphanedFiles?.length || 0} orphaned file embeddings and ${orphanedChunks?.length || 0} orphaned chunk embeddings. Consider cleanup.`
            });
          }
        }
      } catch {
        // Non-critical
      }

      // 12. Summary
      diagnostics.summary = {
        criticalIssues: diagnostics.issues.filter(
          (/** @type {any} */ i) => i.severity === 'critical'
        ).length,
        highIssues: diagnostics.issues.filter((/** @type {any} */ i) => i.severity === 'high')
          .length,
        warnings: diagnostics.warnings.length,
        searchFunctional:
          fileCount > 0 &&
          !dimensionMismatch &&
          (bm25Status.hasIndex || bm25Status.documentCount > 0),
        vectorSearchFunctional: fileCount > 0 && !dimensionMismatch,
        chunkSearchFunctional: chunkCount > 0 && !dimensionMismatch,
        bm25SearchFunctional: bm25Status.hasIndex && bm25Status.documentCount > 0
      };

      // Log comprehensive diagnostic output to both logger and terminal
      this._logDiagnosticsToTerminal(diagnostics);

      return diagnostics;
    } catch (error) {
      logger.error('[SearchService] Diagnosis failed:', error);
      return {
        ...diagnostics,
        error: error.message,
        issues: [
          ...diagnostics.issues,
          {
            type: 'DIAGNOSIS_ERROR',
            severity: 'critical',
            message: `Diagnostic check failed: ${error.message}`
          }
        ]
      };
    }
  }

  /**
   * Auto-run diagnostics when issues are detected (debounced to avoid spam)
   * @param {string} trigger - What triggered the auto-diagnostic
   * @private
   */
  _autoRunDiagnostics(trigger) {
    // Debounce: only run once per 5 minutes to avoid spamming terminal
    const now = Date.now();
    const DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

    if (this._lastAutoDiagnostic && now - this._lastAutoDiagnostic < DEBOUNCE_MS) {
      logger.debug('[SearchService] Skipping auto-diagnostics (debounced)', {
        trigger,
        lastRun: new Date(this._lastAutoDiagnostic).toISOString()
      });
      return;
    }

    this._lastAutoDiagnostic = now;

    // Run diagnostics asynchronously to not block search response
    logger.terminal('warn', '[SearchService] Auto-running diagnostics due to: ' + trigger);

    // Run in next tick to not block
    setImmediate(() => {
      this.diagnoseSearchIssues('auto-diagnostic').catch((err) => {
        logger.error('[SearchService] Auto-diagnostics failed:', err.message);
      });
    });
  }

  /**
   * Log diagnostics to both logger and terminal (stdout) for visibility
   * @param {any} diagnostics - The diagnostic report object
   * @private
   */
  _logDiagnosticsToTerminal(diagnostics) {
    const divider = '='.repeat(70);
    const subDivider = '-'.repeat(70);

    // Build formatted output
    const lines = [
      '',
      divider,
      '  SEMANTIC SEARCH DIAGNOSTICS',
      `  Timestamp: ${diagnostics.timestamp}`,
      divider,
      ''
    ];

    // Summary section
    lines.push('SUMMARY:');
    lines.push(subDivider);
    if (diagnostics.summary) {
      lines.push(`  Critical Issues: ${diagnostics.summary.criticalIssues}`);
      lines.push(`  High Issues:     ${diagnostics.summary.highIssues}`);
      lines.push(`  Warnings:        ${diagnostics.summary.warnings}`);
      lines.push('');
      lines.push(
        `  Search Functional:        ${diagnostics.summary.searchFunctional ? 'YES' : 'NO'}`
      );
      lines.push(
        `  Vector Search Functional: ${diagnostics.summary.vectorSearchFunctional ? 'YES' : 'NO'}`
      );
      lines.push(
        `  Chunk Search Functional:  ${diagnostics.summary.chunkSearchFunctional ? 'YES' : 'NO'}`
      );
      lines.push(
        `  BM25 Search Functional:   ${diagnostics.summary.bm25SearchFunctional ? 'YES' : 'NO'}`
      );
    }
    lines.push('');

    // Details section
    lines.push('COLLECTION STATUS:');
    lines.push(subDivider);
    if (diagnostics.details?.collections) {
      lines.push(`  File Embeddings:  ${diagnostics.details.collections.fileCount}`);
      lines.push(`  Chunk Embeddings: ${diagnostics.details.collections.chunkCount}`);
      lines.push(`  Folder Embeddings: ${diagnostics.details.collections.folderCount}`);
    }
    if (diagnostics.details?.historyCount !== undefined) {
      lines.push(`  Analysis History: ${diagnostics.details.historyCount}`);
    }
    lines.push('');

    // Dimension info
    lines.push('EMBEDDING DIMENSIONS:');
    lines.push(subDivider);
    if (diagnostics.details?.storedDimension) {
      lines.push(`  Stored (in DB):   ${diagnostics.details.storedDimension}`);
    }
    if (diagnostics.details?.queryDimension) {
      lines.push(`  Current Model:    ${diagnostics.details.queryDimension}`);
    }
    if (diagnostics.details?.embeddingModel) {
      lines.push(`  Model Name:       ${diagnostics.details.embeddingModel}`);
    }
    if (diagnostics.details?.chunkDimension) {
      lines.push(`  Chunk Dimension:  ${diagnostics.details.chunkDimension}`);
    }
    lines.push('');

    // BM25 status
    lines.push('BM25 INDEX STATUS:');
    lines.push(subDivider);
    if (diagnostics.details?.bm25) {
      lines.push(`  Has Index:      ${diagnostics.details.bm25.hasIndex ? 'YES' : 'NO'}`);
      lines.push(`  Document Count: ${diagnostics.details.bm25.documentCount}`);
      lines.push(`  Is Stale:       ${diagnostics.details.bm25.isStale ? 'YES' : 'NO'}`);
    }
    lines.push('');

    // AI engine status
    if (diagnostics.details?.llama) {
      lines.push('AI ENGINE STATUS:');
      lines.push(subDivider);
      lines.push(`  Available:          ${diagnostics.details.llama.available ? 'YES' : 'NO'}`);
      lines.push(`  Healthy:            ${diagnostics.details.llama.isHealthy ? 'YES' : 'NO'}`);
      if (diagnostics.details.llama.latencyMs) {
        lines.push(`  Latency:            ${diagnostics.details.llama.latencyMs}ms`);
      }
      lines.push(`  Consecutive Fails:  ${diagnostics.details.llama.consecutiveFailures || 0}`);
      lines.push('');
    }

    // Embedding queue status (stored as embeddingQueues by diagnoseSearch).
    // queueManager.getStats() returns { analysis: {...}, organize: {...} }.
    const eqStats = diagnostics.details?.embeddingQueues;
    if (eqStats) {
      const formatQueue = (/** @type {any} */ label, /** @type {any} */ q) => {
        if (!q) return;
        lines.push(`  [${label}]`);
        lines.push(`    Pending:      ${q.queueLength || 0}`);
        lines.push(`    Capacity:     ${q.capacityPercent?.toFixed(1) || 0}%`);
        lines.push(`    Failed:       ${q.failedItemCount || 0}`);
        lines.push(`    Dead Letter:  ${q.deadLetterCount || 0}`);
        lines.push(`    Health:       ${q.healthStatus || 'unknown'}`);
      };
      lines.push('EMBEDDING QUEUES:');
      lines.push(subDivider);
      formatQueue('analysis', eqStats.analysis);
      formatQueue('organize', eqStats.organize);
      lines.push('');
    }

    // Query cache stats
    if (diagnostics.details?.queryCache) {
      lines.push('QUERY CACHE:');
      lines.push(subDivider);
      lines.push(`  Size:      ${diagnostics.details.queryCache.size || 0}`);
      lines.push(
        `  Hit Rate:  ${((diagnostics.details.queryCache.hitRate || 0) * 100).toFixed(1)}%`
      );
      lines.push('');
    }

    // Orphaned embeddings
    if (diagnostics.details?.orphaned) {
      lines.push('ORPHANED EMBEDDINGS:');
      lines.push(subDivider);
      lines.push(`  Files:  ${diagnostics.details.orphaned.files || 0}`);
      lines.push(`  Chunks: ${diagnostics.details.orphaned.chunks || 0}`);
      lines.push('');
    }

    // Issues section
    if (diagnostics.issues && diagnostics.issues.length > 0) {
      lines.push('ISSUES DETECTED:');
      lines.push(subDivider);
      diagnostics.issues.forEach((/** @type {any} */ issue, /** @type {any} */ idx) => {
        const severityIcon =
          issue.severity === 'critical'
            ? '[CRITICAL]'
            : issue.severity === 'high'
              ? '[HIGH]'
              : '[MEDIUM]';
        lines.push(`  ${idx + 1}. ${severityIcon} ${issue.type}`);
        lines.push(`     ${issue.message}`);
        lines.push('');
      });
    }

    // Warnings section
    if (diagnostics.warnings && diagnostics.warnings.length > 0) {
      lines.push('WARNINGS:');
      lines.push(subDivider);
      diagnostics.warnings.forEach((/** @type {any} */ warning, /** @type {any} */ idx) => {
        lines.push(`  ${idx + 1}. [${warning.severity.toUpperCase()}] ${warning.type}`);
        lines.push(`     ${warning.message}`);
        lines.push('');
      });
    }

    // Recommendations section
    if (diagnostics.recommendations && diagnostics.recommendations.length > 0) {
      lines.push('RECOMMENDATIONS:');
      lines.push(subDivider);
      diagnostics.recommendations.forEach((/** @type {any} */ rec, /** @type {any} */ idx) => {
        lines.push(`  ${idx + 1}. ${rec}`);
      });
      lines.push('');
    }

    lines.push(divider);
    lines.push('');

    // Join all lines
    const output = lines.join('\n');

    // Write to terminal AND log file using logger.terminalRaw
    logger.terminalRaw(output);

    // Also log structured data to logger for searchability
    if (diagnostics.summary?.criticalIssues > 0) {
      logger.terminal('error', '[SearchService] CRITICAL search issues detected', {
        summary: diagnostics.summary,
        issues: diagnostics.issues
      });
    } else if (diagnostics.summary?.highIssues > 0) {
      logger.terminal('warn', '[SearchService] Search issues detected', {
        summary: diagnostics.summary,
        issues: diagnostics.issues,
        warnings: diagnostics.warnings
      });
    } else if (diagnostics.warnings?.length > 0) {
      logger.terminal('info', '[SearchService] Search diagnostics completed with warnings', {
        summary: diagnostics.summary,
        warnings: diagnostics.warnings
      });
    } else {
      logger.terminal('info', '[SearchService] Search diagnostics completed - no issues found', {
        summary: diagnostics.summary
      });
    }
  }

  /**
   * Cleanup resources on shutdown
   * Clears all cached data and pending operations.
   *
   * Awaits any tracked background work (search-index rebuilds, prewarm tasks,
   * etc.) so we match the lifecycle contract used by sibling services
   * (LlamaService, ParallelEmbeddingService). Without the drain, a shutdown
   * racing an in-flight background rebuild could write to a torn-down index.
   */
  async cleanup({ bgWorkDrainTimeoutMs = 5000 } = {}) {
    logger.info('[SearchService] Cleaning up...');

    // Clear rebuild debounce timer and resolve pending promises
    if (this._rebuildDebounceTimer) {
      clearTimeout(this._rebuildDebounceTimer);
      this._rebuildDebounceTimer = null;
    }
    if (this._rebuildDebounceResolvers && this._rebuildDebounceResolvers.length > 0) {
      const pendingResolvers = this._rebuildDebounceResolvers.splice(0);
      for (const r of pendingResolvers) {
        r({ success: false, rebuilt: false, error: 'Service shutting down' });
      }
    }

    if (this._bgWork && typeof this._bgWork.drain === 'function') {
      try {
        await this._bgWork.drain(bgWorkDrainTimeoutMs);
      } catch (drainError) {
        logger.warn?.('[SearchService] Background work drain failed', {
          error: drainError?.message || String(drainError)
        });
      }
    }

    // Clean up re-ranker resources
    this.reRanker?.cleanup?.();

    // Clear index and caches
    this._searchCache?.clear?.();
    this._searchInFlight?.clear?.();
    if (typeof this.vectorDb?.removeListener === 'function' && this._vectorDbMutationListener) {
      this.vectorDb.removeListener('search-data-mutated', this._vectorDbMutationListener);
    }
    this.bm25Index = null;
    this.documentMap.clear();
    this._serializedIndex = null;
    this._serializedDocMap = null;
    this.indexBuiltAt = null;
    this._indexBuildPromise = null;

    logger.info('[SearchService] Cleanup complete');
  }

  /**
   * Alias for cleanup (for consistency with other services)
   */
  async shutdown() {
    await this.cleanup();
  }
}

module.exports = { SearchService };
