// @ts-check
const { registerHandlers } = require('./ipcWrappers');
const { IpcServiceContext, createFromLegacyParams } = require('./IpcServiceContext');
const { schemas } = require('./validationSchemas');
const RelationshipIndexService = require('../services/RelationshipIndexService');
const { EdgeAggregator } = require('../services/relationships/EdgeAggregator');
const { container, ServiceIds } = require('../services/ServiceContainer');

/**
 * @param {IpcServiceContext|Record<string, any>} servicesOrParams - Service context or legacy parameters
 */
function registerKnowledgeIpc(servicesOrParams) {
  let context;
  if (servicesOrParams instanceof IpcServiceContext) {
    context = servicesOrParams;
  } else {
    context = createFromLegacyParams(servicesOrParams);
  }

  const { ipcMain, IPC_CHANNELS, logger } = context.core;
  const { getServiceIntegration } = context;
  /** @type {{ success: boolean, updatedAt: string|null, sourceUpdatedAt: string|null, edgeCount: number, conceptCount: number, docCount: number, maxWeight: number, minWeight: number, totalEdges: number, totalNodes: number }} */
  const emptyStats = {
    success: true,
    updatedAt: null,
    sourceUpdatedAt: null,
    edgeCount: 0,
    conceptCount: 0,
    docCount: 0,
    maxWeight: 0,
    minWeight: 2,
    // Backward compatibility for older consumers/tests.
    totalEdges: 0,
    totalNodes: 0
  };

  // Hoist EdgeAggregator out of the per-call hot path. Constructing a fresh
  // aggregator on every GET_RELATED_DOCUMENTS call (which fires on every
  // InsightDock refresh and every Related Docs panel selection) re-resolves DI
  // refs and re-builds centroid-bridge cluster lookup. One per IPC registration
  // is plenty.
  /** @type {any} */
  let _aggregatorInstance = null;
  const getEdgeAggregator = () => {
    if (!_aggregatorInstance) {
      _aggregatorInstance = new EdgeAggregator();
    }
    return _aggregatorInstance;
  };

  /** @type {any} */
  let _cachedFallbackService = null;
  const getRelationshipService = () => {
    try {
      if (container?.has?.(ServiceIds.RELATIONSHIP_INDEX)) {
        return container.resolve(ServiceIds.RELATIONSHIP_INDEX);
      }
    } catch (error) {
      logger.debug('[Knowledge IPC] RelationshipIndexService not in container', {
        error: error?.message || String(error)
      });
    }

    const integration = getServiceIntegration && getServiceIntegration();
    if (integration?.relationshipIndex) {
      return integration.relationshipIndex;
    }

    const analysisHistoryService = integration?.analysisHistory;
    if (!analysisHistoryService) return null;
    if (!_cachedFallbackService) {
      _cachedFallbackService = new RelationshipIndexService({ analysisHistoryService });
    }
    return _cachedFallbackService;
  };

  registerHandlers({
    ipcMain,
    logger,
    context: 'Knowledge',
    handlers: {
      [IPC_CHANNELS.KNOWLEDGE.GET_RELATIONSHIP_EDGES]: {
        schema: schemas.relationshipEdges,
        handler: async (event, { fileIds, minWeight, maxEdges } = {}) => {
          const service = getRelationshipService();
          if (!service) return { success: true, edges: [] };
          const response = await service.getEdges(fileIds, { minWeight, maxEdges });
          if (Array.isArray(response)) {
            return { success: true, edges: response };
          }
          return response && typeof response === 'object' ? response : { success: true, edges: [] };
        }
      },
      [IPC_CHANNELS.KNOWLEDGE.GET_RELATIONSHIP_STATS]: {
        schema: schemas.relationshipStats,
        handler: async () => {
          const service = getRelationshipService();
          if (!service) return emptyStats;
          const response = await service.getStats();
          if (!response || typeof response !== 'object') return emptyStats;
          return response;
        }
      },
      [IPC_CHANNELS.KNOWLEDGE.GET_RELATED_DOCUMENTS]: {
        schema: schemas.relatedDocuments,
        handler: async (
          event,
          { fileId, limit = 20, minWeight = 2, similarityThreshold = 0.5 } = {}
        ) => {
          try {
            const aggregator = getEdgeAggregator();
            const { edges, neighbors } = await aggregator.getEdgesForFiles([fileId], {
              limit,
              minWeight,
              similarityThreshold
            });
            // Cap idsToFetch at the requested limit (+1 for the seed). Without
            // this, a hub node with 200 edges produces 200 Orama getFile
            // round-trips per click even though only `limit` rows render.
            const cappedNeighbors = Array.isArray(neighbors)
              ? neighbors.slice(0, Math.max(1, limit))
              : [];
            const idsToFetch = Array.from(new Set([fileId, ...cappedNeighbors]));
            const files = await aggregator.getFileMetadata(idsToFetch);
            return { success: true, edges, neighbors, files };
          } catch (err) {
            logger.error('[Knowledge IPC] getRelatedDocuments failed', {
              error: err?.message
            });
            return {
              success: false,
              error: err?.message || 'Failed to get related documents',
              edges: [],
              neighbors: [],
              files: {}
            };
          }
        }
      },
      [IPC_CHANNELS.KNOWLEDGE.REBUILD_RELATIONSHIPS]: {
        schema: schemas.rebuildRelationships,
        handler: async () => {
          const service = getRelationshipService();
          if (!service) {
            return {
              success: false,
              error: 'RelationshipIndexService unavailable',
              errorCode: 'SERVICE_UNAVAILABLE'
            };
          }
          if (typeof service.rebuildNow !== 'function') {
            return {
              success: false,
              error: 'Rebuild not supported by this service instance',
              errorCode: 'REBUILD_UNSUPPORTED'
            };
          }
          try {
            const result = await service.rebuildNow();
            return {
              success: result?.success !== false,
              edgeCount: Array.isArray(result?.edges) ? result.edges.length : undefined,
              error: result?.error || undefined
            };
          } catch (err) {
            logger.error('[Knowledge IPC] rebuildRelationships failed', {
              error: err?.message
            });
            return { success: false, error: err?.message || 'Rebuild failed' };
          }
        }
      }
    }
  });
}

module.exports = registerKnowledgeIpc;
