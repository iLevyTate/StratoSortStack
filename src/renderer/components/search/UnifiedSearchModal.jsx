import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import '@xyflow/react/dist/style.css';
import { AlertTriangle, CalendarDays, Network, List, MessageSquare, Orbit } from 'lucide-react';

import Modal, { ConfirmModal } from '../ui/Modal';
import TriageModal from '../organize/TriageModal';
import DuplicateResolutionModal from '../organize/DuplicateResolutionModal';
import BridgeAnalysisModal from './BridgeAnalysisModal';
import RelatedDocumentsPanel from './RelatedDocumentsPanel';
import DownloadsTriageView from '../triage/DownloadsTriageView';
import TagClusterModal from '../organize/TagClusterModal';
import { ModalLoadingOverlay } from '../ui/LoadingSkeleton';
import { StateMessage } from '../ui';
import { getFileCategory } from '../ui/FileIcon';
import { createLogger } from '../../../shared/logger';
import { isGraphViewEnabled } from '../../../shared/featureFlags';
import { safeBasename, safeDirname } from '../../../shared/memberPathUtils';
import { makeQueryNodeId, defaultNodePosition } from '../../utils/graphUtils';
import normalizeList from '../../utils/normalizeList';
import { sanitizeGraphMetadataTerms } from '../../utils/semanticTerms';
import { debouncedElkLayout, cancelPendingLayout } from '../../utils/elkLayout';
import { useGraphKeyboardNav, useFileActions } from '../../hooks';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { isSimpleExperienceMode } from '../../../shared/experienceMode';
import { setGraphInsightsSection, GRAPH_INSIGHTS_SECTION_KEYS } from '../../store/slices/uiSlice';
// InsightDock: the always-visible headline strip above the canvas. Surfaces the
// most useful insights (clusters, bridges, near-dupes, triage, health) at a
// glance; clicking a tile opens the matching action in the left "What's
// interesting" panel so every insight still has a single home for actions.
import GraphTour from './GraphTour';
import TabButton from './TabButton';
import IndexHealthBanner from './IndexHealthBanner';
import StatsDisplay from './StatsDisplay';
import EmptyEmbeddingsBanner from './EmptyEmbeddingsBanner';
import { getScrollBehavior } from '../../utils/motionPreferences';
import { isTopOverlay } from '../../utils/overlayStack';
import { nextRequestId, isCurrentRequest } from '../../utils/requestGuard';
import { UI_VIRTUALIZATION } from '../../../shared/constants';
import {
  normalizeGraphPathKey,
  getMetadataPath,
  getMetadataName,
  nodeDeduplicationKey,
  buildRecommendationGraph,
  getFileExtension
} from './utils';

import { useNotification } from '../../contexts/NotificationContext';
import { isEditableTarget } from '../../utils/isEditableTarget';
import { useSearchModalStats } from './hooks/useSearchModalStats';
import { useSearchTab } from './hooks/useSearchTab';
import { useChatTab } from './hooks/useChatTab';
import { useGraphTab } from './hooks/useGraphTab';
import { useMoveFilesToFolder } from './hooks/useMoveFilesToFolder';
import GraphTabContent from './GraphTabContent';
import AtlasTabContent from './AtlasTabContent';
import SearchTabContent from './SearchTabContent';
import ChatTabContent from './ChatTabContent';
import { useTimelineTab } from './useTimelineTab';
import TimelineTabContent from './TimelineTabContent';

const logger = createLogger('UnifiedSearchModal');

// React Flow #002: nodeTypes / edgeTypes must be module-scope references, not new objects
// or per-render hooks — see https://reactflow.dev/error#002
// Graph view constants + minimap helpers moved to graphViewConstants.js (§I 5b).
export {
  GRAPH_MINIMAP_STYLE,
  GRAPH_MINIMAP_MASK_COLOR,
  GRAPH_MINIMAP_MASK_STROKE_COLOR,
  resolveGraphMiniMapPalette,
  getGraphMiniMapNodeColor
} from './graphViewConstants';

const ENABLE_SEARCH_TRACE_LOGS = process.env.NODE_ENV === 'development';
// Layout spacing is adaptive (see elkLayout.js); undefined lets it choose.
const GRAPH_LAYOUT_SPACING = undefined;
const GRAPH_LAYER_SPACING = undefined;

// ============================================================================
// Main Component
// ============================================================================

export default function UnifiedSearchModal({
  isOpen,
  onClose,
  defaultTopK = 20,
  initialTab = 'search'
}) {
  const graphViewEnabled = useAppSelector((state) => isGraphViewEnabled(state?.ui?.settings));
  const simpleMode = useAppSelector((state) => isSimpleExperienceMode(state?.ui?.settings));
  const graphInsightsActiveKey = useAppSelector((s) => {
    const v = s.ui?.graphInsightsSection;
    // `null` means the user collapsed all accordion sections; do not coerce to default.
    return v === undefined ? 'insights' : v;
  });
  const sidebarSections = useMemo(() => {
    const next = Object.fromEntries(GRAPH_INSIGHTS_SECTION_KEYS.map((key) => [key, false]));
    if (graphInsightsActiveKey && GRAPH_INSIGHTS_SECTION_KEYS.includes(graphInsightsActiveKey)) {
      next[graphInsightsActiveKey] = true;
    }
    return next;
  }, [graphInsightsActiveKey]);
  // Tab state
  // Graph is currently feature-flagged off. If callers pass initialTab="graph",
  // ensure we still render the Search tab content instead of a blank body.
  const effectiveInitialTab = useMemo(
    () => (graphViewEnabled ? initialTab : initialTab === 'graph' ? 'search' : initialTab),
    [graphViewEnabled, initialTab]
  );
  const [activeTab, setActiveTab] = useState(effectiveInitialTab);
  // Keep Atlas mounted after first visit so EmbeddingView/WebGL is not torn
  // down on every tab switch (major source of click/rAF long-task noise).
  const [atlasMounted, setAtlasMounted] = useState(false);
  const isMountedRef = useRef(true);
  const layoutRequestCounterRef = useRef(0);
  const viewInGraphRafRef = useRef(null);
  const pendingInitialGraphTabRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      cancelAnimationFrame(viewInGraphRafRef.current);
    };
  }, []);

  // Track previous isOpen to detect modal open transitions
  const prevIsOpenRef = useRef(false);

  // Reset tabs only when modal opens (isOpen transitions from false to true)
  // Do NOT reset when effectiveInitialTab changes, as that would override
  // programmatic tab switches like "View in Graph"
  useEffect(() => {
    if (isOpen && !prevIsOpenRef.current) {
      // Modal just opened - reset to initial tab
      pendingInitialGraphTabRef.current = initialTab === 'graph' && !graphViewEnabled;
      setActiveTab(effectiveInitialTab);
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, effectiveInitialTab, graphViewEnabled, initialTab]);

  useEffect(() => {
    if (activeTab === 'atlas') setAtlasMounted(true);
  }, [activeTab]);

  useEffect(() => {
    if (!isOpen) setAtlasMounted(false);
  }, [isOpen]);

  useEffect(() => {
    if (!graphViewEnabled && (activeTab === 'graph' || activeTab === 'atlas')) {
      setActiveTab('search');
    }
  }, [activeTab, graphViewEnabled]);

  useEffect(() => {
    if (!isOpen || !graphViewEnabled || !pendingInitialGraphTabRef.current) return;
    if (activeTab !== 'search') return;
    pendingInitialGraphTabRef.current = false;
    setActiveTab('graph');
  }, [activeTab, graphViewEnabled, isOpen]);

  // Shared state
  const [error, setError] = useState('');

  // Search tab state
  // Search tab state + logic live in hooks/useSearchTab (§I Phase 3).
  const searchTab = useSearchTab({ isOpen, activeTab, defaultTopK, error, setError });
  const {
    query,
    setQuery,
    debouncedQuery,
    setDebouncedQuery,
    searchResults,
    setSearchResults,
    setSelectedSearchId,
    isSearching,
    queryMeta,
    searchMeta,
    bulkSelectedIds,
    setBulkSelectedIds,
    focusedResultIndex,
    setFocusedResultIndex,
    viewMode,
    selectedSearchResultPath,
    triggerSearchRefresh,
    resetSearchState
  } = searchTab;
  const [selectedDocumentDetails, setSelectedDocumentDetails] = useState(null);
  const [isLoadingDocumentDetails, setIsLoadingDocumentDetails] = useState(false);

  // Chat tab state
  const [recommendationMap, setRecommendationMap] = useState({});
  const [isLoadingRecommendations, setIsLoadingRecommendations] = useState(false);

  const { showSuccess, showError } = useNotification();

  // Chat preference hydration lives in useChatTab.

  // Graph tab state + logic live in hooks/useGraphTab (§I Phase 5). The
  // declarations below are modal-owned (cross-tab): shortcuts scoping,
  // details fetch, search->graph bridge, saved-graph rehydration, and
  // reset/close timers.
  const dispatch = useAppDispatch();
  const wasOpenRef = useRef(false);
  const modalContentRef = useRef(null);
  const convertSearchToGraphRef = useRef(null);
  const clusterActionRefs = useRef({});
  const lastFetchedDetailsPathRef = useRef(null);
  const detailsRequestCounterRef = useRef(0);
  const recommendationRequestCounterRef = useRef(0);
  const resultListRef = useRef(null);
  const organizationalHealthRef = useRef(null);
  const handleMoveAllToFolderRef = useRef(null);
  const graphFitViewTimeoutRef = useRef(null);
  const guideIntentLoadTimeoutRef = useRef(null);

  // File Actions Hook
  const { openFile, revealFile, copyPath } = useFileActions(setError);

  const {
    stats,
    statsUnavailable,
    isLoadingStats,
    hasLoadedStats,
    embeddingConfig,
    isRebuildingFolders,
    isRebuildingFiles,
    refreshStats,
    rebuildFolders,
    rebuildFiles
  } = useSearchModalStats({
    isOpen,
    setError,
    showSuccess,
    showError,
    // The search tab re-runs its query when files move/delete underneath it.
    onFileOperation: triggerSearchRefresh
  });

  // Chat tab state + logic live in hooks/useChatTab (§I Phase 4). The
  // graph bridge (handleUseSourcesInGraph) stays below — it writes graph state.
  const chatTab = useChatTab({ isOpen, searchResults, defaultTopK, openFile, setError });
  const {
    chatMessages,
    setChatMessages,
    setDocumentScope,
    handleChatSend,
    resetChatState,
    cancelChatStream
  } = chatTab;

  // Timeline tab (state + logic) — useTimelineTab (Task 5).
  const timelineTab = useTimelineTab({ isOpen, activeTab });
  const refreshTimeline = timelineTab.refresh;

  // When files are organized/moved (possibly elsewhere in the app), keep this
  // modal's derived data honest: remap the recommendation snapshot so newly
  // built graph nodes get the right folder, and refresh the Timeline so it
  // shows current locations instead of pre-move references. Attached even
  // while the modal is CLOSED (it stays mounted after first open): gating on
  // isOpen left stale recommendationMap keys for moves that happened while
  // closed — asymmetric with useGraphTab's always-attached node remap — so
  // nodes built after reopening missed their folder recommendation. The
  // handler is cheap (functional map update + a refresh that no-ops until
  // the timeline tab is next activated).
  useEffect(() => {
    const handleFileOperation = (/** @type {any} */ event) => {
      const detail = event?.detail || {};
      const operationType = detail.operationType || detail.operation;
      if (!operationType) return;

      if (operationType === 'move' || operationType === 'rename') {
        /** @type {Array<[string, string]>} */
        const pairs = [];
        if (
          Array.isArray(detail.files) &&
          Array.isArray(detail.destinations) &&
          detail.files.length === detail.destinations.length
        ) {
          detail.files.forEach((/** @type {any} */ oldPath, /** @type {number} */ i) =>
            pairs.push([oldPath, detail.destinations[i]])
          );
        } else {
          const oldPath = detail.filePath || detail.oldPath;
          const newPath = detail.destPath || detail.newPath;
          if (oldPath && newPath) pairs.push([oldPath, newPath]);
        }
        if (pairs.length > 0) {
          setRecommendationMap((/** @type {any} */ prev) => {
            let changed = false;
            const next = { ...prev };
            for (const [oldPath, newPath] of pairs) {
              if (oldPath in next) {
                delete next[oldPath];
                changed = true;
              }
              // Folder NAME, not the absolute dirname: every other producer
              // of recommendationMap stores smart-folder names, and the graph
              // groups/labels folder nodes by this raw string — a full path
              // here spawns a duplicate folder node labeled "C:\...\Finance"
              // next to the existing "Finance" node.
              const folder = safeBasename(safeDirname(newPath));
              if (folder) {
                next[newPath] = folder;
                changed = true;
              }
            }
            return changed ? next : prev;
          });
        }
      }

      // Move/rename/delete all change what the timeline should show.
      refreshTimeline();
    };
    window.addEventListener('file-operation-complete', handleFileOperation);
    return () => window.removeEventListener('file-operation-complete', handleFileOperation);
  }, [refreshTimeline]);

  // Graph tab (state + logic) — hooks/useGraphTab (§I Phase 5). Called early
  // so every later dep array can reference the destructured surface (TDZ).
  const graphTab = useGraphTab({
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
  });

  const {
    handleMoveFiles,
    handleResolveDuplicates,
    showEmptyBanner,
    edgeTooltipsEnabled,
    effectiveShowEdgeLabels,
    addMode,
    applyEdgeUiPrefs,
    autoLayout,
    closeContextMenu,
    clusterInsights,
    clusterRefreshTimeoutRef,
    contextMenu,
    duplicateGroups,
    edgeTooltipsRef,
    edges,
    edgesRef,
    expandClusterRef,
    expandFromSelectedRef,
    freshMetadata,
    graphActions,
    graphContainerRef,
    handleApplyTags,
    handleClusterExpand,
    handleCreateSmartFolderFromCluster,
    handleExportFileList,
    handleGoToDiscover,
    handleGroupFiles,
    handleMoveAllToFolder,
    handleOpenSettings,
    handleTagCluster,
    hasAutoDisabledEdgeLabels,
    hasAutoDisabledTooltips,
    hasAutoLoadedClusters,
    isBridgeModalOpen,
    isDownloadsTriageOpen,
    isDuplicateModalOpen,
    isGraphMaximized,
    isTagModalOpen,
    isTriageModalOpen,
    loadClustersRef,
    metadataCacheRef,
    nodes,
    nodesRef,
    reactFlowInstance,
    relatedPanel,
    selectedClusterForTagging,
    selectedNode,
    selectedNodeId,
    setAddMode,
    setAutoLayout,
    setDebouncedWithinQuery,
    setDuplicateGroups,
    setFocusDepth,
    setFocusNodeId,
    setGraphStatus,
    setHopCount,
    setHoveredClusterId,
    setIsBridgeModalOpen,
    setIsComputingClusters,
    setIsDownloadsTriageOpen,
    setIsDuplicateModalOpen,
    setIsGraphMaximized,
    setIsTagModalOpen,
    setIsTriageModalOpen,
    setPerformanceNotice,
    setRelatedPanel,
    setShowClearConfirm,
    setShowClusters,
    setShowTourManually,
    setWithinQuery,
    showClearConfirm,
    showEdgeLabelsRef,
    showTourManually,
    triageFiles
  } = graphTab;

  // ============================================================================
  // Chat Handlers
  // ============================================================================

  const buildSuggestionFiles = useCallback((results) => {
    if (!Array.isArray(results)) return [];
    return results
      .map((result) => {
        const metadata = result?.metadata || {};
        const path = getMetadataPath(metadata, result?.id) || result?.id || '';
        const name = getMetadataName(metadata, path, result?.id);
        if (!path) return null;

        return {
          path,
          name,
          extension: getFileExtension(name || path),
          analysis: {
            subject: metadata.subject,
            summary: metadata.summary,
            tags: metadata.tags || [],
            category: metadata.category,
            confidence: metadata.confidence
          }
        };
      })
      .filter(Boolean);
  }, []);

  const hydrateRecommendationMap = useCallback(async () => {
    const requestId = nextRequestId(recommendationRequestCounterRef);
    const files = buildSuggestionFiles(searchResults);
    const getBatchSuggestions = window?.electronAPI?.suggestions?.getBatchSuggestions;
    if (!files.length || typeof getBatchSuggestions !== 'function') {
      if (isMountedRef.current && isCurrentRequest(recommendationRequestCounterRef, requestId)) {
        setRecommendationMap({});
      }
      return;
    }

    // Limit batch size to prevent IPC timeouts
    const MAX_BATCH_SIZE = 50;
    const filesToProcess = files.slice(0, MAX_BATCH_SIZE);

    if (files.length > MAX_BATCH_SIZE) {
      logger.warn('[UnifiedSearchModal] Truncating recommendation request to avoid timeout', {
        total: files.length,
        processing: MAX_BATCH_SIZE
      });
    }

    if (isMountedRef.current && isCurrentRequest(recommendationRequestCounterRef, requestId)) {
      setIsLoadingRecommendations(true);
    }
    try {
      const response = await getBatchSuggestions(filesToProcess);
      if (!isMountedRef.current || !isCurrentRequest(recommendationRequestCounterRef, requestId)) {
        return;
      }
      if (!response?.success || !Array.isArray(response.groups)) {
        setRecommendationMap({});
        return;
      }

      const nextMap = {};
      response.groups.forEach((group) => {
        const groupFolder = group?.folder;
        const groupFiles = Array.isArray(group?.files) ? group.files : [];
        groupFiles.forEach((file) => {
          const filePath = file?.path;
          if (!filePath) return;
          nextMap[filePath] = file?.suggestion?.folder || groupFolder || '';
        });
      });

      setRecommendationMap(nextMap);
    } catch (recErr) {
      logger.debug('[Search] Recommendation lookup failed:', recErr?.message || recErr);
      if (isMountedRef.current && isCurrentRequest(recommendationRequestCounterRef, requestId)) {
        setRecommendationMap({});
      }
    } finally {
      if (isMountedRef.current && isCurrentRequest(recommendationRequestCounterRef, requestId)) {
        setIsLoadingRecommendations(false);
      }
    }
  }, [buildSuggestionFiles, searchResults]);

  useEffect(() => {
    if (!isOpen) return;
    hydrateRecommendationMap();
  }, [hydrateRecommendationMap, isOpen]);

  const handleUseSourcesInGraph = useCallback(
    async (sources) => {
      if (!graphViewEnabled || !Array.isArray(sources)) return;

      if (ENABLE_SEARCH_TRACE_LOGS) {
        logger.info('[KnowledgeOS] Open sources in graph', {
          sourceCount: sources.length
        });
      }

      const fileNodes = sources.map((source, idx) => {
        const sourcePath = source.path || source.metadata?.path || '';
        const suggestedFolder = recommendationMap[sourcePath] || '';
        return {
          id: source.fileId,
          type: 'fileNode',
          position: defaultNodePosition(idx),
          data: {
            kind: 'file',
            label: source.name || source.metadata?.name || source.fileId,
            path: sourcePath,
            score: source.score || 0,
            tags: sanitizeGraphMetadataTerms(source.tags || source.metadata?.tags, {
              maxTerms: 5
            }),
            entities: sanitizeGraphMetadataTerms(
              source.entities || source.metadata?.entities || source.metadata?.keyEntities,
              { maxTerms: 5 }
            ),
            dates: normalizeList(source.dates || source.metadata?.dates).slice(0, 3),
            suggestedFolder,
            category: getFileCategory(sourcePath),
            subject:
              source.subject ||
              source.metadata?.subject ||
              (suggestedFolder ? `Folder: ${suggestedFolder}` : '')
          },
          draggable: true
        };
      });

      const { folderNodes, edges: organizeEdges } = buildRecommendationGraph(fileNodes);
      setActiveTab('graph');
      const graphNodes = [...fileNodes, ...folderNodes];
      let graphEdges = [...organizeEdges];

      const fileIds = sources.map((s) => s.fileId).filter(Boolean);
      if (fileIds.length >= 2) {
        try {
          const simEdgesResp = await window.electronAPI?.embeddings?.getSimilarityEdges?.(fileIds, {
            threshold: 0.75,
            maxEdgesPerNode: 1
          });
          if (simEdgesResp?.success && Array.isArray(simEdgesResp.edges)) {
            const nodeDataMap = new Map();
            fileNodes.forEach((n) => {
              nodeDataMap.set(n.id, {
                id: n.id, // surfaced so edge tooltips can call onGroupFiles
                label: n.data?.label || '',
                tags: n.data?.tags || [],
                category: n.data?.category || '',
                subject: n.data?.subject || ''
              });
            });

            const similarityEdges = simEdgesResp.edges.map((edge) => ({
              id: edge.id,
              source: edge.source,
              target: edge.target,
              type: 'similarity',
              animated: false,
              data: {
                kind: 'similarity',
                similarity: edge.similarity,
                sourceData: nodeDataMap.get(edge.source) || {},
                targetData: nodeDataMap.get(edge.target) || {},
                showEdgeLabels: showEdgeLabelsRef.current,
                showEdgeTooltips: edgeTooltipsRef.current
              }
            }));

            if (similarityEdges.length > 0) {
              graphEdges = [...graphEdges, ...similarityEdges];
              if (ENABLE_SEARCH_TRACE_LOGS) {
                logger.info('[KnowledgeOS] Added similarity edges', {
                  edgeCount: similarityEdges.length
                });
              }
            }
          }
        } catch (simError) {
          logger.warn('[KnowledgeOS] Failed to fetch similarity edges for graph view', {
            error: simError?.message || String(simError)
          });
        }
      }

      if (autoLayout && graphNodes.length > 1) {
        try {
          const { nodes: layoutedNodes, edges: layoutedEdges } = await debouncedElkLayout(
            graphNodes,
            graphEdges,
            {
              direction: 'RIGHT',
              spacing: GRAPH_LAYOUT_SPACING,
              layerSpacing: GRAPH_LAYER_SPACING
            }
          );
          if (!isMountedRef.current) return;
          const finalEdges =
            layoutedEdges && layoutedEdges.length > 0
              ? applyEdgeUiPrefs(layoutedEdges)
              : graphEdges;
          graphActions.setGraph(layoutedNodes, finalEdges);
        } catch (layoutError) {
          if (!isMountedRef.current) return;
          logger.warn('[Graph] Layout from chat sources failed:', layoutError);
          graphActions.setGraph(graphNodes, applyEdgeUiPrefs(graphEdges));
        }
      } else {
        if (!isMountedRef.current) return;
        graphActions.setGraph(graphNodes, applyEdgeUiPrefs(graphEdges));
      }
    },
    [
      autoLayout,
      graphActions,
      recommendationMap,
      applyEdgeUiPrefs,
      graphViewEnabled,
      edgeTooltipsRef,
      showEdgeLabelsRef
    ]
  );

  // ============================================================================
  // Reset on open
  // ============================================================================

  useEffect(() => {
    if (!isOpen) {
      // Cancel any pending layout operations when modal closes
      cancelPendingLayout();
      hasAutoLoadedClusters.current = false;
      reactFlowInstance.current = null; // Clear ref to prevent memory leak
      // Tear down active chat stream resources to prevent post-unmount updates
      cancelChatStream();
      // Clear accumulated state to prevent memory buildup while modal is closed
      setSearchResults([]);
      setChatMessages([]);
      graphActions.setGraph([], []);
      setBulkSelectedIds(new Set());
      setDuplicateGroups([]);
      if (graphFitViewTimeoutRef.current) {
        clearTimeout(graphFitViewTimeoutRef.current);
        graphFitViewTimeoutRef.current = null;
      }
      if (guideIntentLoadTimeoutRef.current) {
        clearTimeout(guideIntentLoadTimeoutRef.current);
        guideIntentLoadTimeoutRef.current = null;
      }
      if (clusterRefreshTimeoutRef.current) {
        clearTimeout(clusterRefreshTimeoutRef.current);
        clusterRefreshTimeoutRef.current = null;
      }
      return () => {};
    }

    const isOpening = !wasOpenRef.current;
    if (isOpening) {
      if (ENABLE_SEARCH_TRACE_LOGS) {
        logger.info('[KnowledgeOS] Opened', {
          initialTab,
          effectiveInitialTab
        });
      }
      wasOpenRef.current = true;

      setActiveTab(effectiveInitialTab);
      setError('');
      // Stats state resets inside useSearchModalStats on open.
      resetSearchState();
      resetChatState();
      // Graph state
      graphActions.setGraph([], []);
      graphActions.selectNode(null);
      setAddMode(true);
      setIsGraphMaximized(false);
      // graphInsightsSection: keep Redux/persisted accordion (do not reset on every open).
      if (graphFitViewTimeoutRef.current) {
        clearTimeout(graphFitViewTimeoutRef.current);
        graphFitViewTimeoutRef.current = null;
      }
      if (guideIntentLoadTimeoutRef.current) {
        clearTimeout(guideIntentLoadTimeoutRef.current);
        guideIntentLoadTimeoutRef.current = null;
      }
      if (clusterRefreshTimeoutRef.current) {
        clearTimeout(clusterRefreshTimeoutRef.current);
        clusterRefreshTimeoutRef.current = null;
      }
      setWithinQuery('');
      setDebouncedWithinQuery('');
      setGraphStatus('');
      // Layout state
      setAutoLayout(true);
      setHoveredClusterId(null);
      setPerformanceNotice('');
      hasAutoDisabledEdgeLabels.current = false;
      hasAutoDisabledTooltips.current = false;
      // Multi-hop state
      setHopCount(1);
      // Clustering state
      setShowClusters(false);
      setIsComputingClusters(false);
      // Duplicates state
      setDuplicateGroups([]);
    }
    // Cleanup pending layouts and active streams on unmount
    return () => {
      cancelPendingLayout();
      cancelChatStream();
      if (graphFitViewTimeoutRef.current) {
        clearTimeout(graphFitViewTimeoutRef.current);
        graphFitViewTimeoutRef.current = null;
      }
      if (guideIntentLoadTimeoutRef.current) {
        clearTimeout(guideIntentLoadTimeoutRef.current);
        guideIntentLoadTimeoutRef.current = null;
      }
      if (clusterRefreshTimeoutRef.current) {
        clearTimeout(clusterRefreshTimeoutRef.current);
        clusterRefreshTimeoutRef.current = null;
      }
      graphActions.reset();
    };
  }, [
    isOpen,
    effectiveInitialTab,
    graphActions,
    initialTab,
    dispatch,
    resetSearchState,
    setBulkSelectedIds,
    setSearchResults,
    cancelChatStream,
    resetChatState,
    setChatMessages,
    clusterRefreshTimeoutRef,
    hasAutoDisabledEdgeLabels,
    hasAutoDisabledTooltips,
    hasAutoLoadedClusters,
    reactFlowInstance,
    setAddMode,
    setAutoLayout,
    setDebouncedWithinQuery,
    setDuplicateGroups,
    setGraphStatus,
    setHopCount,
    setHoveredClusterId,
    setIsComputingClusters,
    setIsGraphMaximized,
    setPerformanceNotice,
    setShowClusters,
    setWithinQuery
  ]);

  useEffect(() => {
    if (!isOpen) {
      if (wasOpenRef.current) {
        if (ENABLE_SEARCH_TRACE_LOGS) {
          logger.info('[KnowledgeOS] Closed');
        }
        wasOpenRef.current = false;
      }
      return;
    }
    if (ENABLE_SEARCH_TRACE_LOGS) {
      logger.info('[KnowledgeOS] Tab changed', { tab: activeTab });
    }
  }, [activeTab, isOpen]);

  // Prevents stale focus state when returning to search tab
  useEffect(() => {
    setFocusedResultIndex(-1);
  }, [activeTab, setFocusedResultIndex]);

  // Update edge visibility when toggle changes (uses derived effectiveShowEdgeLabels)
  useEffect(() => {
    graphActions.setEdges((prevEdges) => {
      let changed = false;
      const nextEdges = prevEdges.map((e) => {
        const currentLabels = e.data?.showEdgeLabels ?? true;
        const currentTooltips = e.data?.showEdgeTooltips ?? true;
        if (currentLabels === effectiveShowEdgeLabels && currentTooltips === edgeTooltipsEnabled) {
          return e;
        }
        changed = true;
        return {
          ...e,
          data: {
            ...e.data,
            showEdgeLabels: effectiveShowEdgeLabels,
            showEdgeTooltips: edgeTooltipsEnabled
          }
        };
      });
      return changed ? nextEdges : prevEdges;
    });
  }, [effectiveShowEdgeLabels, edgeTooltipsEnabled, graphActions]);

  // ============================================================================
  // Persistence & Notes
  // ============================================================================

  // ============================================================================
  // Shared: File Actions (defined early for keyboard shortcut dependency)
  // ============================================================================

  const convertSearchToGraph = useCallback(async () => {
    if (!graphViewEnabled) return;
    if (searchResults.length === 0) return;

    // Clear existing graph if not in add mode
    if (!addMode) {
      graphActions.setGraph([], []);
    }

    // Create query node
    const queryNodeId = makeQueryNodeId(debouncedQuery || 'search', Date.now());
    const queryNode = {
      id: queryNodeId,
      type: 'queryNode',
      position: { x: 40, y: 200 },
      data: {
        kind: 'query',
        label: debouncedQuery || 'Search results',
        resultCount: searchResults.length,
        searchMode: searchMeta?.mode || 'hybrid',
        fallback: searchMeta?.fallback || false,
        corrections: queryMeta?.corrections || null
      },
      draggable: true
    };

    // Create file nodes from search results (limit to defaultTopK to match search)
    const graphResults = searchResults.slice(0, defaultTopK);
    const fileNodes = graphResults.map((result, idx) => {
      const filePath = getMetadataPath(result, result?.id) || result?.id || '';
      const suggestedFolder = recommendationMap[filePath] || '';
      const displayName = getMetadataName(result, filePath, result?.id);

      return {
        id: result.id,
        type: 'fileNode',
        position: { x: 280, y: 40 + idx * 70 },
        data: {
          kind: 'file',
          label: displayName,
          path: filePath,
          score: result.score || 0,
          tags: sanitizeGraphMetadataTerms(result?.metadata?.tags || result?.metadata?.keywords, {
            maxTerms: 5
          }),
          entities: sanitizeGraphMetadataTerms(result?.metadata?.keyEntities, { maxTerms: 5 }),
          dates: normalizeList(result?.metadata?.dates).slice(0, 3),
          suggestedFolder,
          category: result?.metadata?.category || '',
          subject: result?.metadata?.subject || ''
        },
        draggable: true
      };
    });

    // Create edges from query to results
    const queryEdges = graphResults.map((result) => {
      return {
        id: `e:${queryNodeId}->${result.id}`,
        source: queryNodeId,
        target: result.id,
        type: 'queryMatch',
        data: {
          kind: 'query_match',
          score: result?.score || 0,
          matchDetails: result?.matchDetails || {},
          showEdgeLabels: showEdgeLabelsRef.current,
          showEdgeTooltips: edgeTooltipsRef.current
        }
      };
    });

    const { folderNodes, edges: organizeEdges } = buildRecommendationGraph(fileNodes);

    // Update graph state
    // When adding to graph, filter out cluster nodes to avoid clutter
    graphActions.setNodes((prev) => {
      const incoming = [queryNode, ...fileNodes, ...folderNodes];
      if (!addMode) return incoming;
      // Filter out cluster nodes from previous state - they don't mix well with search results
      const prevWithoutClusters = prev.filter(
        (n) => n.type !== 'clusterNode' && n.data?.kind !== 'cluster'
      );
      // Deduplicate by path for file nodes (same file can have different vector DB IDs)
      const existing = new Set(prevWithoutClusters.map(nodeDeduplicationKey));
      const newNodes = incoming.filter((n) => !existing.has(nodeDeduplicationKey(n)));
      return [...prevWithoutClusters, ...newNodes];
    });

    graphActions.setEdges((prev) => {
      const incomingEdges = [...queryEdges, ...organizeEdges];
      if (!addMode) return incomingEdges;
      // Filter out cluster-related edges when adding search results
      const prevWithoutClusterEdges = prev.filter(
        (e) => e.data?.kind !== 'cluster_member' && e.data?.kind !== 'cross_cluster'
      );
      const existing = new Set(prevWithoutClusterEdges.map((e) => e.id));
      const newEdges = incomingEdges.filter((e) => !existing.has(e.id));
      return [...prevWithoutClusterEdges, ...newEdges];
    });

    // Turn off cluster view when adding search results
    if (addMode) {
      setShowClusters(false);
    }

    // Switch to graph tab and collapse sidebar to maximize graph visibility
    setActiveTab('graph');
    dispatch(setGraphInsightsSection('insights'));
    setGraphStatus(`Converted ${fileNodes.length} results to graph`);

    // Apply layout
    if (autoLayout) {
      try {
        // If nodes/edges change during the async layout, we want to merge with
        // the CURRENT state, not the state at the time this function was created
        const currentNodes = nodesRef.current || [];
        const currentEdges = edgesRef.current || [];
        // Filter out cluster nodes when in add mode - they don't mix well with search results
        const nodesWithoutClusters = currentNodes.filter(
          (n) => n.type !== 'clusterNode' && n.data?.kind !== 'cluster'
        );
        const edgesWithoutClusters = currentEdges.filter(
          (e) => e.data?.kind !== 'cluster_member' && e.data?.kind !== 'cross_cluster'
        );
        const allNodes = addMode
          ? [
              ...nodesWithoutClusters.filter((n) => n.id !== queryNodeId),
              queryNode,
              ...fileNodes,
              ...folderNodes
            ]
          : [queryNode, ...fileNodes, ...folderNodes];
        const allEdges = addMode
          ? [
              ...edgesWithoutClusters.filter((e) => !e.id.startsWith(`e:${queryNodeId}`)),
              ...queryEdges,
              ...organizeEdges
            ]
          : [...queryEdges, ...organizeEdges];

        const { nodes: layoutedNodes, edges: layoutedEdges } = await debouncedElkLayout(
          allNodes,
          allEdges,
          {
            direction: 'RIGHT',
            spacing: GRAPH_LAYOUT_SPACING,
            layerSpacing: GRAPH_LAYER_SPACING
          }
        );
        if (!isMountedRef.current) return;
        graphActions.setGraph(
          layoutedNodes,
          layoutedEdges && layoutedEdges.length > 0 ? applyEdgeUiPrefs(layoutedEdges) : []
        );
      } catch (layoutError) {
        logger.warn('[Graph] Layout after conversion failed:', layoutError);
      }
    }
  }, [
    graphViewEnabled,
    searchResults,
    debouncedQuery,
    addMode,
    autoLayout,
    graphActions,
    recommendationMap,
    applyEdgeUiPrefs,
    searchMeta,
    queryMeta,
    defaultTopK,
    dispatch,
    edgeTooltipsRef,
    edgesRef,
    nodesRef,
    setGraphStatus,
    setShowClusters,
    showEdgeLabelsRef
  ]);

  // Assign ref for event handler access
  convertSearchToGraphRef.current = convertSearchToGraph;

  // ============================================================================
  // Keyboard Shortcuts
  // ============================================================================

  // Reset focused index when search results change
  useEffect(() => {
    setFocusedResultIndex(-1);
  }, [searchResults, setFocusedResultIndex]);

  // Scroll focused result into view
  useEffect(() => {
    const usesVirtualizedFlatList =
      viewMode === 'all' && searchResults.length > UI_VIRTUALIZATION.THRESHOLD;
    if (usesVirtualizedFlatList) {
      return;
    }
    if (focusedResultIndex >= 0 && resultListRef.current) {
      const items = resultListRef.current.querySelectorAll('[data-result-item]');
      if (items[focusedResultIndex]) {
        items[focusedResultIndex].scrollIntoView({
          block: 'nearest',
          behavior: getScrollBehavior()
        });
      }
    }
  }, [focusedResultIndex, searchResults.length, viewMode]);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handleKeyDown = (e) => {
      if (!isTopOverlay('knowledge-os-modal')) {
        return;
      }

      // Ctrl/Cmd + K: focus Search tab and query field (same affordance as global search shortcut)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        pendingInitialGraphTabRef.current = false;
        setActiveTab('search');
        requestAnimationFrame(() => {
          // Scope to this modal's content so a same-aria-labeled input in a
          // background overlay (or in a future modal) can't steal focus.
          const searchInput = modalContentRef.current?.querySelector('[aria-label="Search query"]');
          if (searchInput) {
            searchInput.focus();
            if (typeof searchInput.select === 'function') searchInput.select();
          }
        });
        return;
      }

      // Ctrl/Cmd + F: Focus search input
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        // Find and focus the search input. Scope to this modal so we don't
        // capture an input from another open overlay (UnifiedSearchModal can
        // sit beneath e.g. a confirm dialog that also has a search field).
        const searchInput = modalContentRef.current?.querySelector(
          '[aria-label="Search query"], [aria-label="Search to add nodes"]'
        );
        if (searchInput) {
          searchInput.focus();
          searchInput.select();
        }
      }

      // Escape: dismiss context menu → clear selection → close Knowledge OS.
      // closeOnEsc is false on the Modal so layered Esc semantics stay here
      // (and nested confirm modals can still win via isTopOverlay above).
      if (e.key === 'Escape') {
        e.preventDefault();
        if (contextMenu) {
          closeContextMenu();
          return;
        }
        if (selectedNodeId) {
          graphActions.selectNode(null);
          return;
        }
        if (focusedResultIndex >= 0) {
          setFocusedResultIndex(-1);
          return;
        }
        onClose?.();
      }

      if (isEditableTarget(e.target)) {
        return;
      }

      // Arrow key navigation for search results
      if (activeTab === 'search' && searchResults.length > 0) {
        // Check if autocomplete dropdown is open (has visible suggestions)
        const autocompleteOpen = document.querySelector('[role="listbox"]');
        if (autocompleteOpen) return; // Let autocomplete handle arrow keys

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setFocusedResultIndex((prev) => {
            const next = Math.min(prev + 1, searchResults.length - 1);
            // Also select when navigating
            if (searchResults[next]) {
              setSelectedSearchId(searchResults[next].id);
            }
            return next;
          });
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setFocusedResultIndex((prev) => {
            const next = Math.max(prev - 1, -1);
            // Select result or clear selection when at -1
            if (next >= 0 && searchResults[next]) {
              setSelectedSearchId(searchResults[next].id);
            } else if (next === -1) {
              setSelectedSearchId(null); // Clear selection when defocusing
            }
            return next;
          });
        }
        // Enter to open focused result
        if (e.key === 'Enter' && focusedResultIndex >= 0 && !e.ctrlKey && !e.metaKey) {
          const result = searchResults[focusedResultIndex];
          const resultPath = getMetadataPath(result, result?.id);
          if (resultPath) {
            e.preventDefault();
            openFile(resultPath);
          }
        }
      }

      // Ctrl/Cmd + Enter: Run search or load clusters
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (activeTab === 'graph' && nodes.length === 0) {
          loadClustersRef.current?.();
        }
      }

      // Tab switching: Ctrl + 1 search, 2 relate, 3 atlas, 4 chat, 5 timeline
      if (e.ctrlKey && e.key === '1') {
        e.preventDefault();
        pendingInitialGraphTabRef.current = false;
        setActiveTab('search');
      }
      if (e.ctrlKey && e.key === '2' && graphViewEnabled) {
        e.preventDefault();
        pendingInitialGraphTabRef.current = false;
        setActiveTab('graph');
      }
      if (e.ctrlKey && e.key === '3' && graphViewEnabled) {
        e.preventDefault();
        pendingInitialGraphTabRef.current = false;
        setActiveTab('atlas');
      }
      // F-212: Chat and Timeline had no hotkey (mouse only).
      if (e.ctrlKey && e.key === '4') {
        e.preventDefault();
        pendingInitialGraphTabRef.current = false;
        setActiveTab('chat');
      }
      if (e.ctrlKey && e.key === '5') {
        e.preventDefault();
        pendingInitialGraphTabRef.current = false;
        setActiveTab('timeline');
      }

      // Graph keyboard shortcuts — only when the graph tab is active so we
      // don't fight browser zoom or undo behaviors elsewhere in the modal.
      if (graphViewEnabled && activeTab === 'graph') {
        const isCtrlOrCmd = e.ctrlKey || e.metaKey;
        // Ctrl/Cmd + = / + : zoom in (= and + share the same key on most layouts)
        if (isCtrlOrCmd && (e.key === '=' || e.key === '+')) {
          e.preventDefault();
          reactFlowInstance.current?.zoomIn?.({ duration: 200 });
        }
        // Ctrl/Cmd + - : zoom out
        if (isCtrlOrCmd && e.key === '-') {
          e.preventDefault();
          reactFlowInstance.current?.zoomOut?.({ duration: 200 });
        }
        // Ctrl/Cmd + Z : undo last node selection
        if (isCtrlOrCmd && !e.shiftKey && e.key.toLowerCase() === 'z') {
          const tagName = document.activeElement?.tagName?.toLowerCase();
          // Don't hijack undo while the user is typing in a text field
          if (tagName !== 'input' && tagName !== 'textarea') {
            e.preventDefault();
            graphActions.undoSelect?.();
          }
        }
      }

      // "?" key: Show graph tour/help (only on graph tab, not in input)
      if (graphViewEnabled && e.key === '?' && activeTab === 'graph') {
        const tagName = document.activeElement?.tagName?.toLowerCase();
        if (tagName !== 'input' && tagName !== 'textarea') {
          e.preventDefault();
          setShowTourManually(true);
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [
    isOpen,
    activeTab,
    selectedNodeId,
    nodes.length,
    searchResults,
    focusedResultIndex,
    openFile,
    graphViewEnabled,
    graphActions,
    contextMenu,
    closeContextMenu,
    setFocusedResultIndex,
    setSelectedSearchId,
    loadClustersRef,
    reactFlowInstance,
    setShowTourManually,
    onClose
  ]);

  // Graph keyboard navigation (arrow keys, Enter, Escape, Home, End)
  useGraphKeyboardNav({
    nodes,
    edges,
    selectedNodeId,
    onSelectNode: graphActions.selectNode,
    onOpenFile: openFile,
    reactFlowInstance,
    enabled: graphViewEnabled && isOpen && activeTab === 'graph' && nodes.length > 0,
    containerRef: graphContainerRef
  });

  // Listen for findSimilar events from FileNode context menu
  // Use refs to avoid re-subscribing on every nodes change
  useEffect(() => {
    if (!isOpen || !graphViewEnabled) return undefined;

    const handleFindSimilar = (event) => {
      const { nodeId } = event.detail || {};
      if (!nodeId) return;

      // Use nodesRef to access current nodes without re-subscribing
      const currentNodes = nodesRef.current || [];
      const node = currentNodes.find((n) => n.id === nodeId);
      if (node && node.data?.kind === 'file') {
        // Use the ref to call expandFromSelected with the specific node
        expandFromSelectedRef.current?.(node);
      }
    };

    const handleToggleCluster = (event) => {
      const { nodeId } = event.detail || {};
      if (!nodeId) return;
      // Read state via ref to avoid stale closure / re-subscription
      const currentNodes = nodesRef.current || [];
      const clusterNode = currentNodes.find((n) => n.id === nodeId);
      if (!clusterNode) return;
      const memberIds = clusterNode.data?.memberIds || [];
      if (clusterNode.data?.expanded) {
        // Collapse: remove member nodes/edges and mark cluster as collapsed
        const memberIdSet = new Set(memberIds);
        graphActions.setNodes((prev) =>
          prev
            .filter((n) => !memberIdSet.has(n.id))
            .map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, expanded: false } } : n))
        );
        graphActions.setEdges((prev) =>
          prev.filter((e) => !memberIdSet.has(e.source) && !memberIdSet.has(e.target))
        );
        setGraphStatus('Cluster collapsed');
      } else if (expandClusterRef.current) {
        expandClusterRef.current(nodeId, memberIds);
      }
    };

    const handleSearchAgain = (event) => {
      const { query: searchQuery } = event.detail || {};
      if (!searchQuery) return;
      setActiveTab('search');
      setQuery(searchQuery);
      setDebouncedQuery(searchQuery);
    };

    const handleFocusNode = (event) => {
      const { nodeId } = event.detail || {};
      if (!nodeId) return;
      setFocusNodeId(nodeId);
      setFocusDepth(1);

      // Center on the focused node
      const currentNodes = nodesRef.current || [];
      const node = currentNodes.find((n) => n.id === nodeId);
      if (node && reactFlowInstance.current) {
        reactFlowInstance.current.setCenter(node.position.x + 100, node.position.y + 50, {
          duration: 300,
          zoom: 1.2
        });
      }
    };

    const handleViewInGraph = async (event) => {
      const { resultId, resultPath } = event.detail || {};
      const requestedPathKey = normalizeGraphPathKey(resultPath);
      if (!resultId && !requestedPathKey) return;
      // Convert current search results to graph and await layout completion
      try {
        await convertSearchToGraphRef.current?.();
      } catch {
        // Layout may throw AbortError on rapid re-invocation; safe to ignore
      }
      // Guard against unmount during the async conversion
      if (!isMountedRef.current) return;
      const findTargetNode = (currentNodes) => {
        if (!Array.isArray(currentNodes) || currentNodes.length === 0) return null;
        if (requestedPathKey) {
          const pathMatch = currentNodes.find(
            (node) => normalizeGraphPathKey(node?.data?.path) === requestedPathKey
          );
          if (pathMatch) return pathMatch;
        }
        if (resultId) {
          return currentNodes.find((node) => node.id === resultId) || null;
        }
        return null;
      };

      const targetNode = findTargetNode(nodesRef.current || []);
      if (!targetNode) return;

      // Layout is complete — select and focus the target node
      graphActions.selectNode(targetNode.id);
      // Wait one frame for React to flush the new node positions
      const rafId = requestAnimationFrame(() => {
        if (!isMountedRef.current) return;
        const currentNodes = nodesRef.current || [];
        const node = findTargetNode(currentNodes);
        if (node && reactFlowInstance.current) {
          reactFlowInstance.current.setCenter(node.position.x + 100, node.position.y + 50, {
            duration: 300,
            zoom: 1.2
          });
        }
      });
      if (viewInGraphRafRef) viewInGraphRafRef.current = rafId;
    };

    const handleFolderAction = async (event) => {
      const { action, folderId, folderPath } = event.detail || {};
      if (!folderId) return;
      if (action === 'moveFilesHere') {
        // Find all file nodes connected to this folder node via organize edges
        const currentEdges = edgesRef.current || [];
        const fileIds = currentEdges
          .filter((e) => e.target === folderId && e.data?.kind === 'organize')
          .map((e) => e.source);
        if (fileIds.length === 0) {
          setGraphStatus('No files connected to this folder suggestion.');
          return;
        }
        const currentNodes = nodesRef.current || [];
        const fileNodes = currentNodes.filter((n) => fileIds.includes(n.id));
        const filePaths = fileNodes.map((n) => n.data?.path).filter(Boolean);
        if (filePaths.length === 0) {
          setGraphStatus('No file paths available for this folder.');
          return;
        }
        setGraphStatus(
          `Moving ${filePaths.length} file${filePaths.length === 1 ? '' : 's'} to "${folderPath}"...`
        );
        try {
          await handleMoveAllToFolderRef.current?.(
            { id: folderId, label: folderPath, memberIds: fileIds },
            folderPath
          );
        } catch {
          setGraphStatus('Failed to move files.');
        }
      } else if (action === 'reveal') {
        try {
          await window.electronAPI?.files?.reveal?.(folderPath);
        } catch {
          setGraphStatus(`Could not reveal "${folderPath}" in Explorer.`);
        }
      }
    };

    window.addEventListener('graph:findSimilar', handleFindSimilar);
    window.addEventListener('graph:toggleCluster', handleToggleCluster);
    window.addEventListener('graph:searchAgain', handleSearchAgain);
    window.addEventListener('graph:focusNode', handleFocusNode);
    window.addEventListener('graph:viewInGraph', handleViewInGraph);
    window.addEventListener('graph:folderAction', handleFolderAction);
    return () => {
      window.removeEventListener('graph:findSimilar', handleFindSimilar);
      window.removeEventListener('graph:toggleCluster', handleToggleCluster);
      window.removeEventListener('graph:searchAgain', handleSearchAgain);
      window.removeEventListener('graph:focusNode', handleFocusNode);
      window.removeEventListener('graph:viewInGraph', handleViewInGraph);
      window.removeEventListener('graph:folderAction', handleFolderAction);
    };
  }, [
    isOpen,
    graphActions,
    graphViewEnabled,
    setFocusedResultIndex,
    setSelectedSearchId,
    setDebouncedQuery,
    setQuery,
    edgesRef,
    expandClusterRef,
    expandFromSelectedRef,
    nodesRef,
    reactFlowInstance,
    setFocusDepth,
    setFocusNodeId,
    setGraphStatus
  ]); // handleMoveAllToFolder accessed via ref to avoid TDZ

  // Prevent wheel events on the graph container from scrolling the parent modal.
  // Uses a native listener because React's synthetic stopPropagation doesn't
  // intercept ReactFlow's native wheel handler registered with { passive: false }.
  // Re-runs when activeTab changes because the graph container div only mounts on the graph tab.
  useEffect(() => {
    const el = graphContainerRef.current;
    if (!el) return;
    const stopWheel = (e) => e.stopPropagation();
    el.addEventListener('wheel', stopWheel, { passive: true });
    return () => el.removeEventListener('wheel', stopWheel);
  }, [activeTab, graphContainerRef]);

  // ============================================================================
  // Shared: Stats & Rebuild (extracted to hooks/useSearchModalStats — §I Phase 2)
  // ============================================================================

  // ============================================================================
  // Bulk Selection Handlers
  // ============================================================================

  const toggleBulkSelection = useCallback(
    (resultId) => {
      setBulkSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(resultId)) {
          next.delete(resultId);
        } else {
          next.add(resultId);
        }
        return next;
      });
    },
    [setBulkSelectedIds]
  );

  const handleResultSelect = useCallback(
    (result, index) => {
      setSelectedSearchId(result?.id ?? null);
      setFocusedResultIndex(index);
    },
    [setFocusedResultIndex, setSelectedSearchId]
  );

  const clearBulkSelection = useCallback(() => {
    setBulkSelectedIds(new Set());
  }, [setBulkSelectedIds]);

  const moveFilesToFolder = useMoveFilesToFolder();

  const moveSelectedToFolder = useCallback(async () => {
    const paths = searchResults
      .filter((r) => bulkSelectedIds.has(r.id))
      .map((file) => file.metadata?.path)
      .filter(Boolean);
    if (paths.length === 0) return;

    try {
      const { moved, failed, destFolder } = await moveFilesToFolder(paths, {
        onProgress: setGraphStatus
      });

      if (isMountedRef.current) {
        if (moved > 0) {
          metadataCacheRef.current.clear();
          setGraphStatus(`Moved ${moved} file(s) to ${safeBasename(destFolder)}`);
          clearBulkSelection();
        }
        if (failed > 0) {
          setError(`Failed to move ${failed} file(s)`);
        }
      }
    } catch (e) {
      logger.error('[Search] Move operation failed', e);
      if (isMountedRef.current) setError(`Move failed: ${e?.message || 'Unknown error'}`);
    }
  }, [
    searchResults,
    bulkSelectedIds,
    moveFilesToFolder,
    clearBulkSelection,
    metadataCacheRef,
    setGraphStatus
  ]);

  /**
   * Create a Smart Folder from a cluster's metadata
   * Uses the cluster's label, category, and tags to define the folder
   */
  // (graph cluster/focus/layout/save/duplicates handlers moved into useGraphTab — §I Phase 5)
  // ============================================================================
  // Search Tab Logic — extracted to hooks/useSearchTab (§I Phase 3). The
  // details fetch below stays: it serves BOTH the search tab and graph nodes.
  // ============================================================================

  // Fetch full details (including extracted text) when selection changes
  useEffect(() => {
    // Determine the path to fetch details for
    const path =
      activeTab === 'search'
        ? selectedSearchResultPath
        : selectedNode?.data?.kind === 'file'
          ? freshMetadata?.path || selectedNode.data?.path
          : null;

    if (!path) {
      detailsRequestCounterRef.current += 1;
      setSelectedDocumentDetails(null);
      lastFetchedDetailsPathRef.current = null;
      setIsLoadingDocumentDetails(false);
      return undefined;
    }

    // Don't re-fetch if we already have details for this path
    if (lastFetchedDetailsPathRef.current === path) return undefined;

    let cancelled = false;
    const requestId = (detailsRequestCounterRef.current += 1);
    const fetchDetails = async () => {
      setIsLoadingDocumentDetails(true);
      try {
        const history = await window.electronAPI?.analysisHistory?.getFileHistory?.(path);
        if (!cancelled && detailsRequestCounterRef.current === requestId && history) {
          lastFetchedDetailsPathRef.current = path;
          setSelectedDocumentDetails(history);
        }
      } catch (err) {
        logger.warn('Failed to fetch document details', err);
      } finally {
        if (!cancelled && detailsRequestCounterRef.current === requestId) {
          setIsLoadingDocumentDetails(false);
        }
      }
    };
    fetchDetails();
    return () => {
      cancelled = true;
    };
  }, [selectedSearchResultPath, selectedNode, freshMetadata, activeTab]);

  // ============================================================================
  // Graph Tab Logic — extracted to hooks/useGraphTab (§I Phase 5)
  // ============================================================================

  // Graph computed values moved into useGraphTab (§I 5b).

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Knowledge OS"
      size="full"
      closeOnEsc={false}
      // Full-screen workspace with in-progress chat/graph/triage state: a
      // stray click on the thin backdrop margins must not dismiss it. Both
      // dismissal paths (Esc, click-away) route through explicit controls.
      closeOnOverlayClick={false}
      overlayId="knowledge-os-modal"
      className={`search-modal transition-colors [transition-duration:var(--motion-duration-standard)] [transition-timing-function:var(--motion-ease-standard)] ${
        isGraphMaximized ? 'bg-system-gray-100/95' : ''
      }`}
      bodyClassName="p-0 overflow-hidden"
    >
      <div ref={modalContentRef} className="relative flex flex-col gap-default h-full min-h-0">
        {isOpen && isLoadingStats && !hasLoadedStats && (
          <ModalLoadingOverlay message="Loading Knowledge OS..." inline />
        )}
        {/* Header - hide tab bar only when graph is maximized */}
        {!isGraphMaximized && (
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-cozy border-b border-system-gray-200/80 pb-3">
            <div className="flex items-center gap-default">
              <TabButton
                active={activeTab === 'search'}
                onClick={() => {
                  pendingInitialGraphTabRef.current = false;
                  setActiveTab('search');
                }}
                icon={List}
                label="Search"
                tooltip="Find files by keyword or meaning, as a text list"
              />
              <TabButton
                active={activeTab === 'chat'}
                onClick={() => {
                  pendingInitialGraphTabRef.current = false;
                  setActiveTab('chat');
                }}
                icon={MessageSquare}
                label="Chat"
                tooltip="Ask questions about your files"
              />
              <TabButton
                active={activeTab === 'timeline'}
                onClick={() => {
                  pendingInitialGraphTabRef.current = false;
                  setActiveTab('timeline');
                }}
                icon={CalendarDays}
                label="Timeline"
                tooltip="Browse your files by date, newest first"
              />
              {graphViewEnabled && (
                <TabButton
                  active={activeTab === 'graph'}
                  onClick={() => {
                    pendingInitialGraphTabRef.current = false;
                    setActiveTab('graph');
                  }}
                  icon={Network}
                  label="Relate"
                  tooltip="Trace links between files and topic clusters, step by step"
                />
              )}
              {graphViewEnabled && (
                <TabButton
                  active={activeTab === 'atlas'}
                  onClick={() => {
                    pendingInitialGraphTabRef.current = false;
                    setActiveTab('atlas');
                  }}
                  icon={Orbit}
                  label="Atlas"
                  tooltip="See your whole library as a map — nearby files are similar"
                />
              )}
            </div>
            <StatsDisplay
              stats={stats}
              isLoadingStats={isLoadingStats}
              statsUnavailable={statsUnavailable}
              onRefresh={() => refreshStats(true)}
              simpleMode={simpleMode}
            />
          </div>
        )}

        {/* Empty embeddings banner */}
        {showEmptyBanner && (
          <EmptyEmbeddingsBanner
            onRebuildFolders={rebuildFolders}
            onRebuildFiles={rebuildFiles}
            isRebuildingFolders={isRebuildingFolders}
            isRebuildingFiles={isRebuildingFiles}
            embeddingConfig={embeddingConfig}
            indexHealth={stats}
            onOpenSettings={handleOpenSettings}
            simpleMode={simpleMode}
          />
        )}
        {!showEmptyBanner &&
          stats &&
          (stats.embeddingModelMismatch ||
            stats.needsFileEmbeddingRebuild ||
            stats.embeddingCoverageLow) && (
            <IndexHealthBanner
              stats={stats}
              onRebuildFiles={rebuildFiles}
              isRebuildingFiles={isRebuildingFiles}
              onOpenSettings={handleOpenSettings}
              simpleMode={simpleMode}
            />
          )}

        {/* Error banner */}
        {error && (
          <StateMessage
            icon={AlertTriangle}
            tone="error"
            size="sm"
            align="left"
            title="Search error"
            description={error}
            className="glass-panel border border-stratosort-danger/30 bg-stratosort-danger/10 p-3 rounded-xl"
            contentClassName="max-w-xl"
          />
        )}

        {/* Search Tab Content */}
        {activeTab === 'search' && (
          <SearchTabContent
            search={searchTab}
            stats={stats}
            statsUnavailable={statsUnavailable}
            error={error}
            openFile={openFile}
            revealFile={revealFile}
            copyPath={copyPath}
            showEmptyBanner={showEmptyBanner}
            selectedDocumentDetails={selectedDocumentDetails}
            isLoadingDocumentDetails={isLoadingDocumentDetails}
            convertSearchToGraph={convertSearchToGraph}
            moveSelectedToFolder={moveSelectedToFolder}
            clearBulkSelection={clearBulkSelection}
            toggleBulkSelection={toggleBulkSelection}
            handleResultSelect={handleResultSelect}
            resultListRef={resultListRef}
            embeddingConfig={embeddingConfig}
            rebuildFiles={rebuildFiles}
            handleChatSend={handleChatSend}
            handleGoToDiscover={handleGoToDiscover}
            handleOpenSettings={handleOpenSettings}
            setActiveTab={setActiveTab}
            simpleMode={simpleMode}
            graphViewEnabled={graphViewEnabled}
          />
        )}

        {/* Chat Tab Content */}
        {activeTab === 'chat' && (
          <ChatTabContent
            chat={chatTab}
            stats={stats}
            statsUnavailable={statsUnavailable}
            handleUseSourcesInGraph={handleUseSourcesInGraph}
            hasLoadedStats={hasLoadedStats}
            isLoadingStats={isLoadingStats}
            isSearching={isSearching}
            simpleMode={simpleMode}
            graphViewEnabled={graphViewEnabled}
            handleOpenSettings={handleOpenSettings}
          />
        )}

        {/* Timeline Tab Content */}
        {activeTab === 'timeline' && <TimelineTabContent {...timelineTab} onOpenFile={openFile} />}

        {/* Graph Tab Content — extracted to GraphTabContent.jsx (§I 5b) */}
        {graphViewEnabled && activeTab === 'graph' && (
          <GraphTabContent
            graph={graphTab}
            setActiveTab={setActiveTab}
            isGraphMaximized={isGraphMaximized}
            setIsGraphMaximized={setIsGraphMaximized}
            openFile={openFile}
            revealFile={revealFile}
            setError={setError}
            stats={stats}
            statsUnavailable={statsUnavailable}
            query={query}
            setQuery={setQuery}
            handleChatSend={handleChatSend}
            setDocumentScope={setDocumentScope}
            isLoadingDocumentDetails={isLoadingDocumentDetails}
            selectedDocumentDetails={selectedDocumentDetails}
            isLoadingRecommendations={isLoadingRecommendations}
            pendingInitialGraphTabRef={pendingInitialGraphTabRef}
            organizationalHealthRef={organizationalHealthRef}
            graphFitViewTimeoutRef={graphFitViewTimeoutRef}
            sidebarSections={sidebarSections}
          />
        )}

        {/* Atlas Tab Content — keep mounted after first visit to avoid WebGL rebuild */}
        {graphViewEnabled && atlasMounted && (
          <div
            className={
              activeTab === 'atlas'
                ? 'relative flex min-h-0 flex-1 flex-col'
                : 'pointer-events-none absolute inset-0 -z-10 opacity-0'
            }
            aria-hidden={activeTab !== 'atlas'}
          >
            <AtlasTabContent
              isActive={activeTab === 'atlas'}
              openFile={openFile}
              revealFile={revealFile}
              setError={setError}
              simpleMode={simpleMode}
            />
          </div>
        )}
      </div>

      {/* First-time user tour (or re-triggered via help button) */}
      {graphViewEnabled && activeTab === 'graph' && (
        <GraphTour
          isOpen={isOpen && graphViewEnabled && activeTab === 'graph'}
          forceShow={showTourManually}
          onComplete={() => setShowTourManually(false)}
        />
      )}

      {/* Clear confirmation modal */}
      <ConfirmModal
        isOpen={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        onConfirm={() => {
          graphActions.setGraph([], []);
          graphActions.selectNode(null);
          setError('');
          setGraphStatus('');
          setShowClusters(false);
        }}
        title="Clear graph?"
        message="This will remove all nodes and connections from your exploration. This cannot be undone."
        confirmText="Clear graph"
        cancelText="Cancel"
        variant="warning"
      />
      {/* Triage Modal */}
      <TriageModal
        isOpen={isTriageModalOpen}
        onClose={() => setIsTriageModalOpen(false)}
        files={triageFiles}
        title="Organize scattered files"
        description="These files don't belong to any specific topic cluster. Move them to a folder to organize them."
        onMoveFiles={handleMoveFiles}
      />

      {/* Duplicate Resolution Modal */}
      <DuplicateResolutionModal
        isOpen={isDuplicateModalOpen}
        onClose={() => setIsDuplicateModalOpen(false)}
        duplicateGroups={duplicateGroups}
        onResolve={handleResolveDuplicates}
      />
      {/* Bridge Analysis Modal */}
      <BridgeAnalysisModal
        isOpen={isBridgeModalOpen}
        onClose={() => setIsBridgeModalOpen(false)}
        bridges={edges.filter((e) => e.data?.kind === 'cross_cluster')}
        clusters={clusterInsights.clusterNodes || []}
        onGroupFiles={handleGroupFiles}
      />
      {/* Downloads Triage View (Phase 3) */}
      <DownloadsTriageView
        isOpen={isDownloadsTriageOpen}
        onClose={() => setIsDownloadsTriageOpen(false)}
      />
      {/* Related Documents Panel (Phase 2) */}
      {relatedPanel && (
        <div className="fixed right-0 top-0 z-40 h-full">
          <RelatedDocumentsPanel
            isOpen={Boolean(relatedPanel)}
            fileId={relatedPanel.fileId}
            fileName={relatedPanel.fileName}
            filePath={relatedPanel.filePath}
            onClose={() => setRelatedPanel(null)}
            onFocusFile={(neighborId) => {
              window.dispatchEvent(
                new CustomEvent('graph:focusNode', { detail: { nodeId: neighborId } })
              );
            }}
          />
        </div>
      )}
      {/* Tag Cluster Modal */}
      <TagClusterModal
        isOpen={isTagModalOpen}
        onClose={() => setIsTagModalOpen(false)}
        clusterName={selectedClusterForTagging?.label}
        initialTags={selectedClusterForTagging?.commonTags}
        onApplyTags={handleApplyTags}
      />

      {/* Graph node context menu */}
      {contextMenu && (
        <>
          {/* Transparent backdrop — click outside to dismiss */}
          <div
            className="fixed inset-0 z-[9998]"
            aria-hidden="true"
            onClick={closeContextMenu}
            onContextMenu={(e) => {
              e.preventDefault();
              closeContextMenu();
            }}
          />
          <div
            className="dropdown-menu fixed z-[9999] min-w-[160px] text-sm"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            role="menu"
            aria-label="Node actions"
          >
            {contextMenu.kind === 'file' && (
              <>
                <button
                  className="dropdown-menu-item dropdown-menu-item--default flex w-full items-center gap-compact text-left"
                  onClick={() => {
                    if (contextMenu.data?.path) {
                      window.electronAPI?.files?.open?.(contextMenu.data.path);
                    }
                    closeContextMenu();
                  }}
                >
                  Open File
                </button>
                <button
                  className="dropdown-menu-item dropdown-menu-item--default flex w-full items-center gap-compact text-left"
                  onClick={() => {
                    if (contextMenu.data?.path) {
                      window.electronAPI?.files?.reveal?.(contextMenu.data.path);
                    }
                    closeContextMenu();
                  }}
                >
                  Reveal in Folder
                </button>
                <hr className="my-1 border-system-gray-100" />
                <button
                  className="dropdown-menu-item dropdown-menu-item--default flex w-full items-center gap-compact text-left"
                  onClick={() => {
                    window.dispatchEvent(
                      new CustomEvent('graph:findSimilar', {
                        detail: { nodeId: contextMenu.nodeId, path: contextMenu.data?.path }
                      })
                    );
                    closeContextMenu();
                  }}
                >
                  Find Similar
                </button>
                <button
                  className="dropdown-menu-item dropdown-menu-item--default flex w-full items-center gap-compact text-left"
                  onClick={() => {
                    window.dispatchEvent(
                      new CustomEvent('graph:focusNode', { detail: { nodeId: contextMenu.nodeId } })
                    );
                    closeContextMenu();
                  }}
                >
                  Focus on Node
                </button>
                <button
                  className="dropdown-menu-item dropdown-menu-item--default flex w-full items-center gap-compact text-left"
                  onClick={() => {
                    setRelatedPanel({
                      fileId: contextMenu.nodeId,
                      fileName: contextMenu.data?.name,
                      filePath: contextMenu.data?.path
                    });
                    closeContextMenu();
                  }}
                >
                  Show Related Documents
                </button>
              </>
            )}
            {contextMenu.kind === 'cluster' && (
              <>
                <button
                  className="dropdown-menu-item dropdown-menu-item--default flex w-full items-center gap-compact text-left"
                  onClick={() => {
                    handleClusterExpand(contextMenu.nodeId);
                    closeContextMenu();
                  }}
                >
                  {contextMenu.data?.expanded ? 'Collapse cluster' : 'Expand cluster'}
                </button>
                <button
                  className="dropdown-menu-item dropdown-menu-item--default flex w-full items-center gap-compact text-left"
                  onClick={() => {
                    handleTagCluster(contextMenu.data);
                    closeContextMenu();
                  }}
                >
                  Tag Cluster
                </button>
                <hr className="my-1 border-system-gray-100" />
                <button
                  className="dropdown-menu-item dropdown-menu-item--default flex w-full items-center gap-compact text-left"
                  onClick={() => {
                    handleCreateSmartFolderFromCluster(contextMenu.data);
                    closeContextMenu();
                  }}
                >
                  Create Smart Folder
                </button>
                <button
                  className="dropdown-menu-item dropdown-menu-item--default flex w-full items-center gap-compact text-left"
                  onClick={() => {
                    handleMoveAllToFolder(contextMenu.data);
                    closeContextMenu();
                  }}
                >
                  Move All to Folder
                </button>
                <button
                  className="dropdown-menu-item dropdown-menu-item--default flex w-full items-center gap-compact text-left"
                  onClick={() => {
                    handleExportFileList(contextMenu.data);
                    closeContextMenu();
                  }}
                >
                  Export File List
                </button>
              </>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

UnifiedSearchModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  defaultTopK: PropTypes.number,
  initialTab: PropTypes.oneOf(['search', 'chat', 'timeline', 'graph'])
};
