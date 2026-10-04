import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { AlertTriangle, X, Sparkles, RefreshCw, Network, FolderOpen, Settings } from 'lucide-react';
import { PHASES } from '../../shared/constants';
import { TIMEOUTS } from '../../shared/performanceConstants';
import { createLogger } from '../../shared/logger';
import { useNotification } from '../contexts/NotificationContext';
import { useFloatingSearch } from '../contexts/FloatingSearchContext';
import { useConfirmDialog, useDragAndDrop, useSettingsSubscription } from '../hooks';
import { Button, IconButton, MinimizableGuideCard } from '../components/ui';
import { Heading, Text } from '../components/ui/Typography';
import Card from '../components/ui/Card';
import StatusBadge from '../components/ui/StatusBadge';
import { ActionBar, Inline, Stack } from '../components/layout';
import {
  NamingSettingsModal,
  SelectionControls,
  AnalysisResultsList,
  AnalysisProgress
} from '../components/discover';
import { FileListSkeleton } from '../components/ui/LoadingSkeleton';
import store from '../store';
import { toCanonicalPath } from '../utils/canonicalPath';
import {
  useDiscoverState,
  useAnalysis,
  useFileHandlers,
  useFileActions,
  getFileStateDisplayInfo
} from './discover';

const normalizeForComparison = toCanonicalPath;

const logger = createLogger('DiscoverPhase');
function DiscoverPhase() {
  const {
    selectedFiles,
    analysisResults,
    isAnalyzing,
    analysisProgress,
    currentAnalysisFile,
    fileStates,
    namingConvention,
    dateFormat,
    caseConvention,
    separator,
    namingSettings,
    setSelectedFiles,
    addSelectedFiles,
    setAnalysisResults,
    setIsAnalyzing,
    setAnalysisProgress,
    setCurrentAnalysisFile,
    setNamingConvention,
    setDateFormat,
    setCaseConvention,
    setSeparator,
    setFileStates,
    updateFileState,
    resetAnalysisState,
    actions,
    getCurrentPhase,
    organizedFiles,
    organizedPathIndex,
    fileStats
  } = useDiscoverState();

  const { addNotification } = useNotification();
  const { showConfirm, ConfirmDialog } = useConfirmDialog();
  const { openSearchModal } = useFloatingSearch();

  const [showNamingSettings, setShowNamingSettings] = useState(false);
  const [totalAnalysisFailure, setTotalAnalysisFailure] = useState(false);
  const [showEmbeddingPrompt, setShowEmbeddingPrompt] = useState(false);
  const [isRebuildingEmbeddings, setIsRebuildingEmbeddings] = useState(false);
  const isMountedRef = useRef(true);
  const analysisTriggeredRef = useRef(false);

  const prevAnalyzingRef = useRef(isAnalyzing);
  const hasShownEmbeddingPromptRef = useRef(
    (() => {
      try {
        return localStorage.getItem('stratosort_embedding_prompt_dismissed') === 'true';
      } catch {
        return false;
      }
    })()
  );

  const organizedPaths = useMemo(() => {
    const paths = new Set();
    // Prefer the durable compact index (survives organizedFiles persistence
    // caps). Fall back to rich history fields for the current session.
    for (const p of organizedPathIndex || []) {
      const key = normalizeForComparison(p);
      if (key) paths.add(key);
    }
    (organizedFiles || []).forEach((f) => {
      if (!f) return;
      for (const p of [f.originalPath, f.path, f.currentPath].filter(Boolean)) {
        paths.add(normalizeForComparison(p));
      }
    });
    return paths;
  }, [organizedFiles, organizedPathIndex]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const unorganizedSelectedCount = useMemo(() => {
    return (selectedFiles || []).filter((f) => {
      if (!f || !f.path) return false;
      const normalizedPath = normalizeForComparison(f.path);
      return !organizedPaths.has(normalizedPath);
    }).length;
  }, [selectedFiles, organizedPaths]);

  // Only show results for the active unorganized selection — same universe as
  // selectFileStats. Orphan analysis rows (deselected / already moved) used to
  // inflate the list while ready/failed badges read 0 from Redux.
  const selectedUnorganizedKeys = useMemo(() => {
    const keys = new Set();
    for (const file of selectedFiles || []) {
      const key = normalizeForComparison(file?.path);
      if (key && !organizedPaths.has(key)) keys.add(key);
    }
    return keys;
  }, [selectedFiles, organizedPaths]);

  const visibleAnalysisResults = useMemo(() => {
    return (analysisResults || []).filter((result) => {
      if (!result || !result.path) return false;
      const normalizedResultPath = normalizeForComparison(result.path);
      if (!normalizedResultPath || organizedPaths.has(normalizedResultPath)) return false;
      return selectedUnorganizedKeys.has(normalizedResultPath);
    });
  }, [analysisResults, organizedPaths, selectedUnorganizedKeys]);

  // Canonical queue stats (Dashboard / Organize share selectFileStats).
  const visibleReadyCount = fileStats?.ready ?? 0;
  const visibleFailedCount = fileStats?.failed ?? 0;

  const pendingAnalysisFiles = useMemo(() => {
    // Canonical-key lookup: fileStates keys and selected paths can disagree
    // in case/separator style; a raw lookup misses mid-analysis files and
    // would re-queue them.
    const stateByCanonical = new Map(
      Object.entries(fileStates || {}).map(([p, info]) => [toCanonicalPath(p), info])
    );
    // Successful results count as done even when fileStates lag behind
    // (empty map, delayed merge). Otherwise the sticky bar keeps saying
    // "waiting for analysis" after a completed run.
    const analyzedByCanonical = new Set(
      (analysisResults || [])
        .filter((r) => r?.path && r.analysis && !r.error)
        .map((r) => normalizeForComparison(r.path))
        .filter(Boolean)
    );
    return (selectedFiles || []).filter((f) => {
      if (!f || !f.path) return false;
      const normalizedPath = normalizeForComparison(f.path);
      if (organizedPaths.has(normalizedPath)) return false;
      if (analyzedByCanonical.has(normalizedPath)) return false;
      const state = stateByCanonical.get(normalizedPath)?.state;
      // Exclude in-flight and already-ready files. Ready used to be included
      // for re-analyze, but that made the post-run status read as "waiting".
      return state !== 'analyzing' && state !== 'ready';
    });
  }, [selectedFiles, organizedPaths, fileStates, analysisResults]);

  const pendingAnalysisCount = pendingAnalysisFiles.length;
  const analysisStartHint = useMemo(() => {
    if (pendingAnalysisCount === 0) return '';
    const fileApiReady = Boolean(window?.electronAPI?.files?.analyze);
    if (!fileApiReady) {
      return 'Analysis service not ready yet. Wait a moment or click to retry.';
    }
    if (analysisProgress?.current > 0 && analysisProgress?.total > 0) {
      const lastActivity = analysisProgress?.lastActivity;
      if (lastActivity && Date.now() - lastActivity > TIMEOUTS.STUCK_ANALYSIS_CHECK) {
        return 'Analysis paused after inactivity. Click to resume.';
      }
      return 'Analysis paused. Click to resume.';
    }
    return 'Ready to analyze. Click to begin.';
  }, [pendingAnalysisCount, analysisProgress]);

  const shouldShowQueueBar =
    isAnalyzing || pendingAnalysisCount > 0 || visibleAnalysisResults.length > 0;

  useEffect(() => {
    const wasAnalyzing = prevAnalyzingRef.current;
    prevAnalyzingRef.current = isAnalyzing;

    // Reset double-click guard when analysis finishes
    if (!isAnalyzing) {
      analysisTriggeredRef.current = false;
    }

    if (!wasAnalyzing || isAnalyzing) return undefined;
    if (hasShownEmbeddingPromptRef.current) return undefined;
    if (visibleReadyCount === 0) return undefined;

    const checkEmbeddings = async () => {
      try {
        const stats = await window.electronAPI?.embeddings?.getStats?.();
        const historyTotal =
          typeof stats?.analysisHistory?.totalFiles === 'number'
            ? stats.analysisHistory.totalFiles
            : 0;
        const needsRebuild =
          stats?.success &&
          typeof stats?.files === 'number' &&
          stats.files === 0 &&
          historyTotal > 0;

        if (needsRebuild && isMountedRef.current) {
          setShowEmbeddingPrompt(true);
          hasShownEmbeddingPromptRef.current = true;
        }
      } catch (e) {
        logger.warn('Failed to check embedding stats', e);
      }
    };

    const timeoutId = setTimeout(checkEmbeddings, TIMEOUTS.EMBEDDING_CHECK);
    return () => clearTimeout(timeoutId);
  }, [isAnalyzing, visibleReadyCount]);

  const dismissEmbeddingPrompt = useCallback((permanent = false) => {
    setShowEmbeddingPrompt(false);
    if (permanent) {
      try {
        localStorage.setItem('stratosort_embedding_prompt_dismissed', 'true');
      } catch {
        // Private browsing mode or storage unavailable
      }
      hasShownEmbeddingPromptRef.current = true;
    }
  }, []);

  const handleRebuildEmbeddings = useCallback(async () => {
    if (isMountedRef.current) setIsRebuildingEmbeddings(true);
    try {
      const res = await window.electronAPI?.embeddings?.rebuildFiles?.();
      if (res?.success) {
        addNotification(
          `Indexed ${res.files || 0} files for Knowledge OS`,
          'success',
          4000,
          'embedding-rebuild'
        );
        dismissEmbeddingPrompt(true);
      } else {
        throw new Error(res?.error || 'Failed to build embeddings');
      }
    } catch (e) {
      addNotification(e?.message || 'Failed to build embeddings', 'error', 5000, 'embedding-error');
    } finally {
      if (isMountedRef.current) setIsRebuildingEmbeddings(false);
    }
  }, [addNotification, dismissEmbeddingPrompt]);

  // Stable ref for useFileActions -- only organizedFiles is accessed from phaseData
  // and it's never set in this context, so use a stable empty object
  const stablePhaseData = useRef({}).current;

  const extendedActions = useMemo(
    () => ({
      ...actions,
      setPhaseData: (key, value) => {
        if (key === 'totalAnalysisFailure') {
          setTotalAnalysisFailure(value);
        } else {
          actions.setPhaseData(key, value);
        }
      }
    }),
    [actions]
  );

  const {
    analyzeFiles,
    cancelAnalysis,
    clearAnalysisQueue,
    retryFailedFiles,
    pruneBatchResultsForPath
  } = useAnalysis({
    selectedFiles,
    fileStates,
    analysisResults,
    isAnalyzing,
    analysisProgress,
    namingSettings,
    setters: {
      setIsAnalyzing,
      setAnalysisProgress,
      setCurrentAnalysisFile,
      setAnalysisResults,
      setFileStates
    },
    updateFileState,
    addNotification,
    actions: extendedActions,
    getCurrentPhase
  });

  const {
    isScanning,
    handleFileSelection,
    handleFolderSelection,
    handleFileDrop: fileHandlersDrop
  } = useFileHandlers({
    selectedFiles,
    setSelectedFiles,
    addSelectedFiles,
    updateFileState,
    addNotification,
    analyzeFiles
  });

  const { handleFileAction } = useFileActions({
    setAnalysisResults,
    setSelectedFiles,
    setFileStates,
    addNotification,
    showConfirm,
    phaseData: stablePhaseData,
    onFileRemoved: pruneBatchResultsForPath
  });

  const handleFileDrop = useCallback(
    async (files) => {
      if (files && files.length > 0) {
        await fileHandlersDrop(files);
      }
    },
    [fileHandlersDrop]
  );

  const { isDragging, dragProps } = useDragAndDrop(handleFileDrop);
  const initialStuckCheckRef = useRef(false);

  useSettingsSubscription(
    useCallback(
      (changedSettings) => {
        const changedKeys = Object.keys(changedSettings || {});
        if (changedKeys.length === 0) return;
        logger.info('Settings changed externally:', changedKeys);

        const changedLabels = [];
        if (Object.prototype.hasOwnProperty.call(changedSettings, 'textModel')) {
          changedLabels.push('text model');
        }
        if (Object.prototype.hasOwnProperty.call(changedSettings, 'visionModel')) {
          changedLabels.push('vision model');
        }
        if (Object.prototype.hasOwnProperty.call(changedSettings, 'embeddingModel')) {
          changedLabels.push('embedding model');
        }
        if (Object.prototype.hasOwnProperty.call(changedSettings, 'analysisSettings')) {
          changedLabels.push('analysis settings');
        }

        if (changedLabels.length === 0) return;

        const targetMessage =
          changedLabels.length === 1
            ? `Updated ${changedLabels[0]}.`
            : `Updated ${changedLabels.join(', ')}.`;

        if (isAnalyzing) {
          addNotification(
            `${targetMessage} Current analysis keeps previous settings; new analysis runs will use these updates.`,
            'info',
            3500,
            'settings-changed'
          );
          return;
        }

        addNotification(
          `${targetMessage} New analysis runs will use these updates.`,
          'info',
          2500,
          'settings-changed'
        );
      },
      [isAnalyzing, addNotification]
    ),
    {
      enabled: true,
      watchKeys: ['textModel', 'visionModel', 'embeddingModel', 'analysisSettings']
    }
  );

  const handleFileSelectionRef = useRef(handleFileSelection);
  const handleFolderSelectionRef = useRef(handleFolderSelection);
  const handleFileDropRef = useRef(handleFileDrop);
  useEffect(() => {
    handleFileSelectionRef.current = handleFileSelection;
    handleFolderSelectionRef.current = handleFolderSelection;
    handleFileDropRef.current = handleFileDrop;
  }, [handleFileSelection, handleFolderSelection, handleFileDrop]);

  useEffect(() => {
    // preventDefault() acks the (cancelable) bridge events so dispatchAcked
    // senders know a listener exists and stop retrying.
    const onSelectFiles = (e) => {
      e.preventDefault?.();
      handleFileSelectionRef.current?.();
    };
    const onSelectFolder = (e) => {
      e.preventDefault?.();
      handleFolderSelectionRef.current?.();
    };
    // The dashboard surface can't run the drop pipeline itself, so it forwards
    // dropped files here through a window CustomEvent (detail = file objects).
    const onDropFiles = (e) => {
      e.preventDefault?.();
      handleFileDropRef.current?.(e.detail);
    };

    window.addEventListener('app:select-files', onSelectFiles);
    window.addEventListener('app:select-folder', onSelectFolder);
    window.addEventListener('app:drop-files', onDropFiles);

    return () => {
      window.removeEventListener('app:select-files', onSelectFiles);
      window.removeEventListener('app:select-folder', onSelectFolder);
      window.removeEventListener('app:drop-files', onDropFiles);
    };
  }, []);

  const analysisProgressRef = useRef(analysisProgress);
  analysisProgressRef.current = analysisProgress;

  useEffect(() => {
    if (initialStuckCheckRef.current) return;
    initialStuckCheckRef.current = true;

    if (isAnalyzing) {
      const lastActivity = analysisProgress?.lastActivity || Date.now();
      const timeSinceActivity = Date.now() - lastActivity;
      const isStuck = timeSinceActivity > 2 * 60 * 1000;

      if (isStuck) {
        logger.info('Detected stuck analysis state on mount, resetting');
        resetAnalysisState('Stuck analysis detected on mount');
      }
    }
  }, [isAnalyzing, analysisProgress, resetAnalysisState]);

  useEffect(() => {
    if (!isAnalyzing) return;

    const checkStalled = () => {
      // Use Redux store directly to prevent stale reads when the window is minimized
      // (React suspends rendering when minimized, so refs bound to props become stale)
      const state = store.getState();
      const isActuallyAnalyzing = state.analysis.isAnalyzing;

      if (!isActuallyAnalyzing) return; // Already finished, ignore

      const progress = state.analysis.analysisProgress || analysisProgressRef.current;
      const lastActivity = progress?.lastActivity || Date.now();
      const timeSinceActivity = Date.now() - lastActivity;
      const current = progress?.current || 0;
      const total = progress?.total || 0;

      if (current === 0 && total > 0 && timeSinceActivity > TIMEOUTS.STUCK_ANALYSIS_CHECK) {
        addNotification('Analysis paused. Restarting...', 'info', 3000, 'analysis-stalled');
        resetAnalysisState('Analysis stalled with no progress after 2 minutes');
        return;
      }

      if (timeSinceActivity > TIMEOUTS.ANALYSIS_LOCK) {
        addNotification('Analysis timed out. Ready to retry.', 'info', 3000, 'analysis-auto-reset');
        resetAnalysisState('Stuck analysis state after 5 minutes of inactivity');
      }
    };

    // Defer state updates so the interval handler returns quickly (avoids Long Task violations)
    const checkStalledDeferred = () => {
      setTimeout(checkStalled, 0);
    };

    // Check immediately on dependency change
    checkStalled();

    // Also check periodically in case dependencies stop updating (the exact stall scenario).
    // Defer so the interval handler returns quickly (avoids Long Task violations).
    const intervalId = setInterval(checkStalledDeferred, TIMEOUTS.SERVICE_STARTUP);
    return () => clearInterval(intervalId);
  }, [isAnalyzing, addNotification, resetAnalysisState]);

  const fileStatesRef = useRef(fileStates);
  fileStatesRef.current = fileStates;
  const getFileStateDisplay = useCallback((filePath, hasAnalysis) => {
    const state = fileStatesRef.current[filePath]?.state || 'pending';
    return getFileStateDisplayInfo(state, hasAnalysis);
  }, []);

  return (
    <div
      className="flex flex-col flex-1 min-h-0 gap-relaxed lg:gap-spacious pb-6"
      data-testid="phase-discover-content"
    >
      {/* Header Section */}
      <Stack className="text-center flex-shrink-0" gap="compact">
        <Heading as="h1" variant="display">
          Discover & <span className="text-gradient">Analyze</span>
        </Heading>
        <Text variant="lead" className="max-w-xl mx-auto">
          Add files, confirm the naming approach, and prepare everything for review before any move
          happens.
        </Text>
      </Stack>

      <MinimizableGuideCard
        persistKey="discover_review_guide"
        guideLabel="discover guide"
        className="border border-stratosort-blue/18 bg-gradient-to-r from-system-gray-100/95 to-stratosort-blue/8"
        collapsedSummary={
          <Text variant="small" className="text-system-gray-700">
            {isAnalyzing
              ? 'Analysis running now - expand for review tips'
              : visibleReadyCount > 0
                ? `${visibleReadyCount} file${visibleReadyCount !== 1 ? 's' : ''} ready to review - expand for review tips`
                : pendingAnalysisCount > 0
                  ? `${pendingAnalysisCount} file${pendingAnalysisCount !== 1 ? 's' : ''} waiting for analysis - expand for review tips`
                  : 'Add files to begin - expand for review tips'}
          </Text>
        }
      >
        <div className="max-w-2xl">
          <div className="flex flex-wrap gap-compact mb-3">
            <StatusBadge variant="info" size="sm">
              Step 3 of 5
            </StatusBadge>
            <StatusBadge
              variant={
                isAnalyzing
                  ? 'info'
                  : visibleReadyCount > 0 || pendingAnalysisCount === 0
                    ? 'success'
                    : 'warning'
              }
              size="sm"
            >
              {isAnalyzing
                ? 'Analysis in progress'
                : visibleReadyCount > 0 || pendingAnalysisCount === 0
                  ? 'Review before moving'
                  : 'Add files to begin'}
            </StatusBadge>
          </div>
          <Heading as="h2" variant="h5" className="mb-2">
            Build a clean review queue
          </Heading>
          <Text variant="small" className="text-system-gray-600">
            This step is designed to stay simple: add files, let local AI prepare suggestions, and
            move forward only when the review list feels ready.
          </Text>
        </div>

        <Inline className="pt-4" gap="relaxed" wrap>
          <Button
            variant="secondary"
            size="sm"
            data-testid="naming-strategy-trigger"
            onClick={() => setShowNamingSettings(true)}
          >
            <Settings className="w-4 h-4" />
            Naming strategy
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => openSearchModal('search')}
            title="Open Knowledge OS (semantic search + chat)"
          >
            <Network className="w-4 h-4" />
            Knowledge OS
          </Button>
        </Inline>
      </MinimizableGuideCard>

      <Stack className="flex-1 min-h-0" gap="relaxed">
        {/* Primary Content Selection Card */}
        <Card className="flex-shrink-0">
          <Inline className="justify-between mb-6" gap="cozy" wrap>
            <Inline gap="cozy">
              <div className="flex items-center gap-compact">
                <FolderOpen className="w-5 h-5 text-stratosort-blue" />
                {/* Section headings are h2 (h1 is the page title). The guide
                    card's h2 unmounts when minimized, so no section may rely
                    on it for heading order. */}
                <Heading as="h2" variant="h5">
                  Select content
                </Heading>
              </div>
              {unorganizedSelectedCount > 0 && (
                <StatusBadge variant="info">
                  {unorganizedSelectedCount} file{unorganizedSelectedCount !== 1 ? 's' : ''} ready
                </StatusBadge>
              )}
            </Inline>
          </Inline>

          <div
            data-testid="drag-drop-zone"
            className={`flex-1 flex flex-col items-center justify-center animate-fade-in text-center min-h-[200px] p-8 transition-colors [transition-duration:var(--motion-duration-fast)] [transition-timing-function:var(--motion-ease-standard)] border-2 border-dashed rounded-xl ${
              isDragging
                ? 'border-stratosort-blue/40 bg-stratosort-blue/8'
                : 'border-border-soft bg-system-gray-100/35'
            }`}
            {...dragProps}
          >
            <div className="w-16 h-16 bg-gradient-to-br from-stratosort-blue to-stratosort-indigo shadow-lg flex items-center justify-center transition-shadow [transition-duration:var(--motion-duration-standard)] [transition-timing-function:var(--motion-ease-standard)] hover:shadow-xl rounded-xl mb-4">
              <FolderOpen className="w-8 h-8 text-white" />
            </div>

            <Heading as="h3" variant="h4" className="mb-2">
              {isDragging ? 'Drop files here' : 'Add files to organize'}
            </Heading>
            <Text variant="small" className="max-w-sm mb-6">
              {isDragging
                ? 'Release to add these files to your analysis queue.'
                : 'Select documents or scan folders to let AI analyze your content and suggest the perfect organization structure.'}
            </Text>

            <SelectionControls
              onSelectFiles={handleFileSelection}
              onSelectFolder={handleFolderSelection}
              isScanning={isScanning}
              className="w-full max-w-sm justify-center"
            />
          </div>
        </Card>

        {/* Middle Section - Queue & Status Actions */}
        {shouldShowQueueBar && (
          <div className="sticky top-4 z-20">
            <Card className="bg-system-gray-100/95 p-4 shadow-lg border-stratosort-blue/20">
              <Inline className="justify-between" gap="default" wrap>
                <div className="flex items-center flex-1 min-w-0">
                  {isAnalyzing ? (
                    <div className="flex-1 max-w-2xl min-w-0">
                      <AnalysisProgress
                        progress={analysisProgress}
                        currentFile={currentAnalysisFile}
                        surface="none"
                      />
                    </div>
                  ) : (
                    <Inline className="text-sm text-system-gray-600" gap="cozy" wrap>
                      <span className="status-dot success animate-pulse" />
                      {visibleReadyCount > 0 ? (
                        <Text variant="small">
                          Review queue ready
                          {` • ${visibleReadyCount} prepared`}
                          {visibleFailedCount > 0 && ` • ${visibleFailedCount} failed`}
                          {pendingAnalysisCount > 0 && ` • ${pendingAnalysisCount} still waiting`}
                        </Text>
                      ) : pendingAnalysisCount > 0 ? (
                        <Text variant="small">
                          {pendingAnalysisCount} file{pendingAnalysisCount !== 1 ? 's' : ''} waiting
                          for analysis
                        </Text>
                      ) : (
                        <Text variant="small">
                          Review queue ready
                          {visibleFailedCount > 0 && ` • ${visibleFailedCount} failed`}
                        </Text>
                      )}
                    </Inline>
                  )}
                </div>

                <Inline gap="default" wrap>
                  {isAnalyzing ? (
                    <>
                      <Button onClick={cancelAnalysis} variant="danger" size="sm">
                        Stop analysis
                      </Button>
                      {analysisProgress.lastActivity &&
                        Date.now() - analysisProgress.lastActivity >
                          TIMEOUTS.STUCK_ANALYSIS_CHECK && (
                          <Button
                            onClick={() => resetAnalysisState('User forced reset')}
                            variant="warning"
                            size="sm"
                          >
                            Force reset
                          </Button>
                        )}
                    </>
                  ) : (
                    <>
                      {pendingAnalysisCount > 0 && (
                        <Button
                          onClick={async () => {
                            if (analysisTriggeredRef.current) return;
                            analysisTriggeredRef.current = true;
                            try {
                              const result = await analyzeFiles?.(pendingAnalysisFiles);
                              if (!result?.started) {
                                analysisTriggeredRef.current = false;
                              }
                            } catch {
                              analysisTriggeredRef.current = false;
                            }
                          }}
                          variant="primary"
                          size="sm"
                          className="shadow-md shadow-stratosort-blue/20"
                          title={analysisStartHint || undefined}
                        >
                          Analyze {pendingAnalysisCount} file{pendingAnalysisCount !== 1 ? 's' : ''}
                        </Button>
                      )}
                      {visibleFailedCount > 0 && (
                        <Button
                          onClick={retryFailedFiles}
                          variant="ghost"
                          size="sm"
                          className="text-stratosort-warning hover:text-stratosort-warning hover:bg-stratosort-warning/10"
                        >
                          Retry {visibleFailedCount} failed
                        </Button>
                      )}
                      <Button
                        onClick={async () => {
                          const ok = await showConfirm({
                            title: 'Remove all files from the queue?',
                            message:
                              'This will remove all files from the analysis queue. You can add them again later.',
                            confirmText: 'Remove all',
                            cancelText: 'Cancel',
                            variant: 'danger'
                          });
                          if (ok) clearAnalysisQueue();
                        }}
                        variant="ghost"
                        size="sm"
                        className="text-system-gray-500 hover:text-stratosort-danger hover:bg-stratosort-danger/10"
                      >
                        Remove all
                      </Button>
                    </>
                  )}
                </Inline>
              </Inline>
            </Card>
          </div>
        )}

        {/* Bottom Section - Results (or skeleton while analyzing) */}
        {(visibleAnalysisResults.length > 0 || (isAnalyzing && unorganizedSelectedCount > 0)) && (
          <Card className="flex-1 min-h-[400px] flex flex-col overflow-hidden p-0">
            <div className="border-b border-border-soft/70 bg-system-gray-100/75 px-6 py-4 flex items-start justify-between gap-default flex-shrink-0">
              <div>
                <Heading as="h2" variant="h5">
                  Files ready for review
                </Heading>
                <Text variant="tiny" className="text-system-gray-500 mt-1">
                  Review the prepared files from this session before sending them to Organize.
                </Text>
              </div>
              <Text variant="tiny" className="text-system-gray-500 whitespace-nowrap pt-1">
                {`${visibleReadyCount} ready, ${visibleFailedCount} failed`}
              </Text>
            </div>
            <div className="flex-1 min-h-0 bg-system-gray-50/20 overflow-hidden relative">
              {visibleAnalysisResults.length > 0 ? (
                <AnalysisResultsList
                  results={visibleAnalysisResults}
                  onFileAction={handleFileAction}
                  getFileStateDisplay={getFileStateDisplay}
                  fileStates={fileStates}
                />
              ) : (
                <div className="p-6">
                  <FileListSkeleton count={Math.min(selectedFiles.length, 5)} />
                </div>
              )}
            </div>
          </Card>
        )}
      </Stack>

      {/* Embedding Prompt Banner */}
      {showEmbeddingPrompt && !isAnalyzing && (
        <Card
          variant="hero"
          className="flex-shrink-0 border-stratosort-blue/30 bg-gradient-to-r from-system-gray-100/95 to-stratosort-blue/8"
        >
          <div className="flex items-start gap-default">
            <div className="p-2 bg-stratosort-blue/10 rounded-lg shrink-0">
              <Sparkles className="w-5 h-5 text-stratosort-blue" />
            </div>
            <div className="flex-1">
              <Heading as="h2" variant="h6" className="text-stratosort-blue mb-2">
                Enable Knowledge OS
              </Heading>
              <Text variant="small" className="mb-4">
                Knowledge OS uses a semantic index (file embeddings) to power semantic search and
                chat with your documents. Your analysis history is present, but the index is
                currently empty.
              </Text>
              <div className="flex flex-wrap gap-compact">
                <Button
                  onClick={handleRebuildEmbeddings}
                  variant="primary"
                  size="sm"
                  disabled={isRebuildingEmbeddings}
                >
                  {isRebuildingEmbeddings ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      Building...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4" />
                      Build embeddings
                    </>
                  )}
                </Button>
                <Button onClick={() => dismissEmbeddingPrompt(false)} variant="ghost" size="sm">
                  Maybe later
                </Button>
                <Button
                  onClick={() => {
                    dismissEmbeddingPrompt(true);
                    openSearchModal('search');
                  }}
                  variant="secondary"
                  size="sm"
                >
                  <Network className="w-4 h-4" />
                  Open Knowledge OS
                </Button>
              </div>
            </div>
            <IconButton
              onClick={() => dismissEmbeddingPrompt(true)}
              variant="ghost"
              size="sm"
              icon={<X className="w-4 h-4" />}
            />
          </div>
        </Card>
      )}

      {/* Analysis Failure Recovery Banner */}
      {totalAnalysisFailure && (
        <Card variant="warning" className="flex-shrink-0">
          <div className="flex items-start gap-default">
            <AlertTriangle className="w-6 h-6 text-stratosort-warning flex-shrink-0" />
            <div className="flex-1">
              <Heading as="h2" variant="h6" className="text-stratosort-warning mb-2">
                All file analyses failed
              </Heading>
              <Text variant="small" className="mb-4">
                AI analysis could not process your files. This may be due to model loading issues,
                insufficient memory, or unsupported file types.
              </Text>
              <div className="flex flex-wrap gap-compact">
                <Button
                  onClick={() => {
                    setTotalAnalysisFailure(false);
                    clearAnalysisQueue();
                  }}
                  variant="secondary"
                  size="sm"
                >
                  Clear and try again
                </Button>
                <Button
                  onClick={() => {
                    setTotalAnalysisFailure(false);
                    actions.advancePhase(PHASES?.ORGANIZE ?? 'organize');
                  }}
                  variant="secondary"
                  size="sm"
                >
                  Skip to Organize phase →
                </Button>
              </div>
            </div>
            <IconButton
              onClick={() => setTotalAnalysisFailure(false)}
              variant="ghost"
              size="sm"
              icon={<X className="w-4 h-4" />}
            />
          </div>
        </Card>
      )}

      {/* Footer Navigation */}
      <ActionBar>
        <Button
          onClick={() => actions.advancePhase(PHASES?.SETUP ?? 'setup')}
          variant="secondary"
          size="md"
          className="w-full sm:w-auto min-w-[180px]"
        >
          ← Back to Setup
        </Button>

        {(() => {
          // Gate on Redux ready count (not raw analysisResults length) so a
          // failed-only list cannot look clickable while onClick no-ops.
          const canContinue = visibleReadyCount > 0 || totalAnalysisFailure;
          const disabledBecauseAnalyzing = isAnalyzing;
          const disabledBecauseNoReady = !canContinue;

          let disabledReason = '';
          if (disabledBecauseAnalyzing) {
            disabledReason = 'Analysis is in progress.';
          } else if (disabledBecauseNoReady) {
            disabledReason =
              visibleFailedCount > 0
                ? 'All files failed analysis. Use recovery options or continue without analysis when offered.'
                : 'Analyze files or continue without analysis.';
          }

          return (
            <Button
              onClick={() => {
                if (isAnalyzing) {
                  addNotification('Please wait for analysis to complete', 'warning', 3000);
                  return;
                }
                if (visibleReadyCount === 0 && !totalAnalysisFailure) {
                  addNotification(
                    visibleFailedCount > 0
                      ? 'All files failed analysis. Use the recovery options above or click "Continue without analysis".'
                      : 'Please analyze files first',
                    'warning',
                    4000
                  );
                  return;
                }
                if (totalAnalysisFailure) {
                  setTotalAnalysisFailure(false);
                }
                actions.advancePhase(PHASES?.ORGANIZE ?? 'organize');
              }}
              variant={totalAnalysisFailure ? 'secondary' : 'primary'}
              size="md"
              className="w-full sm:w-auto min-w-[180px]"
              disabled={isAnalyzing || !canContinue}
              title={disabledReason || undefined}
            >
              {totalAnalysisFailure ? 'Continue without analysis →' : 'Continue to Organize →'}
            </Button>
          );
        })()}
      </ActionBar>

      <ConfirmDialog />
      <NamingSettingsModal
        isOpen={showNamingSettings}
        onClose={() => setShowNamingSettings(false)}
        namingConvention={namingConvention}
        setNamingConvention={setNamingConvention}
        dateFormat={dateFormat}
        setDateFormat={setDateFormat}
        caseConvention={caseConvention}
        setCaseConvention={setCaseConvention}
        separator={separator}
        setSeparator={setSeparator}
      />
    </div>
  );
}

export default DiscoverPhase;
