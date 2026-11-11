// @ts-check
/**
 * Graph layout utilities for UnifiedSearchModal
 * Pure functions for zoom buckets, edge keys, and recommendation graph building
 *
 * @module search/utils/graphLayoutUtils
 */

/** Zoom below this hides node/edge labels (see getZoomBucket). */
export const ZOOM_LABEL_HIDE_THRESHOLD = 0.6;
const EDGE_LABEL_HIDE_THRESHOLD = 0.9;
/** Cap fit-view zoom-out so the initial graph frame stays label-readable. */
export const GRAPH_FIT_VIEW_MIN_ZOOM = ZOOM_LABEL_HIDE_THRESHOLD;
export const GRAPH_FIT_VIEW_MAX_ZOOM = 1.5;

/**
 * Default React Flow fitView options — keeps auto-fit from zooming past label threshold.
 * @param {import('@xyflow/react').FitViewOptions} [overrides]
 * @returns {import('@xyflow/react').FitViewOptions}
 */
export function getDefaultGraphFitViewOptions(overrides = {}) {
  return {
    padding: 0.2,
    minZoom: GRAPH_FIT_VIEW_MIN_ZOOM,
    maxZoom: GRAPH_FIT_VIEW_MAX_ZOOM,
    ...overrides
  };
}
const PARALLEL_EDGE_OFFSET_PX = 14;

/** @type {Readonly<Record<string, number>>} */
export const EDGE_KIND_PRIORITY = Object.freeze({
  query_match: 0,
  similarity: 1,
  knowledge: 2,
  cross_cluster: 3,
  organize: 4,
  cluster_member: 5
});

export function getZoomBucket(/** @type {number} */ zoom) {
  if (zoom < ZOOM_LABEL_HIDE_THRESHOLD) return 'far';
  if (zoom < EDGE_LABEL_HIDE_THRESHOLD) return 'mid';
  return 'near';
}

export function buildUndirectedEdgeKey(/** @type {any} */ edge) {
  const source = String(edge?.source || '');
  const target = String(edge?.target || '');
  return source <= target ? `${source}::${target}` : `${target}::${source}`;
}

export function applyParallelEdgeOffsets(/** @type {any[]} */ edges = []) {
  if (!Array.isArray(edges) || edges.length === 0) {
    return edges || [];
  }

  const grouped = new Map();
  let hasParallelEdges = false;
  edges.forEach((edge, index) => {
    const key = buildUndirectedEdgeKey(edge);
    const existing = grouped.get(key);
    if (existing) {
      hasParallelEdges = true;
      existing.push({ edge, index });
      return;
    }
    grouped.set(key, [{ edge, index }]);
  });

  if (!hasParallelEdges) {
    return edges;
  }

  const desiredOffsets = new Array(edges.length).fill(0);
  grouped.forEach((entries) => {
    if (entries.length <= 1) return;

    const sorted = [...entries].sort((a, b) => {
      const kindA = EDGE_KIND_PRIORITY[a.edge?.data?.kind] ?? 99;
      const kindB = EDGE_KIND_PRIORITY[b.edge?.data?.kind] ?? 99;
      if (kindA !== kindB) return kindA - kindB;
      const idA = String(a.edge?.id || '');
      const idB = String(b.edge?.id || '');
      return idA.localeCompare(idB);
    });

    const center = (sorted.length - 1) / 2;
    sorted.forEach((entry, idx) => {
      desiredOffsets[entry.index] = Math.round((idx - center) * PARALLEL_EDGE_OFFSET_PX);
    });
  });

  let changed = false;
  const nextEdges = edges.map((edge, index) => {
    const desiredOffset = desiredOffsets[index];
    const currentOffset = Number(edge?.data?.parallelOffset || 0);
    if (currentOffset === desiredOffset) return edge;
    changed = true;
    return {
      ...edge,
      data: {
        ...edge.data,
        parallelOffset: desiredOffset
      }
    };
  });

  return changed ? nextEdges : edges;
}

export function buildRecommendationGraph(/** @type {any[]} */ fileNodes = []) {
  const folderNodesMap = new Map();
  /** @type {any[]} */
  const edges = [];

  fileNodes.forEach((node) => {
    const folder = typeof node?.data?.suggestedFolder === 'string' ? node.data.suggestedFolder : '';
    const trimmed = folder.trim();
    if (!trimmed) return;

    const folderId = `folder:${trimmed}`;
    if (!folderNodesMap.has(folderId)) {
      const basePosition = node.position || { x: 0, y: 0 };
      folderNodesMap.set(folderId, {
        id: folderId,
        type: 'folderNode',
        position: { x: basePosition.x + 260, y: basePosition.y },
        data: { id: folderId, kind: 'folder', label: trimmed, memberCount: 0 },
        draggable: true
      });
    }

    const folderNode = folderNodesMap.get(folderId);
    folderNode.data.memberCount = (folderNode.data.memberCount || 0) + 1;

    edges.push({
      id: `e:organize:${node.id}->${folderId}`,
      source: node.id,
      target: folderId,
      type: 'smartStep',
      label: 'Organize',
      style: {
        stroke: '#f0b030',
        strokeWidth: 1.5
      },
      data: {
        kind: 'organize'
      }
    });
  });

  return {
    folderNodes: Array.from(folderNodesMap.values()),
    edges
  };
}

/**
 * Folder nodes are keyed by smart-folder NAME (see buildRecommendationGraph);
 * file operations need the folder's real path. Returns '' when unknown.
 *
 * @param {any[]} smartFolders - `{ name, path }` entries from the store
 * @param {string} folderName
 * @returns {string}
 */
export function resolveSmartFolderPath(smartFolders, folderName) {
  const wanted = typeof folderName === 'string' ? folderName.trim() : '';
  if (!wanted) return '';
  // Already an absolute path (older recommendation payloads).
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(wanted)) return wanted;
  const key = wanted.toLowerCase();
  const match = (Array.isArray(smartFolders) ? smartFolders : []).find(
    (folder) =>
      typeof folder?.name === 'string' &&
      folder.name.trim().toLowerCase() === key &&
      typeof folder?.path === 'string' &&
      folder.path.trim().length > 0
  );
  return match ? match.path : '';
}

export const REL_CLUSTER_EDGE_PREFIX = 'rel-cluster:';

/**
 * Knowledge edges between clusters are fetched once per cluster load and
 * added after the first render. A re-render (mode/filter change, background
 * refresh) rebuilds the edge list, so carry over the ones whose two clusters
 * are still on screen.
 *
 * @param {any[]} previousEdges - edges currently in the graph
 * @param {any[]} nextNodes - nodes about to be rendered
 * @param {any[]} nextEdges - edges about to be rendered
 * @returns {any[]}
 */
export function carryOverRelClusterEdges(previousEdges, nextNodes, nextEdges) {
  const next = Array.isArray(nextEdges) ? nextEdges : [];
  const nodeIds = new Set((Array.isArray(nextNodes) ? nextNodes : []).map((n) => n?.id));
  const taken = new Set(next.map((e) => e?.id));
  const kept = (Array.isArray(previousEdges) ? previousEdges : []).filter(
    (edge) =>
      typeof edge?.id === 'string' &&
      edge.id.startsWith(REL_CLUSTER_EDGE_PREFIX) &&
      !taken.has(edge.id) &&
      nodeIds.has(edge.source) &&
      nodeIds.has(edge.target)
  );
  return kept.length > 0 ? [...next, ...kept] : next;
}

/**
 * Fingerprint of a freshly drawn cluster overview: which nodes, and where.
 *
 * @param {any[]} nodes
 * @returns {string}
 */
export function buildClusterOverviewSignature(nodes) {
  return (Array.isArray(nodes) ? nodes : [])
    .map((n) => `${n?.id}@${Math.round(n?.position?.x ?? 0)},${Math.round(n?.position?.y ?? 0)}`)
    .sort()
    .join('|');
}

/**
 * True while the graph is still exactly the overview that was drawn: no node
 * added, removed, expanded or dragged since. The delayed background refresh
 * redraws the whole graph, so it may only run while this holds.
 *
 * @param {string|null} signature - from buildClusterOverviewSignature at draw time
 * @param {any[]} currentNodes
 * @returns {boolean}
 */
export function isClusterOverviewUntouched(signature, currentNodes) {
  if (typeof signature !== 'string' || signature.length === 0) return false;
  const nodes = Array.isArray(currentNodes) ? currentNodes : [];
  if (nodes.some((n) => n?.data?.expanded || n?.dragging)) return false;
  return buildClusterOverviewSignature(nodes) === signature;
}

/**
 * What a cluster payload would draw. Two payloads with the same key render
 * the same overview, so a refresh that returns one can be skipped.
 *
 * @param {any[]} clusters
 * @param {any[]} crossClusterEdges
 * @returns {string}
 */
export function getClusterPayloadKey(clusters, crossClusterEdges) {
  const clusterPart = (Array.isArray(clusters) ? clusters : [])
    .map((c) => `${c?.id}:${c?.label}:${c?.memberCount}:${c?.confidence}`)
    .join('|');
  const edgePart = (Array.isArray(crossClusterEdges) ? crossClusterEdges : [])
    .map((e) => `${e?.source}>${e?.target}:${e?.similarity}`)
    .join('|');
  return `${clusterPart}#${edgePart}`;
}
