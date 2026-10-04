import React, { memo, useCallback, useMemo } from 'react';
import PropTypes from 'prop-types';
import { motion, useReducedMotion } from 'framer-motion';
import { CheckCircle2, Check, ArrowLeft, FolderOpen, RotateCcw } from 'lucide-react';
import { PHASES } from '../../shared/constants';
import { useAppSelector, useAppDispatch } from '../store/hooks';
import { setPhase, resetUi } from '../store/slices/uiSlice';
import { resetFilesState } from '../store/slices/filesSlice';
import { resetAnalysisState } from '../store/slices/analysisSlice';
import { cancelPendingPersistence } from '../store/middleware/persistenceMiddleware';
import { Button, Card, MinimizableGuideCard, StatusBadge } from '../components/ui';
import { Heading, Text } from '../components/ui/Typography';
import { UndoRedoToolbar } from '../components/UndoRedoSystem';
import { ActionBar, Inline, Stack } from '../components/layout';
import { selectOrganizedCount, selectRedactPaths } from '../store/selectors';
import { formatDisplayFileName, formatDisplayPath } from '../utils/pathDisplay';
import { useNotification } from '../contexts/NotificationContext';
import { filesIpc } from '../services/ipc';
import { logger } from '../../shared/logger';
import { toCanonicalPath } from '../utils/canonicalPath';
import { collectOrganizedPathKeys, mergeOrganizedPathIndex } from '../utils/organizedPathIndex';

/**
 * Pick a folder path safe to hand to shell.openPath — prefers `newLocation`
 * (already a folder) and falls back to extracting the parent directory from
 * `file.path`. Returns null when nothing usable is present so the "Open
 * organized folder" CTA can degrade to "Review organized files".
 */
function pickOpenableFolder(file) {
  if (!file || typeof file !== 'object') return null;
  if (typeof file.newLocation === 'string' && file.newLocation) return file.newLocation;
  if (typeof file.destination === 'string' && file.destination) return file.destination;
  if (typeof file.path === 'string' && file.path) {
    const sepIndex = Math.max(file.path.lastIndexOf('/'), file.path.lastIndexOf('\\'));
    if (sepIndex > 0) return file.path.slice(0, sepIndex);
  }
  return null;
}

const FileRow = memo(function FileRow({ file, index, redactPaths }) {
  if (!file || typeof file !== 'object') {
    return null;
  }
  const originalName = file.originalName || file.name || `File ${index + 1}`;
  const fullPath = file.path || file.newLocation || file.destination || '';
  const displayName = formatDisplayFileName(originalName, { redact: redactPaths });
  const displayPath = redactPaths
    ? 'Destination hidden'
    : fullPath
      ? formatDisplayPath(fullPath, { redact: false, segments: 2 })
      : 'Organized';
  const rowTitle = redactPaths
    ? `${displayName} -> ${displayPath}`
    : `${originalName} → ${displayPath}`;

  return (
    <div
      className="flex items-center py-2.5 px-4 gap-cozy border-b border-border-soft/30 last:border-0"
      aria-label={`Organized file ${index + 1}`}
    >
      <Check className="w-4 h-4 text-stratosort-success flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <Text variant="small" className="text-system-gray-800 truncate" title={rowTitle}>
          {displayName}
        </Text>
        <Text variant="tiny" className="text-system-gray-500 truncate">
          {displayPath}
        </Text>
      </div>
    </div>
  );
});

function CompletePhase() {
  const dispatch = useAppDispatch();
  const { showError } = useNotification();
  const organizedFiles = useAppSelector((state) => state.files.organizedFiles);
  const organizedPathIndex = useAppSelector((state) => state.files.organizedPathIndex);
  const organizedCount = useAppSelector(selectOrganizedCount);
  const analysisResults = useAppSelector((state) => state.analysis?.results);
  const redactPaths = useAppSelector(selectRedactPaths);
  const shouldReduceMotion = useReducedMotion();

  const organizedKeys = useMemo(
    () =>
      new Set(
        mergeOrganizedPathIndex(organizedPathIndex, collectOrganizedPathKeys(organizedFiles))
      ),
    [organizedPathIndex, organizedFiles]
  );

  const { filesToRender, overflowCount, destinationCount, totalFiles, primaryDestination } =
    useMemo(() => {
      const safeFiles = Array.isArray(organizedFiles) ? organizedFiles : [];
      const destinations = new Set();
      // Track folder counts separately from the destination set so the
      // "Open organized folder" CTA can pick a real directory path, even if
      // some entries fall back to the synthetic 'Organized' placeholder.
      const folderCounts = new Map();
      safeFiles.forEach((file) => {
        if (!file || typeof file !== 'object') return;
        const destination = file.path || file.newLocation || file.destination || 'Organized';
        destinations.add(destination);
        const folder = pickOpenableFolder(file);
        if (folder) {
          folderCounts.set(folder, (folderCounts.get(folder) || 0) + 1);
        }
      });

      let topFolder = null;
      let topCount = 0;
      folderCounts.forEach((count, folder) => {
        if (count > topCount) {
          topCount = count;
          topFolder = folder;
        }
      });

      const displayed = safeFiles.slice(0, 12);
      return {
        filesToRender: displayed,
        overflowCount: Math.max(organizedCount - displayed.length, 0),
        destinationCount: destinations.size,
        // Same source as Dashboard "Organized" (selectOrganizedCount).
        totalFiles: organizedCount,
        primaryDestination: topFolder
      };
    }, [organizedFiles, organizedCount]);

  // Analyzed files still waiting to organize — exclude already-moved paths so
  // the Complete screen does not treat remapped results as "skipped"/unmoved.
  const { analyzedCount, skippedCount } = useMemo(() => {
    const results = Array.isArray(analysisResults) ? analysisResults : [];
    let analyzed = 0;
    let remaining = 0;
    for (const result of results) {
      if (!result?.path || (!result.analysis && !result.error)) continue;
      analyzed += 1;
      if (!organizedKeys.has(toCanonicalPath(result.path))) {
        remaining += 1;
      }
    }
    return { analyzedCount: analyzed, skippedCount: remaining };
  }, [analysisResults, organizedKeys]);

  const sessionSummary = useMemo(() => {
    if (totalFiles === 0) {
      return 'This session did not move any files.';
    }

    return `${totalFiles} file${totalFiles !== 1 ? 's' : ''} moved into ${destinationCount} destination${
      destinationCount !== 1 ? 's' : ''
    }.`;
  }, [destinationCount, totalFiles]);

  const actions = useMemo(
    () => ({
      advancePhase: (phase) => dispatch(setPhase(phase)),
      resetWorkflow: () => {
        // React 18+ batches state updates automatically
        dispatch(resetUi());
        dispatch(resetFilesState());
        dispatch(resetAnalysisState());
        // Kill any save still pending in the debounce window before we clear
        // storage — otherwise that writer fires ~1s later and re-persists the
        // key we are about to remove. Synchronous, so no timer survives.
        cancelPendingPersistence();
        try {
          localStorage.removeItem('stratosort_workflow_state');
          localStorage.removeItem('stratosort_redux_state');
        } catch {
          // Ignore cleanup errors
        }
      }
    }),
    [dispatch]
  );

  const handleOpenFolder = useCallback(async () => {
    if (!primaryDestination) return;
    try {
      await filesIpc.openFolder(primaryDestination);
    } catch (error) {
      logger.warn('[CompletePhase] Failed to open organized folder', {
        error: error?.message || String(error)
      });
      showError('Could not open the folder. The destination may have moved or been deleted.');
    }
  }, [primaryDestination, showError]);

  const canOpenFolder = Boolean(primaryDestination) && totalFiles > 0;

  const showCelebration = totalFiles > 0 && !shouldReduceMotion;

  return (
    <div
      className="flex flex-col flex-1 min-h-0 gap-relaxed lg:gap-spacious pb-6"
      data-testid="phase-complete-content"
    >
      {/* Header with optional celebration animation */}
      <Stack className="text-center flex-shrink-0" gap="compact">
        {totalFiles > 0 && (
          <motion.div
            className="flex justify-center"
            initial={showCelebration ? { opacity: 0, scale: 0.9 } : false}
            animate={{ opacity: 1, scale: 1 }}
            transition={{
              duration: 0.32,
              ease: [0.22, 1, 0.36, 1]
            }}
            aria-hidden="true"
          >
            <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-stratosort-success/12 text-stratosort-success ring-1 ring-stratosort-success/30">
              <CheckCircle2 className="h-8 w-8" />
            </span>
          </motion.div>
        )}
        <Inline className="justify-center" gap="compact">
          <StatusBadge variant="success" size="sm">
            Step 5 of 5
          </StatusBadge>
        </Inline>
        <motion.div
          initial={showCelebration ? { opacity: 0 } : false}
          animate={{ opacity: 1 }}
          transition={{
            duration: 0.22,
            ease: [0.22, 1, 0.36, 1]
          }}
        >
          <Heading as="h1" variant="display">
            Organization <span className="text-gradient">Complete</span>
          </Heading>
        </motion.div>
        <motion.div
          initial={showCelebration ? { opacity: 0 } : false}
          animate={{ opacity: 1 }}
          transition={{
            duration: 0.22,
            delay: showCelebration ? 0.1 : 0,
            ease: [0.22, 1, 0.36, 1]
          }}
          className="max-w-xl mx-auto"
        >
          <Text variant="lead">
            {totalFiles > 0
              ? `Your reviewed batch is complete. ${totalFiles} file${
                  totalFiles !== 1 ? 's' : ''
                } are now in place.`
              : 'No files were organized in this session.'}
          </Text>
        </motion.div>
      </Stack>

      <MinimizableGuideCard
        persistKey="complete_summary_guide"
        guideLabel="completion guide"
        className="border border-stratosort-blue/18 bg-gradient-to-r from-system-gray-100/95 to-stratosort-blue/8"
        collapsedSummary={
          <Text variant="small" className="text-system-gray-700">
            {sessionSummary} Expand for wrap-up details.
          </Text>
        }
      >
        <div className="flex flex-col gap-default lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-2xl">
            <div className="flex flex-wrap gap-compact mb-3">
              <StatusBadge variant={totalFiles > 0 ? 'success' : 'info'} size="sm">
                Session summary
              </StatusBadge>
            </div>
            <Heading as="h2" variant="h5" className="mb-2">
              A clean finish for this batch
            </Heading>
            <Text variant="small" className="text-system-gray-600">
              Review what changed, confirm the outcome, and start the next batch when you are ready.
            </Text>
          </div>
          <div className="min-w-[240px] rounded-2xl border border-border-soft/70 bg-system-gray-100/50 px-4 py-3">
            <Text variant="tiny" className="text-system-gray-500">
              Session summary
            </Text>
            <Text variant="small" className="mt-1 font-medium text-system-gray-800">
              {sessionSummary}
            </Text>
          </div>
        </div>
      </MinimizableGuideCard>

      {/* Toolbar with success badge animation */}
      <motion.div
        initial={showCelebration ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        transition={{
          duration: 0.22,
          delay: showCelebration ? 0.18 : 0,
          ease: [0.22, 1, 0.36, 1]
        }}
      >
        <Inline className="justify-between pt-2" gap="cozy">
          <Inline gap="relaxed">
            {totalFiles > 0 && (
              <StatusBadge variant="success">
                <CheckCircle2 className="w-3.5 h-3.5" />
                {totalFiles} file{totalFiles !== 1 ? 's' : ''} moved
              </StatusBadge>
            )}
            {analyzedCount > 0 && (
              <StatusBadge variant="info">{analyzedCount} analyzed</StatusBadge>
            )}
            {skippedCount > 0 && (
              <StatusBadge variant="warning">{skippedCount} still queued</StatusBadge>
            )}
            {destinationCount > 1 && (
              <StatusBadge variant="info">{destinationCount} destinations</StatusBadge>
            )}
          </Inline>
          <UndoRedoToolbar className="flex-shrink-0" showClearHistory />
        </Inline>
      </motion.div>

      {/* Main Content */}
      <Stack className="flex-1 min-h-0" gap="relaxed">
        <Card className="flex-1 min-h-0 flex flex-col overflow-hidden p-0 shadow-md">
          <div className="flex items-center justify-between px-6 py-4 border-b border-border-soft/70 bg-system-gray-100/70 flex-shrink-0">
            <Heading as="h2" variant="h5">
              Session summary
            </Heading>
            {totalFiles > 0 && (
              <Text variant="tiny" className="text-system-gray-500">
                {totalFiles} file{totalFiles !== 1 ? 's' : ''} organized
              </Text>
            )}
          </div>

          <div className="flex-1 min-h-0 bg-system-gray-50/30 overflow-y-auto modern-scrollbar">
            {filesToRender.length > 0 ? (
              <>
                {filesToRender.map((file, index) => (
                  <FileRow
                    key={
                      // Prefer originalPath (unique per move). Destination path alone
                      // collides when the same file was organized twice or two sources
                      // land on one name — React then warns and can omit rows.
                      [file.originalPath, file.path, file.id, file.originalName, `file-${index}`]
                        .filter(Boolean)
                        .join('|')
                    }
                    file={file}
                    index={index}
                    redactPaths={redactPaths}
                  />
                ))}
                {overflowCount > 0 && (
                  <div className="text-sm text-system-gray-500 text-center py-3 bg-system-gray-50/50 border-t border-border-soft/30">
                    +{overflowCount} more file{overflowCount !== 1 ? 's' : ''}
                  </div>
                )}
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center p-8">
                <Text variant="small" className="font-medium text-system-gray-700">
                  No files were moved
                </Text>
                <Text variant="tiny" className="text-system-gray-500 mt-1">
                  Go back to adjust your selections or start a new session.
                </Text>
              </div>
            )}
          </div>
        </Card>
      </Stack>

      {/* Footer Navigation — primary success-path action on the right, with
          "Start over" as a ghost secondary. The "Review organized files"
          back-affordance lives on the left as a tertiary because most users
          finish here; only those who want to verify need to step backward. */}
      <ActionBar className="mt-auto pt-4">
        <Button
          onClick={() => actions.advancePhase(PHASES?.ORGANIZE ?? 'organize')}
          variant="ghost"
          size="md"
          className="w-full sm:w-auto"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Review organized files
        </Button>
        <Button
          onClick={() => actions.resetWorkflow()}
          variant="ghost"
          size="md"
          className="w-full sm:w-auto min-w-[160px]"
        >
          <RotateCcw className="w-4 h-4 mr-2" />
          Start over
        </Button>
        <Button
          onClick={
            canOpenFolder
              ? handleOpenFolder
              : () => actions.advancePhase(PHASES?.ORGANIZE ?? 'organize')
          }
          variant="primary"
          size="md"
          className="w-full sm:w-auto min-w-[200px]"
          aria-label={
            canOpenFolder
              ? 'Open the folder where organized files were moved'
              : 'Review organized files'
          }
        >
          <FolderOpen className="w-4 h-4 mr-2" />
          {canOpenFolder ? 'Open organized folder' : 'Review organized files'}
        </Button>
      </ActionBar>
    </div>
  );
}

FileRow.propTypes = {
  file: PropTypes.shape({
    originalName: PropTypes.string,
    name: PropTypes.string,
    path: PropTypes.string,
    newLocation: PropTypes.string,
    destination: PropTypes.string
  }),
  index: PropTypes.number.isRequired,
  redactPaths: PropTypes.bool
};

export default memo(CompletePhase);
