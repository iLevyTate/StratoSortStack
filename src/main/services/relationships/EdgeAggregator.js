// @ts-check
/**
 * EdgeAggregator — Phase 2
 *
 * Consolidates three independent "why is this related?" signals into ONE
 * canonical edge per (source, target) with a structured `reasons[]` payload:
 *
 *   - shared_concepts   : from RelationshipIndexService concept index (weight + concepts[])
 *   - content_similarity: from ClusteringService.findFileSimilarityEdges (cosine >= threshold)
 *   - centroid_bridge   : from ClusteringService.findCrossClusterEdges bridgeFiles[] projections
 *
 * The aggregator is additive. Existing edge consumers (SearchService._applyGraphExpansion,
 * legacy graph renderers) can keep reading `{source, target, weight, concepts}`; new
 * consumers (RelatedDocumentsPanel, BridgeAnalysisModal, SimilarityEdge) read `reasons[]`.
 */

const { createLogger } = require('../../../shared/logger');
const { THRESHOLDS } = require('../../../shared/performanceConstants');
const { container, ServiceIds } = require('../ServiceContainer');

const logger = createLogger('EdgeAggregator');

const DEFAULTS = {
  limit: 20,
  maxLimit: 100,
  similarityThreshold: 0.5,
  minWeight: 2
};

function getRelationshipIndex() {
  return container.tryResolve(ServiceIds.RELATIONSHIP_INDEX);
}

function getClustering() {
  return container.tryResolve(ServiceIds.CLUSTERING);
}

function getOrama() {
  return container.tryResolve(ServiceIds.ORAMA_VECTOR);
}

function edgeKey(/** @type {any} */ a, /** @type {any} */ b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function canonicalizeEndpoints(/** @type {any} */ src, /** @type {any} */ dst) {
  return src < dst ? [src, dst] : [dst, src];
}

/**
 * @param {{ kind: string, weight?: number, similarity?: number, sharedTerms?: string[] }} r
 * @returns {number}
 */
function reasonStrength(r) {
  if (!r) return 0;
  if (r.kind === 'content_similarity' && Number.isFinite(r.similarity)) {
    return r.similarity;
  }
  if (r.kind === 'centroid_bridge') {
    const termBoost = (Array.isArray(r.sharedTerms) ? r.sharedTerms.length : 0) * 0.01;
    return (Number(r.similarity) || 0) + termBoost;
  }
  return Number(r.weight) || 0;
}

function mergeEdge(/** @type {any} */ target, /** @type {any} */ incoming) {
  target.weight = Math.max(target.weight || 0, incoming.weight || 0);
  if (incoming.concepts?.length) {
    const set = new Set([...(target.concepts || []), ...incoming.concepts]);
    target.concepts = Array.from(set).slice(0, 10);
  }
  if (incoming.reasons?.length) {
    for (const reason of incoming.reasons) {
      // Deduplicate by reason.kind — keep the highest-signal instance per kind.
      const existing = target.reasons.find((/** @type {any} */ r) => r.kind === reason.kind);
      if (!existing) {
        target.reasons.push(reason);
      } else if (reasonStrength(reason) > reasonStrength(existing)) {
        Object.assign(existing, reason);
      }
    }
  }
  // Unify display/rank weight: concept weights + scaled similarity for non-concept reasons.
  let maxW = target.weight || 0;
  for (const r of target.reasons || []) {
    if (r.kind === 'shared_concepts' && Number.isFinite(r.weight)) {
      maxW = Math.max(maxW, r.weight);
    } else if (r.kind === 'content_similarity' && Number.isFinite(r.similarity)) {
      maxW = Math.max(maxW, r.similarity * 10);
    } else if (r.kind === 'centroid_bridge' && Number.isFinite(r.similarity)) {
      maxW = Math.max(maxW, r.similarity * 10);
    }
  }
  target.weight = maxW;
  return target;
}

function rankReasons(/** @type {any} */ reasons) {
  // Order: shared_concepts (strongest file-pair signal) > content_similarity > centroid_bridge.
  // Returns a sorted *copy*: callers spread the result into a new edge object
  // (`{ ...edge, reasons: rankReasons(edge.reasons) }`), but mutating the input
  // `reasons` array via in-place .sort() leaks ordering changes back to the
  // source-of-truth Map (see merged.values() at the call site), which would
  // surface stale ordering on subsequent reads.
  if (!Array.isArray(reasons)) return [];
  /** @type {Record<string, number>} */
  const order = {
    shared_concepts: 0,
    content_similarity: 1,
    centroid_bridge: 2
  };
  return [...reasons].sort(
    (/** @type {any} */ a, /** @type {any} */ b) => (order[a.kind] ?? 99) - (order[b.kind] ?? 99)
  );
}

class EdgeAggregator {
  /**
   * Get unified edges for a set of seed file IDs. Each returned edge includes a
   * `reasons[]` array describing every signal that contributed to it.
   *
   * @param {string[]} seedIds - One or more file IDs (semantic IDs, not paths)
   * @param {Record<string, any>} [options] - { limit, minWeight, similarityThreshold }
   * @returns {Promise<{edges: Array<any>, neighbors: string[]}>}
   */
  async getEdgesForFiles(seedIds, options = {}) {
    const limit = Math.min(options.limit || DEFAULTS.limit, DEFAULTS.maxLimit);
    const minWeight = options.minWeight ?? DEFAULTS.minWeight;
    const similarityThreshold = options.similarityThreshold ?? DEFAULTS.similarityThreshold;

    const ids = Array.isArray(seedIds)
      ? seedIds.filter((id) => typeof id === 'string' && id.length > 0)
      : [];
    if (ids.length === 0) {
      return { edges: [], neighbors: [] };
    }

    const merged = new Map(); // edgeKey -> edge

    // === Signal 1: concept-based neighbor edges ===
    try {
      const rel = getRelationshipIndex();
      if (rel && typeof rel.getNeighborEdges === 'function') {
        const response = await rel.getNeighborEdges(ids, {
          minWeight,
          maxEdges: limit * 3 // over-fetch; aggregator re-caps after merge
        });
        for (const raw of response?.edges || []) {
          const [src, dst] = canonicalizeEndpoints(raw.source, raw.target);
          const key = edgeKey(src, dst);
          const entry = merged.get(key) || {
            id: `agg:${src}->${dst}`,
            source: src,
            target: dst,
            weight: 0,
            concepts: [],
            reasons: [],
            kind: 'unified'
          };
          mergeEdge(entry, {
            weight: raw.weight,
            concepts: raw.concepts,
            reasons: [
              {
                kind: 'shared_concepts',
                weight: raw.weight,
                concepts: Array.isArray(raw.concepts) ? raw.concepts.slice(0, 5) : []
              }
            ]
          });
          merged.set(key, entry);
        }
      }
    } catch (err) {
      logger.warn('[EdgeAggregator] concept edges failed', { error: err?.message });
    }

    // === Signal 2: pairwise content similarity ===
    try {
      const clustering = getClustering();
      if (clustering && typeof clustering.findFileSimilarityEdges === 'function') {
        const simEdges = await clustering.findFileSimilarityEdges(ids, {
          threshold: similarityThreshold,
          maxEdgesPerNode: 5
        });
        for (const raw of simEdges || []) {
          const [src, dst] = canonicalizeEndpoints(raw.source, raw.target);
          const key = edgeKey(src, dst);
          const entry = merged.get(key) || {
            id: `agg:${src}->${dst}`,
            source: src,
            target: dst,
            weight: 0,
            concepts: [],
            reasons: [],
            kind: 'unified'
          };
          mergeEdge(entry, {
            reasons: [
              {
                kind: 'content_similarity',
                similarity: Number(raw.similarity) || 0
              }
            ]
          });
          merged.set(key, entry);
        }
      }
    } catch (err) {
      logger.warn('[EdgeAggregator] similarity edges failed', { error: err?.message });
    }

    // === Signal 3: centroid-bridge projection ===
    // Cross-cluster bridges connect whole clusters. We promote them to file-level
    // edges using (a) pairs among bridge sample files when a seed is present, and
    // (b) seed ↔ bridge file when the seed lies in one cluster and the sample is
    // from the opposite cluster (so the active file always gets a bridge signal).
    try {
      const clustering = getClustering();
      const crossClusterThreshold =
        options.crossClusterThreshold ?? THRESHOLDS.SIMILARITY_EDGE_DEFAULT;
      const clustersStale =
        typeof clustering?.isClustersStale === 'function' && clustering.isClustersStale();
      if (
        clustering &&
        !clustersStale &&
        Array.isArray(clustering.clusters) &&
        clustering.clusters.length > 0
      ) {
        if (typeof clustering.findCrossClusterEdges === 'function') {
          const bridges = await clustering.findCrossClusterEdges(crossClusterThreshold, {
            includeBridgeFiles: true,
            maxBridgeFilesPerCluster: 3
          });
          const seedSet = new Set(ids);
          const pushBridgeEdge = (
            /** @type {any} */ a,
            /** @type {any} */ b,
            /** @type {any} */ bridge
          ) => {
            if (!a || !b || a === b) return;
            const [src, dst] = canonicalizeEndpoints(a, b);
            const key = edgeKey(src, dst);
            const entry = merged.get(key) || {
              id: `agg:${src}->${dst}`,
              source: src,
              target: dst,
              weight: 0,
              concepts: [],
              reasons: [],
              kind: 'unified'
            };
            mergeEdge(entry, {
              reasons: [
                {
                  kind: 'centroid_bridge',
                  clusters: [bridge.source, bridge.target],
                  similarity: Number(bridge.similarity) || 0,
                  sharedTerms: Array.isArray(bridge.sharedTerms)
                    ? bridge.sharedTerms.slice(0, 5)
                    : []
                }
              ]
            });
            merged.set(key, entry);
          };

          for (const bridge of bridges || []) {
            const files = Array.isArray(bridge.bridgeFiles) ? bridge.bridgeFiles : [];
            const m = /^cluster:(\d+)$/.exec(bridge.source || '');
            const n = /^cluster:(\d+)$/.exec(bridge.target || '');
            const clusterA =
              m && clustering.clusters
                ? clustering.clusters.find((/** @type {any} */ c) => c.id === parseInt(m[1], 10))
                : null;
            const clusterB =
              n && clustering.clusters
                ? clustering.clusters.find((/** @type {any} */ c) => c.id === parseInt(n[1], 10))
                : null;
            const tagA = bridge.source;
            const tagB = bridge.target;
            const fromA = files.filter((/** @type {any} */ f) => f?.clusterId === tagA);
            const fromB = files.filter((/** @type {any} */ f) => f?.clusterId === tagB);

            const memberIdsA = new Set(
              (clusterA?.members || []).map((/** @type {any} */ mem) => mem.id).filter(Boolean)
            );
            const memberIdsB = new Set(
              (clusterB?.members || []).map((/** @type {any} */ mem) => mem.id).filter(Boolean)
            );

            for (const seed of ids) {
              if (memberIdsA.has(seed)) {
                for (const bf of fromB) {
                  if (bf?.id) pushBridgeEdge(seed, bf.id, bridge);
                }
              }
              if (memberIdsB.has(seed)) {
                for (const bf of fromA) {
                  if (bf?.id) pushBridgeEdge(seed, bf.id, bridge);
                }
              }
            }

            for (let i = 0; i < files.length; i++) {
              const a = files[i]?.id;
              if (!a) continue;
              for (let j = i + 1; j < files.length; j++) {
                const b = files[j]?.id;
                if (!b) continue;
                if (!seedSet.has(a) && !seedSet.has(b)) continue;
                pushBridgeEdge(a, b, bridge);
              }
            }
          }
        }
      }
    } catch (err) {
      logger.warn('[EdgeAggregator] centroid bridges failed', { error: err?.message });
    }

    const edges = Array.from(merged.values())
      .map((edge) => ({ ...edge, reasons: rankReasons(edge.reasons) }))
      // Rank by (reasonCount, weight, first-reason-strength).
      .sort((a, b) => {
        const byReasonCount = (b.reasons?.length || 0) - (a.reasons?.length || 0);
        if (byReasonCount !== 0) return byReasonCount;
        return (b.weight || 0) - (a.weight || 0);
      })
      .slice(0, limit);

    // Neighbors = endpoints other than the seed set.
    const seedSet = new Set(ids);
    const neighbors = new Set();
    for (const edge of edges) {
      if (!seedSet.has(edge.source)) neighbors.add(edge.source);
      if (!seedSet.has(edge.target)) neighbors.add(edge.target);
    }

    return { edges, neighbors: Array.from(neighbors) };
  }

  /**
   * Look up file metadata (name, path, category, confidence) for a set of
   * fileIds so the renderer can render a panel row without a second round
   * trip. Uses OramaVectorService.getFile when available.
   */
  async getFileMetadata(/** @type {any} */ fileIds) {
    const orama = getOrama();
    if (!orama || typeof orama.getFile !== 'function') return {};
    const ids = Array.isArray(fileIds) ? fileIds : [];
    /** @type {Record<string, any>} */
    const out = {};
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const doc = await orama.getFile(id);
          return { id, doc };
        } catch (err) {
          logger.debug('[EdgeAggregator] getFile failed', { id, error: err?.message });
          return { id, doc: null };
        }
      })
    );
    for (const { id, doc } of results) {
      if (!doc) continue;
      out[id] = {
        id,
        fileName: doc.fileName || '',
        filePath: doc.filePath || '',
        fileType: doc.fileType || '',
        suggestedName: doc.suggestedName || '',
        tags: Array.isArray(doc.tags) ? doc.tags : [],
        keywords: Array.isArray(doc.keywords) ? doc.keywords : []
      };
    }
    return out;
  }
}

module.exports = { EdgeAggregator };
