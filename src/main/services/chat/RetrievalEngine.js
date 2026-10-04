// @ts-check
/**
 * Retrieval engine for chat — hybrid search execution, context-file
 * scoring, and vector shape normalization.
 *
 * Constructed with the search/vector/embedding/settings services; contains
 * NO session, prompt, or streaming state. The facade's _runRetrieval
 * remains the orchestrator that combines this engine's results with intent
 * detection, session history, persona, and prompt assembly.
 */

const { createLogger } = require('../../../shared/logger');
const { inferMediaKind } = require('../../analysis/mediaAnalysis');
const {
  cosineSimilarity,
  padOrTruncateVector: padOrTruncateVectorImpl
} = require('../../../shared/vectorMath');

const logger = createLogger('ChatRetrievalEngine');

// Minimum *raw* cosine similarity (from embeddings) for a source to be
// included in the chat prompt.  The fused score after min-max normalization
// is unreliable for quality gating because normalization stretches the best-
// of-a-bad-bunch to 1.0.  Raw cosine similarity is an absolute quality signal:
//   ≥ 0.55  strong semantic match
//   0.35–0.55  moderate match
//   < 0.30  effectively random for most embedding models (short queries)
// 0.30 filters marginal matches that cause hallucinations when the LLM
// invents connections between the query and irrelevant documents.
const CHAT_MIN_SEMANTIC_SCORE = 0.3;

// Relevance floor for BM25/keyword-only hits (no vector signal). `keywordScore`
// is min-max normalized within the result set (see SearchService._normalizeScores),
// so this is a *relative* quality bar — "top (1 - threshold) of the keyword-hit
// distribution" — not an absolute similarity score. Kept at the same numeric
// value as CHAT_MIN_SEMANTIC_SCORE for continuity with prior behavior, but
// represents a different concept; rename when tuning.
const CHAT_MIN_KEYWORD_NORMALIZED_SCORE = 0.3;

class RetrievalEngine {
  /** @param {{ searchService: any, vectorDbService: any, embeddingService: any, settingsService: any, defaults: Record<string, any> }} deps */
  constructor({ searchService, vectorDbService, embeddingService, settingsService, defaults }) {
    this.searchService = searchService;
    this.vectorDbService = vectorDbService;
    this.embeddingService = embeddingService;
    this.settingsService = settingsService;
    this.DEFAULTS = defaults;
    this._contextScoringWarned = false;
  }

  /**
   * @param {string} query
   * @param {Record<string, any>} params - topK, mode, chunkTopK, chunkWeight, contextFileIds,
   *   strictScope, expandSynonyms, correctSpelling, rerank, precomputedEmbedding
   */
  async retrieveSources(
    query,
    {
      topK,
      mode,
      chunkTopK,
      chunkWeight,
      contextFileIds,
      strictScope = false,
      expandSynonyms,
      correctSpelling,
      rerank,
      precomputedEmbedding
    }
  ) {
    /** @type {Record<string, any>} */
    const meta = {
      retrievalAvailable: true
    };

    if (!this.searchService || typeof this.searchService.hybridSearch !== 'function') {
      return {
        /** @type {any[]} */
        sources: [],
        meta: {
          ...meta,
          retrievalAvailable: false,
          warning: 'Document retrieval unavailable (search service not ready)'
        }
      };
    }

    let settingsSnapshot = null;

    let searchResults;
    try {
      let retrievalSettings = {};
      try {
        if (this.settingsService?.load) {
          const settings = await this.settingsService.load();
          settingsSnapshot = settings;
          retrievalSettings = {
            ...(typeof settings?.graphExpansionEnabled === 'boolean' && {
              graphExpansion: settings.graphExpansionEnabled
            }),
            ...(Number.isFinite(settings?.graphExpansionWeight) && {
              graphExpansionWeight: settings.graphExpansionWeight
            }),
            ...(Number.isInteger(settings?.graphExpansionMaxNeighbors) && {
              graphExpansionMaxNeighbors: settings.graphExpansionMaxNeighbors
            }),
            ...(typeof settings?.chunkContextEnabled === 'boolean' && {
              chunkContext: settings.chunkContextEnabled
            }),
            ...(Number.isInteger(settings?.chunkContextMaxNeighbors) && {
              chunkContextMaxNeighbors: settings.chunkContextMaxNeighbors
            })
          };
        }
      } catch (settingsError) {
        logger.debug(
          '[RetrievalEngine] Failed to load retrieval settings:',
          settingsError?.message
        );
      }

      searchResults = await this.searchService.hybridSearch(query, {
        topK,
        mode,
        chunkWeight,
        chunkTopK,
        expandSynonyms,
        correctSpelling,
        rerank,
        precomputedEmbedding,
        ...retrievalSettings
      });
    } catch (error) {
      logger.warn('[RetrievalEngine] Search failed:', error?.message || error);
      return {
        /** @type {any[]} */
        sources: [],
        meta: {
          ...meta,
          retrievalAvailable: false,
          error: error?.message || 'Search failed',
          warning: `Document retrieval failed: ${error?.message || 'Search failed'}`
        }
      };
    }

    if (!searchResults?.success) {
      const errorMessage = searchResults?.error || 'Search failed';
      return {
        /** @type {any[]} */
        sources: [],
        meta: {
          ...meta,
          retrievalAvailable: false,
          error: errorMessage,
          warning: `Document retrieval failed: ${errorMessage}`
        }
      };
    }

    const baseResults = Array.isArray(searchResults.results) ? searchResults.results : [];
    const hybridHasSnippets = baseResults.some(
      (/** @type {any} */ r) =>
        r?.matchDetails?.contextSnippet ||
        r?.matchDetails?.bestSnippet ||
        r?.bestSnippet ||
        r?.contextSnippet
    );

    let chunkResults;
    if (!hybridHasSnippets) {
      try {
        chunkResults = await this.searchService.chunkSearch(
          query,
          topK,
          Number.isInteger(chunkTopK) ? chunkTopK : this.DEFAULTS.chunkTopK,
          {
            precomputedEmbedding,
            chunkContext:
              typeof settingsSnapshot?.chunkContextEnabled === 'boolean'
                ? settingsSnapshot.chunkContextEnabled
                : undefined,
            chunkContextMaxNeighbors: Number.isInteger(settingsSnapshot?.chunkContextMaxNeighbors)
              ? settingsSnapshot.chunkContextMaxNeighbors
              : undefined
          }
        );
      } catch (chunkError) {
        chunkResults = [];
        logger.warn('[RetrievalEngine] Chunk search failed (non-fatal):', chunkError.message);
      }
    } else {
      chunkResults = baseResults;
    }

    const chunkMap = new Map();
    chunkResults.forEach((/** @type {any} */ r) => {
      const snippet = r?.matchDetails?.contextSnippet || r?.matchDetails?.bestSnippet;
      if (r?.id && snippet) {
        chunkMap.set(r.id, snippet);
      }
    });

    // Not sliced to topK yet: the relevance gate below runs first, so a
    // context file or a weak hit it drops is replaced by the next candidate
    // instead of leaving the turn short of sources (or with none).
    let finalResults = baseResults;
    if (Array.isArray(contextFileIds) && contextFileIds.length > 0) {
      const contextScores = await this.scoreContextFiles(
        query,
        contextFileIds,
        precomputedEmbedding
      );
      const contextRanked = contextScores
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, topK);

      const contextIds = new Set(contextRanked.map((r) => r.id));
      if (strictScope) {
        // Hard filter: only the explicitly selected documents reach the LLM.
        finalResults = contextRanked.slice(0, topK);
      } else {
        const fallback = baseResults.filter(
          (/** @type {any} */ r) => r?.id && !contextIds.has(r.id)
        );
        finalResults = [...contextRanked, ...fallback];
      }
      meta.contextBoosted = true;
    }

    // Enrich ALL results (including context-boosted files that bypass the search
    // pipeline) with the full analysis metadata from the documentMap. This ensures
    // the LLM prompt gets summary, purpose, entity, extractedText, etc. — not just
    // the bare-bones fields stored in the vector DB.
    if (this.searchService && typeof this.searchService.enrichResults === 'function') {
      const enrichmentSafeResults = finalResults.map((/** @type {any} */ result) => ({
        ...result,
        metadata:
          result && typeof result.metadata === 'object' && result.metadata !== null
            ? { ...result.metadata }
            : {}
      }));
      this.searchService.enrichResults(enrichmentSafeResults);
      finalResults = enrichmentSafeResults;
    }

    const sources = finalResults.map((/** @type {any} */ result, /** @type {any} */ index) => {
      const fileId = result?.id;
      const metadata = result?.metadata || {};
      // Build comprehensive snippet with fallbacks for richer context
      const snippet =
        chunkMap.get(fileId) || metadata.summary || metadata.purpose || metadata.subject || '';
      // Parse tags if stored as JSON string
      let tags = metadata.tags || metadata.keywords || [];
      if (typeof tags === 'string') {
        try {
          tags = JSON.parse(tags);
        } catch {
          tags = [];
        }
      }

      // Parse colors if stored as JSON string
      let colors = metadata.colors || [];
      if (typeof colors === 'string') {
        try {
          colors = JSON.parse(colors);
        } catch {
          colors = [];
        }
      }

      const isImage = metadata.type === 'image';
      // Resolve media kind across every signal — explicit mediaKind from
      // the v3.1.1+ pipeline, mimetype, or filename extension — so legacy
      // index entries (no mediaKind field) still get the lifted cap.
      const resolvedMediaKind = inferMediaKind({
        mediaKind: metadata.mediaKind,
        mimeType: metadata.type,
        filePath: metadata.path || metadata.name
      });
      const isMediaSource = Boolean(resolvedMediaKind);

      // ── Raw semantic score ──
      // The fused score (result.score) is min-max normalized and can inflate
      // terrible matches to 1.0. The raw vector/chunk cosine similarity is
      // the actual measure of semantic relevance. Expose it as semanticScore
      // so the LLM prompt, relevance gate, and UI all use the real signal.
      const hybrid = result?.matchDetails?.hybrid || {};
      const rawSemantic =
        typeof hybrid.vectorRawScore === 'number'
          ? hybrid.vectorRawScore
          : typeof hybrid.chunkRawScore === 'number'
            ? hybrid.chunkRawScore
            : null;
      // If neither vector nor chunk search found this result (BM25-only),
      // rawSemantic is null → semanticScore falls back to 0, signaling
      // that there is no embedding-backed relevance.
      const semanticScore = rawSemantic !== null ? rawSemantic : 0;

      return {
        id: `doc-${index + 1}`,
        fileId,
        name: metadata.name || fileId,
        path: metadata.path || '',
        snippet,
        // Extended context for richer conversations
        summary: metadata.summary || '',
        purpose: metadata.purpose || '',
        subject: metadata.subject || '',
        entity: metadata.entity || '',
        project: metadata.project || '',
        documentType: metadata.documentType || metadata.type || '',
        category: metadata.category || '',
        reasoning: metadata.reasoning || '',
        // Document's primary date (from analysis)
        documentDate: metadata.date || metadata.documentDate || '',
        // Include truncated extracted text for deep context. Media
        // transcripts are 5-10x longer than typical documents (a
        // 20-min podcast ≈ 15 000 chars); without the larger cap the
        // LLM only sees the opening 2 000 chars and can't answer
        // mid-podcast questions. SearchService stores up to 15 000
        // chars for media so this cap is the binding constraint.
        extractedText: metadata.extractedText
          ? metadata.extractedText.substring(0, isMediaSource ? 12000 : 2000)
          : '',
        mediaKind: resolvedMediaKind || null,
        tags: Array.isArray(tags) ? tags : [],
        entities: metadata.keyEntities || [],
        dates: metadata.dates || [],
        score: result?.score || 0,
        // Raw cosine similarity from embedding search (0-1, absolute quality)
        semanticScore,
        confidence: metadata.confidence || 0,
        matchDetails: result?.matchDetails || {},
        // Image-specific fields
        isImage,
        contentType: isImage ? metadata.content_type || '' : '',
        hasText: isImage ? Boolean(metadata.has_text) : false,
        colors: isImage ? (Array.isArray(colors) ? colors : []) : []
      };
    });

    // ── Relevance gate ──
    // Primary check: raw cosine similarity (absolute quality signal; < 0.30 is
    // effectively random for most embedding models on short queries). The fused
    // score is min-max normalized and can make garbage look like gold, so we
    // never gate on it directly when a semantic signal exists.
    //
    // Fallback for hits with no semantic signal at all (BM25/keyword-only;
    // `vectorRawScore` and `chunkRawScore` both undefined): require the
    // normalized keywordScore to clear CHAT_MIN_KEYWORD_NORMALIZED_SCORE — a
    // *relative* quality bar within the keyword-hit distribution rather than
    // an absolute similarity. Last-resort fall back to the fused score.
    const relevantSources = strictScope
      ? sources
      : sources.filter((/** @type {any} */ s) => {
          if (s.semanticScore >= CHAT_MIN_SEMANTIC_SCORE) return true;
          const h = s.matchDetails?.hybrid || {};
          const hasVec =
            typeof h.vectorRawScore === 'number' || typeof h.chunkRawScore === 'number';
          if (hasVec) {
            return false;
          }
          if (
            typeof h.keywordScore === 'number' &&
            h.keywordScore >= CHAT_MIN_KEYWORD_NORMALIZED_SCORE
          ) {
            return true;
          }
          return (s.score || 0) >= CHAT_MIN_SEMANTIC_SCORE;
        });
    const droppedCount = sources.length - relevantSources.length;
    if (droppedCount > 0) {
      const dropped = sources.filter((/** @type {any} */ s) => !relevantSources.includes(s));
      logger.debug(
        `[RetrievalEngine] Dropped ${droppedCount} low-relevance sources (semantic<${CHAT_MIN_SEMANTIC_SCORE}, keyword<${CHAT_MIN_KEYWORD_NORMALIZED_SCORE}, fused<${CHAT_MIN_SEMANTIC_SCORE})`,
        {
          kept: relevantSources.length,
          droppedScores: dropped
            .map((/** @type {any} */ s) => ({
              fused: (s.score ?? 0).toFixed(3),
              semantic: (s.semanticScore ?? 0).toFixed(3),
              keyword: (s.matchDetails?.hybrid?.keywordScore ?? 0).toFixed(3)
            }))
            .slice(0, 3)
        }
      );
    }

    // Renumber doc IDs sequentially for the sources the LLM actually sees.
    // Without this, filtered-out gaps (doc-1, doc-3) cause the model to cite
    // doc-2 for the second listed source → [?] in the UI.
    const limitedSources = relevantSources.slice(0, topK);
    const numberedSources = limitedSources.map(
      (/** @type {any} */ source, /** @type {any} */ index) => ({
        ...source,
        id: `doc-${index + 1}`
      })
    );

    const searchMeta = searchResults.meta || null;
    const fallbackReason = searchMeta?.fallbackReason;
    const isFallback = Boolean(searchMeta?.fallback || searchResults.mode === 'bm25-fallback');

    return {
      sources: numberedSources,
      meta: {
        ...meta,
        mode: searchResults.mode || mode,
        queryMeta: searchResults.queryMeta || null,
        searchMeta,
        resultCount: numberedSources.length,
        totalRetrieved: sources.length,
        droppedLowRelevance: droppedCount,
        ...(isFallback
          ? {
              fallback: true,
              fallbackReason: fallbackReason || 'embedding model unavailable',
              warning: `Limited document retrieval: ${
                fallbackReason || 'embedding model unavailable'
              }`
            }
          : {})
      }
    };
  }

  async scoreContextFiles(
    /** @type {any} */ query,
    /** @type {any} */ fileIds,
    /** @type {any} */ precomputedEmbedding = null
  ) {
    try {
      if (!this.embeddingService || !this.vectorDbService) return [];
      const cleanIds = fileIds
        .filter((/** @type {any} */ id) => typeof id === 'string' && id.length > 0)
        .slice(0, this.DEFAULTS.contextFileLimit);

      if (cleanIds.length === 0) return [];

      let embedResult;
      if (precomputedEmbedding) {
        embedResult = { vector: precomputedEmbedding };
      } else {
        embedResult = await this.embeddingService.embedText(query);
      }

      if (!embedResult?.vector?.length) return [];

      if (!this.vectorDbService) return [];
      await this.vectorDbService.initialize();
      const expectedDim =
        typeof this.vectorDbService.getCollectionDimension === 'function'
          ? await this.vectorDbService.getCollectionDimension('files')
          : null;
      const queryVector = this.padOrTruncateVector(embedResult.vector, expectedDim);
      if (!queryVector?.length) return [];

      const fileDocSettled = await Promise.allSettled(
        cleanIds.map(async (/** @type {any} */ id) => {
          try {
            return await this.vectorDbService.getFile(id);
          } catch {
            return null;
          }
        })
      );
      const fileDocs = fileDocSettled.map((r) => (r.status === 'fulfilled' ? r.value : null));

      const scored = [];
      for (let i = 0; i < cleanIds.length; i += 1) {
        const doc = fileDocs[i];
        const vec = doc?.embedding;
        if (!Array.isArray(vec) || vec.length === 0) continue;
        // Fail closed on dimension mismatch (vector recorded under a previous
        // embedding model) — padded/truncated similarity is meaningless.
        if (vec.length !== queryVector.length) continue;

        const similarity = cosineSimilarity(queryVector, vec);
        scored.push({
          id: cleanIds[i],
          score: similarity,
          metadata: doc
            ? {
                path: doc.filePath,
                filePath: doc.filePath,
                name: doc.fileName,
                fileName: doc.fileName,
                fileType: doc.fileType,
                analyzedAt: doc.analyzedAt,
                suggestedName: doc.suggestedName,
                keywords: doc.keywords,
                tags: doc.tags,
                extractionMethod: doc.extractionMethod
              }
            : {},
          // Provide matchDetails so the source builder and relevance gate
          // can read the raw cosine similarity as vectorRawScore. Without
          // this, semanticScore falls back to 0 and the relevance gate
          // silently drops every context-boosted file.
          matchDetails: {
            hybrid: { vectorRawScore: similarity },
            sources: ['context']
          }
        });
      }

      return scored;
    } catch (error) {
      // First failure per session goes to warn so support can spot "user
      // sees empty context" reports in production logs. Subsequent failures
      // back off to debug to avoid log spam if the underlying service stays
      // degraded (e.g. vector DB unavailable for an extended period).
      if (!this._contextScoringWarned) {
        this._contextScoringWarned = true;
        logger.warn('[RetrievalEngine] Context scoring failed (non-fatal, using empty context)', {
          error: error?.message,
          code: error?.code
        });
      } else {
        logger.debug('[RetrievalEngine] Context scoring failed (non-fatal):', error?.message);
      }
      return [];
    }
  }

  padOrTruncateVector(/** @type {any} */ vector, /** @type {any} */ expectedDim) {
    return padOrTruncateVectorImpl(vector, expectedDim);
  }
}

module.exports = { RetrievalEngine };
