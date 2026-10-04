import React, { useEffect, useMemo, useState, useCallback } from 'react';
import PropTypes from 'prop-types';
import { ChevronDown } from 'lucide-react';
import Button from '../ui/Button';
import Switch from '../ui/Switch';
import { ConfirmModal } from '../ui/Modal';
import SettingRow from './SettingRow';
import SettingsCard from './SettingsCard';
import SettingsGroup from './SettingsGroup';
import { createLogger } from '../../../shared/logger';
import { useAppSelector } from '../../store/hooks';
import { selectIsAnalyzing, selectAnalysisProgress } from '../../store/selectors';
import { Caption, Text } from '../ui/Typography';
import { embeddingsIpc } from '../../services/ipc';
import { DEFAULT_AI_MODELS } from '../../../shared/constants';
import { isIpcTimeoutError, toErrorMessage } from '../../utils/errorMapping';
const logger = createLogger('EmbeddingRebuildSection');

/**
 * Embedding rebuild section for folder and file embeddings
 */
function EmbeddingRebuildSection({ addNotification }) {
  const [isFullRebuilding, setIsFullRebuilding] = useState(false);
  const [isReanalyzingAll, setIsReanalyzingAll] = useState(false);
  const [isReindexingHashes, setIsReindexingHashes] = useState(false);
  const [stats, setStats] = useState(null);
  const [isLoadingStats, setIsLoadingStats] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [applyNamingOnReanalyze, setApplyNamingOnReanalyze] = useState(false);
  // Type-to-confirm gates for the two destructive actions. Booleans rather
  // than refs so React re-renders close the modal on success/cancel.
  const [showRebuildConfirm, setShowRebuildConfirm] = useState(false);
  const [showReanalyzeConfirm, setShowReanalyzeConfirm] = useState(false);
  // Rebuild has no backend progress channel today, but the user still needs
  // to know the operation is alive rather than hung. Track elapsed ms from
  // the moment the request fires and display a running counter; the UI
  // spinner alone gave no sense of how long a multi-minute rebuild had
  // been running.
  const [rebuildStartedAt, setRebuildStartedAt] = useState(null);
  const [rebuildElapsedMs, setRebuildElapsedMs] = useState(0);
  const isMountedRef = React.useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const isAnalyzing = useAppSelector(selectIsAnalyzing);
  const analysisProgress = useAppSelector(selectAnalysisProgress);

  // Returns true when stats were fetched successfully — the polling loop
  // below uses this to drive its error backoff (refreshStats never rejects,
  // so a rejection-based backoff would be dead code).
  const refreshStats = useCallback(async (options = {}) => {
    const forceRefresh = options === true || options?.force === true;
    if (isMountedRef.current) setIsLoadingStats(true);
    let ok = false;
    try {
      const res = await embeddingsIpc.getStatsCached({ forceRefresh });
      if (isMountedRef.current) {
        if (res && res.success) {
          ok = true;
          setStats({
            files: typeof res.files === 'number' ? res.files : 0,
            folders: typeof res.folders === 'number' ? res.folders : 0,
            smartFolderCount:
              typeof res.smartFolderCount === 'number' ? res.smartFolderCount : null,
            initialized: Boolean(res.initialized),
            needsFileEmbeddingRebuild: Boolean(res.needsFileEmbeddingRebuild),
            embeddingCoverageLow: Boolean(res.embeddingCoverageLow),
            uncoveredFiles: typeof res.uncoveredFiles === 'number' ? res.uncoveredFiles : 0,
            embeddingBuildInProgress: Boolean(res.embeddingBuildInProgress),
            analysisHistory: res.analysisHistory,
            embeddingIndex: res.embeddingIndex,
            activeEmbeddingModel: res.activeEmbeddingModel,
            embeddingModelMismatch: Boolean(res.embeddingModelMismatch)
          });
        } else {
          logger.warn('[EmbeddingRebuildSection] getStats returned failure', { error: res?.error });
          setStats(null);
        }
      }
    } catch (e) {
      if (isMountedRef.current) {
        logger.debug('[EmbeddingRebuildSection] getStats failed', { error: e?.message });
        setStats(null);
      }
    } finally {
      if (isMountedRef.current) setIsLoadingStats(false);
    }
    return ok;
  }, []);

  useEffect(() => {
    let timerId;
    let errorCount = 0;
    let isMounted = true;

    const scheduleNext = () => {
      if (!isMounted) return;
      const delay = Math.min(5000 * 2 ** errorCount, 60000);

      timerId = setTimeout(() => {
        if (!isMounted) return;
        if (document.hidden) {
          scheduleNext();
          return;
        }

        refreshStats()
          .then((ok) => {
            if (isMounted) {
              // refreshStats handles its own errors and resolves with a
              // success flag — key the backoff off that flag, not off a
              // rejection that can never happen.
              if (ok) {
                errorCount = 0;
              } else {
                errorCount++;
                logger.debug('[EmbeddingRebuildSection] Stats refresh failed', {
                  nextRetryMs: Math.min(5000 * 2 ** errorCount, 60000)
                });
              }
              scheduleNext();
            }
            return undefined;
          })
          .catch(() => {
            // Defensive: refreshStats never rejects today.
            if (isMounted) {
              errorCount++;
              scheduleNext();
            }
          });
      }, delay);
    };

    refreshStats()
      .catch((err) => {
        logger.debug('[EmbeddingRebuildSection] Initial stats refresh failed', {
          error: err?.message
        });
      })
      .finally(() => {
        if (isMounted) scheduleNext();
      });

    return () => {
      isMounted = false;
      if (timerId) clearTimeout(timerId);
    };
  }, [refreshStats]);

  useEffect(() => {
    const handleOperationProgress = (event) => {
      const payload = event?.detail;
      if (!payload || payload.type !== 'batch_analyze') return;

      const completed = Number(payload.completed);
      const total = Number(payload.total);
      if (Number.isFinite(completed) && Number.isFinite(total) && total > 0 && completed >= total) {
        embeddingsIpc.invalidateStatsCache();
        refreshStats({ force: true });
      }
    };

    window.addEventListener('operation-progress', handleOperationProgress);
    return () => window.removeEventListener('operation-progress', handleOperationProgress);
  }, [refreshStats]);

  // Tick an elapsed-time counter while rebuild is active so the user gets
  // positive evidence of progress. Using setInterval here (not a rAF loop)
  // because the interval is user-visible seconds, not frame-accurate.
  useEffect(() => {
    if (!rebuildStartedAt) {
      setRebuildElapsedMs(0);
      return undefined;
    }
    const tick = () => {
      if (isMountedRef.current) {
        setRebuildElapsedMs(Date.now() - rebuildStartedAt);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [rebuildStartedAt]);

  const formatElapsed = (ms) => {
    if (!Number.isFinite(ms) || ms < 0) return '0s';
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`;
  };

  const statsLabel = useMemo(() => {
    if (isLoadingStats && !stats) return 'Loading embeddings status\u2026';
    if (!stats) return 'Embeddings status unavailable - check AI engine status';
    if (stats.embeddingModelMismatch) {
      const indexed = stats.embeddingIndex?.model ? `${stats.embeddingIndex.model}` : 'unknown';
      const active = stats.activeEmbeddingModel ? `${stats.activeEmbeddingModel}` : 'unknown';
      return `Embedding model mismatch: indexed with ${indexed}, configured ${active}. Run full rebuild to apply.`;
    }
    if (stats.embeddingBuildInProgress) {
      const pending = stats.analysisHistory?.embedding?.pendingFiles || 0;
      return `Embedding build in progress${pending > 0 ? ` (${pending} pending)` : ''}. Refresh in a moment for updated coverage.`;
    }
    if (stats.needsFileEmbeddingRebuild) {
      const eligible =
        stats.analysisHistory?.embedding?.eligibleFiles ?? stats.analysisHistory?.totalFiles ?? 0;
      const folderLabel =
        typeof stats.smartFolderCount === 'number'
          ? `${stats.smartFolderCount} smart folders`
          : `${stats.folders} folder embeddings`;
      return `${folderLabel} • ${stats.files} file embeddings (${eligible} eligible files - click Rebuild to index)`;
    }
    if (stats.embeddingCoverageLow && stats.uncoveredFiles > 0) {
      const eligible =
        stats.analysisHistory?.embedding?.eligibleFiles ?? stats.analysisHistory?.totalFiles ?? 0;
      return `${stats.files} of ${eligible} analyzed files are searchable (${stats.uncoveredFiles} missing) - missing files are indexed at startup, or click Rebuild`;
    }
    if (stats.files === 0 && stats.folders === 0) {
      return 'No embeddings yet - analyze files and add smart folders first';
    }
    const folderLabel =
      typeof stats.smartFolderCount === 'number'
        ? `${stats.smartFolderCount} smart folders`
        : `${stats.folders} folder embeddings`;
    return `${folderLabel} • ${stats.files} file embeddings`;
  }, [stats, isLoadingStats]);

  const handleFullRebuild = useCallback(async () => {
    try {
      setIsFullRebuilding(true);
      setRebuildStartedAt(Date.now());
      if (!window?.electronAPI?.embeddings?.fullRebuild) {
        addNotification('Embedding API not available', 'error');
        return;
      }
      addNotification('Starting full rebuild\u2026 This may take a while.', 'info');
      const res = await window.electronAPI.embeddings.fullRebuild();
      if (res?.success) {
        const folders = res.folders || 0;
        const files = res.files || 0;
        const chunks = res.chunks || 0;
        addNotification(
          `Full rebuild complete: ${folders} folders, ${files} files, ${chunks} chunks${res.model ? ` (model: ${res.model})` : ''}`,
          'success'
        );
      } else {
        const errorMsg = String(res?.error || '');
        const code = String(res?.errorCode || res?.code || '');
        if (
          code === 'AI_ENGINE_UNAVAILABLE' ||
          code === 'SERVICE_NOT_READY' ||
          code === 'SERVICE_UNAVAILABLE' ||
          code === 'EMBEDDING_SERVICE_UNAVAILABLE' ||
          errorMsg.includes('AI engine') ||
          errorMsg.includes('not initialized') ||
          errorMsg.includes('ECONNREFUSED')
        ) {
          addNotification(
            errorMsg || 'AI engine unavailable. Check models and try again.',
            'error'
          );
        } else if (code === 'VECTOR_DB_UNAVAILABLE' || code === 'VECTOR_DB_PENDING') {
          addNotification(
            'Vector DB is initializing. Please wait a moment and try again.',
            'error'
          );
        } else if (errorMsg.includes('Vector DB')) {
          addNotification('Vector DB unavailable. Check Settings or restart the app.', 'error');
        } else if (code === 'MODEL_NOT_AVAILABLE') {
          const modelLabel = 'Embedding model';
          const modelName = res.model || DEFAULT_AI_MODELS.EMBEDDING;
          addNotification(`${modelLabel} not available. Download it first: ${modelName}`, 'error');
        } else {
          addNotification(
            errorMsg || 'Full rebuild failed. Check AI engine status in Settings.',
            'error'
          );
        }
      }
    } catch (err) {
      if (isIpcTimeoutError(err)) {
        // The renderer-side invoke budget elapsed but the main process keeps
        // rebuilding (and typically finishes successfully). Reporting this as
        // a failure made users retry into a REBUILD_IN_PROGRESS error.
        addNotification(
          'The rebuild is taking longer than expected and is still running in the background. The embeddings status above will update when it finishes.',
          'info'
        );
      } else {
        addNotification('Full rebuild failed. Check AI engine status.', 'error');
      }
    } finally {
      if (isMountedRef.current) {
        setIsFullRebuilding(false);
        setRebuildStartedAt(null);
      }
      refreshStats({ force: true });
    }
  }, [addNotification, refreshStats]);

  const handleReanalyzeAll = useCallback(async () => {
    try {
      if (isMountedRef.current) setIsReanalyzingAll(true);
      if (!window?.electronAPI?.embeddings?.reanalyzeAll) {
        addNotification('Embedding API not available', 'error');
        return;
      }
      addNotification('Starting reanalysis of all files\u2026 This may take a while.', 'info');
      const res = await window.electronAPI.embeddings.reanalyzeAll({
        applyNaming: applyNamingOnReanalyze
      });
      if (res?.success) {
        addNotification(
          `Queued ${res.queued} files for reanalysis. Analysis will run in the background.`,
          'success'
        );
      } else {
        const errorMsg = String(res?.error || '');
        const code = String(res?.errorCode || res?.code || '');
        if (
          code === 'AI_ENGINE_UNAVAILABLE' ||
          code === 'SERVICE_NOT_READY' ||
          code === 'SERVICE_UNAVAILABLE' ||
          code === 'EMBEDDING_SERVICE_UNAVAILABLE' ||
          errorMsg.includes('AI engine') ||
          errorMsg.includes('not initialized') ||
          errorMsg.includes('ECONNREFUSED')
        ) {
          addNotification(
            errorMsg || 'AI engine unavailable. Check models and try again.',
            'error'
          );
        } else if (code === 'VECTOR_DB_UNAVAILABLE' || code === 'VECTOR_DB_PENDING') {
          addNotification(
            'Vector DB is initializing. Please wait a moment and try again.',
            'error'
          );
        } else if (errorMsg.includes('WATCHER_NOT_AVAILABLE')) {
          addNotification('Configure smart folders first before reanalyzing.', 'error');
        } else if (code === 'MODEL_NOT_AVAILABLE') {
          // Reanalysis exercises the text/vision models too — don't label the
          // missing model "Embedding" when the handler reports e.g. a vision
          // model as unavailable.
          const modelName = res.model;
          addNotification(
            modelName
              ? `Required AI model not available. Download it first: ${modelName}`
              : 'A required AI model is not available. Check model downloads in AI Configuration.',
            'error'
          );
        } else {
          addNotification(
            res?.error || 'Reanalyze failed. Check AI engine status in Settings.',
            'error'
          );
        }
      }
    } catch {
      addNotification('Reanalyze failed. Check AI engine status.', 'error');
    } finally {
      if (isMountedRef.current) setIsReanalyzingAll(false);
      refreshStats({ force: true });
    }
  }, [addNotification, refreshStats, applyNamingOnReanalyze]);

  const analysisIsActive = Boolean(isAnalyzing && (analysisProgress?.total || 0) > 0);
  const analysisCurrent = Number.isFinite(analysisProgress?.current) ? analysisProgress.current : 0;
  const analysisTotal = Number.isFinite(analysisProgress?.total) ? analysisProgress.total : 0;

  return (
    <SettingsCard
      title="Embeddings maintenance"
      description="Rebuild embeddings updates the search index only (keeps analysis). Reanalyze all files re-runs full AI analysis and may rename files again."
    >
      <SettingRow layout="col" label="Embeddings status" description={statsLabel}>
        <Text variant="tiny" className="text-system-gray-400">
          When changing embedding models, use <strong>Rebuild all embeddings</strong> to update
          everything. This preserves your analysis data but regenerates the search index.
        </Text>
        {analysisIsActive && (
          <Text variant="tiny" className="text-system-gray-500 mt-1">
            Background analysis running: {analysisCurrent}/{analysisTotal} files
          </Text>
        )}
      </SettingRow>

      <SettingRow
        layout="col"
        label="Rebuild all embeddings"
        description="Use this after changing the embedding model setting. It updates folder matches, file search, and sorting."
      >
        <Button
          onClick={() => setShowRebuildConfirm(true)}
          variant="primary"
          disabled={isFullRebuilding || isReanalyzingAll}
          isLoading={isFullRebuilding}
          type="button"
          title="Clear all embeddings and rebuild everything with current model"
          size="sm"
          className="w-full sm:w-auto"
          aria-describedby="full-rebuild-caveats"
        >
          {isFullRebuilding
            ? `Rebuilding\u2026 ${formatElapsed(rebuildElapsedMs)}`
            : 'Rebuild all embeddings'}
        </Button>
        {isFullRebuilding ? (
          <Text
            variant="tiny"
            className="text-system-gray-500 mt-1"
            role="status"
            aria-live="polite"
          >
            Running for {formatElapsed(rebuildElapsedMs)}. Cannot be cancelled once started —
            leaving this panel is safe; the rebuild continues in the background.
          </Text>
        ) : (
          <Text id="full-rebuild-caveats" variant="tiny" className="text-system-gray-500 mt-1">
            Rebuild runs to completion and cannot be cancelled. Expect several minutes for large
            libraries.
          </Text>
        )}
      </SettingRow>

      {/* Advanced Options Toggle */}
      <div className="pt-4 border-t border-border-soft">
        <Button
          onClick={() => setShowAdvanced(!showAdvanced)}
          variant="ghost"
          size="sm"
          rightIcon={
            <ChevronDown
              className={`w-4 h-4 transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
            />
          }
          className="text-stratosort-blue hover:text-stratosort-blue/80"
        >
          {showAdvanced ? 'Hide advanced options' : 'Show advanced options'}
        </Button>

        {showAdvanced && (
          <SettingsGroup className="mt-4">
            <div>
              <Caption className="block text-stratosort-danger mb-2">Danger zone</Caption>
              <Text variant="tiny" className="text-system-gray-500 mb-2">
                <strong>Reanalyze all files</strong> re-runs AI analysis on every file inside your
                smart folders and refreshes the search index for everything else you have analyzed.
                Nothing is deleted first. Use this only if you changed the{' '}
                <em>Text/Vision model</em> (not just the embedding model).
              </Text>
              <div className="mb-3">
                <div className="flex items-center gap-cozy">
                  <Switch
                    id="apply-naming-on-reanalyze"
                    checked={applyNamingOnReanalyze}
                    onChange={setApplyNamingOnReanalyze}
                    disabled={isReanalyzingAll || analysisIsActive || isFullRebuilding}
                    aria-label="Toggle apply naming conventions during reanalysis"
                  />
                  <Text
                    as="label"
                    htmlFor="apply-naming-on-reanalyze"
                    variant="small"
                    className="font-medium text-system-gray-700"
                  >
                    Apply naming conventions to files during reanalysis
                  </Text>
                </div>
                <Text variant="tiny" className="text-system-gray-400 mt-1 ml-14">
                  When enabled, files will be renamed according to your naming convention settings.
                  When disabled, original file names will be preserved.
                </Text>
              </div>
              <Button
                onClick={() => setShowReanalyzeConfirm(true)}
                variant="danger"
                disabled={isReanalyzingAll || analysisIsActive || isFullRebuilding}
                isLoading={isReanalyzingAll || analysisIsActive}
                type="button"
                title="Reanalyze every file with the current AI models; each result replaces the old one as it completes"
                size="sm"
                className="w-full sm:w-auto"
              >
                {isReanalyzingAll
                  ? 'Starting reanalysis\u2026'
                  : analysisIsActive
                    ? `Reanalyzing\u2026 ${analysisCurrent}/${analysisTotal}`
                    : 'Reanalyze all files (slow)'}
              </Button>
            </div>

            <div className="pt-4 border-t border-border-soft">
              <Caption className="block text-system-gray-700 mb-2">Duplicate finder</Caption>
              <Text variant="tiny" className="text-system-gray-500 mb-2">
                <strong>Reindex file hashes</strong> computes SHA-256 for every indexed file missing
                a content hash. The Duplicate finder&apos;s &ldquo;Exact&rdquo; tier and the
                Downloads triage hash-collision check rely on these hashes. Safe to run &mdash; no
                files are moved or modified.
              </Text>
              <Button
                onClick={async () => {
                  if (!window?.electronAPI?.embeddings?.reindexFileHashes) {
                    addNotification('Embedding API not available', 'error');
                    return;
                  }
                  if (isMountedRef.current) setIsReindexingHashes(true);
                  addNotification('Reindexing file hashes…', 'info');
                  try {
                    const res = await window.electronAPI.embeddings.reindexFileHashes({
                      force: false,
                      maxFiles: 10000
                    });
                    if (res?.success) {
                      addNotification(
                        `Hash reindex complete: ${res.hashed} hashed, ${res.skipped} skipped, ${res.failed} failed.`,
                        'success'
                      );
                    } else {
                      addNotification(toErrorMessage(res?.error, 'Hash reindex failed.'), 'error');
                    }
                  } catch (err) {
                    addNotification(err?.message || 'Hash reindex failed.', 'error');
                  } finally {
                    if (isMountedRef.current) setIsReindexingHashes(false);
                  }
                }}
                variant="secondary"
                disabled={isReindexingHashes || analysisIsActive || isFullRebuilding}
                isLoading={isReindexingHashes}
                type="button"
                size="sm"
                className="w-full sm:w-auto"
              >
                {isReindexingHashes ? 'Reindexing…' : 'Reindex file hashes'}
              </Button>
            </div>
          </SettingsGroup>
        )}
      </div>

      <ConfirmModal
        isOpen={showRebuildConfirm}
        onClose={() => setShowRebuildConfirm(false)}
        onConfirm={() => {
          // Deliberately NOT awaited: ConfirmModal stays open (with the whole
          // panel locked behind it) until onConfirm resolves, but a full
          // rebuild runs for many minutes — and the copy promises "leaving
          // this panel is safe". The section's isFullRebuilding state and
          // elapsed counter report progress; outcomes surface as toasts.
          void handleFullRebuild();
        }}
        title="Rebuild all embeddings?"
        message={
          stats?.files
            ? `This drops ${stats.files} file embeddings and ${stats.folders ?? 0} folder embeddings, then re-indexes everything with the current embedding model. Cannot be cancelled once started; expect several minutes.`
            : 'This drops every file and folder embedding, then re-indexes everything with the current embedding model. Cannot be cancelled once started; expect several minutes.'
        }
        confirmText="Rebuild"
        cancelText="Cancel"
        variant="warning"
        requireConfirmText="REBUILD"
      />

      <ConfirmModal
        isOpen={showReanalyzeConfirm}
        onClose={() => setShowReanalyzeConfirm(false)}
        onConfirm={async () => {
          await handleReanalyzeAll();
        }}
        title="Reanalyze every file?"
        message="This re-runs the LLM on every file in your smart folders. Existing results stay searchable until each file's new result replaces them. It can rename files (if naming conventions are enabled) and may take a long time. Use this when you've changed the Text or Vision model or your organization instructions."
        confirmText="Reanalyze all"
        cancelText="Cancel"
        variant="danger"
        requireConfirmText="REANALYZE"
      />
    </SettingsCard>
  );
}

EmbeddingRebuildSection.propTypes = {
  addNotification: PropTypes.func.isRequired
};

export default EmbeddingRebuildSection;
