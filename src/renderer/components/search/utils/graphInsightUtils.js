// @ts-check
/**
 * Client-side ranking for Knowledge OS insight cards and dock ordering.
 * Uses only data already on cluster nodes and cross-cluster edges.
 */

const SURPRISE_SIMILARITY_MIN = 0.82;

/**
 * @param {any} connection - Ranked connection row from clusterInsights
 * @returns {number}
 */
export function scoreBridgeConnection(connection) {
  if (!connection || typeof connection !== 'object') return 0;
  const sim = Number(connection.similarity) || 0;
  const bridgeCount = Array.isArray(connection.bridgeFiles) ? connection.bridgeFiles.length : 0;
  const termBoost = Array.isArray(connection.sharedTerms)
    ? connection.sharedTerms.length * 0.02
    : 0;
  const surpriseBoost = connection.isSurprise ? 0.15 : 0;
  const fileBoost = Math.min(bridgeCount, 8) * 0.04;
  return sim + fileBoost + termBoost + surpriseBoost;
}

/**
 * @param {import('@xyflow/react').Node} node
 * @returns {number}
 */
export function scoreClusterForInsight(node) {
  const memberCount = Number(node?.data?.memberCount) || 0;
  const scatteredBoost = node?.data?.dominantFolderName ? 0 : 12;
  return memberCount + scatteredBoost;
}

/**
 * @param {import('@xyflow/react').Node} a
 * @param {import('@xyflow/react').Node} b
 * @returns {number}
 */
export function compareClustersForInsight(a, b) {
  return scoreClusterForInsight(b) - scoreClusterForInsight(a);
}

/**
 * @param {any} edge - React Flow edge with cross_cluster data
 * @param {Map<string, import('@xyflow/react').Node>} clustersById
 * @returns {boolean}
 */
export function isCrossClusterSurprise(edge, clustersById) {
  const sim = Number(edge?.data?.similarity) || 0;
  if (sim < SURPRISE_SIMILARITY_MIN) return false;
  if (edge?.data?.isSurprise === true) return true;
  const source = clustersById.get(edge.source);
  const target = clustersById.get(edge.target);
  const sourceFolder = String(source?.data?.dominantFolderName || '').trim();
  const targetFolder = String(target?.data?.dominantFolderName || '').trim();
  return sourceFolder.length > 0 && targetFolder.length > 0 && sourceFolder !== targetFolder;
}

/**
 * @param {any[]} crossEdges
 * @param {Map<string, import('@xyflow/react').Node>} clustersById
 * @param {(row: any) => any} mapConnection - builds display row from edge
 * @param {number} [limit=12]
 * @returns {any[]}
 */
export function rankCrossClusterConnections(crossEdges, clustersById, mapConnection, limit = 12) {
  const list = Array.isArray(crossEdges) ? crossEdges : [];
  return list
    .map((edge) => {
      const row = mapConnection(edge);
      return {
        ...row,
        isSurprise: isCrossClusterSurprise(edge, clustersById)
      };
    })
    .sort((a, b) => scoreBridgeConnection(b) - scoreBridgeConnection(a))
    .slice(0, limit);
}

/**
 * @param {import('@xyflow/react').Node[]} clusterNodes
 * @param {number} [limit=8]
 * @returns {import('@xyflow/react').Node[]}
 */
export function sortClustersForInsight(clusterNodes, limit = 8) {
  const list = Array.isArray(clusterNodes) ? [...clusterNodes] : [];
  return list.sort(compareClustersForInsight).slice(0, limit);
}

/**
 * @param {any[]} rankedConnections - output of rankCrossClusterConnections
 * @param {number} [limit=3]
 * @returns {any[]}
 */
export function pickSurpriseConnections(rankedConnections, limit = 3) {
  const list = Array.isArray(rankedConnections) ? rankedConnections : [];
  return list.filter((c) => c.isSurprise).slice(0, limit);
}
