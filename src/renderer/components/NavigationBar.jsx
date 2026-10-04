import React, { useState, useEffect, useRef, memo, useCallback, useMemo } from 'react';
import PropTypes from 'prop-types';
import {
  Home,
  Settings,
  Search,
  FolderOpen,
  CheckCircle2,
  Loader2,
  Minus,
  Square,
  X,
  FolderTree,
  LayoutGrid,
  List,
  ArrowLeft
} from 'lucide-react';
import { PHASES, PHASE_METADATA, PHASE_ORDER } from '../../shared/constants';
import { createLogger } from '../../shared/logger';
import { useAppSelector, useAppDispatch } from '../store/hooks';
import {
  setPhase,
  setViewMode,
  openSettings,
  canTransitionTo,
  getTransitionBlockReason
} from '../store/slices/uiSlice';
import { updateHealth } from '../store/slices/systemSlice';
import { fetchAiConfig } from '../store/slices/aiProviderSlice';
import { useFloatingSearch } from '../contexts/FloatingSearchContext';
import { useNotification } from '../contexts/NotificationContext';
import UpdateIndicator from './UpdateIndicator';
import AIProviderBadge from './common/AIProviderBadge';
import { Button, IconButton } from './ui';
import { Text } from './ui/Typography';
import { isMac } from '../utils/platform';
import { useUndoRedo } from './UndoRedoSystem';

const logger = createLogger('NavigationBar');
// =============================================================================
// Icon Components - Using Lucide React for premium icons
// =============================================================================

const HomeIcon = memo(function HomeIcon({ className = '' }) {
  return <Home className={className} aria-hidden="true" />;
});
HomeIcon.propTypes = { className: PropTypes.string };

const SettingsIcon = memo(function SettingsIcon({ className = '' }) {
  return <Settings className={className} aria-hidden="true" />;
});
SettingsIcon.propTypes = { className: PropTypes.string };

/** Setup step: destinations and folders (distinct from header Settings gear). */
const SetupPhaseIcon = memo(function SetupPhaseIcon({ className = '' }) {
  return <FolderTree className={className} aria-hidden="true" />;
});
SetupPhaseIcon.propTypes = { className: PropTypes.string };

const SearchIcon = memo(function SearchIcon({ className = '' }) {
  return <Search className={className} aria-hidden="true" />;
});
SearchIcon.propTypes = { className: PropTypes.string };

const FolderIcon = memo(function FolderIcon({ className = '' }) {
  return <FolderOpen className={className} aria-hidden="true" />;
});
FolderIcon.propTypes = { className: PropTypes.string };

const CheckCircleIcon = memo(function CheckCircleIcon({ className = '' }) {
  return <CheckCircle2 className={className} aria-hidden="true" />;
});
CheckCircleIcon.propTypes = { className: PropTypes.string };

const SpinnerIcon = memo(function SpinnerIcon({ className = '' }) {
  return <Loader2 className={`animate-spin ${className}`} aria-hidden="true" />;
});
SpinnerIcon.propTypes = { className: PropTypes.string };

const PHASE_ICONS = PHASES
  ? {
      [PHASES.WELCOME]: HomeIcon,
      [PHASES.SETUP]: SetupPhaseIcon,
      [PHASES.DISCOVER]: SearchIcon,
      [PHASES.ORGANIZE]: FolderIcon,
      [PHASES.COMPLETE]: CheckCircleIcon
    }
  : {
      welcome: HomeIcon,
      setup: SetupPhaseIcon,
      discover: SearchIcon,
      organize: FolderIcon,
      complete: CheckCircleIcon
    };

// =============================================================================
// Sub-Components
// =============================================================================

/**
 * Connection status indicator - subtle dot with tooltip
 */
const ConnectionIndicator = memo(function ConnectionIndicator({ status = 'unknown' }) {
  const isOnline = status === 'online';
  const isOffline = status === 'offline';
  const isConnecting = status === 'connecting';
  // Running, but on the CPU fallback or with a model paused by its circuit
  // breaker: work continues, slower or with one capability missing.
  const isDegraded = status === 'degraded';
  const label = isOnline
    ? 'Local AI ready'
    : isOffline
      ? 'Local AI unavailable'
      : isConnecting
        ? 'Preparing local AI...'
        : isDegraded
          ? 'Local AI running with reduced capacity'
          : 'Status unknown';
  return (
    <div
      role="status"
      className="relative flex items-center justify-center"
      title={label}
      aria-label={label}
    >
      <span
        className={`
          h-2 w-2 rounded-full
          ${
            isOnline
              ? 'bg-stratosort-success'
              : isOffline
                ? 'bg-stratosort-danger'
                : isConnecting
                  ? 'bg-stratosort-warning animate-pulse'
                  : isDegraded
                    ? 'bg-stratosort-warning'
                    : 'bg-system-gray-400'
          }
        `}
      />
    </div>
  );
});
ConnectionIndicator.propTypes = {
  status: PropTypes.oneOf(['online', 'offline', 'connecting', 'degraded', 'unknown'])
};

/**
 * Brand logo and name
 */
const Brand = memo(function Brand({ status, activePhaseMeta, totalSteps, showStep = true }) {
  const currentStep = typeof activePhaseMeta?.step === 'number' ? activePhaseMeta.step + 1 : 1;
  const phaseDescription = activePhaseMeta?.description || 'Private file organization';
  // In dashboard mode the phased "Step N of 5" counter is meaningless (currentPhase
  // is irrelevant there), so fall back to the neutral product tagline.
  const subtitle = showStep
    ? `Step ${currentStep} of ${totalSteps} • ${phaseDescription}`
    : 'Private file organization';

  return (
    <div className="flex items-center gap-cozy select-none">
      <div className="relative">
        <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-gradient-primary-start to-gradient-primary-end text-white font-semibold text-sm flex items-center justify-center shadow-md">
          S
        </div>
        {/* pointer-events-auto re-enables the title tooltip even though Brand's wrapper opts out. */}
        <div className="absolute -bottom-0.5 -right-0.5 rounded-full border border-border-soft bg-system-gray-100/95 p-0.5 shadow-sm pointer-events-auto">
          <ConnectionIndicator status={status} />
        </div>
      </div>
      <div className="hidden sm:flex sm:items-center sm:gap-cozy leading-tight">
        <div>
          <Text as="span" variant="small" className="block font-semibold text-system-gray-900">
            StratoSort
          </Text>
          <Text
            as="span"
            variant="tiny"
            className="block max-w-[11rem] truncate lg:max-w-[14rem] xl:max-w-none"
          >
            {subtitle}
          </Text>
        </div>
      </div>
    </div>
  );
});
Brand.propTypes = {
  status: PropTypes.oneOf(['online', 'offline', 'connecting', 'degraded', 'unknown']),
  activePhaseMeta: PropTypes.shape({
    step: PropTypes.number,
    description: PropTypes.string
  }),
  totalSteps: PropTypes.number.isRequired,
  showStep: PropTypes.bool
};

/**
 * Navigation tab button
 */
const NavTab = memo(function NavTab({
  phase,
  isActive,
  canNavigate,
  blockReason,
  isLoading,
  onPhaseChange,
  onBlockedNavigate,
  onHover,
  isHovered
}) {
  const metadata = PHASE_METADATA[phase];
  const IconComponent = PHASE_ICONS[phase];

  // Stable click handler - avoids inline arrow in parent's render loop
  const handleClick = useCallback(() => {
    if (canNavigate) {
      onPhaseChange(phase);
      return;
    }
    onBlockedNavigate?.(phase);
  }, [canNavigate, onBlockedNavigate, onPhaseChange, phase]);

  const handleMouseEnter = useCallback(() => onHover(phase), [onHover, phase]);
  const handleMouseLeave = useCallback(() => onHover(null), [onHover]);

  // Get short label for nav
  const label = useMemo(() => {
    const navLabel = metadata?.navLabel;
    if (navLabel) return navLabel;

    const title = metadata?.title || metadata?.label || '';
    const words = title
      .replace(/&/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .filter((w) => !/^to|and|of|the|for|a|an$/i.test(w));
    if (words.length > 0) {
      return words.slice(0, 2).join(' ');
    }
    // Fallback to phase name if metadata is missing
    return String(phase)
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }, [metadata, phase]);

  const showSpinner = isActive && isLoading;

  return (
    <button
      type="button"
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={`
        phase-nav-tab focus-ring
        ${
          isActive
            ? 'phase-nav-tab-active'
            : canNavigate
              ? 'phase-nav-tab-interactive'
              : 'phase-nav-tab-disabled'
        }
      `}
      aria-label={metadata?.title}
      data-phase={phase}
      aria-current={isActive ? 'step' : undefined}
      aria-busy={showSpinner}
      aria-disabled={!canNavigate}
      title={
        !canNavigate && !isActive
          ? blockReason ||
            'Navigation is paused while analysis or file moves run. Wait for the step to finish, or cancel from the active phase.'
          : `Step ${(metadata?.step ?? 0) + 1} of ${PHASE_ORDER.length} • ${metadata?.description || metadata?.title}`
      }
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      {showSpinner ? (
        <SpinnerIcon className="phase-nav-icon text-stratosort-blue flex-shrink-0" />
      ) : (
        IconComponent && (
          <IconComponent
            className={`phase-nav-icon flex-shrink-0 ${isActive || isHovered ? 'text-stratosort-blue' : 'text-current opacity-70'}`}
          />
        )
      )}
      {/* FIX: Always show label, with clear size/line-height for visibility */}
      <span className="phase-nav-label">{label}</span>

      {/* Active state is conveyed via phase-nav-tab-active (bg, border, text color) */}
    </button>
  );
});

NavTab.propTypes = {
  phase: PropTypes.string.isRequired,
  isActive: PropTypes.bool.isRequired,
  canNavigate: PropTypes.bool.isRequired,
  blockReason: PropTypes.string,
  isLoading: PropTypes.bool.isRequired,
  onPhaseChange: PropTypes.func.isRequired,
  onBlockedNavigate: PropTypes.func,
  onHover: PropTypes.func.isRequired,
  isHovered: PropTypes.bool.isRequired
};

/**
 * 1px gradient progress meter that grows along the bottom of the tab strip
 * as the user advances through PHASE_ORDER. Uses CSS transitions on the
 * scaleX transform so the duration follows --motion-duration-standard
 * tokens automatically. Hidden from screen readers because the active tab's
 * `aria-current="step"` already conveys position.
 */
const PhaseProgressMeter = memo(function PhaseProgressMeter({ currentPhase, totalSteps }) {
  const index = PHASE_ORDER ? PHASE_ORDER.indexOf(currentPhase) : -1;
  const safeTotal = Math.max(1, totalSteps || 1);
  const fraction = index < 0 ? 0 : Math.min(1, (index + 1) / safeTotal);

  return (
    <div
      className="phase-nav-progress"
      aria-hidden="true"
      style={{ '--phase-progress': fraction }}
    />
  );
});
PhaseProgressMeter.propTypes = {
  currentPhase: PropTypes.string,
  totalSteps: PropTypes.number.isRequired
};

const VIEW_MODE_OPTIONS = [
  { mode: 'phased', label: 'Guided', Icon: List, title: 'Guided step-by-step flow' },
  { mode: 'dashboard', label: 'Dashboard', Icon: LayoutGrid, title: 'Dashboard overview' }
];

/**
 * Segmented control for switching between the guided phased flow and the
 * dashboard overview. Subscribes to ui.viewMode directly and dispatches
 * setViewMode, so it stays interactive during operations — switching surfaces
 * is a presentation choice, not a phase transition, and must never be gated by
 * isBlockedByOperation the way the phase tabs are.
 */
const ViewModeToggle = memo(function ViewModeToggle() {
  const dispatch = useAppDispatch();
  const viewMode = useAppSelector((state) => state.ui.viewMode);
  // The dashboard surface is gated on having at least one smart folder — App.js
  // falls back to the phased flow otherwise. Disabling the toggle keeps the
  // control honest: it never highlights Dashboard while the rendered surface
  // stays phased. Same aria-disabled + tooltip treatment as the phase tabs, so
  // the title still surfaces on hover (a native `disabled` would swallow it).
  const dashboardAvailable = useAppSelector((state) => state.files.smartFolders.length > 0);

  // Single stable handler reads the target mode off the button's data-* attr,
  // avoiding a fresh inline closure per option in the render loop.
  const handleSelect = useCallback(
    (event) => {
      const { mode: next, disabled } = event.currentTarget.dataset;
      if (disabled === 'true') return;
      if (next && next !== viewMode) dispatch(setViewMode(next));
    },
    [dispatch, viewMode]
  );

  return (
    <div
      role="group"
      aria-label="View mode"
      className="view-mode-toggle hidden items-center gap-0.5 rounded-full border border-border-soft bg-system-gray-100/95 p-0.5 shadow-sm sm:flex"
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      {VIEW_MODE_OPTIONS.map(({ mode, label, Icon, title }) => {
        const isActive = viewMode === mode;
        const isDisabled = mode === 'dashboard' && !dashboardAvailable;
        // One descriptive string drives both the hover tooltip and the
        // accessible name, so the control is self-describing at every width —
        // including when the visible text label is collapsed to icon-only.
        const describedLabel = isDisabled
          ? 'Add a smart folder in Setup to open the dashboard.'
          : title;
        return (
          <button
            key={mode}
            type="button"
            data-mode={mode}
            data-disabled={isDisabled ? 'true' : undefined}
            onClick={handleSelect}
            aria-pressed={isActive}
            aria-disabled={isDisabled}
            aria-label={describedLabel}
            title={describedLabel}
            className={`
              group focus-ring flex h-8 items-center rounded-full text-xs font-medium
              [transition-duration:var(--duration-normal)]
              ${
                isDisabled
                  ? 'cursor-not-allowed px-2 text-system-gray-400 opacity-60'
                  : isActive
                    ? 'gap-1.5 bg-gradient-to-r from-stratosort-indigo to-stratosort-blue px-3 text-white shadow-sm'
                    : 'px-2 text-system-gray-600 hover:gap-1.5 hover:bg-system-gray-200/70 hover:px-3 hover:text-system-gray-900'
              }
            `}
          >
            <Icon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            <span
              className={`overflow-hidden whitespace-nowrap transition-[max-width,opacity,margin] duration-200 ease-out ${
                isActive
                  ? 'ml-0 max-w-24 opacity-100'
                  : 'max-w-0 opacity-0 group-hover:ml-1.5 group-hover:max-w-24 group-hover:opacity-100 group-focus-visible:ml-1.5 group-focus-visible:max-w-24 group-focus-visible:opacity-100'
              }`}
            >
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
});

/**
 * Action buttons (settings, update indicator, floating search)
 */
const NavActions = memo(function NavActions({ onSettingsClick }) {
  const { isModalOpen, openSearchModal, closeSearchModal } = useFloatingSearch();

  const searchActive = isModalOpen;

  const handleSearchClick = useCallback(() => {
    if (isModalOpen) {
      closeSearchModal();
      return;
    }
    openSearchModal('search');
  }, [isModalOpen, closeSearchModal, openSearchModal]);

  return (
    <div className="flex items-center gap-compact" style={{ WebkitAppRegion: 'no-drag' }}>
      <ViewModeToggle />
      <AIProviderBadge />
      <UpdateIndicator />
      <Button
        onClick={handleSearchClick}
        variant="secondary"
        size="sm"
        leftIcon={<SearchIcon className="h-4 w-4" />}
        className={
          searchActive
            ? 'h-9 w-9 px-0 bg-stratosort-blue/10 border-stratosort-blue/30 text-stratosort-blue hover:bg-stratosort-blue/15'
            : 'h-9 w-9 px-0'
        }
        aria-label={isModalOpen ? 'Close Knowledge OS' : 'Open Knowledge OS (Ctrl+K)'}
        title={isModalOpen ? 'Close Knowledge OS' : 'Open Knowledge OS (Ctrl+K)'}
      />
      <IconButton
        icon={<SettingsIcon className="h-4 w-4" />}
        size="sm"
        variant="secondary"
        onClick={onSettingsClick}
        aria-label="Open settings"
        title="Settings"
      />
    </div>
  );
});
NavActions.propTypes = { onSettingsClick: PropTypes.func.isRequired };

/**
 * Custom window controls for Windows/Linux (macOS uses native traffic lights)
 */
const WindowControls = memo(function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);

  const refreshMaximizedState = useCallback(async () => {
    if (!window?.electronAPI?.window?.isMaximized) return;
    try {
      const maximized = await window.electronAPI.window.isMaximized();
      setIsMaximized(Boolean(maximized));
    } catch (error) {
      logger.error('Failed to read window maximize state', error);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    let resizeTimeout = null;

    const updateState = async () => {
      if (!isMounted) return;
      await refreshMaximizedState();
    };

    // Debounced resize handler to prevent excessive IPC calls
    const handleResize = () => {
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      resizeTimeout = setTimeout(() => {
        if (isMounted) {
          updateState();
        }
      }, 150); // 150ms debounce
    };

    // Initial state check
    updateState();
    window.addEventListener('resize', handleResize, { passive: true });

    return () => {
      isMounted = false;
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      window.removeEventListener('resize', handleResize);
    };
  }, [refreshMaximizedState]);

  const handleMinimize = useCallback(async () => {
    try {
      await window.electronAPI?.window?.minimize?.();
    } catch (error) {
      logger.error('Failed to minimize window', error);
    }
  }, []);

  const handleToggleMaximize = useCallback(async () => {
    try {
      const toggled = await window.electronAPI?.window?.toggleMaximize?.();
      if (typeof toggled === 'boolean') {
        setIsMaximized(toggled);
      } else {
        refreshMaximizedState();
      }
    } catch (error) {
      logger.error('Failed to toggle maximize state', error);
    }
  }, [refreshMaximizedState]);

  const handleClose = useCallback(async () => {
    try {
      await window.electronAPI?.window?.close?.();
    } catch (error) {
      logger.error('Failed to close window', error);
    }
  }, []);

  // macOS uses the native traffic lights
  if (isMac) return null;

  return (
    <div
      className="flex items-center overflow-hidden rounded-full border border-border-soft bg-system-gray-100/95 shadow-sm"
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      <IconButton
        icon={<Minus className="h-4 w-4" />}
        size="sm"
        variant="ghost"
        onClick={handleMinimize}
        className="h-9 w-11 rounded-none rounded-l-full text-system-gray-600 hover:bg-system-gray-100 hover:text-system-gray-900 [transition-duration:var(--duration-normal)]"
        aria-label="Minimize window"
        title="Minimize"
      />
      <IconButton
        icon={
          isMaximized ? (
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path d="M3,1v2H1v6h6V7h2V1H3z M2,8V4h4v4H2z M8,6h-1V3H4V2h4V6z" />
            </svg>
          ) : (
            <Square className="h-3.5 w-3.5" />
          )
        }
        size="sm"
        variant="ghost"
        onClick={handleToggleMaximize}
        className="h-9 w-11 rounded-none text-system-gray-600 hover:bg-system-gray-100 hover:text-system-gray-900 [transition-duration:var(--duration-normal)]"
        aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
        title={isMaximized ? 'Restore' : 'Maximize'}
      />
      <IconButton
        icon={<X className="h-4 w-4" />}
        size="sm"
        variant="ghost"
        onClick={handleClose}
        className="h-9 w-11 rounded-none rounded-r-full text-system-gray-500 hover:text-white hover:bg-stratosort-danger [transition-duration:var(--duration-normal)]"
        aria-label="Close window"
        title="Close"
      />
    </div>
  );
});

// =============================================================================
// Main Component
// =============================================================================

function NavigationBar() {
  const dispatch = useAppDispatch();
  const { showInfo } = useNotification();
  const currentPhase = useAppSelector((state) => state.ui.currentPhase);
  const viewMode = useAppSelector((state) => state.ui.viewMode);
  const cameFromDashboard = useAppSelector((state) => state.ui.cameFromDashboard);
  // Mirror App.js' dashboard gate so the "Back to dashboard" affordance never
  // dead-ends: returning is only offered when the dashboard would actually render.
  const dashboardAvailable = useAppSelector((state) => state.files?.smartFolders?.length > 0);
  const isOrganizing = useAppSelector((state) => state.ui.isOrganizing);
  const { isExecuting: isUndoRedoExecuting, executionStatus } = useUndoRedo();
  const isLoading = useAppSelector((state) => state.ui.isLoading);
  const isAnalyzing = useAppSelector((state) => state.analysis?.isAnalyzing);
  const health = useAppSelector((state) => state.system.health);
  const aiProviderLoaded = useAppSelector((state) => state.aiProvider?.loaded);
  const connectionStatus = useMemo(() => {
    const normalizeStatus = (value) => {
      if (!value) return 'unknown';
      const normalized = String(value).toLowerCase();
      if (['online', 'healthy', 'ready', 'ok', 'running', 'available'].includes(normalized)) {
        return 'online';
      }
      if (['offline', 'unhealthy', 'down', 'error', 'stopped'].includes(normalized)) {
        return 'offline';
      }
      if (normalized === 'degraded') return 'degraded';
      if (
        ['connecting', 'initializing', 'starting', 'booting', 'unknown', 'pending'].includes(
          normalized
        )
      ) {
        return 'connecting';
      }
      return 'unknown';
    };

    // Llama and VectorDB are in-process, always online after initialization
    const statuses = [health?.llama, health?.vectorDb].map(normalizeStatus);
    if (statuses.every((s) => s === 'online')) return 'online';
    if (statuses.some((s) => s === 'offline')) return 'offline';
    if (statuses.some((s) => s === 'degraded')) return 'degraded';
    if (statuses.some((s) => s === 'connecting' || s === 'unknown')) return 'connecting';
    return 'unknown';
  }, [health]);

  const [isScrolled, setIsScrolled] = useState(false);
  const [hoveredTab, setHoveredTab] = useState(null);
  const headerRef = useRef(null);
  const currentPhaseMeta = PHASE_METADATA?.[currentPhase] || PHASE_METADATA?.[PHASES.WELCOME];

  // The header is position:fixed, so its height never participates in flow —
  // AppShell's <main> clears it with top padding. When sub-rows (the
  // dashboard-return breadcrumb, the navigation-paused banner) appear the
  // header grows past --app-nav-height and would overlap content. Publish the
  // real measured height so <main> reserves exactly the right space.
  useEffect(() => {
    const el = headerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const root = document.documentElement;
    const publish = () => {
      root.style.setProperty('--app-nav-total-height', `${el.offsetHeight}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--app-nav-total-height');
    };
  }, []);

  // Memoized action creators
  const actions = useMemo(
    () => ({
      advancePhase: (phase) => dispatch(setPhase(phase)),
      openSettings: (payload) => dispatch(openSettings(payload))
    }),
    [dispatch]
  );

  const didProbeHealth = useRef(false);
  const didFetchAiConfig = useRef(false);
  const AI_CONFIG_FETCH_MAX_ATTEMPTS = 3;

  useEffect(() => {
    if (didFetchAiConfig.current || aiProviderLoaded) return;
    if (!window.electronAPI?.aiProvider?.getConfig) return;
    didFetchAiConfig.current = true;

    let cancelled = false;

    const attemptFetch = async (attempt) => {
      if (cancelled || aiProviderLoaded) return;
      try {
        await dispatch(fetchAiConfig()).unwrap();
      } catch (err) {
        if (cancelled) return;
        if (attempt + 1 < AI_CONFIG_FETCH_MAX_ATTEMPTS) {
          const delayMs = 500 * (attempt + 1);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return attemptFetch(attempt + 1);
        }
        logger.warn('[NavigationBar] fetchAiConfig failed after retries', {
          error: err?.message || String(err)
        });
      }
    };

    void attemptFetch(0);

    return () => {
      cancelled = true;
    };
  }, [dispatch, aiProviderLoaded]);

  useEffect(() => {
    if (didProbeHealth.current) return;
    didProbeHealth.current = true;

    const probeHealth = async () => {
      // LlamaService is in-process - use testConnection to verify model loaded
      if (window.electronAPI?.llama?.testConnection) {
        try {
          const res = await window.electronAPI.llama.testConnection();
          // `status` is 'unhealthy' both when the engine never initialized
          // and when one model type is paused by its breaker. The health
          // block tells them apart: not initialized is offline, a paused
          // model or the CPU fallback is degraded, everything else online.
          const health =
            res?.llamaHealth && typeof res.llamaHealth === 'object' ? res.llamaHealth : null;
          const initialized = health ? health.initialized === true : res?.status !== 'unhealthy';
          const mappedStatus =
            res?.success === false || !initialized
              ? 'offline'
              : health?.degraded
                ? 'degraded'
                : 'online';
          dispatch(updateHealth({ llama: mappedStatus }));
        } catch (error) {
          const message = error?.message || String(error);
          const isInFlight =
            message.includes('Operation already in progress') &&
            message.includes('llama:test-connection');
          if (isInFlight) {
            logger.debug('[NavigationBar] Llama health probe skipped: test already in flight');
            return;
          }
          logger.debug('[NavigationBar] Llama health probe failed', { error: message });
          dispatch(updateHealth({ llama: 'offline' }));
        }
      } else {
        dispatch(updateHealth({ llama: 'offline' }));
      }

      // Check VectorDB status
      if (window.electronAPI?.vectorDb?.healthCheck) {
        try {
          const res = await window.electronAPI.vectorDb.healthCheck();
          const status = res?.healthy ? 'online' : 'offline';
          dispatch(updateHealth({ vectorDb: status }));
        } catch (error) {
          logger.debug('[NavigationBar] Vector DB health check failed', {
            error: error?.message || String(error)
          });
          dispatch(updateHealth({ vectorDb: 'offline' }));
        }
      } else {
        dispatch(updateHealth({ vectorDb: 'offline' }));
      }
    };

    probeHealth();
  }, [dispatch]);

  // Scroll effect for glass morphism - throttled to prevent excessive re-renders
  useEffect(() => {
    let scrollRafId = null;
    let isMounted = true;
    const scrollTarget = document.getElementById('main-content') || window;

    const getScrollTop = () => {
      if (scrollTarget === window) {
        return window.scrollY || 0;
      }
      return scrollTarget?.scrollTop || 0;
    };

    const handleScroll = () => {
      if (scrollRafId) {
        return; // Skip if already scheduled
      }
      scrollRafId = requestAnimationFrame(() => {
        scrollRafId = null;
        if (isMounted) {
          setIsScrolled(getScrollTop() > 10);
        }
      });
    };

    handleScroll();
    scrollTarget.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      isMounted = false;
      if (scrollRafId) {
        cancelAnimationFrame(scrollRafId);
      }
      scrollTarget.removeEventListener('scroll', handleScroll);
    };
  }, []);

  // Phase navigation handler
  const handlePhaseChange = useCallback(
    (newPhase) => {
      if (!newPhase || typeof newPhase !== 'string') return;

      if (newPhase === currentPhase || canTransitionTo(currentPhase, newPhase)) {
        actions.advancePhase(newPhase);
      }
    },
    [currentPhase, actions]
  );

  const handleBlockedNavigation = useCallback(
    (phase) => {
      if (!phase || phase === currentPhase) {
        showInfo(
          isOrganizing
            ? 'Files are still moving. Stay on this step until the move finishes or cancel from Organize.'
            : isAnalyzing
              ? 'Analysis is still running. You can keep reviewing this step while processing finishes.'
              : 'Navigation is paused until the current operation finishes.',
          5200
        );
        return;
      }

      if (phase === PHASES.SETUP) {
        actions.openSettings();
        showInfo(
          'Settings opened while work continues. Review destination changes now, then re-run once the current operation finishes.',
          6200
        );
        return;
      }

      showInfo(
        isOrganizing
          ? 'Navigation is paused while files are moving. You can still open Settings from the gear.'
          : 'Navigation is paused while analysis is running. You can still open Settings from the gear.',
        5200
      );
    },
    [actions, currentPhase, isAnalyzing, isOrganizing, showInfo]
  );

  // Settings handler
  const handleSettingsClick = useCallback(() => {
    actions.openSettings();
  }, [actions]);

  // Return to the dashboard the user deep-linked out of. A view switch, not a
  // phase transition, so it is never gated by isBlockedByOperation.
  const handleReturnToDashboard = useCallback(() => {
    dispatch(setViewMode('dashboard'));
  }, [dispatch]);

  // Keep top-level navigation responsive; analysis state can become stale.
  const isBlockedByOperation =
    isOrganizing || isLoading || Boolean(isAnalyzing) || Boolean(isUndoRedoExecuting);
  // Only show a nav spinner for loading states other than analysis to avoid duplicate indicators
  const navSpinnerActive = isOrganizing || isLoading || Boolean(isUndoRedoExecuting);
  // Dashboard mode hides the phased chrome (tab strip, step counter, the
  // navigation-paused banner) — none of it is meaningful when the user has
  // opted out of the guided flow. The ViewModeToggle remains the way back.
  const isDashboard = viewMode === 'dashboard';
  // Contextual return path for users who deep-linked out of the dashboard into a
  // phase. The global ViewModeToggle is the deliberate switch; this banner is the
  // "I just popped out to do one thing, take me home" affordance — and unlike the
  // toggle it stays visible at every window width.
  const showDashboardReturn = !isDashboard && cameFromDashboard && dashboardAvailable;

  return (
    <header
      ref={headerRef}
      className={`
        fixed inset-x-0 top-0 z-[100]
        border-b border-border-soft/60
        backdrop-blur-xl backdrop-saturate-150
        [transition-property:background-color,box-shadow,border-color]
        [transition-duration:var(--motion-duration-standard)]
        [transition-timing-function:var(--motion-ease-standard)]
        ${isScrolled ? 'bg-system-gray-100/96 shadow-md' : 'bg-system-gray-100/90 shadow-sm'}
      `}
      style={{
        WebkitAppRegion: 'drag',
        zIndex: 'var(--z-header)',
        isolation: 'isolate',
        willChange: 'auto'
      }}
    >
      <div className="relative grid h-[var(--app-nav-height)] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 px-4 lg:gap-x-6 lg:px-6">
        {/* pointer-events-none so branding never steals phase-nav clicks */}
        <div
          className={`z-20 min-w-0 shrink-0 pointer-events-none ${isMac ? 'ml-[78px] lg:ml-[84px]' : ''}`}
        >
          <Brand
            status={connectionStatus}
            activePhaseMeta={currentPhaseMeta}
            totalSteps={(PHASE_ORDER || []).length || 5}
            showStep={!isDashboard}
          />
        </div>

        {/* Center: grid corridor between brand and actions — never overlaps either side */}
        <div
          className="phase-nav-center z-10 flex min-w-0 items-center justify-center px-2 pointer-events-none"
          data-testid="phase-nav-center"
          aria-hidden={isDashboard || undefined}
        >
          {!isDashboard && (
            <nav
              className="phase-nav max-w-full pointer-events-auto"
              style={{ WebkitAppRegion: 'no-drag' }}
              aria-label="Phase navigation"
              data-testid="phase-nav"
              data-active-phase={currentPhase}
            >
              {(PHASE_ORDER || ['welcome', 'setup', 'discover', 'organize', 'complete']).map(
                (phase) => {
                  const isActive = phase === currentPhase;

                  const canNavigate =
                    (isActive || canTransitionTo(currentPhase, phase)) && !isBlockedByOperation;

                  const blockReason =
                    !canNavigate && !isActive && !isBlockedByOperation
                      ? getTransitionBlockReason(currentPhase, phase)
                      : null;

                  return (
                    <NavTab
                      key={phase}
                      phase={phase}
                      isActive={isActive}
                      canNavigate={canNavigate}
                      blockReason={blockReason}
                      isLoading={isActive && navSpinnerActive}
                      onPhaseChange={handlePhaseChange}
                      onBlockedNavigate={handleBlockedNavigation}
                      onHover={setHoveredTab}
                      isHovered={hoveredTab === phase}
                    />
                  );
                }
              )}
              <PhaseProgressMeter
                currentPhase={currentPhase}
                totalSteps={(PHASE_ORDER || []).length || 5}
              />
            </nav>
          )}
        </div>

        {/* Right: Actions + Window Controls */}
        <div
          className="z-20 flex shrink-0 items-center gap-compact"
          data-testid="nav-actions"
          style={{ WebkitAppRegion: 'no-drag' }}
        >
          <NavActions onSettingsClick={handleSettingsClick} />
          <WindowControls />
        </div>
      </div>

      {showDashboardReturn && (
        <div
          className="flex items-center justify-center gap-cozy border-t border-border-soft/50 bg-gradient-to-b from-stratosort-blue/12 to-transparent px-4 py-1.5 lg:px-6"
          style={{ WebkitAppRegion: 'no-drag' }}
        >
          <Text variant="tiny" className="hidden text-system-gray-600 sm:inline">
            You opened this from your dashboard.
          </Text>
          <Button
            variant="subtle"
            size="sm"
            onClick={handleReturnToDashboard}
            leftIcon={<ArrowLeft className="h-3.5 w-3.5" />}
          >
            Back to dashboard
          </Button>
        </div>
      )}

      {!isDashboard && isBlockedByOperation && (
        <div className="border-t border-border-soft/50 bg-stratosort-warning/8 px-4 py-1.5 text-center lg:px-6">
          <Text variant="tiny" className="text-system-gray-700">
            {isOrganizing
              ? 'Step navigation is paused while files are being moved. Wait for the move to finish or cancel from Organize.'
              : isUndoRedoExecuting
                ? executionStatus?.label
                  ? `${executionStatus.label} Step navigation is paused until file moves finish.`
                  : 'Step navigation is paused while undo/redo moves files.'
                : isAnalyzing
                  ? 'Step navigation is paused while analysis is running.'
                  : 'Step navigation is paused. Please wait for the current operation to finish.'}
          </Text>
        </div>
      )}
    </header>
  );
}

export default memo(NavigationBar);
