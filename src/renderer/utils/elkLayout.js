// @ts-check
/**
 * ELK.js layout utility for ReactFlow graph visualization
 * Provides intelligent hierarchical graph layout with proper spacing
 *
 * Performance optimizations:
 * - Debounced layout requests to prevent rapid re-layouts
 * - Request deduplication to avoid redundant computations
 * - Progressive rendering hints for large graphs
 * - Batched position updates
 *
 * @see https://github.com/kieler/elkjs#web-workers
 */

import ELK from 'elkjs/lib/elk-api.js';
import ELKNoWorker from 'elkjs/lib/elk.bundled.js';
import { logger } from '../../shared/logger';
import { NODE_SIZES, getLayoutBounds, radialLayout } from './elkLayoutUtils';

export { getLayoutBounds, radialLayout };

const shouldFallbackToMainThread = (/** @type {any} */ error) => {
  const message = error?.message || '';
  return (
    message.includes('Worker') ||
    message.includes('worker') ||
    message.includes('Failed to construct') ||
    message.includes('NetworkError')
  );
};

/** @param {{ useWorker?: boolean }} [opts] */
const createElkInstance = ({ useWorker } = {}) => {
  if (useWorker) {
    try {
      // webpack 5 transforms `new Worker(new URL(..., import.meta.url))` at build time,
      // emitting the worker file as a hashed asset and providing a correct file:// URL.
      // This is the only reliable approach in an Electron file:// context — the old
      // workerUrl string approach silently falls back to main-thread when the URL
      // resolves to the wrong path inside the bundle.
      const worker = new Worker(
        // @ts-expect-error import.meta.url is provided by webpack at build; tsc (commonjs module) rejects it
        new URL('elkjs/lib/elk-worker.min.js', import.meta.url)
      );
      // elk-api's ELK constructor accepts { workerUrl } or { workerFactory } —
      // NOT a pre-built { worker }. Passing { worker } threw "Cannot construct
      // an ELK without both 'workerUrl' and 'workerFactory'", which silently
      // forced EVERY graph layout onto the main thread (janky, cramped result).
      // Hand ELK a factory that returns the webpack-emitted worker so layout
      // actually runs off-thread.
      const instance = new ELK(/** @type {any} */ ({ workerFactory: () => worker }));
      logger.debug('[elkLayout] ELK worker initialised successfully');
      return { instance, usesWorker: true };
    } catch (error) {
      logger.warn(
        '[elkLayout] Worker construction failed; layout will run on main thread (may block UI for large graphs)',
        { error: error?.message || String(error) }
      );
    }
  }
  return { instance: new ELKNoWorker(), usesWorker: false };
};

// Lazy-init ELK instance on first use to avoid blocking module load if Worker fails
/** @type {any} */
let elk = null;
let elkUsesWorker = false;
let elkInitialized = false;

function ensureElk() {
  if (elkInitialized) return;
  elkInitialized = true;
  const result = createElkInstance({ useWorker: true });
  elk = result.instance;
  elkUsesWorker = result.usesWorker;
}

export function isWorkerActive() {
  return elkUsesWorker;
}

// Threshold for when to log performance warnings
const LARGE_GRAPH_THRESHOLD = 100;

// Threshold for "very large" graphs that need special handling
const VERY_LARGE_GRAPH_THRESHOLD = 200;

// Debounce tracking for layout requests
/** @type {any} */
let pendingLayoutPromise = null;
/** @type {any} */
let layoutDebounceTimer = null;
const LAYOUT_DEBOUNCE_MS = 200; // Increased debounce to let UI settle before heavy layout

// Track pending promise callbacks to prevent memory leaks and handle cancellation
const MAX_PENDING_CALLBACKS = 100;
/** @type {any[]} */
let pendingCallbacks = [];

// Store latest layout request data to prevent stale closure issues
/** @type {any} */
let latestLayoutData = { nodes: null, edges: null, options: {} };

// Track if layout was aborted to prevent resolving after cancellation
let layoutAborted = false;

// Topology hash and cached result to skip layout when only node data (not structure) changes
/** @type {any} */
let lastTopologyHash = null;
/** @type {any} */
let lastTopologyResult = null;

/**
 * Default layout options for ELK
 */
const DEFAULT_OPTIONS = {
  direction: 'RIGHT',
  algorithm: 'layered'
  // spacing and layerSpacing are computed adaptively per-call based on node count
};

const ALGORITHM_MAP = /** @type {Record<string, string>} */ ({
  layered: 'layered',
  force: 'org.eclipse.elk.force',
  stress: 'org.eclipse.elk.stress',
  radial: 'org.eclipse.elk.radial'
});

/**
 * Apply ELK layout to ReactFlow nodes and edges
 *
 * @param {any[]} nodes - ReactFlow nodes
 * @param {any[]} edges - ReactFlow edges
 * @param {Object} [options] - Layout options
 * @param {string} [options.direction] - Layout direction: 'RIGHT', 'DOWN', 'LEFT', 'UP'
 * @param {number} [options.spacing] - Node-to-node spacing
 * @param {number} [options.layerSpacing] - Spacing between layers
 * @param {string} [options.algorithm] - ELK algorithm: 'layered', 'force', 'stress'
 * @returns {Promise<{nodes: any[], edges: any[]}>} Object containing updated nodes and edges
 */
export async function elkLayout(nodes, edges, options = {}) {
  if (!nodes || nodes.length === 0) {
    return { nodes: nodes || [], edges: edges || [] };
  }

  ensureElk();

  // If worker failed and graph is large, fall back to progressive smartLayout
  // to avoid blocking the main thread for seconds
  if (!elkUsesWorker && nodes.length > LARGE_GRAPH_THRESHOLD) {
    logger.info(`[elkLayout] No worker available, using smartLayout for ${nodes.length} nodes`);
    return smartLayout(nodes, edges, { progressive: true, maxInitialNodes: 50, ...options });
  }

  // Normalize edges to empty array if null/undefined to prevent TypeError on .map()
  const safeEdges = edges || [];

  // Adaptive spacing: tighter for small graphs, wider for large ones
  const nodeCount = nodes.length;
  const adaptiveSpacing = nodeCount <= 10 ? 120 : nodeCount <= 30 ? 180 : 250;
  const adaptiveLayerSpacing = nodeCount <= 10 ? 200 : nodeCount <= 30 ? 300 : 400;

  const {
    direction = DEFAULT_OPTIONS.direction,
    spacing = adaptiveSpacing,
    layerSpacing = adaptiveLayerSpacing,
    algorithm = DEFAULT_OPTIONS.algorithm
  } = options;

  const elkAlgorithm = ALGORITHM_MAP[algorithm] || algorithm;

  // Spacing proportional to base spacing
  const edgeSpacing = Math.max(56, Math.round(spacing / 3));
  const edgeNodeSpacing = Math.max(56, Math.round(spacing / 2.6));
  const edgeLayerSpacing = Math.max(60, Math.round(layerSpacing / 3));

  // Base layout options
  const layoutOptions = /** @type {Record<string, string>} */ ({
    'elk.algorithm': elkAlgorithm,
    'elk.direction': direction,
    'elk.spacing.nodeNode': String(spacing),
    'elk.spacing.edgeEdge': String(edgeSpacing),
    'elk.spacing.edgeNode': String(edgeNodeSpacing),
    // Improve edge routing - SPLINES looks cleaner than ORTHOGONAL for complex graphs
    'elk.edgeRouting': 'SPLINES',
    // Prioritize node placement that reduces edge crossings
    'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
    // Keep edge order deterministic to reduce line stacking flicker between layouts
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    // Separate edge segments to prevent overlap
    'elk.layered.mergeEdges': 'false'
  });

  // Add algorithm-specific options
  if (elkAlgorithm === 'layered') {
    layoutOptions['elk.layered.spacing.nodeNodeBetweenLayers'] = String(layerSpacing);
    layoutOptions['elk.layered.spacing.edgeNodeBetweenLayers'] = String(edgeLayerSpacing);
    layoutOptions['elk.layered.spacing.edgeEdgeBetweenLayers'] = String(edgeSpacing);
    layoutOptions['elk.layered.nodePlacement.strategy'] = 'BRANDES_KOEPF'; // Better straight-line alignment
    layoutOptions['elk.spacing.componentComponent'] = String(spacing); // Keep disconnected clusters close
    layoutOptions['elk.layered.crossingMinimization.strategy'] = 'LAYER_SWEEP';
    layoutOptions['elk.layered.crossingMinimization.greedySwitch.type'] = 'TWO_SIDED';
  } else if (elkAlgorithm === 'org.eclipse.elk.force') {
    layoutOptions['elk.force.iterations'] = '100';
    layoutOptions['elk.force.repulsion'] = String(Math.max(2.0, spacing / 50)); // Scale repulsion
    layoutOptions['elk.force.temperature'] = '0.1'; // Low temperature for stability
  }

  // Build ELK graph structure
  const nodeIds = new Set(nodes.map((n) => n.id));
  let skippedEdgeCount = 0;
  /** @type {any[]} */
  const skippedEdgeSamples = [];
  const elkGraph = {
    id: 'root',
    layoutOptions,
    children: nodes.map((node) => {
      const size = /** @type {any} */ (NODE_SIZES)[node.type] || NODE_SIZES.default;
      return {
        id: node.id,
        width: size.width,
        height: size.height
      };
    }),
    edges: safeEdges
      .filter((edge) => {
        const hasSource = nodeIds.has(edge.source);
        const hasTarget = nodeIds.has(edge.target);
        if (!hasSource || !hasTarget) {
          // Avoid log spam: collect and emit a single summary warning below.
          skippedEdgeCount++;
          if (skippedEdgeSamples.length < 10) {
            skippedEdgeSamples.push({
              id: edge.id,
              source: edge.source,
              target: edge.target,
              hasSource,
              hasTarget
            });
          }
          return false;
        }
        return true;
      })
      .map((edge) => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target]
      }))
  };

  try {
    if (skippedEdgeCount > 0) {
      logger.warn(`[elkLayout] Skipping ${skippedEdgeCount} edge(s) referencing missing node(s)`, {
        sample: skippedEdgeSamples
      });
    }
    // Performance measurement for large graphs
    const startTime = performance.now();

    if (nodes.length >= LARGE_GRAPH_THRESHOLD) {
      logger.warn(`[elkLayout] Large graph detected (${nodes.length} nodes), layout may take time`);
    }

    const elkInstance = elk;
    const usesWorker = elkUsesWorker;
    let layout;
    try {
      layout = await elkInstance.layout(elkGraph);
    } catch (error) {
      if (usesWorker && shouldFallbackToMainThread(error)) {
        logger.warn('[elkLayout] Worker failed; retrying on main thread', {
          error: error?.message || String(error)
        });
        const fallbackElk = createElkInstance({ useWorker: false });
        // Persist fallback mode so future layouts don't repeatedly hit worker failures.
        elk = fallbackElk.instance;
        elkUsesWorker = false;
        layout = await fallbackElk.instance.layout(elkGraph);
      } else {
        throw error;
      }
    }
    const duration = performance.now() - startTime;

    // Log performance for monitoring
    if (duration > 100 || nodes.length >= LARGE_GRAPH_THRESHOLD) {
      logger.debug(
        `[elkLayout] Layout completed in ${duration.toFixed(1)}ms for ${nodes.length} nodes`
      );
    }

    const updatedNodes = applyElkPositions(nodes, layout.children);
    const updatedEdges = applyElkEdgeRoutes(safeEdges, layout.edges);

    return { nodes: updatedNodes, edges: updatedEdges };
  } catch (error) {
    logger.error('[elkLayout] Layout failed:', { error: error.message });
    // Return original nodes and edges if layout fails
    return { nodes, edges: safeEdges };
  }
}

/**
 * Debounced version of elkLayout that prevents rapid re-layouts
 * Coalesces multiple layout requests into a single execution
 *
 * Benefits:
 * - Prevents UI jank from rapid search queries
 * - Deduplicates redundant layout requests
 * - Returns same promise for concurrent calls
 *
 * @param {any[]} nodes - ReactFlow nodes
 * @param {any[]} edges - ReactFlow edges
 * @param {Record<string, any>} [options] - Layout options (debounceMs + elkLayout options)
 * @returns {Promise<{nodes: any[], edges: any[]}>} Object containing updated nodes and edges
 */
export function debouncedElkLayout(nodes, edges, options = {}) {
  const { debounceMs = LAYOUT_DEBOUNCE_MS, ...layoutOptions } = options;

  // Compute a cheap topology hash — only node IDs and edge connections, not display data.
  // If the topology hasn't changed (e.g. only score/label updated), skip ELK entirely.
  const safeNodes = nodes || [];
  const safeEdges = edges || [];
  const layoutOptionHash = [
    layoutOptions.direction ?? '',
    layoutOptions.spacing ?? '',
    layoutOptions.layerSpacing ?? '',
    layoutOptions.algorithm ?? ''
  ].join('|');
  const topologyHash =
    safeNodes.map((n) => n.id).join('\x00') +
    '|' +
    safeEdges.map((e) => `${e.source}>${e.target}`).join('\x00') +
    '|' +
    layoutOptionHash;
  if (topologyHash === lastTopologyHash && lastTopologyResult) {
    const positionById = new Map(
      (lastTopologyResult.nodes || []).map((/** @type {any} */ node) => [node.id, node.position])
    );
    const elkSectionsById = new Map(
      (lastTopologyResult.edges || []).map((/** @type {any} */ edge) => [
        edge.id,
        edge?.data?.elkSections
      ])
    );
    const nodesWithCachedPositions = safeNodes.map((node) => {
      const cachedPosition = positionById.get(node.id);
      return cachedPosition ? { ...node, position: cachedPosition } : node;
    });
    const edgesWithCachedRoutes = safeEdges.map((edge) => {
      const cachedSections = elkSectionsById.get(edge.id);
      return cachedSections
        ? {
            ...edge,
            data: {
              ...edge.data,
              elkSections: cachedSections
            }
          }
        : edge;
    });
    return Promise.resolve({
      nodes: nodesWithCachedPositions,
      edges: edgesWithCachedRoutes
    });
  }

  // Store latest data in module-level variable to prevent stale closure issues
  // When the debounce timer fires, it will use the most recent data.
  // Also store pre-computed topologyHash to avoid recomputing after layout.
  latestLayoutData = { nodes: safeNodes, edges: safeEdges, options: layoutOptions, topologyHash };
  layoutAborted = false;

  return new Promise((resolve, reject) => {
    // Clear any pending debounce timer - new request supersedes old ones
    if (layoutDebounceTimer) {
      clearTimeout(layoutDebounceTimer);
    }

    // Track this resolver, evicting oldest entries if over the cap
    if (pendingCallbacks.length >= MAX_PENDING_CALLBACKS) {
      const evicted = pendingCallbacks.splice(
        0,
        pendingCallbacks.length - MAX_PENDING_CALLBACKS + 1
      );
      const evictError = new Error('Layout callback evicted (too many pending)');
      evictError.name = 'AbortError';
      evicted.forEach((cb) => cb.reject(evictError));
    }
    pendingCallbacks.push({ resolve, reject });

    // Set up debounced execution
    layoutDebounceTimer = setTimeout(async () => {
      layoutDebounceTimer = null;

      // Check if layout was aborted during debounce wait
      if (layoutAborted) {
        // Reject any pending callbacks that haven't been handled
        if (pendingCallbacks.length > 0) {
          const error = new Error('Layout cancelled');
          error.name = 'AbortError';
          pendingCallbacks.forEach((cb) => cb.reject(error));
          pendingCallbacks = [];
        }
        return;
      }

      // Capture callbacks to notify
      const callbacksToNotify = [...pendingCallbacks];
      pendingCallbacks = [];

      // Get the latest data (not stale closure data)
      const { nodes: latestNodes, edges: latestEdges, options: latestOptions } = latestLayoutData;

      // but then ALWAYS use the latest data for the result instead of reusing
      // the pending promise's result. This prevents stale data issues when
      // new requests come in with different data during a running layout.
      if (pendingLayoutPromise) {
        try {
          await pendingLayoutPromise;
          // Don't reuse the result - fall through to compute with latest data
          // The pending layout may have used older data
        } catch {
          // Fall through to new layout
        }
      }

      // Execute the layout with LATEST data (not stale closure data)
      pendingLayoutPromise = elkLayout(latestNodes, latestEdges, latestOptions);

      try {
        const result = await pendingLayoutPromise;
        if (layoutAborted) {
          const error = new Error('Layout cancelled');
          error.name = 'AbortError';
          callbacksToNotify.forEach((cb) => cb.reject(error));
        } else {
          // Cache the result so identical topology can skip ELK on the next call.
          // Reuse the pre-computed topologyHash from latestLayoutData (Fix 8).
          lastTopologyHash = latestLayoutData.topologyHash;
          lastTopologyResult = result;
          callbacksToNotify.forEach((cb) => cb.resolve(result));
        }
      } catch (error) {
        logger.error('[elkLayout] Debounced layout failed:', error);
        if (layoutAborted) {
          const abortError = new Error('Layout cancelled');
          abortError.name = 'AbortError';
          callbacksToNotify.forEach((cb) => cb.reject(abortError));
        } else {
          callbacksToNotify.forEach((cb) => cb.resolve({ nodes: latestNodes, edges: latestEdges }));
        }
      } finally {
        pendingLayoutPromise = null;
      }
    }, debounceMs);
  });
}

/**
 * Cancel any pending debounced layout
 * Useful when component unmounts or user cancels operation
 *
 * Note: ELK layout computation itself cannot be cancelled once started,
 * but this prevents callbacks from being resolved after cancellation.
 */
export function cancelPendingLayout() {
  // Set abort flag to prevent any pending callbacks from resolving
  layoutAborted = true;

  // Invalidate topology cache so the next layout always runs fresh
  lastTopologyHash = null;
  lastTopologyResult = null;

  if (layoutDebounceTimer) {
    clearTimeout(layoutDebounceTimer);
    layoutDebounceTimer = null;
  }

  // Reject pending promises with AbortError to signal cancellation
  if (pendingCallbacks.length > 0) {
    const error = new Error('Layout cancelled');
    error.name = 'AbortError';
    pendingCallbacks.forEach((cb) => cb.reject(error));
    pendingCallbacks = [];
  }

  // Clear the promise reference (actual ELK computation may still run but results will be ignored)
  pendingLayoutPromise = null;

  // Clear cached layout data
  latestLayoutData = { nodes: null, edges: null, options: {} };
}

/**
 * Smart layout that automatically chooses the best strategy
 * based on graph size and complexity
 *
 * @param {any[]} nodes - ReactFlow nodes
 * @param {any[]} edges - ReactFlow edges
 * @param {Record<string, any>} [options] - Layout options (progressive, maxInitialNodes + elkLayout options)
 * @returns {Promise<any>} Layout result ({ nodes, edges } plus optional isPartial/totalNodes/layoutedCount)
 */
export async function smartLayout(nodes, edges, options = {}) {
  const { progressive = true, maxInitialNodes = 50, ...layoutOptions } = options;

  if (!nodes || nodes.length === 0) {
    return { nodes: nodes || [], edges: edges || [], isPartial: false, totalNodes: 0 };
  }

  // Normalize edges to empty array if null/undefined
  const safeEdges = edges || [];
  const totalNodes = nodes.length;

  // For very large graphs with progressive enabled, layout only important nodes first
  if (progressive && totalNodes > VERY_LARGE_GRAPH_THRESHOLD) {
    logger.info(`[elkLayout] Progressive layout for ${totalNodes} nodes`);

    // Sort nodes by importance (score, or if no score, keep original order)
    const sortedNodes = [...nodes].sort((a, b) => {
      const scoreA = a.data?.score || a.data?.withinScore || 0;
      const scoreB = b.data?.score || b.data?.withinScore || 0;
      return scoreB - scoreA;
    });

    // Take top N nodes for initial layout
    const initialNodes = sortedNodes.slice(0, maxInitialNodes);
    const initialNodeIds = new Set(initialNodes.map((n) => n.id));

    // Filter edges to only include those between initial nodes
    const initialEdges = safeEdges.filter(
      (e) => initialNodeIds.has(e.source) && initialNodeIds.has(e.target)
    );

    // Layout initial nodes
    const { nodes: layoutedInitial, edges: layoutedEdges } = await elkLayout(
      initialNodes,
      initialEdges,
      layoutOptions
    );

    // For remaining nodes, position them in a grid below the laid out nodes
    const remainingNodes = sortedNodes.slice(maxInitialNodes);
    const bounds = getLayoutBounds(layoutedInitial);
    const gridStartY = bounds.maxY + 100;
    const gridColumns = 5;
    const gridSpacing = { x: 200, y: 80 };

    const layoutedRemaining = remainingNodes.map((node, index) => ({
      ...node,
      position: {
        x: (index % gridColumns) * gridSpacing.x,
        y: gridStartY + Math.floor(index / gridColumns) * gridSpacing.y
      }
    }));

    return {
      nodes: [...layoutedInitial, ...layoutedRemaining],
      edges: [
        ...layoutedEdges,
        ...safeEdges.filter((e) => !initialNodeIds.has(e.source) || !initialNodeIds.has(e.target))
      ],
      isPartial: true,
      totalNodes,
      layoutedCount: initialNodes.length
    };
  }

  // For smaller graphs, do full layout
  return await elkLayout(nodes, safeEdges, layoutOptions);
}

/**
 * Apply ELK positions back to ReactFlow nodes
 *
 * @param {any[]} nodes - Original ReactFlow nodes
 * @param {any[]} elkChildren - ELK layout result children
 * @returns {any[]} Nodes with updated positions
 */
function applyElkPositions(nodes, elkChildren) {
  if (!elkChildren || elkChildren.length === 0) {
    return nodes;
  }

  const posMap = new Map(
    elkChildren.map((child) => [child.id, { x: child.x || 0, y: child.y || 0 }])
  );

  return nodes.map((node) => {
    const newPos = posMap.get(node.id);
    if (!newPos) return node;

    // Only update if position actually changed
    const currentPos = node.position || { x: 0, y: 0 };
    if (currentPos.x === newPos.x && currentPos.y === newPos.y) {
      return node;
    }

    return {
      ...node,
      position: newPos
    };
  });
}

/**
 * Apply ELK edge routes to ReactFlow edges
 *
 * @param {any[]} edges - Original ReactFlow edges
 * @param {any[]} elkEdges - ELK layout result edges
 * @returns {any[]} Edges with updated route data
 */
function applyElkEdgeRoutes(edges, elkEdges) {
  if (!elkEdges || elkEdges.length === 0) {
    return edges;
  }

  const routeMap = new Map(elkEdges.map((edge) => [edge.id, edge.sections]));

  return edges.map((edge) => {
    const sections = routeMap.get(edge.id);
    if (!sections) return edge;

    return {
      ...edge,
      data: {
        ...edge.data,
        elkSections: sections
      }
    };
  });
}

/**
 * Layout clusters in an intelligent hierarchical pattern
 * Groups related clusters together and sizes them by member count
 *
 * @param {any[]} clusterNodes - Cluster nodes
 * @param {any[]} edges - Edges between clusters (used to determine relationships)
 * @param {Record<string, any>} [options] - Layout options
 * @returns {any[]} Nodes with calculated positions
 */
export function clusterRadialLayout(clusterNodes, edges, options = {}) {
  const { centerX = 400, centerY = 300, radius = 500 } = options;
  const clusterSize = NODE_SIZES.clusterNode || { width: 180, height: 180 };
  const arcPadding = 250; // Increased to 250 for much better separation and to allow expansion

  if (!clusterNodes || clusterNodes.length === 0) {
    return clusterNodes;
  }

  // Single cluster - place in center
  if (clusterNodes.length === 1) {
    return clusterNodes.map((node) => ({
      ...node,
      position: { x: centerX, y: centerY }
    }));
  }

  // Sort clusters by member count (largest first) for prominence
  const sortedClusters = [...clusterNodes].sort((a, b) => {
    const countA = a.data?.memberCount || 0;
    const countB = b.data?.memberCount || 0;
    return countB - countA;
  });

  // Group clusters by confidence level for visual hierarchy
  const highConfidence = sortedClusters.filter((n) => n.data?.confidence === 'high');
  const mediumConfidence = sortedClusters.filter((n) => n.data?.confidence === 'medium');
  const lowConfidence = sortedClusters.filter((n) => n.data?.confidence === 'low');

  // Build adjacency map from edges to identify connected clusters
  const safeEdges = edges || [];
  const adjacency = new Map();
  safeEdges.forEach((edge) => {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
    adjacency.get(edge.source).add(edge.target);
    adjacency.get(edge.target).add(edge.source);
  });

  // Use force-directed-like placement: connected clusters stay closer
  const positioned = new Map();
  /** @type {any[]} */
  const result = [];

  // Calculate radii that scale with node size and ring density to avoid overlap
  const baseRadius = Math.max(radius, clusterSize.width * 1.5);
  const calcRingRadius = (
    /** @type {number} */ count,
    /** @type {number} */ ringMultiplier,
    minPreviousRadius = 0
  ) => {
    const nodesInRing = Math.max(count, 1);
    const minCircumference = nodesInRing * (clusterSize.width + arcPadding);
    const minRadiusForSpacing = minCircumference / (2 * Math.PI);
    const scaledRadius = Math.max(baseRadius * ringMultiplier, minRadiusForSpacing);
    // Ensure rings never collapse into each other vertically
    const separatedRadius =
      minPreviousRadius > 0
        ? Math.max(scaledRadius, minPreviousRadius + clusterSize.height + arcPadding / 2)
        : scaledRadius;
    return Math.max(separatedRadius, clusterSize.width + arcPadding);
  };

  const innerRadius = calcRingRadius(highConfidence.length, 0.65);
  highConfidence.forEach((node, idx) => {
    const angle = (idx / Math.max(1, highConfidence.length)) * 2 * Math.PI - Math.PI / 2;
    const pos = {
      x: centerX + innerRadius * Math.cos(angle),
      y: centerY + innerRadius * Math.sin(angle)
    };
    positioned.set(node.id, pos);
    result.push({ ...node, position: pos });
  });

  // Position medium-confidence clusters in the middle ring
  const middleRadius = calcRingRadius(mediumConfidence.length, 0.9, innerRadius);
  mediumConfidence.forEach((node, idx) => {
    // Try to position near connected high-confidence clusters
    const neighbors = adjacency.get(node.id) || new Set();
    let bestAngle = (idx / Math.max(1, mediumConfidence.length)) * 2 * Math.PI - Math.PI / 2;

    // If connected to a positioned cluster, bias towards it
    for (const neighborId of neighbors) {
      if (positioned.has(neighborId)) {
        const neighborPos = positioned.get(neighborId);
        bestAngle = Math.atan2(neighborPos.y - centerY, neighborPos.x - centerX);
        // Add small offset to avoid overlap
        bestAngle += idx % 2 === 0 ? 0.3 : -0.3;
        break;
      }
    }

    const pos = {
      x: centerX + middleRadius * Math.cos(bestAngle),
      y: centerY + middleRadius * Math.sin(bestAngle)
    };
    positioned.set(node.id, pos);
    result.push({ ...node, position: pos });
  });

  // Position low-confidence clusters in the outer ring
  const outerRadius = calcRingRadius(lowConfidence.length, 1.25, middleRadius);
  lowConfidence.forEach((node, idx) => {
    // Try to position near connected clusters
    const neighbors = adjacency.get(node.id) || new Set();
    let bestAngle = (idx / Math.max(1, lowConfidence.length)) * 2 * Math.PI - Math.PI / 2;

    for (const neighborId of neighbors) {
      if (positioned.has(neighborId)) {
        const neighborPos = positioned.get(neighborId);
        bestAngle = Math.atan2(neighborPos.y - centerY, neighborPos.x - centerX);
        bestAngle += idx % 2 === 0 ? 0.4 : -0.4;
        break;
      }
    }

    const pos = {
      x: centerX + outerRadius * Math.cos(bestAngle),
      y: centerY + outerRadius * Math.sin(bestAngle)
    };
    positioned.set(node.id, pos);
    result.push({ ...node, position: pos });
  });

  // Apply repulsion pass to avoid overlaps
  const minRepulsionDistance = Math.max(clusterSize.width + arcPadding, baseRadius * 0.35);
  return applyClusterRepulsion(result, {
    centerX,
    centerY,
    minDistance: minRepulsionDistance,
    iterations: 5
  });
}

/**
 * Apply simple repulsion to avoid cluster overlaps
 * FIX CRIT: Optimized from O(n²) to O(n) using spatial grid hashing
 * For 200 nodes, reduces from 40,000 comparisons to ~200 comparisons per iteration
 * @param {any[]} nodes - Cluster nodes with positions
 * @param {Record<string, any>} [options] - { minDistance, iterations }
 * @returns {any[]} Nodes with repulsed positions
 * @private
 */
function applyClusterRepulsion(nodes, options = {}) {
  const { minDistance = 500, iterations = 4 } = options;

  if (nodes.length < 2) return nodes;

  const positions = nodes.map((n) => ({ ...n.position }));

  // Grid cell size should be >= minDistance to ensure we only check neighboring cells
  const cellSize = minDistance;

  for (let iter = 0; iter < iterations; iter++) {
    // Build spatial grid hash map
    const grid = new Map();

    const getCellKey = (/** @type {number} */ x, /** @type {number} */ y) => {
      const cx = Math.floor(x / cellSize);
      const cy = Math.floor(y / cellSize);
      return `${cx},${cy}`;
    };

    // Index all positions into grid cells
    for (let i = 0; i < positions.length; i++) {
      const key = getCellKey(positions[i].x, positions[i].y);
      if (!grid.has(key)) {
        grid.set(key, []);
      }
      grid.get(key).push(i);
    }

    // For each position, only check positions in same cell or adjacent cells
    for (let i = 0; i < positions.length; i++) {
      const cx = Math.floor(positions[i].x / cellSize);
      const cy = Math.floor(positions[i].y / cellSize);

      // Check 3x3 neighborhood of cells (current + 8 neighbors)
      for (let dcx = -1; dcx <= 1; dcx++) {
        for (let dcy = -1; dcy <= 1; dcy++) {
          const neighborKey = `${cx + dcx},${cy + dcy}`;
          const neighbors = grid.get(neighborKey);
          if (!neighbors) continue;

          for (const j of neighbors) {
            // Only process each pair once (j > i) and skip self
            if (j <= i) continue;

            const dx = positions[j].x - positions[i].x;
            const dy = positions[j].y - positions[i].y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < minDistance && dist > 0) {
              const overlap = (minDistance - dist) / 2;
              const nx = dx / dist;
              const ny = dy / dist;

              positions[i].x -= nx * overlap;
              positions[i].y -= ny * overlap;
              positions[j].x += nx * overlap;
              positions[j].y += ny * overlap;
            }
          }
        }
      }
    }
  }

  return nodes.map((node, idx) => ({
    ...node,
    position: positions[idx]
  }));
}

/**
 * Layout for expanding cluster members around a cluster node
 * Wrapper around radialLayout for fan pattern
 *
 * @param {any} clusterNode - The parent cluster node
 * @param {any[]} memberNodes - Member file nodes to layout
 * @param {Record<string, any>} [options] - Layout options
 * @returns {any[]} Member nodes with positions
 */
export function clusterExpansionLayout(clusterNode, memberNodes, options = {}) {
  const {
    offsetX = 450, // Increased from 300 to prevent node overlap
    spacing = 80 // Increased from 60
  } = options;

  if (!clusterNode || !memberNodes || memberNodes.length === 0) {
    return memberNodes;
  }

  const count = memberNodes.length;

  // For small numbers, use simple vertical stacking (legacy behavior preserved)
  if (count <= 5) {
    const clusterPos = clusterNode.position || { x: 0, y: 0 };
    const totalHeight = (count - 1) * spacing;
    const startY = clusterPos.y - totalHeight / 2;

    return memberNodes.map((node, index) => ({
      ...node,
      position: {
        x: clusterPos.x + offsetX,
        y: startY + index * spacing
      }
    }));
  }

  // Dynamic radius and angle adjustment for better spacing
  // Calculate needed circumference to avoid overlap
  const minCircumference = count * (spacing * 0.85);

  // Dynamic angle: Scale angle based on count, from minAngle up to almost full circle (2PI - gap)
  const { minAngle = Math.PI / 4 } = options;
  const maxAngle = Math.PI * 1.85; // Leave a small gap (approx 27 degrees)

  // Estimate angle needed for this count at base radius
  // Base angle per node roughly 15 degrees (0.26 rad) at 300px radius
  const anglePerNode = 0.25;
  let calculatedAngle = Math.max(minAngle, Math.min(maxAngle, count * anglePerNode));

  // Calculate radius needed to fit nodes within this angle
  const currentArcLength = calculatedAngle * offsetX;
  let finalRadius = offsetX;

  if (minCircumference > currentArcLength) {
    // If nodes don't fit in current angle/radius, try expanding angle first (if not maxed)
    if (calculatedAngle < maxAngle) {
      calculatedAngle = maxAngle;
    }

    // Recalculate with max angle
    const maxArcLength = calculatedAngle * offsetX;
    if (minCircumference > maxArcLength) {
      // Still don't fit, need to increase radius
      finalRadius = Math.max(offsetX, minCircumference / calculatedAngle);
    }
  }

  // Determine best angle to avoid center overlap if center is known
  // If we know the center of the graph, point the fan AWAY from the center
  let centerAngle = 0;
  if (options.origin && clusterNode.position) {
    // Vector from origin to cluster
    const dx = clusterNode.position.x - options.origin.x;
    const dy = clusterNode.position.y - options.origin.y;
    // Angle pointing away from center
    centerAngle = Math.atan2(dy, dx);
  }

  // Fan is centered at centerAngle
  return radialLayout(clusterNode, memberNodes, {
    radius: finalRadius,
    startAngle: centerAngle - calculatedAngle / 2,
    endAngle: centerAngle + calculatedAngle / 2
  });
}

// Also export the new functions
export { LARGE_GRAPH_THRESHOLD, VERY_LARGE_GRAPH_THRESHOLD };

// HMR disposal handler to reset module-level state during hot reload
// This prevents stale callbacks and inconsistent state during development
if (module.hot) {
  module.hot.dispose(() => {
    cancelPendingLayout();
    if (layoutDebounceTimer) {
      clearTimeout(layoutDebounceTimer);
      layoutDebounceTimer = null;
    }
    pendingLayoutPromise = null;
    pendingCallbacks = [];
    latestLayoutData = { nodes: null, edges: null, options: {} };
    layoutAborted = false;
  });
}
