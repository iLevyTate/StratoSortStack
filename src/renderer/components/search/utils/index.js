// @ts-check
/**
 * Search modal utility exports
 */

export {
  normalizeGraphPathKey,
  extractPathFromSemanticId,
  toMetadataObject,
  getMetadataPath,
  getMetadataName,
  nodeDeduplicationKey
} from './graphPathUtils';

export {
  getZoomBucket,
  getDefaultGraphFitViewOptions,
  GRAPH_FIT_VIEW_MIN_ZOOM,
  GRAPH_FIT_VIEW_MAX_ZOOM,
  buildUndirectedEdgeKey,
  applyParallelEdgeOffsets,
  buildRecommendationGraph,
  resolveSmartFolderPath,
  carryOverRelClusterEdges,
  buildClusterOverviewSignature,
  isClusterOverviewUntouched,
  getClusterPayloadKey,
  REL_CLUSTER_EDGE_PREFIX,
  EDGE_KIND_PRIORITY
} from './graphLayoutUtils';

export {
  getErrorMessage,
  validateSearchResponse,
  getParentFolderName,
  getConnectionReason,
  getFileExtension,
  formatGraphBridgeFileLabel
} from './searchResultUtils';

export {
  getDefaultClusterFilters,
  getDefaultActiveFilters,
  DEFAULT_CLUSTER_MODE,
  CLUSTER_MODE_CHIP_LABELS
} from './graphFilterDefaults';

export {
  regroupClustersForMode,
  flattenClusterMembers,
  getRecencyBucketKey,
  getRecencyBucketLabel,
  parseSemanticClusterId,
  RECENCY_BUCKETS
} from './clusterRegroupUtils';

export {
  FILE_METADATA_BATCH_LIMIT,
  ADD_TAGS_BATCH_LIMIT,
  chunkArray,
  fetchFileMetadataChunked,
  addTagsChunked
} from './ipcBatchUtils';

export {
  scoreBridgeConnection,
  scoreClusterForInsight,
  compareClustersForInsight,
  isCrossClusterSurprise,
  rankCrossClusterConnections,
  sortClustersForInsight,
  pickSurpriseConnections
} from './graphInsightUtils';
