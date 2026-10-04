import React, { useCallback, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { AlertCircle, CheckCircle2, Cpu, Download, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import Button from '../ui/Button';
import StatusBadge from '../ui/StatusBadge';
import { ConfirmModal } from '../ui/Modal';
import SettingsCard from './SettingsCard';
import SettingsGroup from './SettingsGroup';
import StateMessage from '../ui/StateMessage';
import { Text } from '../ui/Typography';
import SettingRow from './SettingRow';

/**
 * Llama AI configuration section
 * Displays local model status and management for node-llama-cpp
 * No external server required - all processing is in-process
 */
function LlamaConfigSection({
  llamaHealth,
  isRefreshingModels = false,
  isDownloading = false,
  downloadProgress,
  modelList = [],
  showAllModels,
  setShowAllModels,
  onRefreshModels,
  onDownloadModel,
  onDeleteModel,
  isAdvancedMode = true,
  activeModelNames = []
}) {
  // Stage destructive deletes through a ConfirmModal so a single misclick
  // can't drop a multi-gigabyte model. Tracks the model object (not just
  // the name) so the dialog can show display name + size.
  const [pendingDelete, setPendingDelete] = useState(null);

  // Deleting a model that is currently configured as the text/vision/
  // embedding default leaves that capability broken until the user picks a
  // replacement — call that out in the confirm dialog instead of letting it
  // happen silently.
  const pendingDeleteIsActive = useMemo(() => {
    if (!pendingDelete) return false;
    const candidates = [pendingDelete.name, pendingDelete.filename].filter(Boolean);
    return candidates.some((name) => activeModelNames.includes(name));
  }, [pendingDelete, activeModelNames]);

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete || typeof onDeleteModel !== 'function') return;
    await onDeleteModel(pendingDelete.name || pendingDelete.filename);
  }, [pendingDelete, onDeleteModel]);

  // `cpu` / `false` / absent all mean "no GPU backend is live". Declared
  // before the badge because both the badge copy and the GPU panel below
  // branch on it and must not disagree.
  const isCpuBackend =
    llamaHealth?.gpuBackend === 'cpu' ||
    llamaHealth?.gpuBackend === false ||
    !llamaHealth?.gpuBackend;

  const healthBadge = useMemo(() => {
    if (downloadProgress) {
      return {
        variant: 'info',
        icon: <Loader2 className="w-4 h-4 animate-spin" />,
        label: `Downloading: ${downloadProgress.percent || 0}%`
      };
    }
    if (!llamaHealth) {
      return {
        variant: 'info',
        icon: <Cpu className="w-4 h-4" />,
        label: 'Initializing AI\u2026'
      };
    }
    const isHealthy = llamaHealth.status === 'healthy' || llamaHealth.initialized;
    const openCircuits = Array.isArray(llamaHealth.openCircuits) ? llamaHealth.openCircuits : [];
    if (isHealthy && openCircuits.length > 0) {
      // A breaker stays open for 5 minutes after five straight failures;
      // without this the badge read "Ready" while every request was refused.
      return {
        variant: 'warning',
        icon: <AlertCircle className="w-4 h-4" />,
        label: `Paused (${openCircuits.join(', ')} model${openCircuits.length > 1 ? 's' : ''} failing, retry in 5 min)`
      };
    }
    if (isHealthy && llamaHealth.usingCPUFallback) {
      // Two different failures used to share one string, and it was wrong for
      // both. A whole-engine fallback leaves `gpuBackend === 'cpu'`, so
      // "<backend> unavailable" rendered as "cpu unavailable"; a per-type
      // fallback happens while the GPU backend is live, so claiming the GPU
      // is unavailable — and implying every model moved — was false twice
      // over. `cpuFallbackTypes` names the types that are actually on the
      // CPU, so say which case this is.
      const cpuFallbackTypes = Array.isArray(llamaHealth.cpuFallbackTypes)
        ? llamaHealth.cpuFallbackTypes.filter((type) => typeof type === 'string' && type)
        : [];
      let label;
      if (isCpuBackend) {
        label = 'Ready (CPU only — GPU backend unavailable)';
      } else if (cpuFallbackTypes.length > 0) {
        label = `Ready (${llamaHealth.gpuBackend} active, ${cpuFallbackTypes.join(', ')} model${
          cpuFallbackTypes.length > 1 ? 's' : ''
        } on CPU)`;
      } else {
        // A fallback reported without naming a type: stay vague rather than
        // guess which models moved.
        label = `Ready (${llamaHealth.gpuBackend} active, some models on CPU)`;
      }
      return {
        variant: 'warning',
        icon: <Cpu className="w-4 h-4" />,
        label
      };
    }
    return {
      variant: isHealthy ? 'success' : 'error',
      icon: isHealthy ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />,
      label: isHealthy
        ? `Ready (${llamaHealth.gpuBackend || 'CPU'})`
        : `Error${llamaHealth.error ? `: ${llamaHealth.error}` : ''}`
    };
  }, [llamaHealth, downloadProgress, isCpuBackend]);

  const modelCountLabel = useMemo(() => {
    const count = modelList?.length ?? 0;
    if (!count) return 'No models downloaded';
    if (count === 1) return '1 model available';
    return `${count} models available`;
  }, [modelList]);

  const gpuInfo = useMemo(() => {
    const backend = llamaHealth?.gpuBackend;
    if (!backend) return null;
    if (backend === 'metal') return 'Apple Metal (GPU accelerated)';
    if (backend === 'cuda') return 'NVIDIA CUDA (GPU accelerated)';
    if (backend === 'vulkan') return 'Vulkan (GPU accelerated)';
    if (backend === 'cpu' || backend === false) return 'CPU only (no GPU backend)';
    return String(backend);
  }, [llamaHealth]);

  const detectedGpu = useMemo(() => {
    const detected = llamaHealth?.gpuDetected;
    if (!detected || typeof detected !== 'object') return null;
    return {
      name: detected.name || 'Unknown GPU',
      type: detected.type || null,
      vramMB: Number.isFinite(detected.vramMB) ? detected.vramMB : null
    };
  }, [llamaHealth]);

  const backendAttempts = useMemo(() => {
    const attempted = llamaHealth?.gpuSelection?.attempted;
    if (!Array.isArray(attempted) || attempted.length === 0) return null;
    return attempted
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({
        backend: entry.backend || 'unknown',
        success: Boolean(entry.success),
        actualBackend: entry.actualBackend || null,
        error: entry.error || null
      }));
  }, [llamaHealth]);

  const canManageModels = isAdvancedMode === true;
  const shouldShowModelList = canManageModels && showAllModels;

  return (
    <SettingsCard
      title="Local AI engine"
      description="StratoSort uses on-device AI for complete privacy. No data leaves your computer."
      headerAction={
        <div className="flex flex-wrap items-center gap-compact">
          <StatusBadge variant={healthBadge.variant} className="whitespace-nowrap">
            <span className="flex items-center gap-compact">
              {healthBadge.icon}
              {/* The honest fallback copy names model types, so it can clip
                  in the header — keep the full text reachable on hover. */}
              <span className="truncate" title={healthBadge.label}>
                {healthBadge.label}
              </span>
            </span>
          </StatusBadge>
          <Text
            as="div"
            variant="tiny"
            className="text-system-gray-500 px-3 py-1 rounded-full bg-surface-muted border border-border-soft whitespace-nowrap"
          >
            {modelCountLabel}
          </Text>
        </div>
      }
    >
      {(gpuInfo || detectedGpu) && (
        <SettingRow
          layout="col"
          label="GPU Acceleration"
          description="AI processing is accelerated using your device's GPU when available."
          className="space-y-2"
        >
          <SettingsGroup gap="compact">
            <div className="flex items-center gap-compact">
              <Cpu className="w-5 h-5 text-system-gray-500" />
              <Text variant="small" className="font-medium">
                AI backend: {gpuInfo || 'Unknown'}
              </Text>
            </div>
            {detectedGpu && (
              <Text variant="tiny" className="text-system-gray-600">
                System GPU detected: {detectedGpu.name}
                {detectedGpu.vramMB ? ` (${detectedGpu.vramMB} MB VRAM)` : ''}
              </Text>
            )}
            {isAdvancedMode && backendAttempts && (
              <div className="pt-1 space-y-1">
                <Text variant="tiny" className="text-system-gray-600">
                  Backend init attempts:
                </Text>
                {backendAttempts.map((attempt, idx) => {
                  let suffix = '';
                  if (attempt.success) {
                    if (attempt.actualBackend && attempt.actualBackend !== attempt.backend) {
                      suffix = ` (actual: ${attempt.actualBackend})`;
                    }
                  } else if (attempt.error) {
                    suffix = ` — ${attempt.error}`;
                  }
                  return (
                    <Text
                      key={`${attempt.backend}-${idx}`}
                      variant="tiny"
                      className={`font-mono ${
                        attempt.success ? 'text-system-gray-600' : 'text-stratosort-warning'
                      }`}
                    >
                      {attempt.backend}: {attempt.success ? 'ok' : 'failed'}
                      {suffix}
                    </Text>
                  );
                })}
              </div>
            )}
            {isCpuBackend && detectedGpu?.type && detectedGpu.type !== 'cpu' && (
              <Text variant="tiny" className="text-stratosort-warning">
                GPU detected but the AI backend is running on CPU. Restart the app to retry GPU
                acceleration. Ensure CUDA (NVIDIA) or Vulkan drivers are installed and up to date.
              </Text>
            )}
          </SettingsGroup>
        </SettingRow>
      )}

      <div className="flex flex-wrap items-center gap-cozy">
        <Button
          onClick={onRefreshModels}
          variant="secondary"
          type="button"
          title="Refresh models"
          disabled={isRefreshingModels}
          leftIcon={
            isRefreshingModels ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )
          }
          size="sm"
          className="w-full sm:w-auto min-w-[9rem] justify-center"
        >
          {isRefreshingModels ? 'Refreshing\u2026' : 'Refresh models'}
        </Button>
        {canManageModels ? (
          <Button
            onClick={() => setShowAllModels((v) => !v)}
            variant="subtle"
            type="button"
            title="Toggle model list"
            size="sm"
            className="w-full sm:w-auto min-w-[9rem] justify-center"
          >
            {showAllModels ? 'Hide models' : 'View all models'}
          </Button>
        ) : (
          onDownloadModel && (
            <Button
              onClick={onDownloadModel}
              variant="secondary"
              size="sm"
              disabled={isDownloading}
              leftIcon={
                isDownloading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )
              }
              className="w-full sm:w-auto min-w-[12rem] justify-center"
            >
              {isDownloading ? 'Downloading…' : 'Download recommended models'}
            </Button>
          )
        )}
        <Text
          as="div"
          variant="tiny"
          className="flex-1 min-w-[240px] text-system-gray-600 flex items-center gap-compact"
        >
          {downloadProgress ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin text-system-gray-500" />
              <span className="truncate" title={`Downloading ${downloadProgress.modelName}`}>
                {downloadProgress.modelName}: {downloadProgress.percent}%
              </span>
            </>
          ) : (
            <span className="truncate">
              {llamaHealth && (llamaHealth.status === 'healthy' || llamaHealth.initialized)
                ? 'AI engine ready. All processing happens locally.'
                : llamaHealth?.error
                  ? `AI engine error: ${llamaHealth.error}`
                  : 'Initializing local AI engine\u2026'}
            </span>
          )}
        </Text>
      </div>

      {shouldShowModelList && (
        <SettingsGroup gap="compact">
          <div className="flex items-center justify-between gap-compact">
            <Text variant="small" className="font-medium text-system-gray-700">
              Downloaded models
            </Text>
            <Text variant="tiny" className="text-system-gray-500">
              {modelCountLabel}
            </Text>
          </div>
          {!modelList || modelList.length === 0 ? (
            <StateMessage
              icon={AlertCircle}
              tone="warning"
              size="sm"
              align="left"
              title="No models downloaded"
              description="Download models to enable AI features."
              className="py-2"
              contentClassName="max-w-xs"
            />
          ) : (
            <ul className="space-y-2">
              {modelList.map((model) => (
                <li
                  key={model.name || model.filename}
                  className="flex items-center justify-between gap-compact px-3 py-2 rounded-lg border border-border-soft bg-surface-primary shadow-sm"
                >
                  <div className="flex-1 min-w-0">
                    <Text variant="small" className="font-mono truncate block">
                      {model.displayName || model.name || model.filename}
                    </Text>
                    <Text variant="tiny" className="text-system-gray-500">
                      {model.type} • {model.sizeMB ? `${model.sizeMB}MB` : 'Unknown size'}
                    </Text>
                  </div>
                  {onDeleteModel && (
                    <Button
                      onClick={() => setPendingDelete(model)}
                      variant="ghost"
                      size="sm"
                      title="Delete model"
                      aria-label={`Delete ${model.displayName || model.name || model.filename}`}
                      className="text-stratosort-danger hover:opacity-90"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {onDownloadModel && (
            <div className="pt-3 border-t border-border-soft">
              <Button
                onClick={onDownloadModel}
                variant="secondary"
                size="sm"
                disabled={isDownloading}
                leftIcon={
                  isDownloading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Download className="w-4 h-4" />
                  )
                }
              >
                {isDownloading ? 'Downloading…' : 'Download recommended models'}
              </Button>
            </div>
          )}
        </SettingsGroup>
      )}

      <ConfirmModal
        isOpen={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={handleConfirmDelete}
        title="Delete this model?"
        message={
          (pendingDeleteIsActive
            ? 'This model is currently selected as one of your default AI models — analysis, vision, or search will stop working until you choose a replacement in Default AI models. '
            : '') +
          (pendingDelete?.sizeMB
            ? `Removing this model frees ~${pendingDelete.sizeMB} MB of disk. You can re-download it later, but it must be downloaded again from scratch.`
            : 'Removing this model frees its disk space. You can re-download it later, but it must be downloaded again from scratch.')
        }
        confirmText="Delete model"
        cancelText="Cancel"
        variant="danger"
        fileName={pendingDelete?.displayName || pendingDelete?.name || pendingDelete?.filename}
      />
    </SettingsCard>
  );
}

LlamaConfigSection.propTypes = {
  llamaHealth: PropTypes.object,
  isRefreshingModels: PropTypes.bool,
  isDownloading: PropTypes.bool,
  downloadProgress: PropTypes.object,
  modelList: PropTypes.array,
  showAllModels: PropTypes.bool.isRequired,
  setShowAllModels: PropTypes.func.isRequired,
  onRefreshModels: PropTypes.func.isRequired,
  onDownloadModel: PropTypes.func,
  onDeleteModel: PropTypes.func,
  // Names of the currently configured default models (text/vision/embedding)
  // so the delete confirm can warn when the deletion breaks an active default.
  activeModelNames: PropTypes.arrayOf(PropTypes.string),
  isAdvancedMode: PropTypes.bool
};

export default LlamaConfigSection;
