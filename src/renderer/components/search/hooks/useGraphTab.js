// @ts-check
/**
 * Graph-tab state + logic for the Unified Search modal (§I Phase 5).
 *
 * Owns the knowledge-graph subsystem: node/edge loading and layout,
 * clusters (+ regrouping modes and filters), bridges, duplicates, focus /
 * expansion, context menus, notes, zoom buckets, and the insight surfaces.
 * Extracted verbatim from UnifiedSearchModal; cross-tab couplings
 * (searchResults, chat scope bridge, shared error state, file actions)
 * flow in as params and the full surface is returned to the modal shell.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createLogger } from '../../../../shared/logger';
import { TIMEOUTS } from '../../../../shared/performanceConstants';
import { PHASES } from '../../../../shared/constants';
import { safeBasename, safeDirname } from '../../../../shared/memberPathUtils';
import { deriveClusterDisplayLabel } from '../../../../shared/clusterDisplayLabel';
import { scoreToOpacity, clamp01 } from '../../../utils/scoreUtils';
import { makeQueryNodeId, defaultNodePosition } from '../../../utils/graphUtils';
import { extractFileName } from '../../../utils/pathNormalization';
import { extractDroppedFiles, isFileDragEvent } from '../../../utils/dragAndDrop';
import normalizeList from '../../../utils/normalizeList';
import { joinPath } from '../../../utils/platform';
import { sanitizeGraphMetadataTerms, sanitizeSemanticTerms } from '../../../utils/semanticTerms';
import {
  elkLayout,
  cancelPendingLayout,
  debouncedElkLayout,
  smartLayout,
  clusterRadialLayout,
  clusterExpansionLayout,
  LARGE_GRAPH_THRESHOLD
} from '../../../utils/elkLayout';
import { nextRequestId, isCurrentRequest } from '../../../utils/requestGuard';
import { useGraphState } from '../../../hooks';
import { useAppDispatch, useAppSelector } from '../../../store/hooks';
import { openSettings, setPhase, setGraphInsightsSection } from '../../../store/slices/uiSlice';
import { clearActiveEdgePin } from '../useEdgeInteraction';
import { resolveGraphMiniMapPalette, getGraphMiniMapNodeColor } from '../graphViewConstants';
import { mapErrorToNotification } from '../../../utils/errorMapping';
import { edgeStrengthScore } from '../../../utils/graphUtils';
import { getFileCategory } from '../../ui/FileIcon';
import {
  getErrorMessage,
  getMetadataPath,
  getMetadataName,
  getParentFolderName,
  getZoomBucket,
  getDefaultGraphFitViewOptions,
  nodeDeduplicationKey,
  buildRecommendationGraph,
  regroupClustersForMode,
  DEFAULT_CLUSTER_MODE,
  getDefaultClusterFilters,
  getDefaultActiveFilters,
  applyParallelEdgeOffsets,
  getConnectionReason,
  rankCrossClusterConnections,
  sortClustersForInsight,
  pickSurpriseConnections
} from '../utils';

const logger = createLogger('useGraphTab');

// Maximum nodes allowed in graph to prevent memory exhaustion
const MAX_GRAPH_NODES = 300;
// Layout spacing is adaptive (see elkLayout.js); undefined lets it choose.
const GRAPH_LAYOUT_SPACING = /** @type {any} */ (undefined);
const GRAPH_LAYER_SPACING = /** @type {any} */ (undefined);
const SMALL_GRAPH_NODE_THRESHOLD = 18;
const SMALL_GRAPH_EDGE_THRESHOLD = 26;
const DENSE_GRAPH_NODE_THRESHOLD = 40;
const DENSE_GRAPH_EDGE_THRESHOLD = 70;
const DENSE_GRAPH_EDGE_RATIO_THRESHOLD = 1.35;
const WHY_CONNECTIONS_DISPLAY_LIMIT = 6;

export function useGraphTab(
  /** @type {any} */ {
    isOpen,
    activeTab,
    onClose,
    query,
    setQuery,
    defaultTopK,
    stats,
    graphViewEnabled,
    setError,
    recommendationMap,
    sidebarSections,
    chatMessages,
    setChatMessages,
    clusterActionRefs,
    handleMoveAllToFolderRef,
    layoutRequestCounterRef,
    error,
    hasLoadedStats,
    refreshStats,
    organizationalHealthRef
  }
) {
  const dispatch = useAppDispatch();
  const selectedTheme = useAppSelector((state) => /** @type {any} */ (state)?.ui?.selectedTheme);
  const { nodes, edges, selectedNodeId, actions: graphActions } = useGraphState();

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Graph tab state
  const [freshMetadata, setFreshMetadata] = useState(null);
  const [isLoadingMetadata, setIsLoadingMetadata] = useState(false);
  const [addMode, setAddMode] = useState(true);
  const [withinQuery, setWithinQuery] = useState('');
  const [debouncedWithinQuery, setDebouncedWithinQuery] = useState('');
  const [graphStatus, setGraphStatus] = useState('');

  // Layout state
  const [autoLayout, setAutoLayout] = useState(true);

  // Multi-hop expansion state
  const [hopCount, setHopCount] = useState(1);
  const DECAY_FACTOR = 0.7;

  // Clustering state
  const [showClusters, setShowClusters] = useState(false);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [isLayouting, setIsLayouting] = useState(false);
  const [isComputingClusters, setIsComputingClusters] = useState(false);
  /** Bump to remount graph subtree after error boundary "Try again". */
  const [graphVisualizationRemountKey, setGraphVisualizationRemountKey] = useState(0);
  /** After opening Advanced sidebar, focus "Search within graph" once it has mounted. */
  const [shouldFocusWithinGraphInput, setShouldFocusWithinGraphInput] = useState(false);

  // Help tour state (for re-showing the tour via help button)
  const [showTourManually, setShowTourManually] = useState(false);

  // Reset manual force-show whenever the parent modal closes.
  // This prevents the tour from being forced on every reopen.
  useEffect(() => {
    if (!isOpen) {
      setShowTourManually(false);
    }
  }, [isOpen]);

  // Persistence and Notes state
  const [graphNotes, setGraphNotes] = useState({}); // Map of nodeId -> note string
  const [showEdgeLabels, setShowEdgeLabels] = useState(true); // User's explicit preference
  // Derive effective value during render — large graphs auto-disable labels without state cascade
  const effectiveShowEdgeLabels = nodes.length > LARGE_GRAPH_THRESHOLD ? false : showEdgeLabels;
  const showEdgeLabelsRef = useRef(true); // Ref for access in callbacks without dependency
  const edgeTooltipsRef = useRef(true);
  const hasAutoDisabledEdgeLabels = useRef(false);
  const hasAutoDisabledTooltips = useRef(false);
  const edgeTooltipsEnabled = nodes.length <= LARGE_GRAPH_THRESHOLD;

  // Cluster configuration state
  const [clusterMode, setClusterMode] = useState(DEFAULT_CLUSTER_MODE); // topic | time | type | tag
  const [clusterFilters, setClusterFilters] = useState(getDefaultClusterFilters);
  const clusterFiltersRef = useRef(clusterFilters);
  const clusterModeRef = useRef(clusterMode);
  const lastClustersRef = useRef(null);
  const lastCrossClusterEdgesRef = useRef(null);

  const [duplicateSummary, setDuplicateSummary] = useState({
    groupCount: 0,
    totalDuplicates: 0,
    loading: false,
    groups: [] // Store the actual groups for the modal
  });

  // Graph context menu
  const [contextMenu, setContextMenu] = useState(null); // { x, y, nodeId, kind, data }
  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    // Also unpin any open edge tooltip so a click on empty canvas dismisses it.
    clearActiveEdgePin();
  }, []);

  // ReactFlow surfaces internal warnings (missing node/edge types, zoom
  // bounds, parent/child ordering) through onError instead of throwing. Route
  // them to the structured logger at debug so they stay discoverable without
  // spamming the console. `code` is ReactFlow's error id; `message` is the
  // human-readable text.
  const handleReactFlowError = useCallback(
    (/** @type {any} */ code, /** @type {any} */ message) => {
      logger.debug('[Graph] ReactFlow warning', { code, message });
    },
    []
  );

  // Triage & Resolution Modals
  const [isTriageModalOpen, setIsTriageModalOpen] = useState(false);
  const [isDownloadsTriageOpen, setIsDownloadsTriageOpen] = useState(false);
  const [relatedPanel, setRelatedPanel] = useState(null); // { fileId, fileName, filePath } | null
  const [triageFiles, setTriageFiles] = useState([]);
  const [isDuplicateModalOpen, setIsDuplicateModalOpen] = useState(false);
  const [isBridgeModalOpen, setIsBridgeModalOpen] = useState(false);
  const [isTagModalOpen, setIsTagModalOpen] = useState(false);
  const [selectedClusterForTagging, setSelectedClusterForTagging] = useState(null);

  // Persist cluster preferences locally (simple best-effort)
  useEffect(() => {
    try {
      const raw = window.localStorage?.getItem('graph.clusterPrefs');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.mode) setClusterMode(parsed.mode);
        if (parsed?.filters) setClusterFilters((prev) => ({ ...prev, ...parsed.filters }));
      }
    } catch (err) {
      logger.debug('[Graph] Failed to load cluster prefs', err);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const { search: _search, ...persistFilters } = clusterFilters; // exclude transient search
        window.localStorage?.setItem(
          'graph.clusterPrefs',
          JSON.stringify({ mode: clusterMode, filters: persistFilters })
        );
      } catch (err) {
        logger.debug('[Graph] Failed to save cluster prefs', err);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [clusterMode, clusterFilters]);

  // Sync clusterFilters ref so loadClusters can read current filters without re-creating
  useEffect(() => {
    clusterFiltersRef.current = clusterFilters;
  }, [clusterFilters]);

  // Sync clusterMode ref so cluster rendering can update without recomputing
  useEffect(() => {
    clusterModeRef.current = clusterMode;
  }, [clusterMode]);

  // Sync ref with derived effective value (not raw state) so callbacks use the right value
  useEffect(() => {
    showEdgeLabelsRef.current = effectiveShowEdgeLabels;
  }, [effectiveShowEdgeLabels]);
  useEffect(() => {
    edgeTooltipsRef.current = edgeTooltipsEnabled;
  }, [edgeTooltipsEnabled]);

  const [performanceNotice, setPerformanceNotice] = useState('');
  const noticeTimerRef = useRef(null);
  const graphStatusTimerRef = useRef(null);
  const dockHealthScrollRafRef = useRef(null);
  const showPerformanceNotice = useCallback((/** @type {any} */ message) => {
    setPerformanceNotice(message);
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
    }
    noticeTimerRef.current = setTimeout(() => {
      setPerformanceNotice('');
    }, 4000);
  }, []);
  useEffect(() => {
    if (!graphStatus) return undefined;

    if (graphStatusTimerRef.current) {
      clearTimeout(graphStatusTimerRef.current);
    }

    graphStatusTimerRef.current = setTimeout(() => {
      setGraphStatus('');
      graphStatusTimerRef.current = null;
    }, 2800);

    return () => {
      if (graphStatusTimerRef.current) {
        clearTimeout(graphStatusTimerRef.current);
        graphStatusTimerRef.current = null;
      }
    };
  }, [graphStatus]);
  useEffect(
    () => () => {
      if (noticeTimerRef.current) {
        clearTimeout(noticeTimerRef.current);
      }
      if (graphStatusTimerRef.current) {
        clearTimeout(graphStatusTimerRef.current);
      }
      if (dockHealthScrollRafRef.current != null) {
        cancelAnimationFrame(dockHealthScrollRafRef.current);
        dockHealthScrollRafRef.current = null;
      }
    },
    []
  );

  const applyEdgeUiPrefs = useCallback((/** @type {any} */ edgesToUpdate) => {
    if (!Array.isArray(edgesToUpdate) || edgesToUpdate.length === 0) {
      return edgesToUpdate || [];
    }

    const showLabels = showEdgeLabelsRef.current;
    const showTooltips = edgeTooltipsRef.current;
    let changed = false;
    const updated = edgesToUpdate.map((edge) => {
      const currentLabels = edge.data?.showEdgeLabels ?? true;
      const currentTooltips = edge.data?.showEdgeTooltips ?? true;
      if (currentLabels === showLabels && currentTooltips === showTooltips) return edge;
      changed = true;
      return {
        ...edge,
        data: {
          ...edge.data,
          showEdgeLabels: showLabels,
          showEdgeTooltips: showTooltips
        }
      };
    });

    return changed ? updated : edgesToUpdate;
  }, []);

  // Show performance notice when labels are auto-disabled (no state cascade — derived value handles it)
  useEffect(() => {
    if (
      nodes.length > LARGE_GRAPH_THRESHOLD &&
      showEdgeLabels &&
      !hasAutoDisabledEdgeLabels.current
    ) {
      hasAutoDisabledEdgeLabels.current = true;
      showPerformanceNotice('Large graph: connection labels disabled for performance.');
    }
    if (nodes.length <= LARGE_GRAPH_THRESHOLD) {
      hasAutoDisabledEdgeLabels.current = false;
    }
  }, [nodes.length, showEdgeLabels, showPerformanceNotice]);

  useEffect(() => {
    if (nodes.length > LARGE_GRAPH_THRESHOLD && !hasAutoDisabledTooltips.current) {
      hasAutoDisabledTooltips.current = true;
      showPerformanceNotice('Large graph: connection tooltips disabled for performance.');
    }
    if (nodes.length <= LARGE_GRAPH_THRESHOLD) {
      hasAutoDisabledTooltips.current = false;
    }
  }, [nodes.length, showPerformanceNotice]);

  const toggleSidebarSection = useCallback(
    (/** @type {any} */ key) => {
      dispatch(setGraphInsightsSection(sidebarSections[key] ? null : key));
    },
    [dispatch, sidebarSections]
  );

  useEffect(() => {
    if (!shouldFocusWithinGraphInput || !sidebarSections.advanced) return undefined;
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById('graph-within-filter-input');
      if (el && typeof el.focus === 'function') {
        el.focus();
      }
      setShouldFocusWithinGraphInput(false);
    });
    return () => cancelAnimationFrame(raf);
  }, [shouldFocusWithinGraphInput, sidebarSections.advanced]);

  const handleOpenSettings = useCallback(() => {
    dispatch(openSettings());
    onClose?.();
  }, [dispatch, onClose]);

  const handleGoToDiscover = useCallback(() => {
    onClose?.();
    dispatch(setPhase(PHASES.DISCOVER));
  }, [dispatch, onClose]);

  // Graph filtering state
  const [activeFilters, setActiveFilters] = useState(getDefaultActiveFilters);

  // Bridge overlay state (used for Guide "bridges only" intent)
  const [bridgeOverlayEnabled, setBridgeOverlayEnabled] = useState(false);

  // Zoom state
  const [, setZoomLevel] = useState(1);
  const [zoomBucket, setZoomBucket] = useState(() => getZoomBucket(1));
  const zoomBucketRef = useRef(zoomBucket);
  useEffect(() => {
    zoomBucketRef.current = zoomBucket;
  }, [zoomBucket]);
  const [hoveredClusterId, setHoveredClusterId] = useState(null);

  // Focus mode state - for local graph view
  const [focusNodeId, setFocusNodeId] = useState(null);
  const [focusDepth, setFocusDepth] = useState(1);
  const [searchWithinScope, setSearchWithinScope] = useState(null);

  // Related clusters UI state (accordion + file list expansion)
  const [expandedRelatedClusters, setExpandedRelatedClusters] = useState(() => ({}));
  const [isRelatedClustersOpen, setIsRelatedClustersOpen] = useState(true);

  const handleToggleFilter = useCallback(
    (/** @type {any} */ category, /** @type {any} */ value) => {
      setActiveFilters((prev) => {
        const current = /** @type {any} */ (prev)[category] || [];
        const newValues = current.includes(value)
          ? current.filter((/** @type {any} */ v) => v !== value)
          : [...current, value];
        return { ...prev, [category]: newValues };
      });
    },
    []
  );

  // Reset graph filters to defaults (cluster + active filters)
  const resetGraphFilters = useCallback(() => {
    setClusterMode(DEFAULT_CLUSTER_MODE);
    setClusterFilters(getDefaultClusterFilters());
    setActiveFilters(getDefaultActiveFilters());
    setBridgeOverlayEnabled(false);
    setWithinQuery('');
    setDebouncedWithinQuery('');
    setFocusNodeId(null);
    setFocusDepth(1);
    setSearchWithinScope(null);
  }, []);

  // Duplicates detection state (duplicateGroups stored for potential future export feature)
  const [duplicateGroups, setDuplicateGroups] = useState([]);

  // Confirmation modal state
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // UI State for progressive disclosure
  const [isGraphMaximized, setIsGraphMaximized] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  // Refs
  const withinRequestCounterRef = useRef(0);
  const withinReqRef = useRef(0);
  const reactFlowInstance = useRef(null);
  const clusterRefreshTimeoutRef = useRef(null);
  const userHasExpandedRef = useRef(false);
  const freshMetadataRequestCounterRef = useRef(0);
  const graphSearchRequestCounterRef = useRef(0);
  const graphDropRequestCounterRef = useRef(0);
  const graphContainerRef = useRef(null);

  // Refs for tracking auto-load state
  const hasAutoLoadedClusters = useRef(false);

  // Scope ref for keyboard-shortcut DOM queries (the search input lookup that
  // used to use `document.querySelector` could capture an aria-label="Search query"
  // input belonging to a different overlay sitting beneath us in the stack).

  // Ref to avoid temporal dead zone with loadClusters in keyboard shortcuts
  const loadClustersRef = useRef(null);

  // Request counter for loadClusters; prevents an in-flight knowledge-edge
  // augmentation from a superseded loadClusters call from writing edges into
  // the graph after a fresher loadClusters has rendered a different cluster set.
  const clustersRequestCounterRef = useRef(0);

  // Ref for expandFromSelected to be used by findSimilar event handler
  const expandFromSelectedRef = useRef(null);

  // Ref for expandCluster to be used in handleClusterExpand (defined before expandCluster)
  const expandClusterRef = useRef(null);

  // Ref for convertSearchToGraph to be used by viewInGraph event handler

  // Ref for cluster action callbacks to rehydrate saved graphs

  // Track the last fetched document details path to avoid re-fetching

  // Refs to access current nodes/edges in callbacks without creating stale closures
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  const handleCreateSmartFolderFromCluster = useCallback(async (/** @type {any} */ clusterData) => {
    try {
      // Prompt user to select destination directory
      const dirResult = await window.electronAPI?.files?.selectDirectory?.({
        purpose: 'destination'
      });
      if (!dirResult?.success || !dirResult?.path) {
        // User cancelled
        return;
      }

      const basePath = dirResult.path;
      const folderName = clusterData.label || 'Cluster Folder';

      // Build the full path for the new smart folder
      const folderPath = joinPath(basePath, folderName);

      // Create the smart folder using existing API
      const result = await window.electronAPI?.smartFolders?.add?.({
        name: folderName,
        path: folderPath,
        description: `Auto-created from cluster with ${clusterData.memberCount || 0} similar files`,
        keywords: clusterData.commonTags || [],
        category: clusterData.dominantCategory || 'General'
      });

      if (isMountedRef.current) {
        if (result?.success) {
          setError(''); // Clear any existing error
          setGraphStatus(`Smart folder "${folderName}" created successfully!`);
          logger.info('[Graph] Created smart folder from cluster', {
            folderName,
            memberCount: clusterData.memberCount
          });
        } else {
          setError(`Failed to create folder: ${getErrorMessage(result?.error, 'Folder creation')}`);
        }
      }
    } catch (e) {
      logger.error('[Graph] Failed to create smart folder from cluster', e);
      if (isMountedRef.current)
        setError(`Failed to create folder: ${e?.message || 'Unknown error'}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Move all files in a cluster to a selected folder
   * Uses the existing FILES.PERFORM_OPERATION handler
   */
  /**
   * Core move flow shared by every "Group into folder" affordance:
   * prompts the user for a destination folder, resolves paths for the
   * given file IDs, and moves them in batches via the existing
   * `files.performOperation` IPC. Returns nothing — surfaces success and
   * failure through the existing `setGraphStatus` / `setError` channels.
   *
   * @param {string[]} fileIds - File IDs (Orama doc IDs) to move.
   * @param {{ source?: string }} [opts] - Telemetry tag for logger.
   */
  const moveFilesToChosenFolder = useCallback(async (/** @type {any} */ fileIds, opts = {}) => {
    const ids = Array.isArray(fileIds) ? fileIds.filter(Boolean) : [];
    if (ids.length === 0) {
      if (isMountedRef.current) setError('No files selected to move.');
      return;
    }
    const source = /** @type {any} */ (opts).source || 'graph_group_action';

    try {
      const dirResult = await window.electronAPI?.files?.selectDirectory?.({
        purpose: 'destination'
      });
      if (!dirResult?.success || !dirResult?.path) {
        return; // User cancelled the folder picker.
      }
      const destFolder = dirResult.path;

      const metadataResult = await window.electronAPI?.embeddings?.getFileMetadata?.(ids);
      if (!metadataResult?.success) {
        if (isMountedRef.current) setError('Failed to retrieve file metadata');
        return;
      }
      const metadata = metadataResult.metadata || {};
      let successCount = 0;
      let failCount = 0;

      const operations = ids
        .map((id) => {
          const sourcePath = metadata[id]?.path;
          if (!sourcePath) return null;
          return { sourcePath, fileName: safeBasename(sourcePath) };
        })
        .filter(Boolean);
      failCount += ids.length - operations.length;

      // One batch_move for the whole group: one undo entry (MOVE_BATCH)
      // instead of one FILE_MOVE per file (audit row UR-04).
      if (operations.length > 0) {
        const response = await window.electronAPI?.files?.performOperation?.({
          type: 'batch_move',
          label: 'Move files from graph',
          operations: operations.map((op) => ({
            source: op.sourcePath,
            destination: joinPath(destFolder, op.fileName)
          }))
        });
        const rows = Array.isArray(response?.results) ? response.results : [];
        for (const row of rows) {
          if (row?.success === true) {
            successCount++;
          } else {
            logger.error('[Graph] Failed to move file', { error: row?.error, source });
            failCount++;
          }
        }
        if (rows.length === 0) {
          failCount += operations.length;
          logger.error('[Graph] Batch move returned no results', { source });
        }
      }

      if (isMountedRef.current) {
        if (successCount > 0) {
          metadataCacheRef.current.clear();
          setGraphStatus(`Moved ${successCount} file(s) to ${safeBasename(destFolder)}`);
        }
        if (failCount > 0) {
          setError(`Failed to move ${failCount} file(s)`);
        }
      }
    } catch (e) {
      logger.error('[Graph] Move files failed', { error: e?.message, source });
      if (isMountedRef.current) setError(`Move failed: ${e?.message || 'Unknown error'}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cluster path (existing entry point used by cluster cards + selection menu).
  const handleMoveAllToFolder = useCallback(
    (/** @type {any} */ clusterData) =>
      moveFilesToChosenFolder(clusterData?.memberIds || [], { source: 'cluster' }),
    [moveFilesToChosenFolder]
  );
  handleMoveAllToFolderRef.current = handleMoveAllToFolder;

  // Ad-hoc path: edges, bridges, scattered-files cards — any surface that
  // wants to group a one-off list of file IDs into a folder.
  const handleGroupFiles = useCallback(
    (/** @type {any} */ fileIds, opts = {}) =>
      moveFilesToChosenFolder(fileIds, {
        source: /** @type {any} */ (opts).source || 'graph_group_action'
      }),
    [moveFilesToChosenFolder]
  );

  // Stable value for GraphActionsContext so ReactFlow children (edges) can
  // call onGroupFiles without prop drilling. Memoized so consumers don't
  // re-render every time UnifiedSearchModal re-renders.
  const graphActionsContextValue = useMemo(
    () => ({ onGroupFiles: handleGroupFiles }),
    [handleGroupFiles]
  );

  /**
   * Export a list of file paths from a cluster to clipboard
   */
  const handleExportFileList = useCallback(async (/** @type {any} */ clusterData) => {
    try {
      const memberIds = clusterData?.memberIds || [];
      if (memberIds.length === 0) {
        setError('No files in this cluster');
        return;
      }

      // Get file metadata for all members in one call
      const metadataResult = await window.electronAPI?.embeddings?.getFileMetadata?.(memberIds);
      if (!metadataResult?.success) {
        if (isMountedRef.current) setError('Failed to retrieve file metadata');
        return;
      }

      const metadata = metadataResult.metadata || {};
      const paths = memberIds.map((/** @type {any} */ id) => metadata[id]?.path).filter(Boolean);

      if (paths.length === 0) {
        if (isMountedRef.current) setError('Could not retrieve file paths');
        return;
      }

      try {
        await navigator.clipboard.writeText(paths.join('\n'));
        if (isMountedRef.current)
          setGraphStatus(`Copied ${paths.length} file path(s) to clipboard`);
      } catch (clipboardErr) {
        logger.error('[Graph] Clipboard write failed', clipboardErr);
        if (isMountedRef.current)
          setError('Could not copy to clipboard. Check browser permissions.');
      }
    } catch (e) {
      logger.error('[Graph] Export file list failed', e);
      if (isMountedRef.current) setError(`Export failed: ${e?.message || 'Unknown error'}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Open all files in a cluster
   */
  const handleOpenAllFilesInCluster = useCallback(async (/** @type {any} */ clusterData) => {
    const memberIds = clusterData?.memberIds || [];
    if (memberIds.length === 0) {
      if (isMountedRef.current) setError('No files in this cluster');
      return;
    }

    const fileApi = window.electronAPI?.files;
    if (!fileApi?.open) {
      if (isMountedRef.current) setError('Open operation is unavailable');
      return;
    }

    // Limit to prevent opening too many files at once
    const MAX_FILES_TO_OPEN = 10;
    if (memberIds.length > MAX_FILES_TO_OPEN) {
      if (isMountedRef.current) {
        setGraphStatus(
          `Opening first ${MAX_FILES_TO_OPEN} of ${memberIds.length} files (limit reached)`
        );
      }
    }

    try {
      const subsetIds = memberIds.slice(0, MAX_FILES_TO_OPEN);

      // Get file metadata for members
      const metadataResult = await window.electronAPI?.embeddings?.getFileMetadata?.(subsetIds);
      if (!metadataResult?.success) {
        setError('Failed to retrieve file metadata');
        return;
      }

      const metadata = metadataResult.metadata || {};
      let openedCount = 0;
      let failedCount = 0;

      // Open sequentially to avoid overwhelming the shell/open handlers
      for (const id of subsetIds) {
        const filePath = metadata[id]?.path;
        if (!filePath) {
          failedCount++;
          continue;
        }

        try {
          const result = await fileApi.open(filePath);
          if (result?.success !== false) {
            openedCount++;
          } else {
            failedCount++;
          }
        } catch (err) {
          logger.warn('[Graph] Failed to open cluster file', { id, err });
          failedCount++;
        }
      }

      if (isMountedRef.current) {
        if (openedCount > 0 && failedCount > 0) {
          setGraphStatus(`Opened ${openedCount} file(s) (${failedCount} failed)`);
        } else if (openedCount > 0) {
          setGraphStatus(`Opened ${openedCount} file(s)`);
        } else if (failedCount > 0) {
          setError('Unable to open files. They may have been moved or deleted.');
        }
      }
    } catch (e) {
      logger.error('[Graph] Open all files failed', e);
      if (isMountedRef.current) setError(`Failed to open files: ${e?.message || 'Unknown error'}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * "Focus on a cluster" — scopes the graph, expands if needed, opens the Advanced
   * sidebar and focuses "Search within graph" after React commits.
   */
  const handleSearchWithinCluster = useCallback(
    (/** @type {any} */ clusterData) => {
      const label = clusterData?.label || 'cluster';
      const clusterId = clusterData?.id || clusterData?.clusterId;
      const memberIds = Array.isArray(clusterData?.memberIds)
        ? clusterData.memberIds.filter(
            (/** @type {any} */ id) => typeof id === 'string' && id.length > 0
          )
        : [];

      setGraphStatus(`Focused on "${label}".`);

      if (clusterId) {
        setFocusNodeId(clusterId);
        setFocusDepth(1);
        setSearchWithinScope({ clusterId, memberIds });
      } else {
        setSearchWithinScope(null);
      }

      if (clusterId && !clusterData?.expanded && memberIds.length > 0) {
        expandClusterRef.current?.(clusterId, memberIds);
      }

      dispatch(setGraphInsightsSection('advanced'));
      setShouldFocusWithinGraphInput(true);
    },
    [dispatch]
  );

  /**
   * Rename a cluster label (user override of auto-generated label)
   */
  const handleTagCluster = useCallback((/** @type {any} */ clusterData) => {
    if (clusterData) {
      setSelectedClusterForTagging(clusterData);
      setIsTagModalOpen(true);
    }
  }, []);

  const handleApplyTags = useCallback(
    async (/** @type {any} */ tags) => {
      if (!selectedClusterForTagging) return;

      const memberIds = selectedClusterForTagging.memberIds || [];
      if (memberIds.length === 0) return;

      if (isMountedRef.current)
        setGraphStatus(`Applying ${tags.length} tags to ${memberIds.length} files...`);

      try {
        // Call backend to add tags
        const result = await window.electronAPI.files.addTags(memberIds, tags);

        if (!result?.success) {
          throw new Error(getErrorMessage(result?.errors?.[0]?.error || result?.error, 'Tags'));
        }

        if (isMountedRef.current) {
          // Update local graph node to reflect new tags immediately
          graphActions.setNodes((/** @type {any} */ prev) =>
            prev.map((/** @type {any} */ n) => {
              if (n.id === selectedClusterForTagging.id) {
                const currentTags = n.data.commonTags || [];
                const newTags = sanitizeGraphMetadataTerms([...currentTags, ...tags], {
                  maxTerms: 10
                });
                return {
                  ...n,
                  data: {
                    ...n.data,
                    commonTags: newTags,
                    topTerms: sanitizeGraphMetadataTerms(newTags, { maxTerms: 3 })
                  }
                };
              }
              return n;
            })
          );

          setGraphStatus(`Applied tags to cluster: ${selectedClusterForTagging.label}`);
        }
      } catch (error) {
        logger.error('Failed to apply tags', {
          error: error?.message,
          stack: error?.stack
        });
        if (isMountedRef.current) setError('Failed to apply tags');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedClusterForTagging, graphActions]
  );

  const handleRenameCluster = useCallback(
    async (/** @type {any} */ clusterData) => {
      const clusterId = clusterData?.id || clusterData?.clusterId;
      const newLabel = clusterData?.newLabel;

      if (!clusterId || !newLabel) return;

      // Optimistic UI update
      graphActions.setNodes((/** @type {any} */ prev) =>
        prev.map((/** @type {any} */ n) =>
          n.id === clusterId
            ? {
                ...n,
                data: {
                  ...n.data,
                  label: newLabel,
                  isAutoGenerated: false
                }
              }
            : n
        )
      );

      setGraphStatus(`Cluster renamed to "${newLabel}"`);

      // Persist to backend so the label survives graph reloads and app restarts
      try {
        await window.electronAPI?.embeddings?.renameCluster?.(clusterId, newLabel);
      } catch (e) {
        logger.warn('[Graph] Failed to persist cluster rename:', e?.message);
      }
    },
    [graphActions]
  );

  // Ref-based node lookup: always holds the latest nodes map but does NOT
  // trigger downstream useMemo chains when only node positions change
  // (layout adjustments). Consumers that only need label/kind read from the
  // ref, keeping their dependency arrays small and stable.
  const nodeByIdRef = useRef(new Map());
  useEffect(() => {
    nodeByIdRef.current = new Map(nodes.map((/** @type {any} */ n) => [n.id, n]));
  }, [nodes]);
  const adjacencyByNode = useMemo(() => {
    const map = new Map();
    edges.forEach((/** @type {any} */ edge) => {
      if (!map.has(edge.source)) map.set(edge.source, new Set());
      if (!map.has(edge.target)) map.set(edge.target, new Set());
      map.get(edge.source).add(edge.target);
      map.get(edge.target).add(edge.source);
    });
    return map;
  }, [edges]);

  /**
   * Get nodes visible in focus mode based on depth from focused node
   */
  const getNodesInFocus = useCallback(
    (/** @type {any} */ nodeId, /** @type {any} */ depth) => {
      if (!nodeId) return new Set();

      const visible = new Set([nodeId]);
      let frontier = [nodeId];

      for (let d = 0; d < depth; d++) {
        /** @type {any[]} */
        const next = [];
        for (const id of frontier) {
          // Find all connected nodes via adjacency map
          const neighbors = adjacencyByNode.get(id);
          if (neighbors) {
            neighbors.forEach((/** @type {any} */ neighborId) => {
              if (!visible.has(neighborId)) {
                visible.add(neighborId);
                next.push(neighborId);
              }
            });
          }

          // Also include cluster members if this is a cluster node
          const node = nodeByIdRef.current.get(id);
          if (node?.data?.memberIds) {
            node.data.memberIds.forEach((/** @type {any} */ memberId) => {
              if (!visible.has(memberId)) {
                visible.add(memberId);
                next.push(memberId);
              }
            });
          }
        }
        frontier = next;
      }

      return visible;
    },
    [adjacencyByNode]
  );

  /**
   * Handle cluster expand/collapse from ClusterNode component
   * Looks up the cluster node and triggers expansion with memberIds
   */
  const handleClusterExpand = useCallback(
    (/** @type {any} */ clusterId) => {
      // Use ref to get current nodes state to avoid stale closure issues
      const currentNodes = nodesRef.current || [];
      const clusterNode = currentNodes.find((/** @type {any} */ n) => n.id === clusterId);

      if (!clusterNode) {
        logger.warn('[Graph] Cluster node not found for expand:', clusterId);
        return;
      }

      const memberIds = clusterNode.data?.memberIds || [];
      if (memberIds.length === 0) {
        logger.warn('[Graph] Cluster has no members to expand:', clusterId);
        return;
      }

      // Check if already expanded - toggle collapse
      if (clusterNode.data?.expanded) {
        // Collapse: remove member nodes and edges connected to them
        const memberIdSet = new Set(memberIds);
        graphActions.setNodes((/** @type {any} */ prev) =>
          prev
            .filter((/** @type {any} */ n) => !memberIdSet.has(n.id))
            .map((/** @type {any} */ n) =>
              n.id === clusterId ? { ...n, data: { ...n.data, expanded: false } } : n
            )
        );
        graphActions.setEdges((/** @type {any} */ prev) =>
          prev.filter(
            (/** @type {any} */ e) => !memberIdSet.has(e.source) && !memberIdSet.has(e.target)
          )
        );
        setGraphStatus('Cluster collapsed');
      } else {
        // Expand using existing expandCluster function
        expandClusterRef.current?.(clusterId, memberIds);
      }
    },
    [graphActions]
  );

  const handleClearFocus = useCallback(() => {
    setFocusNodeId(null);
    setSearchWithinScope(null);
    setGraphStatus('Focus cleared - showing all nodes');
  }, []);

  const handleExpandAllClusters = useCallback(async () => {
    const clusterNodes = nodes.filter(
      (/** @type {any} */ n) =>
        n.type === 'clusterNode' && n.data?.kind === 'cluster' && !n.data?.expanded
    );

    if (clusterNodes.length === 0) {
      if (isMountedRef.current) setGraphStatus('All clusters are already expanded');
      return;
    }

    if (isMountedRef.current) {
      setGraphStatus(`Expanding ${clusterNodes.length} clusters...`);
    }

    let expandedCount = 0;
    for (const cluster of clusterNodes) {
      if (!isMountedRef.current) break;
      const currentCount = (nodesRef.current || []).length;
      if (currentCount >= MAX_GRAPH_NODES) {
        if (isMountedRef.current) {
          setGraphStatus(
            `Expanded ${expandedCount} of ${clusterNodes.length} clusters (graph limit: ${MAX_GRAPH_NODES} nodes).`
          );
        }
        return;
      }
      const memberIds = cluster.data?.memberIds || [];
      if (memberIds.length > 0) {
        await expandClusterRef.current?.(cluster.id, memberIds);
        expandedCount += 1;
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    if (isMountedRef.current) setGraphStatus(`Expanded ${expandedCount} clusters`);
  }, [nodes]);

  const handleCollapseAllClusters = useCallback(() => {
    const expandedClusters = nodes.filter(
      (/** @type {any} */ n) =>
        n.type === 'clusterNode' && n.data?.kind === 'cluster' && n.data?.expanded
    );

    if (expandedClusters.length === 0) {
      if (isMountedRef.current) setGraphStatus('No expanded clusters to collapse');
      return;
    }

    const allMemberIds = new Set();
    expandedClusters.forEach((/** @type {any} */ cluster) => {
      (cluster.data?.memberIds || []).forEach((/** @type {any} */ id) => allMemberIds.add(id));
    });

    graphActions.setNodes((/** @type {any} */ prev) =>
      prev
        .filter((/** @type {any} */ n) => !allMemberIds.has(n.id))
        .map((/** @type {any} */ n) =>
          n.type === 'clusterNode' && n.data?.expanded
            ? { ...n, data: { ...n.data, expanded: false } }
            : n
        )
    );

    graphActions.setEdges((/** @type {any} */ prev) =>
      prev.filter(
        (/** @type {any} */ e) => !allMemberIds.has(e.source) && !allMemberIds.has(e.target)
      )
    );

    if (isMountedRef.current) {
      setGraphStatus(`Collapsed ${expandedClusters.length} clusters`);
    }
  }, [nodes, graphActions]);

  const applyLayout = useCallback(async () => {
    if (nodes.length === 0) return;

    cancelPendingLayout();
    const requestId = ++layoutRequestCounterRef.current;

    setIsLayouting(true);
    setGraphStatus('Applying layout...');

    try {
      const { nodes: layoutedNodes, edges: layoutedEdges } = await elkLayout(nodes, edges, {
        direction: 'RIGHT',
        spacing: GRAPH_LAYOUT_SPACING,
        layerSpacing: GRAPH_LAYER_SPACING
      });

      if (!isMountedRef.current || requestId !== layoutRequestCounterRef.current) {
        return;
      }
      graphActions.setGraph(
        layoutedNodes,
        layoutedEdges && layoutedEdges.length > 0 ? applyEdgeUiPrefs(layoutedEdges) : []
      );
      setGraphStatus('Layout applied');
    } catch (error) {
      logger.error('[Graph] Layout failed:', error);
      if (isMountedRef.current && requestId === layoutRequestCounterRef.current) {
        setGraphStatus('Layout failed');
      }
    } finally {
      if (isMountedRef.current && requestId === layoutRequestCounterRef.current) {
        setIsLayouting(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, graphActions, applyEdgeUiPrefs]);

  const handleSaveGraph = useCallback(() => {
    try {
      const state = {
        nodes,
        edges,
        notes: graphNotes,
        chatMessages,
        settings: {
          autoLayout,
          showEdgeLabels
        },
        timestamp: Date.now()
      };
      localStorage.setItem('stratosort_graph_state', JSON.stringify(state));
      setGraphStatus('Graph, chat, and settings saved');
    } catch (e) {
      logger.error('Failed to save graph', e);
      setError('Failed to save graph state');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, graphNotes, chatMessages, autoLayout, showEdgeLabels]);

  const handleLoadGraph = useCallback(() => {
    try {
      const saved = localStorage.getItem('stratosort_graph_state');
      if (!saved) {
        setGraphStatus('No saved graph found');
        return;
      }
      const state = JSON.parse(saved);
      if (Array.isArray(state.nodes) && Array.isArray(state.edges)) {
        const rehydratedNodes = state.nodes.map((/** @type {any} */ node) => {
          if (node?.type === 'clusterNode' || node?.data?.kind === 'cluster') {
            return {
              ...node,
              data: {
                ...node.data,
                ...clusterActionRefs.current
              }
            };
          }
          return node;
        });
        graphActions.setNodes(rehydratedNodes);
        const loadedShowLabels = state.settings?.showEdgeLabels ?? true;
        const restoredEdges = state.edges.map((/** @type {any} */ e) => ({
          ...e,
          data: {
            ...e.data,
            showEdgeLabels: loadedShowLabels,
            showEdgeTooltips: edgeTooltipsEnabled
          }
        }));
        graphActions.setEdges(restoredEdges);

        if (state.notes) setGraphNotes(state.notes);
        if (state.chatMessages) setChatMessages(state.chatMessages);

        if (state.settings) {
          if (state.settings.autoLayout !== undefined) setAutoLayout(state.settings.autoLayout);
          setShowEdgeLabels(loadedShowLabels);
        }

        setGraphStatus(`Loaded graph from ${new Date(state.timestamp).toLocaleTimeString()}`);

        // Frame the restored nodes; the <ReactFlow fitView> prop only fires on
        // the initial empty mount, so a load after open would otherwise leave
        // the viewport parked at the origin with nodes off-screen.
        if (rehydratedNodes.length > 0) {
          setTimeout(() => {
            reactFlowInstance.current?.fitView(getDefaultGraphFitViewOptions({ duration: 400 }));
          }, 100);
        }
      } else {
        logger.warn('[UnifiedSearchModal] Saved graph state invalid, resetting', {
          hasNodes: Array.isArray(state.nodes),
          hasEdges: Array.isArray(state.edges)
        });
        graphActions.setGraph([], []);
        setGraphStatus('Saved graph state was invalid and has been reset');
      }
    } catch (e) {
      logger.error('Failed to load graph', e);
      setError('Failed to load saved graph');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphActions, edgeTooltipsEnabled, setChatMessages]);

  useEffect(() => {
    clusterActionRefs.current = {
      onCreateSmartFolder: handleCreateSmartFolderFromCluster,
      onMoveAllToFolder: handleMoveAllToFolder,
      onExportFileList: handleExportFileList,
      onOpenAllFiles: handleOpenAllFilesInCluster,
      onSearchWithinCluster: handleSearchWithinCluster,
      onTagCluster: handleTagCluster,
      onRenameCluster: handleRenameCluster,
      onExpand: handleClusterExpand
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    handleCreateSmartFolderFromCluster,
    handleMoveAllToFolder,
    handleExportFileList,
    handleOpenAllFilesInCluster,
    handleSearchWithinCluster,
    handleTagCluster,
    handleRenameCluster,
    handleClusterExpand
  ]);

  /**
   * Find near-duplicate files across the collection
   * Displays them as special clusters in the graph
   */
  const handleFindDuplicates = useCallback(async () => {
    setError('');
    setDuplicateGroups([]);

    try {
      const result = await window.electronAPI?.embeddings?.findDuplicates?.({
        threshold: 0.9,
        maxResults: 30
      });

      if (!result?.success) {
        setError(getErrorMessage(result?.error, 'Duplicate detection'));
        return;
      }

      if (result.groups.length === 0) {
        setGraphStatus('No duplicate files found');
        return;
      }

      const normalizedGroups = (Array.isArray(result.groups) ? result.groups : []).map(
        (/** @type {any} */ group, /** @type {any} */ groupIndex) => {
          const normalizedMembers = (Array.isArray(group?.members) ? group.members : [])
            .map((/** @type {any} */ member, /** @type {any} */ memberIndex) => {
              const filePath =
                member?.path ||
                member?.filePath ||
                member?.metadata?.path ||
                member?.originalPath ||
                '';
              const memberId = member?.id || filePath || `dup:${groupIndex}:${memberIndex}`;
              // Preserve an unknown size as null (→ "Size unavailable") rather
              // than coercing it to a misleading 0 B. The main process enriches
              // members with a real on-disk size before they reach here.
              const rawSize = member?.size ?? member?.fileSize ?? member?.metadata?.size;
              const parsedSize = Number(rawSize);
              return {
                id: memberId,
                path: filePath,
                name:
                  member?.name ||
                  member?.fileName ||
                  member?.metadata?.name ||
                  safeBasename(filePath || memberId),
                size: Number.isFinite(parsedSize) && parsedSize >= 0 ? parsedSize : null,
                mtime: member?.mtime ?? member?.mtimeMs ?? member?.metadata?.mtimeMs ?? null
              };
            })
            .filter((/** @type {any} */ member) => Boolean(member.id));

          return {
            ...group,
            tier: group?.tier || null,
            reason: group?.reason || null,
            members: normalizedMembers
          };
        }
      );

      if (normalizedGroups.length === 0) {
        setGraphStatus('No duplicate files found');
        return;
      }

      // Store duplicate groups
      setDuplicateGroups(normalizedGroups);

      // Display duplicates as special cluster nodes, colored by tier.
      const tierLabel = {
        exact: 'Identical',
        nearIdentical: 'Near-identical',
        related: 'Related'
      };
      const dupNodes = normalizedGroups.map((/** @type {any} */ group, /** @type {any} */ idx) => {
        const tier = group.tier || 'related';
        const labelDetail =
          tier === 'exact'
            ? 'Identical'
            : `${Math.round((group.averageSimilarity || 0) * 100)}% similar`;
        return {
          id: group.id,
          type: 'clusterNode',
          position: defaultNodePosition(idx),
          data: {
            kind: 'duplicate',
            duplicateTier: tier,
            duplicateReason: group.reason || null,
            label: `${/** @type {any} */ (tierLabel)[tier] || 'Duplicates'} (${labelDetail})`,
            memberCount: group.memberCount,
            memberIds: group.members.map((/** @type {any} */ m) => m.id).filter(Boolean),
            expanded: false,
            confidence: tier === 'exact' ? 'high' : tier === 'nearIdentical' ? 'medium' : 'low',
            dominantCategory: /** @type {any} */ (tierLabel)[tier] || 'Duplicate Group',
            commonTags: /** @type {any[]} */ ([]),
            isAutoGenerated: true,
            onCreateSmartFolder: handleCreateSmartFolderFromCluster,
            onMoveAllToFolder: handleMoveAllToFolder,
            onExportFileList: handleExportFileList,
            // New action callbacks
            onOpenAllFiles: handleOpenAllFilesInCluster,
            onSearchWithinCluster: handleSearchWithinCluster,
            onRenameCluster: handleRenameCluster,
            onTagCluster: handleTagCluster,
            // Expand/collapse callback
            onExpand: handleClusterExpand
          },
          draggable: true
        };
      });

      graphActions.setGraph(dupNodes, []);
      setShowClusters(false);
      setGraphStatus(
        `Found ${result.groups.length} duplicate group(s) with ${result.totalDuplicates} files`
      );
    } catch (e) {
      logger.error('[Graph] Find duplicates failed', e);
      setError(`Find duplicates failed: ${e?.message || 'Unknown error'}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    handleCreateSmartFolderFromCluster,
    handleMoveAllToFolder,
    handleExportFileList,
    handleOpenAllFilesInCluster,
    handleSearchWithinCluster,
    handleTagCluster,
    handleRenameCluster,
    handleClusterExpand,
    graphActions
  ]);

  // NOTE: selectedNode must be defined before callbacks that reference it.
  // Must depend on `nodes`, not read nodeByIdRef: the ref is refreshed in an
  // effect AFTER render, so a ref-based memo keyed only on selectedNodeId
  // kept serving the pre-refresh node object — the details sidebar showed
  // stale label/tags after cluster rename/tag or a background loadClusters
  // refresh until the user re-clicked. Drag churn is cheap: find() returns
  // the same reference unless the selected node itself changed, and the
  // metadata fetch effect is debounced + cached.
  const selectedNode = useMemo(
    () =>
      selectedNodeId
        ? (nodes.find((/** @type {any} */ n) => n.id === selectedNodeId) ?? null)
        : null,
    [selectedNodeId, nodes]
  );

  const focusNode = useCallback(
    (/** @type {any} */ nodeId, { zoom = 1.15 } = {}) => {
      if (!nodeId) return;
      graphActions.selectNode(nodeId);
      const currentNodes = nodesRef.current || [];
      const node = currentNodes.find((/** @type {any} */ n) => n.id === nodeId);
      if (node && reactFlowInstance.current) {
        reactFlowInstance.current.setCenter(node.position.x + 100, node.position.y + 50, {
          duration: 350,
          zoom
        });
      }
    },
    [graphActions]
  );

  const clusterInsights = useMemo(() => {
    if (!showClusters) {
      return {
        clustersById: new Map(),
        clusterNodes: [],
        topConnections: [],
        emergingClusters: [],
        connectedEdgeCounts: new Map(),
        crossEdges: []
      };
    }

    const clusterNodes = nodes.filter((/** @type {any} */ n) => n?.data?.kind === 'cluster');
    const clustersById = new Map(clusterNodes.map((/** @type {any} */ n) => [n.id, n]));

    const crossEdges = edges.filter((/** @type {any} */ e) => e?.data?.kind === 'cross_cluster');
    const connectedEdgeCounts = new Map();
    for (const e of crossEdges) {
      connectedEdgeCounts.set(e.source, (connectedEdgeCounts.get(e.source) || 0) + 1);
      connectedEdgeCounts.set(e.target, (connectedEdgeCounts.get(e.target) || 0) + 1);
    }

    const mapCrossClusterConnection = (/** @type {any} */ e) => {
      const src = clustersById.get(e.source);
      const tgt = clustersById.get(e.target);
      const sim = Number.isFinite(e?.data?.similarity) ? e.data.similarity : 0;
      const sharedTerms = sanitizeSemanticTerms(e?.data?.sharedTerms, {
        maxTerms: 3,
        minLength: 2
      });
      const bridgeFiles = Array.isArray(e?.data?.bridgeFiles) ? e.data.bridgeFiles : [];
      return {
        id: e.id,
        sourceId: e.source,
        targetId: e.target,
        similarity: sim,
        sharedTerms,
        bridgeFiles,
        sourceLabel: deriveClusterDisplayLabel({
          label: src?.data?.label,
          clusterId: src?.data?.clusterId,
          topTerms: src?.data?.topTerms,
          commonTags: src?.data?.commonTags,
          dominantCategory: src?.data?.dominantCategory,
          dominantFolderName: src?.data?.dominantFolderName,
          memberCount: src?.data?.memberCount
        }),
        targetLabel: deriveClusterDisplayLabel({
          label: tgt?.data?.label,
          clusterId: tgt?.data?.clusterId,
          topTerms: tgt?.data?.topTerms,
          commonTags: tgt?.data?.commonTags,
          dominantCategory: tgt?.data?.dominantCategory,
          dominantFolderName: tgt?.data?.dominantFolderName,
          memberCount: tgt?.data?.memberCount
        })
      };
    };

    const topConnections = rankCrossClusterConnections(
      crossEdges,
      clustersById,
      mapCrossClusterConnection,
      12
    );

    const emergingClusters = clusterNodes
      .filter((/** @type {any} */ n) => Number.isFinite(n?.data?.timeRange?.endMs))
      .map((/** @type {any} */ n) => ({
        id: n.id,
        label: n?.data?.label || n.id,
        endMs: n.data.timeRange.endMs,
        startMs: Number.isFinite(n?.data?.timeRange?.startMs) ? n.data.timeRange.startMs : null,
        memberCount: n?.data?.memberCount || 0
      }))
      .sort((/** @type {any} */ a, /** @type {any} */ b) => (b.endMs || 0) - (a.endMs || 0))
      .slice(0, 5);

    return {
      clustersById,
      clusterNodes,
      topConnections,
      emergingClusters,
      connectedEdgeCounts,
      crossEdges
    };
  }, [showClusters, nodes, edges]);

  const insightSummary = useMemo(() => {
    const clusterNodes = clusterInsights.clusterNodes || [];
    const crossClusterEdges = clusterInsights.crossEdges || [];

    const bridgeDocIds = new Set();
    crossClusterEdges.forEach((/** @type {any} */ edge) => {
      const bridgeFiles = Array.isArray(edge?.data?.bridgeFiles) ? edge.data.bridgeFiles : [];
      bridgeFiles.forEach((/** @type {any} */ file) => {
        const key = file?.path || file?.id || String(file || '');
        if (key) bridgeDocIds.add(key);
      });
    });

    const scatteredFiles = clusterNodes.reduce(
      (/** @type {any} */ sum, /** @type {any} */ clusterNode) => {
        const memberCount = clusterNode?.data?.memberCount || 0;
        const hasDominantFolder = Boolean(clusterNode?.data?.dominantFolderName);
        return sum + (hasDominantFolder ? 0 : memberCount);
      },
      0
    );

    return {
      topicClusters: clusterNodes.length,
      bridgeDocuments: bridgeDocIds.size,
      nearDuplicates: duplicateSummary.totalDuplicates,
      scatteredFiles
    };
  }, [clusterInsights, duplicateSummary.totalDuplicates]);

  const organizationalHealth = useMemo(() => {
    const clusters = clusterInsights.clusterNodes || [];
    const isolatedClusters = clusters.filter(
      (/** @type {any} */ node) => (clusterInsights.connectedEdgeCounts.get(node.id) || 0) === 0
    ).length;
    const clustersWithoutFolder = clusters.filter(
      (/** @type {any} */ node) => !node?.data?.dominantFolderName
    ).length;
    const scatteredFiles = insightSummary.scatteredFiles;
    const duplicateFiles = insightSummary.nearDuplicates;

    const penalty =
      Math.min(35, scatteredFiles * 0.8) +
      Math.min(25, duplicateFiles * 1.2) +
      Math.min(20, isolatedClusters * 4) +
      Math.min(20, clustersWithoutFolder * 3);

    const score = Math.max(0, Math.round(100 - penalty));
    const grade =
      score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
    const findings = [
      {
        key: 'scattered',
        label: `${scatteredFiles} scattered file${scatteredFiles === 1 ? '' : 's'}`,
        active: scatteredFiles > 0
      },
      {
        key: 'duplicates',
        label: `${duplicateFiles} near-duplicate file${duplicateFiles === 1 ? '' : 's'}`,
        active: duplicateFiles > 0
      },
      {
        key: 'isolated',
        label: `${isolatedClusters} isolated topic group${isolatedClusters === 1 ? '' : 's'}`,
        active: isolatedClusters > 0
      },
      {
        key: 'unmapped',
        label: `${clustersWithoutFolder} topic group${clustersWithoutFolder === 1 ? '' : 's'} without folder signal`,
        active: clustersWithoutFolder > 0
      }
    ];

    return { score, grade, findings };
  }, [clusterInsights.clusterNodes, clusterInsights.connectedEdgeCounts, insightSummary]);

  // Files in clusters with no dominant folder — i.e. genuinely scattered.
  // Used by the "What's interesting" sidebar's scattered-files card so it
  // can pass a concrete fileIds[] to handleGroupFiles.
  const scatteredFileIds = useMemo(() => {
    return clusterInsights.clusterNodes
      .filter((/** @type {any} */ n) => !n?.data?.dominantFolderName)
      .flatMap((/** @type {any} */ n) =>
        Array.isArray(n?.data?.memberIds) ? n.data.memberIds : []
      )
      .filter(Boolean);
  }, [clusterInsights.clusterNodes]);

  // Active organizational findings — used by the health card's "See findings"
  // verb. We surface the first active finding's key so the same handler
  // (`handleOrgFindingClick`) the right panel uses can be reused verbatim.
  const activeFindings = useMemo(
    () => organizationalHealth.findings.filter((f) => f.active),
    [organizationalHealth.findings]
  );

  const insightClusterNodes = useMemo(
    () => sortClustersForInsight(clusterInsights.clusterNodes, 8),
    [clusterInsights.clusterNodes]
  );

  const insightSurpriseConnections = useMemo(
    () => pickSurpriseConnections(clusterInsights.topConnections, 3),
    [clusterInsights.topConnections]
  );

  const insightBridgeCards = useMemo(() => {
    const surpriseIds = new Set(insightSurpriseConnections.map((c) => c.id));
    return clusterInsights.topConnections
      .filter((c) => c.bridgeFiles && c.bridgeFiles.length > 0 && !surpriseIds.has(c.id))
      .slice(0, 5);
  }, [clusterInsights.topConnections, insightSurpriseConnections]);

  const openBridgeAnalysis = useCallback(() => {
    if (!showClusters) {
      loadClustersRef.current?.();
    }
    setIsBridgeModalOpen(true);
  }, [showClusters]);

  const fileNodeIds = useMemo(
    () =>
      nodes
        .filter((/** @type {any} */ n) => n?.data?.kind === 'file')
        .map((/** @type {any} */ n) => n.id),
    [nodes]
  );

  // Fetch fresh metadata from the vector DB when a file node is selected.
  // Debounced to avoid IPC flood when clicking through nodes rapidly.
  // Component-level cache prevents re-fetching for previously selected nodes.
  const metadataCacheRef = useRef(new Map());
  const lastDuplicateFileCountRef = useRef(null);
  useEffect(() => {
    if (!selectedNode || selectedNode.data?.kind !== 'file') {
      freshMetadataRequestCounterRef.current += 1;
      setFreshMetadata(null);
      setIsLoadingMetadata(false);
      return undefined;
    }

    const nodeId = selectedNode.id;

    // Check component-level cache first
    if (metadataCacheRef.current.has(nodeId)) {
      setFreshMetadata(metadataCacheRef.current.get(nodeId));
      setIsLoadingMetadata(false);
      return undefined;
    }

    let cancelled = false;
    const requestId = (freshMetadataRequestCounterRef.current += 1);

    // Debounce 150ms to avoid IPC flood on rapid node selection
    const debounceTimer = setTimeout(async () => {
      setIsLoadingMetadata(true);
      try {
        const resp = await window.electronAPI?.embeddings?.getFileMetadata?.([nodeId]);
        if (!cancelled && freshMetadataRequestCounterRef.current === requestId && resp?.success) {
          const meta = resp.metadata?.[nodeId] || null;
          setFreshMetadata(meta);
          // Cache for later re-selection (cap at 50 entries)
          if (meta) {
            metadataCacheRef.current.set(nodeId, meta);
            if (metadataCacheRef.current.size > 50) {
              const firstKey = metadataCacheRef.current.keys().next().value;
              metadataCacheRef.current.delete(firstKey);
            }
          }
        }
      } catch {
        if (!cancelled && freshMetadataRequestCounterRef.current === requestId) {
          setFreshMetadata(null);
        }
      } finally {
        if (!cancelled && freshMetadataRequestCounterRef.current === requestId) {
          setIsLoadingMetadata(false);
        }
      }
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(debounceTimer);
    };
  }, [selectedNode]);

  const upsertFileNode = useCallback(
    (/** @type {any} */ result, /** @type {any} */ preferredPosition) => {
      const id = result?.id;
      if (!id) return null;
      const metadata = result?.metadata || {};
      const path = getMetadataPath(metadata, id);
      const name = getMetadataName(metadata, path, id);
      const score = typeof result?.score === 'number' ? result.score : undefined;

      // Parse tags from JSON string (vector DB stores as string) or use array directly
      let tags = [];
      if (Array.isArray(metadata.tags)) {
        tags = metadata.tags;
      } else if (typeof metadata.tags === 'string' && metadata.tags) {
        try {
          tags = JSON.parse(metadata.tags);
        } catch {
          tags = [];
        }
      }
      const category = metadata.category || getFileCategory(path);
      const suggestedFolder = recommendationMap[path] || '';
      const subject = metadata.subject || (suggestedFolder ? `Folder: ${suggestedFolder}` : '');
      const summary = metadata.summary || '';
      const content = result?.document || '';

      return {
        id,
        type: 'fileNode', // Custom node type for card-like styling
        position: preferredPosition || { x: 0, y: 0 },
        data: {
          id, // Needed by FileNode toolbar buttons (Find Similar, Focus on Node)
          kind: 'file',
          label: name,
          path,
          score,
          tags: sanitizeGraphMetadataTerms(tags.length > 0 ? tags : metadata.keywords, {
            maxTerms: 5
          }),
          entities: sanitizeGraphMetadataTerms(metadata.keyEntities, { maxTerms: 5 }),
          dates: normalizeList(metadata.dates).slice(0, 3),
          suggestedFolder,
          category,
          subject,
          summary,
          content
        },
        draggable: true
      };
    },
    [recommendationMap]
  );

  /**
   * Handle drag over for file drops to graph
   */
  const handleDragOver = useCallback((/** @type {any} */ e) => {
    e.preventDefault();
    e.stopPropagation();
    // Check if this is a file drop
    if (!isFileDragEvent(e)) return;
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
    setIsDragOver(true);
  }, []);

  /**
   * Handle drag leave
   */
  const handleDragLeave = useCallback((/** @type {any} */ e) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set false if we're leaving the container (not entering a child)
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setIsDragOver(false);
    }
  }, []);

  /**
   * Handle file drop to add files to graph
   */
  const handleFileDrop = useCallback(
    async (/** @type {any} */ e) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      if (!e.dataTransfer) return;
      const requestId = nextRequestId(graphDropRequestCounterRef);
      const isStaleRequest = () =>
        !isCurrentRequest(graphDropRequestCounterRef, requestId) || !isMountedRef.current;

      const { paths, unresolvedNames = [] } = extractDroppedFiles(e.dataTransfer);
      const droppedPaths = Array.from(new Set([...paths, ...unresolvedNames]));
      if (droppedPaths.length === 0) return;

      setGraphStatus(
        `Looking up ${droppedPaths.length} file${droppedPaths.length > 1 ? 's' : ''}...`
      );

      try {
        const currentNodes = nodesRef.current || [];
        /** @type {any[]} */
        const addedNodes = [];
        /** @type {any[]} */
        const addedEdges = [];

        for (const filePath of droppedPaths) {
          if (isStaleRequest()) return;
          if (!filePath) continue;

          // Search for this file by name to find it in the vector DB
          const fileName = extractFileName(filePath) || filePath;
          const searchResp = await window.electronAPI?.embeddings?.search?.(fileName, {
            topK: 20,
            mode: 'hybrid'
          });
          if (isStaleRequest()) return;

          if (!searchResp?.success || !searchResp.results?.length) {
            logger.debug('[Graph] File not found in index:', fileName);
            continue;
          }

          const hasFullPath = /[\\/]/.test(filePath);
          const normalizedDrop = String(filePath).toLowerCase();
          const matchingResult = searchResp.results.find((/** @type {any} */ r) => {
            const candidatePath = String(getMetadataPath(r, r?.id) || '').toLowerCase();
            const candidateName = String(getMetadataName(r, '', r?.id) || '').toLowerCase();
            if (hasFullPath) return candidatePath === normalizedDrop;
            return candidateName === normalizedDrop;
          });

          if (!matchingResult) {
            logger.debug('[Graph] No exact path match for:', filePath);
            continue;
          }

          // Calculate position for the new node
          const existingNodeCount = currentNodes.length + addedNodes.length;
          const pos = defaultNodePosition(existingNodeCount);

          // Create node using upsertFileNode
          const node = upsertFileNode(matchingResult, pos);
          if (node) {
            // Deduplicate by path (same file can have different vector DB IDs)
            const existingKeys = new Set([
              ...currentNodes.map(nodeDeduplicationKey),
              ...addedNodes.map(nodeDeduplicationKey)
            ]);
            if (!existingKeys.has(nodeDeduplicationKey(node))) {
              addedNodes.push(node);
            }
          }
        }

        if (isStaleRequest()) return;
        if (addedNodes.length === 0) {
          setError('Dropped files not found in index. Try analyzing them first.');
          setGraphStatus('');
          return;
        }

        // Add new nodes to graph
        graphActions.setNodes((/** @type {any} */ prev) => [...prev, ...addedNodes]);

        // If we have existing nodes, try to find similarity connections
        if (currentNodes.length > 0 && addedNodes.length > 0) {
          try {
            const existingIds = currentNodes.map((/** @type {any} */ n) => n.id);
            const newIds = addedNodes.map((n) => n.id);

            // Get similarity edges between new and existing nodes
            for (const newId of newIds) {
              if (isStaleRequest()) return;
              const simResp = await window.electronAPI?.embeddings?.findSimilar?.(newId, 5);
              if (isStaleRequest()) return;
              if (simResp?.success && simResp.results) {
                for (const sim of simResp.results) {
                  if (existingIds.includes(sim.id) && sim.score > 0.5) {
                    addedEdges.push({
                      id: `e:${newId}->${sim.id}`,
                      source: newId,
                      target: sim.id,
                      type: 'similarity',
                      animated: false,
                      data: {
                        kind: 'similarity',
                        similarity: sim.score,
                        showEdgeLabels: showEdgeLabelsRef.current,
                        showEdgeTooltips: edgeTooltipsRef.current
                      }
                    });
                  }
                }
              }
            }
          } catch (simErr) {
            logger.debug('[Graph] Failed to get similarity edges for dropped files:', simErr);
          }
        }

        // Add edges if any
        if (addedEdges.length > 0) {
          graphActions.setEdges((/** @type {any} */ prev) => {
            const existingIds = new Set(prev.map((/** @type {any} */ e) => e.id));
            const newEdges = addedEdges.filter((e) => !existingIds.has(e.id));
            return [...prev, ...newEdges];
          });
        }

        // Apply layout if auto-layout is enabled
        if (autoLayout && addedNodes.length > 0) {
          const currentEdges = edgesRef.current || [];
          const allNodes = [...currentNodes, ...addedNodes];
          const allEdges = [...currentEdges, ...addedEdges];
          try {
            const { nodes: layoutedNodes, edges: layoutedEdges } = await debouncedElkLayout(
              allNodes,
              allEdges,
              {
                direction: 'RIGHT',
                spacing: GRAPH_LAYOUT_SPACING,
                layerSpacing: GRAPH_LAYER_SPACING
              }
            );
            if (isStaleRequest()) return;
            graphActions.setGraph(
              layoutedNodes,
              layoutedEdges && layoutedEdges.length > 0 ? applyEdgeUiPrefs(layoutedEdges) : []
            );
          } catch (layoutErr) {
            logger.debug('[Graph] Layout after drop failed:', layoutErr);
          }
        }

        setGraphStatus(
          `Added ${addedNodes.length} file${addedNodes.length > 1 ? 's' : ''} to graph`
        );
      } catch (err) {
        if (isStaleRequest()) return;
        logger.error('[Graph] File drop failed:', err);
        setError('Failed to add files to graph');
        setGraphStatus('');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graphActions, upsertFileNode, autoLayout, applyEdgeUiPrefs]
  );

  /**
   * Load and display semantic clusters
   */
  const formatDateLabel = useCallback((/** @type {any} */ iso) => {
    if (!iso) return '';
    const ms = Date.parse(String(iso));
    if (!Number.isFinite(ms)) return '';
    try {
      return new Date(ms).toLocaleDateString();
    } catch {
      return '';
    }
  }, []);

  const getClusterDisplayLabel = useCallback(
    (/** @type {any} */ cluster) => {
      const mode = clusterModeRef.current || DEFAULT_CLUSTER_MODE;
      const semanticLabel = deriveClusterDisplayLabel(cluster);
      const fallback = semanticLabel || cluster?.label || 'Similar files';

      if (mode === 'type') {
        if (cluster?.isRegrouped && cluster?.label) return String(cluster.label);
        // Prefer file-category buckets ("document", "image", etc) over semantic categories ("Finance", etc).
        if (cluster?.dominantFileCategoryLabel) return String(cluster.dominantFileCategoryLabel);
        if (cluster?.dominantFileCategory) return String(cluster.dominantFileCategory);
        return fallback;
      }
      if (mode === 'tag') {
        if (cluster?.isRegrouped && cluster?.label) return String(cluster.label);
        // "Tag/Folder": prefer dominant folder name (more consistently available than tags),
        // then fall back to first common tag if present.
        if (cluster?.dominantFolderName) return String(cluster.dominantFolderName);
        const tag = Array.isArray(cluster?.commonTags) ? cluster.commonTags[0] : null;
        return tag ? String(tag) : fallback;
      }
      if (mode === 'time') {
        if (cluster?.isRegrouped && cluster?.label) return String(cluster.label);
        const start = cluster?.timeRange?.start;
        const end = cluster?.timeRange?.end;
        const startLabel = formatDateLabel(start);
        const endLabel = formatDateLabel(end);
        if (startLabel && endLabel && startLabel !== endLabel) return `${startLabel} – ${endLabel}`;
        if (endLabel) return endLabel;
        return fallback;
      }

      // topic (semantic) default
      return fallback;
    },
    [formatDateLabel]
  );

  const sortClustersForMode = useCallback((/** @type {any} */ clusters) => {
    const mode = clusterModeRef.current || DEFAULT_CLUSTER_MODE;
    const list = Array.isArray(clusters) ? clusters.slice() : [];

    if (mode === 'time') {
      list.sort((a, b) => {
        const aMs = Number.isFinite(a?.timeRange?.endMs)
          ? a.timeRange.endMs
          : Date.parse(a?.timeRange?.end);
        const bMs = Number.isFinite(b?.timeRange?.endMs)
          ? b.timeRange.endMs
          : Date.parse(b?.timeRange?.end);
        const aVal = Number.isFinite(aMs) ? aMs : 0;
        const bVal = Number.isFinite(bMs) ? bMs : 0;
        return bVal - aVal;
      });
      return list;
    }

    if (mode === 'type') {
      const typeLabel = (/** @type {any} */ c) =>
        String(
          c?.dominantFileCategoryLabel || c?.dominantFileCategory || c?.dominantCategory || ''
        );
      list.sort((a, b) => typeLabel(a).localeCompare(typeLabel(b)));
      return list;
    }

    if (mode === 'tag') {
      const tagOrFolder = (/** @type {any} */ c) =>
        String(
          c?.dominantFolderName || (Array.isArray(c?.commonTags) ? c.commonTags[0] || '' : '') || ''
        );
      list.sort((a, b) => tagOrFolder(a).localeCompare(tagOrFolder(b)));
      return list;
    }

    return list;
  }, []);

  const renderClustersToGraph = useCallback(
    (/** @type {any} */ clusters, /** @type {any} */ crossClusterEdges) => {
      const currentFilters = clusterFiltersRef.current;
      const normalizedSearch = (currentFilters.search || '').trim().toLowerCase();

      const filteredClusters = (Array.isArray(clusters) ? clusters : []).filter((cluster) => {
        const confOk = currentFilters.confidence.includes(cluster.confidence || 'low');
        const sizeOk = (cluster.memberCount || 0) >= (currentFilters.minSize || 1);
        const typeOk =
          currentFilters.fileType === 'all' ||
          String(cluster.dominantFileCategory || cluster.dominantCategory || '').toLowerCase() ===
            String(currentFilters.fileType || '').toLowerCase();
        const searchOk =
          !normalizedSearch ||
          (cluster.label || '').toLowerCase().includes(normalizedSearch) ||
          (cluster.commonTags || [])
            .map((/** @type {any} */ t) => (t || '').toLowerCase())
            .some((/** @type {any} */ t) => t.includes(normalizedSearch));
        return confOk && sizeOk && searchOk && typeOk;
      });

      if (filteredClusters.length === 0) {
        graphActions.setGraph([], []);
        setShowClusters(true);
        setGraphStatus('No groups match your current filters.');
        return;
      }

      const mode = clusterModeRef.current || DEFAULT_CLUSTER_MODE;
      const presentationClusters = regroupClustersForMode(filteredClusters, mode);
      const presentationEdges = mode === 'topic' ? crossClusterEdges : [];
      const ordered = sortClustersForMode(presentationClusters);
      const clusterById = new Map(ordered.map((cluster) => [cluster.id, cluster]));

      const clusterNodes = ordered.map((cluster, idx) => ({
        id: cluster.id,
        type: 'clusterNode',
        position: defaultNodePosition(idx),
        data: {
          kind: 'cluster',
          id: cluster.id,
          clusterId: cluster.clusterId,
          label: getClusterDisplayLabel(cluster),
          memberCount: cluster.memberCount,
          memberIds: cluster.memberIds,
          expanded: false,
          topTerms: sanitizeGraphMetadataTerms(cluster.topTerms || cluster.commonTags, {
            maxTerms: 5
          }),
          confidence: cluster.confidence || 'low',
          dominantCategory: cluster.dominantCategory || null,
          dominantFolderName: cluster.dominantFolderName || '',
          commonTags: sanitizeGraphMetadataTerms(cluster.commonTags, { maxTerms: 10 }),
          timeRange: cluster.timeRange || null,
          isAutoGenerated: true,
          onCreateSmartFolder: handleCreateSmartFolderFromCluster,
          onMoveAllToFolder: handleMoveAllToFolder,
          onExportFileList: handleExportFileList,
          onOpenAllFiles: handleOpenAllFilesInCluster,
          onSearchWithinCluster: handleSearchWithinCluster,
          onRenameCluster: handleRenameCluster,
          onTagCluster: handleTagCluster,
          onExpand: handleClusterExpand
        },
        draggable: true
      }));

      const filteredClusterIds = new Set(
        presentationClusters.map((c) => /** @type {any} */ (c).id)
      );
      const uniqueEdgesMap = new Map();
      (Array.isArray(presentationEdges) ? presentationEdges : [])
        .filter(
          (edge) => filteredClusterIds.has(edge.source) && filteredClusterIds.has(edge.target)
        )
        .forEach((edge) => {
          const [u, v] = [edge.source, edge.target].sort();
          const key = `${u}|${v}`;

          const current = uniqueEdgesMap.get(key) || {
            similarity: 0,
            count: 0,
            sharedTerms: [],
            bridgeFiles: []
          };

          const mergedBridgeFiles = [
            ...(current.bridgeFiles || []),
            ...(edge.bridgeFiles || []).slice(0, 6)
          ].filter(Boolean);

          const uniqueBridgeFiles = Array.from(
            new Map(
              mergedBridgeFiles.map((file) => [file?.id || file?.path || file, file])
            ).values()
          );

          uniqueEdgesMap.set(key, {
            ...current,
            source: u,
            target: v,
            similarity: Math.max(current.similarity || 0, edge.similarity || 0),
            bridgeFiles: uniqueBridgeFiles,
            count:
              uniqueBridgeFiles.length > 0
                ? uniqueBridgeFiles.length
                : (current.count || 0) + (edge.count || 0),
            sharedTerms: sanitizeSemanticTerms(
              [
                ...(current.sharedTerms || []),
                ...(edge.commonTerms || edge.sharedTerms || edge.tags || edge.labels || []).slice(
                  0,
                  3
                )
              ],
              { maxTerms: 6, minLength: 2 }
            )
          });
        });

      const uniqueEdges = Array.from(uniqueEdgesMap.values());
      const edgesByNode = new Map();
      uniqueEdges.forEach((edge) => {
        if (!edgesByNode.has(edge.source)) edgesByNode.set(edge.source, []);
        edgesByNode.get(edge.source).push(edge);

        if (!edgesByNode.has(edge.target)) edgesByNode.set(edge.target, []);
        edgesByNode.get(edge.target).push(edge);
      });

      const MAX_CONNECTIONS = 1;
      const STRICT_THRESHOLD = 0.72;
      const VERY_STRONG_THRESHOLD = 0.82;
      const MIN_BRIDGE_FILES = 2;
      const edgeQuality = (/** @type {any} */ candidate) => {
        const sim = Number(candidate?.similarity || 0);
        const sharedTermCount = Array.isArray(candidate?.sharedTerms)
          ? candidate.sharedTerms.length
          : 0;
        const bridgeFileCount = Array.isArray(candidate?.bridgeFiles)
          ? candidate.bridgeFiles.length
          : 0;
        return sim + sharedTermCount * 0.04 + Math.min(bridgeFileCount, 4) * 0.025;
      };
      const rankByNode = new Map();
      edgesByNode.forEach((nodeEdges, nodeId) => {
        const rankedEdges = [...nodeEdges].sort((a, b) => edgeQuality(b) - edgeQuality(a));
        const rankMap = new Map();
        rankedEdges.forEach((candidate, index) => {
          rankMap.set(candidate, index);
        });
        rankByNode.set(nodeId, rankMap);
      });
      const meaningfulEdges = uniqueEdges.filter((edge) => {
        const sim = Number(edge?.similarity || 0);
        const sharedTermCount = Array.isArray(edge?.sharedTerms) ? edge.sharedTerms.length : 0;
        const bridgeFileCount = Array.isArray(edge?.bridgeFiles) ? edge.bridgeFiles.length : 0;
        const hasSemanticEvidence =
          sharedTermCount > 0 ||
          bridgeFileCount >= MIN_BRIDGE_FILES ||
          sim >= VERY_STRONG_THRESHOLD;

        if (sim < STRICT_THRESHOLD || !hasSemanticEvidence) return false;

        const sourceRank = rankByNode.get(edge.source)?.get(edge);
        const targetRank = rankByNode.get(edge.target)?.get(edge);
        const isTopForSource = Number.isFinite(sourceRank) && sourceRank < MAX_CONNECTIONS;
        const isTopForTarget = Number.isFinite(targetRank) && targetRank < MAX_CONNECTIONS;

        return isTopForSource || isTopForTarget;
      });

      const clusterEdges = meaningfulEdges.map((edge) => {
        const sourceCluster = clusterById.get(edge.source);
        const targetCluster = clusterById.get(edge.target);
        const sourceFolder = String(sourceCluster?.dominantFolderName || '');
        const targetFolder = String(targetCluster?.dominantFolderName || '');
        const foldersDiffer =
          sourceFolder.length > 0 && targetFolder.length > 0 && sourceFolder !== targetFolder;
        const isSurprise = (edge.similarity || 0) >= 0.82 && foldersDiffer;

        return {
          id: `cross:${edge.source}->${edge.target}`,
          source: edge.source,
          target: edge.target,
          type: 'similarity',
          animated: false,
          style: {
            stroke: 'var(--color-system-gray-500)',
            strokeWidth: Math.max(1, (edge.similarity || 0.5) * 1.25),
            strokeDasharray: '4,8',
            opacity: 0.24
          },
          className: 'cross-cluster-edge',
          data: {
            kind: 'cross_cluster',
            similarity: edge.similarity || 0.5,
            bridgeCount: edge.count || 0,
            isSurprise,
            sharedTerms: sanitizeSemanticTerms(edge.sharedTerms, { maxTerms: 3, minLength: 2 }),
            bridgeFiles: edge.bridgeFiles || [],
            showEdgeLabels: false,
            showEdgeTooltips: edgeTooltipsRef.current
          }
        };
      });

      graphActions.setGraph(clusterNodes, clusterEdges);
      setShowClusters(true);

      setGraphStatus(`Found ${presentationClusters.length} groups (cluster by: ${mode})`);

      if (clusterNodes.length > 0) {
        try {
          const estimatedArcWidth = 380 + 180;
          const minRadius = 550;
          const dynamicRadius = Math.max(
            minRadius,
            (Math.max(clusterNodes.length, 1) * estimatedArcWidth) / (2 * Math.PI)
          );

          const layoutedNodes = clusterRadialLayout(clusterNodes, clusterEdges, {
            centerX: 450,
            centerY: 320,
            radius: dynamicRadius
          });
          graphActions.setNodes(layoutedNodes);
        } catch (layoutError) {
          logger.warn('[Graph] Cluster layout failed:', layoutError);
        }

        // The <ReactFlow fitView> prop only auto-fits on the initial (empty)
        // mount, so after populating clusters we must explicitly frame them or
        // the default view stays parked at the origin with the nodes off-screen.
        // Defer one frame so ReactFlow has applied/measured the new nodes.
        setTimeout(() => {
          reactFlowInstance.current?.fitView(getDefaultGraphFitViewOptions({ duration: 400 }));
        }, 100);
      }
    },
    [
      graphActions,
      getClusterDisplayLabel,
      sortClustersForMode,
      handleCreateSmartFolderFromCluster,
      handleMoveAllToFolder,
      handleExportFileList,
      handleOpenAllFilesInCluster,
      handleSearchWithinCluster,
      handleTagCluster,
      handleRenameCluster,
      handleClusterExpand
    ]
  );

  const loadClusters = useCallback(async () => {
    const requestId = nextRequestId(clustersRequestCounterRef);
    setIsComputingClusters(true);
    setGraphStatus('Analyzing file relationships...');
    setError('');
    // Reset expansion flag so the background refresh is allowed again on a fresh load
    userHasExpandedRef.current = false;

    try {
      // Prefer using cached clusters when available; recompute only if stale.
      let clustersResp = await window.electronAPI?.embeddings?.getClusters?.();
      if (!clustersResp || clustersResp.success !== true) {
        throw new Error(getErrorMessage(clustersResp?.error, 'Clusters'));
      }

      if (clustersResp.stale === true) {
        // computeClusters returns clusters + crossClusterEdges directly with
        // fast metadata-based labels immediately. Graph loads pass generateLabels:false
        // so the tab does not trigger optional LLM label refinement / model load on tight VRAM.
        const computeResp = await window.electronAPI?.embeddings?.computeClusters?.('auto', {
          generateLabels: false
        });
        if (!computeResp || computeResp.success !== true) {
          throw new Error(getErrorMessage(computeResp?.error, 'Clusters'));
        }
        // Use the response directly — no redundant second getClusters call needed.
        clustersResp = computeResp;
      }

      const clusters = clustersResp.clusters || [];
      const crossClusterEdges = clustersResp.crossClusterEdges || [];

      if (!Array.isArray(clusters) || clusters.length === 0) {
        setGraphStatus('No related groups found yet. Try indexing more files.');
        setShowClusters(true);
        graphActions.setGraph([], []);
        return;
      }

      lastClustersRef.current = clusters;
      lastCrossClusterEdgesRef.current = crossClusterEdges;

      renderClustersToGraph(clusters, crossClusterEdges);

      // W3: Asynchronously augment cluster view with knowledge relationship edges.
      // Collect all member IDs and find file-level connections; map them back to cluster pairs.
      const allMemberIds = clusters.flatMap((c) => c.memberIds || []).slice(0, 500);
      if (allMemberIds.length > 0) {
        window.electronAPI?.knowledge
          ?.getRelationshipEdges?.(allMemberIds, { minWeight: 3, maxEdges: 200 })
          .then(
            /**
             * @param {any} relResp
             * @returns {any}
             */
            (relResp) => {
              // Drop the augmentation if a fresher loadClusters has started since
              // we issued this request — its edges describe a stale cluster set.
              if (
                !isMountedRef.current ||
                !isCurrentRequest(clustersRequestCounterRef, requestId) ||
                !relResp?.success
              ) {
                return undefined;
              }
              const relEdges = Array.isArray(relResp.edges) ? relResp.edges : [];
              if (relEdges.length === 0) return undefined;

              // Build a map of fileId -> clusterId for quick lookup
              const fileToCluster = new Map();
              clusters.forEach((c) => {
                (c.memberIds || []).forEach((/** @type {any} */ id) => fileToCluster.set(id, c.id));
              });

              const pairBest = new Map();
              relEdges.forEach((/** @type {any} */ e) => {
                const srcCluster = fileToCluster.get(e.source);
                const tgtCluster = fileToCluster.get(e.target);
                if (!srcCluster || !tgtCluster || srcCluster === tgtCluster) return;
                const [u, v] = [String(srcCluster), String(tgtCluster)].sort();
                const edgeId = `rel-cluster:${u}|${v}`;
                const w = Number(e.weight) || 0;
                const terms = sanitizeSemanticTerms(e.concepts || e.sharedTerms, {
                  maxTerms: 6,
                  minLength: 2
                });
                const cur = pairBest.get(edgeId);
                if (!cur) {
                  pairBest.set(edgeId, {
                    source: srcCluster,
                    target: tgtCluster,
                    maxWeight: w,
                    concepts: new Set(terms)
                  });
                } else {
                  cur.maxWeight = Math.max(cur.maxWeight, w);
                  terms.forEach((t) => cur.concepts.add(t));
                }
              });

              graphActions.setEdges((/** @type {any} */ prev) => {
                if (pairBest.size === 0) return prev;
                const next = prev.map((/** @type {any} */ e) =>
                  e ? { ...e, data: e.data ? { ...e.data } : {} } : e
                );
                for (const [edgeId, agg] of pairBest) {
                  const conceptArr = Array.from(agg.concepts).slice(0, 8);
                  const sim = Math.max(0, Math.min(1, agg.maxWeight / 10));
                  const i = next.findIndex((/** @type {any} */ e) => e && e.id === edgeId);
                  if (i >= 0) {
                    const e = next[i];
                    const mergedWeight = Math.max(Number(e.data?.weight) || 0, agg.maxWeight);
                    const combined = new Set([...(e.data?.concepts || []), ...conceptArr]);
                    const mergedConcepts = Array.from(combined).slice(0, 8);
                    e.data = {
                      ...e.data,
                      kind: 'knowledge',
                      weight: mergedWeight,
                      concepts: mergedConcepts,
                      sharedTerms: mergedConcepts,
                      similarity: Math.max(Number(e.data?.similarity) || 0, sim)
                    };
                  } else {
                    next.push({
                      id: edgeId,
                      source: agg.source,
                      target: agg.target,
                      type: 'knowledge',
                      data: {
                        kind: 'knowledge',
                        weight: agg.maxWeight,
                        concepts: conceptArr,
                        sharedTerms: conceptArr,
                        similarity: sim
                      }
                    });
                  }
                }
                return next;
              });
              return undefined;
            }
          )
          .catch((/** @type {any} */ err) => {
            logger.debug('[KnowledgeOS] getRelationshipEdges enrichment failed', {
              error: err?.message || String(err)
            });
          });
      }

      // Background: After a short delay, re-fetch cached clusters from main (labels or
      // edges may have been updated elsewhere — e.g. organize flow or IPC with LLM on)
      // and silently re-render the graph.
      if (clusterRefreshTimeoutRef.current) {
        clearTimeout(clusterRefreshTimeoutRef.current);
      }
      clusterRefreshTimeoutRef.current = setTimeout(async () => {
        try {
          if (!isMountedRef.current) return;
          const refreshed = await window.electronAPI?.embeddings?.getClusters?.();
          if (
            refreshed?.success &&
            Array.isArray(refreshed.clusters) &&
            refreshed.clusters.length > 0
          ) {
            lastClustersRef.current = refreshed.clusters;
            lastCrossClusterEdgesRef.current = refreshed.crossClusterEdges || crossClusterEdges;
            renderClustersToGraph(
              refreshed.clusters,
              refreshed.crossClusterEdges || crossClusterEdges
            );
          }
        } catch {
          // Label refresh is best-effort; failures are non-critical.
        } finally {
          clusterRefreshTimeoutRef.current = null;
        }
      }, 6000);
    } catch (e) {
      setError(getErrorMessage(e, 'Cluster loading'));
      setGraphStatus('');
    } finally {
      setIsComputingClusters(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphActions, renderClustersToGraph]);

  // Assign to ref so keyboard shortcuts can access it
  loadClustersRef.current = loadClusters;

  // Auto-load clusters when opening graph tab (if files are indexed)
  useEffect(() => {
    if (!graphViewEnabled || !isOpen || activeTab !== 'graph') return;
    if (hasAutoLoadedClusters.current) return;
    if (nodes.length > 0) return; // Already have nodes
    if (!stats?.files || stats.files === 0) return; // No indexed files

    // Auto-load clusters to give users something to explore
    hasAutoLoadedClusters.current = true;
    loadClusters();
  }, [graphViewEnabled, isOpen, activeTab, stats, nodes.length, loadClusters]);

  // Refresh insights when the vector DB transitions out of `hydrating` /
  // `recovering` back to `connected`. Without this, dock counts (clusters,
  // bridges, near-dupes) keep showing the pre-hydration snapshot until the
  // user manually re-runs a search or reopens the graph tab. The recent
  // schema fix (b01e534e) added the `hydrating` enum value but no consumer
  // reacted to it.
  const lastVectorDbStatusRef = useRef(null);
  useEffect(() => {
    if (!isOpen) return undefined;
    const offFn = /** @type {any} */ (window)?.api?.vectorDb?.onStatusChanged?.(
      (/** @type {any} */ payload) => {
        const status = payload?.status;
        if (!status) return;
        const prev = lastVectorDbStatusRef.current;
        lastVectorDbStatusRef.current = status;
        // Only refresh on the transition INTO `connected`/`online` from a
        // degraded state; ignore steady-state ticks to avoid refresh loops.
        const becameHealthy =
          (status === 'connected' || status === 'online') &&
          (prev === 'hydrating' || prev === 'recovering' || prev === 'connecting');
        if (becameHealthy && graphViewEnabled && activeTab === 'graph') {
          loadClustersRef.current?.();
        }
      }
    );
    return typeof offFn === 'function' ? offFn : undefined;
  }, [isOpen, graphViewEnabled, activeTab]);

  // Pre-compute near-duplicate insight counts for graph landing card.
  // Deferred until cluster loading completes to avoid saturating IPC during startup.
  useEffect(() => {
    let cancelled = false;
    if (!graphViewEnabled || !isOpen || activeTab !== 'graph') return undefined;
    if (isComputingClusters) return undefined;
    if (!stats?.files || stats.files < 2) {
      lastDuplicateFileCountRef.current = null;
      setDuplicateSummary((prev) => ({
        ...prev,
        loading: false,
        groupCount: 0,
        totalDuplicates: 0
      }));
      return undefined;
    }

    // Skip if file count hasn't changed since last scan
    if (lastDuplicateFileCountRef.current === stats.files) return undefined;

    const run = async () => {
      setDuplicateSummary((prev) => ({ ...prev, loading: true }));
      try {
        const result = await window.electronAPI?.embeddings?.findDuplicates?.({
          threshold: 0.9,
          maxResults: 20
        });
        if (cancelled) return;
        lastDuplicateFileCountRef.current = stats.files;
        if (result?.success) {
          setDuplicateSummary(
            /** @type {any} */ ({
              loading: false,
              groupCount: Array.isArray(result.groups) ? result.groups.length : 0,
              totalDuplicates: Number.isFinite(result.totalDuplicates) ? result.totalDuplicates : 0
            })
          );
          return;
        }
      } catch {
        // Non-critical insight card enrichment failure.
      }
      if (!cancelled) {
        setDuplicateSummary((prev) => ({ ...prev, loading: false }));
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [graphViewEnabled, isOpen, activeTab, stats?.files, isComputingClusters]);

  // Refresh cluster presentation when mode/filters change (no recompute needed).
  useEffect(() => {
    if (!graphViewEnabled || !isOpen || activeTab !== 'graph') return;
    if (!showClusters) return;
    if (isComputingClusters) return;

    const clusters = lastClustersRef.current;
    if (!Array.isArray(clusters) || clusters.length === 0) return;
    const crossEdges = lastCrossClusterEdgesRef.current || [];

    const timer = setTimeout(() => {
      renderClustersToGraph(clusters, crossEdges);
    }, 200);

    return () => clearTimeout(timer);
  }, [
    graphViewEnabled,
    isOpen,
    activeTab,
    showClusters,
    isComputingClusters,
    clusterMode,
    clusterFilters,
    renderClustersToGraph
  ]);

  // Real-time updates: Listen for file operations
  useEffect(() => {
    const handleFileOperation = async (/** @type {any} */ event) => {
      const detail = event.detail || {};
      const operationType = detail.operationType || detail.operation;

      if (!operationType) return;

      if (operationType === 'delete') {
        const deletedPaths = Array.isArray(detail.files)
          ? detail.files
          : [detail.filePath || detail.oldPath].filter(Boolean);
        if (deletedPaths.length === 0) return;

        // Remove nodes for deleted paths
        graphActions.setNodes((/** @type {any} */ prev) =>
          prev.filter((/** @type {any} */ n) => !deletedPaths.includes(n.data?.path))
        );
        return;
      }

      if (operationType === 'move' || operationType === 'rename') {
        /** @type {any[]} */
        let pathPairs = [];

        if (
          Array.isArray(detail.files) &&
          Array.isArray(detail.destinations) &&
          detail.files.length === detail.destinations.length
        ) {
          pathPairs = detail.files.map((/** @type {any} */ oldPath, /** @type {any} */ index) => ({
            oldPath,
            newPath: detail.destinations[index]
          }));
        } else {
          const oldPath = detail.filePath || detail.oldPath;
          const newPath = detail.destPath || detail.newPath;
          if (oldPath && newPath) {
            pathPairs = [{ oldPath, newPath }];
          }
        }

        if (pathPairs.length === 0) return;

        // Map lookup keeps a batch organize (many moves × many nodes) linear.
        const newPathByOld = new Map(
          pathPairs.map((/** @type {any} */ pair) => [pair.oldPath, pair.newPath])
        );

        graphActions.setNodes((/** @type {any} */ prev) =>
          prev.map((/** @type {any} */ n) => {
            const newPath = newPathByOld.get(n.data?.path);
            if (!newPath) return n;
            // The file now lives under its destination folder. Refresh the
            // grouping/display key so the node subtitle and any folder grouping
            // reflect the new home instead of the pre-move suggestion (the
            // stale-reference bug after organizing).
            // Folder NAME (not the absolute dirname): grouping keys, folder
            // node labels, and `Folder: <name>` subjects elsewhere all use
            // names — a full path here breaks subject-equality with unmoved
            // siblings and leaks filesystem paths into node labels.
            const newFolder = safeBasename(safeDirname(newPath));
            const prevSubject = typeof n.data?.subject === 'string' ? n.data.subject : '';
            const subjectIsFolderDerived = prevSubject === '' || prevSubject.startsWith('Folder: ');
            return {
              ...n,
              data: {
                ...n.data,
                path: newPath,
                label: safeBasename(newPath),
                suggestedFolder: newFolder || n.data?.suggestedFolder || '',
                subject:
                  subjectIsFolderDerived && newFolder ? `Folder: ${newFolder}` : n.data?.subject
              }
            };
          })
        );
      }
    };

    window.addEventListener('file-operation-complete', handleFileOperation);
    return () => window.removeEventListener('file-operation-complete', handleFileOperation);
  }, [graphActions]);

  /**
   * Expand a cluster to show its members with current file names
   */
  const expandCluster = useCallback(
    async (/** @type {any} */ clusterId, /** @type {any} */ memberIds) => {
      if (!Array.isArray(memberIds) || memberIds.length === 0) return;

      const currentNodeCount = (nodesRef.current || []).length;
      if (currentNodeCount + memberIds.length > MAX_GRAPH_NODES) {
        const available = Math.max(0, MAX_GRAPH_NODES - currentNodeCount);
        if (available === 0) {
          setGraphStatus(
            `Graph limit (${MAX_GRAPH_NODES} nodes) reached. Collapse clusters or clear graph first.`
          );
          return;
        }
        const originalCount = memberIds.length;
        memberIds = memberIds.slice(0, available);
        setGraphStatus(
          `Showing ${available} of ${originalCount} members (graph limit: ${MAX_GRAPH_NODES} nodes).`
        );
      }

      // Cancel the background label-refresh so it cannot wipe an expanded graph
      if (!userHasExpandedRef.current) {
        userHasExpandedRef.current = true;
        if (clusterRefreshTimeoutRef.current) {
          clearTimeout(clusterRefreshTimeoutRef.current);
          clusterRefreshTimeoutRef.current = null;
        }
      }

      setGraphStatus('Expanding cluster...');

      try {
        // Get cluster node for layout calculation - use ref for latest nodes
        const currentNodes = nodesRef.current || [];
        const clusterNode = currentNodes.find((/** @type {any} */ n) => n.id === clusterId);

        // Fetch actual file metadata to get current names (not original names)
        let membersWithMetadata = [];
        try {
          // Extract numeric cluster ID from the string ID (e.g., "cluster:0" -> 0)
          const numericClusterId = parseInt(clusterId.replace('cluster:', ''), 10);
          const memberResp =
            await window.electronAPI?.embeddings?.getClusterMembers?.(numericClusterId);

          if (memberResp?.success && Array.isArray(memberResp.members)) {
            membersWithMetadata = memberResp.members;
          }
        } catch (fetchErr) {
          logger.warn('[Graph] Failed to fetch cluster members metadata:', fetchErr);
        }

        // Build a map of id -> metadata for quick lookup
        const metadataMap = new Map(
          membersWithMetadata.map((/** @type {any} */ m) => [m.id, m.metadata || {}])
        );

        // Create file nodes with proper current names from metadata
        const memberNodes = memberIds.map((/** @type {any} */ id) => {
          const metadata = metadataMap.get(id) || {};
          const memberPath = getMetadataPath(metadata, id) || id;
          // Use metadata.name first (current organized name), fallback to path extraction
          const currentName =
            getMetadataName(metadata, memberPath, id) ||
            safeBasename(id) ||
            id.split('/').pop() ||
            id.split('\\').pop() ||
            id;

          return {
            id,
            type: 'fileNode',
            position: { x: 0, y: 0 }, // Will be set by layout
            data: {
              kind: 'file',
              label: currentName,
              path: memberPath,
              // Include metadata for edge tooltips
              tags: sanitizeGraphMetadataTerms(metadata.tags || metadata.keywords, { maxTerms: 5 }),
              entities: sanitizeGraphMetadataTerms(metadata.keyEntities, { maxTerms: 5 }),
              dates: normalizeList(metadata.dates).slice(0, 3),
              suggestedFolder: recommendationMap[memberPath] || '',
              category: metadata.category || '',
              subject: metadata.subject || ''
            },
            draggable: true
          };
        });

        // Apply expansion layout to position nodes nicely
        // Use smart dynamic layout that adjusts radius and angle based on count
        // Point the fan AWAY from the center of the graph (approx 450, 320) to avoid overlap
        const layoutedMemberNodes = clusterExpansionLayout(clusterNode, memberNodes, {
          offsetX: 320, // Base radius
          spacing: 80, // Arc length per node
          minAngle: Math.PI / 4, // Minimum arc for small clusters
          origin: { x: 450, y: 320 } // Center of the graph layout
        });

        // Create edges from cluster to members (Distinct visual style)
        // Use smooth bezier curves instead of straight lines for a more organic feel
        const memberEdges = memberIds.map((/** @type {any} */ id) => ({
          id: `cluster:${clusterId}->${id}`,
          source: clusterId,
          target: id,
          type: 'smartStep',
          animated: false,
          style: {
            stroke: 'var(--color-stratosort-accent)',
            strokeWidth: 1.5,
            opacity: 0.4
          },
          data: { kind: 'cluster_member' }
        }));

        const { folderNodes, edges: organizeEdges } = buildRecommendationGraph(layoutedMemberNodes);

        // Add to existing graph (deduplicate by path for file nodes)
        graphActions.setNodes((/** @type {any} */ prev) => {
          const existingKeys = new Set(prev.map(nodeDeduplicationKey));
          const newNodes = layoutedMemberNodes.filter(
            (n) => !existingKeys.has(nodeDeduplicationKey(n))
          );

          // Mark cluster as expanded
          const updated = prev.map((/** @type {any} */ n) => {
            if (n.id === clusterId) {
              return { ...n, data: { ...n.data, expanded: true } };
            }
            return n;
          });

          const withFolders = folderNodes.filter((n) => !existingKeys.has(nodeDeduplicationKey(n)));
          return [...updated, ...newNodes, ...withFolders];
        });

        graphActions.setEdges((/** @type {any} */ prev) => {
          const existingIds = new Set(prev.map((/** @type {any} */ e) => e.id));
          const newEdges = memberEdges.filter((/** @type {any} */ e) => !existingIds.has(e.id));
          const newOrganizeEdges = organizeEdges.filter((e) => !existingIds.has(e.id));
          return [...prev, ...newEdges, ...newOrganizeEdges];
        });

        // Smooth viewport animation to show expanded members
        setTimeout(() => {
          const expandedNodeIds = [clusterId, ...memberIds];
          reactFlowInstance.current?.fitView(
            getDefaultGraphFitViewOptions({
              nodes: expandedNodeIds.map((id) => ({ id })),
              padding: 0.25,
              duration: 500
            })
          );
        }, 100);

        setGraphStatus(
          `${layoutedMemberNodes.length} related files. Right-click cluster to organize them.`
        );

        // W1/W2: Asynchronously fetch inter-file edges (similarity + knowledge relationships)
        // so member files show their connections to each other after expansion.
        try {
          const [simResp, relResp] = await Promise.allSettled([
            window.electronAPI?.embeddings?.getSimilarityEdges?.(memberIds),
            memberIds.length >= 2
              ? window.electronAPI?.knowledge?.getRelationshipEdges?.(memberIds, {
                  minWeight: 2,
                  maxEdges: 200
                })
              : Promise.resolve({ success: true, edges: [] })
          ]);

          /** @type {any[]} */
          const interNodeEdges = [];

          if (simResp.status === 'fulfilled' && simResp.value?.success) {
            const simEdges = Array.isArray(simResp.value.edges) ? simResp.value.edges : [];
            simEdges.forEach((/** @type {any} */ e) => {
              const [u, v] = [e.source, e.target].sort();
              interNodeEdges.push({
                id: `sim:${u}->${v}`,
                source: e.source,
                target: e.target,
                type: 'similarity',
                data: { kind: 'similarity', similarity: e.similarity || 0, weight: e.weight || 0 }
              });
            });
          }

          if (relResp.status === 'fulfilled' && relResp.value?.success) {
            const relEdges = Array.isArray(relResp.value.edges) ? relResp.value.edges : [];
            relEdges.forEach((/** @type {any} */ e) => {
              const [u, v] = [e.source, e.target].sort();
              const edgeId = `rel:${u}->${v}`;
              if (!interNodeEdges.some((ie) => ie.id === edgeId)) {
                const relationConcepts = sanitizeSemanticTerms(e.concepts || e.sharedTerms, {
                  maxTerms: 3,
                  minLength: 2
                });
                interNodeEdges.push({
                  id: edgeId,
                  source: e.source,
                  target: e.target,
                  type: 'knowledge',
                  data: {
                    kind: 'multi_hop',
                    weight: e.weight || 0,
                    concepts: relationConcepts,
                    sharedTerms: relationConcepts
                  }
                });
              }
            });
          }

          if (interNodeEdges.length > 0) {
            graphActions.setEdges((/** @type {any} */ prev) => {
              const existingIds = new Set(prev.map((/** @type {any} */ e) => e.id));
              const newEdges = interNodeEdges.filter((e) => !existingIds.has(e.id));
              if (newEdges.length === 0) return prev;
              return [...prev, ...newEdges];
            });
            setGraphStatus(
              `${layoutedMemberNodes.length} files · ${interNodeEdges.length} connections found.`
            );
          }
        } catch (edgeErr) {
          logger.debug('[Graph] Failed to fetch inter-node edges after expand:', edgeErr);
        }
      } catch (e) {
        setError(getErrorMessage(e, 'Cluster expansion'));
        setGraphStatus('');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graphActions, recommendationMap]
  );

  // Assign to ref so handleClusterExpand can access it
  expandClusterRef.current = expandCluster;

  const runGraphSearch = useCallback(
    async (/** @type {any} */ overrideQuery) => {
      // Accept overrideQuery to support immediate search from autocomplete
      // without waiting for state update
      const q = (typeof overrideQuery === 'string' ? overrideQuery : query).trim();
      if (q.length < 2) return;

      // Update query state if using override (keeps UI in sync)
      if (typeof overrideQuery === 'string' && overrideQuery !== query) {
        setQuery(overrideQuery);
      }

      // Capture addMode at search start to prevent race condition if user toggles during async operation
      const shouldAddMode = addMode;
      const requestId = nextRequestId(graphSearchRequestCounterRef);
      const isStaleSearch = () =>
        !isCurrentRequest(graphSearchRequestCounterRef, requestId) || !isMountedRef.current;

      setError('');
      setGraphStatus('Searching...');

      try {
        // Graph search should be fast and interactive.
        // LLM re-ranking can exceed IPC timeouts and make the modal feel "stuck".
        const resp = await window.electronAPI?.embeddings?.search?.(q, {
          topK: defaultTopK,
          mode: 'hybrid',
          rerank: false
        });
        if (isStaleSearch()) return;
        if (!resp || resp.success !== true) {
          throw new Error(getErrorMessage(resp?.error, 'Graph search'));
        }

        const rawResults = Array.isArray(resp.results) ? resp.results : [];

        // Deduplicate by file path before creating graph nodes
        const dedupMap = new Map();
        for (const r of rawResults) {
          const key = getMetadataPath(r, r?.id) || r.id;
          const existing = dedupMap.get(key);
          if (!existing || (r.score || 0) > (existing.score || 0)) {
            dedupMap.set(key, r);
          }
        }
        const results = Array.from(dedupMap.values());

        const salt = Date.now();
        const queryNodeId = makeQueryNodeId(q, salt);

        const nextNodes = [];
        const nextEdges = [];

        const queryNode = {
          id: queryNodeId,
          type: 'queryNode', // Custom query node type
          position: { x: 40, y: 40 },
          data: {
            kind: 'query',
            label: q,
            resultCount: results.length,
            searchMode: resp.mode || 'hybrid',
            fallback: resp.meta?.fallback || false,
            corrections: resp.queryMeta?.corrections || null
          },
          draggable: true
        };

        nextNodes.push(queryNode);

        results.forEach((r, idx) => {
          const node = upsertFileNode(r, defaultNodePosition(idx));
          if (!node) return;
          nextNodes.push(node);
          nextEdges.push({
            id: `e:${queryNodeId}->${node.id}`,
            source: queryNodeId,
            target: node.id,
            type: 'queryMatch',
            animated: false, // Using custom edge with hover effects
            data: {
              kind: 'query_match',
              score: r.score,
              matchDetails: r.matchDetails || {},
              showEdgeLabels: showEdgeLabelsRef.current,
              showEdgeTooltips: edgeTooltipsRef.current
            }
          });
        });

        const { folderNodes, edges: organizeEdges } = buildRecommendationGraph(
          nextNodes.filter((node) => node.type === 'fileNode')
        );
        if (folderNodes.length > 0) {
          nextNodes.push(...folderNodes);
          nextEdges.push(...organizeEdges);
        }

        // Compute final nodes and edges FIRST to avoid stale closure issues
        // These values are used for both state update and layout calculation
        let finalNodes;
        let finalEdges;
        let nodeLimitReached = false;

        if (!shouldAddMode) {
          // Replace mode - use nextNodes directly
          if (nextNodes.length > MAX_GRAPH_NODES) {
            finalNodes = nextNodes.slice(0, MAX_GRAPH_NODES);
            nodeLimitReached = true;
            if (!isStaleSearch()) {
              setError(
                `Graph limit (${MAX_GRAPH_NODES} nodes) exceeded. Showing first ${MAX_GRAPH_NODES} results.`
              );
            }
          } else {
            finalNodes = nextNodes;
          }
          finalEdges = nextEdges;
        } else {
          // Add mode - merge with current state using refs to get latest values
          // This prevents stale closure issues when state changes during async operation
          const currentNodes = nodesRef.current || [];
          const currentEdges = edgesRef.current || [];

          // Filter out cluster nodes from current graph - they don't mix well with search results
          // Cluster nodes are designed for cluster exploration view, not search accumulation
          const nodesWithoutClusters = currentNodes.filter(
            (/** @type {any} */ n) => n.type !== 'clusterNode' && n.data?.kind !== 'cluster'
          );
          const edgesWithoutClusters = currentEdges.filter(
            (/** @type {any} */ e) =>
              e.data?.kind !== 'cluster_member' && e.data?.kind !== 'cross_cluster'
          );

          // Turn off cluster view since we're transitioning to search results
          setShowClusters(false);

          // Deduplicate by file path (not just ID) to prevent duplicate nodes
          // when the same file has different vector DB IDs across analysis runs
          const nodeMap = new Map(
            nodesWithoutClusters.map((/** @type {any} */ n) => [nodeDeduplicationKey(n), n])
          );
          nextNodes.forEach((n) => {
            const key = nodeDeduplicationKey(n);
            if (!nodeMap.has(key)) nodeMap.set(key, n);
          });
          const merged = Array.from(nodeMap.values());

          if (merged.length > MAX_GRAPH_NODES) {
            // Don't add more nodes if limit reached
            finalNodes = nodesWithoutClusters;
            nodeLimitReached = true;
            if (!isStaleSearch()) {
              setError(
                `Graph limit (${MAX_GRAPH_NODES} nodes) reached. Clear graph to start fresh.`
              );
            }
          } else {
            finalNodes = merged;
          }

          const edgeMap = new Map(edgesWithoutClusters.map((/** @type {any} */ e) => [e.id, e]));
          nextEdges.forEach((e) => edgeMap.set(e.id, e));

          finalEdges = Array.from(edgeMap.values());
        }

        // Filter edges to only include those where both source and target exist in finalNodes
        // This prevents ELK layout errors and orphaned edges (especially after node limiting)
        const finalNodeIds = new Set(finalNodes.map((/** @type {any} */ n) => n.id));
        finalEdges = finalEdges.filter(
          (e) => finalNodeIds.has(e.source) && finalNodeIds.has(e.target)
        );

        if (isStaleSearch()) return;
        // Now update state with computed values (only if there are changes)
        graphActions.setNodes((/** @type {any} */ prev) => {
          // Skip update if nothing changed (add mode and limit reached)
          if (nodeLimitReached && shouldAddMode) return prev;
          // Check if update is needed
          if (
            prev.length === finalNodes.length &&
            prev.every((/** @type {any} */ n, /** @type {any} */ i) => n.id === finalNodes[i]?.id)
          ) {
            return prev;
          }
          return finalNodes;
        });

        graphActions.setEdges((/** @type {any} */ prev) => {
          if (nodeLimitReached && shouldAddMode) return prev;
          if (
            prev.length === finalEdges.length &&
            prev.every((/** @type {any} */ e, /** @type {any} */ i) => e.id === finalEdges[i]?.id)
          ) {
            return prev;
          }
          return finalEdges;
        });

        graphActions.selectNode(results[0]?.id || queryNodeId);
        setGraphStatus(`Found ${results.length} matching file${results.length === 1 ? '' : 's'}`);

        // Apply auto-layout if enabled (debounced to prevent rapid re-layouts)
        // Uses pre-computed finalNodes/finalEdges to avoid stale state issues
        if (autoLayout && finalNodes.length > 1 && !nodeLimitReached) {
          setGraphStatus('Applying layout...');
          try {
            // Use smart layout for large graphs (progressive rendering)
            // Use debounced layout for smaller graphs
            let layoutedNodes;
            let layoutedEdges = finalEdges;
            if (finalNodes.length > LARGE_GRAPH_THRESHOLD) {
              const result = await smartLayout(finalNodes, finalEdges, {
                direction: 'RIGHT',
                spacing: GRAPH_LAYOUT_SPACING,
                layerSpacing: GRAPH_LAYER_SPACING,
                progressive: true
              });
              if (isStaleSearch()) return;
              layoutedNodes = result.nodes;
              if (result.edges && result.edges.length > 0) {
                layoutedEdges = applyEdgeUiPrefs(result.edges);
              }
              if (result.isPartial) {
                setGraphStatus(
                  `${results.length} results (${result.layoutedCount} laid out, ${finalNodes.length - result.layoutedCount} in grid)`
                );
              }
            } else {
              const layoutResult = await debouncedElkLayout(finalNodes, finalEdges, {
                direction: 'RIGHT',
                spacing: GRAPH_LAYOUT_SPACING,
                layerSpacing: GRAPH_LAYER_SPACING,
                debounceMs: 150
              });
              if (isStaleSearch()) return;
              layoutedNodes = layoutResult.nodes;
              if (layoutResult.edges && layoutResult.edges.length > 0) {
                layoutedEdges = applyEdgeUiPrefs(layoutResult.edges);
              }
            }
            if (isStaleSearch()) return;
            graphActions.setGraph(layoutedNodes, layoutedEdges);
            if (finalNodes.length <= LARGE_GRAPH_THRESHOLD) {
              setGraphStatus(
                `Found ${results.length} file${results.length === 1 ? '' : 's'}, organized by relevance`
              );
            }
          } catch (layoutError) {
            logger.warn('[Graph] Auto-layout failed:', layoutError);
          }
        }

        // Fetch and add similarity edges between file nodes
        const expandedFileIds = nextNodes.filter((n) => n.type === 'fileNode').map((n) => n.id);
        const nodeDataMap = new Map();
        nextNodes.forEach((n) => {
          if (n.type === 'fileNode') {
            nodeDataMap.set(n.id, {
              id: n.id, // surfaced for edge tooltip's onGroupFiles action
              label: n.data?.label || '',
              tags: n.data?.tags || [],
              category: n.data?.category || '',
              subject: n.data?.subject || '',
              path: n.data?.path || ''
            });
          }
        });

        // Fetch similarity and relationship edges in parallel — they are independent
        if (expandedFileIds.length >= 2) {
          const [simResult, relResult] = await Promise.allSettled([
            window.electronAPI?.embeddings?.getSimilarityEdges?.(expandedFileIds, {
              threshold: 0.75,
              maxEdgesPerNode: 1
            }),
            window.electronAPI?.knowledge?.getRelationshipEdges?.(expandedFileIds, {
              minWeight: 2,
              maxEdges: 200
            })
          ]);
          if (isStaleSearch()) return;

          // Process similarity edges
          if (simResult.status === 'fulfilled') {
            const simEdgesResp = simResult.value;
            if (simEdgesResp?.success && Array.isArray(simEdgesResp.edges)) {
              const similarityEdges = simEdgesResp.edges
                .filter(
                  (/** @type {any} */ e) => finalNodeIds.has(e.source) && finalNodeIds.has(e.target)
                )
                .map((/** @type {any} */ e) => {
                  const sourceData = nodeDataMap.get(e.source) || {};
                  const targetData = nodeDataMap.get(e.target) || {};
                  const sourceFolder = getParentFolderName(sourceData.path);
                  const targetFolder = getParentFolderName(targetData.path);
                  const foldersDiffer =
                    sourceFolder.length > 0 &&
                    targetFolder.length > 0 &&
                    sourceFolder !== targetFolder;
                  const isSurprise = Number(e.similarity || 0) >= 0.85 && foldersDiffer;
                  return {
                    id: e.id,
                    source: e.source,
                    target: e.target,
                    type: 'similarity',
                    animated: false,
                    data: {
                      kind: 'similarity',
                      similarity: e.similarity,
                      isSurprise,
                      sourceData,
                      targetData,
                      showEdgeLabels: showEdgeLabelsRef.current,
                      showEdgeTooltips: edgeTooltipsRef.current
                    }
                  };
                });

              if (similarityEdges.length > 0) {
                graphActions.setEdges((/** @type {any} */ prev) => {
                  const existingIds = new Set(prev.map((/** @type {any} */ e) => e.id));
                  const newEdges = similarityEdges.filter(
                    (/** @type {any} */ e) => !existingIds.has(e.id)
                  );
                  if (newEdges.length === 0) return prev;
                  return [...prev, ...newEdges];
                });
                setGraphStatus((prev) => `${prev} • ${similarityEdges.length} connections`);
              }
            }
          } else {
            logger.debug('[Graph] Failed to fetch similarity edges:', simResult.reason);
          }

          // Process relationship edges
          if (relResult.status === 'fulfilled') {
            const relEdgesResp = relResult.value;
            if (relEdgesResp?.success && Array.isArray(relEdgesResp.edges)) {
              const relationshipEdges = relEdgesResp.edges
                .filter(
                  (/** @type {any} */ edge) =>
                    finalNodeIds.has(edge.source) && finalNodeIds.has(edge.target)
                )
                .map((/** @type {any} */ edge) => ({
                  id: edge.id,
                  source: edge.source,
                  target: edge.target,
                  type: 'knowledge',
                  data: {
                    kind: 'knowledge',
                    weight: edge.weight,
                    concepts: Array.isArray(edge.concepts) ? edge.concepts : [],
                    sourceData: nodeDataMap.get(edge.source) || {},
                    targetData: nodeDataMap.get(edge.target) || {},
                    showEdgeTooltips: edgeTooltipsRef.current
                  }
                }));

              if (relationshipEdges.length > 0) {
                graphActions.setEdges((/** @type {any} */ prev) => {
                  const existingIds = new Set(prev.map((/** @type {any} */ e) => e.id));
                  const newEdges = relationshipEdges.filter(
                    (/** @type {any} */ e) => !existingIds.has(e.id)
                  );
                  if (newEdges.length === 0) return prev;
                  return [...prev, ...newEdges];
                });
                setGraphStatus((prev) => `${prev} • ${relationshipEdges.length} knowledge links`);
              }
            }
          } else {
            logger.debug('[Graph] Failed to fetch knowledge edges:', relResult.reason);
          }
        }
      } catch (e) {
        if (isStaleSearch()) return;
        setGraphStatus('');
        setError(getErrorMessage(e, 'Graph search'));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      query,
      defaultTopK,
      addMode,
      autoLayout,
      graphActions,
      upsertFileNode,
      applyEdgeUiPrefs,
      setQuery
    ]
  );

  const expandFromSelected = useCallback(
    async (/** @type {any} */ overrideNode = null) => {
      // Use provided node or fall back to selectedNode (fixes stale closure in onNodeDoubleClick)
      const seed = overrideNode || selectedNode;
      if (!seed || seed.data?.kind !== 'file') return;
      const seedId = seed.id;

      setError('');
      setGraphStatus(`Expanding (${hopCount} hop${hopCount > 1 ? 's' : ''})...`);

      try {
        // Use multi-hop expansion when hopCount > 1, otherwise use findSimilar for single hop
        const resp =
          hopCount > 1
            ? await window.electronAPI?.embeddings?.findMultiHop?.([seedId], {
                hops: hopCount,
                decay: DECAY_FACTOR
              })
            : await window.electronAPI?.embeddings?.findSimilar?.(seedId, 10);
        if (!resp || resp.success !== true) {
          throw new Error(getErrorMessage(resp?.error, 'Expand'));
        }

        const results = Array.isArray(resp.results) ? resp.results : [];
        const seedPos = seed.position || { x: 200, y: 200 };

        /** @type {any[]} */
        const nextNodes = [];
        /** @type {any[]} */
        const nextEdges = [];

        // Get seed node data for tooltips
        const seedNodeData = {
          id: seed.id, // surfaced for edge tooltip's onGroupFiles action
          label: seed.data?.label || '',
          tags: seed.data?.tags || [],
          category: seed.data?.category || '',
          subject: seed.data?.subject || '',
          path: seed.data?.path || ''
        };

        results.forEach((/** @type {any} */ r, /** @type {any} */ idx) => {
          const pos = {
            x: seedPos.x + 280,
            y: seedPos.y + idx * 80
          };
          const node = upsertFileNode(r, pos);
          if (!node?.id) return; // Ensure node has valid id for edge creation
          nextNodes.push(node);

          // Get target node data for tooltip
          const targetNodeData = {
            id: node.id, // surfaced for edge tooltip's onGroupFiles action
            label: node.data?.label || '',
            tags: node.data?.tags || [],
            category: node.data?.category || '',
            subject: node.data?.subject || '',
            path: node.data?.path || ''
          };

          const sourceFolder = getParentFolderName(seedNodeData.path);
          const targetFolder = getParentFolderName(targetNodeData.path);
          const foldersDiffer =
            sourceFolder.length > 0 && targetFolder.length > 0 && sourceFolder !== targetFolder;
          const isSurprise = Number(r.score || 0) >= 0.85 && foldersDiffer;

          nextEdges.push({
            id: `e:${seedId}->${node.id}`,
            source: seedId,
            target: node.id,
            type: 'similarity', // Use custom edge component
            animated: false,
            data: {
              kind: 'similarity',
              similarity: r.score || 0,
              isSurprise,
              sourceData: seedNodeData,
              targetData: targetNodeData,
              showEdgeLabels: showEdgeLabelsRef.current,
              showEdgeTooltips: edgeTooltipsRef.current
            }
          });
        });

        const { folderNodes, edges: organizeEdges } = buildRecommendationGraph(nextNodes);
        const nextNodesWithFolders = [...nextNodes, ...folderNodes];
        const nextEdgesWithFolders = [...nextEdges, ...organizeEdges];

        graphActions.setNodes((/** @type {any} */ prev) => {
          // Check if any new nodes need to be added (deduplicate by path for file nodes)
          const existingKeys = new Set(prev.map(nodeDeduplicationKey));
          const hasNewNodes = nextNodesWithFolders.some(
            (n) => !existingKeys.has(nodeDeduplicationKey(n))
          );

          if (!hasNewNodes) {
            // No new nodes to add, preserve reference to prevent unnecessary updates
            return prev;
          }

          // Merge new nodes with existing ones
          const map = new Map(prev.map((/** @type {any} */ n) => [nodeDeduplicationKey(n), n]));
          nextNodesWithFolders.forEach((n) => {
            const key = nodeDeduplicationKey(n);
            if (!map.has(key)) map.set(key, n);
          });
          return Array.from(map.values());
        });
        graphActions.setEdges((/** @type {any} */ prev) => {
          // Check if any new edges need to be added
          const existingEdgeIds = new Set(prev.map((/** @type {any} */ e) => e.id));
          const hasNewEdges = nextEdgesWithFolders.some((e) => !existingEdgeIds.has(e.id));

          if (!hasNewEdges) {
            // No new edges to add, preserve reference to prevent unnecessary updates
            return prev;
          }

          // Merge new edges with existing ones
          const map = new Map(prev.map((/** @type {any} */ e) => [e.id, e]));
          nextEdgesWithFolders.forEach((e) => map.set(e.id, e));
          return Array.from(map.values());
        });

        setGraphStatus(`Expanded: +${results.length}`);

        // Apply auto-layout if enabled (debounced)
        if (autoLayout && nextNodes.length > 0) {
          setGraphStatus('Applying layout...');
          try {
            // Get the final nodes and edges for layout
            // Use refs to get current state (nodes/edges from closure may be stale)
            const finalNodes = (() => {
              const currentNodes = nodesRef.current || [];
              const map = new Map(currentNodes.map((/** @type {any} */ n) => [n.id, n]));
              nextNodes.forEach((n) => {
                if (!map.has(n.id)) map.set(n.id, n);
              });
              return Array.from(map.values());
            })();

            const finalEdges = (() => {
              const currentEdges = edgesRef.current || [];
              const map = new Map(currentEdges.map((/** @type {any} */ e) => [e.id, e]));
              nextEdges.forEach((e) => map.set(e.id, e));
              return Array.from(map.values());
            })();

            // Use debounced layout for expansion
            const { nodes: layoutedNodes, edges: layoutedEdges } = await debouncedElkLayout(
              finalNodes,
              finalEdges,
              {
                direction: 'RIGHT',
                spacing: GRAPH_LAYOUT_SPACING,
                layerSpacing: GRAPH_LAYER_SPACING,
                debounceMs: 100 // Shorter debounce for explicit user action
              }
            );
            graphActions.setGraph(
              layoutedNodes,
              layoutedEdges && layoutedEdges.length > 0
                ? applyEdgeUiPrefs(layoutedEdges)
                : finalEdges
            );
            setGraphStatus(`Expanded: +${results.length} (laid out)`);
          } catch (layoutError) {
            logger.warn('[Graph] Auto-layout after expand failed:', layoutError);
          }
        }

        // Fetch similarity edges among newly expanded nodes (not just to the seed)
        if (nextNodes.length > 1) {
          try {
            const expandedNodeIds = nextNodes.map((n) => n.id);
            const simEdgesResp = await window.electronAPI?.embeddings?.getSimilarityEdges?.(
              expandedNodeIds,
              { threshold: 0.75, maxEdgesPerNode: 1 }
            );

            if (simEdgesResp?.success && Array.isArray(simEdgesResp.edges)) {
              // Build node data map for tooltips
              const nodeDataMap = new Map();
              nextNodes.forEach((n) => {
                nodeDataMap.set(n.id, {
                  id: n.id, // surfaced for edge tooltip's onGroupFiles action
                  label: n.data?.label || '',
                  tags: n.data?.tags || [],
                  category: n.data?.category || '',
                  subject: n.data?.subject || '',
                  path: n.data?.path || ''
                });
              });

              const interNodeEdges = simEdgesResp.edges
                .filter((/** @type {any} */ e) => e.source !== seedId && e.target !== seedId) // Exclude seed edges (already added)
                .map((/** @type {any} */ e) => {
                  const sourceData = nodeDataMap.get(e.source) || {};
                  const targetData = nodeDataMap.get(e.target) || {};
                  const sourceFolder = getParentFolderName(sourceData.path);
                  const targetFolder = getParentFolderName(targetData.path);
                  const foldersDiffer =
                    sourceFolder.length > 0 &&
                    targetFolder.length > 0 &&
                    sourceFolder !== targetFolder;
                  const isSurprise = Number(e.similarity || 0) >= 0.85 && foldersDiffer;
                  return {
                    id: `sim:${e.source}->${e.target}`,
                    source: e.source,
                    target: e.target,
                    type: 'similarity',
                    animated: false,
                    data: {
                      kind: 'similarity',
                      similarity: e.similarity,
                      isSurprise,
                      sourceData,
                      targetData,
                      showEdgeLabels: showEdgeLabelsRef.current,
                      showEdgeTooltips: edgeTooltipsRef.current
                    }
                  };
                });

              if (interNodeEdges.length > 0) {
                graphActions.setEdges((/** @type {any} */ prev) => {
                  const existingIds = new Set(prev.map((/** @type {any} */ e) => e.id));
                  const newEdges = interNodeEdges.filter(
                    (/** @type {any} */ e) => !existingIds.has(e.id)
                  );
                  if (newEdges.length === 0) return prev;
                  return [...prev, ...newEdges];
                });
                setGraphStatus((prev) => `${prev} • +${interNodeEdges.length} connections`);
              }
            }
          } catch (simErr) {
            logger.debug('[Graph] Failed to fetch inter-node similarity edges:', simErr);
          }
        }
      } catch (e) {
        setGraphStatus('');
        setError(getErrorMessage(e, 'Node expansion'));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedNode, autoLayout, hopCount, graphActions, upsertFileNode, applyEdgeUiPrefs]
  );

  // Assign to ref so event handlers can access it
  expandFromSelectedRef.current = expandFromSelected;

  // Debounce within-graph query
  useEffect(() => {
    const handle = setTimeout(
      () => setDebouncedWithinQuery(withinQuery.trim()),
      TIMEOUTS.DEBOUNCE_INPUT
    );
    return () => clearTimeout(handle);
  }, [withinQuery]);

  // Combined Node Styling Effect: Filters + Search Scoring
  useEffect(() => {
    if (!graphViewEnabled || activeTab !== 'graph' || !isOpen) return undefined;

    let cancelled = false;
    const requestId = (withinRequestCounterRef.current += 1);
    withinReqRef.current = requestId;

    const run = async () => {
      // 1. Prepare search scores if query exists
      let scoreMap = null;
      const q = debouncedWithinQuery;
      let topMatches = [];
      const activeScope =
        searchWithinScope &&
        focusNodeId &&
        searchWithinScope.clusterId === focusNodeId &&
        Array.isArray(searchWithinScope.memberIds)
          ? searchWithinScope
          : null;
      const scopedMemberIds = activeScope ? new Set(activeScope.memberIds) : null;
      const scoreTargetFileIds = scopedMemberIds
        ? fileNodeIds.filter((/** @type {any} */ id) => scopedMemberIds.has(id))
        : fileNodeIds;

      if (q && q.length >= 2 && scoreTargetFileIds.length > 0) {
        try {
          const resp = await window.electronAPI?.embeddings?.scoreFiles?.(q, scoreTargetFileIds);
          if (cancelled || withinReqRef.current !== requestId) return;

          if (resp && resp.success === true && Array.isArray(resp.scores)) {
            scoreMap = new Map(resp.scores.map((/** @type {any} */ s) => [s.id, clamp01(s.score)]));

            topMatches = resp.scores
              .filter((/** @type {any} */ s) => s.score > 0.5)
              .sort((/** @type {any} */ a, /** @type {any} */ b) => b.score - a.score)
              .slice(0, 5);
          }
        } catch (e) {
          setError(getErrorMessage(e, 'File scoring'));
        }
      }

      // 2. Calculate focus mode visibility
      const focusVisibleNodes = focusNodeId ? getNodesInFocus(focusNodeId, focusDepth) : null;
      const scopeClusterId = activeScope?.clusterId;
      const getNodeKind = (/** @type {any} */ node) =>
        node.data?.kind ||
        (node.type === 'clusterNode'
          ? 'cluster'
          : node.type === 'queryNode'
            ? 'query'
            : node.type === 'folderNode'
              ? 'folder'
              : 'file');
      const evaluateNodeVisibility = (/** @type {any} */ node) => {
        const kind = getNodeKind(node);
        const isTypeActive = activeFilters.types.includes(kind);
        let isConfidenceActive = true;
        if (kind === 'cluster') {
          const conf = ['high', 'medium', 'low'].includes(node.data?.confidence)
            ? node.data?.confidence
            : 'low';
          isConfidenceActive = activeFilters.confidence.includes(conf);
        }
        const isInFocus = focusVisibleNodes ? focusVisibleNodes.has(node.id) : true;
        const isInScope = scopedMemberIds
          ? (kind === 'cluster' && node.id === scopeClusterId) ||
            (kind === 'file' && scopedMemberIds.has(node.id))
          : true;
        return {
          kind,
          shouldHide: !isTypeActive || !isConfidenceActive || !isInFocus || !isInScope
        };
      };
      // Use the ref to avoid declaring `nodes` as a dependency (which would re-run
      // on every drag event). nodesRef.current is always up-to-date without being reactive.
      const visibilityByNodeId = new Map();
      const hiddenNodeIds = new Set();
      (nodesRef.current || []).forEach((/** @type {any} */ node) => {
        const visibility = evaluateNodeVisibility(node);
        visibilityByNodeId.set(node.id, visibility);
        if (visibility.shouldHide) {
          hiddenNodeIds.add(node.id);
        }
      });

      // 3. Apply updates (Filters + Scores + Focus)
      graphActions.setNodes((/** @type {any} */ prev) => {
        let changed = false;
        const updated = prev.map((/** @type {any} */ n) => {
          const visibility = visibilityByNodeId.get(n.id) || evaluateNodeVisibility(n);
          const { kind, shouldHide } = visibility;

          // -- Score/Opacity Logic --
          let opacity = 1;
          let borderColor;
          let borderWidth;
          let withinScore;

          if (scoreMap) {
            // Search is active
            if (kind === 'file' || n.type === 'fileNode') {
              const s = scoreMap.get(n.id);
              if (typeof s === 'number') {
                withinScore = s;
                opacity = scoreToOpacity(s);
                if (s > 0.75) {
                  borderColor = 'color-mix(in srgb, var(--color-stratosort-blue) 90%, transparent)';
                  borderWidth = 2;
                }
              } else {
                // Not a match - fade out
                withinScore = 0;
                opacity = 0.3;
              }
            } else if (kind === 'cluster' && n.data?.memberIds) {
              // Keep cluster visible if it contains a matching file
              const hasMatchingMember = n.data.memberIds.some(
                (/** @type {any} */ id) => (scoreMap.get(id) || 0) > 0.5
              );
              opacity = hasMatchingMember ? 1 : 0.3;
            } else {
              // Other nodes (queries, empty clusters) dim when searching files
              opacity = 0.3;
            }
          }

          // -- Check for changes --
          const currentHidden = n.hidden === true;
          const currentOpacity = n.style?.opacity ?? 1;
          const currentScore = n.data?.withinScore;

          if (
            shouldHide === currentHidden &&
            opacity === currentOpacity &&
            withinScore === currentScore &&
            n.style?.borderColor === borderColor &&
            n.style?.borderWidth === borderWidth
          ) {
            return n;
          }

          changed = true;
          const newData = { ...(n.data || {}) };
          if (withinScore !== undefined) newData.withinScore = withinScore;
          else delete newData.withinScore;

          return {
            ...n,
            hidden: shouldHide,
            data: newData,
            style: {
              ...(n.style || {}),
              opacity,
              borderColor,
              borderWidth
            }
          };
        });

        return changed ? updated : prev;
      });

      graphActions.setEdges((/** @type {any} */ prevEdges) => {
        let edgeChanged = false;
        const updatedEdges = prevEdges.map((/** @type {any} */ e) => {
          const shouldHideEdge = hiddenNodeIds.has(e.source) || hiddenNodeIds.has(e.target);
          if (e.hidden !== shouldHideEdge) {
            edgeChanged = true;
            return { ...e, hidden: shouldHideEdge };
          }
          return e;
        });

        return edgeChanged ? updatedEdges : prevEdges;
      });

      // 3. Zoom to matches (only if search was performed and we have matches)
      if (topMatches.length > 0 && reactFlowInstance.current) {
        reactFlowInstance.current.fitView(
          getDefaultGraphFitViewOptions({
            nodes: topMatches.map((/** @type {any} */ m) => ({ id: m.id })),
            padding: 0.3,
            duration: 300
          })
        );
        graphActions.selectNode(topMatches[0].id);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    graphViewEnabled,
    debouncedWithinQuery,
    fileNodeIds,
    isOpen,
    activeTab,
    graphActions,
    activeFilters,
    focusNodeId,
    focusDepth,
    getNodesInFocus,
    searchWithinScope
    // `nodes` intentionally omitted: we use nodesRef.current to avoid re-running
    // on every position/drag update, which would spam the scoreFiles IPC call.
  ]);

  const onNodeClick = useCallback(
    (/** @type {any} */ _, /** @type {any} */ node) => {
      if (!node?.id) return;
      graphActions.selectNode(node.id);
      // Single-click only selects the node for the details panel.
      // Focus mode (which hides the rest of the graph) is activated by double-click
      // or by the dedicated "Focus on Node" toolbar button on the FileNode card.
    },
    [graphActions]
  );

  // Select a node and pan/zoom the canvas to it. Used by the clickable titles
  // in the "What's interesting" cards so a name acts as a jump-to-node link.
  const focusGraphNode = useCallback(
    (/** @type {any} */ nodeId) => {
      if (!nodeId) return;
      graphActions.selectNode(nodeId);
      // Defer a frame so any selection-driven re-render settles before fitView.
      setTimeout(() => {
        reactFlowInstance.current?.fitView(
          getDefaultGraphFitViewOptions({
            nodes: [{ id: nodeId }],
            padding: 0.4,
            duration: 400,
            maxZoom: 1.2
          })
        );
      }, 60);
    },
    [graphActions]
  );

  const onNodesChange = useCallback(
    (/** @type {any} */ changes) => {
      // 1. Let React Flow helper handle all node updates (dragging, resizing, selection flags)
      graphActions.onNodesChange(changes);

      // 2. Sync our separate selection state for the details panel
      for (const change of changes) {
        if (change.type === 'select') {
          if (change.selected) {
            graphActions.selectNode(change.id);
          } else {
            graphActions.selectNode((/** @type {any} */ prev) =>
              prev === change.id ? null : prev
            );
          }
        }
      }
    },
    [graphActions]
  );

  // Double-click on a node to expand it (file or cluster)
  // Mouse enter/leave handlers for interactive edge visibility
  const onNodeMouseEnter = useCallback((/** @type {any} */ _, /** @type {any} */ node) => {
    // Only apply for cluster nodes
    if (node.type !== 'clusterNode') return;

    setHoveredClusterId((/** @type {any} */ prev) => (prev === node.id ? prev : node.id));
  }, []);

  const onNodeMouseLeave = useCallback((/** @type {any} */ _, /** @type {any} */ node) => {
    if (node.type !== 'clusterNode') return;

    setHoveredClusterId((/** @type {any} */ prev) => (prev === node.id ? null : prev));
  }, []);

  const syncGraphZoomFromViewport = useCallback(() => {
    const viewport = reactFlowInstance.current?.getViewport?.();
    if (!viewport || typeof viewport.zoom !== 'number') return;
    const nextBucket = getZoomBucket(viewport.zoom);
    zoomBucketRef.current = nextBucket;
    setZoomBucket(nextBucket);
    setZoomLevel(viewport.zoom);
  }, []);

  const handleGraphMove = useCallback((/** @type {any} */ _, /** @type {any} */ viewport) => {
    if (!viewport || typeof viewport.zoom !== 'number') return;
    const nextBucket = getZoomBucket(viewport.zoom);
    if (nextBucket === zoomBucketRef.current) return;
    zoomBucketRef.current = nextBucket;
    setZoomBucket(nextBucket);
    setZoomLevel(viewport.zoom);
  }, []);

  const onNodeDoubleClick = useCallback(
    (/** @type {any} */ _, /** @type {any} */ node) => {
      if (!node?.id) return;

      const kind = node?.data?.kind;

      // Handle cluster node double-click
      if (kind === 'cluster') {
        const memberIds = node?.data?.memberIds;
        if (Array.isArray(memberIds) && memberIds.length > 0) {
          expandCluster(node.id, memberIds);
        }
        return;
      }

      // Handle file node double-click
      if (kind === 'file') {
        graphActions.selectNode(node.id);
        // Pass node directly to avoid stale closure (selectedNode won't update until re-render)
        expandFromSelected(node);
      }
    },
    [expandFromSelected, expandCluster, graphActions]
  );

  const onNodeContextMenu = useCallback((/** @type {any} */ event, /** @type {any} */ node) => {
    event.preventDefault();
    event.stopPropagation();
    if (!node?.id) return;

    // Estimated menu dimensions for viewport clamping
    const menuW = 180;
    const menuH = node.type === 'cluster' ? 220 : 180;
    const x = Math.max(8, Math.min(event.clientX, window.innerWidth - menuW - 8));
    const y = Math.max(8, Math.min(event.clientY, window.innerHeight - menuH - 8));

    setContextMenu({
      x,
      y,
      nodeId: node.id,
      kind: node.data?.kind || node.type || 'file',
      data: node.data
    });
  }, []);

  const onEdgeClick = useCallback(
    (/** @type {any} */ _, /** @type {any} */ edge) => {
      if (!edge) return;
      const kind = edge.data?.kind || '';
      const source = edge.source;
      const target = edge.target;

      // Highlight connected nodes by selecting them in the focus context
      graphActions.setNodes((/** @type {any} */ prev) =>
        prev.map((/** @type {any} */ n) => {
          if (n.id === source || n.id === target) {
            return { ...n, selected: true };
          }
          // Deselect other nodes
          if (n.selected) return { ...n, selected: false };
          return n;
        })
      );

      // Surface edge info in the status bar
      const sourceNode = (nodesRef.current || []).find((/** @type {any} */ n) => n.id === source);
      const targetNode = (nodesRef.current || []).find((/** @type {any} */ n) => n.id === target);
      const sourceLabel = sourceNode?.data?.label || source;
      const targetLabel = targetNode?.data?.label || target;

      const kindLabels = {
        query_match: 'search match',
        cross_cluster: 'cross-cluster connection',
        cluster_member: 'cluster membership',
        similarity: 'semantic similarity',
        multi_hop: 'multi-hop connection',
        organize: 'organize suggestion'
      };
      const kindLabel = /** @type {any} */ (kindLabels)[kind] || 'connection';
      const similarity = edge.data?.similarity;
      const scoreStr = similarity > 0 ? ` (${Math.round(similarity * 100)}% similar)` : '';
      setGraphStatus(`${kindLabel}: ${sourceLabel} ↔ ${targetLabel}${scoreStr}`);
    },
    [graphActions]
  );

  // ============================================================================
  // Computed values
  // ============================================================================

  // Avoid recreating ReactFlow props on every render; unstable refs can trigger StoreUpdater loops.
  // CRITICAL: Only create new objects when selection or node data actually changes
  const rfNodes = useMemo(() => {
    // This allows toggling visibility without losing data
    const visibleNodes = showClusters
      ? nodes
      : nodes.filter((/** @type {any} */ n) => n.data?.kind !== 'cluster');

    return visibleNodes.map((/** @type {any} */ n) => {
      const isSelected = n.id === selectedNodeId;
      // Only create new object if selection state actually changed
      // Preserve node reference when possible to prevent unnecessary ReactFlow updates
      const currentSelected = n.selected === true || n.selected === false ? n.selected : false;
      if (currentSelected === isSelected) {
        // Selection hasn't changed, return node as-is to preserve reference stability
        // This prevents ReactFlow StoreUpdater from detecting false changes
        return n;
      }
      // Selection changed, create new object with updated selected state
      return {
        ...n,
        selected: isSelected
      };
    });
  }, [nodes, selectedNodeId, showClusters]);

  const visibleNodeIds = useMemo(() => {
    if (showClusters) return null;
    return new Set(
      nodes
        .filter((/** @type {any} */ node) => node.data?.kind !== 'cluster')
        .map((/** @type {any} */ node) => node.id)
    );
  }, [nodes, showClusters]);

  // Split into baseEdges (expensive, no hover deps) and rfEdges (lightweight hover overlay)
  const baseEdges = useMemo(() => {
    const filtered =
      showClusters || !visibleNodeIds
        ? edges
        : edges.filter(
            (/** @type {any} */ e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target)
          );

    let styledEdges = filtered;

    // Bridge overlay: dim non-bridge edges when showing cluster bridges only
    if (bridgeOverlayEnabled && showClusters) {
      styledEdges = filtered.map((/** @type {any} */ edge) => {
        const isBridge = edge.data?.kind === 'cross_cluster';
        return {
          ...edge,
          style: {
            ...edge.style,
            opacity: isBridge ? 0.9 : 0.15
          },
          data: {
            ...edge.data,
            showEdgeLabels: Boolean(isBridge)
          }
        };
      });
    }

    return applyParallelEdgeOffsets(styledEdges);
  }, [edges, visibleNodeIds, showClusters, bridgeOverlayEnabled]);

  const graphReadabilityProfile = useMemo(() => {
    const nodeCount = rfNodes.length;
    const edgeCount = baseEdges.length;
    const edgePerNode = edgeCount / Math.max(nodeCount, 1);

    const isSmall =
      nodeCount <= SMALL_GRAPH_NODE_THRESHOLD && edgeCount <= SMALL_GRAPH_EDGE_THRESHOLD;
    const isDense =
      nodeCount >= DENSE_GRAPH_NODE_THRESHOLD ||
      edgeCount >= DENSE_GRAPH_EDGE_THRESHOLD ||
      (nodeCount >= SMALL_GRAPH_NODE_THRESHOLD && edgePerNode >= DENSE_GRAPH_EDGE_RATIO_THRESHOLD);

    return { nodeCount, edgeCount, isSmall, isDense };
  }, [rfNodes, baseEdges]);

  const rfEdges = useMemo(() => {
    let edgesForRender = baseEdges;

    // hoveredClusterId + hasHoveredCluster which could desync and permanently
    // hide cross-cluster edges.
    if (hoveredClusterId && showClusters && !bridgeOverlayEnabled) {
      const hoveredId = hoveredClusterId;
      edgesForRender = baseEdges.map((edge) => {
        if (edge.data?.kind !== 'cross_cluster') return edge;
        const isConnected = edge.source === hoveredId || edge.target === hoveredId;
        const targetOpacity = isConnected ? 0.8 : 0.1;
        const currentOpacity = edge.style?.opacity ?? 1;
        if (currentOpacity === targetOpacity) return edge;
        return {
          ...edge,
          style: {
            ...edge.style,
            opacity: targetOpacity
          },
          className: isConnected
            ? edge.className?.replace('opacity-0', 'opacity-100') || edge.className
            : edge.className?.replace('opacity-100', 'opacity-0') || edge.className
        };
      });
    }

    let suppressEdgeLabelsForZoom = false;
    let readabilityOpacityCap = null;
    if (zoomBucket === 'far') {
      suppressEdgeLabelsForZoom = true;
      readabilityOpacityCap = graphReadabilityProfile.isDense ? 0.4 : 0.5;
    } else if (zoomBucket === 'mid') {
      if (graphReadabilityProfile.isSmall) {
        suppressEdgeLabelsForZoom = false;
        readabilityOpacityCap = null;
      } else if (graphReadabilityProfile.isDense) {
        suppressEdgeLabelsForZoom = true;
        readabilityOpacityCap = 0.6;
      } else {
        suppressEdgeLabelsForZoom = false;
        readabilityOpacityCap = 0.75;
      }
    }

    if (!suppressEdgeLabelsForZoom && readabilityOpacityCap === null) {
      return edgesForRender;
    }

    let changed = false;
    const adjusted = edgesForRender.map((edge) => {
      const kind = edge.data?.kind;
      const shouldSoftenEdge =
        readabilityOpacityCap !== null &&
        (kind === 'similarity' || kind === 'knowledge' || kind === 'cross_cluster');

      const currentOpacity = edge.style?.opacity;
      const nextOpacity = shouldSoftenEdge
        ? Math.min(typeof currentOpacity === 'number' ? currentOpacity : 1, readabilityOpacityCap)
        : currentOpacity;

      const currentShowLabels = edge.data?.showEdgeLabels ?? true;
      const nextShowLabels = suppressEdgeLabelsForZoom ? false : currentShowLabels;

      const needsStyleUpdate = nextOpacity !== currentOpacity;
      const needsDataUpdate = nextShowLabels !== currentShowLabels;
      if (!needsStyleUpdate && !needsDataUpdate) return edge;

      changed = true;
      return {
        ...edge,
        ...(needsStyleUpdate
          ? {
              style: {
                ...edge.style,
                opacity: nextOpacity
              }
            }
          : {}),
        ...(needsDataUpdate
          ? {
              data: {
                ...edge.data,
                showEdgeLabels: nextShowLabels
              }
            }
          : {})
      };
    });

    return changed ? adjusted : edgesForRender;
  }, [
    baseEdges,
    hoveredClusterId,
    showClusters,
    bridgeOverlayEnabled,
    zoomBucket,
    graphReadabilityProfile
  ]);

  const rfFitViewOptions = useMemo(() => getDefaultGraphFitViewOptions(), []);
  const rfDefaultViewport = useMemo(() => ({ x: 0, y: 0, zoom: 1 }), []);
  const rfProOptions = useMemo(() => ({ hideAttribution: true }), []);

  const miniMapPalette = useMemo(
    () => resolveGraphMiniMapPalette(),

    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedTheme]
  );
  const miniMapNodeColor = useCallback(
    (/** @type {any} */ n) => getGraphMiniMapNodeColor(n, miniMapPalette),
    [miniMapPalette]
  );

  // Helper to compute visible filters as chips
  const activeClusterFilterChips = useMemo(() => {
    const chips = [];
    const conf = clusterFilters.confidence || [];
    if (!conf.includes('high') || !conf.includes('medium') || !conf.includes('low')) {
      chips.push(`Conf: ${conf.join(', ')}`);
    }
    if ((clusterFilters.minSize || 1) > 1) chips.push(`Min ${clusterFilters.minSize}`);
    if (clusterFilters.fileType && clusterFilters.fileType !== 'all') {
      chips.push(`Type: ${clusterFilters.fileType}`);
    }
    if (clusterFilters.search) chips.push(`Search: ${clusterFilters.search}`);
    return chips;
  }, [clusterFilters]);

  const activeGraphFilterChips = useMemo(() => {
    const chips = [];
    const types = activeFilters.types || [];
    const conf = activeFilters.confidence || [];
    if (types.length > 0 && types.length < 4) {
      chips.push(`Nodes: ${types.join(', ')}`);
    }
    if (conf.length > 0 && conf.length < 3) {
      chips.push(`Conf: ${conf.join(', ')}`);
    }
    const trimmedWithinQuery = withinQuery.trim();
    if (trimmedWithinQuery) {
      chips.push(`Within: ${trimmedWithinQuery}`);
    }
    if (focusNodeId) {
      chips.push(`Focus: ${focusDepth} hop${focusDepth === 1 ? '' : 's'}`);
    }
    return chips;
  }, [activeFilters, withinQuery, focusNodeId, focusDepth]);

  const hasGraphFilterIndicators = useMemo(
    () =>
      bridgeOverlayEnabled ||
      clusterMode !== DEFAULT_CLUSTER_MODE ||
      activeClusterFilterChips.length > 0 ||
      activeGraphFilterChips.length > 0,
    [bridgeOverlayEnabled, clusterMode, activeClusterFilterChips, activeGraphFilterChips]
  );
  const activeSidebarFilterCount =
    (clusterMode !== DEFAULT_CLUSTER_MODE ? 1 : 0) +
    (bridgeOverlayEnabled ? 1 : 0) +
    activeClusterFilterChips.length +
    activeGraphFilterChips.length;

  const showEmptyBanner =
    hasLoadedStats && stats && typeof stats.files === 'number' && stats.files === 0 && !error;
  // Use fresh metadata from the vector DB when available (for current file paths after moves)
  const selectedPath = freshMetadata?.path || selectedNode?.data?.path || '';
  const selectedLabel = freshMetadata?.name || selectedNode?.data?.label || selectedNode?.id || '';
  const selectedKind = selectedNode?.data?.kind || '';
  const nodeLabelById = useMemo(() => {
    const map = new Map();
    nodes.forEach((/** @type {any} */ n) => map.set(n.id, n?.data?.label || n?.id || 'Unknown'));
    return map;
  }, [nodes]);
  const selectedNodeEdges = useMemo(() => {
    if (!selectedNode?.id) return [];
    return edges.filter(
      (/** @type {any} */ e) => e.source === selectedNode.id || e.target === selectedNode.id
    );
  }, [edges, selectedNode?.id]);
  const selectedNodeConnectionCount = selectedNodeEdges.length;
  const selectedNodeNeighbors = useMemo(() => {
    if (!selectedNode?.id || selectedNodeEdges.length === 0) return [];
    // Use ref to avoid recomputing when only node positions change (layout).
    // The ref is always kept in sync via the nodeById useMemo above.
    const lookup = nodeByIdRef.current;
    const neighborsMap = new Map();
    selectedNodeEdges.forEach((/** @type {any} */ edge) => {
      const otherId = edge.source === selectedNode.id ? edge.target : edge.source;
      if (!otherId) return;
      const similarity = edgeStrengthScore(edge.data);
      const existing = neighborsMap.get(otherId);
      if (existing) {
        if (
          typeof similarity === 'number' &&
          (typeof existing.similarity !== 'number' || similarity > existing.similarity)
        ) {
          neighborsMap.set(otherId, { ...existing, similarity });
        }
        return;
      }
      const otherNode = lookup.get(otherId);
      neighborsMap.set(otherId, {
        id: otherId,
        label: otherNode?.data?.label || otherNode?.id || 'Unknown',
        kind: otherNode?.data?.kind || 'file',
        similarity
      });
    });
    return Array.from(neighborsMap.values());
  }, [selectedNode?.id, selectedNodeEdges, nodeByIdRef]);
  const selectedNodeWhyConnections = useMemo(() => {
    if (!selectedNode?.id || selectedNodeEdges.length === 0) return [];
    return selectedNodeEdges
      .map((/** @type {any} */ edge) => {
        const targetId = edge.source === selectedNode.id ? edge.target : edge.source;
        return {
          edgeId: edge.id,
          targetId,
          targetLabel: nodeLabelById.get(targetId) || targetId || 'Unknown',
          similarity: edgeStrengthScore(edge?.data),
          ...getConnectionReason(edge)
        };
      })
      .sort(
        (/** @type {any} */ a, /** @type {any} */ b) => (b.similarity || 0) - (a.similarity || 0)
      );
  }, [nodeLabelById, selectedNode?.id, selectedNodeEdges]);
  const displayedSelectedNodeWhyConnections = useMemo(
    () => selectedNodeWhyConnections.slice(0, WHY_CONNECTIONS_DISPLAY_LIMIT),
    [selectedNodeWhyConnections]
  );
  const hiddenSelectedNodeConnectionsCount = Math.max(
    0,
    selectedNodeWhyConnections.length - displayedSelectedNodeWhyConnections.length
  );
  const selectedNodeHeroConnectionText = useMemo(() => {
    if (selectedKind !== 'file') return '';
    const top = selectedNodeWhyConnections[0];
    if (!top) return '';
    const score = Math.round((top.similarity || 0) * 100);
    return `${selectedLabel || 'This file'} is most strongly connected to ${top.targetLabel} (${score}% related) because ${String(top.detail || top.label || 'they share context').replace(/\.$/, '')}.`;
  }, [selectedKind, selectedLabel, selectedNodeWhyConnections]);

  // Cluster-specific derived data
  const selectedClusterInfo = useMemo(() => {
    if (selectedKind !== 'cluster' || !selectedNode) return null;
    const neighborEdges = edges.filter(
      (/** @type {any} */ e) =>
        e.data?.kind === 'cross_cluster' &&
        (e.source === selectedNode.id || e.target === selectedNode.id)
    );
    const neighborIds = new Set(
      neighborEdges.map((/** @type {any} */ e) =>
        e.source === selectedNode.id ? e.target : e.source
      )
    );
    const neighborNodes = rfNodes.filter((/** @type {any} */ n) => neighborIds.has(n.id));
    const bridges = neighborEdges.map((/** @type {any} */ edge) => ({
      id: edge.id,
      similarity: edge.data?.similarity || 0,
      bridgeCount: edge.data?.bridgeCount || 0,
      sharedTerms: sanitizeSemanticTerms(edge.data?.sharedTerms, { maxTerms: 4, minLength: 2 }),
      targetId: edge.source === selectedNode.id ? edge.target : edge.source,
      targetLabel: neighborNodes.find(
        (/** @type {any} */ n) =>
          n.id === (edge.source === selectedNode.id ? edge.target : edge.source)
      )?.data?.label,
      bridgeFiles: edge.data?.bridgeFiles || []
    }));
    return {
      bridges,
      neighbors: neighborNodes
    };
  }, [edges, rfNodes, selectedKind, selectedNode]);

  const handleMoveFiles = useCallback(
    async (/** @type {any} */ files, /** @type {any} */ destination) => {
      try {
        const operations = files.map((/** @type {any} */ f) => ({
          type: 'move',
          source: f.path || f.id,
          destination: joinPath(destination, safeBasename(f.path || f.id))
        }));

        const result = await window.electronAPI.files.organize(operations);
        if (result.success) {
          refreshStats();
          // Remove moved files from triage list
          setTriageFiles((prev) =>
            prev.filter(
              (f) => !files.find((/** @type {any} */ mf) => (mf.path || mf.id) === (f.path || f.id))
            )
          );
        }
      } catch (error) {
        logger.error('Failed to move files', {
          error: error?.message,
          stack: error?.stack
        });
        // Use the shared error mapper rather than raw error.message, which can
        // expose internal paths or stack fragments. Mapper falls back to the
        // raw message when no signature matches, so detail isn't lost — just
        // sanitized for known error shapes.
        const { message } = mapErrorToNotification({ error, operationType: 'Move files' });
        setError(message);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshStats, setTriageFiles]
  );

  const handleResolveDuplicates = useCallback(
    async (/** @type {any} */ resolutions) => {
      try {
        const filesToDelete = resolutions.flatMap((/** @type {any} */ r) =>
          r.delete.map((/** @type {any} */ f) => f.path || f.id).filter(Boolean)
        );
        if (filesToDelete.length === 0) return;

        const tiers = new Set(resolutions.map((/** @type {any} */ r) => r.tier).filter(Boolean));
        const summary = {
          label: 'Delete duplicates',
          tier: tiers.size === 1 ? [...tiers][0] : 'mixed'
        };

        // Route through the new tiered trash handler: shell.trashItem + one
        // batched undo entry, rather than per-file fs.unlink.
        const result = await window.electronAPI.embeddings.trashDuplicates({
          paths: filesToDelete,
          summary
        });

        if (!result) {
          setError('Failed to resolve duplicates: no response from main process');
          return;
        }

        const trashedPaths = (result.trashed || []).map((/** @type {any} */ t) => t.path);
        if (result.failed?.length) {
          logger.warn('Some duplicates could not be trashed', {
            failed: result.failed
          });
          setError(
            `Trashed ${trashedPaths.length} of ${filesToDelete.length}. ` +
              `${result.failed.length} failed — see logs for details.`
          );
        }

        // Remove successfully-trashed file nodes from the live graph.
        const deletedIdSet = new Set(trashedPaths);
        graphActions.setNodes((/** @type {any} */ prev) =>
          prev.filter(
            (/** @type {any} */ n) => !deletedIdSet.has(n.id) && !deletedIdSet.has(n.data?.path)
          )
        );
        graphActions.setEdges((/** @type {any} */ prev) =>
          prev.filter(
            (/** @type {any} */ e) => !deletedIdSet.has(e.source) && !deletedIdSet.has(e.target)
          )
        );

        refreshStats();
        handleFindDuplicates();
      } catch (error) {
        logger.error('Failed to resolve duplicates', {
          error: error?.message,
          stack: error?.stack
        });
        const { message } = mapErrorToNotification({
          error,
          operationType: 'Resolve duplicates'
        });
        setError(message);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshStats, handleFindDuplicates, graphActions]
  );

  const handleOpenTriage = useCallback(async () => {
    const clusterNodes = clusterInsights.clusterNodes || [];
    const scatteredClusters = clusterNodes.filter(
      (/** @type {any} */ n) => !n.data?.dominantFolderName
    );

    if (scatteredClusters.length === 0) {
      setGraphStatus('No scattered files found.');
      return;
    }

    setGraphStatus('Loading scattered files...');

    try {
      const allFiles = [];
      for (const cluster of scatteredClusters) {
        const clusterId = parseInt(cluster.id.replace('cluster:', ''), 10);
        if (isNaN(clusterId)) continue;

        const result = await window.electronAPI.embeddings.getClusterMembers(clusterId);
        if (result.success && result.members) {
          allFiles.push(
            ...result.members.map((/** @type {any} */ m) => ({
              id: m.id,
              path: getMetadataPath(m?.metadata || {}, m.id) || m.id,
              name: getMetadataName(
                m?.metadata || {},
                getMetadataPath(m?.metadata || {}, m.id),
                m.id
              ),
              size: m.metadata?.size
            }))
          );
        }
      }

      // Deduplicate by path
      const uniqueFiles = Array.from(new Map(allFiles.map((f) => [f.path, f])).values());

      setTriageFiles(uniqueFiles);
      setIsTriageModalOpen(true);
      setGraphStatus('');
    } catch (e) {
      logger.error('Failed to load scattered files', {
        error: e?.message,
        stack: e?.stack
      });
      setGraphStatus('Failed to load scattered files');
    }
  }, [clusterInsights.clusterNodes, setGraphStatus, setIsTriageModalOpen, setTriageFiles]);

  const handleOrgFindingClick = useCallback(
    (/** @type {any} */ findingKey) => {
      if (findingKey === 'duplicates') {
        handleFindDuplicates();
        setIsDuplicateModalOpen(true);
        return;
      }
      if (findingKey === 'isolated') {
        setShowClusters(true);
        setBridgeOverlayEnabled(false);
        setActiveFilters((prev) => ({ ...prev, types: ['cluster'] }));
        loadClustersRef.current?.();
        return;
      }
      if (findingKey === 'unmapped' || findingKey === 'scattered') {
        handleOpenTriage();
        return;
      }
    },
    [
      handleFindDuplicates,
      handleOpenTriage,
      loadClustersRef,
      setActiveFilters,
      setBridgeOverlayEnabled,
      setIsDuplicateModalOpen,
      setShowClusters
    ]
  );

  // InsightDock tile click: surface the matching insight in the left
  // "What's interesting" panel. The dock shows counts at a glance; the panel
  // hosts the actionable cards, so every tile routes there for follow-through.
  const handleDockStatClick = useCallback(
    (/** @type {any} */ statKey) => {
      dispatch(setGraphInsightsSection('insights'));
      if (statKey === 'clusters') {
        if (!showClusters) {
          loadClustersRef.current?.();
        }
        setBridgeOverlayEnabled(false);
        return;
      }
      if (statKey === 'bridges') {
        if (!showClusters) {
          loadClustersRef.current?.();
        }
        setBridgeOverlayEnabled(true);
        if (clusterInsights.crossEdges.length > 0) {
          setIsBridgeModalOpen(true);
        }
        return;
      }
      if (statKey === 'scattered') {
        if (!showClusters) {
          loadClustersRef.current?.();
        }
        setBridgeOverlayEnabled(false);
        if (scatteredFileIds.length > 0) {
          handleOpenTriage();
        }
        return;
      }
      if (statKey === 'duplicates') {
        handleFindDuplicates();
        setIsDuplicateModalOpen(true);
      }
    },
    [
      dispatch,
      showClusters,
      handleFindDuplicates,
      clusterInsights.crossEdges.length,
      scatteredFileIds.length,
      handleOpenTriage,
      loadClustersRef,
      setBridgeOverlayEnabled,
      setIsBridgeModalOpen,
      setIsDuplicateModalOpen
    ]
  );

  const handleDockHealthClick = useCallback(() => {
    dispatch(setGraphInsightsSection('insights'));
    if (dockHealthScrollRafRef.current != null) {
      cancelAnimationFrame(dockHealthScrollRafRef.current);
    }
    // Defer the scroll one frame so the accordion section has expanded and the
    // health card's ref is laid out before we scroll it into view.
    dockHealthScrollRafRef.current = requestAnimationFrame(() => {
      dockHealthScrollRafRef.current = null;
      organizationalHealthRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, dockHealthScrollRafRef]);

  // Reset related-cluster UI when selection changes to avoid "sticky" expansion noise
  useEffect(() => {
    // Clear per-bridge expansion state whenever the selected node changes
    setExpandedRelatedClusters({});

    const count = selectedClusterInfo?.bridges?.length || 0;
    // Progressive disclosure: auto-collapse when there are many related clusters
    setIsRelatedClustersOpen(count > 0 && count <= 2);
  }, [
    selectedNodeId,
    selectedClusterInfo?.bridges?.length,
    setExpandedRelatedClusters,
    setIsRelatedClustersOpen
  ]);

  return {
    activeClusterFilterChips,
    activeFilters,
    activeFindings,
    activeGraphFilterChips,
    activeSidebarFilterCount,
    addMode,
    adjacencyByNode,
    applyEdgeUiPrefs,
    applyLayout,
    autoLayout,
    baseEdges,
    bridgeOverlayEnabled,
    closeContextMenu,
    clusterFilters,
    clusterFiltersRef,
    clusterInsights,
    clusterMode,
    clusterModeRef,
    clusterRefreshTimeoutRef,
    clustersRequestCounterRef,
    contextMenu,
    debouncedWithinQuery,
    displayedSelectedNodeWhyConnections,
    dockHealthScrollRafRef,
    duplicateGroups,
    duplicateSummary,
    edgeTooltipsEnabled,
    edgeTooltipsRef,
    edges,
    edgesRef,
    effectiveShowEdgeLabels,
    expandCluster,
    expandClusterRef,
    expandFromSelected,
    expandFromSelectedRef,
    expandedRelatedClusters,
    fileNodeIds,
    focusDepth,
    focusGraphNode,
    focusNode,
    focusNodeId,
    formatDateLabel,
    freshMetadata,
    freshMetadataRequestCounterRef,
    getClusterDisplayLabel,
    getNodesInFocus,
    graphActions,
    graphActionsContextValue,
    graphContainerRef,
    graphDropRequestCounterRef,
    graphNotes,
    graphReadabilityProfile,
    graphSearchRequestCounterRef,
    graphStatus,
    graphStatusTimerRef,
    graphVisualizationRemountKey,
    handleApplyTags,
    handleClearFocus,
    handleClusterExpand,
    handleCollapseAllClusters,
    handleCreateSmartFolderFromCluster,
    handleDockHealthClick,
    handleDockStatClick,
    handleDragLeave,
    handleDragOver,
    handleExpandAllClusters,
    handleExportFileList,
    handleFileDrop,
    handleFindDuplicates,
    handleGoToDiscover,
    handleGraphMove,
    handleGroupFiles,
    handleLoadGraph,
    handleMoveAllToFolder,
    handleMoveFiles,
    handleOpenAllFilesInCluster,
    handleOpenSettings,
    handleOpenTriage,
    handleOrgFindingClick,
    handleReactFlowError,
    handleRenameCluster,
    handleResolveDuplicates,
    handleSaveGraph,
    handleSearchWithinCluster,
    handleTagCluster,
    handleToggleFilter,
    hasAutoDisabledEdgeLabels,
    hasAutoDisabledTooltips,
    hasAutoLoadedClusters,
    hasGraphFilterIndicators,
    hiddenSelectedNodeConnectionsCount,
    hopCount,
    hoveredClusterId,
    insightBridgeCards,
    insightClusterNodes,
    insightSummary,
    insightSurpriseConnections,
    isBridgeModalOpen,
    isComputingClusters,
    isDownloadsTriageOpen,
    isDragOver,
    isDuplicateModalOpen,
    isGraphMaximized,
    isLayouting,
    isLoadingMetadata,
    isRelatedClustersOpen,
    isTagModalOpen,
    isTriageModalOpen,
    lastClustersRef,
    lastCrossClusterEdgesRef,
    lastDuplicateFileCountRef,
    lastVectorDbStatusRef,
    loadClusters,
    loadClustersRef,
    metadataCacheRef,
    miniMapNodeColor,
    miniMapPalette,
    moveFilesToChosenFolder,
    nodeByIdRef,
    nodeLabelById,
    nodes,
    nodesRef,
    noticeTimerRef,
    onEdgeClick,
    onNodeClick,
    onNodeContextMenu,
    onNodeDoubleClick,
    onNodeMouseEnter,
    onNodeMouseLeave,
    onNodesChange,
    openBridgeAnalysis,
    organizationalHealth,
    performanceNotice,
    reactFlowInstance,
    relatedPanel,
    renderClustersToGraph,
    resetGraphFilters,
    rfDefaultViewport,
    rfEdges,
    rfFitViewOptions,
    rfNodes,
    rfProOptions,
    runGraphSearch,
    scatteredFileIds,
    searchWithinScope,
    selectedClusterForTagging,
    selectedClusterInfo,
    selectedKind,
    selectedLabel,
    selectedNode,
    selectedNodeConnectionCount,
    selectedNodeEdges,
    selectedNodeHeroConnectionText,
    selectedNodeId,
    selectedNodeNeighbors,
    selectedNodeWhyConnections,
    selectedPath,
    setActiveFilters,
    setAddMode,
    setAutoLayout,
    setBridgeOverlayEnabled,
    setClusterFilters,
    setClusterMode,
    setContextMenu,
    setDebouncedWithinQuery,
    setDuplicateGroups,
    setDuplicateSummary,
    setExpandedRelatedClusters,
    setFocusDepth,
    setFocusNodeId,
    setFreshMetadata,
    setGraphNotes,
    setGraphStatus,
    setGraphVisualizationRemountKey,
    setHopCount,
    setHoveredClusterId,
    setIsBridgeModalOpen,
    setIsComputingClusters,
    setIsDownloadsTriageOpen,
    setIsDragOver,
    setIsDuplicateModalOpen,
    setIsGraphMaximized,
    setIsLayouting,
    setIsLoadingMetadata,
    setIsRelatedClustersOpen,
    setIsTagModalOpen,
    setIsTriageModalOpen,
    setPerformanceNotice,
    setRelatedPanel,
    setSearchWithinScope,
    setSelectedClusterForTagging,
    setShouldFocusWithinGraphInput,
    setShowAdvancedFilters,
    setShowClearConfirm,
    setShowClusters,
    setShowEdgeLabels,
    setShowTourManually,
    setTriageFiles,
    setWithinQuery,
    setZoomBucket,
    setZoomLevel,
    shouldFocusWithinGraphInput,
    showAdvancedFilters,
    showClearConfirm,
    showClusters,
    showEdgeLabels,
    showEdgeLabelsRef,
    showEmptyBanner,
    showPerformanceNotice,
    showTourManually,
    sortClustersForMode,
    syncGraphZoomFromViewport,
    toggleSidebarSection,
    triageFiles,
    upsertFileNode,
    userHasExpandedRef,
    visibleNodeIds,
    withinQuery,
    withinReqRef,
    withinRequestCounterRef,
    zoomBucket,
    zoomBucketRef
  };
}
