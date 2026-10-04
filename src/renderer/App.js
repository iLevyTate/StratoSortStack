// @ts-check
import React, { useMemo, useCallback, useEffect, Suspense, lazy } from 'react';
import { useAppDispatch, useAppSelector } from './store/hooks';
import { PHASES } from '../shared/constants';

import NavigationBar from './components/NavigationBar';
import TooltipManager from './components/TooltipManager';

import AppProviders from './components/AppProviders';
import ErrorBoundary from './components/ErrorBoundary';
import _PhaseErrorBoundary from './components/PhaseErrorBoundary';
import _AppShell from './components/layout/AppShell';
import DegradedStateBanner from './components/layout/DegradedStateBanner';
import { LazyLoadingSpinner, ModalLoadingOverlay } from './components/ui/LoadingSkeleton';
import { updateSettings } from './store/slices/uiSlice';
import { fetchLicenseStatus } from './store/slices/licenseSlice';
import { useSettingsSubscription } from './hooks/useSettingsSubscription';
import { useNotificationActivation } from './hooks/useNotificationActivation';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';

// AppShell is a .jsx module (untyped under checkJs); cast at import so JSX
// prop checks pass under noImplicitAny. See tsconfig.checkjs.json header re .jsx.
const AppShell = /** @type {any} */ (_AppShell);
const PhaseErrorBoundary = /** @type {any} */ (_PhaseErrorBoundary);

// PhaseRenderer pulls in framer-motion (~60 KB gzipped) and every lazy
// phase module. Keeping it eager forced the whole motion runtime + phase
// preloader into the synchronous renderer boot bundle, which was visible
// on cold startup as a ~150 ms parse/eval pause between the splash clear
// and the first phase paint. Loading it lazily lets the shell (nav,
// boundaries, degraded banner) mount and paint first while framer-motion
// streams in alongside the active phase chunk.
const PhaseRenderer = lazy(() => import('./components/PhaseRenderer'));
const DashboardView = lazy(() => import('./components/dashboard/DashboardView'));
// The settings overlay mounts HERE — not inside PhaseRenderer — because the
// dashboard surface replaces PhaseRenderer entirely. When it lived in
// PhaseRenderer, the gear on the dashboard flipped ui.showSettings with no
// consumer mounted: nothing appeared, and the stale flag popped the panel
// open the moment the user switched back to Guided. Mirrors how
// FloatingSearchProvider hoists the Knowledge OS modal above both surfaces.
const SettingsPanel = lazy(() => import('./components/SettingsPanel'));

function AppContent() {
  const dispatch = useAppDispatch();
  const currentPhase = useAppSelector((/** @type {any} */ state) => state.ui.currentPhase);
  const viewMode = useAppSelector((/** @type {any} */ state) => state.ui.viewMode);
  // Dashboard is only meaningful once setup is done — without smart folders its
  // actions are dead ends. For a true first run, fall through to the phased
  // flow so onboarding (Welcome → Setup) still runs even if 'dashboard' was the
  // remembered preference.
  const smartFoldersConfigured = useAppSelector(
    (/** @type {any} */ state) => state.files.smartFolders.length > 0
  );
  const effectiveDashboard = viewMode === 'dashboard' && smartFoldersConfigured;
  const selectedTheme = useAppSelector((/** @type {any} */ state) => state.ui.selectedTheme);
  const showSettings = useAppSelector((/** @type {any} */ state) => state.ui.showSettings);
  const settingsEventsEnabled =
    typeof window !== 'undefined' && window.electronAPI?.events?.onSettingsChanged;

  // App-level so Ctrl+, / Ctrl+Z / File-menu actions stay live on the
  // dashboard surface too (previously registered by PhaseRenderer only).
  useKeyboardShortcuts();

  // Entitlement snapshot (offline, main-process verified). Fire-and-forget:
  // until it resolves the gate stays open by design (licenseSlice initial
  // state), so a slow IPC can never flash a locked UI.
  useEffect(() => {
    dispatch(/** @type {any} */ (fetchLicenseStatus()))?.catch?.(() => {});
  }, [dispatch]);

  const handleSettingsSync = useCallback(
    (/** @type {any} */ incomingSettings) => {
      if (!incomingSettings || typeof incomingSettings !== 'object') return;
      dispatch(/** @type {any} */ (updateSettings(incomingSettings)));
    },
    [dispatch]
  );

  useSettingsSubscription(handleSettingsSync, { enabled: Boolean(settingsEventsEnabled) });
  useNotificationActivation();

  // Apply the chosen palette as a data-theme attribute on <html>. The stylesheet
  // re-themes every token under :root[data-theme='light'|'dark']; "primary" is
  // the base :root. selectedTheme is persisted by the Redux persistence
  // middleware and re-applied here on rehydrate. We also mirror it to a dedicated
  // localStorage key that index.html's pre-paint inline script reads, so the
  // splash/reload screen shows the correct theme from the very first frame
  // rather than flashing 'primary' before React mounts.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const theme = ['primary', 'light', 'dark'].includes(selectedTheme) ? selectedTheme : 'primary';
    document.documentElement.setAttribute('data-theme', theme);
    try {
      window.localStorage?.setItem('stratosort_theme', theme);
    } catch {
      // localStorage unavailable (private mode) — pre-paint falls back to the Redux blob.
    }
    // Keep the NATIVE window surface in sync too (live + persisted for the
    // next launch's pre-HTML frame). Best-effort: cosmetic only (U-002).
    window.electronAPI?.window?.setThemeBackground?.(theme)?.catch?.(() => {});
  }, [selectedTheme]);

  // Determine content container classes based on phase
  const contentClassName = useMemo(() => {
    // `flex-1` is required here — each phase is a windowed scroller (its Card/body uses
    // `flex-1 min-h-0 overflow-y-auto`) that needs an ancestor with a resolved height to
    // size against. Dropping flex-1 collapses the chain to 0px and clips the whole view.
    const baseClasses = 'flex flex-col min-h-0 flex-1 w-full mx-auto';

    if (effectiveDashboard) {
      return `${baseClasses} px-4 sm:px-6 lg:px-8 py-4 max-w-screen-2xl`;
    }

    switch (currentPhase) {
      case PHASES?.WELCOME:
      case 'welcome':
        // Welcome phase handles its own vertical padding/centering
        return `${baseClasses} px-4 sm:px-6 lg:px-8 py-0 max-w-5xl`;

      case PHASES?.SETUP:
      case 'setup':
        return `${baseClasses} px-4 sm:px-6 lg:px-8 py-6 max-w-screen-2xl`;

      case PHASES?.DISCOVER:
      case 'discover':
        return `${baseClasses} px-4 sm:px-6 lg:px-8 py-6 max-w-screen-2xl`;

      case PHASES?.ORGANIZE:
      case 'organize':
        return `${baseClasses} px-4 sm:px-6 lg:px-8 py-6 max-w-screen-2xl`;

      case PHASES?.COMPLETE:
      case 'complete':
        return `${baseClasses} px-4 sm:px-6 lg:px-8 py-6 max-w-screen-2xl`;

      default:
        return `${baseClasses} px-4 sm:px-6 lg:px-8 py-6 max-w-screen-2xl`;
    }
  }, [currentPhase, effectiveDashboard]);

  // Each chrome slot gets its own ErrorBoundary with a null fallback. Without
  // these boundaries a crash inside NavigationBar / DegradedStateBanner /
  // TooltipManager unmounts the entire app via the outer global boundary, which
  // is wildly disproportionate — a broken nav label shouldn't destroy the user's
  // in-progress workflow. Null fallback intentionally: we'd rather silently
  // drop the chrome element than render a large error card inside the top bar
  // or as a fixed-position tooltip root. The error is still logged via the
  // boundary's own logger + reportErrorToMain channel.
  /** @returns {null} */
  const noopFallback = () => null;

  return (
    <>
      <AppShell
        header={
          <ErrorBoundary contextName="NavigationBar" fallback={noopFallback}>
            <NavigationBar />
          </ErrorBoundary>
        }
        subheader={
          <ErrorBoundary contextName="DegradedStateBanner" fallback={noopFallback}>
            <DegradedStateBanner />
          </ErrorBoundary>
        }
        contentClassName={contentClassName}
      >
        <Suspense fallback={<LazyLoadingSpinner message="Preparing your workspace..." />}>
          {effectiveDashboard ? <DashboardView /> : <PhaseRenderer />}
        </Suspense>
      </AppShell>

      {showSettings && (
        <Suspense fallback={<ModalLoadingOverlay message="Opening preferences..." />}>
          <PhaseErrorBoundary phaseName="Settings">
            <SettingsPanel />
          </PhaseErrorBoundary>
        </Suspense>
      )}

      <ErrorBoundary contextName="TooltipManager" fallback={noopFallback}>
        <TooltipManager />
      </ErrorBoundary>
    </>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <AppProviders>
        <AppContent />
      </AppProviders>
    </ErrorBoundary>
  );
}

export default App;
