// @ts-check
/**
 * Shared stats + rebuild state for the Unified Search modal (§I Phase 2).
 *
 * Owns embedding index stats (files/folders/health flags), the embedding
 * config snapshot shown as indexing hints, and the folder/file rebuild
 * flows. Consumed by all three tabs: search gates on a non-empty index,
 * chat shows index health, and graph load gating depends on `stats`.
 *
 * Extracted verbatim from UnifiedSearchModal — behavior parity is pinned
 * by the existing modal suites; renderHook smokes live in
 * test/renderer/components/search/useSearchModalStats.test.js.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createLogger } from '../../../../shared/logger';
import { embeddingsIpc } from '../../../services/ipc';
import { getErrorMessage } from '../utils';

const logger = createLogger('useSearchModalStats');

/**
 * @param {{
 *   isOpen: boolean,
 *   setError: (v: string) => void,
 *   showSuccess: (v: string) => void,
 *   showError: (v: string) => void,
 *   onFileOperation?: ((data: any) => void) | null
 * }} props
 */
export function useSearchModalStats({
  isOpen,
  setError,
  showSuccess,
  showError,
  onFileOperation = null
}) {
  const [stats, setStats] = useState(null);
  const [statsUnavailable, setStatsUnavailable] = useState(false);
  const [isLoadingStats, setIsLoadingStats] = useState(false);
  const [hasLoadedStats, setHasLoadedStats] = useState(false);
  const [embeddingConfig, setEmbeddingConfig] = useState(null);
  const [isRebuildingFolders, setIsRebuildingFolders] = useState(false);
  const [isRebuildingFiles, setIsRebuildingFiles] = useState(false);

  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Monotonic request id: a stale in-flight refresh must never clobber the
  // state written by a newer one (rapid open/close + rebuild races).
  const statsRequestCounterRef = useRef(0);

  const refreshStats = useCallback(async (/** @type {any} */ options = {}) => {
    const forceRefresh = options === true || options?.force === true;
    const requestId = (statsRequestCounterRef.current += 1);
    if (isMountedRef.current) setIsLoadingStats(true);
    try {
      const [statsResult, settingsResult] = await Promise.allSettled([
        embeddingsIpc.getStatsCached({ forceRefresh }),
        window.electronAPI?.settings?.get?.()
      ]);
      const res = statsResult.status === 'fulfilled' ? statsResult.value : null;
      const settings = settingsResult.status === 'fulfilled' ? settingsResult.value : null;

      if (
        isMountedRef.current &&
        statsRequestCounterRef.current === requestId &&
        settings &&
        typeof settings === 'object'
      ) {
        setEmbeddingConfig({
          timing:
            settings.embeddingTiming === 'during_analysis' ||
            settings.embeddingTiming === 'after_organize' ||
            settings.embeddingTiming === 'manual'
              ? settings.embeddingTiming
              : null,
          policy:
            settings.defaultEmbeddingPolicy === 'embed' ||
            settings.defaultEmbeddingPolicy === 'skip' ||
            settings.defaultEmbeddingPolicy === 'web_only'
              ? settings.defaultEmbeddingPolicy
              : null
        });
      } else if (isMountedRef.current && statsRequestCounterRef.current === requestId) {
        setEmbeddingConfig(null);
      }

      if (isMountedRef.current && statsRequestCounterRef.current === requestId && res?.success) {
        setStats({
          files: typeof res.files === 'number' ? res.files : 0,
          folders: typeof res.folders === 'number' ? res.folders : 0,
          smartFolderCount: typeof res.smartFolderCount === 'number' ? res.smartFolderCount : null,
          initialized: Boolean(res.initialized),
          needsFileEmbeddingRebuild: Boolean(res.needsFileEmbeddingRebuild),
          uncoveredFiles: typeof res.uncoveredFiles === 'number' ? res.uncoveredFiles : 0,
          embeddingCoverageLow: Boolean(res.embeddingCoverageLow),
          embeddingCoverage:
            typeof res.embeddingCoverage === 'number' ? res.embeddingCoverage : null,
          embeddingBuildInProgress: Boolean(res.embeddingBuildInProgress),
          embeddingModelMismatch: Boolean(res.embeddingModelMismatch),
          activeEmbeddingModel:
            typeof res.activeEmbeddingModel === 'string' ? res.activeEmbeddingModel : '',
          indexedEmbeddingModel:
            typeof res.embeddingIndex?.model === 'string' ? res.embeddingIndex.model : '',
          analysisHistoryTotal:
            typeof res.analysisHistory?.embedding?.eligibleFiles === 'number'
              ? res.analysisHistory.embedding.eligibleFiles
              : typeof res.analysisHistory?.totalFiles === 'number'
                ? res.analysisHistory.totalFiles
                : 0
        });
        setStatsUnavailable(false);
      } else if (isMountedRef.current && statsRequestCounterRef.current === requestId) {
        setStats(null);
        setStatsUnavailable(
          Boolean(
            res?.unavailable ||
            res?.code === 'VECTOR_DB_UNAVAILABLE' ||
            res?.code === 'VECTOR_DB_PENDING'
          )
        );
      }
    } catch (e) {
      logger.warn('Failed to load embedding stats', { error: e?.message });
      if (isMountedRef.current && statsRequestCounterRef.current === requestId) {
        setStats(null);
        setStatsUnavailable(false);
        setEmbeddingConfig(null);
      }
    } finally {
      if (isMountedRef.current && statsRequestCounterRef.current === requestId) {
        setIsLoadingStats(false);
        setHasLoadedStats(true);
      }
    }
  }, []);

  // On open: reset to a clean slate, then load. (Replaces the modal's
  // open-reset setter block + its separate refresh-on-open effect; both ran
  // in the same commit pre-extraction, so the net behavior is identical.)
  useEffect(() => {
    if (!isOpen) return;
    setStats(null);
    setStatsUnavailable(false);
    setHasLoadedStats(false);
    setIsLoadingStats(false);
    setEmbeddingConfig(null);
    refreshStats();
  }, [isOpen, refreshStats]);

  // Listen for file operation events (move/delete): refresh stats and let
  // the caller react too (the search tab bumps its refresh trigger).
  useEffect(() => {
    if (!isOpen) return undefined;
    const handleFileOperation = (/** @type {any} */ event) => {
      const data = event?.detail;
      if (data?.operation === 'move' || data?.operation === 'delete') {
        logger.debug('[Search] File operation detected, refreshing search', {
          operation: data.operation,
          oldPath: data.oldPath
        });
        onFileOperation?.(data);
        embeddingsIpc.invalidateStatsCache();
        refreshStats(true);
      }
    };

    window.addEventListener('file-operation-complete', handleFileOperation);
    return () => {
      window.removeEventListener('file-operation-complete', handleFileOperation);
    };
  }, [isOpen, refreshStats, onFileOperation]);

  // Throttled refresh while batch analysis streams progress events; force a
  // final refresh when the batch completes.
  useEffect(() => {
    if (!isOpen) return undefined;

    /** @type {ReturnType<typeof setTimeout> | null} */
    let timerId = null;
    let lastRefreshAt = 0;
    const MIN_REFRESH_INTERVAL_MS = 1500;

    const scheduleRefresh = (force = false) => {
      const now = Date.now();
      const elapsed = now - lastRefreshAt;
      const invoke = () => {
        lastRefreshAt = Date.now();
        refreshStats({ force });
      };

      if (force || elapsed >= MIN_REFRESH_INTERVAL_MS) {
        invoke();
        return;
      }

      if (timerId) return;
      timerId = setTimeout(() => {
        timerId = null;
        invoke();
      }, MIN_REFRESH_INTERVAL_MS - elapsed);
    };

    const handleOperationProgress = (/** @type {any} */ event) => {
      const payload = event?.detail;
      if (!payload || payload.type !== 'batch_analyze') return;

      scheduleRefresh(false);

      const completed = Number(payload.completed);
      const total = Number(payload.total);
      if (Number.isFinite(completed) && Number.isFinite(total) && total > 0 && completed >= total) {
        embeddingsIpc.invalidateStatsCache();
        scheduleRefresh(true);
      }
    };

    window.addEventListener('operation-progress', handleOperationProgress);
    return () => {
      if (timerId) clearTimeout(timerId);
      window.removeEventListener('operation-progress', handleOperationProgress);
    };
  }, [isOpen, refreshStats]);

  const rebuildFolders = useCallback(async () => {
    const rebuild = window?.electronAPI?.embeddings?.rebuildFolders;
    if (typeof rebuild !== 'function') return;
    if (isMountedRef.current) {
      setIsRebuildingFolders(true);
      setError('');
    }
    try {
      const res = await rebuild();
      if (!res?.success) throw new Error(getErrorMessage(res?.error, 'Folder rebuild'));
      await refreshStats(true);
      if (isMountedRef.current) showSuccess('Folder embeddings rebuilt successfully');
    } catch (e) {
      if (isMountedRef.current) {
        const msg = getErrorMessage(e, 'Folder rebuild');
        setError(msg);
        showError(msg);
      }
    } finally {
      if (isMountedRef.current) setIsRebuildingFolders(false);
    }
  }, [refreshStats, setError, showSuccess, showError]);

  const rebuildFiles = useCallback(async () => {
    const rebuild = window?.electronAPI?.embeddings?.rebuildFiles;
    if (typeof rebuild !== 'function') return;
    if (isMountedRef.current) {
      setIsRebuildingFiles(true);
      setError('');
    }
    try {
      const res = await rebuild();
      if (!res?.success) throw new Error(getErrorMessage(res?.error, 'File rebuild'));
      await refreshStats(true);
      if (isMountedRef.current) showSuccess('File embeddings rebuilt successfully');
    } catch (e) {
      if (isMountedRef.current) {
        const msg = getErrorMessage(e, 'File rebuild');
        setError(msg);
        showError(msg);
      }
    } finally {
      if (isMountedRef.current) setIsRebuildingFiles(false);
    }
  }, [refreshStats, setError, showSuccess, showError]);

  return {
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
  };
}
