/**
 * Graph tab content for the Unified Search modal (§I Phase 5b).
 *
 * Pure presentation: renders the graph canvas (React Flow), the left
 * controls sidebar and right insight/details sidebar, context menus,
 * empty/status states, and the cluster/triage/bridge/duplicate/tag
 * modals. All state and handlers arrive via the  prop — the
 * ~190-member surface returned by hooks/useGraphTab — plus a handful of
 * modal-owned extras. Extracted verbatim from UnifiedSearchModal.
 */
import React from 'react';
import PropTypes from 'prop-types';
import { ReactFlow, Background, Controls, MiniMap, Panel } from '@xyflow/react';
import {
  Activity,
  AlertTriangle,
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Copy,
  Crosshair,
  ExternalLink,
  FileText,
  Filter,
  FolderOpen,
  FolderPlus,
  GitBranch,
  HelpCircle,
  Inbox,
  Layers,
  LayoutGrid,
  List,
  Loader2,
  Maximize2,
  MessageSquare,
  Minimize2,
  Network,
  RefreshCw,
  Search as SearchIcon,
  Sparkles,
  X,
  Zap
} from 'lucide-react';
import { Button, IconButton, StateMessage, Textarea, Input, Select } from '../ui';
import { Heading, Text } from '../ui/Typography';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { selectRedactPaths } from '../../store/selectors';
import {
  setGraphInsightsSection,
  setGraphLegendHintDismissed,
  setGraphInsightsDockCollapsed
} from '../../store/slices/uiSlice';
import { safeBasename } from '../../../shared/memberPathUtils';
import { deriveClusterDisplayLabel } from '../../../shared/clusterDisplayLabel';
import { sanitizeGraphMetadataTerms } from '../../utils/semanticTerms';
import ActionCard from './ActionCard';
import ClusterLegend from './ClusterLegend';
import GraphErrorBoundary from './GraphErrorBoundary';
import InsightDock from './InsightDock';
import SearchAutocomplete from './SearchAutocomplete';
import SidebarSection from './SidebarSection';
import { GraphActionsContext } from './useEdgeInteraction';
import {
  formatGraphBridgeFileLabel,
  getDefaultGraphFitViewOptions,
  DEFAULT_CLUSTER_MODE,
  CLUSTER_MODE_CHIP_LABELS
} from './utils';
import {
  GRAPH_VIEW_NODE_TYPES,
  GRAPH_VIEW_EDGE_TYPES,
  GRAPH_SIDEBAR_CARD,
  GRAPH_SIDEBAR_SECTION_TITLE,
  GRAPH_MINIMAP_STYLE,
  GRAPH_MINIMAP_MASK_COLOR,
  GRAPH_MINIMAP_MASK_STROKE_COLOR
} from './graphViewConstants';

export default function GraphTabContent({
  graph,
  setActiveTab,
  isGraphMaximized,
  setIsGraphMaximized,
  openFile,
  revealFile,
  setError,
  stats,
  statsUnavailable,
  query,
  setQuery,
  handleChatSend,
  setDocumentScope,
  isLoadingDocumentDetails,
  selectedDocumentDetails,
  isLoadingRecommendations,
  pendingInitialGraphTabRef,
  organizationalHealthRef,
  graphFitViewTimeoutRef,
  sidebarSections
}) {
  const dispatch = useAppDispatch();
  const redactPaths = useAppSelector(selectRedactPaths);
  const legendHintDismissed = useAppSelector((s) => s.ui?.graphLegendHintDismissed === true);
  const insightDockCollapsed = useAppSelector((s) => s.ui?.graphInsightsDockCollapsed === true);

  const {
    activeClusterFilterChips,
    activeFilters,
    activeFindings,
    activeGraphFilterChips,
    activeSidebarFilterCount,
    addMode,
    applyLayout,
    autoLayout,
    bridgeOverlayEnabled,
    closeContextMenu,
    clusterFilters,
    clusterInsights,
    clusterMode,
    displayedSelectedNodeWhyConnections,
    duplicateSummary,
    edges,
    expandedRelatedClusters,
    focusDepth,
    focusGraphNode,
    focusNode,
    focusNodeId,
    graphActions,
    graphActionsContextValue,
    graphContainerRef,
    graphNotes,
    graphReadabilityProfile,
    graphStatus,
    graphVisualizationRemountKey,
    handleClearFocus,
    handleCollapseAllClusters,
    handleCreateSmartFolderFromCluster,
    handleDockHealthClick,
    handleDockStatClick,
    handleDragLeave,
    handleDragOver,
    handleExpandAllClusters,
    handleFileDrop,
    handleFindDuplicates,
    handleGraphMove,
    handleGroupFiles,
    handleLoadGraph,
    handleMoveAllToFolder,
    handleOpenSettings,
    handleOrgFindingClick,
    handleReactFlowError,
    handleSaveGraph,
    handleToggleFilter,
    hasGraphFilterIndicators,
    hiddenSelectedNodeConnectionsCount,
    hopCount,
    insightBridgeCards,
    insightClusterNodes,
    insightSummary,
    insightSurpriseConnections,
    isComputingClusters,
    isDragOver,
    isLayouting,
    isLoadingMetadata,
    isRelatedClustersOpen,
    loadClusters,
    miniMapNodeColor,
    nodes,
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
    resetGraphFilters,
    rfDefaultViewport,
    rfEdges,
    rfFitViewOptions,
    rfNodes,
    rfProOptions,
    runGraphSearch,
    scatteredFileIds,
    selectedClusterInfo,
    selectedKind,
    selectedLabel,
    selectedNode,
    selectedNodeConnectionCount,
    selectedNodeHeroConnectionText,
    selectedNodeNeighbors,
    selectedNodeWhyConnections,
    selectedPath,
    setAddMode,
    setAutoLayout,
    setBridgeOverlayEnabled,
    setClusterFilters,
    setClusterMode,
    setExpandedRelatedClusters,
    setFocusDepth,
    setFocusNodeId,
    setGraphNotes,
    setGraphStatus,
    setGraphVisualizationRemountKey,
    setHopCount,
    setIsDownloadsTriageOpen,
    setIsDuplicateModalOpen,
    setIsRelatedClustersOpen,
    setShowAdvancedFilters,
    setShowClearConfirm,
    setShowClusters,
    setShowEdgeLabels,
    setShowTourManually,
    setWithinQuery,
    showAdvancedFilters,
    showClusters,
    showEdgeLabels,
    syncGraphZoomFromViewport,
    toggleSidebarSection,
    withinQuery,
    zoomBucket
  } = graph;

  return (
    <div
      className={`grid gap-cozy flex-1 min-h-0 [transition-property:grid-template-columns,min-height,height] [transition-duration:var(--motion-duration-standard)] [transition-timing-function:var(--motion-ease-standard)] ${
        isGraphMaximized
          ? 'grid-cols-1'
          : 'grid-cols-1 lg:grid-cols-[minmax(260px,300px)_minmax(0,1fr)_minmax(260px,320px)]'
      }`}
    >
      {statsUnavailable ? (
        <div className="col-span-full flex items-center justify-center surface-panel">
          <StateMessage
            icon={AlertTriangle}
            tone="error"
            size="lg"
            title="Graph is offline"
            description="The local AI engine or vector database is currently unavailable. Please check your model downloads in Settings or restart the app."
            action={
              <Button type="button" variant="secondary" size="sm" onClick={handleOpenSettings}>
                Open Settings
              </Button>
            }
          />
        </div>
      ) : (
        <GraphErrorBoundary
          onReset={() => {
            setGraphVisualizationRemountKey((k) => k + 1);
          }}
          onClearGraph={() => {
            graphActions.setGraph([], []);
            graphActions.selectNode(null);
            setError('');
          }}
          onLeaveGraph={() => {
            pendingInitialGraphTabRef.current = false;
            setActiveTab('search');
          }}
        >
          <React.Fragment key={graphVisualizationRemountKey}>
            {/* Left: Controls */}
            {!isGraphMaximized && (
              <div
                className="surface-panel p-0 flex flex-col h-full min-h-0 overflow-hidden"
                role="complementary"
                aria-label="Graph controls"
              >
                <div className="px-4 py-3 border-b border-system-gray-100 bg-system-gray-50/50">
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      pendingInitialGraphTabRef.current = false;
                      setActiveTab('search');
                    }}
                    className="mb-1 -ml-1 text-system-gray-500 hover:text-stratosort-blue"
                  >
                    <ChevronLeft className="w-3 h-3" />
                    <span className="text-xs">Discover</span>
                  </Button>
                  <div className="flex items-center justify-between gap-compact">
                    <Text
                      as="div"
                      variant="tiny"
                      className={`${GRAPH_SIDEBAR_SECTION_TITLE} items-center`}
                    >
                      <Network
                        className="w-3.5 h-3.5 text-stratosort-blue shrink-0"
                        aria-hidden="true"
                      />
                      <span>Graph controls</span>
                    </Text>
                    {hasGraphFilterIndicators && (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={resetGraphFilters}
                        className="shrink-0"
                      >
                        Reset Filters
                      </Button>
                    )}
                  </div>
                </div>

                {/* Persistent search. The sections below are an accordion
                        (one open at a time), which buried search inside the
                        collapsed "Add to graph" section. Hoisting it here keeps
                        "find / add files" reachable at all times. */}
                <div className="px-4 py-3 border-b border-system-gray-100 bg-system-gray-50/30">
                  <SearchAutocomplete
                    value={query}
                    onChange={setQuery}
                    onSearch={runGraphSearch}
                    placeholder="Search files to add to the graph…"
                    ariaLabel="Search the graph"
                    className="bg-system-gray-100 shadow-sm"
                    showShortcutHint={false}
                  />
                </div>

                <div className="p-3 pb-6 flex-1 min-h-0 overflow-y-auto panel-scroll flex flex-col gap-cozy">
                  {/* Selection-aware quick stats: only render when a node is
                          picked so the panel doesn't open with a stats slab. The
                          numbers also appear in the toolbar above the canvas. */}
                  {selectedNode && (
                    <div className="flex items-center justify-between gap-compact text-xs px-1">
                      <Text as="span" variant="tiny" className="text-system-gray-500">
                        {nodes.length} nodes · {edges.length} links
                      </Text>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => graphActions.selectNode(null)}
                      >
                        Clear Selection
                      </Button>
                    </div>
                  )}

                  {/* What's interesting — round-2 redesign. Every card
                          below is an ActionCard: sentence + primary verb.
                          The cards only render when their underlying count
                          is > 0, so a fresh graph shows a compact set and
                          grows as insights accumulate. */}
                  <SidebarSection
                    icon={Sparkles}
                    title="What's interesting"
                    isOpen={sidebarSections.insights}
                    onToggle={() => toggleSidebarSection('insights')}
                  >
                    {/* Empty state — only thing that shows when no nodes are loaded. */}
                    {nodes.length === 0 && (
                      <div className={`${GRAPH_SIDEBAR_CARD} text-system-gray-500`}>
                        <Text as="div" variant="small" className="text-system-gray-700 mb-1">
                          No files in the graph yet.
                        </Text>
                        <Text as="div" variant="tiny" className="text-system-gray-500">
                          Run a search or drag files in to populate it. Then come back here for
                          actionable suggestions.
                        </Text>
                      </div>
                    )}

                    {nodes.length > 0 && (
                      <div className="space-y-2.5">
                        {/* Scattered files — clusters with no dominant folder. */}
                        {scatteredFileIds.length > 0 && (
                          <ActionCard
                            icon={Inbox}
                            tone="warning"
                            headline={`${scatteredFileIds.length} file${scatteredFileIds.length === 1 ? '' : 's'} spread across folders`}
                            description="No clear home. Consolidate them into one folder."
                            verb="Group into one folder"
                            onClick={() =>
                              handleGroupFiles(scatteredFileIds, { source: 'scattered' })
                            }
                          />
                        )}

                        {/* Surprises — semantically close topics in different folders. */}
                        {insightSurpriseConnections.map((bridge) => (
                          <ActionCard
                            key={`surprise:${bridge.id}`}
                            icon={Zap}
                            tone="warning"
                            headline={
                              <>
                                {bridge.sourceLabel} <span className="text-system-gray-400">↔</span>{' '}
                                {bridge.targetLabel}
                              </>
                            }
                            description={`${Math.round((bridge.similarity || 0) * 100)}% related — files sit in different folders`}
                            verb="Highlight on graph"
                            onClick={() => {
                              setBridgeOverlayEnabled(true);
                              focusGraphNode(bridge.sourceId);
                            }}
                            secondary={{
                              label: 'Explore all bridges',
                              onClick: openBridgeAnalysis
                            }}
                          />
                        ))}

                        {/* Recent activity — clusters with a recency window (esp. time mode). */}
                        {clusterInsights.emergingClusters[0] && (
                          <ActionCard
                            icon={Clock}
                            headline={clusterInsights.emergingClusters[0].label}
                            onHeadlineClick={() =>
                              focusGraphNode(clusterInsights.emergingClusters[0].id)
                            }
                            description={[
                              `${clusterInsights.emergingClusters[0].memberCount} file${clusterInsights.emergingClusters[0].memberCount === 1 ? '' : 's'}`,
                              clusterInsights.emergingClusters[0].endMs
                                ? `active through ${new Date(
                                    clusterInsights.emergingClusters[0].endMs
                                  ).toLocaleDateString(undefined, {
                                    month: 'short',
                                    day: 'numeric',
                                    year: 'numeric'
                                  })}`
                                : null
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                            verb="Show in graph"
                            onClick={() => focusGraphNode(clusterInsights.emergingClusters[0].id)}
                          />
                        )}

                        {/* Topic clusters — top 5 by insight score (size + scattered boost). */}
                        {insightClusterNodes.slice(0, 5).map((clusterNode) => {
                          const memberIds = Array.isArray(clusterNode.data?.memberIds)
                            ? clusterNode.data.memberIds
                            : [];
                          const memberCount = clusterNode.data?.memberCount || memberIds.length;
                          const topTerms = sanitizeGraphMetadataTerms(clusterNode.data?.topTerms, {
                            maxTerms: 3
                          });
                          const descParts = [`${memberCount} file${memberCount === 1 ? '' : 's'}`];
                          if (topTerms.length > 0) descParts.push(topTerms.join(', '));
                          const canSaveSmart =
                            typeof handleCreateSmartFolderFromCluster === 'function' &&
                            memberCount >= 6;
                          return (
                            <ActionCard
                              key={clusterNode.id}
                              icon={Layers}
                              headline={deriveClusterDisplayLabel({
                                label: clusterNode.data?.label,
                                clusterId: clusterNode.data?.clusterId,
                                topTerms: clusterNode.data?.topTerms,
                                commonTags: clusterNode.data?.commonTags,
                                dominantCategory: clusterNode.data?.dominantCategory,
                                dominantFolderName: clusterNode.data?.dominantFolderName,
                                memberCount: clusterNode.data?.memberCount
                              })}
                              onHeadlineClick={() => focusGraphNode(clusterNode.id)}
                              description={descParts.join(' · ')}
                              verb="Group into folder"
                              onClick={() => handleMoveAllToFolder(clusterNode.data)}
                              secondary={
                                canSaveSmart
                                  ? {
                                      label: 'Save as Smart Folder',
                                      onClick: () =>
                                        handleCreateSmartFolderFromCluster(clusterNode.data)
                                    }
                                  : null
                              }
                            />
                          );
                        })}

                        {/* Bridges — ranked cross-cluster links with concrete files. */}
                        {insightBridgeCards.map((bridge, bridgeIdx) => {
                          const fileIds = bridge.bridgeFiles.map((f) => f?.id).filter(Boolean);
                          return (
                            <ActionCard
                              key={bridge.id}
                              icon={GitBranch}
                              headline={
                                <>
                                  {bridge.sourceLabel}{' '}
                                  <span className="text-system-gray-400">↔</span>{' '}
                                  {bridge.targetLabel}
                                </>
                              }
                              description={`${bridge.bridgeFiles.length} file${bridge.bridgeFiles.length === 1 ? '' : 's'} link both topic groups`}
                              verb="Group bridge files into folder"
                              onClick={() => handleGroupFiles(fileIds, { source: 'bridge' })}
                              secondary={
                                bridgeIdx === 0 && clusterInsights.crossEdges.length > 0
                                  ? {
                                      label: 'Explore all bridges',
                                      onClick: openBridgeAnalysis
                                    }
                                  : null
                              }
                            />
                          );
                        })}

                        {/* Near-duplicates — uses existing duplicate modal. */}
                        {insightSummary.nearDuplicates > 0 && (
                          <ActionCard
                            icon={Copy}
                            headline={`${insightSummary.nearDuplicates} near-duplicate file${insightSummary.nearDuplicates === 1 ? '' : 's'} detected`}
                            description={
                              duplicateSummary.groupCount > 0
                                ? `Across ${duplicateSummary.groupCount} group${duplicateSummary.groupCount === 1 ? '' : 's'}.`
                                : 'Likely duplicates of each other.'
                            }
                            verb="Review & dedupe"
                            onClick={() => {
                              handleFindDuplicates();
                              setIsDuplicateModalOpen(true);
                            }}
                          />
                        )}

                        {/* Organizational health — anchored ref kept so existing
                                "scroll into view" from elsewhere still lands here. */}
                        <div ref={organizationalHealthRef}>
                          <ActionCard
                            icon={Activity}
                            tone={
                              organizationalHealth.score >= 80
                                ? 'success'
                                : organizationalHealth.score >= 60
                                  ? 'default'
                                  : 'warning'
                            }
                            headline={`Grade ${organizationalHealth.grade} (${organizationalHealth.score})`}
                            description={
                              activeFindings.length === 0
                                ? 'No major organization issues detected.'
                                : `${activeFindings.length} active finding${activeFindings.length === 1 ? '' : 's'}.`
                            }
                            verb={activeFindings.length > 0 ? 'See findings' : null}
                            onClick={
                              activeFindings.length > 0
                                ? () => handleOrgFindingClick(activeFindings[0].key)
                                : null
                            }
                          />
                        </div>
                      </div>
                    )}
                  </SidebarSection>

                  <SidebarSection
                    icon={SearchIcon}
                    title="Add to graph"
                    isOpen={sidebarSections.addToGraph}
                    onToggle={() => toggleSidebarSection('addToGraph')}
                  >
                    <div className={`${GRAPH_SIDEBAR_CARD} space-y-3`}>
                      <SearchAutocomplete
                        value={query}
                        onChange={setQuery}
                        onSearch={runGraphSearch}
                        placeholder="Search files..."
                        ariaLabel="Search to add nodes"
                        className="bg-system-gray-100 shadow-sm"
                        showShortcutHint={false}
                      />
                      <div className="flex items-center justify-between gap-cozy">
                        <Text
                          as="label"
                          variant="tiny"
                          className="text-system-gray-600 flex items-center gap-compact select-none cursor-pointer"
                        >
                          {/* eslint-disable-next-line jsx-a11y/control-has-associated-label -- labelled by wrapping label at runtime; rule only inspects the control */}
                          <input
                            type="checkbox"
                            checked={addMode}
                            onChange={(e) => setAddMode(e.target.checked)}
                            className="h-4 w-4 rounded-md border-system-gray-300 text-stratosort-blue focus:ring-stratosort-blue/20"
                          />
                          Add to existing
                        </Text>
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={runGraphSearch}
                          disabled={query.trim().length < 2}
                          className="px-4 py-1.5 h-auto text-xs font-semibold shadow-sm"
                        >
                          Add
                        </Button>
                      </div>
                    </div>
                  </SidebarSection>

                  <SidebarSection
                    icon={Network}
                    title="Explore"
                    isOpen={sidebarSections.explore}
                    onToggle={() => toggleSidebarSection('explore')}
                  >
                    <div className={`${GRAPH_SIDEBAR_CARD} space-y-3`}>
                      <div>
                        <Text
                          as="label"
                          variant="tiny"
                          className="font-medium text-system-gray-700 mb-1.5 block"
                          title="Controls how files are grouped into clusters"
                        >
                          Group files by
                        </Text>
                        <Select
                          value={clusterMode}
                          onChange={(e) => setClusterMode(e.target.value)}
                          className="text-sm shadow-sm bg-system-gray-100"
                        >
                          <option value="topic">Topic (semantic)</option>
                          <option value="time">Time (recency)</option>
                          <option value="type">Type (file category)</option>
                          <option value="tag">Tag/Folder</option>
                        </Select>
                      </div>

                      {showClusters && clusterInsights.crossEdges.length > 0 && (
                        <Text
                          as="label"
                          variant="tiny"
                          className="flex items-center gap-compact text-system-gray-600 cursor-pointer select-none"
                        >
                          {/* eslint-disable-next-line jsx-a11y/control-has-associated-label -- labelled by wrapping label at runtime; rule only inspects the control */}
                          <input
                            type="checkbox"
                            checked={bridgeOverlayEnabled}
                            onChange={(e) => setBridgeOverlayEnabled(e.target.checked)}
                            className="h-4 w-4 rounded-md border-system-gray-300 text-stratosort-blue focus:ring-stratosort-blue/20"
                          />
                          <span>Topic bridges only (dim other links)</span>
                        </Text>
                      )}

                      {showClusters && clusterInsights.crossEdges.length > 0 && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="w-full text-xs"
                          onClick={openBridgeAnalysis}
                        >
                          Explore all topic bridges
                        </Button>
                      )}

                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full justify-between text-xs font-medium text-system-gray-700 bg-system-gray-100 border border-system-gray-200 rounded-lg px-3 py-2 hover:bg-system-gray-50"
                        onClick={() => setShowAdvancedFilters((prev) => !prev)}
                        aria-expanded={showAdvancedFilters}
                        aria-controls="advanced-cluster-filters"
                      >
                        <span>
                          {showAdvancedFilters ? 'Hide advanced filters' : 'Show advanced filters'}
                        </span>
                        <ChevronDown
                          className={`h-3.5 w-3.5 text-system-gray-400 transition-transform ${showAdvancedFilters ? 'rotate-180' : ''}`}
                        />
                      </Button>

                      {showAdvancedFilters && (
                        <div
                          id="advanced-cluster-filters"
                          className="mt-2 space-y-3 border border-system-gray-200 rounded-lg p-3 bg-system-gray-50/80"
                        >
                          <Text
                            as="div"
                            variant="tiny"
                            className="font-medium text-system-gray-600 mb-1.5"
                          >
                            Confidence Level
                          </Text>
                          <div className="flex flex-wrap gap-x-3 gap-y-1">
                            {['high', 'medium', 'low'].map((conf) => (
                              <Text
                                key={conf}
                                as="label"
                                variant="tiny"
                                className="flex items-center gap-1.5 text-system-gray-600 cursor-pointer"
                              >
                                {/* eslint-disable-next-line jsx-a11y/control-has-associated-label -- labelled by wrapping label at runtime; rule only inspects the control */}
                                <input
                                  type="checkbox"
                                  checked={clusterFilters.confidence.includes(conf)}
                                  onChange={(e) =>
                                    setClusterFilters((prev) => {
                                      const current = prev.confidence;
                                      const next = e.target.checked
                                        ? Array.from(new Set([...current, conf]))
                                        : current.filter((c) => c !== conf);
                                      return { ...prev, confidence: next };
                                    })
                                  }
                                  className="h-4 w-4 rounded-md border-system-gray-300 text-stratosort-blue focus:ring-stratosort-blue/20"
                                />
                                <span className="capitalize">{conf}</span>
                              </Text>
                            ))}
                          </div>

                          <div className="grid grid-cols-2 gap-cozy">
                            <div>
                              <Text
                                as="label"
                                variant="tiny"
                                className="font-medium text-system-gray-600 mb-1.5 block"
                              >
                                Min size
                              </Text>
                              <Input
                                type="number"
                                min={1}
                                value={clusterFilters.minSize}
                                onChange={(e) =>
                                  setClusterFilters((prev) => ({
                                    ...prev,
                                    minSize: Math.max(1, Number(e.target.value) || 1)
                                  }))
                                }
                                className="h-8 text-sm bg-system-gray-100"
                              />
                            </div>

                            <div>
                              <Text
                                as="label"
                                variant="tiny"
                                className="font-medium text-system-gray-600 mb-1.5 block"
                              >
                                File type
                              </Text>
                              <Select
                                value={clusterFilters.fileType}
                                onChange={(e) =>
                                  setClusterFilters((prev) => ({
                                    ...prev,
                                    fileType: e.target.value
                                  }))
                                }
                                className="h-8 text-sm bg-system-gray-100"
                              >
                                <option value="all">All</option>
                                <option value="document">Document</option>
                                <option value="spreadsheet">Spreadsheet</option>
                                <option value="code">Code</option>
                                <option value="image">Image</option>
                                <option value="audio">Audio</option>
                                <option value="video">Video</option>
                              </Select>
                            </div>
                          </div>

                          <Input
                            value={clusterFilters.search}
                            onChange={(e) =>
                              setClusterFilters((prev) => ({
                                ...prev,
                                search: e.target.value
                              }))
                            }
                            placeholder="Search clusters..."
                            className="h-8 text-sm bg-system-gray-100"
                          />
                        </div>
                      )}
                    </div>
                  </SidebarSection>

                  <SidebarSection
                    icon={List}
                    title="Actions"
                    isOpen={sidebarSections.actions}
                    onToggle={() => toggleSidebarSection('actions')}
                  >
                    <div className={`${GRAPH_SIDEBAR_CARD} space-y-3`}>
                      <div className="space-y-2.5">
                        <Button
                          variant={showClusters ? 'primary' : 'secondary'}
                          size="sm"
                          onClick={loadClusters}
                          disabled={isComputingClusters}
                          className="w-full justify-center h-9 text-xs font-semibold shadow-sm"
                          title="Group similar files into clusters"
                          aria-label={
                            isComputingClusters
                              ? 'Computing clusters'
                              : showClusters
                                ? 'Refresh clusters'
                                : 'Auto-discover clusters'
                          }
                        >
                          <Layers className="h-4 w-4" />
                          <span>
                            {isComputingClusters
                              ? 'Computing...'
                              : showClusters
                                ? 'Refresh clusters'
                                : 'Auto-discover Clusters'}
                          </span>
                        </Button>

                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={applyLayout}
                          disabled={nodes.length === 0 || isLayouting}
                          className="w-full justify-center h-9 text-xs font-semibold shadow-sm"
                          title="Organize nodes automatically"
                          aria-label={isLayouting ? 'Organizing layout' : 'Re-organize layout'}
                        >
                          <LayoutGrid className="h-4 w-4" />
                          <span>{isLayouting ? 'Organizing...' : 'Re-organize Layout'}</span>
                        </Button>
                      </div>

                      {showClusters && (
                        <div className="pt-3 border-t border-system-gray-100 flex gap-compact">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleExpandAllClusters}
                            disabled={
                              nodes.filter(
                                (n) =>
                                  n.type === 'clusterNode' &&
                                  n.data?.kind === 'cluster' &&
                                  !n.data?.expanded
                              ).length === 0
                            }
                            className="flex-1 justify-center text-xs h-8"
                            title="Expand all clusters"
                            aria-label="Expand all clusters"
                          >
                            <Maximize2 className="h-3.5 w-3.5" />
                            <span>Expand all</span>
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleCollapseAllClusters}
                            disabled={
                              nodes.filter(
                                (n) =>
                                  n.type === 'clusterNode' &&
                                  n.data?.kind === 'cluster' &&
                                  n.data?.expanded
                              ).length === 0
                            }
                            className="flex-1 justify-center text-xs h-8"
                            title="Collapse all clusters"
                            aria-label="Collapse all clusters"
                          >
                            <Minimize2 className="h-3.5 w-3.5" />
                            <span>Collapse all</span>
                          </Button>
                        </div>
                      )}

                      {focusNodeId && (
                        <div className="pt-3 border-t border-system-gray-100">
                          <div className="bg-stratosort-indigo/10 border border-stratosort-indigo/30 rounded-lg p-3 space-y-2">
                            <div className="flex items-center justify-between">
                              <Text
                                as="span"
                                variant="tiny"
                                className="font-medium text-stratosort-indigo"
                              >
                                Focus Mode Active
                              </Text>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={handleClearFocus}
                                className="text-xs text-stratosort-indigo hover:bg-stratosort-indigo/10 px-2 py-0.5 h-auto"
                              >
                                Show Full Graph
                              </Button>
                            </div>
                            <div>
                              <Text
                                as="label"
                                variant="tiny"
                                className="font-medium text-stratosort-indigo mb-1.5 block"
                              >
                                Focus Depth
                              </Text>
                              <Select
                                value={focusDepth}
                                onChange={(e) => setFocusDepth(Number(e.target.value))}
                                className="text-sm text-stratosort-indigo"
                              >
                                <option value={0}>Only selected</option>
                                <option value={1}>1 level (Direct)</option>
                                <option value={2}>2 levels</option>
                                <option value={3}>3 levels (Deep)</option>
                              </Select>
                            </div>
                          </div>
                        </div>
                      )}

                      <div className="pt-3 border-t border-system-gray-100">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (nodes.length > 0) {
                              setShowClearConfirm(true);
                            }
                          }}
                          disabled={nodes.length === 0}
                          className="w-full justify-center text-stratosort-danger border border-stratosort-danger/20 bg-stratosort-danger/5 hover:bg-stratosort-danger/10 hover:text-stratosort-danger"
                        >
                          Clear Graph
                        </Button>
                      </div>
                    </div>
                  </SidebarSection>

                  <SidebarSection
                    icon={Filter}
                    title="Filters"
                    isOpen={sidebarSections.filters}
                    onToggle={() => toggleSidebarSection('filters')}
                  >
                    <div className={`${GRAPH_SIDEBAR_CARD} space-y-3`}>
                      <ClusterLegend
                        compact={false}
                        showHeader={false}
                        className="shadow-none border-none p-0 bg-transparent w-full"
                        activeFilters={activeFilters}
                        onToggleFilter={handleToggleFilter}
                      />
                    </div>
                  </SidebarSection>

                  <SidebarSection
                    icon={CheckSquare}
                    title="Advanced"
                    isOpen={sidebarSections.advanced}
                    onToggle={() => toggleSidebarSection('advanced')}
                  >
                    <div className={`${GRAPH_SIDEBAR_CARD} space-y-4`}>
                      <div>
                        <Text
                          as="label"
                          variant="tiny"
                          className="font-medium text-system-gray-600 mb-1.5 block"
                          title="Dims unrelated nodes and highlights the best matches"
                        >
                          Search within graph
                        </Text>
                        <Input
                          id="graph-within-filter-input"
                          aria-label="Search within graph nodes"
                          value={withinQuery}
                          onChange={(e) => setWithinQuery(e.target.value)}
                          placeholder="Highlight matching nodes..."
                          className="h-8 text-sm bg-system-gray-100"
                        />
                      </div>

                      <div>
                        <Text
                          as="label"
                          variant="tiny"
                          className="font-medium text-system-gray-600 mb-1.5 block"
                        >
                          Connection Depth
                        </Text>
                        <Select
                          value={hopCount}
                          onChange={(e) => {
                            const val = Number(e.target.value);
                            setHopCount(val);
                            const labels = {
                              1: 'Direct',
                              2: '2 levels',
                              3: 'Deep (3 levels)'
                            };
                            setGraphStatus(
                              `Connection depth set to ${labels[val] || val}. Double-click a node to explore.`
                            );
                          }}
                          className="text-sm bg-system-gray-100"
                        >
                          <option value={1}>1 level (Direct)</option>
                          <option value={2}>2 levels</option>
                          <option value={3}>3 levels (Deep)</option>
                        </Select>
                      </div>

                      <div className="space-y-2 pt-1">
                        <Text
                          as="label"
                          variant="tiny"
                          className="text-system-gray-600 flex items-center gap-compact select-none cursor-pointer"
                        >
                          {/* eslint-disable-next-line jsx-a11y/control-has-associated-label -- labelled by wrapping label at runtime; rule only inspects the control */}
                          <input
                            type="checkbox"
                            checked={autoLayout}
                            onChange={(e) => setAutoLayout(e.target.checked)}
                            className="h-4 w-4 rounded-md border-system-gray-300 text-stratosort-blue focus:ring-stratosort-blue/20"
                          />
                          Auto-layout on changes
                        </Text>

                        <Text
                          as="label"
                          variant="tiny"
                          className="text-system-gray-600 flex items-center gap-compact select-none cursor-pointer"
                        >
                          {/* eslint-disable-next-line jsx-a11y/control-has-associated-label -- labelled by wrapping label at runtime; rule only inspects the control */}
                          <input
                            type="checkbox"
                            checked={showEdgeLabels}
                            onChange={(e) => setShowEdgeLabels(e.target.checked)}
                            className="h-4 w-4 rounded-md border-system-gray-300 text-stratosort-blue focus:ring-stratosort-blue/20"
                          />
                          Show connection labels
                        </Text>
                      </div>

                      <div className="pt-2 mt-2 border-t border-system-gray-100 flex gap-compact">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={handleSaveGraph}
                          className="flex-1 justify-center h-8 text-xs"
                        >
                          Save State
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={handleLoadGraph}
                          className="flex-1 justify-center h-8 text-xs"
                        >
                          Load State
                        </Button>
                      </div>

                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleFindDuplicates}
                        className="w-full justify-center h-8 text-xs"
                        aria-label="Find duplicates"
                      >
                        <Copy className="h-3.5 w-3.5" />
                        <span>Find duplicates</span>
                      </Button>
                    </div>
                  </SidebarSection>

                  {/* Status Footer */}
                  <Text
                    as="div"
                    variant="tiny"
                    className="mt-auto pt-4 text-system-gray-400 border-t border-system-gray-100"
                  >
                    Tip: use <span className="font-mono text-system-gray-500">?</span> for graph
                    help.
                  </Text>
                </div>
              </div>
            )}

            {/* Center: Graph */}
            {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- graph keyboard focus target (J-001); drag-drop has picker alternative; U-T14 tracks full keyboard design */}
            <div
              className={`surface-panel p-0 overflow-hidden min-h-[40vh] lg:min-h-[52vh] rounded-xl border relative flex flex-col [transition-property:background-color,border-color,box-shadow] [transition-duration:var(--motion-duration-standard)] [transition-timing-function:var(--motion-ease-standard)] ${
                isGraphMaximized ? 'shadow-lg ring-1 ring-system-gray-200' : ''
              } ${
                isDragOver
                  ? 'border-stratosort-blue border-2 bg-stratosort-blue/5 ring-4 ring-stratosort-blue/20'
                  : 'border-system-gray-200'
              } focus:outline-none focus-visible:ring-2 focus-visible:ring-stratosort-blue/40`}
              role="main"
              aria-label="Graph visualization"
              ref={graphContainerRef}
              tabIndex={0}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleFileDrop}
            >
              {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
              {/* InsightDock: always-visible headline strip of the most
                        useful insights, sitting directly above the canvas so
                        they're easy to find. Collapsible to reclaim space. */}
              {!isGraphMaximized && nodes.length > 0 && !insightDockCollapsed && (
                <div className="flex items-stretch shrink-0 border-b border-system-gray-200 bg-system-gray-100/90">
                  <div className="min-w-0 flex-1">
                    <InsightDock
                      insightSummary={insightSummary}
                      organizationalHealth={organizationalHealth}
                      duplicateSummary={duplicateSummary}
                      onStatClick={handleDockStatClick}
                      onHealthClick={handleDockHealthClick}
                      onTriageClick={() => setIsDownloadsTriageOpen(true)}
                      className="border-0"
                    />
                  </div>
                  <div className="flex items-center px-2 border-l border-system-gray-200 shrink-0">
                    <IconButton
                      onClick={() => dispatch(setGraphInsightsDockCollapsed(true))}
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 text-system-gray-500 hover:text-system-gray-800"
                      title="Hide insights strip"
                      aria-label="Hide insights strip"
                      icon={<ChevronUp className="w-4 h-4" />}
                    />
                  </div>
                </div>
              )}
              {!isGraphMaximized && nodes.length > 0 && insightDockCollapsed && (
                <div className="flex items-center justify-between shrink-0 border-b border-system-gray-200 bg-system-gray-100/90 px-3 py-1.5">
                  <Text as="span" variant="tiny" className="text-system-gray-500">
                    Insights hidden
                  </Text>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => dispatch(setGraphInsightsDockCollapsed(false))}
                    leftIcon={<ChevronDown className="w-3 h-3" />}
                  >
                    Show insights
                  </Button>
                </div>
              )}
              {!isGraphMaximized && (
                <div
                  className="flex items-center justify-end gap-compact shrink-0 border-b border-system-gray-200 bg-system-gray-100/90 px-2 py-2 min-h-[3rem]"
                  role="toolbar"
                  aria-label="Graph view options"
                >
                  {nodes.length > 0 && (
                    <div className="mr-auto flex items-center gap-compact text-xs text-system-gray-500">
                      <span>
                        <span className="font-semibold text-system-gray-700">{nodes.length}</span>{' '}
                        nodes
                      </span>
                      <span className="w-px h-3 bg-system-gray-300" />
                      <span>
                        <span className="font-semibold text-system-gray-700">{edges.length}</span>{' '}
                        links
                      </span>
                    </div>
                  )}
                  {nodes.some((n) => n.data?.kind === 'cluster') && (
                    <Button
                      onClick={() => setShowClusters(!showClusters)}
                      variant="secondary"
                      size="sm"
                      leftIcon={<Layers className="w-4 h-4" />}
                      aria-label={showClusters ? 'Hide clusters' : 'Show clusters'}
                      className={`h-8 px-2 shadow-sm ${
                        showClusters
                          ? 'bg-stratosort-accent/10 border-stratosort-accent/30 text-stratosort-accent hover:bg-stratosort-accent/20'
                          : 'bg-system-gray-100/90 border-border-soft text-system-gray-600 hover:text-system-gray-800 hover:bg-system-gray-100'
                      }`}
                      title={
                        showClusters
                          ? 'Hide clusters (simplify view)'
                          : 'Show clusters (reveal structure)'
                      }
                    >
                      <Text as="span" variant="tiny" className="font-medium hidden sm:inline">
                        {showClusters ? 'Clusters on' : 'Clusters off'}
                      </Text>
                    </Button>
                  )}
                  <IconButton
                    onClick={() => setShowTourManually(true)}
                    size="sm"
                    variant="secondary"
                    className="h-8 w-8 border-border-soft bg-system-gray-100/90 text-system-gray-600 hover:bg-system-gray-100 hover:text-stratosort-blue"
                    title="Show graph tour"
                    aria-label="Show graph tour"
                    icon={<HelpCircle className="w-4 h-4" />}
                  />
                  <IconButton
                    onClick={() => {
                      setIsGraphMaximized((prev) => !prev);
                      if (graphFitViewTimeoutRef.current) {
                        clearTimeout(graphFitViewTimeoutRef.current);
                      }
                      graphFitViewTimeoutRef.current = setTimeout(() => {
                        reactFlowInstance.current?.fitView(
                          getDefaultGraphFitViewOptions({ duration: 800 })
                        );
                        graphFitViewTimeoutRef.current = null;
                      }, 300);
                    }}
                    size="sm"
                    variant="secondary"
                    className="h-8 w-8 border-border-soft bg-system-gray-100/90 text-system-gray-600 hover:bg-system-gray-100 hover:text-system-gray-900"
                    title="Maximize graph view"
                    aria-label="Maximize graph view"
                    icon={<Maximize2 className="w-4 h-4" />}
                  />
                </div>
              )}
              {isGraphMaximized && (
                <div className="absolute top-3 left-3 z-[21]">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="h-8 text-xs shadow-sm"
                    onClick={() => {
                      setIsGraphMaximized(false);
                      dispatch(setGraphInsightsSection('insights'));
                      if (graphFitViewTimeoutRef.current) {
                        clearTimeout(graphFitViewTimeoutRef.current);
                      }
                      graphFitViewTimeoutRef.current = setTimeout(() => {
                        reactFlowInstance.current?.fitView(
                          getDefaultGraphFitViewOptions({ duration: 800 })
                        );
                        graphFitViewTimeoutRef.current = null;
                      }, 300);
                    }}
                  >
                    Show insights
                  </Button>
                </div>
              )}
              {/* Graph controls when full-screen (insight bar hidden) */}
              {isGraphMaximized && (
                <div className="absolute top-3 right-3 z-20 flex flex-wrap justify-end gap-compact max-w-[calc(100%-6rem)]">
                  {nodes.length > 0 && (
                    <div className="flex items-center gap-compact rounded-lg border border-border-soft bg-system-gray-100/90 px-3 py-1.5 shadow-sm">
                      <Text as="span" variant="tiny" className="font-medium text-system-gray-600">
                        {nodes.length} nodes
                      </Text>
                      <span className="w-px h-3 bg-system-gray-300" />
                      <Text as="span" variant="tiny" className="font-medium text-system-gray-600">
                        {edges.length} links
                      </Text>
                    </div>
                  )}
                  {nodes.some((n) => n.data?.kind === 'cluster') && (
                    <Button
                      onClick={() => setShowClusters(!showClusters)}
                      variant="secondary"
                      size="sm"
                      leftIcon={<Layers className="w-4 h-4" />}
                      aria-label={showClusters ? 'Hide clusters' : 'Show clusters'}
                      className={`h-8 px-2 shadow-sm ${
                        showClusters
                          ? 'bg-stratosort-accent/10 border-stratosort-accent/30 text-stratosort-accent hover:bg-stratosort-accent/20'
                          : 'bg-system-gray-100/90 border-border-soft text-system-gray-600 hover:text-system-gray-800 hover:bg-system-gray-100'
                      }`}
                      title={
                        showClusters
                          ? 'Hide clusters (simplify view)'
                          : 'Show clusters (reveal structure)'
                      }
                    >
                      <Text as="span" variant="tiny" className="font-medium hidden sm:inline">
                        {showClusters ? 'Clusters on' : 'Clusters off'}
                      </Text>
                    </Button>
                  )}
                  <IconButton
                    onClick={() => setIsDownloadsTriageOpen(true)}
                    size="sm"
                    variant="secondary"
                    className="h-8 w-8 border-border-soft bg-system-gray-100/90 text-system-gray-600 hover:bg-system-gray-100 hover:text-stratosort-blue"
                    title="Triage Downloads folder"
                    aria-label="Triage Downloads folder"
                    icon={<Inbox className="w-4 h-4" />}
                  />
                  <IconButton
                    onClick={() => setShowTourManually(true)}
                    size="sm"
                    variant="secondary"
                    className="h-8 w-8 border-border-soft bg-system-gray-100/90 text-system-gray-600 hover:bg-system-gray-100 hover:text-stratosort-blue"
                    title="Show graph tour"
                    aria-label="Show graph tour"
                    icon={<HelpCircle className="w-4 h-4" />}
                  />
                  <IconButton
                    onClick={() => {
                      setIsGraphMaximized((prev) => !prev);
                      if (graphFitViewTimeoutRef.current) {
                        clearTimeout(graphFitViewTimeoutRef.current);
                      }
                      graphFitViewTimeoutRef.current = setTimeout(() => {
                        reactFlowInstance.current?.fitView(
                          getDefaultGraphFitViewOptions({ duration: 800 })
                        );
                        graphFitViewTimeoutRef.current = null;
                      }, 300);
                    }}
                    size="sm"
                    variant="secondary"
                    className="h-8 w-8 border-border-soft bg-system-gray-100/90 text-system-gray-600 hover:bg-system-gray-100 hover:text-system-gray-900"
                    title="Exit full view"
                    aria-label="Exit full view"
                    icon={<Minimize2 className="w-4 h-4" />}
                  />
                </div>
              )}

              {/* Drag overlay indicator */}
              {isDragOver && (
                <div className="absolute inset-0 z-30 flex items-center justify-center bg-stratosort-blue/10 pointer-events-none animate-loading-fade">
                  <div className="bg-system-gray-100 rounded-xl shadow-xl px-8 py-6 flex flex-col items-center gap-cozy border-2 border-stratosort-blue border-dashed">
                    <div className="w-12 h-12 rounded-full bg-stratosort-blue/10 flex items-center justify-center">
                      <FolderPlus className="w-6 h-6 text-stratosort-blue" />
                    </div>
                    <Text variant="small" className="font-medium text-system-gray-900">
                      Drop files to add to graph
                    </Text>
                    <Text variant="tiny" className="text-system-gray-500">
                      Files must be indexed first
                    </Text>
                  </div>
                </div>
              )}

              {nodes.length === 0 ? (
                <div className="flex flex-col items-center justify-center flex-1 min-h-0 overflow-y-auto text-center p-8 animate-loading-content">
                  <div className="w-20 h-20 bg-system-gray-50 rounded-full flex items-center justify-center mb-6">
                    <Network className="w-10 h-10 text-stratosort-blue opacity-50" />
                  </div>

                  {stats?.files === 0 ? (
                    <div className="max-w-md">
                      <Heading as="h3" variant="h4" className="mb-2">
                        Your files already know things you do not.
                      </Heading>
                      <Text
                        variant="small"
                        className="text-system-gray-500 max-w-md mb-6 leading-relaxed"
                      >
                        Point StratoSort at a folder to discover hidden connections, duplicate work,
                        and organization gaps.
                      </Text>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={handleOpenSettings}
                        className="mx-auto justify-center px-4 py-2"
                        aria-label="Point StratoSort at a folder"
                      >
                        <FolderPlus className="h-4 w-4" />
                        <span>Point StratoSort at a folder</span>
                      </Button>
                    </div>
                  ) : (
                    <>
                      <Heading as="h3" variant="h4" className="mb-2">
                        Stop Searching. Start Finding.
                      </Heading>
                      <Text
                        variant="small"
                        className="text-system-gray-500 max-w-md mb-8 leading-relaxed"
                      >
                        Your files are scattered across folders. Clustering reveals how they
                        naturally belong together-even files you forgot you had. For a
                        bird&apos;s-eye map of everything at once, the Atlas tab is a great
                        companion view.
                      </Text>

                      {/* Inline Search for Empty State */}
                      <div className="w-full max-w-sm mb-8 relative z-10">
                        <div className="relative group">
                          {/* eslint-disable jsx-a11y/no-autofocus -- deliberate initial focus per WAI-ARIA dialog pattern */}
                          <SearchAutocomplete
                            value={query}
                            onChange={setQuery}
                            onSearch={runGraphSearch}
                            placeholder="Search for files to start..."
                            className="shadow-md border-transparent bg-system-gray-100/80 backdrop-blur-sm rounded-2xl focus-within:border-stratosort-blue/50 focus-within:shadow-lg focus-within:ring-0 [transition-property:background-color,border-color,box-shadow] [transition-duration:var(--motion-duration-standard)] [transition-timing-function:var(--motion-ease-standard)]"
                            autoFocus
                          />
                          {/* eslint-enable jsx-a11y/no-autofocus */}
                        </div>
                        <Text
                          as="div"
                          variant="tiny"
                          className="text-system-gray-400 mt-2 flex justify-center gap-default"
                        >
                          <span>or drag files here from the list</span>
                        </Text>
                      </div>
                    </>
                  )}

                  {/* Quick start options */}
                  {stats?.files > 0 && (
                    <div className="flex flex-col gap-compact mb-8 w-full max-w-xs">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={loadClusters}
                        disabled={isComputingClusters}
                        className="w-full justify-center bg-system-gray-100 border border-system-gray-200 hover:bg-system-gray-50 text-system-gray-700 shadow-sm"
                        aria-label={
                          isComputingClusters ? 'Analyzing relationships' : 'Show clusters'
                        }
                      >
                        <Layers className="h-4 w-4 text-stratosort-blue" />
                        <span>
                          {isComputingClusters
                            ? 'Analyzing relationships...'
                            : 'Discover how your files connect'}
                        </span>
                      </Button>
                    </div>
                  )}

                  <Text
                    as="div"
                    variant="tiny"
                    className="grid grid-cols-2 gap-x-8 gap-y-3 text-system-gray-400 max-w-md border-t border-system-gray-100 pt-6"
                  >
                    <div className="flex items-center gap-compact">
                      <kbd className="px-1.5 py-0.5 rounded-md bg-system-gray-100 border border-system-gray-200 font-mono text-system-gray-600">
                        Click
                      </kbd>
                      <span>to select nodes</span>
                    </div>
                    <div className="flex items-center gap-compact">
                      <kbd className="px-1.5 py-0.5 rounded-md bg-system-gray-100 border border-system-gray-200 font-mono text-system-gray-600">
                        Double-click
                      </kbd>
                      <span>to expand</span>
                    </div>
                    <div className="flex items-center gap-compact">
                      <kbd className="px-1.5 py-0.5 rounded-md bg-system-gray-100 border border-system-gray-200 font-mono text-system-gray-600">
                        Drag
                      </kbd>
                      <span>to pan the canvas</span>
                    </div>
                    <div className="flex items-center gap-compact">
                      <kbd className="px-1.5 py-0.5 rounded-md bg-system-gray-100 border border-system-gray-200 font-mono text-system-gray-600">
                        ?
                      </kbd>
                      <span>for graph help</span>
                    </div>
                  </Text>
                </div>
              ) : (
                <div className="flex-1 min-h-0 relative w-full">
                  <GraphActionsContext.Provider value={graphActionsContextValue}>
                    <style>
                      {`
                      .graph-zoomed-out .file-node-label,
                      .graph-zoomed-out .react-flow__edgelabel-renderer > div {
                        opacity: 0;
                        pointer-events: none;
                        transition: opacity var(--motion-duration-fast) var(--motion-ease-standard);
                      }

                      .graph-zoomed-mid .file-node-label {
                        opacity: 0.6;
                        transition: opacity var(--motion-duration-fast) var(--motion-ease-standard);
                      }

                      .graph-zoomed-mid .react-flow__edgelabel-renderer > div {
                        opacity: 0.5;
                        transition: opacity var(--motion-duration-fast) var(--motion-ease-standard);
                      }

                      /* Hide connection handles (dots) for now */
                      .graph-flow .react-flow__handle {
                        opacity: 0;
                        pointer-events: none;
                      }

                      /* Theme-aware MiniMap surface (kept in sync with
                         GRAPH_MINIMAP_STYLE / GRAPH_MINIMAP_MASK_COLOR;
                         !important beats React Flow's inline defaults) */
                      .react-flow__minimap {
                        background-color: var(--surface-panel-bg) !important;
                        border: 1px solid var(--border-soft) !important;
                        border-radius: 12px !important;
                        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1) !important;
                      }
                      .react-flow__minimap-mask {
                        fill: color-mix(in srgb, var(--surface-muted) 78%, transparent) !important;
                        stroke: color-mix(in srgb, var(--color-stratosort-blue) 70%, transparent) !important;
                        stroke-width: 1.5px !important;
                      }
                    `}
                    </style>
                    <ReactFlow
                      nodes={rfNodes}
                      edges={rfEdges}
                      nodeTypes={GRAPH_VIEW_NODE_TYPES}
                      edgeTypes={GRAPH_VIEW_EDGE_TYPES}
                      onError={handleReactFlowError}
                      onNodesChange={onNodesChange}
                      onEdgesChange={graphActions.onEdgesChange}
                      className={`graph-flow bg-[var(--surface-muted)] ${
                        zoomBucket === 'far'
                          ? 'graph-zoomed-out'
                          : zoomBucket === 'mid' && !graphReadabilityProfile.isSmall
                            ? 'graph-zoomed-mid'
                            : ''
                      }`}
                      onNodeClick={onNodeClick}
                      onNodeDoubleClick={onNodeDoubleClick}
                      onEdgeClick={onEdgeClick}
                      onNodeContextMenu={onNodeContextMenu}
                      onPaneClick={closeContextMenu}
                      onNodeMouseEnter={onNodeMouseEnter}
                      onNodeMouseLeave={onNodeMouseLeave}
                      onInit={(instance) => {
                        reactFlowInstance.current = instance;
                        // fitView runs async on mount; sync zoom bucket once it settles.
                        requestAnimationFrame(() => {
                          syncGraphZoomFromViewport();
                        });
                      }}
                      onMove={handleGraphMove}
                      fitView
                      fitViewOptions={rfFitViewOptions}
                      minZoom={0.2}
                      maxZoom={2}
                      zoomOnScroll
                      panOnScroll={false}
                      defaultViewport={rfDefaultViewport}
                      proOptions={rfProOptions}
                    >
                      <Background color="rgba(196, 221, 233, 0.18)" gap={16} />
                      <MiniMap
                        pannable
                        zoomable
                        nodeColor={miniMapNodeColor}
                        position="bottom-right"
                        style={GRAPH_MINIMAP_STYLE}
                        maskColor={GRAPH_MINIMAP_MASK_COLOR}
                        maskStrokeColor={GRAPH_MINIMAP_MASK_STROKE_COLOR}
                        maskStrokeWidth={1.5}
                      />
                      <Controls showInteractive={false} />

                      {/* Floating mini-legend when fully maximized, so the
                              key stays reachable even with side panels hidden. */}
                      {isGraphMaximized && (
                        <Panel position="bottom-right" className="pointer-events-auto">
                          <div className="rounded-xl border border-border-soft bg-system-gray-100/95 shadow-lg p-2 max-w-[260px]">
                            <Text
                              as="div"
                              variant="tiny"
                              className="font-semibold text-system-gray-700 uppercase tracking-wider px-1 pb-1"
                            >
                              Legend
                            </Text>
                            <ClusterLegend
                              compact
                              showHeader={false}
                              className="text-system-gray-600"
                              activeFilters={activeFilters}
                              onToggleFilter={handleToggleFilter}
                            />
                          </div>
                        </Panel>
                      )}

                      {/* Active filter chips (top-left) */}
                      {hasGraphFilterIndicators && (
                        <Panel position="top-left" className="pointer-events-auto">
                          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border-soft bg-system-gray-100/90 px-2 py-1 shadow-sm">
                            {clusterMode !== DEFAULT_CLUSTER_MODE && (
                              <span
                                className="px-2 py-0.5 rounded-full bg-system-gray-50 border border-system-gray-200 text-xs text-system-gray-600"
                                title="How files are grouped into clusters"
                              >
                                Grouped by {CLUSTER_MODE_CHIP_LABELS[clusterMode] || clusterMode}
                              </span>
                            )}
                            {bridgeOverlayEnabled && (
                              <span className="px-2 py-0.5 rounded-full bg-stratosort-accent/10 border border-stratosort-accent/30 text-xs text-stratosort-accent">
                                Bridges only
                              </span>
                            )}
                            {activeClusterFilterChips.map((chip) => (
                              <span
                                key={`cluster-${chip}`}
                                className="px-2 py-0.5 rounded-full bg-system-gray-50 border border-system-gray-200 text-xs text-system-gray-600"
                              >
                                {chip}
                              </span>
                            ))}
                            {activeGraphFilterChips.map((chip) => (
                              <span
                                key={`graph-${chip}`}
                                className="px-2 py-0.5 rounded-full bg-system-gray-50 border border-system-gray-200 text-xs text-system-gray-600"
                              >
                                {chip}
                              </span>
                            ))}
                            <Button variant="ghost" size="xs" onClick={resetGraphFilters}>
                              Reset
                            </Button>
                          </div>
                        </Panel>
                      )}

                      {/* Zoom Level Indicator */}
                      {zoomBucket === 'far' && (
                        <Text
                          as="div"
                          variant="tiny"
                          className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-system-gray-50/90 backdrop-blur-md !text-system-gray-900 px-4 py-2 rounded-full shadow-lg pointer-events-none z-50 border border-border-soft animate-slide-up"
                        >
                          Labels hidden at this zoom • Use (+/-) to zoom in
                        </Text>
                      )}
                      {zoomBucket === 'mid' && !graphReadabilityProfile.isSmall && (
                        <Text
                          as="div"
                          variant="tiny"
                          className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-system-gray-100/90 backdrop-blur-md text-system-gray-700 px-3 py-1.5 rounded-full shadow-sm pointer-events-none z-50 border border-system-gray-200 animate-fade-in"
                        >
                          {graphReadabilityProfile.isDense
                            ? 'Dense graph simplified for readability'
                            : 'Connections softened while zoomed out for clarity'}
                        </Text>
                      )}

                      {/* Keyboard shortcuts hint (subtle, bottom-left) */}
                      {nodes.length > 0 && zoomBucket !== 'far' && (
                        <Text
                          as="div"
                          variant="tiny"
                          className="absolute bottom-3 left-3 text-system-gray-400 pointer-events-none z-10 flex items-center gap-1.5"
                        >
                          <kbd className="px-1 py-0.5 rounded-md bg-system-gray-100/80 border border-system-gray-200 text-system-gray-500 font-mono shadow-sm">
                            ?
                          </kbd>
                          <span>for help</span>
                        </Text>
                      )}

                      {/* Performance notice (auto-hide) */}
                      {performanceNotice && (
                        <Text
                          as="div"
                          variant="tiny"
                          className="absolute top-4 left-1/2 -translate-x-1/2 bg-system-gray-50/90 backdrop-blur-md !text-system-gray-900 px-3 py-1.5 rounded-full shadow-md pointer-events-none z-40 border border-border-soft animate-slide-down"
                        >
                          {performanceNotice}
                        </Text>
                      )}
                      {graphStatus && (
                        <Text
                          as="div"
                          variant="tiny"
                          className="absolute top-14 left-1/2 -translate-x-1/2 bg-system-gray-100/95 text-system-gray-700 px-3 py-1.5 rounded-full shadow-sm pointer-events-none z-40 border border-system-gray-200 animate-fade-in"
                        >
                          {graphStatus}
                        </Text>
                      )}
                      {isLoadingRecommendations && (
                        <Text
                          as="div"
                          variant="tiny"
                          className="absolute bottom-4 right-4 flex items-center gap-1.5 bg-system-gray-100/95 text-system-gray-500 px-3 py-1.5 rounded-full shadow-sm pointer-events-none z-40 border border-system-gray-200 animate-fade-in"
                        >
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Loading folder suggestions…
                        </Text>
                      )}
                    </ReactFlow>
                  </GraphActionsContext.Provider>
                </div>
              )}
            </div>

            {/* Right: Details & Legend */}
            {!isGraphMaximized && (
              <div
                className="surface-panel p-0 flex flex-col h-full min-h-0 overflow-hidden"
                role="complementary"
                aria-label="Node details"
              >
                <div className="px-4 py-3 border-b border-system-gray-100 bg-system-gray-50/50">
                  <div className="flex items-center justify-between gap-compact">
                    <Text as="div" variant="tiny" className={GRAPH_SIDEBAR_SECTION_TITLE}>
                      <Sparkles className="h-3.5 w-3.5 text-stratosort-blue" aria-hidden="true" />
                      <span>{selectedNode ? 'Node details' : 'Legend'}</span>
                    </Text>
                    {selectedNode ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => graphActions.selectNode(null)}
                      >
                        Back to Legend
                      </Button>
                    ) : null}
                  </div>
                </div>

                <div className="p-3 pb-6 flex-1 min-h-0 overflow-y-auto panel-scroll">
                  {selectedNode ? (
                    <>
                      <div className={`${GRAPH_SIDEBAR_CARD} mb-4 bg-system-gray-50/80`}>
                        <div className="flex items-center justify-between text-xs">
                          <Text
                            as="span"
                            variant="tiny"
                            className="font-semibold text-system-gray-700"
                          >
                            Selection overview
                          </Text>
                          <Text
                            as="span"
                            variant="tiny"
                            className="text-system-gray-500 capitalize"
                          >
                            {selectedKind || 'node'}
                          </Text>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-compact text-center">
                          <div className="rounded-md border border-system-gray-200 bg-system-gray-100 px-2 py-1.5">
                            <Text
                              as="div"
                              variant="tiny"
                              className="font-semibold text-system-gray-800"
                            >
                              {selectedNodeConnectionCount}
                            </Text>
                            <Text as="div" variant="tiny" className="text-system-gray-500">
                              Links
                            </Text>
                          </div>
                          <div className="rounded-md border border-system-gray-200 bg-system-gray-100 px-2 py-1.5">
                            <Text
                              as="div"
                              variant="tiny"
                              className="font-semibold text-system-gray-800"
                            >
                              {selectedNodeNeighbors.length}
                            </Text>
                            <Text as="div" variant="tiny" className="text-system-gray-500">
                              Neighbors
                            </Text>
                          </div>
                        </div>
                      </div>

                      {isLoadingMetadata ? (
                        /* Skeleton loading state */
                        <div className="animate-pulse space-y-4">
                          <div className="h-4 bg-system-gray-200 rounded-md w-3/4" />
                          <div className="h-3 bg-system-gray-200 rounded-md w-full" />
                          <div className="h-3 bg-system-gray-200 rounded-md w-1/2" />
                          <div className="flex gap-compact pt-2">
                            <div className="h-8 bg-system-gray-200 rounded-md w-20" />
                            <div className="h-8 bg-system-gray-200 rounded-md w-20" />
                          </div>
                        </div>
                      ) : selectedKind === 'cluster' ? (
                        <div className="flex flex-col gap-relaxed">
                          <div className="flex items-start gap-cozy mb-2">
                            <div className="mt-1 p-2 bg-system-gray-100 border border-system-gray-200 rounded-lg shadow-sm text-stratosort-accent">
                              <Layers className="h-5 w-5" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <Text
                                variant="small"
                                className="font-semibold text-system-gray-900 break-words leading-snug"
                              >
                                {selectedLabel}
                              </Text>
                              <Text
                                as="div"
                                variant="tiny"
                                className="text-system-gray-500 mt-1 flex flex-wrap gap-compact"
                              >
                                <span className="px-2 py-0.5 bg-system-gray-100 rounded-full">
                                  {selectedNode.data?.memberCount || 0} files
                                </span>
                                <span className="px-2 py-0.5 bg-system-gray-100 rounded-full capitalize">
                                  {selectedNode.data?.confidence || 'low'} confidence
                                </span>
                                {selectedNode.data?.dominantCategory && (
                                  <span className="px-2 py-0.5 bg-system-gray-100 rounded-full">
                                    {selectedNode.data.dominantCategory}
                                  </span>
                                )}
                              </Text>
                            </div>
                          </div>

                          {(() => {
                            const clusterTerms = sanitizeGraphMetadataTerms(
                              selectedNode.data?.topTerms || selectedNode.data?.commonTags,
                              { maxTerms: 12 }
                            );
                            if (clusterTerms.length === 0) return null;
                            return (
                              <div className="space-y-2">
                                <Text
                                  as="div"
                                  variant="tiny"
                                  className="font-semibold text-system-gray-500 uppercase tracking-wider"
                                >
                                  Why this cluster
                                </Text>
                                <div className="flex flex-wrap gap-1.5">
                                  {clusterTerms.map((term) => (
                                    <span
                                      key={term}
                                      className="px-2 py-0.5 bg-stratosort-accent/10 text-stratosort-accent border border-stratosort-accent/30 rounded-full text-xs"
                                    >
                                      {term}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            );
                          })()}

                          {selectedNodeHeroConnectionText && (
                            <div className="rounded-lg border border-stratosort-blue/20 bg-stratosort-blue/5 px-3 py-2">
                              <Text
                                as="div"
                                variant="tiny"
                                className="text-stratosort-blue font-medium"
                              >
                                {selectedNodeHeroConnectionText}
                              </Text>
                            </div>
                          )}

                          {selectedNodeWhyConnections.length > 0 && (
                            <div className="space-y-2">
                              <Text
                                as="div"
                                variant="tiny"
                                className="font-semibold text-system-gray-500 uppercase tracking-wider"
                              >
                                Why connected
                              </Text>
                              <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                                {displayedSelectedNodeWhyConnections.map((reason) => (
                                  <div
                                    key={reason.edgeId}
                                    className="rounded-lg border border-system-gray-200 bg-system-gray-100 px-2 py-1.5"
                                  >
                                    <Text
                                      as="div"
                                      variant="tiny"
                                      className="font-medium text-system-gray-700 truncate"
                                      title={reason.targetLabel}
                                    >
                                      {reason.targetLabel}
                                    </Text>
                                    <Text
                                      as="div"
                                      variant="tiny"
                                      className="text-system-gray-500 mt-0.5"
                                    >
                                      {reason.label}
                                    </Text>
                                    <Text
                                      as="div"
                                      variant="tiny"
                                      className="text-system-gray-400 truncate"
                                    >
                                      {reason.detail}
                                    </Text>
                                  </div>
                                ))}
                                {hiddenSelectedNodeConnectionsCount > 0 ? (
                                  <Text as="div" variant="tiny" className="text-system-gray-500">
                                    +{hiddenSelectedNodeConnectionsCount} more connections
                                  </Text>
                                ) : null}
                              </div>
                            </div>
                          )}

                          {selectedClusterInfo?.bridges?.length > 0 && (
                            <div className="space-y-2">
                              <div className="flex items-center justify-between gap-compact">
                                <Text
                                  as="div"
                                  variant="tiny"
                                  className="font-semibold text-system-gray-500 uppercase tracking-wider"
                                >
                                  Related clusters
                                </Text>
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  className="text-system-gray-600 hover:text-system-gray-800"
                                  rightIcon={
                                    <ChevronRight
                                      className={`h-3.5 w-3.5 transition-transform ${
                                        isRelatedClustersOpen ? 'rotate-90' : 'rotate-0'
                                      }`}
                                    />
                                  }
                                  onClick={() => setIsRelatedClustersOpen((prev) => !prev)}
                                  aria-label={
                                    isRelatedClustersOpen
                                      ? 'Collapse related clusters'
                                      : 'Expand related clusters'
                                  }
                                >
                                  <span>
                                    {isRelatedClustersOpen
                                      ? 'Hide'
                                      : `Show (${selectedClusterInfo.bridges.length})`}
                                  </span>
                                </Button>
                              </div>

                              {isRelatedClustersOpen ? (
                                <div className="space-y-2">
                                  {selectedClusterInfo.bridges.map((bridge) => {
                                    const bridgeKey =
                                      bridge?.id || bridge?.targetId || bridge?.targetLabel || '';
                                    const isExpanded = Boolean(
                                      expandedRelatedClusters?.[bridgeKey]
                                    );
                                    const bridgeFiles = Array.isArray(bridge?.bridgeFiles)
                                      ? bridge.bridgeFiles
                                      : [];
                                    const visibleFiles = bridgeFiles;

                                    return (
                                      <div
                                        key={bridge.id}
                                        className="border border-system-gray-200 rounded-lg p-2 bg-system-gray-50"
                                      >
                                        <div className="flex items-start gap-compact min-w-0">
                                          <div className="min-w-0 flex-1">
                                            <Button
                                              type="button"
                                              variant="ghost"
                                              size="xs"
                                              className="w-full min-w-0 h-auto !justify-start text-left p-0"
                                              title="Select related cluster"
                                              onClick={() => {
                                                if (bridge?.targetId)
                                                  graphActions.selectNode?.(bridge.targetId);
                                              }}
                                            >
                                              <Text
                                                as="span"
                                                variant="small"
                                                className="block w-full truncate text-system-gray-800 hover:text-stratosort-blue"
                                              >
                                                {bridge.targetLabel || bridge.targetId}
                                              </Text>
                                            </Button>
                                            <Text
                                              as="div"
                                              variant="tiny"
                                              className="text-system-gray-500 mt-0.5"
                                            >
                                              {Math.round((bridge.similarity || 0) * 100)}% match
                                            </Text>
                                          </div>

                                          <Button
                                            variant="ghost"
                                            size="xs"
                                            className="text-system-gray-600 hover:text-system-gray-800 shrink-0 self-start"
                                            rightIcon={
                                              <ChevronRight
                                                className={`h-3.5 w-3.5 transition-transform ${
                                                  isExpanded ? 'rotate-90' : 'rotate-0'
                                                }`}
                                              />
                                            }
                                            onClick={() =>
                                              setExpandedRelatedClusters((prev) => ({
                                                ...(prev || {}),
                                                [bridgeKey]: !prev?.[bridgeKey]
                                              }))
                                            }
                                            aria-label={
                                              isExpanded
                                                ? 'Hide related cluster details'
                                                : 'Show related cluster details'
                                            }
                                          >
                                            <span>
                                              {isExpanded ? 'Hide details' : 'Show details'}
                                            </span>
                                          </Button>
                                        </div>

                                        <Text
                                          as="div"
                                          variant="tiny"
                                          className="text-system-gray-600 mt-2 flex flex-wrap gap-1"
                                        >
                                          {(bridge.sharedTerms || []).map((t) => (
                                            <span
                                              key={t}
                                              className="px-1.5 py-0.5 bg-system-gray-100 border border-system-gray-200 rounded-md text-xs"
                                            >
                                              {t}
                                            </span>
                                          ))}
                                          {bridge.bridgeCount > 0 && (
                                            <span className="px-1.5 py-0.5 bg-system-gray-100 border border-system-gray-200 rounded-md text-xs">
                                              {bridge.bridgeCount} bridge file
                                              {bridge.bridgeCount === 1 ? '' : 's'}
                                            </span>
                                          )}
                                        </Text>

                                        {isExpanded && bridgeFiles.length > 0 && (
                                          <div className="mt-2 space-y-1 max-h-40 overflow-y-auto pr-1">
                                            {visibleFiles.map((file) => (
                                              <div
                                                key={file?.path || file?.id || file}
                                                className="flex items-center justify-between text-xs text-system-gray-700 bg-system-gray-100 border border-system-gray-100 rounded-md px-2 py-1"
                                              >
                                                <span className="truncate flex-1 mr-2">
                                                  {formatGraphBridgeFileLabel(
                                                    file,
                                                    file?.path || null,
                                                    redactPaths
                                                  )}
                                                </span>
                                                {file?.path && (
                                                  <div className="flex gap-1">
                                                    <Button
                                                      variant="ghost"
                                                      size="xs"
                                                      onClick={() => openFile(file.path)}
                                                      aria-label="Open bridge file"
                                                      title="Open"
                                                    >
                                                      <ExternalLink className="h-3.5 w-3.5" />
                                                    </Button>
                                                    <Button
                                                      variant="ghost"
                                                      size="xs"
                                                      onClick={() => revealFile(file.path)}
                                                      aria-label="Reveal bridge file"
                                                      title="Reveal"
                                                    >
                                                      <FolderOpen className="h-3.5 w-3.5" />
                                                    </Button>
                                                  </div>
                                                )}
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <Text as="div" variant="tiny" className="text-system-gray-500">
                                  Hidden to reduce clutter. Expand to explore bridges to other
                                  clusters.
                                </Text>
                              )}
                            </div>
                          )}

                          <div className="flex flex-wrap gap-compact">
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => {
                                setFocusNodeId(selectedNode.id);
                                setFocusDepth(0);
                                setGraphStatus('Focus: selected cluster only');
                              }}
                            >
                              <Maximize2 className="h-4 w-4" />
                              <span>Show only cluster</span>
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setFocusNodeId(selectedNode.id);
                                setFocusDepth(1);
                                setGraphStatus('Focus: selected cluster + neighbors');
                              }}
                            >
                              <Layers className="h-4 w-4" />
                              <span>Show neighbors</span>
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-relaxed">
                          {/* Header Info */}
                          <div>
                            <div className="flex items-start gap-cozy mb-2">
                              <div className="mt-1 p-2 bg-system-gray-100 border border-system-gray-200 rounded-lg shadow-sm text-stratosort-blue">
                                {selectedKind === 'query' ? (
                                  <SearchIcon className="h-5 w-5" />
                                ) : selectedKind === 'cluster' ? (
                                  <Layers className="h-5 w-5" />
                                ) : (
                                  <FileText className="h-5 w-5" />
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                <Text
                                  variant="small"
                                  className="font-semibold text-system-gray-900 break-words leading-snug"
                                >
                                  {selectedLabel}
                                </Text>
                                <Text
                                  as="div"
                                  variant="tiny"
                                  className="text-system-gray-500 mt-1 capitalize px-2 py-0.5 bg-system-gray-100 rounded-full inline-block"
                                >
                                  {selectedKind} Node
                                </Text>
                              </div>
                            </div>
                          </div>

                          {selectedNodeHeroConnectionText && (
                            <div className="rounded-lg border border-stratosort-blue/20 bg-stratosort-blue/5 px-3 py-2">
                              <Text
                                as="div"
                                variant="tiny"
                                className="text-stratosort-blue font-medium"
                              >
                                {selectedNodeHeroConnectionText}
                              </Text>
                            </div>
                          )}

                          {selectedNodeWhyConnections.length > 0 && (
                            <div className="space-y-2">
                              <Text
                                as="div"
                                variant="tiny"
                                className="font-semibold text-system-gray-500 uppercase tracking-wider"
                              >
                                Why connected
                              </Text>
                              <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
                                {displayedSelectedNodeWhyConnections.map((reason) => (
                                  <div
                                    key={reason.edgeId}
                                    className="rounded-lg border border-system-gray-200 bg-system-gray-100 px-2 py-1.5"
                                  >
                                    <Text
                                      as="div"
                                      variant="tiny"
                                      className="font-medium text-system-gray-700 truncate"
                                      title={reason.targetLabel}
                                    >
                                      {reason.targetLabel}
                                    </Text>
                                    <Text
                                      as="div"
                                      variant="tiny"
                                      className="text-system-gray-500 mt-0.5"
                                    >
                                      {reason.label}
                                    </Text>
                                    <Text
                                      as="div"
                                      variant="tiny"
                                      className="text-system-gray-400 truncate"
                                    >
                                      {reason.detail}
                                    </Text>
                                  </div>
                                ))}
                                {hiddenSelectedNodeConnectionsCount > 0 ? (
                                  <Text as="div" variant="tiny" className="text-system-gray-500">
                                    +{hiddenSelectedNodeConnectionsCount} more connections
                                  </Text>
                                ) : null}
                              </div>
                            </div>
                          )}

                          {/* Analysis Section (Subject & Summary) */}
                          {(() => {
                            const subject =
                              selectedDocumentDetails?.analysis?.subject ||
                              selectedNode.data?.subject;
                            const summary =
                              selectedDocumentDetails?.analysis?.summary ||
                              selectedNode.data?.summary;
                            if (!subject && !summary) return null;
                            return (
                              <div className="space-y-2">
                                <Text
                                  as="div"
                                  variant="tiny"
                                  className="font-semibold text-system-gray-500 uppercase tracking-wider"
                                >
                                  Analysis
                                </Text>
                                <div className="bg-system-gray-50 rounded-lg p-3 border border-system-gray-100">
                                  {subject && (
                                    <Text
                                      variant="small"
                                      className="font-medium text-system-gray-800 mb-1 break-words"
                                    >
                                      {subject}
                                    </Text>
                                  )}
                                  {summary && (
                                    <Text
                                      variant="tiny"
                                      className="text-system-gray-600 leading-relaxed break-words"
                                    >
                                      {summary}
                                    </Text>
                                  )}
                                </div>
                              </div>
                            );
                          })()}

                          {/* Tags Section */}
                          {(() => {
                            const tags = sanitizeGraphMetadataTerms(
                              selectedDocumentDetails?.analysis?.tags ||
                                selectedDocumentDetails?.analysis?.keywords ||
                                selectedNode.data?.tags,
                              { maxTerms: 16 }
                            );
                            if (tags.length === 0) return null;
                            return (
                              <div className="space-y-2">
                                <Text
                                  as="div"
                                  variant="tiny"
                                  className="font-semibold text-system-gray-500 uppercase tracking-wider"
                                >
                                  Tags
                                </Text>
                                <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto pr-1">
                                  {tags.map((tag) => (
                                    <Text
                                      as="span"
                                      variant="tiny"
                                      key={tag}
                                      className="px-2 py-0.5 rounded-full bg-system-gray-100 text-system-gray-600 border border-system-gray-200 max-w-full truncate"
                                      title={tag}
                                    >
                                      {tag}
                                    </Text>
                                  ))}
                                </div>
                              </div>
                            );
                          })()}

                          {/* Content Preview */}
                          {isLoadingDocumentDetails ? (
                            <div className="flex items-center justify-center p-4 animate-loading-fade">
                              <RefreshCw className="w-5 h-5 text-system-gray-300 animate-spin" />
                            </div>
                          ) : (
                            (selectedDocumentDetails?.analysis?.extractedText ||
                              selectedNode.data?.content) && (
                              <div className="space-y-2">
                                <Text
                                  as="div"
                                  variant="tiny"
                                  className="font-semibold text-system-gray-500 uppercase tracking-wider"
                                >
                                  Content Preview
                                </Text>
                                <div className="bg-system-gray-100 border border-system-gray-100 rounded-lg p-3 max-h-48 overflow-y-auto">
                                  <Text
                                    variant="tiny"
                                    className="text-system-gray-600 whitespace-pre-wrap leading-relaxed"
                                  >
                                    {String(
                                      selectedDocumentDetails?.analysis?.extractedText ||
                                        selectedNode.data?.content
                                    ).slice(0, 500)}
                                    {String(
                                      selectedDocumentDetails?.analysis?.extractedText ||
                                        selectedNode.data?.content
                                    ).length > 500 && '...'}
                                  </Text>
                                </div>
                              </div>
                            )
                          )}

                          {/* Properties Section */}
                          {selectedPath && (
                            <div className="space-y-2">
                              <Text
                                as="div"
                                variant="tiny"
                                className="font-semibold text-system-gray-500 uppercase tracking-wider"
                              >
                                Properties
                              </Text>
                              <div className="bg-system-gray-50 rounded-lg p-3 border border-system-gray-100 space-y-2">
                                <div>
                                  <Text
                                    as="div"
                                    variant="tiny"
                                    className="text-system-gray-400 uppercase tracking-wide mb-0.5"
                                  >
                                    Path
                                  </Text>
                                  <Text
                                    as="div"
                                    variant="tiny"
                                    className="text-system-gray-700 font-mono break-all leading-relaxed select-all"
                                  >
                                    {selectedPath}
                                  </Text>
                                </div>
                                {selectedNode.data?.score > 0 && (
                                  <div>
                                    <Text
                                      as="div"
                                      variant="tiny"
                                      className="text-system-gray-400 uppercase tracking-wide mb-0.5"
                                    >
                                      Relevance Score
                                    </Text>
                                    <Text as="div" variant="tiny" className="text-system-gray-700">
                                      {Math.round(selectedNode.data.score * 100)}%
                                    </Text>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}

                          {/* Notes Section */}
                          <div className="space-y-2">
                            <Text
                              as="div"
                              variant="tiny"
                              className="font-semibold text-system-gray-500 uppercase tracking-wider flex justify-between"
                            >
                              <span>Notes</span>
                            </Text>
                            <Textarea
                              className="w-full text-sm"
                              rows={3}
                              placeholder="Add notes about this node or connection..."
                              value={graphNotes[selectedNode.id] || ''}
                              onChange={(e) =>
                                setGraphNotes((prev) => ({
                                  ...prev,
                                  [selectedNode.id]: e.target.value
                                }))
                              }
                            />
                          </div>

                          {/* Connections Section */}
                          <div className="space-y-2">
                            <Text
                              as="div"
                              variant="tiny"
                              className="font-semibold text-system-gray-500 uppercase tracking-wider flex justify-between"
                            >
                              <span>Connections</span>
                              <span className="text-system-gray-400 font-normal">
                                {selectedNodeConnectionCount} links
                              </span>
                            </Text>
                            <div className="flex flex-col gap-1.5 mt-1">
                              {selectedNodeNeighbors.length === 0 ? (
                                <Text
                                  as="div"
                                  variant="tiny"
                                  className="text-system-gray-400 italic"
                                >
                                  No direct connections
                                </Text>
                              ) : (
                                selectedNodeNeighbors.slice(0, 10).map((neighbor) => {
                                  const icon =
                                    neighbor.kind === 'query' ? (
                                      <SearchIcon className="h-3 w-3 text-system-gray-400" />
                                    ) : neighbor.kind === 'cluster' ? (
                                      <Layers className="h-3 w-3 text-system-gray-400" />
                                    ) : (
                                      <FileText className="h-3 w-3 text-system-gray-400" />
                                    );
                                  return (
                                    <Button
                                      key={neighbor.id}
                                      variant="ghost"
                                      size="sm"
                                      leftIcon={icon}
                                      onClick={() => graphActions.selectNode(neighbor.id)}
                                      className="w-full justify-between h-auto px-2 py-1.5 rounded-md text-left text-xs text-system-gray-700 hover:bg-system-gray-100"
                                    >
                                      <span className="flex-1 min-w-0 truncate group-hover:text-stratosort-blue">
                                        {neighbor.label}
                                      </span>
                                      {typeof neighbor.similarity === 'number' ? (
                                        <span className="text-xs text-system-gray-400">
                                          {Math.round(neighbor.similarity * 100)}%
                                        </span>
                                      ) : null}
                                    </Button>
                                  );
                                })
                              )}
                              {selectedNodeConnectionCount > 10 && (
                                <Text
                                  as="div"
                                  variant="tiny"
                                  className="text-system-gray-400 pl-6 mt-1"
                                >
                                  +{selectedNodeConnectionCount - 10} more
                                </Text>
                              )}
                            </div>
                          </div>

                          {/* Actions Section */}
                          <div className="space-y-2 pt-2 border-t border-system-gray-100">
                            <Text as="div" variant="tiny" className={GRAPH_SIDEBAR_SECTION_TITLE}>
                              Actions
                            </Text>
                            <div className="grid grid-cols-2 gap-compact">
                              <Button
                                variant="primary"
                                size="sm"
                                onClick={() => openFile(selectedPath)}
                                disabled={!selectedPath}
                                className="w-full justify-center"
                              >
                                <ExternalLink className="h-3.5 w-3.5" />
                                <span>Open</span>
                              </Button>
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => revealFile(selectedPath)}
                                disabled={!selectedPath}
                                className="w-full justify-center"
                              >
                                <FolderOpen className="h-3.5 w-3.5" />
                                <span>Reveal</span>
                              </Button>
                            </div>

                            {selectedKind === 'file' && selectedPath && (
                              <>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => {
                                    const fileName = safeBasename(selectedPath) || 'file';
                                    setQuery(`similar to: ${fileName}`);
                                    setActiveTab('search');
                                  }}
                                  className="w-full justify-center"
                                >
                                  <SearchIcon className="h-3.5 w-3.5" />
                                  <span>Find similar</span>
                                </Button>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => focusNode(selectedNode.id)}
                                  className="w-full justify-center"
                                >
                                  <Crosshair className="h-3.5 w-3.5" />
                                  <span>Focus</span>
                                </Button>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => {
                                    const fileName = safeBasename(selectedPath) || 'file';
                                    setDocumentScope([
                                      {
                                        id: selectedNode.id,
                                        label: fileName,
                                        path: selectedPath
                                      }
                                    ]);
                                    setActiveTab('chat');
                                    const contextMsg = `Tell me about ${fileName}`;
                                    handleChatSend(contextMsg, [selectedNode.id]);
                                  }}
                                  className="w-full justify-center"
                                >
                                  <MessageSquare className="h-3.5 w-3.5" />
                                  <span>Ask assistant</span>
                                </Button>
                              </>
                            )}
                          </div>

                          {selectedKind === 'file' && (
                            <Text
                              as="div"
                              variant="tiny"
                              className="text-system-gray-300 font-mono mt-4 truncate"
                            >
                              ID: {selectedNode.id}
                            </Text>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="h-full flex flex-col">
                      {/* Integrated Legend when no node selected */}
                      {showClusters || nodes.length > 0 ? (
                        <div className="space-y-4">
                          <div className={`${GRAPH_SIDEBAR_CARD} space-y-2 bg-system-gray-50/80`}>
                            <Text
                              as="div"
                              variant="tiny"
                              className="font-semibold text-system-gray-700"
                            >
                              No node selected
                            </Text>
                            <Text as="div" variant="tiny" className="text-system-gray-500">
                              Click a node in the graph to inspect details and actions.
                            </Text>
                            <div className="flex items-center justify-between text-xs text-system-gray-500">
                              <span>{nodes.length} nodes</span>
                              <span>{edges.length} links</span>
                              <span>{activeSidebarFilterCount} filters</span>
                            </div>
                          </div>
                          {!legendHintDismissed && (
                            <div
                              className={`${GRAPH_SIDEBAR_CARD} relative pr-7 bg-stratosort-blue/5 border-stratosort-blue/20`}
                              role="note"
                            >
                              <Text
                                as="div"
                                variant="tiny"
                                className="font-semibold text-stratosort-blue mb-1"
                              >
                                Reading this graph
                              </Text>
                              <Text as="div" variant="tiny" className="text-system-gray-600">
                                Clusters are groups of related files. Solid lines connect similar
                                files; dashed lines between clusters mean topics overlap — a count
                                shows files that belong to both groups. Hover or click a line&apos;s
                                label for why it&apos;s there; click again to pin the details open.
                              </Text>
                              <IconButton
                                onClick={() => dispatch(setGraphLegendHintDismissed(true))}
                                size="xs"
                                variant="ghost"
                                className="absolute top-1 right-1"
                                title="Dismiss tip"
                                aria-label="Dismiss legend tip"
                                icon={<X className="w-3 h-3" />}
                              />
                            </div>
                          )}
                          <div className={`${GRAPH_SIDEBAR_CARD} space-y-3`}>
                            <div className="flex items-center justify-between">
                              <Text
                                as="div"
                                variant="tiny"
                                className="font-semibold text-system-gray-600 uppercase tracking-wider"
                              >
                                {showClusters ? 'Cluster legend' : 'Graph legend'}
                              </Text>
                              <Text as="div" variant="tiny" className="text-system-gray-400">
                                Click to filter
                              </Text>
                            </div>
                            <ClusterLegend
                              compact={false}
                              showHeader={false}
                              className="shadow-none border-none p-0 bg-transparent w-full"
                              activeFilters={activeFilters}
                              onToggleFilter={handleToggleFilter}
                            />
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center h-full text-center py-12 text-system-gray-400">
                          <div className="w-12 h-12 rounded-full bg-system-gray-100 flex items-center justify-center mb-3">
                            <Sparkles className="w-6 h-6 text-system-gray-300" />
                          </div>
                          <Text variant="small" className="font-medium text-system-gray-600">
                            No Selection
                          </Text>
                          <Text variant="tiny" className="text-system-gray-400 mt-1 max-w-[200px]">
                            Select a node to view details, or run a search to populate the graph.
                          </Text>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </React.Fragment>
        </GraphErrorBoundary>
      )}
    </div>
  );
}

GraphTabContent.propTypes = {
  graph: PropTypes.object.isRequired,
  isGraphMaximized: PropTypes.bool,
  setIsGraphMaximized: PropTypes.func,
  openFile: PropTypes.func,
  revealFile: PropTypes.func,
  stats: PropTypes.object
};
