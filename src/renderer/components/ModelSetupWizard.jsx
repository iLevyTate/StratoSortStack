// src/renderer/components/ModelSetupWizard.jsx

import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  createContext,
  useContext
} from 'react';
import { Download, HardDrive, Cpu, CheckCircle, Loader2, RefreshCw } from 'lucide-react';
import AlertBox from './ui/AlertBox';
import Button from './ui/Button';
import Card from './ui/Card';
import SelectionCard from './ui/SelectionCard';
import { ConfirmModal } from './ui/Modal';
import { Text, Heading, Caption } from './ui/Typography';
import { formatBytes, formatDuration } from '../utils/format';
import { AI_DEFAULTS, INSTALL_MODEL_PROFILES } from '../../shared/constants';
import { recommendInstallProfile } from '../../shared/aiModelConfig';
import { getModel } from '../../shared/modelRegistry';
import { createLogger } from '../../shared/logger';
import { EXPERIENCE_MODES } from '../../shared/experienceMode';
import { withTimeout } from '../../shared/promiseUtils';
import { toErrorMessage } from '../utils/errorMapping';
import { settingsIpc } from '../services/ipc';

const logger = createLogger('ModelSetupWizard');

const CHECK_SYSTEM_TIMEOUT_MS = 12000;
const CHECKING_ESCAPE_MS = 7000;
const CONTINUE_WITH_LIMITED_AI_LABEL = 'Continue with limited AI';
const STEP_ORDER = ['checking', 'select', 'downloading', 'complete'];
const STEP_TITLES = {
  checking: 'Check',
  select: 'Choose',
  downloading: 'Download',
  complete: 'Finish'
};
const CHECKING_STATUS_MESSAGES = [
  'Detecting available local models...',
  'Checking active background downloads...',
  'Preparing safe defaults for your setup...'
];

function getModelTotalBytes(filename) {
  const model = getModel(filename);
  if (!model) return null;
  const baseSize = Number(model.size);
  if (!Number.isFinite(baseSize) || baseSize <= 0) return null;

  let total = baseSize;
  if (model.clipModel) {
    const clipSize = Number(model.clipModel.size);
    if (!Number.isFinite(clipSize) || clipSize <= 0) return null;
    total += clipSize;
  }
  return total;
}

function summarizeModelBytes(filenames) {
  return filenames.filter(Boolean).reduce(
    (summary, filename) => {
      const size = getModelTotalBytes(filename);
      if (size == null) {
        summary.hasUnknown = true;
        return summary;
      }

      summary.totalBytes += size;
      summary.hasKnown = true;
      return summary;
    },
    { totalBytes: 0, hasKnown: false, hasUnknown: false }
  );
}

function formatByteSummary(summary, emptyLabel = 'Size unavailable') {
  if (!summary?.hasKnown) return emptyLabel;
  if (summary.hasUnknown) return `At least ${formatBytes(summary.totalBytes)}`;
  return formatBytes(summary.totalBytes);
}

/**
 * When rendered inside the generic Modal component, the Modal owns the outer
 * frame, max-width, and scrolling. The wizard should then render as a
 * borderless semantic section so we don't nest Cards or double-scroll.
 */
const WizardLayoutContext = createContext({ embedded: false });

/** Keep the card shadow outside the scroll container. */
function getWizardFrameClassName() {
  return ['max-w-2xl mx-auto w-full', 'px-3 sm:px-4 py-3', 'animate-loading-fade'].join(' ');
}

function getWizardScrollAreaClassName() {
  return [
    'max-h-[min(calc(100vh-var(--app-nav-height)-7rem),720px)]',
    'overflow-y-auto overflow-x-hidden',
    'modern-scrollbar',
    'scroll-py-2',
    'pr-1'
  ].join(' ');
}

const PROFILE_MODELS = {
  base: {
    embedding: INSTALL_MODEL_PROFILES?.BASE_SMALL?.models?.EMBEDDING,
    text: INSTALL_MODEL_PROFILES?.BASE_SMALL?.models?.TEXT_ANALYSIS,
    vision: INSTALL_MODEL_PROFILES?.BASE_SMALL?.models?.IMAGE_ANALYSIS
  },
  quality: {
    embedding: INSTALL_MODEL_PROFILES?.BETTER_QUALITY?.models?.EMBEDDING,
    text: INSTALL_MODEL_PROFILES?.BETTER_QUALITY?.models?.TEXT_ANALYSIS,
    vision: INSTALL_MODEL_PROFILES?.BETTER_QUALITY?.models?.IMAGE_ANALYSIS
  }
};

function truncateMiddle(str, max = 42) {
  if (typeof str !== 'string' || str.length <= max) return str;
  const head = Math.floor(max / 2) - 1;
  const tail = Math.ceil(max / 2) - 1;
  return `${str.slice(0, head)}…${str.slice(-tail)}`;
}

function detectProfileKey(models) {
  if (
    models?.embedding === PROFILE_MODELS.quality.embedding &&
    models?.text === PROFILE_MODELS.quality.text &&
    models?.vision === PROFILE_MODELS.quality.vision
  ) {
    return 'quality';
  }
  if (
    models?.embedding === PROFILE_MODELS.base.embedding &&
    models?.text === PROFILE_MODELS.base.text &&
    models?.vision === PROFILE_MODELS.base.vision
  ) {
    return 'base';
  }
  return 'custom';
}

export default function ModelSetupWizard({ onComplete, onSkip, onStepChange, embedded = false }) {
  // Memoize the provider value so context consumers (many, deep in the
  // wizard body) don't re-render whenever the wizard's parent re-renders
  // for unrelated reasons. Without useMemo the object identity changes
  // every render, invalidating context consumers even when `embedded`
  // hasn't changed.
  const contextValue = useMemo(() => ({ embedded }), [embedded]);
  return (
    <WizardLayoutContext.Provider value={contextValue}>
      <ModelSetupWizardBody onComplete={onComplete} onSkip={onSkip} onStepChange={onStepChange} />
    </WizardLayoutContext.Provider>
  );
}

function ModelSetupWizardBody({ onComplete, onSkip, onStepChange }) {
  const [systemInfo, setSystemInfo] = useState(null);
  const [recommendations, setRecommendations] = useState(null);
  const [selectedProfile, setSelectedProfile] = useState('base');
  const [selectedModels, setSelectedModels] = useState({});
  const [availableModels, setAvailableModels] = useState([]);
  const [downloadState, setDownloadState] = useState({});
  const [step, setStep] = useState('checking'); // checking, select, downloading, complete
  const [initError, setInitError] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [hasApi, setHasApi] = useState(true);
  const [showCheckingEscape, setShowCheckingEscape] = useState(false);
  const [checkingStatusIndex, setCheckingStatusIndex] = useState(0);
  /** When true, save experienceMode advanced after models apply (quality profile default). */
  const [startInAdvancedMode, setStartInAdvancedMode] = useState(false);
  /**
   * What this computer can carry, from the main process hardware probe:
   * `{ profile, reason, facts }` (see shared/aiModelConfig.recommendInstallProfile).
   * Shown next to the profile cards; preselected on a fresh install only.
   */
  const [hardwareAdvice, setHardwareAdvice] = useState(null);
  // Once the user clicks a profile card the recommendation stops steering
  // the selection (it still shows as information).
  const userPickedProfileRef = useRef(false);
  const isMountedRef = useRef(true);
  const userInitiatedDownloadsRef = useRef(false);
  // Synchronous guard against double-triggering startDownloads. `isRefreshing`
  // is React state and won't reflect a mid-click change until the next render,
  // so a rapid second click could start a parallel download pass while the
  // first one was still enumerating models. This ref flips immediately on
  // entry and resets in `finally`.
  const startDownloadsInFlightRef = useRef(false);
  // Embedding model the engine is configured with when the wizard loaded,
  // and the pending "switch and rebuild?" question, if any (audit row ML-08).
  const currentEmbeddingModelRef = useRef(null);
  const pendingEmbeddingResolveRef = useRef(null);
  // The prompt's own promise, shared by every caller that asks while it is
  // open. The download poll asks every four seconds; without this each ask
  // replaced the resolver and the earlier callers never heard the answer.
  const pendingEmbeddingPromiseRef = useRef(null);
  // One profile apply at a time: the poll, the Continue button and
  // checkSystem all call it, and a second run while the first waits on the
  // user would prompt again or apply twice.
  const applyInFlightRef = useRef(null);
  const [pendingEmbeddingSwitch, setPendingEmbeddingSwitch] = useState(null);

  useEffect(() => {
    // StrictMode mounts effects twice in development; re-arm the mounted flag
    // so long-running checks and escape timers can still update state.
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (typeof onStepChange === 'function') {
      onStepChange(step);
    }
  }, [step, onStepChange]);

  const availableSet = useMemo(() => new Set(availableModels || []), [availableModels]);

  const updateDownloadState = useCallback((modelName, patch) => {
    if (!modelName) return;
    setDownloadState((prev) => ({
      ...prev,
      [modelName]: {
        ...(prev[modelName] || {}),
        ...patch
      }
    }));
  }, []);

  const handleCancelDownload = useCallback(
    async (filename) => {
      if (!filename || !window?.electronAPI?.llama?.cancelDownload) return;
      try {
        const result = await window.electronAPI.llama.cancelDownload(filename);
        if (result?.success !== false) {
          updateDownloadState(filename, { status: 'cancelled', error: null });
        }
      } catch (error) {
        updateDownloadState(filename, {
          status: 'failed',
          error: error?.message || 'Could not cancel download'
        });
      }
    },
    [updateDownloadState]
  );

  // Switching the embedding model clears every vector collection and
  // re-embeds the library. Settings warns before doing that; re-running the
  // wizard and picking the other profile used to do it with no question.
  // Resolves true when no index would be lost or the user agreed.
  const confirmEmbeddingSwitch = useCallback(async (nextEmbeddingModel) => {
    const current = currentEmbeddingModelRef.current;
    if (!nextEmbeddingModel || !current || nextEmbeddingModel === current) return true;
    const getStats = window?.electronAPI?.embeddings?.getStats;
    let indexedFiles = 0;
    if (typeof getStats === 'function') {
      try {
        const stats = await getStats();
        indexedFiles = Number(stats?.files) || 0;
      } catch (error) {
        logger.debug('embeddings.getStats failed before embedding switch', {
          error: error?.message
        });
      }
    }
    if (indexedFiles === 0) return true;
    if (pendingEmbeddingPromiseRef.current) return pendingEmbeddingPromiseRef.current;
    const prompt = new Promise((resolve) => {
      pendingEmbeddingResolveRef.current = resolve;
      setPendingEmbeddingSwitch({ from: current, to: nextEmbeddingModel, indexedFiles });
    }).then((accepted) => {
      pendingEmbeddingPromiseRef.current = null;
      return accepted;
    });
    pendingEmbeddingPromiseRef.current = prompt;
    return prompt;
  }, []);

  const settleEmbeddingSwitch = useCallback((accepted) => {
    const resolve = pendingEmbeddingResolveRef.current;
    pendingEmbeddingResolveRef.current = null;
    setPendingEmbeddingSwitch(null);
    if (typeof resolve === 'function') resolve(accepted);
  }, []);

  const embeddingSwitchModal = (
    <ConfirmModal
      isOpen={Boolean(pendingEmbeddingSwitch)}
      onClose={() => settleEmbeddingSwitch(false)}
      onConfirm={() => settleEmbeddingSwitch(true)}
      title="Switch embedding model and rebuild the index?"
      message={
        pendingEmbeddingSwitch
          ? `Your search index holds ${pendingEmbeddingSwitch.indexedFiles} file${
              pendingEmbeddingSwitch.indexedFiles === 1 ? '' : 's'
            } embedded with "${pendingEmbeddingSwitch.from}". Switching to "${pendingEmbeddingSwitch.to}" clears that index and re-embeds everything. Search results are incomplete until the rebuild finishes.`
          : ''
      }
      confirmText="Switch and rebuild"
      cancelText="Keep current model"
      variant="warning"
    />
  );

  // State-independent core for applying a model profile. Defined before
  // checkSystem (which calls it with freshly computed values) so neither
  // function captures stale selection state.
  const applyProfileConfigOnce = useCallback(
    async (models, advancedMode) => {
      const updateConfig = window?.electronAPI?.llama?.updateConfig;
      if (typeof updateConfig !== 'function') return true;
      const proceed = await confirmEmbeddingSwitch(models.embedding);
      if (!proceed) return false;
      const payload = {
        textModel: models.text,
        embeddingModel: models.embedding
      };
      if (models.vision) {
        payload.visionModel = models.vision;
      }
      try {
        const response = await updateConfig(payload);
        if (response?.success === false) {
          setInitError(toErrorMessage(response?.error, 'Could not apply selected model profile.'));
          return false;
        }
        if (models.embedding) {
          currentEmbeddingModelRef.current = models.embedding;
        }
        if (advancedMode) {
          try {
            const current = await settingsIpc.get();
            const merged = {
              ...(current && typeof current === 'object' ? current : {}),
              experienceMode: EXPERIENCE_MODES.ADVANCED
            };
            await settingsIpc.save(merged);
          } catch (settingsErr) {
            setInitError(
              (prev) => prev || settingsErr?.message || 'Could not save Advanced mode to settings.'
            );
          }
        }
        return true;
      } catch (error) {
        setInitError(error?.message || 'Could not apply selected model profile.');
        return false;
      }
    },
    [confirmEmbeddingSwitch]
  );

  const applyProfileConfig = useCallback(
    (models, advancedMode) => {
      if (applyInFlightRef.current) return applyInFlightRef.current;
      const run = applyProfileConfigOnce(models, advancedMode).finally(() => {
        if (applyInFlightRef.current === run) applyInFlightRef.current = null;
      });
      applyInFlightRef.current = run;
      return run;
    },
    [applyProfileConfigOnce]
  );

  const checkSystem = useCallback(async () => {
    if (!isMountedRef.current) return;
    setIsRefreshing(true);
    setInitError(null);

    const llamaApi = window?.electronAPI?.llama;
    const hasLlamaApi =
      typeof llamaApi?.getModels === 'function' && typeof llamaApi?.getConfig === 'function';
    if (!isMountedRef.current) return;
    setHasApi(hasLlamaApi);

    const fallbackDefaults = {
      embedding: PROFILE_MODELS.base.embedding || AI_DEFAULTS?.EMBEDDING?.MODEL,
      text: PROFILE_MODELS.base.text || AI_DEFAULTS?.TEXT?.MODEL,
      vision: PROFILE_MODELS.base.vision || AI_DEFAULTS?.IMAGE?.MODEL
    };

    const applyFallbackSelection = () => {
      const fallbackProfile = detectProfileKey(fallbackDefaults);
      const fallbackSelection = PROFILE_MODELS[fallbackProfile] || fallbackDefaults;
      setSelectedProfile(fallbackProfile);
      setStartInAdvancedMode(fallbackProfile === 'quality');
      setRecommendations(fallbackSelection);
      setSelectedModels(fallbackSelection);
      setSystemInfo({ gpuBackend: null, modelsPath: null });
    };

    if (!hasLlamaApi) {
      if (!isMountedRef.current) return;
      applyFallbackSelection();
      setInitError('AI engine is still starting. Please try again in a moment.');
      setStep('select');
      setIsRefreshing(false);
      return;
    }

    try {
      const [configResponse, modelsResponse, downloadStatus] = await withTimeout(
        Promise.all([
          llamaApi.getConfig(),
          llamaApi.getModels(),
          typeof llamaApi.getDownloadStatus === 'function'
            ? llamaApi.getDownloadStatus().catch((err) => {
                logger.debug('getDownloadStatus failed', { error: err?.message });
                return null;
              })
            : null
        ]),
        CHECK_SYSTEM_TIMEOUT_MS,
        'AI system check'
      );
      if (!isMountedRef.current) return;
      const config = configResponse?.config || configResponse || {};

      const suggestedSelection = modelsResponse?.selected || {};
      currentEmbeddingModelRef.current =
        config?.embeddingModel || suggestedSelection?.embeddingModel || null;
      const defaults = {
        embedding:
          suggestedSelection?.embeddingModel ||
          config?.embeddingModel ||
          fallbackDefaults.embedding,
        text: suggestedSelection?.textModel || config?.textModel || fallbackDefaults.text,
        vision: suggestedSelection?.visionModel || config?.visionModel || fallbackDefaults.vision
      };
      const profileKey = detectProfileKey(defaults);
      const selectedProfileModels = profileKey === 'custom' ? defaults : PROFILE_MODELS[profileKey];

      const modelList = Array.isArray(modelsResponse)
        ? modelsResponse
        : Array.isArray(modelsResponse?.models)
          ? modelsResponse.models
          : [];
      const available = modelList.map((m) => m.name || m.filename || m).filter(Boolean);
      const availableNow = new Set(available);

      setSelectedProfile(profileKey);
      setStartInAdvancedMode(profileKey === 'quality');
      setRecommendations(selectedProfileModels);
      setSelectedModels(selectedProfileModels);
      setAvailableModels(available);
      setSystemInfo({
        gpuBackend: config?.gpuBackend || null,
        modelsPath: config?.modelsPath || null
      });

      // Read RAM and GPU memory and say which profile fits (audit row ML-07:
      // the wizard used to read neither). Best effort and off the critical
      // path: a slow or missing probe leaves the cards as they are. On a
      // fresh install with the stock Base config and no user click yet, the
      // recommended profile is preselected; the user can still pick the other.
      const probe = window?.electronAPI?.system?.getRecommendedConcurrency;
      if (typeof probe === 'function') {
        const freshInstall = available.length === 0 && profileKey === 'base';
        probe()
          .then((hw) => {
            if (!isMountedRef.current || !hw || hw.success === false) return undefined;
            const advice = recommendInstallProfile({
              totalMemMB:
                typeof hw.totalMemGB === 'number' ? Math.round(hw.totalMemGB * 1024) : null,
              vramMB: typeof hw.vramMB === 'number' ? hw.vramMB : null,
              hasGpu: hw.hasGpu === true,
              gpuName: hw.gpuName || null
            });
            setHardwareAdvice(advice);
            if (freshInstall && !userPickedProfileRef.current && advice.profile === 'quality') {
              setSelectedProfile('quality');
              setStartInAdvancedMode(true);
              setRecommendations(PROFILE_MODELS.quality);
              setSelectedModels(PROFILE_MODELS.quality);
            }
            return undefined;
          })
          .catch((err) => {
            logger.debug('Hardware probe for profile recommendation failed', {
              error: err?.message
            });
          });
      }

      const nextDownloadState = {};
      available.forEach((name) => {
        const totalBytes = getModelTotalBytes(name);
        nextDownloadState[name] = {
          status: 'ready',
          percent: 100,
          downloadedBytes: totalBytes,
          totalBytes
        };
      });

      const activeDownloads = downloadStatus?.status?.downloads || [];
      activeDownloads.forEach((download) => {
        if (!download?.filename) return;
        nextDownloadState[download.filename] = {
          status: 'downloading',
          percent: download.progress ?? 0,
          downloadedBytes: download.downloadedBytes,
          totalBytes: download.totalBytes
        };
      });
      setDownloadState((prev) => ({ ...prev, ...nextDownloadState }));

      const missingSelected = Object.values(selectedProfileModels)
        .filter(Boolean)
        .filter((name) => !availableNow.has(name));

      if (missingSelected.length === 0) {
        // All profile models already on disk: still apply the profile so
        // LlamaService config matches the selection. Skipping this left the
        // wizard "complete" while the engine kept stale model settings.
        // advancedMode is deliberately false here: this path runs passively
        // on every mount/refresh, and force-saving experienceMode ADVANCED
        // would flip a user back who explicitly switched to simple mode.
        // The user-initiated apply flow handles the experience-mode save.
        const applied = await applyProfileConfig(selectedProfileModels, false);
        if (!isMountedRef.current) return;
        setStep(applied ? 'complete' : 'select');
      } else if (userInitiatedDownloadsRef.current && activeDownloads.length > 0) {
        setStep('downloading');
      } else {
        // Force users through Choose first unless this session started downloads.
        setStep('select');
      }
    } catch (error) {
      if (!isMountedRef.current) return;
      applyFallbackSelection();
      if (
        typeof error?.message === 'string' &&
        error.message.startsWith('AI system check timed out')
      ) {
        setInitError(
          'AI check is taking longer than expected. You can continue with manual setup or press Refresh.'
        );
      } else {
        setInitError(error?.message || 'Failed to load AI model status.');
      }
      setStep('select');
    } finally {
      if (isMountedRef.current) {
        setIsRefreshing(false);
      }
    }
  }, [applyProfileConfig]);

  useEffect(() => {
    void checkSystem();
  }, [checkSystem]);

  // Failsafe: If checkSystem hangs (e.g. backend unresponsive), force exit 'checking' state.
  // Not while the embedding-switch question is open: the check is waiting
  // on the user, not on the backend.
  useEffect(() => {
    if (step === 'checking' && !pendingEmbeddingSwitch) {
      const timer = setTimeout(() => {
        if (isMountedRef.current) {
          setInitError('AI system check timed out. Please select models manually.');
          setStep('select');
          setIsRefreshing(false);
        }
      }, 15000); // 15s failsafe (longer than checkSystem's 12s timeout)
      return () => clearTimeout(timer);
    }
  }, [step, pendingEmbeddingSwitch]);

  useEffect(() => {
    if (step !== 'checking') {
      setShowCheckingEscape(false);
      setCheckingStatusIndex(0);
      return undefined;
    }

    const escapeTimer = setTimeout(() => {
      if (isMountedRef.current) {
        setShowCheckingEscape(true);
      }
    }, CHECKING_ESCAPE_MS);

    const statusTimer = setInterval(() => {
      if (!isMountedRef.current) return;
      setCheckingStatusIndex((prev) => (prev + 1) % CHECKING_STATUS_MESSAGES.length);
    }, 2200);

    return () => {
      clearTimeout(escapeTimer);
      clearInterval(statusTimer);
    };
  }, [step]);

  useEffect(() => {
    // Subscribe to download progress
    // Note: Assuming window.electronAPI.events.onOperationProgress handles this
    const subscribe = window?.electronAPI?.events?.onOperationProgress;
    if (typeof subscribe !== 'function') return undefined;
    const unsubscribe = subscribe((data) => {
      if (!data) return;
      const eventType = data.type;
      const payload = data.progress || data;
      const modelName = data.model || payload.model || payload.filename;
      if (!modelName) return;

      if (eventType === 'model-download') {
        updateDownloadState(modelName, {
          status: 'downloading',
          percent: payload.percent ?? payload.percentage ?? 0,
          downloadedBytes: payload.downloadedBytes,
          totalBytes: payload.totalBytes,
          speedBps: payload.speedBps,
          etaSeconds: payload.etaSeconds
        });
        return;
      }

      if (eventType === 'model-download-complete') {
        const totalBytes =
          typeof payload.totalBytes === 'number' && payload.totalBytes > 0
            ? payload.totalBytes
            : getModelTotalBytes(modelName);
        const downloadedBytes =
          typeof payload.downloadedBytes === 'number' && payload.downloadedBytes > 0
            ? payload.downloadedBytes
            : totalBytes;
        updateDownloadState(modelName, {
          status: 'ready',
          percent: 100,
          downloadedBytes,
          totalBytes
        });
        setAvailableModels((prev) => Array.from(new Set([...(prev || []), modelName])));
        return;
      }

      if (eventType === 'model-download-error') {
        // Cancelling aborts the stream, which main reports as an error;
        // keep the user-initiated 'cancelled' status instead of 'failed'.
        setDownloadState((prev) => {
          if (prev[modelName]?.status === 'cancelled') return prev;
          return {
            ...prev,
            [modelName]: {
              ...(prev[modelName] || {}),
              status: 'failed',
              error: data.error || payload.error || 'Download failed'
            }
          };
        });
      }
    });
    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [updateDownloadState]);

  const applySelectedProfileConfig = useCallback(
    () => applyProfileConfig(selectedModels, startInAdvancedMode),
    [applyProfileConfig, selectedModels, startInAdvancedMode]
  );

  useEffect(() => {
    if (step !== 'downloading') return undefined;

    const llamaApi = window?.electronAPI?.llama;
    if (typeof llamaApi?.getModels !== 'function') return undefined;

    let cancelled = false;
    const POLL_INTERVAL_MS = 4000;

    async function syncDownloadState() {
      try {
        const [modelsResponse, downloadStatus] = await Promise.all([
          llamaApi.getModels(),
          typeof llamaApi.getDownloadStatus === 'function'
            ? llamaApi.getDownloadStatus().catch((err) => {
                logger.debug('getDownloadStatus failed', { error: err?.message });
                return null;
              })
            : Promise.resolve(null)
        ]);
        if (cancelled || !isMountedRef.current) return;

        const modelList = Array.isArray(modelsResponse)
          ? modelsResponse
          : Array.isArray(modelsResponse?.models)
            ? modelsResponse.models
            : [];
        const latestAvailable = modelList.map((m) => m.name || m.filename || m).filter(Boolean);
        const latestAvailableSet = new Set(latestAvailable);
        const hasReliableDownloadStatus = Array.isArray(downloadStatus?.status?.downloads);
        const activeDownloads = hasReliableDownloadStatus ? downloadStatus.status.downloads : [];

        if (latestAvailable.length > 0) {
          setAvailableModels((prev) => Array.from(new Set([...(prev || []), ...latestAvailable])));
        }

        setDownloadState((prev) => {
          const next = { ...(prev || {}) };

          latestAvailable.forEach((name) => {
            const totalBytes = getModelTotalBytes(name);
            next[name] = {
              ...(next[name] || {}),
              status: 'ready',
              percent: 100,
              downloadedBytes: totalBytes,
              totalBytes
            };
          });

          activeDownloads.forEach((download) => {
            if (!download?.filename) return;
            next[download.filename] = {
              ...(next[download.filename] || {}),
              status: 'downloading',
              percent: download.progress ?? next[download.filename]?.percent ?? 0,
              downloadedBytes: download.downloadedBytes,
              totalBytes: download.totalBytes
            };
          });

          return next;
        });

        const selectedMissing = Object.values(selectedModels)
          .filter(Boolean)
          .filter((name) => !latestAvailableSet.has(name));
        const requiredMissing = [selectedModels.embedding, selectedModels.text]
          .filter(Boolean)
          .filter((name) => !latestAvailableSet.has(name));

        if (selectedMissing.length === 0 && activeDownloads.length === 0) {
          const applied = await applySelectedProfileConfig();
          if (!cancelled && isMountedRef.current && applied) {
            setStep('complete');
          } else if (!cancelled && isMountedRef.current && !applied) {
            setStep('select');
          }
          return;
        }

        if (
          requiredMissing.length > 0 &&
          hasReliableDownloadStatus &&
          activeDownloads.length === 0
        ) {
          setInitError(
            (prev) => prev || 'Required model downloads stopped. Please retry downloads.'
          );
          setStep('select');
        }
      } catch {
        // Best-effort sync only; keep existing state if polling fails.
      }
    }

    void syncDownloadState();
    const timer = setInterval(() => {
      void syncDownloadState();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [step, selectedModels, applySelectedProfileConfig]);

  async function startDownloads() {
    // Synchronous double-trigger guard. Even with `disabled` on the button
    // the React re-render to reflect `isRefreshing=true` / `step='downloading'`
    // is deferred; a user who clicks twice in quick succession would land
    // here twice and kick off two parallel download passes. The ref flips
    // before the first await so a second invocation exits immediately.
    if (startDownloadsInFlightRef.current) {
      return;
    }
    startDownloadsInFlightRef.current = true;
    try {
      await runStartDownloads();
    } finally {
      startDownloadsInFlightRef.current = false;
    }
  }

  async function runStartDownloads() {
    const modelsToDownload = Object.values(selectedModels)
      .filter(Boolean)
      .filter((modelName) => !availableSet.has(modelName));

    if (modelsToDownload.length === 0) {
      const applied = await applySelectedProfileConfig();
      if (applied) {
        setStep('complete');
      }
      return;
    }

    if (!window?.electronAPI?.llama?.downloadModel) {
      setInitError('Download service unavailable. Try again once the app finishes loading.');
      return;
    }

    userInitiatedDownloadsRef.current = true;
    setStep('downloading');

    const nextAvailable = new Set(availableSet);
    for (const filename of modelsToDownload) {
      updateDownloadState(filename, { status: 'downloading', percent: 0, error: null });
      try {
        const result = await window.electronAPI.llama.downloadModel(filename);
        if (result?.success) {
          // downloadModel() acknowledges that a download has started; it does not
          // guarantee the model is installed yet. We only mark ready when the
          // model appears in getModels() or a completion event arrives.
          updateDownloadState(filename, { status: 'downloading' });
        } else {
          updateDownloadState(filename, {
            status: 'failed',
            error: result?.error || 'Download failed'
          });
        }
      } catch (error) {
        updateDownloadState(filename, {
          status: 'failed',
          error: error?.message || 'Download failed'
        });
      }
    }

    // Refresh availability from source-of-truth after requests complete.
    // This avoids treating "alreadyInProgress" downloads as fully installed.
    let activeDownloads = [];
    let hasReliableDownloadStatus = false;
    try {
      const [modelsResponse, downloadStatus] = await Promise.all([
        window.electronAPI.llama.getModels(),
        typeof window.electronAPI.llama.getDownloadStatus === 'function'
          ? window.electronAPI.llama.getDownloadStatus().catch((err) => {
              logger.debug('getDownloadStatus failed', { error: err?.message });
              return null;
            })
          : Promise.resolve(null)
      ]);

      const modelList = Array.isArray(modelsResponse)
        ? modelsResponse
        : Array.isArray(modelsResponse?.models)
          ? modelsResponse.models
          : [];
      const latestAvailable = modelList.map((m) => m.name || m.filename || m).filter(Boolean);

      latestAvailable.forEach((name) => nextAvailable.add(name));
      if (latestAvailable.length > 0) {
        setAvailableModels((prev) => Array.from(new Set([...(prev || []), ...latestAvailable])));
      }

      const downloads = downloadStatus?.status?.downloads;
      if (Array.isArray(downloads)) {
        hasReliableDownloadStatus = true;
        activeDownloads = downloads;
      }
      activeDownloads.forEach((download) => {
        if (!download?.filename) return;
        updateDownloadState(download.filename, {
          status: 'downloading',
          percent: download.progress ?? 0,
          downloadedBytes: download.downloadedBytes,
          totalBytes: download.totalBytes
        });
      });
    } catch {
      // Non-fatal: fallback to local state if status refresh fails.
    }

    const selectedMissing = Object.values(selectedModels)
      .filter(Boolean)
      .filter((name) => !nextAvailable.has(name));

    let configApplied = true;
    if (selectedMissing.length === 0) {
      configApplied = await applySelectedProfileConfig();
    }

    if (selectedMissing.length === 0 && configApplied) {
      setStep('complete');
    } else {
      setStep(
        hasReliableDownloadStatus
          ? activeDownloads.length > 0
            ? 'downloading'
            : 'select'
          : 'downloading'
      );
    }
  }

  function toggleModel(type, filename) {
    setSelectedModels((prev) => ({
      ...prev,
      [type]: prev[type] === filename ? null : filename
    }));
  }

  const getModelSize = (filename) => {
    return getModelTotalBytes(filename);
  };

  const getProfileSizeSummary = (profileKey) =>
    summarizeModelBytes(Object.values(PROFILE_MODELS[profileKey] || {}));

  const totalDownloadSummary = summarizeModelBytes(
    Object.values(selectedModels)
      .filter(Boolean)
      .filter((filename) => !availableSet.has(filename))
  );

  const requiredModelsMissing = [selectedModels.embedding, selectedModels.text]
    .filter(Boolean)
    .filter((name) => !availableSet.has(name));

  if (step === 'checking') {
    return (
      <WizardCard
        as="section"
        variant="hero"
        aria-labelledby="wizard-setup-title"
        className="text-center"
      >
        <div className="animate-loading-content" aria-busy="true">
          <SetupHeader
            step="checking"
            icon={Loader2}
            title="Preparing AI Setup"
            description="Detecting model availability and active downloads for your first run."
          />
          <Text variant="tiny" className="text-system-gray-500 mt-2">
            {CHECKING_STATUS_MESSAGES[checkingStatusIndex]}
          </Text>
          <Text variant="tiny" className="text-system-gray-500 mt-1">
            If this takes too long, you can continue now or open manual setup.
          </Text>
          {showCheckingEscape && (
            <div className="mt-4 flex flex-col sm:flex-row gap-cozy justify-center">
              <Button onClick={onSkip} variant="secondary">
                {CONTINUE_WITH_LIMITED_AI_LABEL}
              </Button>
              <Button
                onClick={() => {
                  setInitError(
                    'AI check is taking longer than expected. You can continue with manual setup or press Refresh.'
                  );
                  setStep('select');
                  setIsRefreshing(false);
                }}
                variant="primary"
              >
                Open manual setup
              </Button>
            </div>
          )}
        </div>
        {embeddingSwitchModal}
      </WizardCard>
    );
  }

  if (step === 'select') {
    return (
      <WizardCard as="section" variant="hero" aria-labelledby="wizard-setup-title" className="">
        <SetupHeader
          step="select"
          icon={Cpu}
          title="Choose AI Models"
          description="StratoSort runs AI locally. Download core models once, then keep using them offline."
        />

        {initError && (
          <AlertBox variant="warning" className="mb-6">
            <div className="space-y-1">
              <p className="font-medium">Setup not ready</p>
              <p>{initError}</p>
            </div>
          </AlertBox>
        )}

        {/* System Info */}
        <section
          aria-label="Your system"
          className="mb-4 rounded-xl border border-border-soft/80 bg-system-gray-50/90 p-3"
        >
          <dl className="grid grid-cols-1 gap-compact text-sm sm:grid-cols-2 sm:gap-x-6">
            <div className="flex items-center justify-between sm:block">
              <dt className="text-system-gray-500">GPU backend</dt>
              <dd className="mt-0 sm:mt-0.5 font-medium text-system-gray-900 uppercase">
                {systemInfo?.gpuBackend || 'CPU only'}
              </dd>
            </div>
            <div className="flex items-center justify-between sm:block min-w-0">
              <dt className="text-system-gray-500">Models folder</dt>
              <dd
                className="mt-0 sm:mt-0.5 font-mono text-xs text-system-gray-800 break-all sm:text-sm"
                title={systemInfo?.modelsPath || undefined}
              >
                {systemInfo?.modelsPath
                  ? truncateMiddle(systemInfo.modelsPath, 48)
                  : 'Default app storage'}
              </dd>
            </div>
          </dl>
        </section>

        <div className="mb-4">
          <Caption className="mb-2 text-system-gray-500">Install profile</Caption>
          <div className="grid grid-cols-1 gap-cozy sm:grid-cols-2">
            <SelectionCard
              selected={selectedProfile === 'base'}
              onSelect={() => {
                userPickedProfileRef.current = true;
                setSelectedProfile('base');
                setStartInAdvancedMode(false);
                setRecommendations(PROFILE_MODELS.base);
                setSelectedModels(PROFILE_MODELS.base);
              }}
              disabled={!hasApi || isRefreshing}
            >
              <Text className="font-medium">
                {INSTALL_MODEL_PROFILES?.BASE_SMALL?.label || 'Base (Small & Fast)'}
              </Text>
              {hardwareAdvice?.profile === 'base' && (
                <Text variant="tiny" className="mt-1 text-stratosort-blue">
                  Recommended for this computer
                </Text>
              )}
              <Text variant="small" className="mt-1">
                {INSTALL_MODEL_PROFILES?.BASE_SMALL?.description ||
                  'Runs on most machines with faster startup and smaller downloads.'}
              </Text>
              <Text variant="tiny" className="mt-2">
                Approx. download: {formatByteSummary(getProfileSizeSummary('base'))}
              </Text>
            </SelectionCard>
            <SelectionCard
              selected={selectedProfile === 'quality'}
              onSelect={() => {
                userPickedProfileRef.current = true;
                setSelectedProfile('quality');
                setStartInAdvancedMode(true);
                setRecommendations(PROFILE_MODELS.quality);
                setSelectedModels(PROFILE_MODELS.quality);
              }}
              disabled={!hasApi || isRefreshing}
            >
              <Text className="font-medium">
                {INSTALL_MODEL_PROFILES?.BETTER_QUALITY?.label || 'Better Quality (Larger)'}
              </Text>
              {hardwareAdvice?.profile === 'quality' && (
                <Text variant="tiny" className="mt-1 text-stratosort-blue">
                  Recommended for this computer
                </Text>
              )}
              <Text variant="small" className="mt-1">
                {INSTALL_MODEL_PROFILES?.BETTER_QUALITY?.description ||
                  'Higher quality output with larger models and larger downloads.'}
              </Text>
              <Text variant="tiny" className="mt-2">
                Approx. download: {formatByteSummary(getProfileSizeSummary('quality'))}
              </Text>
            </SelectionCard>
          </div>
          {hardwareAdvice?.reason && (
            <Text
              variant="tiny"
              className="mt-2 text-system-gray-600"
              data-testid="wizard-hardware-advice"
            >
              {hardwareAdvice.reason}
            </Text>
          )}
        </div>

        <div className="mb-4 rounded-xl border border-border-soft/80 bg-system-gray-50/90 p-3">
          <label className="flex cursor-pointer items-start gap-cozy text-left">
            {/* eslint-disable-next-line jsx-a11y/control-has-associated-label -- labelled by wrapping label at runtime; rule only inspects the control */}
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-border-soft text-stratosort-blue focus:ring-stratosort-blue"
              checked={startInAdvancedMode}
              onChange={(e) => setStartInAdvancedMode(e.target.checked)}
            />
            <span>
              <Text className="font-medium text-system-gray-900">Start in Advanced mode</Text>
              <Text variant="small" className="mt-0.5 text-system-gray-600">
                Enables on-device embeddings, semantic search, chat with your documents, and the
                knowledge graph. You can change this anytime in Settings.
              </Text>
            </span>
          </label>
        </div>

        {/* Model Selection */}
        <div className="mb-4 space-y-2" role="region" aria-label="Model choices">
          <ModelSelector
            type="embedding"
            label="Embedding model (required)"
            description="Converts text to vectors for search"
            selected={selectedModels.embedding}
            recommendations={recommendations}
            onChange={(f) => toggleModel('embedding', f)}
            status={downloadState[selectedModels.embedding]?.status}
            error={downloadState[selectedModels.embedding]?.error}
            disabled={!hasApi || isRefreshing}
            required
            getModelSize={getModelSize}
          />

          <ModelSelector
            type="text"
            label="Text analysis model (required)"
            description="Analyzes documents and generates descriptions"
            selected={selectedModels.text}
            recommendations={recommendations}
            onChange={(f) => toggleModel('text', f)}
            status={downloadState[selectedModels.text]?.status}
            error={downloadState[selectedModels.text]?.error}
            disabled={!hasApi || isRefreshing}
            required
            getModelSize={getModelSize}
          />

          <ModelSelector
            type="vision"
            label="Vision model (optional)"
            description="Analyzes images and screenshots"
            selected={selectedModels.vision}
            recommendations={recommendations}
            onChange={(f) => toggleModel('vision', f)}
            status={downloadState[selectedModels.vision]?.status}
            error={downloadState[selectedModels.vision]?.error}
            disabled={!hasApi || isRefreshing}
            optional
            getModelSize={getModelSize}
          />
        </div>

        {/* Download Summary */}
        <div className="mb-4 flex items-start gap-cozy rounded-xl border border-stratosort-blue/20 bg-gradient-to-br from-stratosort-blue/[0.06] to-transparent p-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-stratosort-blue/10 text-stratosort-blue ring-1 ring-stratosort-blue/15"
            aria-hidden
          >
            <HardDrive className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <Text className="font-medium text-system-gray-900 leading-tight">
              Estimated download
            </Text>
            <Text variant="small" className="mt-0.5 text-system-gray-700">
              {formatByteSummary(totalDownloadSummary, 'Download size unavailable')}
            </Text>
            <Text variant="tiny" className="mt-1 text-system-gray-500 leading-snug">
              One-time download. You can keep using the app while files transfer in the background.
            </Text>
          </div>
        </div>

        {requiredModelsMissing.length > 0 && (
          <AlertBox variant="warning" className="mb-4 py-2 px-3">
            Required models are missing. Download them to enable AI features.
          </AlertBox>
        )}

        <div className="flex flex-col sm:flex-row gap-compact sm:gap-cozy">
          <Button
            onClick={startDownloads}
            variant="primary"
            className="flex-1"
            disabled={!selectedModels.embedding || !selectedModels.text || !hasApi || isRefreshing}
          >
            <Download className="w-4 h-4" />
            Download models
          </Button>
          <Button onClick={checkSystem} variant="secondary" disabled={isRefreshing}>
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button onClick={onSkip} variant="secondary" className="sm:min-w-[140px]">
            {CONTINUE_WITH_LIMITED_AI_LABEL}
          </Button>
        </div>
        {embeddingSwitchModal}
      </WizardCard>
    );
  }

  if (step === 'downloading') {
    const models = Object.entries(selectedModels).filter(([_, v]) => v);
    // Simple check: if all active downloads are complete
    // In reality, you'd track each download's state from the event
    const allComplete = models.every(([_, filename]) => {
      const status = downloadState[filename]?.status;
      return status === 'ready' || status === 'complete';
    });
    const hasFailures = models.some(([_, filename]) => {
      const status = downloadState[filename]?.status;
      return status === 'failed' || status === 'cancelled';
    });

    return (
      <WizardCard as="section" variant="hero" aria-labelledby="wizard-setup-title" className="">
        <SetupHeader
          step="downloading"
          icon={Download}
          title="Downloading models"
          description="This can take a while depending on your connection. You can continue with limited AI at any time."
        />

        <div className="space-y-3">
          {models.map(([_type, filename]) => {
            const progress = downloadState[filename] || { percent: 0 };
            const status = progress.status || 'downloading';
            const downloadedBytes =
              typeof progress.downloadedBytes === 'number' ? progress.downloadedBytes : 0;
            const totalBytes = typeof progress.totalBytes === 'number' ? progress.totalBytes : 0;
            const clampedPercent =
              status === 'ready' || status === 'complete'
                ? 100
                : Math.max(0, Math.min(100, progress.percent || 0));
            const byteLabel =
              totalBytes > 0
                ? `${formatBytes(Math.min(downloadedBytes, totalBytes))} / ${formatBytes(totalBytes)}`
                : formatBytes(downloadedBytes);
            const displayLabel = getModel(filename)?.displayName || filename;
            return (
              <div
                key={filename}
                className="rounded-xl border border-border-soft bg-system-gray-50/50 p-3 sm:p-4 shadow-sm"
              >
                <div className="mb-2 flex items-center justify-between gap-compact">
                  <Text className="min-w-0 truncate font-medium leading-tight">{displayLabel}</Text>
                  <Text variant="small" className="shrink-0 tabular-nums">
                    {status === 'failed'
                      ? 'Failed'
                      : status === 'cancelled'
                        ? 'Cancelled'
                        : `${clampedPercent}%`}
                  </Text>
                </div>
                <div
                  className="mb-2 h-2 w-full overflow-hidden rounded-full bg-system-gray-200"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={clampedPercent}
                  aria-label={`Download progress for ${displayLabel}`}
                >
                  <div
                    className="h-2 rounded-full bg-stratosort-blue transition-[width] duration-300 ease-out"
                    style={{ width: `${clampedPercent}%` }}
                  />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-system-gray-500">
                  <span className="min-w-0">{byteLabel}</span>
                  <span className="tabular-nums">
                    {progress.speedBps
                      ? `${formatBytes(progress.speedBps)}/s`
                      : status === 'ready' || status === 'complete'
                        ? 'Complete'
                        : status === 'failed'
                          ? 'Download failed'
                          : status === 'cancelled'
                            ? 'Download cancelled'
                            : 'Starting…'}
                  </span>
                  <span className="tabular-nums">
                    {progress.etaSeconds ? `ETA ${formatDuration(progress.etaSeconds * 1000)}` : ''}
                  </span>
                </div>
                {progress.error && (
                  <Text variant="tiny" className="text-stratosort-danger mt-1.5">
                    {progress.error}
                  </Text>
                )}
                {(status === 'downloading' || status === 'starting') && (
                  <div className="mt-2 flex justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => handleCancelDownload(filename)}
                      aria-label={`Cancel download of ${displayLabel}`}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex flex-col sm:flex-row gap-compact sm:gap-cozy">
          <Button
            onClick={async () => {
              if (allComplete) {
                const applied = await applySelectedProfileConfig();
                if (applied) {
                  setStep('complete');
                }
              } else {
                onSkip();
              }
            }}
            variant={allComplete ? 'primary' : 'secondary'}
            className="w-full sm:flex-1"
          >
            {allComplete ? 'Continue' : CONTINUE_WITH_LIMITED_AI_LABEL}
          </Button>
          {hasFailures && (
            <Button onClick={startDownloads} variant="secondary" className="w-full sm:flex-1">
              Retry failed downloads
            </Button>
          )}
        </div>
        {embeddingSwitchModal}
      </WizardCard>
    );
  }

  return (
    <WizardCard
      as="section"
      variant="hero"
      aria-labelledby="wizard-setup-complete-title"
      className="text-center"
    >
      <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-stratosort-success/10 ring-1 ring-stratosort-success/20 mb-5">
        <CheckCircle className="w-8 h-8 text-stratosort-success" aria-hidden />
      </div>
      <Heading as="h2" variant="h3" id="wizard-setup-complete-title">
        Setup complete
      </Heading>
      <Text variant="small" className="text-system-gray-600 mt-2 mb-8 max-w-sm mx-auto">
        StratoSort is ready to organize your files with on-device AI.
      </Text>
      <Button onClick={onComplete} variant="primary" size="lg" className="min-w-[200px]">
        Get started
      </Button>
      {embeddingSwitchModal}
    </WizardCard>
  );
}

function WizardCard({ children, className = '', as: Component = 'div', ...props }) {
  const { embedded } = useContext(WizardLayoutContext);

  if (embedded) {
    // Host (e.g. the shared Modal) already provides the panel chrome, scrolling,
    // focus trap, and aria-modal. Render a bare semantic element so we don't
    // nest Cards or double-scroll.
    const { variant: _variant, ...rest } = props;
    const mergedClassName = ['w-full animate-loading-fade', className].filter(Boolean).join(' ');
    return (
      <Component className={mergedClassName} {...rest}>
        {children}
      </Component>
    );
  }

  return (
    <div className={getWizardFrameClassName()}>
      <Card as={Component} {...props} className={className}>
        <div className={getWizardScrollAreaClassName()}>{children}</div>
      </Card>
    </div>
  );
}

function WizardStepper({ activeStep }) {
  const currentIndex = Math.max(0, STEP_ORDER.indexOf(activeStep));

  return (
    <nav aria-label="Model setup steps" className="mb-4 sm:mb-5">
      <ol className="flex items-center justify-center gap-0 sm:gap-1">
        {STEP_ORDER.map((stepKey, index) => {
          const isComplete = index < currentIndex;
          const isCurrent = activeStep === stepKey;
          const label = STEP_TITLES[stepKey];
          return (
            <li key={stepKey} className="flex items-center">
              <div className="flex flex-col items-center min-w-0">
                <span
                  className={[
                    'flex h-8 w-8 sm:h-9 sm:w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors',
                    isComplete && 'bg-stratosort-success text-white shadow-sm',
                    isCurrent &&
                      !isComplete &&
                      'bg-stratosort-blue text-white shadow-md ring-2 ring-stratosort-blue/25 ring-offset-2 ring-offset-[var(--color-surface-primary)]',
                    !isComplete && !isCurrent && 'bg-system-gray-200 text-system-gray-500'
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-current={isCurrent ? 'step' : undefined}
                >
                  {isComplete ? (
                    <CheckCircle className="h-4 w-4" aria-hidden />
                  ) : (
                    <span aria-hidden>{index + 1}</span>
                  )}
                </span>
                <span
                  className={[
                    'mt-1.5 max-w-[4.5rem] text-center text-[10px] leading-tight sm:max-w-none sm:text-xs',
                    isCurrent ? 'font-medium text-stratosort-blue' : 'text-system-gray-500'
                  ].join(' ')}
                >
                  {label}
                </span>
              </div>
              {index < STEP_ORDER.length - 1 && (
                <div
                  className={[
                    'mx-0.5 h-0.5 w-3 shrink-0 rounded-full sm:mx-1 sm:w-10',
                    index < currentIndex ? 'bg-stratosort-success/80' : 'bg-system-gray-200'
                  ].join(' ')}
                  aria-hidden
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function SetupHeader({ step, icon: Icon, title, description }) {
  return (
    <header className="mb-4 text-center sm:mb-5">
      <WizardStepper activeStep={step} />
      <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-stratosort-blue/10 ring-1 ring-stratosort-blue/15 mb-3">
        <Icon
          className={`h-6 w-6 text-stratosort-blue ${step === 'checking' ? 'animate-spin' : ''}`}
          aria-hidden
        />
      </div>
      <Heading as="h2" variant="h3" id="wizard-setup-title" className="text-balance leading-tight">
        {title}
      </Heading>
      <Text
        variant="small"
        className="mx-auto mt-1.5 max-w-lg text-system-gray-600 text-balance leading-snug"
      >
        {description}
      </Text>
    </header>
  );
}

function ModelSelector({
  type,
  label,
  description,
  selected,
  recommendations,
  onChange,
  optional,
  required,
  getModelSize,
  status,
  error,
  disabled
}) {
  // Using passed recommendations to show options
  // In real app, might want a dropdown if there are multiple choices
  const filename = recommendations?.[type];
  if (!filename) return null;

  const modelInfo = getModel(filename);
  const displayName = modelInfo?.displayName || filename;
  const modelSize = getModelSize(filename);
  const isInstalled = status === 'ready' || status === 'complete';
  const statusLabel = isInstalled ? 'Installed' : status === 'failed' ? 'Failed' : 'Not installed';
  const statusClass = isInstalled
    ? 'bg-stratosort-success/10 text-stratosort-success'
    : status === 'failed'
      ? 'bg-stratosort-danger/10 text-stratosort-danger'
      : 'bg-system-gray-100 text-system-gray-700';

  const groupId = `model-group-${type}`;
  const labelId = `model-label-${type}`;

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className="rounded-xl border border-border-soft bg-system-gray-50/30 p-3 shadow-sm"
    >
      <div className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 text-left">
          <Text id={labelId} className="font-medium text-system-gray-900 leading-tight">
            {label}
          </Text>
          <Text variant="small" className="mt-0.5 text-system-gray-600 leading-snug">
            {description}
          </Text>
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-compact sm:pt-0.5">
          {required && (
            <Text
              as="span"
              variant="tiny"
              className="rounded-md bg-stratosort-blue/10 px-2 py-0.5 font-medium text-stratosort-blue"
            >
              Required
            </Text>
          )}
          {optional && (
            <Text
              as="span"
              variant="tiny"
              className="rounded-md bg-system-gray-100 px-2 py-0.5 text-system-gray-600"
            >
              Optional
            </Text>
          )}
          <Text
            as="span"
            variant="tiny"
            className={`rounded-md px-2 py-0.5 font-medium ${statusClass}`}
          >
            {statusLabel}
          </Text>
        </div>
      </div>

      <label
        className={`flex cursor-pointer items-center gap-cozy rounded-lg border p-2.5 transition focus-within:outline-none focus-within:ring-2 focus-within:ring-stratosort-blue/20 focus-within:ring-offset-2 focus-within:ring-offset-[var(--color-surface-primary)] ${
          selected === filename
            ? 'border-stratosort-blue bg-stratosort-blue/5'
            : 'border-border-soft hover:border-system-gray-300'
        } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
      >
        {/* eslint-disable-next-line jsx-a11y/control-has-associated-label -- labelled by wrapping label at runtime; rule only inspects the control */}
        <input
          type="checkbox"
          checked={selected === filename}
          onChange={() => onChange(filename)}
          disabled={disabled || required}
          className="h-4 w-4 shrink-0 rounded border-system-gray-300 text-stratosort-blue focus:ring-stratosort-blue"
          aria-describedby={`${groupId}-hint`}
        />
        <div className="flex-1">
          <div className="flex items-center gap-compact">
            <Text variant="small" className="font-medium">
              {displayName}
            </Text>
            <Text
              as="span"
              variant="tiny"
              className="bg-stratosort-success/10 text-stratosort-success px-2 py-0.5 rounded"
            >
              Recommended
            </Text>
          </div>
          <Text variant="tiny">
            {modelSize == null ? 'Size unavailable' : formatBytes(modelSize)}
          </Text>
          {error && (
            <Text variant="tiny" className="text-stratosort-danger mt-1">
              {error}
            </Text>
          )}
        </div>
      </label>
      <span id={`${groupId}-hint`} className="sr-only">
        {required
          ? 'This model is required for the selected profile.'
          : 'Toggle optional model for your setup.'}
      </span>
    </div>
  );
}
