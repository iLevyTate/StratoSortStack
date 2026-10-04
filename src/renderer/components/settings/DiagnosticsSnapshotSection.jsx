import React from 'react';
import PropTypes from 'prop-types';
import { ClipboardCopy, RefreshCw } from 'lucide-react';
import Button from '../ui/Button';
import SettingsCard from './SettingsCard';
import { Heading, Text } from '../ui/Typography';
import { formatBytes, formatDuration, formatMillisHuman } from '../../utils/format';
import { createLogger } from '../../../shared/logger';
import { embeddingsIpc, getElectronAPI, llamaIpc, systemIpc } from '../../services/ipc';

const logger = createLogger('DiagnosticsSnapshot');

const UNAVAILABLE_MARKER = '__diagnostics_unavailable__';
// The preload serializes llama:test-connection; a probe already in flight
// (NavigationBar's boot probe, StrictMode's dev double-effect) is benign —
// keep the previous value instead of warning + rendering an error alert.
const IN_FLIGHT_MARKER = '__diagnostics_in_flight__';

function isTestConnectionInFlight(error) {
  const message = error?.message || String(error);
  return (
    message.includes('Operation already in progress') && message.includes('llama:test-connection')
  );
}

/**
 * Safely run a diagnostics fetcher. Returns the resolved value, or an object
 * with an `error` string when the fetch throws. We deliberately keep failures
 * per-source isolated so one failing service doesn't blank the whole panel.
 */
async function safeFetch(label, fetcher) {
  try {
    const value = await fetcher();
    return { ok: true, value };
  } catch (error) {
    logger.warn(`[DiagnosticsSnapshot] ${label} fetch failed`, {
      error: error?.message || String(error)
    });
    return { ok: false, error: error?.message || 'Failed to load' };
  }
}

function formatPercent(value, { decimals = 1 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(decimals)}%`;
}

function formatCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString();
}

function getVectorDbApi() {
  const api = getElectronAPI();
  if (api?.vectorDb && typeof api.vectorDb.getStats === 'function') return api.vectorDb;
  return null;
}

function getLlamaApi() {
  const api = getElectronAPI();
  if (api?.llama) return api.llama;
  return null;
}

function StatGrid({ children, className = '' }) {
  return (
    <dl className={`grid grid-cols-1 gap-cozy sm:grid-cols-2 md:grid-cols-3 ${className}`.trim()}>
      {children}
    </dl>
  );
}

StatGrid.propTypes = {
  children: PropTypes.node.isRequired,
  className: PropTypes.string
};

function StatItem({ label, value, hint }) {
  return (
    <div className="rounded-lg border border-border-soft bg-surface-primary px-3 py-2 shadow-sm">
      <dt className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
        {label}
      </dt>
      <dd className="mt-1 text-sm font-semibold text-[var(--text-emphasis)] break-words">
        {value ?? '—'}
      </dd>
      {hint && <dd className="mt-0.5 text-xs text-[var(--text-secondary)] leading-snug">{hint}</dd>}
    </div>
  );
}

StatItem.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.node,
  hint: PropTypes.node
};

function SubSection({ title, description, error, children }) {
  return (
    <section className="space-y-2">
      <div>
        <Heading as="h4" variant="h6" className="text-[var(--text-emphasis)]">
          {title}
        </Heading>
        {description && (
          <Text variant="tiny" className="text-[var(--text-secondary)] leading-relaxed">
            {description}
          </Text>
        )}
      </div>
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-system-red-200 bg-system-red-50 px-3 py-2 text-sm text-system-red-700"
        >
          Unable to load: {error}
        </div>
      ) : (
        children
      )}
    </section>
  );
}

SubSection.propTypes = {
  title: PropTypes.string.isRequired,
  description: PropTypes.node,
  error: PropTypes.string,
  children: PropTypes.node
};

/**
 * Read-only diagnostics snapshot for support triage.
 *
 * Aggregates `systemAnalytics.collectMetrics()`, degraded-state flags,
 * Llama config/health, Orama stats, and the effective `STRATOSORT_*` env
 * into a single panel. All fetches are isolated so a single failing source
 * does not blank the whole view.
 */
function DiagnosticsSnapshotSection({ addNotification }) {
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = React.useState(null);
  const [snapshot, setSnapshot] = React.useState({
    metrics: { ok: false, value: null, error: null },
    degraded: { ok: false, value: null, error: null },
    llamaConfig: { ok: false, value: null, error: null },
    llamaHealth: { ok: false, value: null, error: null },
    vectorStats: { ok: false, value: null, error: null }
  });

  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    // StrictMode mounts effects twice in development (mount → cleanup →
    // remount). Re-arm the flag on every mount so the post-fetch state
    // updates (and the `finally` that clears `loading`) still run after a
    // remount; otherwise the panel stays stuck on "Collecting diagnostics…".
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchAll = React.useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setRefreshing(true);
    try {
      const [metrics, degraded, llamaConfig, llamaHealth, vectorStats] = await Promise.all([
        safeFetch('system metrics', () => systemIpc.getMetrics()),
        safeFetch('degraded state', () => systemIpc.getDegradedState()),
        safeFetch('llama config', async () => {
          if (!getLlamaApi()) return UNAVAILABLE_MARKER;
          return llamaIpc.getConfig();
        }),
        safeFetch('llama health', async () => {
          if (!getLlamaApi()) return UNAVAILABLE_MARKER;
          try {
            return await llamaIpc.testConnection();
          } catch (error) {
            if (isTestConnectionInFlight(error)) return IN_FLIGHT_MARKER;
            throw error;
          }
        }),
        safeFetch('vector db stats', async () => {
          const api = getVectorDbApi();
          if (api) return api.getStats();
          // Fallback: embedding stats (richer shape) when vectorDb not exposed.
          return embeddingsIpc.getStatsCached({ forceRefresh: true });
        })
      ]);
      if (!mountedRef.current) return;
      setSnapshot((prev) => ({
        metrics: { ok: metrics.ok, value: metrics.ok ? metrics.value : null, error: metrics.error },
        degraded: {
          ok: degraded.ok,
          value: degraded.ok ? degraded.value : null,
          error: degraded.error
        },
        llamaConfig: {
          ok: llamaConfig.ok,
          value:
            llamaConfig.ok && llamaConfig.value !== UNAVAILABLE_MARKER ? llamaConfig.value : null,
          error:
            llamaConfig.ok && llamaConfig.value === UNAVAILABLE_MARKER
              ? 'Llama IPC unavailable in this build'
              : llamaConfig.error
        },
        llamaHealth:
          llamaHealth.ok && llamaHealth.value === IN_FLIGHT_MARKER
            ? prev.llamaHealth
            : {
                ok: llamaHealth.ok,
                value:
                  llamaHealth.ok && llamaHealth.value !== UNAVAILABLE_MARKER
                    ? llamaHealth.value
                    : null,
                error:
                  llamaHealth.ok && llamaHealth.value === UNAVAILABLE_MARKER
                    ? 'Llama IPC unavailable in this build'
                    : llamaHealth.error
              },
        vectorStats: {
          ok: vectorStats.ok,
          value: vectorStats.ok ? vectorStats.value : null,
          error: vectorStats.error
        }
      }));
      setLastRefreshedAt(new Date());
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  React.useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const handleRefresh = React.useCallback(() => {
    fetchAll({ silent: true });
  }, [fetchAll]);

  const handleCopy = React.useCallback(async () => {
    const payload = {
      capturedAt: new Date().toISOString(),
      metrics: snapshot.metrics.value,
      metricsError: snapshot.metrics.error,
      degraded: snapshot.degraded.value,
      degradedError: snapshot.degraded.error,
      llamaConfig: snapshot.llamaConfig.value,
      llamaConfigError: snapshot.llamaConfig.error,
      llamaHealth: snapshot.llamaHealth.value,
      llamaHealthError: snapshot.llamaHealth.error,
      vectorStats: snapshot.vectorStats.value,
      vectorStatsError: snapshot.vectorStats.error
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      addNotification?.('Diagnostics snapshot copied to clipboard', 'success');
    } catch (error) {
      logger.error('[DiagnosticsSnapshot] clipboard write failed', { error });
      addNotification?.(
        'Failed to copy diagnostics snapshot. Check clipboard permissions.',
        'error'
      );
    }
  }, [addNotification, snapshot]);

  const { metrics, degraded, llamaConfig, llamaHealth, vectorStats } = snapshot;
  const metricsValue = metrics.value;
  const memory = metricsValue?.memory;
  const pipeline = metricsValue?.pipeline;
  const envSnapshot = metricsValue?.env || {};
  const envKeys = Object.keys(envSnapshot).sort();
  const llamaHealthValue = llamaHealth.value;
  const llamaConfigValue = llamaConfig.value;
  const degradedFlags = Array.isArray(degraded.value?.flags) ? degraded.value.flags : [];

  const headerAction = (
    <div className="flex items-center gap-compact">
      <Button
        variant="subtle"
        size="sm"
        onClick={handleCopy}
        disabled={loading || refreshing}
        leftIcon={<ClipboardCopy className="h-3.5 w-3.5" aria-hidden="true" />}
      >
        Copy
      </Button>
      <Button
        variant="subtle"
        size="sm"
        onClick={handleRefresh}
        isLoading={refreshing}
        disabled={loading}
        leftIcon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
      >
        Refresh
      </Button>
    </div>
  );

  return (
    <SettingsCard
      title="System diagnostics snapshot"
      description="Read-only snapshot of app metrics, AI health, vector store, and effective feature flags. Use Copy to paste into a support ticket."
      headerAction={headerAction}
    >
      {loading ? (
        <Text variant="small" className="text-system-gray-500">
          Collecting diagnostics…
        </Text>
      ) : (
        <div className="space-y-5">
          {lastRefreshedAt && (
            <Text variant="tiny" className="text-system-gray-500">
              Last refreshed {lastRefreshedAt.toLocaleTimeString()}
            </Text>
          )}

          <SubSection
            title="App runtime"
            description="Uptime, processing throughput, and memory for the main process."
            error={metrics.error}
          >
            {metricsValue && (
              <StatGrid>
                <StatItem
                  label="Uptime"
                  value={formatDuration(metricsValue.uptime)}
                  hint={`Started ${new Date(Date.now() - (metricsValue.uptime || 0)).toLocaleString()}`}
                />
                <StatItem
                  label="Processed files"
                  value={formatCount(metricsValue.processedFiles)}
                />
                <StatItem
                  label="Successful / failed ops"
                  value={`${formatCount(metricsValue.successfulOperations)} / ${formatCount(
                    metricsValue.failedOperations
                  )}`}
                />
                <StatItem
                  label="Avg processing"
                  value={formatMillisHuman(metricsValue.avgProcessingTime)}
                />
                <StatItem label="Error rate" value={formatPercent(metricsValue.errorRate)} />
                {memory && (
                  <StatItem
                    label="Heap used"
                    value={`${formatBytes((memory.used || 0) * 1024 * 1024)} / ${formatBytes(
                      (memory.total || 0) * 1024 * 1024
                    )}`}
                    hint={`${memory.percentage ?? 0}% of JS heap`}
                  />
                )}
              </StatGrid>
            )}
          </SubSection>

          {pipeline && (
            <SubSection
              title="Processing pipeline"
              description="Recent window (last 200 jobs per pipeline) for fallback/error health."
            >
              <StatGrid>
                {['document', 'image', 'embedding'].map((key) => {
                  const stats = pipeline[key];
                  if (!stats) return null;
                  const fallbackRate = formatPercent((stats.recent?.fallbackRate || 0) * 100);
                  const errorRate = formatPercent((stats.recent?.errorRate || 0) * 100);
                  const topReasons = Object.entries(stats.fallbackReasons || {})
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 2)
                    .map(([reason, count]) => `${reason} (${count})`)
                    .join(', ');
                  const healthHint = `${formatCount(stats.recent?.total || 0)} recent · ${
                    stats.degraded ? 'degraded' : 'healthy'
                  }`;
                  return (
                    <StatItem
                      key={key}
                      label={`${key} pipeline`}
                      value={`Fallback ${fallbackRate} · Error ${errorRate}`}
                      hint={topReasons ? `${healthHint} · ${topReasons}` : healthHint}
                    />
                  );
                })}
              </StatGrid>
            </SubSection>
          )}

          <SubSection
            title="Local AI (Llama)"
            description="Current model configuration and load status."
            error={llamaConfig.error || llamaHealth.error}
          >
            <StatGrid>
              <StatItem label="Text model" value={llamaConfigValue?.textModel || '—'} />
              <StatItem label="Embedding model" value={llamaConfigValue?.embeddingModel || '—'} />
              <StatItem
                label="Loaded"
                value={
                  llamaHealthValue?.loaded === true
                    ? 'Yes'
                    : llamaHealthValue?.loaded === false
                      ? 'No'
                      : '—'
                }
                hint={llamaHealthValue?.modelName || undefined}
              />
              <StatItem
                label="Llama health"
                value={metricsValue?.llamaHealth?.status || '—'}
                hint={
                  metricsValue?.llamaHealth?.lastCheck
                    ? `Checked ${new Date(metricsValue.llamaHealth.lastCheck).toLocaleString()}`
                    : undefined
                }
              />
            </StatGrid>
          </SubSection>

          <SubSection
            title="Vector & search index"
            description="Orama vector / BM25 index size and health."
            error={vectorStats.error}
          >
            {vectorStats.value && (
              <StatGrid>
                <StatItem
                  label="Documents"
                  value={formatCount(
                    vectorStats.value.totalDocuments ??
                      vectorStats.value.totalFiles ??
                      vectorStats.value.count
                  )}
                />
                <StatItem
                  label="Embedding dimensions"
                  value={formatCount(
                    vectorStats.value.dimensions ?? vectorStats.value.embeddingDimensions
                  )}
                />
                <StatItem
                  label="Storage"
                  value={
                    vectorStats.value.storageBytes
                      ? formatBytes(vectorStats.value.storageBytes)
                      : vectorStats.value.storageSize || '—'
                  }
                />
                <StatItem
                  label="Health"
                  value={vectorStats.value.healthy === false ? 'Degraded' : 'Healthy'}
                  hint={vectorStats.value.status || undefined}
                />
              </StatGrid>
            )}
          </SubSection>

          <SubSection
            title="Degraded flags"
            description="Active user-visible degradation signals from DegradedStateTracker."
            error={degraded.error}
          >
            {degradedFlags.length === 0 ? (
              <Text variant="small" className="text-system-gray-500">
                No active degraded flags.
              </Text>
            ) : (
              <ul className="space-y-2">
                {degradedFlags.map((flag) => (
                  <li
                    key={flag.code}
                    className="rounded-md border border-border-soft bg-surface-primary px-3 py-2 shadow-sm"
                  >
                    <div className="flex items-center justify-between gap-compact">
                      <Text variant="small" className="font-semibold text-[var(--text-emphasis)]">
                        {flag.title || flag.code}
                      </Text>
                      <Text
                        variant="tiny"
                        className="text-[var(--text-muted)] uppercase tracking-wide"
                      >
                        {flag.severity || 'info'}
                      </Text>
                    </div>
                    {flag.description && (
                      <Text
                        variant="tiny"
                        className="text-[var(--text-secondary)] leading-relaxed mt-1"
                      >
                        {flag.description}
                      </Text>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </SubSection>

          <SubSection
            title="Effective STRATOSORT_* environment"
            description="Feature flags and overrides detected at startup. Empty means defaults are in effect."
          >
            {envKeys.length === 0 ? (
              <Text variant="small" className="text-system-gray-500">
                No STRATOSORT_* overrides set.
              </Text>
            ) : (
              <div className="overflow-x-auto rounded-md border border-border-soft bg-surface-primary shadow-sm">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                      <th className="px-3 py-2">Variable</th>
                      <th className="px-3 py-2">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {envKeys.map((key) => (
                      <tr key={key} className="border-t border-border-soft">
                        <td className="px-3 py-1.5 font-mono text-xs text-[var(--text-emphasis)]">
                          {key}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-xs text-[var(--text-secondary)] break-all">
                          {envSnapshot[key]}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SubSection>
        </div>
      )}
    </SettingsCard>
  );
}

DiagnosticsSnapshotSection.propTypes = {
  addNotification: PropTypes.func
};

export default DiagnosticsSnapshotSection;
