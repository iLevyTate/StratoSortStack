import React, { useCallback, useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { useSelector } from 'react-redux';
import { FolderOpen, CheckCircle, Clock, FileText } from 'lucide-react';
import { formatDisplayPath } from '../../utils/pathDisplay';
import { Heading, Text } from '../ui/Typography';
import Button from '../ui/Button';
import Card from '../ui/Card';
import { selectRedactPaths } from '../../store/selectors';

function OrganizeProgress({
  isOrganizing,
  batchProgress = { current: 0, total: 0, currentFile: '' },
  preview = [],
  onCancel,
  isCancelling = false,
  onPause,
  isPausing = false,
  isPaused = false,
  pausedSummary = null,
  onResume,
  onDismissPaused
}) {
  // PERF: Use memoized selector instead of inline Boolean coercion
  const redactPaths = useSelector(selectRedactPaths);
  const [startedAt, setStartedAt] = useState(null);
  const [etaText, setEtaText] = useState('Calculating…');
  const hasTotals = Number(batchProgress.total) > 0;
  const actualPercent = hasTotals
    ? Math.round((Number(batchProgress.current) / Number(batchProgress.total)) * 100)
    : 0;
  const [visualPercent, setVisualPercent] = useState(0);

  // Completion linger: when isOrganizing flips true→false, hold a "Done!"
  // frame for ~1.5s before unmounting. Otherwise the parent's `finally`
  // block clears state synchronously and the user sees the progress UI
  // disappear at 99% — looks like a freeze instead of a successful finish.
  // wasOrganizing tracks the previous value so we only flash on completion,
  // not on initial mount when isOrganizing is already false.
  const [completedFlash, setCompletedFlash] = useState(false);
  const wasOrganizingRef = useRef(false);
  const completedTimerRef = useRef(null);
  const startedAtRef = useRef(startedAt);
  startedAtRef.current = startedAt;
  const batchProgressRef = useRef(batchProgress);
  batchProgressRef.current = batchProgress;

  const computeEta = useCallback(() => {
    const s = startedAtRef.current;
    const bp = batchProgressRef.current;
    const total = Number(bp.total);
    const current = Number(bp.current);
    const hasT = total > 0;
    const pct = hasT ? Math.round((current / total) * 100) : 0;
    if (!s || !hasT || pct <= 0) return 'Calculating…';
    const elapsedMs = Date.now() - s;
    const perUnit = elapsedMs / Math.max(1, current);
    const remaining = Math.max(0, total - current);
    const remainingSec = Math.round((perUnit * remaining) / 1000);
    if (remainingSec < 60) return `${remainingSec}s remaining`;
    const m = Math.floor(remainingSec / 60);
    const sec = remainingSec % 60;
    return `${m}m ${sec}s remaining`;
  }, []);

  useEffect(() => {
    if (!isOrganizing) {
      setStartedAt(null);
      setVisualPercent(0);
      setEtaText('Calculating…');
      return;
    }
    if (!startedAt) setStartedAt(Date.now());
  }, [isOrganizing, startedAt]);

  // Snapshot the last meaningful progress so we can show "Done!" frame at the
  // FINAL count even after the parent zeroes batchProgress on completion.
  const lastProgressRef = useRef({ current: 0, total: 0 });
  useEffect(() => {
    const total = Number(batchProgress.total);
    const current = Number(batchProgress.current);
    if (total > 0) {
      lastProgressRef.current = { current, total };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the two scalar fields drive this; depending on the parent object would re-fire on identity changes that don't affect snapshot
  }, [batchProgress.current, batchProgress.total]);

  // Completion linger trigger: detect isOrganizing true → false transition.
  // Only flash when the previous run reached 100% (current === total > 0) —
  // cancelled/errored runs don't deserve a "Done!" badge and would mislead
  // the user about what actually happened.
  useEffect(() => {
    const wasOrganizing = wasOrganizingRef.current;
    wasOrganizingRef.current = isOrganizing;
    if (!wasOrganizing || isOrganizing) return undefined;

    const { current, total } = lastProgressRef.current;
    if (total <= 0 || current < total) return undefined;

    setCompletedFlash(true);
    completedTimerRef.current = setTimeout(() => {
      setCompletedFlash(false);
      completedTimerRef.current = null;
    }, 1500);

    return undefined;
  }, [isOrganizing]);

  // Always clear the timer on unmount so it can't fire against a dead
  // component if the parent advances phase mid-flash.
  useEffect(() => {
    return () => {
      if (completedTimerRef.current) {
        clearTimeout(completedTimerRef.current);
        completedTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isOrganizing) return undefined;
    // Update ETA text only when the computed string changes (avoids full re-render)
    const intervalId = setInterval(() => {
      setEtaText((prev) => {
        const next = computeEta();
        return next === prev ? prev : next;
      });
    }, 1000);
    return () => clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- computeEta is stable (deps: []), safe to omit
  }, [isOrganizing]);

  useEffect(() => {
    if (!isOrganizing) return undefined;
    if (hasTotals && actualPercent > 0) {
      setVisualPercent((prev) => Math.max(prev, actualPercent));
      return undefined;
    }
    let rafId;
    let isMounted = true;
    let lastFrame = 0;
    const FRAME_INTERVAL = 100; // ~10fps — imperceptible difference for a progress bar
    const tick = (now) => {
      if (!isMounted) return;
      if (now - lastFrame >= FRAME_INTERVAL) {
        lastFrame = now;
        setVisualPercent((prev) => {
          const next = prev + Math.max(0.2, (85 - prev) * 0.02);
          return Math.min(85, next);
        });
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      isMounted = false;
      cancelAnimationFrame(rafId);
    };
  }, [isOrganizing, hasTotals, actualPercent]);

  // Paused banner: the batch is parked (journal open, completed moves kept
  // and undoable); offer Resume / Dismiss. Rendered INSTEAD of the live
  // progress UI — a paused run is not organizing and must not flash "Done!".
  if (!isOrganizing && !completedFlash && isPaused) {
    const completed = Number(pausedSummary?.completed) || 0;
    const remaining = Number(pausedSummary?.remaining) || 0;
    return (
      <div className="py-8 w-full max-w-2xl mx-auto" role="status" aria-live="polite">
        <Card variant="static" className="p-5 border-system-yellow-200 bg-system-yellow-50">
          <div className="flex items-center gap-relaxed">
            <div className="relative w-12 h-12 flex-shrink-0 rounded-full bg-system-yellow-100 flex items-center justify-center">
              <Clock className="w-6 h-6 text-system-yellow-700" />
            </div>
            <div className="flex-1 min-w-0">
              <Heading as="h3" variant="h4" className="text-system-gray-900">
                Organizing paused
              </Heading>
              <Text variant="small" className="text-system-gray-600">
                {completed} file{completed === 1 ? '' : 's'} organized so far
                {remaining > 0 ? `, ${remaining} remaining` : ''}. Completed moves are kept and
                undoable.
              </Text>
            </div>
            <div className="flex items-center gap-compact">
              {typeof onResume === 'function' && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={onResume}
                  aria-label="Resume organize batch"
                >
                  Resume
                </Button>
              )}
              {typeof onDismissPaused === 'function' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onDismissPaused}
                  aria-label="Dismiss paused organize batch"
                >
                  Dismiss
                </Button>
              )}
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (!isOrganizing && !completedFlash) return null;

  // During completedFlash, batchProgress has already been zeroed by the
  // parent, so render the snapshot saved in lastProgressRef instead. This
  // keeps the bar at 100% and the count at "N of N" while we hold the frame.
  const flashSnapshot = completedFlash ? lastProgressRef.current : null;
  const displayCurrent = flashSnapshot ? flashSnapshot.current : Number(batchProgress.current);
  const displayTotal = flashSnapshot ? flashSnapshot.total : Number(batchProgress.total);
  const displayHasTotals = displayTotal > 0;
  const percentToShow = completedFlash
    ? 100
    : hasTotals
      ? Math.max(visualPercent, actualPercent)
      : visualPercent;

  return (
    <div className="py-8 w-full max-w-2xl mx-auto" role="status" aria-live="polite">
      <div
        className={`flex items-center justify-center gap-relaxed mb-8 ${completedFlash ? 'text-stratosort-success' : 'text-stratosort-blue'}`}
      >
        <div className="relative w-16 h-16 flex-shrink-0">
          {completedFlash ? (
            <div className="absolute inset-0 rounded-full bg-stratosort-success/10 flex items-center justify-center">
              <CheckCircle className="w-10 h-10 text-stratosort-success" />
            </div>
          ) : (
            <>
              <div className="absolute inset-0 animate-spin rounded-full border-4 border-stratosort-blue/30 border-t-stratosort-blue" />
              <div className="absolute inset-2 rounded-full bg-stratosort-blue/5 flex items-center justify-center">
                <FolderOpen className="w-6 h-6 text-stratosort-blue" />
              </div>
            </>
          )}
        </div>
        <div>
          <Heading
            as="h3"
            variant="h4"
            className={completedFlash ? 'text-stratosort-success' : 'text-stratosort-blue'}
          >
            {completedFlash ? 'Done!' : 'Organizing files...'}
          </Heading>
          <Text variant="small" className="text-system-gray-600">
            {completedFlash
              ? `Organized ${displayCurrent} ${displayCurrent === 1 ? 'file' : 'files'}.`
              : 'Do not close the app until completion'}
          </Text>
        </div>
      </div>

      <div className="mb-8">
        <Text
          as="div"
          variant="small"
          className="flex justify-between text-system-gray-600 mb-2 font-medium"
        >
          <span>
            {displayHasTotals ? (
              <>
                Progress: {displayCurrent} of {displayTotal}
              </>
            ) : (
              <>Working...</>
            )}
          </span>
          <span>{Math.round(percentToShow)}%</span>
        </Text>

        <div
          className="h-3 w-full bg-system-gray-100 rounded-full overflow-hidden mb-3"
          role="progressbar"
          {...(displayHasTotals
            ? {
                'aria-valuemin': 0,
                'aria-valuemax': 100,
                'aria-valuenow': Math.round(percentToShow),
                'aria-valuetext': `${Math.round(percentToShow)} percent`
              }
            : { 'aria-valuetext': 'Working' })}
        >
          {displayHasTotals ? (
            <div
              className={`h-full transition-[width,background-color] duration-300 ease-out rounded-full ${completedFlash ? 'bg-stratosort-success' : 'bg-stratosort-blue'}`}
              style={{ width: `${percentToShow}%` }}
            />
          ) : (
            <div className="h-full w-full bg-system-gray-200 relative overflow-hidden">
              <div className="absolute inset-y-0 left-0 w-1/3 bg-stratosort-blue animate-[shimmer_1.5s_infinite]" />
            </div>
          )}
        </div>

        {!completedFlash && batchProgress.currentFile && (
          <Text variant="tiny" className="text-system-gray-500 break-words truncate">
            Currently processing:{' '}
            <span className="font-medium text-system-gray-700">
              {formatDisplayPath(batchProgress.currentFile, { redact: redactPaths, segments: 2 })}
            </span>
          </Text>
        )}
        {!completedFlash && (
          <Text variant="tiny" className="text-system-gray-500 mt-1">
            {etaText}
          </Text>
        )}

        {/* Pause parks the batch (resumable); Cancel stops it for good. Both
            honor the atomic-move boundary: the in-flight file finishes, no
            further moves start, completed moves are kept and undoable. */}
        {!completedFlash && (typeof onCancel === 'function' || typeof onPause === 'function') && (
          <div className="mt-4 flex justify-end gap-compact">
            {typeof onPause === 'function' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onPause}
                disabled={isPausing || isCancelling}
                aria-label={isPausing ? 'Pausing organize batch' : 'Pause organize batch'}
              >
                {isPausing ? 'Pausing…' : 'Pause'}
              </Button>
            )}
            {typeof onCancel === 'function' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onCancel}
                disabled={isCancelling}
                aria-label={isCancelling ? 'Cancelling organize batch' : 'Cancel organize batch'}
              >
                {isCancelling ? 'Cancelling…' : 'Cancel'}
              </Button>
            )}
          </div>
        )}
      </div>

      {Array.isArray(preview) && preview.length > 0 && (
        <Card variant="static" className="p-0 overflow-hidden border-system-gray-200">
          <div className="px-4 py-3 bg-system-gray-50 border-b border-system-gray-200">
            <Text
              variant="tiny"
              className="font-semibold text-system-gray-700 uppercase tracking-wide"
            >
              Planned operations ({preview.length} files)
            </Text>
          </div>
          <div className="max-h-48 overflow-y-auto p-2 space-y-1 custom-scrollbar">
            {preview.slice(0, 6).map((op, idx) => {
              const isCurrentFile =
                batchProgress.currentFile && op.fileName === batchProgress.currentFile;
              const isProcessed = hasTotals && idx < batchProgress.current;

              return (
                <div
                  key={op.destination || op.fileName || idx}
                  className={`flex items-center gap-cozy text-sm p-2 rounded-lg transition-colors ${
                    isCurrentFile ? 'bg-stratosort-blue/10' : 'hover:bg-system-gray-50'
                  }`}
                >
                  <span className="flex-shrink-0">
                    {isProcessed ? (
                      <CheckCircle className="w-4 h-4 text-stratosort-success" />
                    ) : isCurrentFile ? (
                      <Clock className="w-4 h-4 text-stratosort-blue animate-pulse" />
                    ) : (
                      <FileText className="w-4 h-4 text-system-gray-400" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1 overflow-hidden grid grid-cols-2 gap-default">
                    <div className="font-medium text-system-gray-900 truncate" title={op.fileName}>
                      {op.fileName}
                    </div>
                    <Text
                      as="div"
                      variant="tiny"
                      className="text-system-gray-500 truncate flex items-center"
                      title={formatDisplayPath(op.destination, {
                        redact: redactPaths,
                        segments: 2
                      })}
                    >
                      <span className="mr-1">→</span>
                      {formatDisplayPath(op.destination, { redact: redactPaths, segments: 2 })}
                    </Text>
                  </div>
                </div>
              );
            })}
            {preview.length > 6 && (
              <Text variant="tiny" className="text-system-gray-500 italic text-center py-2">
                ...and {preview.length - 6} more files
              </Text>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

OrganizeProgress.propTypes = {
  isOrganizing: PropTypes.bool.isRequired,
  batchProgress: PropTypes.shape({
    current: PropTypes.number,
    total: PropTypes.number,
    currentFile: PropTypes.string
  }),
  preview: PropTypes.arrayOf(
    PropTypes.shape({
      fileName: PropTypes.string,
      destination: PropTypes.string
    })
  ),
  onCancel: PropTypes.func,
  isCancelling: PropTypes.bool,
  onPause: PropTypes.func,
  isPausing: PropTypes.bool,
  isPaused: PropTypes.bool,
  pausedSummary: PropTypes.shape({
    completed: PropTypes.number,
    remaining: PropTypes.number
  }),
  onResume: PropTypes.func,
  onDismissPaused: PropTypes.func
};

export default OrganizeProgress;
