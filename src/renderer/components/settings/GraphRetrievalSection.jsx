import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import Switch from '../ui/Switch';
import Button from '../ui/Button';
import NumericSettingInput from './NumericSettingInput';
import SettingRow from './SettingRow';
import SettingsCard from './SettingsCard';
import SettingsGroup from './SettingsGroup';
import { Text } from '../ui/Typography';
import { logger } from '../../../shared/logger';
import { embeddingsIpc } from '../../services/ipc';
import { formatDateTime } from '../../utils/format';

const DEFAULT_WEIGHT = 0.2;
const WEIGHT_MIN = 0;
const WEIGHT_MAX = 1;

const DEFAULT_NEIGHBORS = 120;
const NEIGHBORS_MIN = 10;
const NEIGHBORS_MAX = 500;

const DEFAULT_CONTEXT_NEIGHBORS = 1;
const CONTEXT_NEIGHBORS_MIN = 0;
const CONTEXT_NEIGHBORS_MAX = 3;

function clampNumber(value, min, max, fallback) {
  const safe = Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, safe));
}

function GraphRetrievalSection({ settings, setSettings, lockedBySimpleMode = false }) {
  const [stats, setStats] = useState(null);
  const [historyStats, setHistoryStats] = useState(null);
  const [embeddingStats, setEmbeddingStats] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const updateSetting = useCallback(
    (key, value) => {
      setSettings((prev) => ({
        ...prev,
        [key]: value
      }));
    },
    [setSettings]
  );

  const weight = clampNumber(settings.graphExpansionWeight, WEIGHT_MIN, WEIGHT_MAX, DEFAULT_WEIGHT);
  const weightPercent = Math.round(weight * 100);

  const neighbors = clampNumber(
    settings.graphExpansionMaxNeighbors,
    NEIGHBORS_MIN,
    NEIGHBORS_MAX,
    DEFAULT_NEIGHBORS
  );

  const contextNeighbors = clampNumber(
    settings.chunkContextMaxNeighbors,
    CONTEXT_NEIGHBORS_MIN,
    CONTEXT_NEIGHBORS_MAX,
    DEFAULT_CONTEXT_NEIGHBORS
  );

  // `formatDateTime` uses a shared, cached Intl.DateTimeFormat so locale is
  // explicit and overridable in tests (see utils/format.setDateLocale). The
  // fallback strings preserve the previous UX for missing/invalid inputs.
  const formattedUpdatedAt = useMemo(
    () => formatDateTime(stats?.updatedAt, 'datetime-long', 'Not built yet'),
    [stats?.updatedAt]
  );

  const formattedSourceUpdatedAt = useMemo(
    () => formatDateTime(stats?.sourceUpdatedAt, 'datetime-long', 'Unknown'),
    [stats?.sourceUpdatedAt]
  );

  const formattedHistoryUpdatedAt = useMemo(
    () => formatDateTime(historyStats?.lastUpdated, 'datetime-long', 'Unknown'),
    [historyStats?.lastUpdated]
  );

  const searchableFilesLabel = useMemo(() => {
    const indexedFiles = typeof embeddingStats?.files === 'number' ? embeddingStats.files : null;
    const analyzedFiles =
      typeof embeddingStats?.analysisHistory?.embedding?.eligibleFiles === 'number'
        ? embeddingStats.analysisHistory.embedding.eligibleFiles
        : typeof historyStats?.totalFiles === 'number'
          ? historyStats.totalFiles
          : null;
    if (indexedFiles == null) return '—';
    if (analyzedFiles != null && analyzedFiles > 0) {
      return `${indexedFiles} / ${analyzedFiles}`;
    }
    return String(indexedFiles);
  }, [
    embeddingStats?.analysisHistory?.embedding?.eligibleFiles,
    embeddingStats?.files,
    historyStats?.totalFiles
  ]);

  const refreshStats = useCallback(async (options = {}) => {
    const forceRefresh = options === true || options?.force === true;
    const getRelationshipStats = window?.electronAPI?.knowledge?.getRelationshipStats;
    const getHistoryStats = window?.electronAPI?.analysisHistory?.getStatistics;
    const getEmbeddingStats = () => embeddingsIpc.getStatsCached({ forceRefresh });
    if (typeof getRelationshipStats !== 'function') return;
    if (isMountedRef.current) setIsLoading(true);
    try {
      const [response, historyResponse, embeddingResponse] = await Promise.all([
        getRelationshipStats(),
        typeof getHistoryStats === 'function' ? getHistoryStats() : Promise.resolve(null),
        typeof getEmbeddingStats === 'function' ? getEmbeddingStats() : Promise.resolve(null)
      ]);
      if (isMountedRef.current) {
        if (response?.success) {
          setStats(response);
        } else {
          setStats(null);
        }
        // Check for explicit failure (success: false), not absence of success flag.
        // Statistics may arrive without a success wrapper from older IPC paths.
        if (historyResponse && historyResponse.success !== false) {
          setHistoryStats(historyResponse);
        } else {
          setHistoryStats(null);
        }
        if (embeddingResponse?.success) {
          setEmbeddingStats(embeddingResponse);
        } else {
          setEmbeddingStats(null);
        }
      }
    } catch (error) {
      logger.debug('[GraphRetrievalSection] Failed to fetch graph stats', {
        error: error?.message
      });
      if (isMountedRef.current) {
        setStats(null);
        setHistoryStats(null);
        setEmbeddingStats(null);
      }
    } finally {
      if (isMountedRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    // Load stats on mount so UI is always up to date.
    refreshStats();
  }, [refreshStats]);

  useEffect(() => {
    let inFlight = false;
    const refreshIfIdle = (force = false) => {
      if (inFlight) return;
      inFlight = true;
      // refreshStats handles its own errors internally, so we only need the
      // .finally() to release the in-flight gate. The trailing .catch() is
      // defensive: if a future change makes refreshStats reject, the gate
      // still gets released and we don't leak an unhandledRejection.
      Promise.resolve(refreshStats({ force }))
        .finally(() => {
          inFlight = false;
        })
        .catch(() => {});
    };

    const intervalId = setInterval(() => {
      if (document.hidden) return;
      refreshIfIdle(false);
    }, 8000);

    const handleOperationProgress = (event) => {
      const payload = event?.detail;
      if (!payload || payload.type !== 'batch_analyze') return;
      refreshIfIdle(false);

      const completed = Number(payload.completed);
      const total = Number(payload.total);
      if (Number.isFinite(completed) && Number.isFinite(total) && total > 0 && completed >= total) {
        embeddingsIpc.invalidateStatsCache();
        refreshIfIdle(true);
      }
    };

    window.addEventListener('operation-progress', handleOperationProgress);
    return () => {
      clearInterval(intervalId);
      window.removeEventListener('operation-progress', handleOperationProgress);
    };
  }, [refreshStats]);

  return (
    <SettingsCard
      title="Search enrichment"
      description="Configure relationship-aware retrieval and contextual chunk expansion for search and chat."
    >
      {lockedBySimpleMode && (
        <Text variant="tiny" className="text-system-gray-500">
          Relationship expansion and contextual chunk expansion are managed automatically in Simple
          mode. Switch to Advanced under Experience level to change them.
        </Text>
      )}

      <SettingRow
        label="Enable relationship expansion"
        description="Use document relationships to pull related files into search results."
      >
        <Switch
          checked={settings.graphExpansionEnabled !== false}
          onChange={(checked) => updateSetting('graphExpansionEnabled', checked)}
          disabled={lockedBySimpleMode}
          aria-label="Toggle relationship expansion"
        />
      </SettingRow>

      <SettingRow
        label="Relationship expansion weight"
        description="How much related documents can influence ranking."
      >
        <div className="w-full space-y-2">
          <div className="flex items-center justify-between">
            <Text variant="tiny" className="text-system-gray-500">
              Weight
            </Text>
            <Text variant="tiny" className="font-medium text-stratosort-blue">
              {weightPercent}%
            </Text>
          </div>
          <input
            type="range"
            min={Math.round(WEIGHT_MIN * 100)}
            max={Math.round(WEIGHT_MAX * 100)}
            step="1"
            value={weightPercent}
            onChange={(e) => {
              const next = clampNumber(
                Number(e.target.value) / 100,
                WEIGHT_MIN,
                WEIGHT_MAX,
                weight
              );
              updateSetting('graphExpansionWeight', next);
            }}
            aria-label="Graph expansion weight"
            className="w-full accent-stratosort-blue"
          />
        </div>
      </SettingRow>

      <SettingRow
        label="Related files limit"
        description="Maximum number of related files added per query."
        layout="col"
      >
        <NumericSettingInput
          value={neighbors}
          onCommit={(next) => updateSetting('graphExpansionMaxNeighbors', Math.round(next))}
          min={NEIGHBORS_MIN}
          max={NEIGHBORS_MAX}
          fallback={DEFAULT_NEIGHBORS}
          className="w-full"
          ariaLabel="Related files limit"
        />
      </SettingRow>

      <SettingRow
        label="Contextual chunk expansion"
        description="Include adjacent chunks around the best chunk match."
      >
        <Switch
          checked={settings.chunkContextEnabled !== false}
          onChange={(checked) => updateSetting('chunkContextEnabled', checked)}
          disabled={lockedBySimpleMode}
          aria-label="Toggle contextual chunk expansion"
        />
      </SettingRow>

      <SettingRow
        label="Adjacent chunks"
        description="How many neighboring chunks to include on each side."
        layout="col"
      >
        <NumericSettingInput
          value={contextNeighbors}
          onCommit={(next) => updateSetting('chunkContextMaxNeighbors', Math.round(next))}
          min={CONTEXT_NEIGHBORS_MIN}
          max={CONTEXT_NEIGHBORS_MAX}
          fallback={DEFAULT_CONTEXT_NEIGHBORS}
          className="w-full"
          ariaLabel="Adjacent chunks"
        />
      </SettingRow>

      <SettingRow
        label="Relationship index status"
        description="Shows the local relationship index used to improve search and chat."
        layout="col"
      >
        <SettingsGroup gap="compact">
          <div className="flex items-center justify-between">
            <Text
              variant="small"
              className={
                stats?.edgeCount != null && stats.edgeCount >= 2000
                  ? 'text-stratosort-warning'
                  : 'text-system-gray-700'
              }
            >
              {stats?.edgeCount != null
                ? stats.edgeCount >= 2000
                  ? `${stats.edgeCount} edges (at capacity)`
                  : `${stats.edgeCount} edges (max 2000)`
                : 'No index yet'}
            </Text>
            <div className="flex items-center gap-compact">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => refreshStats(true)}
                disabled={isLoading || !window?.electronAPI?.knowledge?.getRelationshipStats}
              >
                {isLoading ? 'Refreshing…' : 'Refresh'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => {
                  if (!window?.electronAPI?.knowledge?.rebuildRelationships) return;
                  if (isMountedRef.current) setIsRebuilding(true);
                  try {
                    const res = await window.electronAPI.knowledge.rebuildRelationships();
                    if (!res?.success) {
                      logger.warn('[GraphRetrievalSection] rebuild failed', {
                        error: res?.error
                      });
                    }
                  } catch (err) {
                    logger.warn('[GraphRetrievalSection] rebuild threw', {
                      error: err?.message
                    });
                  } finally {
                    if (isMountedRef.current) setIsRebuilding(false);
                    refreshStats({ force: true });
                  }
                }}
                disabled={
                  isRebuilding || isLoading || !window?.electronAPI?.knowledge?.rebuildRelationships
                }
                title="Rebuild the relationship index now, bypassing the 10-minute throttle."
              >
                {isRebuilding ? 'Rebuilding…' : 'Rebuild'}
              </Button>
            </div>
          </div>
          <Text variant="tiny" className="text-system-gray-500">
            Concepts: {stats?.conceptCount ?? '—'} • Concept-linked docs: {stats?.docCount ?? '—'}
          </Text>
          <Text variant="tiny" className="text-system-gray-500">
            Vector-indexed files: {searchableFilesLabel} • Analysis history:{' '}
            {historyStats?.totalFiles ?? '—'} • Updated: {formattedHistoryUpdatedAt}
          </Text>
          <Text variant="tiny" className="text-system-gray-500">
            Related documents only include files with extracted concepts (tags, keywords, entities).
            Searchable files are stored in the vector database for semantic retrieval.
          </Text>
          <Text variant="tiny" className="text-system-gray-500">
            Last built: {formattedUpdatedAt}
          </Text>
          <Text variant="tiny" className="text-system-gray-500">
            Source data: Analysis history updated {formattedSourceUpdatedAt}
          </Text>
        </SettingsGroup>
      </SettingRow>
    </SettingsCard>
  );
}

GraphRetrievalSection.propTypes = {
  settings: PropTypes.object.isRequired,
  setSettings: PropTypes.func.isRequired,
  // True when the panel is in Simple mode but this Advanced-only section was
  // revealed by settings search. graphExpansionEnabled / chunkContextEnabled
  // are Simple-mode enforced keys re-applied on every save, so editing them
  // would silently revert — lock the controls and say why instead.
  lockedBySimpleMode: PropTypes.bool
};

export default GraphRetrievalSection;
