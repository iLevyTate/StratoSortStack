import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  Brain,
  Cloud,
  CheckCircle2,
  ChevronsDown,
  ChevronsUp,
  CircleAlert,
  FolderOpen,
  History,
  Loader2,
  Monitor,
  Plug,
  Search,
  Settings as SettingsIcon,
  Wrench,
  X,
  Zap
} from 'lucide-react';
import { createLogger } from '../../shared/logger';
import { sanitizeSettings } from '../../shared/settingsValidation';
import { DEFAULT_AI_MODELS } from '../../shared/constants';
import { DEFAULT_SETTINGS } from '../../shared/defaultSettings';

/** AI provider config is persisted via ai-provider IPC, not the settings panel. */
function settingsWithoutAiBlob(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  const { ai: _ai, ...rest } = settings;
  return rest;
}
import {
  EXPERIENCE_MODES,
  isSimpleExperienceMode,
  applyExperienceModeSettings,
  carryAdvancedValuesAcrossModeSwitch
} from '../../shared/experienceMode';
import { DEBOUNCE } from '../../shared/performanceConstants';
import { matchSettingsSections } from '../../shared/settingsSearch';
import { stableStringify } from '../../shared/safeJsonOps';
import { useNotification } from '../contexts/NotificationContext';
import { getElectronAPI, eventsIpc, filesIpc, llamaIpc, settingsIpc } from '../services/ipc';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { closeSettings, clearSettingsScrollTarget, updateSettings } from '../store/slices/uiSlice';
import { useDebouncedCallback } from '../hooks/usePerformance';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import Collapsible from './ui/Collapsible';
import StatusBadge from './ui/StatusBadge';
import Spinner from './ui/Spinner';
import SettingsCard from './settings/SettingsCard';
import AnalysisHistoryModal from './AnalysisHistoryModal';
import { Heading, Text } from './ui/Typography';
import { Stack } from './layout';
import { lockAppScroll, unlockAppScroll } from '../utils/scrollLock';
import { isTopOverlay, registerOverlay, unregisterOverlay } from '../utils/overlayStack';
import { toErrorMessage } from '../utils/errorMapping';
import AutoOrganizeSection from './settings/AutoOrganizeSection';
import BackgroundModeSection from './settings/BackgroundModeSection';
import NotificationSettingsSection from './settings/NotificationSettingsSection';
import LlamaConfigSection from './settings/LlamaConfigSection';
import ModelSelectionSection from './settings/ModelSelectionSection';
import ChatPersonaSection from './settings/ChatPersonaSection';
import ModelManagementSection from './settings/ModelManagementSection';
import EmbeddingRebuildSection from './settings/EmbeddingRebuildSection';
import EmbeddingBehaviorSection from './settings/EmbeddingBehaviorSection';
import DefaultLocationsSection from './settings/DefaultLocationsSection';
import NamingSettingsSection from './settings/NamingSettingsSection';
import GraphRetrievalSection from './settings/GraphRetrievalSection';
import ExclusionRulesEditor from './settings/ExclusionRulesEditor';
import ProcessingLimitsSection from './settings/ProcessingLimitsSection';
import AboutSection from './settings/AboutSection';
import LicenseSection from './settings/LicenseSection';
import ApplicationSection from './settings/ApplicationSection';
import AppearanceSection from './settings/AppearanceSection';
import LegalNoticesSection from './settings/LegalNoticesSection';
import APITestSection from './settings/APITestSection';
import SettingsBackupSection from './settings/SettingsBackupSection';
import DebugToolsSection from './settings/DebugToolsSection';
import DiagnosticsLogsSection from './settings/DiagnosticsLogsSection';
import AIProviderSection from './settings/AIProviderSection';
import McpServerSection from './settings/McpServerSection';
import DiagnosticsSnapshotSection from './settings/DiagnosticsSnapshotSection';

const SETTINGS_OVERLAY_ID = 'settings-panel';

const SECTION_KEYS = [
  'settings-appearance',
  'settings-ai-provider',
  'settings-ai',
  'settings-performance',
  'settings-defaults',
  'settings-app',
  'settings-diagnostics',
  'settings-history'
];
const CLOSE_FLUSH_TIMEOUT_MS = 3000;
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])';

const logger = createLogger('SettingsPanel');
const isElectronAPIAvailable = () => {
  return getElectronAPI() != null;
};

/**
 * Canonical persisted-settings snapshot: exactly what autoSaveSettings sends
 * to settings:save (sanitized, `ai` blob stripped — AI provider config
 * persists via its own IPC). EVERY snapshot store/compare must use this one
 * shape: mixing ai-full and ai-free shapes left a permanently "dirty"
 * snapshot after Redux sync, firing a phantom no-op settings:save (+
 * settings-changed broadcast) on every Settings open.
 */
const computeSettingsSnapshot = (value) =>
  stableStringify(settingsWithoutAiBlob(sanitizeSettings(value || {})));

const EXPERIENCE_MODE_COPY = {
  [EXPERIENCE_MODES.SIMPLE]:
    'Focused on analyze, rename, and categorize without extra search complexity.',
  [EXPERIENCE_MODES.ADVANCED]:
    'Full control over local models, embeddings, retrieval, and diagnostics.'
};

/**
 * Format a "saved <relative>" string without registering a tick interval.
 * The chip re-renders whenever lastSavedAt updates (next save, next
 * keystroke that triggers auto-save), which is the relevant cadence; if a
 * user idles the panel for an hour the relative time will lag, but
 * accuracy at that scale is not the design goal.
 */
function formatSavedRelative(lastSavedAt, now) {
  if (!lastSavedAt) return '';
  const seconds = Math.max(0, Math.floor((now - lastSavedAt) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

const SettingsPanel = React.memo(function SettingsPanel() {
  const dispatch = useAppDispatch();
  const uiSettings = useAppSelector((state) => state.ui.settings);
  // Read showSettings so the initial-focus effect re-runs whenever the
  // overlay transitions open -> closed -> open without the component
  // itself fully unmounting. Today PhaseRenderer gates the panel on a
  // truthy `showSettings` (so it DOES remount), but relying on that as
  // an implicit contract was fragile: any future refactor that keeps
  // SettingsPanel mounted (animation hold, keep-alive, etc.) would
  // silently lose keyboard focus on re-open. Making the effect
  // explicitly depend on `showSettings` fixes that for both cases.
  const showSettings = useAppSelector((state) => state.ui.showSettings);
  const settingsScrollTargetId = useAppSelector((state) => state.ui.settingsScrollTargetId);
  const { addNotification } = useNotification();
  const isApiAvailable = isElectronAPIAvailable();
  const isDevBuild = process.env.NODE_ENV === 'development';
  const overlayId = SETTINGS_OVERLAY_ID;

  const saveFlushRef = useRef(null);
  const skipCloseFlushRef = useRef(false);
  const panelRef = useRef(null);
  const previousFocusRef = useRef(null);
  const focusTimerRef = useRef(null);

  const flushPendingAutoSave = useCallback(async () => {
    const flush = saveFlushRef.current;
    if (typeof flush !== 'function') return true;
    let timeoutId = null;
    try {
      const timeoutPromise = new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(false), CLOSE_FLUSH_TIMEOUT_MS);
      });
      const flushPromise = Promise.resolve(flush()).then(() => true);
      const completedInTime = await Promise.race([flushPromise, timeoutPromise]);
      if (!completedInTime) {
        logger.warn('Settings auto-save flush timed out before close');
      }
      return Boolean(completedInTime);
    } catch (error) {
      logger.warn('Settings auto-save flush failed before close', {
        error: error?.message
      });
      return false;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }, []);

  const closeSettingsPanel = useCallback(async () => {
    if (skipCloseFlushRef.current) {
      skipCloseFlushRef.current = false;
    } else {
      await flushPendingAutoSave();
    }
    dispatch(closeSettings());
  }, [dispatch, flushPendingAutoSave]);

  // Flush (not just cancel) any pending auto-save when the panel unmounts.
  // This effect is intentionally declared BEFORE the useDebouncedCallback
  // call below: React runs unmount cleanups in declaration order, so this
  // flush fires while the debounced invocation is still pending — the hook's
  // own cleanup cancels it right after. It covers unmount paths that bypass
  // closeSettingsPanel entirely (Ctrl+K search swap dispatching closeSettings
  // directly, resetUi, error boundaries).
  useEffect(() => {
    return () => {
      const flush = saveFlushRef.current;
      if (typeof flush === 'function') {
        Promise.resolve(flush()).catch((error) => {
          logger.warn('Failed to flush settings auto-save during unmount', {
            error: error?.message
          });
        });
      }
    };
  }, []);

  useEffect(() => {
    registerOverlay(overlayId);

    return () => {
      unregisterOverlay(overlayId);
    };
  }, [overlayId]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && isTopOverlay(overlayId)) {
        event.preventDefault();
        void closeSettingsPanel();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeSettingsPanel, overlayId]);

  useEffect(() => {
    const handleCloseRequest = () => {
      if (isTopOverlay(overlayId)) {
        void closeSettingsPanel();
      }
    };

    window.addEventListener('app:close-settings-request', handleCloseRequest);
    return () => {
      window.removeEventListener('app:close-settings-request', handleCloseRequest);
    };
  }, [closeSettingsPanel, overlayId]);

  useEffect(() => {
    if (!settingsScrollTargetId || !showSettings) return undefined;
    // Deep links can target a collapsed section (e.g. 'settings-app' for
    // the license form). Expand it first using the same
    // localStorage + synthetic storage-event broadcast that expand-all uses,
    // so the content is actually visible when we scroll to it.
    if (SECTION_KEYS.includes(settingsScrollTargetId)) {
      try {
        localStorage.setItem(`collapsible:${settingsScrollTargetId}`, 'true');
        window.dispatchEvent(new Event('storage'));
      } catch {
        // Non-fatal if localStorage is unavailable
      }
    }
    const timer = setTimeout(() => {
      const el = document.getElementById(settingsScrollTargetId);
      if (el) {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
      dispatch(clearSettingsScrollTarget());
    }, 100);
    return () => clearTimeout(timer);
  }, [settingsScrollTargetId, showSettings, dispatch]);

  useEffect(() => {
    if (!showSettings) return undefined;

    previousFocusRef.current = document.activeElement;
    focusTimerRef.current = setTimeout(() => {
      const root = panelRef.current;
      if (!root) return;

      const focusable = root.querySelectorAll(FOCUSABLE_SELECTOR);
      if (focusable.length > 0) {
        focusable[0].focus();
      } else {
        root.focus();
      }
    }, 50);

    return () => {
      if (focusTimerRef.current) {
        clearTimeout(focusTimerRef.current);
        focusTimerRef.current = null;
      }
      // Same guards as Modal.jsx's focus restore: only restore when nothing
      // else has claimed focus (the Ctrl+K settings→Knowledge OS swap mounts
      // the modal that should win) and the opener node is still mounted —
      // restoring to a detached node silently drops focus to <body>.
      const active = document.activeElement;
      const focusUnclaimed =
        !active || active === document.body || active === document.documentElement;
      const previous = previousFocusRef.current;
      if (
        focusUnclaimed &&
        previous &&
        typeof previous.focus === 'function' &&
        previous.isConnected !== false
      ) {
        try {
          previous.focus();
        } catch {
          document.body?.focus?.();
        }
      }
    };
  }, [showSettings]);

  useEffect(() => {
    const handleTabKey = (event) => {
      if (event.key !== 'Tab' || !isTopOverlay(overlayId)) return;

      const root = panelRef.current;
      if (!root) return;

      const focusable = Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const activeInside = root.contains(active);

      if (event.shiftKey) {
        if (!activeInside || active === first || active === root) {
          event.preventDefault();
          last.focus();
        }
      } else if (!activeInside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleTabKey);
    return () => {
      document.removeEventListener('keydown', handleTabKey);
    };
  }, [overlayId]);

  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [modelLists, setModelLists] = useState({
    text: [],
    vision: [],
    embedding: [],
    all: []
  });
  const [llamaHealth, setLlamaHealth] = useState(null);
  const [isRefreshingModels, setIsRefreshingModels] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [lastSaveError, setLastSaveError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [isHydrating, setIsHydrating] = useState(true);
  const [newModel, setNewModel] = useState('');
  const [isAddingModel, setIsAddingModel] = useState(false);
  const [pullProgress, setPullProgress] = useState(null);
  const progressUnsubRef = useRef(null);
  const pullProgressTimeoutRef = useRef(null);

  useEffect(() => {
    return () => {
      if (progressUnsubRef.current) {
        try {
          progressUnsubRef.current();
        } catch {
          // Non-fatal if cleanup fails
        }
        progressUnsubRef.current = null;
      }
      if (pullProgressTimeoutRef.current) {
        clearTimeout(pullProgressTimeoutRef.current);
        pullProgressTimeoutRef.current = null;
      }
    };
  }, []);

  const [showAllModels, setShowAllModels] = useState(false);
  const [showAnalysisHistory, setShowAnalysisHistory] = useState(false);
  const [analysisStats, setAnalysisStats] = useState(null);
  const [pendingExternalSettings, setPendingExternalSettings] = useState(null);
  const didAutoHealthCheckRef = useRef(false);
  const skipAutoSaveRef = useRef(0);
  const cancelAutoSaveRef = useRef(null);
  const settingsRef = useRef(null);
  const settingsLoadedRef = useRef(false);
  const modelLoadRequestRef = useRef(0);
  const lastSavedSnapshotRef = useRef(computeSettingsSnapshot(DEFAULT_SETTINGS));
  const pendingExternalSnapshotRef = useRef(null);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const experienceMode = settings?.experienceMode || EXPERIENCE_MODES.SIMPLE;
  const isSimpleMode = isSimpleExperienceMode(settings);
  const isAdvancedMode = !isSimpleMode;

  const applySettingsUpdate = useCallback(
    (updater) => {
      setSettings((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        settingsRef.current = next;
        return next;
      });
    },
    [setSettings]
  );

  const setExperienceMode = useCallback(
    (nextMode) => {
      // Mirror what the main process does on save (park or restore the
      // Advanced-only choices, then `applyExperienceModeSettings`) so the UI
      // reflects enforced/restored values immediately. Without this, toggling
      // Simple ↔ Advanced shows no visible change to the embedding/graph/chunk
      // fields until the user saves and the panel reloads.
      applySettingsUpdate((prev) =>
        applyExperienceModeSettings(
          carryAdvancedValuesAcrossModeSwitch(prev, { ...prev, experienceMode: nextMode })
        )
      );
    },
    [applySettingsUpdate]
  );

  const updateLastSavedSnapshot = useCallback((nextSettings) => {
    lastSavedSnapshotRef.current = computeSettingsSnapshot(nextSettings);
  }, []);

  const hasUnsavedSettingsChanges = useCallback(() => {
    return computeSettingsSnapshot(settingsRef.current) !== lastSavedSnapshotRef.current;
  }, []);

  useEffect(() => {
    settingsLoadedRef.current = settingsLoaded;
  }, [settingsLoaded]);

  const textModelOptions = useMemo(
    () => (modelLists.text.length ? modelLists.text : modelLists.all),
    [modelLists.text, modelLists.all]
  );

  const visionModelOptions = useMemo(() => modelLists.vision, [modelLists.vision]);

  const embeddingModelOptions = useMemo(() => modelLists.embedding, [modelLists.embedding]);

  const modelList = useMemo(() => {
    const typeLookup = new Map();
    (modelLists.text || []).forEach((name) => typeLookup.set(name, 'text'));
    (modelLists.vision || []).forEach((name) => typeLookup.set(name, 'vision'));
    (modelLists.embedding || []).forEach((name) => typeLookup.set(name, 'embedding'));
    const sizeLookup = new Map(
      (modelLists.details || []).map((detail) => [detail.name, detail.sizeMB])
    );
    return (modelLists.all || []).map((name) => ({
      name,
      type: typeLookup.get(name) || 'text',
      sizeMB: sizeLookup.get(name) ?? null
    }));
  }, [
    modelLists.all,
    modelLists.details,
    modelLists.embedding,
    modelLists.text,
    modelLists.vision
  ]);

  const loadSettings = useCallback(async () => {
    // If hydration outlives the 10s timeout, the panel unblocks and the user
    // can start editing the DEFAULT_SETTINGS form. Capture the pre-fetch form
    // state so the late-arriving persisted settings don't clobber those
    // in-flight edits — any key that changed while we awaited is overlaid
    // back on top of the fetched values (and then auto-saved).
    const preloadForm = { ...(settingsRef.current || DEFAULT_SETTINGS) };
    try {
      if (settingsLoadedRef.current) return;
      // Always fetch authoritative settings from main-process persistence.
      // Relying on cached Redux ui.settings can replay stale/default values and
      // accidentally overwrite user-selected locations during auto-save.
      const savedSettings = await settingsIpc.get();
      const mergedSettings = {
        ...DEFAULT_SETTINGS,
        ...settingsWithoutAiBlob(savedSettings || {})
      };
      const defaultLocation =
        typeof mergedSettings.defaultSmartFolderLocation === 'string'
          ? mergedSettings.defaultSmartFolderLocation.trim()
          : '';
      const shouldResolveDocumentsLocation =
        !defaultLocation || defaultLocation.toLowerCase() === 'documents';
      if (shouldResolveDocumentsLocation) {
        try {
          const documentsPathResponse = await filesIpc.getDocumentsPath();
          const documentsPath =
            typeof documentsPathResponse === 'string'
              ? documentsPathResponse
              : documentsPathResponse?.path;
          if (typeof documentsPath === 'string' && documentsPath.trim()) {
            mergedSettings.defaultSmartFolderLocation = documentsPath.trim();
          }
        } catch {
          // Keep the existing fallback value if documents path lookup fails.
        }
      }
      const currentForm = settingsRef.current || preloadForm;
      const editedKeys = Object.keys(currentForm).filter(
        (key) => !Object.is(currentForm[key], preloadForm[key])
      );
      if (editedKeys.length > 0) {
        // Overlay the user's mid-hydration edits on the fetched settings and
        // let the auto-save effect persist them (no skip token). The saved
        // snapshot below deliberately stays at the on-disk state so these
        // edits still count as unsaved.
        const formWithEdits = { ...mergedSettings };
        for (const key of editedKeys) {
          formWithEdits[key] = currentForm[key];
        }
        applySettingsUpdate(formWithEdits);
      } else {
        skipAutoSaveRef.current += 1;
        applySettingsUpdate(mergedSettings);
      }
      dispatch(updateSettings(mergedSettings));
      updateLastSavedSnapshot(mergedSettings);
      setSettingsLoaded(true);
      settingsLoadedRef.current = true;
    } catch (error) {
      logger.error('Failed to load settings', {
        error: error.message,
        stack: error.stack
      });
      skipAutoSaveRef.current += 1;
      applySettingsUpdate({ ...DEFAULT_SETTINGS });
      dispatch(updateSettings({ ...DEFAULT_SETTINGS }));
      updateLastSavedSnapshot(DEFAULT_SETTINGS);
      setSettingsLoaded(true);
      settingsLoadedRef.current = true;
    }
  }, [applySettingsUpdate, dispatch, updateLastSavedSnapshot]);

  const loadModels = useCallback(async () => {
    const requestId = modelLoadRequestRef.current + 1;
    modelLoadRequestRef.current = requestId;

    try {
      setIsRefreshingModels(true);
      const response = await llamaIpc.getModels();
      if (modelLoadRequestRef.current !== requestId) {
        return;
      }
      const categories = response?.categories || {
        text: [],
        vision: [],
        embedding: []
      };

      const installedModels = response?.models || [];

      setModelLists({
        text: (categories.text || []).slice().sort(),
        vision: (categories.vision || []).slice().sort(),
        embedding: (categories.embedding || []).slice().sort(),
        all: installedModels.slice().sort(),
        // Per-model {name, type, sizeMB} metadata; drives real size labels
        // (and the delete-confirm's freed-space message) in the model list.
        details: Array.isArray(response?.modelDetails) ? response.modelDetails : []
      });
      if (response?.llamaHealth) setLlamaHealth(response.llamaHealth);
      if (response?.requiresModelConfirmation) {
        addNotification(
          'Some saved AI model names are outdated. Review and confirm model selections in Settings.',
          'warning',
          6000,
          'model-corrections'
        );
      }
      // Important: model discovery should never mutate persisted user choices.
      // Returning "selected" from getModels is useful for diagnostics/UI hints,
      // but applying it here can silently overwrite user-configured models
      // with fallback/default selections and then persist them on next save.
    } catch (error) {
      if (modelLoadRequestRef.current !== requestId) {
        return;
      }
      logger.error('Failed to load AI models', {
        error: error.message,
        stack: error.stack
      });
      setModelLists({ text: [], vision: [], embedding: [], all: [] });
      addNotification('Failed to load AI models. Check model downloads.', 'warning');
    } finally {
      if (modelLoadRequestRef.current === requestId) {
        setIsRefreshingModels(false);
      }
    }
  }, [addNotification]);

  useEffect(() => {
    if (!isApiAvailable) return undefined;

    let mounted = true;
    setIsHydrating(true);

    const HYDRATION_TIMEOUT_MS = DEBOUNCE.SETTINGS_HYDRATION;

    const loadSettingsIfMounted = async () => {
      if (mounted) {
        await loadSettings();
      }
    };

    const loadModelsIfMounted = async () => {
      if (mounted) {
        await loadModels();
      }
    };

    // Timeout to ensure hydration doesn't block forever
    const timeoutId = setTimeout(() => {
      if (mounted) {
        logger.warn('Settings hydration timed out after 10s, continuing anyway');
        setIsHydrating(false);
      }
    }, HYDRATION_TIMEOUT_MS);

    (async () => {
      try {
        await loadSettingsIfMounted();
      } catch (error) {
        logger.error('Settings hydration failed', { error: error.message });
      } finally {
        // Unblock the panel as soon as persisted settings hydrate. Model
        // discovery (llamaIpc.getModels) can cold-touch LlamaService and take
        // many seconds on constrained hardware; it must NOT hold the whole
        // panel hostage. It continues in the background below with its own
        // scoped spinner (isRefreshingModels) on the model dropdowns.
        clearTimeout(timeoutId);
        if (mounted) {
          setIsHydrating(false);
        }
      }

      try {
        await loadModelsIfMounted();
      } catch (error) {
        logger.error('Background model load failed', { error: error.message });
      }
    })();

    return () => {
      mounted = false;
      clearTimeout(timeoutId);
    };
  }, [isApiAvailable, loadSettings, loadModels]);

  useEffect(() => {
    if (!settingsLoaded) return;
    if (!uiSettings || typeof uiSettings !== 'object') return;
    const mergedSettings = {
      ...DEFAULT_SETTINGS,
      ...(uiSettings || {})
    };
    const mergedSnapshot = computeSettingsSnapshot(mergedSettings);
    const currentSnapshot = computeSettingsSnapshot(settingsRef.current);
    if (mergedSnapshot === currentSnapshot) {
      updateLastSavedSnapshot(mergedSettings);
      pendingExternalSnapshotRef.current = null;
      setPendingExternalSettings(null);
      return;
    }
    if (hasUnsavedSettingsChanges()) {
      if (mergedSnapshot === lastSavedSnapshotRef.current) {
        // Redux echo of our own last save arriving while the user kept
        // editing — not an external change. The in-flight edits will be
        // picked up by the next auto-save tick.
        return;
      }
      if (pendingExternalSnapshotRef.current !== mergedSnapshot) {
        // Freeze the pending debounced save so it can't clobber the external
        // change on disk while the user decides which version to keep.
        cancelAutoSaveRef.current?.();
        pendingExternalSnapshotRef.current = mergedSnapshot;
        setPendingExternalSettings(mergedSettings);
        addNotification(
          'Settings changed externally while you have unsaved edits. Choose which version to keep.',
          'warning',
          5000,
          'settings-conflict'
        );
      }
      return;
    }
    skipAutoSaveRef.current += 1;
    applySettingsUpdate(mergedSettings);
    updateLastSavedSnapshot(mergedSettings);
    pendingExternalSnapshotRef.current = null;
    setPendingExternalSettings(null);
  }, [
    addNotification,
    applySettingsUpdate,
    hasUnsavedSettingsChanges,
    settingsLoaded,
    uiSettings,
    updateLastSavedSnapshot
  ]);

  const navLlamaHealth = useAppSelector((s) => s.system?.health?.llama);
  const lastSaveWarningsRef = useRef('');

  useEffect(() => {
    if (!isApiAvailable) return undefined;
    if (!settingsLoaded) return undefined;
    if (settingsRef.current === null) return undefined;
    if (didAutoHealthCheckRef.current) return undefined;
    didAutoHealthCheckRef.current = true;

    let isMounted = true;

    (async () => {
      try {
        // NavigationBar already probes llama:test-connection on boot; skip the
        // duplicate IPC when we already know the engine is online.
        if (navLlamaHealth === 'online' || navLlamaHealth === 'degraded') {
          if (isMounted) await loadModels();
          return;
        }

        const res = await llamaIpc.testConnection();
        if (!isMounted) return;
        setLlamaHealth(res?.llamaHealth || null);
        if (res?.success && isMounted) {
          await loadModels();
        }
      } catch (e) {
        const message = e?.message || '';
        const isInFlight =
          message.includes('Operation already in progress') &&
          message.includes('llama:test-connection');
        if (isInFlight) {
          logger.debug('Auto AI health check skipped: another test-connection is already running', {
            error: message
          });
          if (isMounted) await loadModels();
        } else {
          logger.error('Auto AI health check failed', {
            error: message
          });
          // Release the once-per-mount latch so a later dependency change
          // (e.g. the nav health probe flipping to online) retries instead of
          // leaving health/models permanently unloaded for this session.
          didAutoHealthCheckRef.current = false;
        }
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [isApiAvailable, settingsLoaded, loadModels, navLlamaHealth]);

  useEffect(() => {
    lockAppScroll('settings-panel');

    return () => {
      unlockAppScroll('settings-panel');
    };
  }, []);

  const applyExternalSettingsSnapshot = useCallback(() => {
    if (!pendingExternalSettings || typeof pendingExternalSettings !== 'object') {
      return;
    }
    // Drop any debounced save still holding the pre-conflict local edits so
    // it can't fire after we adopt the external version.
    cancelAutoSaveRef.current?.();
    skipAutoSaveRef.current += 1;
    applySettingsUpdate(pendingExternalSettings);
    dispatch(updateSettings(pendingExternalSettings));
    updateLastSavedSnapshot(pendingExternalSettings);
    pendingExternalSnapshotRef.current = null;
    setPendingExternalSettings(null);
    addNotification(
      'Loaded external settings changes.',
      'info',
      3500,
      'settings-conflict-resolved'
    );
  }, [
    addNotification,
    applySettingsUpdate,
    dispatch,
    pendingExternalSettings,
    updateLastSavedSnapshot
  ]);

  const autoSaveSettings = useDebouncedCallback(async () => {
    const currentSettings = settingsRef.current;
    if (!currentSettings) return;

    try {
      setIsSaving(true);
      const normalizedSettings = sanitizeSettings({
        ...currentSettings
      });
      const toSave = settingsWithoutAiBlob(normalizedSettings);
      const nextSnapshot = stableStringify(toSave);
      if (nextSnapshot === lastSavedSnapshotRef.current) {
        setIsSaving(false);
        return;
      }
      const res = await settingsIpc.save(toSave);
      if (res?.success === false) {
        logger.error('Auto-save settings rejected by backend', {
          error: res?.error,
          validationErrors: res?.validationErrors
        });
        const errMessage = res?.error || 'rejected by backend';
        setLastSaveError(errMessage);
        // Surface a deduplicated toast so the user isn't stuck thinking the
        // change saved. Auto-save fires every 800ms, so the dedupe key
        // ensures rapid edits collapse to a single toast that updates in place.
        addNotification(
          `Couldn't save settings: ${errMessage}`,
          'error',
          6000,
          'settings-auto-save-error'
        );
        return;
      }
      const savedSettings = res?.settings || normalizedSettings;
      dispatch(updateSettings(savedSettings));
      updateLastSavedSnapshot(savedSettings);
      setLastSavedAt(Date.now());
      setLastSaveError(null);
      // The backend may accept a save with reservations (a clamped value, a
      // model it could not apply). They were logged in main and never shown;
      // one toast per distinct set, updated in place.
      const warnings = Array.isArray(res?.validationWarnings)
        ? res.validationWarnings.filter(Boolean).map(String)
        : [];
      const warningKey = warnings.join('\n');
      if (warningKey && warningKey !== lastSaveWarningsRef.current) {
        addNotification(
          warnings.length === 1
            ? `Saved with a warning: ${warnings[0]}`
            : `Saved with ${warnings.length} warnings: ${warnings[0]}`,
          'warning',
          8000,
          'settings-save-warning'
        );
      }
      lastSaveWarningsRef.current = warningKey;

      // The backend may adjust values during save (model downgrade, merge
      // with on-disk state, coercion). If the user hasn't edited since this
      // save was issued, sync the form to the persisted reality — otherwise
      // the panel keeps showing values that never actually stuck. The ai
      // blob is excluded from save payloads, so keep the local copy.
      const savedSnapshot = computeSettingsSnapshot(savedSettings);
      if (
        savedSnapshot !== nextSnapshot &&
        computeSettingsSnapshot(settingsRef.current) === nextSnapshot
      ) {
        skipAutoSaveRef.current += 1;
        applySettingsUpdate((prev) => ({
          ...prev,
          ...settingsWithoutAiBlob(savedSettings)
        }));
      }

      if (res?.modelUpdate?.modelDowngraded) {
        logger.warn('Model selection was adjusted by the backend', res.modelUpdate);
        addNotification(
          'One or more model selections were adjusted. Check AI model settings.',
          'warning',
          5000,
          'model-downgrade'
        );
      }
    } catch (error) {
      const validationErrors = Array.isArray(error?.details?.validationErrors)
        ? error.details.validationErrors
        : [];
      const baseMessage =
        error?.details?.error ||
        (typeof error?.message === 'string' ? error.message : 'unknown error');
      const detailMessage =
        validationErrors.length > 0
          ? `${baseMessage}: ${validationErrors.join('; ')}`
          : baseMessage;
      logger.error('Auto-save settings failed', {
        error: error.message,
        stack: error.stack,
        validationErrors,
        details: error?.details
      });
      setLastSaveError(detailMessage);
      addNotification(
        `Couldn't save settings: ${detailMessage}`,
        'error',
        6000,
        'settings-auto-save-error'
      );
    } finally {
      setIsSaving(false);
    }
  }, 800);

  const retryAutoSave = useCallback(() => {
    setLastSaveError(null);
    autoSaveSettings();
  }, [autoSaveSettings]);

  const keepLocalSettingsSnapshot = useCallback(() => {
    pendingExternalSnapshotRef.current = null;
    setPendingExternalSettings(null);
    // Re-assert the local edits over the external change on disk. The
    // conflict detection cancelled the pending auto-save, so without this
    // the local version would only persist if the user made another edit.
    autoSaveSettings();
    addNotification('Kept local unsaved edits.', 'info', 3500, 'settings-keep-local');
  }, [addNotification, autoSaveSettings]);

  useEffect(() => {
    cancelAutoSaveRef.current = autoSaveSettings?.cancel || null;
    saveFlushRef.current = autoSaveSettings?.flush || null;
  }, [autoSaveSettings]);

  useEffect(() => {
    if (!isApiAvailable || !settingsLoaded || settings === null) {
      return;
    }
    if (skipAutoSaveRef.current > 0) {
      // Reset to 0 (not decrement) because React 18+ batching can merge multiple
      // programmatic setSettings calls into one render, so only one effect fires
      // but multiple skip tokens may have been issued. Zeroing ensures auto-save
      // resumes after the first batched programmatic update completes.
      skipAutoSaveRef.current = 0;
      return;
    }
    if (pendingExternalSnapshotRef.current !== null) {
      // External-change conflict card is open. Conflict detection cancelled
      // the pending debounced save, but any further keystroke re-lands here —
      // scheduling a new save would clobber the external change on disk while
      // the user is still deciding which version to keep. Freeze auto-save;
      // "Keep my edits" re-triggers it and "Load external" uses a skip token.
      return;
    }
    autoSaveSettings();
  }, [isApiAvailable, settings, settingsLoaded, autoSaveSettings]);

  const addModel = useCallback(
    async (explicitName) => {
      // Catalog rows pass an explicit filename; the manual field falls back to
      // `newModel` state. Guard against the click event object being forwarded.
      const requested = (typeof explicitName === 'string' ? explicitName : newModel).trim();
      if (!requested) return;

      // The backend dispatches `downloadModel` in the background and resolves
      // immediately with {success: true, started: true}; the actual completion
      // arrives later as a `model-download-complete` event. Earlier code
      // mistook the IPC ack for completion — which (a) fired the success toast
      // before any bytes landed, (b) refreshed the model list while the file
      // was still missing, and (c) unsubscribed from progress after a 1500 ms
      // grace period, swallowing every chunk after that. Mirror the proven
      // event-driven flow used by downloadRecommendedModels.
      setIsAddingModel(true);

      // Reset any in-flight progress UI/subscription before starting a new one
      if (progressUnsubRef.current) {
        try {
          progressUnsubRef.current();
        } catch {
          // Non-fatal
        }
        progressUnsubRef.current = null;
      }
      if (pullProgressTimeoutRef.current) {
        clearTimeout(pullProgressTimeoutRef.current);
        pullProgressTimeoutRef.current = null;
      }
      setPullProgress(null);

      // Some backends report progress under the requested filename, others
      // (notably vision models with auto-companion downloads like mmproj) emit
      // under the companion's filename. Match on includes so we catch both.
      const matchesRequest = (evtModel) =>
        typeof evtModel === 'string' &&
        (evtModel === requested || evtModel.includes(requested) || requested.includes(evtModel));

      const finalize = () => {
        if (progressUnsubRef.current) {
          try {
            progressUnsubRef.current();
          } catch {
            // Non-fatal
          }
          progressUnsubRef.current = null;
        }
        setIsAddingModel(false);
        // Brief grace so the final 100% bar is visible before it disappears
        if (pullProgressTimeoutRef.current) {
          clearTimeout(pullProgressTimeoutRef.current);
        }
        pullProgressTimeoutRef.current = setTimeout(() => {
          setPullProgress(null);
          pullProgressTimeoutRef.current = null;
        }, 1500);
      };

      let progressSubscribed = false;
      try {
        progressUnsubRef.current = eventsIpc.onOperationProgress((evt) => {
          if (!evt || !matchesRequest(evt.model)) return;
          if (evt.type === 'model-download') {
            // Normalize to {modelName, percent} so LlamaConfigSection and
            // ModelManagementSection render the same shape.
            const percent = Number.isFinite(evt.progress?.percent) ? evt.progress.percent : 0;
            setPullProgress({
              modelName: requested,
              filename: evt.model,
              percent,
              downloadedBytes: evt.progress?.downloadedBytes,
              totalBytes: evt.progress?.totalBytes
            });
          } else if (evt.type === 'model-download-complete') {
            setPullProgress({ modelName: requested, filename: evt.model, percent: 100 });
            addNotification(`Model "${requested}" installed`, 'success');
            setNewModel('');
            // Refresh on completion — not on IPC ack — so the list reflects
            // the file actually being on disk.
            loadModels().catch(() => {
              // loadModels surfaces its own errors via addNotification
            });
            finalize();
          } else if (evt.type === 'model-download-error') {
            const errorMsg = evt.error || '';
            if (errorMsg.includes('not found') || errorMsg.includes('404')) {
              addNotification('Model not found. Check the model name in the registry.', 'error');
            } else if (errorMsg.includes('timeout')) {
              addNotification('Download timed out. Try again or check your connection.', 'error');
            } else {
              addNotification(
                `Could not install "${requested}": ${errorMsg || 'unknown error'}`,
                'error'
              );
            }
            finalize();
          }
        });
        progressSubscribed = true;
      } catch {
        // Non-fatal if progress subscription fails — fall through to IPC call
      }

      try {
        const res = await llamaIpc.downloadModel(requested);
        if (!res?.success) {
          const errorMsg = res?.error || '';
          if (errorMsg.includes('not found') || errorMsg.includes('404')) {
            addNotification('Model not found. Check the model name in the registry.', 'error');
          } else if (errorMsg.includes('timeout')) {
            addNotification('Download timed out. Try again or check your connection.', 'error');
          } else {
            addNotification('Could not install model. Check the name and try again.', 'error');
          }
          finalize();
        } else if (res?.alreadyInProgress) {
          // Background setup already started this download; the progress
          // events from that run will drive the same subscription.
          addNotification(`Model "${requested}" is already downloading`, 'info');
        } else if (!progressSubscribed) {
          // The download started but the progress subscription failed, so the
          // completion event will never reach us — without this the button
          // stays in its loading state forever. Reset the UI and tell the
          // user how to see the result.
          addNotification(
            `Download of "${requested}" started, but progress updates are unavailable. Refresh the model list in a few minutes.`,
            'info'
          );
          finalize();
        }
        // With an active subscription we deliberately do NOT finalize() here —
        // the download is still running. `model-download-complete` (or -error)
        // will arrive on the subscription above and finalize() then.
      } catch (error) {
        logger.error('Model installation failed', {
          error: error?.message || String(error)
        });
        addNotification('Model installation failed. Check your connection.', 'error');
        finalize();
      }
    },
    [newModel, addNotification, loadModels]
  );

  const downloadRecommendedModels = useCallback(async () => {
    // Use the user's configured models, falling back to system defaults.
    // This avoids downloading BASE_SMALL models when the user has selected
    // a BETTER_QUALITY profile.
    const modelsToDownload = [
      settings.textModel || DEFAULT_AI_MODELS.TEXT_ANALYSIS,
      settings.visionModel || DEFAULT_AI_MODELS.IMAGE_ANALYSIS,
      settings.embeddingModel || DEFAULT_AI_MODELS.EMBEDDING
    ].filter(Boolean);
    if (modelsToDownload.length === 0) return;

    try {
      setIsAddingModel(true);

      // Clean up any stale progress subscription before creating a new one
      if (progressUnsubRef.current) {
        try {
          progressUnsubRef.current();
        } catch {
          // Non-fatal
        }
        progressUnsubRef.current = null;
      }
      // Also clear addModel's "keep the 100% bar visible" grace timeout —
      // left running it would null out THIS run's progress 1.5s in.
      if (pullProgressTimeoutRef.current) {
        clearTimeout(pullProgressTimeoutRef.current);
        pullProgressTimeoutRef.current = null;
      }
      setPullProgress(null);

      // Track which models we're waiting on so we know when all are done
      const pendingModels = new Set(modelsToDownload);

      // When the last pending model resolves, tear the subscription down too.
      // Previously it stayed registered for the rest of the panel session.
      const finishAll = () => {
        if (progressUnsubRef.current) {
          try {
            progressUnsubRef.current();
          } catch {
            // Non-fatal
          }
          progressUnsubRef.current = null;
        }
        setPullProgress(null);
        setIsAddingModel(false);
      };

      // Subscribe to progress/completion/error events for ALL requested downloads
      progressUnsubRef.current = eventsIpc.onOperationProgress((evt) => {
        if (evt?.type === 'model-download' && pendingModels.has(evt.model)) {
          setPullProgress({
            modelName: evt.model,
            percent: evt.progress?.percent || 0
          });
        } else if (evt?.type === 'model-download-complete' && pendingModels.has(evt.model)) {
          pendingModels.delete(evt.model);
          addNotification(`Model "${evt.model}" downloaded successfully`, 'success');
          loadModels();
          if (pendingModels.size === 0) {
            finishAll();
          }
        } else if (evt?.type === 'model-download-error' && pendingModels.has(evt.model)) {
          pendingModels.delete(evt.model);
          addNotification(
            `Failed to download "${evt.model}": ${evt.error || 'unknown error'}`,
            'error'
          );
          if (pendingModels.size === 0) {
            finishAll();
          }
        }
      });

      // Kick off all downloads (handler returns immediately now)
      const errors = [];
      for (const modelName of modelsToDownload) {
        const res = await llamaIpc.downloadModel(modelName);
        if (res?.alreadyInProgress) {
          pendingModels.delete(modelName);
          continue;
        }
        if (!res?.success && !res?.started) {
          pendingModels.delete(modelName);
          errors.push(toErrorMessage(res?.error, `Failed to start ${modelName}`));
        }
      }

      if (errors.length > 0) {
        addNotification(`Some downloads failed to start: ${errors.join('; ')}`, 'warning');
      }

      // Show immediate feedback
      const startedCount = pendingModels.size;
      if (startedCount > 0) {
        addNotification(
          `Downloading ${startedCount} model${startedCount > 1 ? 's' : ''}… Progress is shown above.`,
          'info'
        );
      } else {
        // All were already in progress or failed to start — reset loading
        // state and drop the now-purposeless subscription.
        finishAll();
      }
    } catch (error) {
      addNotification(
        `Failed to download recommended models: ${error?.message || 'unknown error'}`,
        'error'
      );
      if (progressUnsubRef.current) {
        try {
          progressUnsubRef.current();
        } catch {
          // Non-fatal
        }
        progressUnsubRef.current = null;
      }
      setIsAddingModel(false);
    }
  }, [
    settings.textModel,
    settings.visionModel,
    settings.embeddingModel,
    addNotification,
    loadModels
  ]);

  const deleteModel = useCallback(
    async (modelName) => {
      if (!modelName) return;
      try {
        const res = await llamaIpc.deleteModel(modelName);
        if (!res?.success) {
          throw new Error(toErrorMessage(res?.error, 'Failed to delete model'));
        }
        addNotification(`Model "${modelName}" deleted`, 'success');
        await loadModels();
      } catch (error) {
        addNotification(`Failed to delete model: ${error?.message || 'unknown error'}`, 'error');
      }
    },
    [addNotification, loadModels]
  );

  // Per-key try/catch and an unconditional broadcast: if one setItem throws
  // (quota, privacy mode) mid-loop, the remaining sections should still be
  // written and the storage event must still fire, otherwise the persisted
  // state desyncs from what's on screen.
  const setAllSections = useCallback((open) => {
    for (const k of SECTION_KEYS) {
      try {
        localStorage.setItem(`collapsible:${k}`, String(open));
      } catch {
        // Non-fatal if localStorage fails
      }
    }
    window.dispatchEvent(new Event('storage'));
  }, []);

  const expandAll = useCallback(() => setAllSections(true), [setAllSections]);
  const collapseAll = useCallback(() => setAllSections(false), [setAllSections]);

  const showUnavailable = !isApiAvailable;

  // Pre-compute which sections match the search query so we can hide
  // non-matching ones from the rendered tree without unmounting them. We
  // use display:none rather than array filter so panels keep their state
  // (collapsed/expanded, scroll position, in-flight model downloads).
  const settingsSearchMatch = useMemo(() => matchSettingsSections(searchQuery), [searchQuery]);
  const matchedSectionIds = settingsSearchMatch.sectionIds;
  const revealAdvancedFromSearch =
    settingsSearchMatch.revealAdvanced && Boolean(searchQuery.trim());
  const effectiveAdvancedMode = isAdvancedMode || revealAdvancedFromSearch;

  const isSectionVisible = useCallback(
    (sectionId) => !matchedSectionIds || matchedSectionIds.has(sectionId),
    [matchedSectionIds]
  );

  // Expand matched collapsibles so nested cards (e.g. Chat persona) are visible.
  useEffect(() => {
    if (!matchedSectionIds || matchedSectionIds.size === 0) return undefined;
    try {
      matchedSectionIds.forEach((sectionId) => {
        localStorage.setItem(`collapsible:${sectionId}`, 'true');
      });
      window.dispatchEvent(new Event('storage'));
    } catch {
      // Non-fatal if localStorage is unavailable
    }
    return undefined;
  }, [matchedSectionIds]);

  // Save status chip — describes the save subsystem in 3 mutually-exclusive
  // states. `now` snapshot is taken at render time (no setInterval); the
  // displayed relative time refreshes whenever lastSavedAt advances or a
  // setting change forces a re-render.
  const saveStatusNow = Date.now();
  let saveStatusChip = null;
  if (lastSaveError) {
    saveStatusChip = (
      // Deliberately NOT StatusBadge: this chip is an interactive retry
      // <button> (hover + focus ring); StatusBadge renders a static span.
      // It hand-carries the same label recipe as StatusBadge appearance="label".
      <button
        type="button"
        onClick={retryAutoSave}
        className="inline-flex items-center gap-1.5 rounded-full border border-stratosort-danger/30 bg-stratosort-danger/10 px-2.5 py-1 text-micro font-semibold uppercase tracking-wide text-stratosort-danger focus-ring-warning hover:bg-stratosort-danger/15"
        aria-label={`Save failed: ${lastSaveError}. Click to retry.`}
        title={`Save failed: ${lastSaveError}. Click to retry.`}
      >
        <CircleAlert className="h-3 w-3" aria-hidden="true" />
        <span>Save failed — retry</span>
      </button>
    );
  } else if (isSaving) {
    saveStatusChip = (
      <StatusBadge appearance="label" variant="info">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        <span>Saving…</span>
      </StatusBadge>
    );
  } else if (lastSavedAt) {
    saveStatusChip = (
      <StatusBadge appearance="label" variant="success">
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
        <span>Saved {formatSavedRelative(lastSavedAt, saveStatusNow)}</span>
      </StatusBadge>
    );
  }

  const content = (
    <div
      className="settings-modal fixed inset-0 z-modal flex items-center justify-center p-4 sm:p-6"
      style={{
        backgroundColor: 'var(--overlay-scrim)',
        paddingTop: 'calc(var(--app-nav-height) + 1rem)',
        paddingBottom: '1.5rem'
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) void closeSettingsPanel();
      }}
      role="presentation"
    >
      <div
        ref={panelRef}
        className="surface-panel !p-0 w-full max-w-4xl mx-auto max-h-[86vh] flex flex-col overflow-hidden shadow-2xl pointer-events-auto"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
      >
        {showUnavailable ? (
          <>
            <div className="settings-modal-header px-6 py-4 border-b border-border-soft/70 bg-surface-primary flex-shrink-0 rounded-t-2xl">
              <div className="flex items-start sm:items-center justify-between gap-default">
                <div className="min-w-0">
                  <div className="flex items-center gap-compact">
                    <SettingsIcon className="h-5 w-5 text-stratosort-blue" aria-hidden="true" />
                    <Heading as="h2" variant="h4">
                      Settings unavailable
                    </Heading>
                  </div>
                  <Text variant="tiny" className="text-system-gray-500 mt-1">
                    Electron API not available. Please restart the application.
                  </Text>
                </div>
                <IconButton
                  icon={<X className="w-4 h-4" />}
                  size="md"
                  variant="ghost"
                  onClick={closeSettingsPanel}
                  aria-label="Close settings"
                  title="Close"
                />
              </div>
            </div>
            <div className="p-6 text-center">
              <Text variant="body" className="text-stratosort-danger font-medium">
                Settings unavailable
              </Text>
              <Text variant="small" className="text-system-gray-500 mt-2">
                Electron API not available. Please restart the application.
              </Text>
            </div>
            <div className="px-6 py-4 border-t border-border-soft bg-surface-muted flex items-center justify-end gap-cozy flex-shrink-0 rounded-b-2xl">
              <Button
                onClick={closeSettingsPanel}
                variant="secondary"
                size="sm"
                leftIcon={<X className="w-4 h-4" />}
              >
                Close
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="settings-modal-header px-6 py-4 border-b border-border-soft/70 bg-surface-primary flex-shrink-0 rounded-t-2xl">
              <div className="flex items-start sm:items-center justify-between gap-default">
                <div className="min-w-0">
                  <div className="flex items-center gap-compact">
                    <SettingsIcon className="h-5 w-5 text-stratosort-blue" aria-hidden="true" />
                    <Heading as="h2" variant="h4">
                      Settings
                    </Heading>
                    <StatusBadge appearance="label" variant="neutral">
                      {isSimpleMode ? 'Simple mode' : 'Advanced mode'}
                    </StatusBadge>
                  </div>
                  <Text variant="tiny" className="text-system-gray-500 mt-1">
                    {isSimpleMode
                      ? 'Keep StratoSort focused on analysis, renaming, organization, and essential app controls.'
                      : 'Configure AI models, performance, default folders, and app behavior.'}
                  </Text>
                </div>
                <div className="flex items-center gap-cozy flex-shrink-0">
                  {saveStatusChip}
                  <div className="flex items-center gap-compact flex-shrink-0 rounded-full border border-border-soft bg-system-gray-100/80 px-2 py-1">
                    <IconButton
                      icon={<ChevronsDown className="w-4 h-4" />}
                      size="md"
                      variant="secondary"
                      onClick={expandAll}
                      aria-label="Expand all settings sections"
                      title="Expand all"
                    />
                    <IconButton
                      icon={<ChevronsUp className="w-4 h-4" />}
                      size="md"
                      variant="secondary"
                      onClick={collapseAll}
                      aria-label="Collapse all settings sections"
                      title="Collapse all"
                    />
                    <IconButton
                      icon={<X className="w-4 h-4" />}
                      size="md"
                      variant="ghost"
                      onClick={closeSettingsPanel}
                      aria-label="Close settings"
                      title="Close"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="p-6 flex flex-col gap-5 flex-1 min-h-0 overflow-y-auto modern-scrollbar relative">
              <div className="flex items-center gap-compact rounded-full border border-border-soft bg-system-gray-100/70 px-3 py-2 flex-shrink-0">
                <Search className="h-4 w-4 text-system-gray-500 flex-shrink-0" aria-hidden="true" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search settings…"
                  className="flex-1 bg-transparent border-0 outline-none text-sm text-system-gray-800 placeholder:text-system-gray-500 focus:outline-none"
                  aria-label="Search settings"
                />
                {searchQuery && (
                  <IconButton
                    icon={<X className="h-3.5 w-3.5" />}
                    size="sm"
                    variant="ghost"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear settings search"
                    title="Clear search"
                  />
                )}
              </div>
              {matchedSectionIds && matchedSectionIds.size === 0 && (
                <Text variant="small" className="text-system-gray-500 text-center py-4">
                  No settings match "{searchQuery}".
                </Text>
              )}
              {revealAdvancedFromSearch && !isAdvancedMode && (
                <Text variant="small" className="text-system-gray-600 leading-snug">
                  Showing advanced settings that match your search. Switch to Advanced experience to
                  keep them visible when search is cleared.
                </Text>
              )}
              {isHydrating && (
                <div
                  data-testid="settings-loading-overlay"
                  role="status"
                  aria-live="polite"
                  className="absolute inset-0 bg-surface-primary/80 flex items-center justify-center z-10 rounded-b-2xl animate-loading-fade"
                >
                  <div className="text-center animate-loading-content">
                    <Spinner size="md" className="mx-auto mb-3" />
                    <Text variant="small" className="text-system-gray-600">
                      Loading settings…
                    </Text>
                  </div>
                </div>
              )}
              {pendingExternalSettings && (
                <SettingsCard
                  title="External update detected"
                  description="Settings changed outside this panel while you were editing. Reload external settings or keep your local edits."
                  className="border-stratosort-warning/40 bg-stratosort-warning/8"
                >
                  <div className="flex flex-col sm:flex-row gap-compact">
                    <Button onClick={applyExternalSettingsSnapshot} variant="secondary" size="sm">
                      Reload external settings
                    </Button>
                    <Button onClick={keepLocalSettingsSnapshot} variant="ghost" size="sm">
                      Keep local edits
                    </Button>
                  </div>
                </SettingsCard>
              )}
              <div hidden={!isSectionVisible('settings-experience')}>
                <SettingsCard
                  id="settings-experience"
                  title="Experience level"
                  description={EXPERIENCE_MODE_COPY[experienceMode] || EXPERIENCE_MODE_COPY.simple}
                >
                  <div className="flex flex-col gap-default">
                    <div className="flex flex-col gap-compact sm:flex-row">
                      <Button
                        type="button"
                        variant={isSimpleMode ? 'primary' : 'secondary'}
                        size="sm"
                        onClick={() => setExperienceMode(EXPERIENCE_MODES.SIMPLE)}
                        className="w-full sm:w-auto"
                      >
                        Simple
                      </Button>
                      <Button
                        type="button"
                        variant={isAdvancedMode ? 'primary' : 'secondary'}
                        size="sm"
                        onClick={() => setExperienceMode(EXPERIENCE_MODES.ADVANCED)}
                        className="w-full sm:w-auto"
                      >
                        Advanced
                      </Button>
                    </div>
                    <Text variant="small" className="text-system-gray-600">
                      {isSimpleMode
                        ? 'Simple mode hides the advanced configuration panels and uses a streamlined retrieval path, while still embedding your files on-device in the background — so nothing needs re-processing if you switch to Advanced later.'
                        : 'Advanced reveals every configuration panel — AI models, semantic search, chat-with-documents, and the knowledge graph — and enables graph-aware retrieval at search time. Save to apply.'}
                    </Text>
                  </div>
                </SettingsCard>
              </div>
              <div hidden={!isSectionVisible('settings-appearance')}>
                <AppearanceSection />
              </div>
              <div hidden={!isSectionVisible('settings-ai-provider')}>
                <Collapsible
                  title={
                    <div className="flex items-center gap-compact">
                      <Cloud className="h-4 w-4 text-stratosort-blue" aria-hidden="true" />
                      <span>AI Provider</span>
                    </div>
                  }
                  defaultOpen={false}
                  persistKey="settings-ai-provider"
                >
                  <AIProviderSection addNotification={addNotification} />
                </Collapsible>
              </div>
              <div hidden={!isSectionVisible('settings-mcp')}>
                <Collapsible
                  title={
                    <div className="flex items-center gap-compact">
                      <Plug className="h-4 w-4 text-stratosort-blue" aria-hidden="true" />
                      <span>MCP Server</span>
                    </div>
                  }
                  defaultOpen={false}
                  persistKey="settings-mcp"
                >
                  <McpServerSection addNotification={addNotification} />
                </Collapsible>
              </div>
              <div hidden={!isSectionVisible('settings-ai')}>
                <Collapsible
                  title={
                    <div className="flex items-center gap-compact">
                      <Brain className="h-4 w-4 text-stratosort-blue" aria-hidden="true" />
                      <span>AI Configuration</span>
                    </div>
                  }
                  defaultOpen={false}
                  persistKey="settings-ai"
                >
                  <Stack gap="spacious">
                    <LlamaConfigSection
                      llamaHealth={llamaHealth}
                      isRefreshingModels={isRefreshingModels}
                      isDownloading={isAddingModel}
                      downloadProgress={pullProgress}
                      modelList={modelList}
                      showAllModels={showAllModels}
                      setShowAllModels={setShowAllModels}
                      onRefreshModels={loadModels}
                      onDownloadModel={downloadRecommendedModels}
                      onDeleteModel={deleteModel}
                      // effectiveAdvancedMode (not isAdvancedMode): when a
                      // Simple-mode search reveals this section, its advanced
                      // controls should match the other search-revealed
                      // sections instead of staying hidden.
                      isAdvancedMode={effectiveAdvancedMode}
                      activeModelNames={[
                        settings.textModel,
                        settings.visionModel,
                        settings.embeddingModel
                      ].filter(Boolean)}
                    />
                    {effectiveAdvancedMode && (
                      <ModelSelectionSection
                        settings={settings}
                        setSettings={applySettingsUpdate}
                        textModelOptions={textModelOptions}
                        visionModelOptions={visionModelOptions}
                        embeddingModelOptions={embeddingModelOptions}
                      />
                    )}
                    {effectiveAdvancedMode && (
                      <ChatPersonaSection settings={settings} setSettings={applySettingsUpdate} />
                    )}
                    {effectiveAdvancedMode && (
                      <ModelManagementSection
                        newModel={newModel}
                        setNewModel={setNewModel}
                        isAddingModel={isAddingModel}
                        onAddModel={addModel}
                        installedModels={modelLists.all}
                        downloadProgress={pullProgress}
                      />
                    )}
                    {effectiveAdvancedMode && (
                      <EmbeddingBehaviorSection
                        settings={settings}
                        setSettings={applySettingsUpdate}
                        lockedBySimpleMode={!isAdvancedMode}
                      />
                    )}
                    {effectiveAdvancedMode && (
                      <EmbeddingRebuildSection addNotification={addNotification} />
                    )}
                  </Stack>
                </Collapsible>
              </div>

              <div hidden={!isSectionVisible('settings-performance')}>
                <Collapsible
                  title={
                    <div className="flex items-center gap-compact">
                      <Zap className="h-4 w-4 text-stratosort-blue" aria-hidden="true" />
                      <span>Performance</span>
                    </div>
                  }
                  defaultOpen={false}
                  persistKey="settings-performance"
                >
                  <Stack gap="spacious">
                    <AutoOrganizeSection settings={settings} setSettings={applySettingsUpdate} />
                    <BackgroundModeSection settings={settings} setSettings={applySettingsUpdate} />
                    {effectiveAdvancedMode && (
                      <ProcessingLimitsSection
                        settings={settings}
                        setSettings={applySettingsUpdate}
                      />
                    )}
                    {effectiveAdvancedMode && (
                      <GraphRetrievalSection
                        settings={settings}
                        setSettings={applySettingsUpdate}
                        lockedBySimpleMode={!isAdvancedMode}
                      />
                    )}
                    <ExclusionRulesEditor settings={settings} setSettings={applySettingsUpdate} />
                  </Stack>
                </Collapsible>
              </div>

              <div hidden={!isSectionVisible('settings-defaults')}>
                <Collapsible
                  title={
                    <div className="flex items-center gap-compact">
                      <FolderOpen className="h-4 w-4 text-stratosort-blue" aria-hidden="true" />
                      <span>Default locations</span>
                    </div>
                  }
                  defaultOpen={false}
                  persistKey="settings-defaults"
                >
                  <Stack gap="spacious">
                    <DefaultLocationsSection
                      settings={settings}
                      setSettings={applySettingsUpdate}
                    />
                    <NamingSettingsSection settings={settings} setSettings={applySettingsUpdate} />
                  </Stack>
                </Collapsible>
              </div>

              {/* id doubles as the scroll target for openSettings({ scrollToId }) deep links */}
              <div id="settings-app" hidden={!isSectionVisible('settings-app')}>
                <Collapsible
                  title={
                    <div className="flex items-center gap-compact">
                      <Monitor className="h-4 w-4 text-stratosort-blue" aria-hidden="true" />
                      <span>Application</span>
                    </div>
                  }
                  defaultOpen={false}
                  persistKey="settings-app"
                >
                  <Stack gap="spacious">
                    <ApplicationSection
                      settings={settings}
                      setSettings={applySettingsUpdate}
                      addNotification={addNotification}
                    />
                    <NotificationSettingsSection
                      settings={settings}
                      setSettings={applySettingsUpdate}
                    />
                    <LicenseSection />
                    <AboutSection addNotification={addNotification} />
                    <LegalNoticesSection addNotification={addNotification} />
                    {effectiveAdvancedMode && (
                      <SettingsBackupSection addNotification={addNotification} />
                    )}
                  </Stack>
                </Collapsible>
              </div>

              <div hidden={!isSectionVisible('settings-history')}>
                <Collapsible
                  title={
                    <div className="flex items-center gap-compact">
                      <History className="h-4 w-4 text-stratosort-blue" aria-hidden="true" />
                      <span>Analysis history</span>
                    </div>
                  }
                  defaultOpen={false}
                  persistKey="settings-history"
                >
                  <SettingsCard
                    title="Analysis history"
                    description="View and manage your file analysis history, including past results and statistics."
                  >
                    <Button
                      onClick={() => setShowAnalysisHistory(true)}
                      variant="secondary"
                      size="sm"
                      className="w-full sm:w-auto"
                    >
                      View analysis history
                    </Button>
                  </SettingsCard>
                </Collapsible>
              </div>

              {effectiveAdvancedMode && (
                <div hidden={!isSectionVisible('settings-diagnostics')}>
                  <Collapsible
                    title={
                      <div className="flex items-center gap-compact">
                        <Wrench className="h-4 w-4 text-stratosort-blue" aria-hidden="true" />
                        <span>Diagnostics</span>
                      </div>
                    }
                    defaultOpen={false}
                    persistKey="settings-diagnostics"
                  >
                    <Stack gap="spacious">
                      <DiagnosticsSnapshotSection addNotification={addNotification} />
                      <DiagnosticsLogsSection addNotification={addNotification} />
                      <APITestSection addNotification={addNotification} />
                      {isDevBuild && (
                        <DebugToolsSection
                          settings={settings}
                          setSettings={applySettingsUpdate}
                          addNotification={addNotification}
                        />
                      )}
                    </Stack>
                  </Collapsible>
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-border-soft bg-surface-muted flex items-center justify-between gap-cozy flex-shrink-0 rounded-b-2xl">
              <Text variant="tiny" className="text-system-gray-500">
                Changes save automatically. The chip in the header confirms each save.
              </Text>
              <Button
                onClick={closeSettingsPanel}
                variant="secondary"
                size="sm"
                leftIcon={<X className="w-4 h-4" />}
              >
                Close
              </Button>
            </div>
          </>
        )}
      </div>
      {!showUnavailable && showAnalysisHistory && (
        <AnalysisHistoryModal
          onClose={() => setShowAnalysisHistory(false)}
          analysisStats={analysisStats}
          setAnalysisStats={setAnalysisStats}
        />
      )}
    </div>
  );

  if (typeof document === 'undefined') {
    return content;
  }

  return createPortal(content, document.body);
});

export default SettingsPanel;
