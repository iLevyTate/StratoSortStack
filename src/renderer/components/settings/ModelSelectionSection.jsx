import React, { useState, useEffect, useCallback } from 'react';
import PropTypes from 'prop-types';
import { Database, Info, FileText } from 'lucide-react';
import Select from '../ui/Select';
import Input from '../ui/Input';
import AlertBox from '../ui/AlertBox';
import StatusBadge from '../ui/StatusBadge';
import SettingRow from './SettingRow';
import SettingsCard from './SettingsCard';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import StateMessage from '../ui/StateMessage';
import { Text } from '../ui/Typography';
import { logger } from '../../../shared/logger';
import { embeddingsIpc } from '../../services/ipc';
import { isIpcTimeoutError, toErrorMessage } from '../../utils/errorMapping';

const { getModel } = require('../../../shared/modelRegistry');
const { NUMERIC_LIMITS } = require('../../../shared/validationConstants');

// Canonical bounds shared with the persistence + IPC validation layers so the
// UI cannot drift from what the backend accepts.
const GPU_LAYERS_RANGE = NUMERIC_LIMITS.llamaGpuLayers;
const CONTEXT_SIZE_RANGE = NUMERIC_LIMITS.llamaContextSize;

/**
 * Coerce a numeric input to an integer within [range.min, range.max].
 * Falls back to `fallback` when the value isn't a finite number (e.g. an
 * empty field mid-edit) so we never persist NaN.
 */
function clampInt(rawValue, range, fallback) {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(range.max, Math.max(range.min, parsed));
}

/**
 * Resolve the embedding dimension for a model name.
 * Primary: exact lookup in MODEL_CATALOG (GGUF filenames).
 * Fallback: partial-match known dimension prefixes.
 */
const DIMENSION_FALLBACKS = {
  'nomic-embed': 768,
  'mxbai-embed-large': 1024,
  embeddinggemma: 768,
  'all-minilm': 384,
  'bge-large': 1024,
  'snowflake-arctic-embed': 1024,
  gte: 768
};

function getEmbeddingDimensions(modelName) {
  if (!modelName) return null;
  // Exact registry lookup (GGUF filenames)
  const info = getModel(modelName);
  if (info?.dimensions) return info.dimensions;
  // Partial-match fallback for unknown models
  const lower = modelName.toLowerCase();
  const entries = Object.entries(DIMENSION_FALLBACKS).sort(([a], [b]) => b.length - a.length);
  for (const [prefix, dim] of entries) {
    if (lower.includes(prefix)) return dim;
  }
  return null;
}

/**
 * Model selection section for text, vision, and embedding models
 * Displays categorized model dropdowns with helpful messages when categories are empty
 */
function ModelSelectionSection({
  settings,
  setSettings,
  textModelOptions,
  visionModelOptions,
  embeddingModelOptions
}) {
  const [embeddingModelChanged, setEmbeddingModelChanged] = useState(false);
  const [pendingModel, setPendingModel] = useState(null);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [stats, setStats] = useState(null);
  const [isRebuilding, setIsRebuilding] = useState(false);
  // Outcome of the last "Change & rebuild now" run, rendered as an inline
  // AlertBox: { variant: 'info'|'success'|'danger', message }. Previously a
  // failed rebuild was silently swallowed — the dialog just closed and a
  // misleading "Model changed" banner appeared with no error at all.
  const [rebuildStatus, setRebuildStatus] = useState(null);
  const isMountedRef = React.useRef(true);
  const statsRequestIdRef = React.useRef(0);

  // Engine-tuning fields are edited through local drafts and committed on
  // blur/Enter. Clamping inside onChange mangled multi-digit input — typing
  // "4096" in the context-size field became 512 → 5124… because every
  // keystroke was clamped and auto-saved.
  const [gpuLayersDraft, setGpuLayersDraft] = useState(() => String(settings.llamaGpuLayers ?? -1));
  const [contextSizeDraft, setContextSizeDraft] = useState(() =>
    String(settings.llamaContextSize ?? 8192)
  );

  useEffect(() => {
    setGpuLayersDraft(String(settings.llamaGpuLayers ?? -1));
  }, [settings.llamaGpuLayers]);

  useEffect(() => {
    setContextSizeDraft(String(settings.llamaContextSize ?? 8192));
  }, [settings.llamaContextSize]);

  const commitGpuLayers = useCallback(() => {
    const next = clampInt(gpuLayersDraft, GPU_LAYERS_RANGE, settings.llamaGpuLayers ?? -1);
    // Snap the field to the committed value (covers blank/out-of-range input,
    // where the settings value may not change and the sync effect won't fire).
    setGpuLayersDraft(String(next));
    setSettings((prev) => ({ ...prev, llamaGpuLayers: next }));
  }, [gpuLayersDraft, settings.llamaGpuLayers, setSettings]);

  const commitContextSize = useCallback(() => {
    const next = clampInt(contextSizeDraft, CONTEXT_SIZE_RANGE, settings.llamaContextSize ?? 8192);
    setContextSizeDraft(String(next));
    setSettings((prev) => ({ ...prev, llamaContextSize: next }));
  }, [contextSizeDraft, settings.llamaContextSize, setSettings]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const fetchStats = useCallback((forceRefresh = false) => {
    const requestId = ++statsRequestIdRef.current;
    embeddingsIpc
      .getStatsCached({ forceRefresh })
      .then((s) => {
        if (isMountedRef.current && requestId === statsRequestIdRef.current) {
          setStats(s);
        }
        return undefined;
      })
      .catch((err) => {
        if (isMountedRef.current && requestId === statsRequestIdRef.current) {
          logger.error('Failed to fetch stats', err);
        }
      });
  }, []);

  useEffect(() => {
    fetchStats(true);
  }, [settings.embeddingModel, fetchStats]);

  const handleEmbeddingModelChange = (e) => {
    const newModel = e.target.value;
    if (newModel !== settings.embeddingModel) {
      setPendingModel(newModel);
      setShowConfirmDialog(true);
      fetchStats(true);
    }
  };

  const confirmChangeAndRebuild = async () => {
    const targetModel = pendingModel;
    if (!targetModel) return;
    // Apply the model selection immediately (same effect as "Change only").
    // The rebuild handler switches the engine to the override at start, so
    // leaving the form on the OLD model while the rebuild runs desyncs the
    // saved settings from the engine — and if the IPC invoke times out while
    // main keeps rebuilding, the next settings auto-save would push the stale
    // model back and invalidate the freshly built index.
    setSettings((prev) => ({ ...prev, embeddingModel: targetModel }));
    setEmbeddingModelChanged(false);
    setIsRebuilding(true);
    // Close the dialog right away — a full rebuild can run for many minutes
    // and holding a modal open for its duration locks the user out.
    setShowConfirmDialog(false);
    setPendingModel(null);
    setRebuildStatus({
      variant: 'info',
      message: `Rebuilding embeddings with ${targetModel}\u2026 You can keep using the app meanwhile.`
    });
    try {
      if (!window.electronAPI?.embeddings?.fullRebuild) {
        throw new Error('Embeddings rebuild API is unavailable');
      }
      const rebuildResult = await window.electronAPI.embeddings.fullRebuild({
        modelOverride: targetModel
      });
      if (!rebuildResult || typeof rebuildResult !== 'object') {
        throw new Error('Embeddings rebuild returned an invalid response');
      }
      if (rebuildResult.success !== true) {
        throw new Error(rebuildResult.error || 'Embeddings rebuild failed');
      }
      if (isMountedRef.current) {
        setRebuildStatus({
          variant: 'success',
          message: `Embeddings rebuilt with ${targetModel}.`
        });
        fetchStats(true);
      }
    } catch (error) {
      logger.error('Failed to rebuild embeddings', error);
      if (isMountedRef.current) {
        if (isIpcTimeoutError(error)) {
          // The main process is still rebuilding — this is not a failure.
          // The embeddings status in AI Configuration reflects live progress.
          setRebuildStatus({
            variant: 'info',
            message:
              'The rebuild is taking longer than expected and is still running in the background. Check embeddings status in AI Configuration before starting another rebuild.'
          });
        } else {
          setRebuildStatus({
            variant: 'danger',
            message: `Embeddings rebuild failed: ${toErrorMessage(error)}. Your model selection was kept — rebuild embeddings from AI Configuration to apply it.`
          });
          // Model changed but the index wasn't rebuilt — this banner is now
          // accurate and points at the recovery path.
          setEmbeddingModelChanged(true);
        }
      }
    } finally {
      if (isMountedRef.current) {
        setIsRebuilding(false);
      }
    }
  };

  const confirmChangeOnly = () => {
    setSettings((prev) => ({ ...prev, embeddingModel: pendingModel }));
    setEmbeddingModelChanged(true);
    setRebuildStatus(null);
    setShowConfirmDialog(false);
    setPendingModel(null);
  };

  const cancelChange = () => {
    setShowConfirmDialog(false);
    setPendingModel(null);
  };

  const hasTextModels = textModelOptions.length > 0;
  const hasVisionModels = visionModelOptions.length > 0;
  const hasEmbeddingModels = embeddingModelOptions.length > 0;

  return (
    <SettingsCard
      title="Default AI models"
      description="Choose which GGUF models StratoSort uses for analysis, vision, and embeddings."
      headerAction={
        <StatusBadge variant="info" className="whitespace-nowrap">
          <span className="flex items-center gap-compact">
            <Database className="w-4 h-4" />
            Loaded locally
          </span>
        </StatusBadge>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-relaxed">
        {/* Text Model Selection */}
        <SettingRow
          layout="col"
          label="Text model"
          description={`${textModelOptions.length} available`}
          className="h-full"
        >
          {hasTextModels ? (
            <Select
              value={settings.textModel}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  textModel: e.target.value
                }))
              }
              className="w-full"
            >
              {textModelOptions.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </Select>
          ) : (
            <StateMessage
              icon={FileText}
              tone="neutral"
              size="sm"
              align="left"
              title="No text models found"
              description="Download a text model from the Models tab."
              className="p-4 bg-surface-muted rounded-xl border border-border-soft"
              contentClassName="max-w-xs"
            />
          )}
        </SettingRow>

        {/* Vision Model Selection */}
        <SettingRow
          layout="col"
          label="Vision model"
          description={`${visionModelOptions.length} available`}
          className="h-full"
        >
          {hasVisionModels ? (
            <Select
              value={settings.visionModel}
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  visionModel: e.target.value
                }))
              }
              className="w-full"
            >
              {visionModelOptions.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </Select>
          ) : (
            <StateMessage
              icon={Info}
              tone="neutral"
              size="sm"
              align="left"
              title="No vision models found"
              description="Download a vision model from the Models tab for image analysis."
              className="p-4 bg-surface-muted rounded-xl border border-border-soft"
              contentClassName="max-w-xs"
            />
          )}
        </SettingRow>

        {/* Embedding Model Selection */}
        <SettingRow
          layout="col"
          label="Embedding model"
          description={`${embeddingModelOptions.length} available`}
          className="h-full"
        >
          {hasEmbeddingModels ? (
            <div className="space-y-3">
              <Select
                value={settings.embeddingModel}
                onChange={handleEmbeddingModelChange}
                disabled={isRebuilding}
                className="w-full"
              >
                {embeddingModelOptions.map((model) => (
                  <option key={model} value={model}>
                    {model} ({getEmbeddingDimensions(model) || '?'} dims)
                  </option>
                ))}
              </Select>

              <AlertBox variant="info">
                Different models use different vector dimensions. Changing the model requires
                rebuilding your embeddings database.
              </AlertBox>

              {rebuildStatus && (
                <AlertBox variant={rebuildStatus.variant}>{rebuildStatus.message}</AlertBox>
              )}

              {embeddingModelChanged && (
                <AlertBox variant="warning">
                  <span className="font-medium">Model changed.</span> Rebuild embeddings in AI
                  Configuration to apply.
                </AlertBox>
              )}
            </div>
          ) : (
            <StateMessage
              icon={Database}
              tone="neutral"
              size="sm"
              align="left"
              title="No embedding models available"
              description="Pull embeddinggemma (recommended) or mxbai-embed-large."
              className="p-4 bg-surface-muted rounded-xl border border-border-soft"
              contentClassName="max-w-xs"
            />
          )}
        </SettingRow>
      </div>

      {/* LLM engine tuning (in-process node-llama-cpp). These map directly to
          llamaGpuLayers / llamaContextSize. Saving forwards them to
          LlamaService; a model already in memory reloads on its next use. */}
      <div className="mt-6 pt-6 border-t border-border-soft">
        <Text as="div" variant="small" className="font-medium text-system-gray-700 mb-1">
          Engine tuning
        </Text>
        <Text as="div" variant="tiny" className="text-system-gray-500 mb-4">
          Advanced node-llama-cpp settings. Saved changes apply on the next analysis or chat
          request; a model already loaded is reloaded with the new values.
        </Text>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-relaxed">
          <SettingRow
            layout="col"
            label="GPU layers"
            description="Layers offloaded to the GPU. -1 lets the engine offload as many as fit; 0 forces CPU-only."
          >
            <Input
              type="number"
              min={GPU_LAYERS_RANGE.min}
              max={GPU_LAYERS_RANGE.max}
              step={1}
              value={gpuLayersDraft}
              onChange={(e) => setGpuLayersDraft(e.target.value)}
              onBlur={commitGpuLayers}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitGpuLayers();
              }}
              className="w-full"
              aria-label="GPU layers"
            />
          </SettingRow>

          <SettingRow
            layout="col"
            label="Context size (tokens)"
            description="Maximum context window for text analysis. Larger uses more memory."
          >
            <Input
              type="number"
              min={CONTEXT_SIZE_RANGE.min}
              max={CONTEXT_SIZE_RANGE.max}
              step={512}
              value={contextSizeDraft}
              onChange={(e) => setContextSizeDraft(e.target.value)}
              onBlur={commitContextSize}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitContextSize();
              }}
              className="w-full"
              aria-label="Context size in tokens"
            />
          </SettingRow>
        </div>
      </div>

      {/* Confirmation Dialog */}
      <Modal
        isOpen={showConfirmDialog}
        onClose={cancelChange}
        title="Change embedding model?"
        size="sm"
      >
        <div className="space-y-4">
          <AlertBox variant="warning">
            <div>
              <p className="font-medium mb-1">This will invalidate existing embeddings.</p>
              <p>
                Switching from <strong>{settings.embeddingModel}</strong> to{' '}
                <strong>{pendingModel}</strong> changes the vector dimensions. You will need to
                rebuild the vector database to search existing files.
              </p>
            </div>
          </AlertBox>

          {stats &&
            (stats.files > 0 || stats.fileChunks > 0 || stats.analysisHistory?.totalFiles > 0) && (
              <div className="flex items-center gap-compact p-3 bg-surface-muted rounded-lg border border-border-soft">
                <FileText className="w-4 h-4" />
                <Text as="span" variant="small" className="text-system-gray-600">
                  {stats.files || 0} files ({stats.fileChunks || 0} chunks) currently indexed.
                  {(stats.analysisHistory?.embedding?.eligibleFiles > 0 ||
                    stats.analysisHistory?.totalFiles > 0) &&
                    ` (~${stats.analysisHistory?.embedding?.eligibleFiles ?? stats.analysisHistory.totalFiles} eligible files in history)`}
                </Text>
              </div>
            )}

          <div className="flex flex-col gap-compact pt-2">
            <Button
              onClick={confirmChangeAndRebuild}
              disabled={isRebuilding}
              variant="primary"
              size="sm"
              className="w-full justify-center"
            >
              {isRebuilding ? 'Starting rebuild\u2026' : 'Change & rebuild now'}
            </Button>

            <Button
              onClick={confirmChangeOnly}
              disabled={isRebuilding}
              variant="secondary"
              size="sm"
              className="w-full justify-center"
            >
              Change only (rebuild later)
            </Button>

            <Button
              onClick={cancelChange}
              disabled={isRebuilding}
              variant="ghost"
              size="sm"
              className="w-full justify-center"
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </SettingsCard>
  );
}

ModelSelectionSection.propTypes = {
  settings: PropTypes.object.isRequired,
  setSettings: PropTypes.func.isRequired,
  textModelOptions: PropTypes.array.isRequired,
  visionModelOptions: PropTypes.array.isRequired,
  embeddingModelOptions: PropTypes.array.isRequired
};

export default ModelSelectionSection;
