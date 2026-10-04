import React, { useMemo, useCallback, useEffect, useRef } from 'react';
import { PHASES } from '../../shared/constants';
import { createLogger } from '../../shared/logger';
import { useNotification } from '../contexts/NotificationContext';
import { useAppSelector } from '../store/hooks';
import {
  Button,
  Card,
  MinimizableGuideCard,
  SidePanel,
  StateMessage,
  StatusBadge
} from '../components/ui';
import { Heading, Text } from '../components/ui/Typography';
import { ErrorBoundaryCore } from '../components/ErrorBoundary';
import {
  FolderOpen,
  BarChart3,
  CheckCircle2,
  Inbox,
  Sparkles,
  AlertTriangle,
  FileText
} from 'lucide-react';
import { ActionBar, Inline, Stack } from '../components/layout';
import {
  StatusOverview,
  TargetFolderList,
  BulkOperations,
  OrganizeProgress,
  VirtualizedFileGrid,
  VirtualizedProcessedFiles,
  UncategorizedActionsBar
} from '../components/organize';
import { setSmartFolders as setSmartFoldersAction } from '../store/slices/filesSlice';
import { UndoRedoToolbar, useUndoRedo } from '../components/UndoRedoSystem';
import Modal from '../components/ui/Modal';
import AnalysisDetails from '../components/AnalysisDetails';
import { useOrganizeState, useLoadInitialData } from './organize/useOrganizeState';
import {
  useSmartFolderMatcher,
  useSmartFolderMatcherForFile
} from './organize/useSmartFolderMatcher';
import {
  useFileStateDisplay,
  useFileEditing,
  useFileSelection,
  useBulkOperations,
  useProcessedFiles
} from './organize/useFileEditing';
import { useOrganization } from './organize/useOrganization';
import { useOrganizeSuggestions } from './organize/useOrganizeSuggestions';
import { resolveOrganizeDestination } from './organize/organizeDestination';
import { useOrganizeNotificationFocus } from './organize/useOrganizeNotificationFocus';
import { setFileStates as setFileStatesAction } from '../store/slices/filesSlice';
import { updateAnalysisResult } from '../store/slices/analysisSlice';
import { selectRedactPaths } from '../store/selectors';
import { formatDisplayPath } from '../utils/pathDisplay';
import { toCanonicalPath } from '../utils/canonicalPath';
import { useFileActions } from '../hooks/useFileActions';

const logger = createLogger('OrganizePhase');
function OrganizePhase() {
  const { addNotification } = useNotification();
  const { executeAction } = useUndoRedo();
  const [viewingFileDetails, setViewingFileDetails] = React.useState(null);
  const redactPaths = useAppSelector(selectRedactPaths);
  const currentPhase = useAppSelector((state) => state.ui.currentPhase);
  const detailHeaderPath = useMemo(() => {
    const rawPath = viewingFileDetails?.path || viewingFileDetails?.analysis?.path || '';
    const displayPath = rawPath
      ? formatDisplayPath(rawPath, { redact: Boolean(redactPaths), segments: 2 })
      : '';
    return { rawPath, displayPath };
  }, [viewingFileDetails, redactPaths]);

  const [showFoldersModal, setShowFoldersModal] = React.useState(false);
  const [showStatusModal, setShowStatusModal] = React.useState(false);
  const [showHistoryModal, setShowHistoryModal] = React.useState(false);
  const [focusFileIndex, setFocusFileIndex] = React.useState(null);
  const { revealFile } = useFileActions();

  const {
    organizedFiles,
    filesWithAnalysis,
    analysisResults,
    isAnalyzing,
    analysisProgress,
    smartFolders,
    fileStates,
    defaultLocation,
    failedCount,
    smartFoldersRef,
    dispatchRef,
    dispatch,
    setOrganizedFiles,
    addOrganizedFiles,
    removeOrganizedFiles,
    setOrganizingState,
    phaseData,
    actions
  } = useOrganizeState();
  const safeSmartFolders = useMemo(
    () => (Array.isArray(smartFolders) ? smartFolders : []),
    [smartFolders]
  );

  const addNotificationRef = useRef(addNotification);
  useEffect(() => {
    addNotificationRef.current = addNotification;
  }, [addNotification]);

  useLoadInitialData({ smartFoldersRef, dispatchRef }, addNotificationRef.current);

  const { getFileStateDisplay } = useFileStateDisplay(fileStates);

  const {
    setProcessedFileIds,
    markFilesAsProcessed,
    unmarkFilesAsProcessed,
    getFilteredFiles,
    normalizePath
  } = useProcessedFiles(organizedFiles);

  useEffect(() => {
    if (!organizedFiles || organizedFiles.length === 0) {
      setProcessedFileIds(new Set());
    } else {
      setProcessedFileIds(
        new Set(
          organizedFiles.flatMap((f) =>
            [f.originalPath, f.path, f.currentPath].filter(Boolean).map((p) => normalizePath(p))
          )
        )
      );
    }
  }, [organizedFiles, setProcessedFileIds, normalizePath]);

  const { unprocessedFiles: baseUnprocessedFiles, processedFiles } = useMemo(() => {
    return getFilteredFiles(filesWithAnalysis);
  }, [getFilteredFiles, filesWithAnalysis]);

  const { editingFiles, setEditingFiles, handleEditFile, getFileWithEdits } = useFileEditing({
    onEditChange: useCallback(
      (filePath, field, value) => {
        if (!filePath) return;
        if (field === 'category') {
          // userCategory marks the choice as the user's, so it still wins
          // over the engine's ranking after Organize remounts and the card
          // edit state is gone.
          dispatch(
            updateAnalysisResult({
              path: filePath,
              changes: { category: value, userCategory: value }
            })
          );
        }
        if (field === 'suggestedName') {
          dispatch(updateAnalysisResult({ path: filePath, changes: { suggestedName: value } }));
        }
      },
      [dispatch]
    )
  });

  const findSmartFolderForCategory = useSmartFolderMatcher(safeSmartFolders);
  // Per-file matcher: walks category, vendor, organization, entity, sender,
  // project against folder names. Lets a file route to a folder named after
  // its vendor even when the LLM-assigned category doesn't match.
  const findSmartFolderForFile = useSmartFolderMatcherForFile(safeSmartFolders);

  // D1: the suggestion engine ranks each ready file's destination; name
  // matching stays as the fallback when it has nothing.
  const { suggestionsByPath } = useOrganizeSuggestions(baseUnprocessedFiles, safeSmartFolders);
  const resolveDestination = useCallback(
    (file) => {
      const key = toCanonicalPath(file?.path);
      return resolveOrganizeDestination({
        fileWithEdits: getFileWithEdits(file) || file,
        edits: key ? editingFiles[key] : null,
        engineSuggestion: key ? suggestionsByPath.get(key) : null,
        smartFolders: safeSmartFolders,
        findSmartFolderForCategory,
        findSmartFolderForFile
      });
    },
    [
      getFileWithEdits,
      editingFiles,
      suggestionsByPath,
      safeSmartFolders,
      findSmartFolderForCategory,
      findSmartFolderForFile
    ]
  );

  const {
    isOrganizing,
    batchProgress,
    organizePreview,
    handleOrganizeFiles,
    handlePreviewOrganize,
    organizeConflicts,
    lastOrganizeSummary,
    cancelOrganize,
    isCancelling,
    pauseOrganize,
    resumeOrganize,
    dismissPausedBatch,
    isPausing,
    isPaused,
    pausedSummary
  } = useOrganization({
    unprocessedFiles: baseUnprocessedFiles,
    editingFiles,
    getFileWithEdits,
    findSmartFolderForCategory,
    findSmartFolderForFile,
    defaultLocation,
    smartFolders: safeSmartFolders,
    suggestionsByPath,
    analysisResults,
    markFilesAsProcessed,
    unmarkFilesAsProcessed,
    actions,
    phaseData,
    currentPhase,
    addNotification,
    executeAction,
    dispatch,
    setOrganizedFiles,
    addOrganizedFiles,
    removeOrganizedFiles,
    setOrganizingState
  });

  const filesBeingOrganized = useMemo(() => {
    if (!isOrganizing || !organizePreview || organizePreview.length === 0) return new Set();
    return new Set(organizePreview.map((item) => normalizePath(item.sourcePath)));
  }, [isOrganizing, organizePreview, normalizePath]);

  const unprocessedFiles = useMemo(() => {
    if (isOrganizing && filesBeingOrganized.size > 0) {
      return baseUnprocessedFiles.filter((f) => !filesBeingOrganized.has(normalizePath(f.path)));
    }
    return baseUnprocessedFiles;
  }, [baseUnprocessedFiles, isOrganizing, filesBeingOrganized, normalizePath]);

  const { selectedFiles, setSelectedFiles, toggleFileSelection, selectAllFiles } =
    useFileSelection(unprocessedFiles);

  const { bulkEditMode, setBulkEditMode, bulkCategory, setBulkCategory, applyBulkCategoryChange } =
    useBulkOperations({
      selectedFiles,
      editingFiles,
      setEditingFiles,
      setSelectedFiles,
      addNotification
    });

  // Drop edits for files that left the queue so a filtered grid cannot write
  // to a leftover index/path from a previous batch (SW-15 / SW-81). Prune
  // against the base queue: files hidden only while their move is in flight
  // must keep their edits in case the move fails and they return to the grid.
  useEffect(() => {
    const live = new Set(
      baseUnprocessedFiles.map((file) => toCanonicalPath(file?.path)).filter(Boolean)
    );
    setEditingFiles((prev) => {
      let changed = false;
      const next = {};
      for (const [key, value] of Object.entries(prev)) {
        if (live.has(key)) next[key] = value;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [baseUnprocessedFiles, setEditingFiles]);

  useOrganizeNotificationFocus({
    unprocessedFiles,
    processedFiles,
    setSelectedFiles,
    setFocusFileIndex,
    setViewingFileDetails,
    setShowHistoryModal,
    addNotification,
    revealFile
  });

  useEffect(() => {
    const handleBatchResultsChunk = (event) => {
      const { results, chunk } = event.detail || {};
      // Main sends 'chunk'; ipcMiddleware normalizes to chunk; support both for compatibility
      const items = Array.isArray(chunk) ? chunk : Array.isArray(results) ? results : [];
      if (items.length > 0) {
        logger.debug('[OrganizePhase] Received batch results chunk', {
          chunkIndex: event.detail?.chunkIndex,
          totalChunks: event.detail?.totalChunks,
          resultCount: items.length
        });
        const paths = [];
        for (const result of items) {
          if (result?.success && (result.source || result.path)) {
            const primary = result.originalPath || result.source || result.path;
            if (primary) paths.push(primary);
            if (result.destination && result.destination !== primary)
              paths.push(result.destination);
          }
        }
        if (paths.length > 0) {
          markFilesAsProcessed(paths);
        }
      }
    };

    window.addEventListener('batch-results-chunk', handleBatchResultsChunk);
    return () => {
      window.removeEventListener('batch-results-chunk', handleBatchResultsChunk);
    };
  }, [markFilesAsProcessed]);

  const hasLoadedPersistedDataRef = useRef(false);

  useEffect(() => {
    if (hasLoadedPersistedDataRef.current) {
      return;
    }
    hasLoadedPersistedDataRef.current = true;

    const loadPersistedData = () => {
      const persistedStates = fileStates || {};

      if (analysisResults.length === 0 && Object.keys(persistedStates).length > 0) {
        dispatch(setFileStatesAction({}));
      }
      if (Object.keys(persistedStates).length === 0 && analysisResults.length > 0) {
        const reconstructedStates = {};
        analysisResults.forEach((file) => {
          // Canonical keys: setFileStates replaces the map wholesale with no
          // canonical dedupe (unlike updateFileState), and result paths come
          // from main-process IPC whose separator/case style can differ from
          // the grid's selected paths.
          const key = toCanonicalPath(file.path) || file.path;
          if (file.analysis && !file.error)
            reconstructedStates[key] = {
              state: 'ready',
              timestamp: file.analyzedAt || new Date().toISOString(),
              analysis: file.analysis,
              analyzedAt: file.analyzedAt
            };
          else if (file.error)
            reconstructedStates[key] = {
              state: 'error',
              timestamp: file.analyzedAt || new Date().toISOString(),
              error: file.error,
              analyzedAt: file.analyzedAt
            };
          else
            reconstructedStates[key] = {
              state: 'pending',
              timestamp: new Date().toISOString()
            };
        });
        dispatch(setFileStatesAction(reconstructedStates));
      }
      const previouslyOrganized = organizedFiles || [];
      const processedIds = new Set(
        previouslyOrganized.flatMap((file) =>
          [file.originalPath, file.path, file.currentPath]
            .filter(Boolean)
            .map((p) => normalizePath(p))
        )
      );
      setProcessedFileIds(processedIds);
    };
    loadPersistedData();
  }, [analysisResults, dispatch, fileStates, organizedFiles, setProcessedFileIds, normalizePath]);

  const isAnalysisRunning = isAnalyzing || false;
  const analysisProgressFromDiscover = analysisProgress || {
    current: 0,
    total: 0
  };

  // getFilteredFiles already requires analysis; length is the Organize-local
  // ready count (also drops in-flight processedFileIds before Redux index updates).
  // Prefer this over fileStats.ready during an active move so the CTA shrinks immediately.
  const readyFilesCount = unprocessedFiles.length;
  const [progressLinger, setProgressLinger] = React.useState(false);
  const wasOrganizingRef = useRef(false);
  useEffect(() => {
    const wasOrganizing = wasOrganizingRef.current;
    wasOrganizingRef.current = isOrganizing;
    if (isOrganizing) {
      setProgressLinger(false);
      return undefined;
    }
    if (wasOrganizing && !isPaused) {
      setProgressLinger(true);
      const lingerId = setTimeout(() => setProgressLinger(false), 1600);
      return () => clearTimeout(lingerId);
    }
    return undefined;
  }, [isOrganizing, isPaused]);

  const approveSelectedFiles = useCallback(() => {
    if (selectedFiles.size === 0) return;
    const filesToProcess = unprocessedFiles.filter(
      (f) => f && f.analysis && selectedFiles.has(toCanonicalPath(f.path))
    );

    if (filesToProcess.length === 0) {
      addNotification('No valid files selected for organization', 'warning');
      return;
    }

    handleOrganizeFiles(filesToProcess);
    setSelectedFiles(new Set());
  }, [selectedFiles, unprocessedFiles, addNotification, handleOrganizeFiles, setSelectedFiles]);

  // Not license-gated (CP-19): moving already-analyzed files is the user's
  // own file operation, not new AI work. The gate applies to Analyze and
  // Reanalyze, where inference actually runs.
  const handleOrganizeClick = useCallback(() => {
    if (selectedFiles.size > 0) {
      approveSelectedFiles();
    } else {
      handleOrganizeFiles();
    }
  }, [selectedFiles.size, approveSelectedFiles, handleOrganizeFiles]);

  // Refresh the smart-folder list after the user creates a folder inline.
  // useLoadInitialData only fetches when the list is empty; this fetches
  // unconditionally so a newly-created folder immediately becomes available
  // for matching against files already on screen.
  const reloadSmartFolders = useCallback(async () => {
    if (!window?.electronAPI?.smartFolders?.get) return;
    try {
      const folders = await window.electronAPI.smartFolders.get();
      if (Array.isArray(folders)) {
        dispatch(setSmartFoldersAction(folders));
      }
    } catch (error) {
      logger.error('Failed to reload smart folders after inline create', {
        error: error?.message,
        stack: error?.stack
      });
    }
  }, [dispatch]);

  return (
    <div
      className="flex flex-col flex-1 min-h-0 gap-relaxed lg:gap-spacious pb-6"
      data-testid="phase-organize-content"
    >
      {/* Header */}
      <Stack className="text-center flex-shrink-0" gap="compact">
        <Heading as="h1" variant="display">
          Review & <span className="text-gradient">Organize</span>
        </Heading>
        <Text variant="lead" className="max-w-xl mx-auto">
          Review the move plan, refine anything that needs attention, and stay in control before
          files are relocated.
        </Text>
        {isAnalysisRunning && (
          <div className="flex items-center justify-center gap-compact mt-2">
            <div className="flex items-center gap-compact rounded-lg border border-stratosort-blue/30 bg-stratosort-blue/8 px-3 py-1.5 text-sm text-stratosort-blue">
              <span className="loading-spinner h-4 w-4 border-t-transparent" />
              Analysis continuing in background: {analysisProgressFromDiscover.current}/
              {analysisProgressFromDiscover.total} files
            </div>
          </div>
        )}
      </Stack>

      <MinimizableGuideCard
        persistKey="organize_review_guide"
        guideLabel="organize guide"
        className="border border-stratosort-blue/18 bg-gradient-to-r from-system-gray-100/95 to-stratosort-blue/8"
        collapsedSummary={
          <Text variant="small" className="text-system-gray-700">
            {readyFilesCount > 0
              ? `${readyFilesCount} file${readyFilesCount !== 1 ? 's' : ''} ready for review - expand for organize tips`
              : 'Waiting for review items - expand for organize tips'}
          </Text>
        }
      >
        <div className="flex flex-col gap-default lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-2xl">
            <div className="flex flex-wrap gap-compact mb-3">
              <StatusBadge variant="info" size="sm">
                Step 4 of 5
              </StatusBadge>
              <StatusBadge variant={readyFilesCount > 0 ? 'success' : 'warning'} size="sm">
                {readyFilesCount > 0 ? 'Review queue' : 'Waiting for review items'}
              </StatusBadge>
            </div>
            <Heading as="h2" variant="h5" className="mb-2">
              Approve the move plan with confidence
            </Heading>
            <Text variant="small" className="text-system-gray-600">
              This is the last review step before files move. Focus on anything uncertain, confirm
              the destinations look right, and use undo if you need to roll a batch back.
            </Text>
          </div>
          <div className="min-w-[240px] rounded-2xl border border-border-soft/70 bg-system-gray-100/50 px-4 py-3">
            <Text variant="tiny" className="text-system-gray-500">
              Review queue
            </Text>
            <Text variant="small" className="mt-1 font-medium text-system-gray-800">
              {readyFilesCount} ready • {failedCount} failed
            </Text>
            <Text variant="tiny" className="mt-1 text-system-gray-500">
              {selectedFiles.size > 0
                ? `${selectedFiles.size} currently selected for the next move`
                : 'Select specific files or approve the full reviewed batch'}
            </Text>
          </div>
        </div>
      </MinimizableGuideCard>

      {/* Toolbar */}
      <Inline className="justify-between pt-2" gap="cozy">
        <Inline
          className="flex-shrink-0"
          role="toolbar"
          aria-label="Organization tools"
          gap="default"
        >
          {safeSmartFolders.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowFoldersModal(true)}
              aria-label={`View ${safeSmartFolders.length} smart folders`}
            >
              <FolderOpen className="w-4 h-4" aria-hidden="true" />
              <span>{safeSmartFolders.length} Smart Folders</span>
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowStatusModal(true)}
            aria-label={`View file status: ${unprocessedFiles.length} ready, ${processedFiles.length} done, ${failedCount} failed`}
          >
            <BarChart3 className="w-4 h-4" aria-hidden="true" />
            <span>{unprocessedFiles.length} Ready</span>
            {processedFiles.length > 0 && (
              <span className="text-stratosort-success">• {processedFiles.length} Done</span>
            )}
            {failedCount > 0 && (
              <span className="text-stratosort-danger">• {failedCount} Failed</span>
            )}
          </Button>
          {processedFiles.length > 0 && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setShowHistoryModal(true)}
              className="border-stratosort-success/20 bg-stratosort-success/8 text-stratosort-success hover:border-stratosort-success/40 hover:bg-stratosort-success/12"
              aria-label={`View ${processedFiles.length} organized files history`}
            >
              <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
              <span>{processedFiles.length} Organized</span>
            </Button>
          )}
        </Inline>
        <UndoRedoToolbar className="flex-shrink-0" />
      </Inline>

      {lastOrganizeSummary && (
        <div
          className="flex items-center gap-cozy rounded-xl border px-4 py-3 text-sm bg-stratosort-success/10 border-stratosort-success/25 text-system-gray-800"
          role="status"
          aria-live="polite"
        >
          <CheckCircle2
            className="w-5 h-5 text-stratosort-success flex-shrink-0"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <Text as="span" variant="small" className="font-medium text-system-gray-900">
              {lastOrganizeSummary.partial
                ? `Moved ${lastOrganizeSummary.count} file${
                    lastOrganizeSummary.count !== 1 ? 's' : ''
                  } (${lastOrganizeSummary.failedCount} could not be completed)`
                : `Moved ${lastOrganizeSummary.count} file${
                    lastOrganizeSummary.count !== 1 ? 's' : ''
                  } to their destinations`}
            </Text>
            <Text as="div" variant="tiny" className="text-system-gray-600 mt-0.5">
              You can review organized files in the status panel or continue with the next batch.
            </Text>
          </div>
        </div>
      )}

      {/* Main Content */}
      <Stack className="flex-1 min-h-0" gap="relaxed">
        {/* Inline Bulk Operations */}
        {unprocessedFiles.length > 0 && selectedFiles.size > 0 && (
          <Card className="flex-shrink-0 p-4">
            <BulkOperations
              total={unprocessedFiles.length}
              selectedCount={selectedFiles.size}
              onSelectAll={selectAllFiles}
              onApproveSelected={approveSelectedFiles}
              bulkEditMode={bulkEditMode}
              setBulkEditMode={setBulkEditMode}
              bulkCategory={bulkCategory}
              setBulkCategory={setBulkCategory}
              onApplyBulkCategory={applyBulkCategoryChange}
              smartFolders={safeSmartFolders}
              isProcessing={isOrganizing}
            />
          </Card>
        )}

        {/* Files Ready - Main Focus Area */}
        <Card className="flex-1 min-h-0 flex flex-col overflow-hidden p-0">
          <div className="flex items-center justify-between px-6 py-4 border-b border-border-soft/70 bg-system-gray-100/75 flex-shrink-0">
            <div className="flex items-center gap-cozy">
              <Heading as="h2" variant="h5">
                Files ready for organization
              </Heading>
              {unprocessedFiles.length > 0 && (
                <Text
                  as="span"
                  variant="tiny"
                  className="px-2.5 py-1 font-medium bg-stratosort-blue/10 text-stratosort-blue rounded-full"
                >
                  {unprocessedFiles.length} file{unprocessedFiles.length !== 1 ? 's' : ''}
                </Text>
              )}
            </div>
            {unprocessedFiles.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={selectAllFiles}
                aria-label={
                  selectedFiles.size === unprocessedFiles.length
                    ? 'Deselect all files'
                    : 'Select all files'
                }
                className="text-stratosort-blue hover:text-stratosort-blue/80 font-medium"
              >
                {selectedFiles.size === unprocessedFiles.length ? 'Deselect all' : 'Select all'}
              </Button>
            )}
          </div>

          <div className="flex flex-col flex-1 min-h-0 bg-system-gray-50/20 overflow-hidden">
            {unprocessedFiles.length === 0 ? (
              <div className="h-full min-h-[12rem] flex flex-1 items-center justify-center p-6">
                <StateMessage
                  icon={processedFiles.length > 0 ? CheckCircle2 : Inbox}
                  tone={processedFiles.length > 0 ? 'success' : 'neutral'}
                  title={processedFiles.length > 0 ? 'All files organized!' : 'No files ready yet'}
                  description={
                    processedFiles.length > 0
                      ? 'Click "Organized" above to review your organized files, or return to Discover to add more.'
                      : 'Add files in Discover, run analysis, then return here to organize.'
                  }
                  action={
                    processedFiles.length === 0 ? (
                      <Button
                        onClick={() => actions.advancePhase(PHASES?.DISCOVER ?? 'discover')}
                        variant="primary"
                      >
                        ← Go to Discover
                      </Button>
                    ) : null
                  }
                  size="lg"
                  contentClassName="max-w-md"
                />
              </div>
            ) : (
              <div className="flex flex-col flex-1 min-h-0 overflow-hidden p-4 sm:p-6 pb-6">
                <ErrorBoundaryCore variant="simple" contextName="Uncategorized actions bar">
                  <UncategorizedActionsBar
                    unprocessedFiles={unprocessedFiles}
                    findSmartFolderForCategory={findSmartFolderForCategory}
                    findSmartFolderForFile={findSmartFolderForFile}
                    resolveDestination={resolveDestination}
                    defaultLocation={defaultLocation}
                    existingFolders={safeSmartFolders}
                    onFolderCreated={reloadSmartFolders}
                    addNotification={addNotification}
                  />
                </ErrorBoundaryCore>
                <ErrorBoundaryCore variant="simple" contextName="File Grid">
                  <VirtualizedFileGrid
                    files={unprocessedFiles}
                    selectedFiles={selectedFiles}
                    toggleFileSelection={toggleFileSelection}
                    getFileWithEdits={getFileWithEdits}
                    editingFiles={editingFiles}
                    findSmartFolderForCategory={findSmartFolderForCategory}
                    findSmartFolderForFile={findSmartFolderForFile}
                    resolveDestination={resolveDestination}
                    getFileStateDisplay={getFileStateDisplay}
                    handleEditFile={handleEditFile}
                    smartFolders={safeSmartFolders}
                    defaultLocation={defaultLocation}
                    onViewDetails={setViewingFileDetails}
                    focusFileIndex={focusFileIndex}
                    onFocusApplied={() => setFocusFileIndex(null)}
                  />
                </ErrorBoundaryCore>
              </div>
            )}
          </div>
        </Card>

        {/* Action Area - Sticky at bottom */}
        {(unprocessedFiles.length > 0 || isOrganizing || isPaused || progressLinger) && (
          <Card className="flex-shrink-0 p-4 border-t-4 border-t-stratosort-blue/10">
            {organizeConflicts && organizeConflicts.length > 0 && (
              <div className="mb-4 rounded-lg border border-stratosort-warning/30 bg-stratosort-warning/12 p-3">
                <div className="flex items-start gap-cozy">
                  <AlertTriangle className="w-5 h-5 text-stratosort-warning flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <Text variant="small" className="font-medium text-stratosort-warning">
                      Destination conflicts detected
                    </Text>
                    <Text variant="tiny" className="text-system-gray-600 mt-1">
                      {organizeConflicts.reduce((sum, c) => sum + c.files.length, 0)} files would be
                      moved to the same destination. Rename the files below to resolve:
                    </Text>
                    <ul className="mt-2 space-y-1 text-system-gray-700">
                      {organizeConflicts.slice(0, 3).map((conflict) => (
                        <li
                          key={conflict.destination || conflict.files?.[0]?.fileName}
                          className="flex items-start gap-1"
                        >
                          <span className="text-stratosort-warning">•</span>
                          <Text as="span" variant="tiny" className="truncate">
                            <strong>{conflict.files.map((f) => f.fileName).join(', ')}</strong>
                            {' → '}
                            <span className="text-system-gray-500">
                              {conflict.destination.split(/[\\/]/).pop()}
                            </span>
                          </Text>
                        </li>
                      ))}
                      {organizeConflicts.length > 3 && (
                        <li>
                          <Text variant="tiny" className="text-system-gray-500">
                            ...and {organizeConflicts.length - 3} more conflicts
                          </Text>
                        </li>
                      )}
                    </ul>
                  </div>
                </div>
              </div>
            )}
            {(isOrganizing || isPaused || progressLinger) && (
              <div className="mb-4" data-testid="organize-progress-panel">
                <OrganizeProgress
                  isOrganizing={isOrganizing}
                  batchProgress={batchProgress}
                  preview={organizePreview}
                  onCancel={cancelOrganize}
                  isCancelling={isCancelling}
                  onPause={pauseOrganize}
                  isPausing={isPausing}
                  isPaused={isPaused}
                  pausedSummary={pausedSummary}
                  onResume={resumeOrganize}
                  onDismissPaused={dismissPausedBatch}
                />
              </div>
            )}
            <div className="flex items-center justify-between gap-cozy">
              <div className="min-w-0">
                <Text variant="body" className="font-medium text-system-gray-700">
                  {isOrganizing ? 'Moving files…' : 'Review queue'}
                </Text>
                <Text variant="tiny" className="text-system-gray-500">
                  {isOrganizing
                    ? 'Please wait — destinations update as each file lands. You can cancel or pause below.'
                    : `${readyFilesCount} file${readyFilesCount !== 1 ? 's' : ''} prepared for movement. Undo remains available after the batch completes.`}
                </Text>
              </div>
              {!isOrganizing && !isPaused ? (
                <div className="flex shrink-0 items-center gap-compact">
                  <Button
                    onClick={async () => {
                      const filesToProcess =
                        selectedFiles.size > 0
                          ? unprocessedFiles.filter((f) =>
                              selectedFiles.has(toCanonicalPath(f.path))
                            )
                          : unprocessedFiles;
                      const plan = await handlePreviewOrganize(filesToProcess);
                      if (!plan) {
                        addNotification('Nothing to preview.', 'info', 4000, 'organize-preview');
                        return;
                      }
                      const movedSummary =
                        plan.wouldMove.length === 1 ? '1 file' : `${plan.wouldMove.length} files`;
                      const conflictSummary =
                        plan.conflicts > 0 ? `, ${plan.conflicts} renamed to avoid collisions` : '';
                      const folderSummary =
                        plan.wouldCreateFolders.length > 0
                          ? `, ${plan.wouldCreateFolders.length} new folder${plan.wouldCreateFolders.length !== 1 ? 's' : ''}`
                          : '';
                      const skippedSummary =
                        plan.skipped.length > 0 ? ` (${plan.skipped.length} skipped)` : '';
                      addNotification(
                        `Preview: would move ${movedSummary}${conflictSummary}${folderSummary}${skippedSummary}. Click Move to commit.`,
                        'info',
                        8000,
                        'organize-preview'
                      );
                    }}
                    variant="secondary"
                    size="md"
                    disabled={
                      (selectedFiles.size === 0 ? readyFilesCount === 0 : false) || isOrganizing
                    }
                  >
                    Preview
                  </Button>
                  <Button
                    onClick={handleOrganizeClick}
                    variant="success"
                    size="md"
                    className="px-6"
                    disabled={
                      (selectedFiles.size === 0 ? readyFilesCount === 0 : false) || isOrganizing
                    }
                    isLoading={isOrganizing}
                  >
                    {isOrganizing ? (
                      'Organizing...'
                    ) : (
                      <>
                        <Sparkles className="w-5 h-5 mr-2" />
                        <span>
                          {selectedFiles.size > 0
                            ? `Move ${selectedFiles.size} selected file${selectedFiles.size !== 1 ? 's' : ''}`
                            : `Move ${readyFilesCount} file${readyFilesCount !== 1 ? 's' : ''}`}
                        </span>
                      </>
                    )}
                  </Button>
                </div>
              ) : null}
            </div>
          </Card>
        )}
      </Stack>

      {/* Footer Buttons */}
      <ActionBar>
        <Button
          onClick={() => actions.advancePhase(PHASES?.DISCOVER ?? 'discover')}
          variant="secondary"
          disabled={isOrganizing}
          size="md"
          className="w-full sm:w-auto min-w-[180px]"
        >
          ← Back to Discovery
        </Button>
        <Button
          onClick={() => actions.advancePhase(PHASES?.COMPLETE ?? 'complete')}
          disabled={processedFiles.length === 0 || isOrganizing}
          size="md"
          className="w-full sm:w-auto min-w-[180px]"
          title={
            processedFiles.length === 0
              ? 'Process at least one file to view results.'
              : isOrganizing
                ? 'Finishing current organize operation.'
                : undefined
          }
        >
          View results →
        </Button>
      </ActionBar>

      {/* Analysis Details Panel */}
      <SidePanel
        isOpen={!!viewingFileDetails}
        onClose={() => setViewingFileDetails(null)}
        title="File analysis details"
        description="Review metadata, rationale, and extracted text."
        width={520}
      >
        {viewingFileDetails && viewingFileDetails.analysis && (
          <Stack gap="default">
            <Card
              variant="static"
              className="border-border-soft/70 bg-gradient-to-br from-system-gray-100/95 to-system-gray-50/70"
            >
              <div className="flex items-start gap-cozy">
                <div className="w-10 h-10 rounded-xl bg-stratosort-blue/10 text-stratosort-blue flex items-center justify-center shrink-0">
                  <FileText className="w-5 h-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <Text variant="small" className="font-semibold text-system-gray-900 break-words">
                    {viewingFileDetails.name}
                  </Text>
                  {detailHeaderPath.displayPath && (
                    <Text
                      variant="tiny"
                      className="text-system-gray-500 break-all mt-1"
                      title={redactPaths ? undefined : detailHeaderPath.rawPath}
                    >
                      {detailHeaderPath.displayPath}
                    </Text>
                  )}
                </div>
                {viewingFileDetails.analysis?.category && (
                  <StatusBadge variant="info" size="sm" className="shrink-0">
                    {viewingFileDetails.analysis.category}
                  </StatusBadge>
                )}
              </div>
            </Card>
            <AnalysisDetails
              analysis={viewingFileDetails.analysis}
              filePath={viewingFileDetails.path}
              redactPaths={redactPaths}
            />
          </Stack>
        )}
      </SidePanel>

      {/* Smart Folders Modal */}
      <Modal
        isOpen={showFoldersModal}
        onClose={() => setShowFoldersModal(false)}
        title="Target Smart Folders"
        size="lg"
        footer={
          <Inline className="justify-end" gap="default" wrap={false}>
            <Button onClick={() => setShowFoldersModal(false)} variant="secondary" size="sm">
              Close
            </Button>
          </Inline>
        }
      >
        <Stack gap="default" className="h-full">
          <Text variant="small" className="text-system-gray-600">
            Files will be organized into these destination folders based on their content.
          </Text>
          <div className="flex-1 min-h-0 overflow-y-auto modern-scrollbar -mx-6 px-6">
            <TargetFolderList folders={safeSmartFolders} defaultLocation={defaultLocation} />
          </div>
        </Stack>
      </Modal>

      {/* Status Overview Modal */}
      <Modal
        isOpen={showStatusModal}
        onClose={() => setShowStatusModal(false)}
        title={
          <span className="flex items-center gap-compact">
            <BarChart3 className="w-5 h-5 text-stratosort-blue" />
            File status overview
          </span>
        }
        size="md"
        footer={
          <Inline className="justify-end" gap="default" wrap={false}>
            <Button onClick={() => setShowStatusModal(false)} variant="secondary" size="sm">
              Close
            </Button>
          </Inline>
        }
      >
        <StatusOverview
          unprocessedCount={unprocessedFiles.length}
          processedCount={processedFiles.length}
          failedCount={failedCount}
        />
      </Modal>

      {/* Previously Organized Files Modal */}
      <Modal
        isOpen={showHistoryModal}
        onClose={() => setShowHistoryModal(false)}
        title="Previously organized files"
        size="lg"
        footer={
          <Inline className="justify-end" gap="default" wrap={false}>
            <Button onClick={() => setShowHistoryModal(false)} variant="secondary" size="sm">
              Close
            </Button>
          </Inline>
        }
      >
        <Stack gap="default" className="h-full">
          <Text variant="small" className="text-system-gray-600">
            {processedFiles.length} file
            {processedFiles.length !== 1 ? 's have' : ' has'} been successfully organized.
          </Text>
          <div className="flex-1 min-h-0 overflow-y-auto modern-scrollbar -mx-6 px-6">
            <ErrorBoundaryCore variant="simple" contextName="Processed Files">
              <VirtualizedProcessedFiles files={processedFiles} />
            </ErrorBoundaryCore>
          </div>
        </Stack>
      </Modal>
    </div>
  );
}

export default OrganizePhase;
