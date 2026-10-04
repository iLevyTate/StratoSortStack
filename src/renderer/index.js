// @ts-check
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { createLogger } from '../shared/logger';
// @ts-ignore -- store barrel's default export type doesn't survive under
// checkJs (allowJs+checkJs:false leaves the .js chain untyped). Kept
// unannotated so the file compiles; usages are all thunks/dispatches.
import _store from './store';
import { fetchDocumentsPath, fetchRedactPaths } from './store/slices/systemSlice';
import {
  addSelectedFiles,
  fetchSmartFolders,
  mergeFileStates,
  setOrganizedFiles
} from './store/slices/filesSlice';
import { mergeAnalysisResults } from './store/slices/analysisSlice';
import { fetchSettings } from './store/slices/uiSlice';
import App from './App.js';
import { applyPlatformClass } from './utils/platform';
import { fetchAnalysisHistoryPages } from './utils/analysisHistoryFetch';
import { mergeReadyQueueIntoState, normalizeReadyQueuePayload } from './utils/readyQueueHydration';
import { normalizeNamingConventionState } from '../shared/namingConventions';
import { GlobalErrorBoundary as _GlobalErrorBoundary } from './components/ErrorBoundary';
import { getScrollBehavior } from './utils/motionPreferences';
import { lockAppScroll } from './utils/scrollLock';
import perfMarks from '../shared/perfMarks';
import './styles.css';

// GlobalErrorBoundary is exported from a .jsx file (untyped under checkJs);
// cast so JSX prop checks pass. Store handled by the @ts-ignore above.
const GlobalErrorBoundary = /** @type {any} */ (_GlobalErrorBoundary);
// @ts-ignore -- see store import comment; alias avoids TS7005 at every usage.
const store = _store;

// Startup baseline. Everything else that matters is measured relative to
// this mark (React root creation, first paint, splash removal, etc.), so we
// record it as early as possible — before any dispatches or DOM work.
perfMarks.mark('startup:renderer:module-eval');

// Fetch commonly-used data early. Under webpack HMR, skip re-dispatch so thunks don't clobber
// in-memory workflow state when index.js is re-evaluated.
const __BOOTSTRAP_KEY__ = '__STRATOSORT_RENDERER_BOOTSTRAP_DISPATCH__';
const __hmr = typeof window !== 'undefined' && typeof module !== 'undefined' && !!module.hot;
const shouldRunBootstrap = typeof window !== 'undefined' && (!__hmr || !window[__BOOTSTRAP_KEY__]);

/**
 * Keep retrying settings / smart-folders after a cold-start timeout so the
 * sticky degraded banners clear once main is actually ready. The per-thunk
 * BOOTSTRAP_IPC_OPTIONS already retry inside one dispatch; this loop covers
 * the case where even that budget is exhausted under memory pressure.
 */
function scheduleBootstrapRecovery(/** @type {number} */ attempt = 0) {
  const MAX_ATTEMPTS = 5;
  if (attempt >= MAX_ATTEMPTS) return;
  const delayMs = Math.min(30_000, 2_000 * (attempt + 1));
  setTimeout(() => {
    const state = store.getState();
    const needSettings =
      Boolean(state.ui?.settingsError) || (!state.ui?.settingsLoaded && !state.ui?.settingsLoading);
    const needFolders =
      Boolean(state.files?.smartFoldersError) ||
      (!state.files?.smartFoldersLoaded && !state.files?.smartFoldersLoading);
    if (!needSettings && !needFolders) return;

    const work = [];
    if (needSettings) work.push(store.dispatch(fetchSettings(true)));
    if (needFolders) work.push(store.dispatch(fetchSmartFolders(true)));
    // allSettled never rejects; the catch only satisfies promise/catch-or-return.
    Promise.allSettled(work)
      .then(() => scheduleBootstrapRecovery(attempt + 1))
      .catch(() => {});
  }, delayMs);
}

if (shouldRunBootstrap) {
  if (__hmr) window[__BOOTSTRAP_KEY__] = true;
  store.dispatch(/** @type {any} */ (fetchDocumentsPath)());
  store.dispatch(/** @type {any} */ (fetchRedactPaths)());
  // This overrides potentially stale data from localStorage. Fire both, then
  // keep recovering in the background if either latches a timeout error.
  Promise.allSettled([store.dispatch(fetchSmartFolders(true)), store.dispatch(fetchSettings(true))])
    .then(() => scheduleBootstrapRecovery(0))
    .catch(() => {});
}

// Set logger context for renderer entry point (must be before repairOrganizedHistory)
const logger = createLogger('Renderer');

const HISTORY_REPAIR_KEY = 'stratosort_history_repair_done';

async function hydrateDurableReadyQueue() {
  try {
    const getReadyQueue = window.electronAPI?.analysis?.getReadyQueue;
    if (typeof getReadyQueue !== 'function') return;

    const response = await getReadyQueue();
    const readyEntries = normalizeReadyQueuePayload(response);
    if (readyEntries.length === 0) return;

    // Snapshot store state AFTER the IPC await — the state may have changed
    // (new uploads, background persistence rehydrate) while the IPC was in
    // flight. Reading a single snapshot rather than three separate
    // store.getState() calls also guarantees a consistent view of selected
    // files / analysis / fileStates.
    const postAwaitState = store.getState();
    const namingSettings = normalizeNamingConventionState(postAwaitState.files?.namingConvention);
    const merged = mergeReadyQueueIntoState(
      {
        selectedFiles: postAwaitState.files.selectedFiles,
        analysisResults: postAwaitState.analysis.results,
        fileStates: postAwaitState.files.fileStates
      },
      readyEntries,
      namingSettings
    );

    if (merged.hydratedCount <= 0) return;

    if (merged.addedSelectedFiles.length > 0) {
      store.dispatch(addSelectedFiles(merged.addedSelectedFiles));
    }
    if (merged.addedAnalysisResults.length > 0) {
      store.dispatch(mergeAnalysisResults(merged.addedAnalysisResults));
    }
    if (Object.keys(merged.addedFileStates).length > 0) {
      store.dispatch(mergeFileStates(merged.addedFileStates));
    }

    logger.info('[Renderer] Hydrated durable ready-to-organize queue', {
      hydratedCount: merged.hydratedCount,
      queueSize: readyEntries.length
    });
  } catch (error) {
    logger.warn('[Renderer] Failed to hydrate durable ready queue', { error: error?.message });
  }
}

async function repairOrganizedHistory() {
  try {
    if (localStorage.getItem(HISTORY_REPAIR_KEY)) return;
    const state = store.getState();
    if (state.files.organizedFiles.length > 0) return;
    const history = await fetchAnalysisHistoryPages();
    if (!Array.isArray(history) || history.length === 0) return;

    const normalize = (/** @type {any} */ p) => (p || '').replace(/\\+/g, '/').toLowerCase();
    const getFolderFromPath = (/** @type {any} */ filePath) => {
      if (!filePath) return '';
      const normalized = filePath.replace(/\\+/g, '/');
      const parts = normalized.split('/').filter(Boolean);
      if (parts.length < 2) return '';
      return parts[parts.length - 2];
    };

    const latestByPath = new Map();
    history.forEach((entry) => {
      const actualPath = entry?.organization?.actual;
      const originalPath = entry?.originalPath || entry?.filePath;
      if (!actualPath || !originalPath) return;

      const organizedAt = entry.timestamp || new Date().toISOString();
      const key = normalize(originalPath);
      const existing = latestByPath.get(key);
      if (existing && existing.organizedAt >= organizedAt) return;

      const newName = entry?.organization?.newName || actualPath.split(/[\\/]/).pop() || '';
      const originalName =
        originalPath.split(/[\\/]/).pop() || entry.fileName || newName || 'Unknown';
      const smartFolder =
        entry?.organization?.smartFolder || getFolderFromPath(actualPath) || 'Organized';

      latestByPath.set(key, {
        originalPath,
        path: actualPath,
        originalName,
        newName,
        smartFolder,
        organizedAt
      });
    });

    if (latestByPath.size > 0) {
      store.dispatch(setOrganizedFiles(Array.from(latestByPath.values())));
      logger.info('[Renderer] Rebuilt organized files history from analysis history', {
        count: latestByPath.size
      });
    }
    localStorage.setItem(HISTORY_REPAIR_KEY, 'true');
  } catch (error) {
    logger.warn('[Renderer] Failed to rebuild organized files history', { error: error?.message });
  }
}

// Under webpack HMR, run expensive hydration once per window session (not on every index re-exec).
const __HYDRATE_KEY__ = '__STRATOSORT_RENDERER_HYDRATE_ONCE__';
if (typeof window === 'undefined') {
  repairOrganizedHistory();
  hydrateDurableReadyQueue();
} else if (!__hmr) {
  repairOrganizedHistory();
  hydrateDurableReadyQueue();
} else if (!window[__HYDRATE_KEY__]) {
  window[__HYDRATE_KEY__] = true;
  repairOrganizedHistory();
  hydrateDurableReadyQueue();
}

// Add platform class to body for OS-specific styling hooks
applyPlatformClass();

// Detect flex gap support and add class for CSS fallback spacing
function applyFlexGapSupportClass() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!document.body) {
    window.addEventListener('DOMContentLoaded', applyFlexGapSupportClass, { once: true });
    return;
  }

  const flex = document.createElement('div');
  flex.style.display = 'flex';
  flex.style.flexDirection = 'column';
  flex.style.rowGap = '1px';
  flex.style.position = 'absolute';
  flex.style.visibility = 'hidden';
  flex.appendChild(document.createElement('div'));
  flex.appendChild(document.createElement('div'));
  document.body.appendChild(flex);

  const isSupported = flex.scrollHeight === 1;
  document.body.removeChild(flex);

  root.classList.toggle('no-flex-gap', !isSupported);
  root.classList.toggle('has-flex-gap', isSupported);
}

applyFlexGapSupportClass();

// Store handlers in a module-level object for reliable cleanup
/** @type {{ click: any, beforeunload: any, unhandledrejection: any, error: any }} */
const eventHandlers = {
  click: null,
  beforeunload: null,
  unhandledrejection: null,
  error: null
};

// Remove any previously registered handlers (important for HMR)
function cleanupEventHandlers() {
  if (eventHandlers.click) {
    document.removeEventListener('click', eventHandlers.click);
  }
  if (eventHandlers.beforeunload) {
    window.removeEventListener('beforeunload', eventHandlers.beforeunload);
  }
  if (eventHandlers.unhandledrejection) {
    window.removeEventListener('unhandledrejection', eventHandlers.unhandledrejection);
  }
  if (eventHandlers.error) {
    window.removeEventListener('error', eventHandlers.error);
  }
}

function isChunkLoadFailure(/** @type {any} */ err) {
  const name = String(err?.name || '');
  const message = String(err?.message || '');
  // Common signatures across webpack + browsers
  return (
    name === 'ChunkLoadError' ||
    /Loading chunk \d+ failed/i.test(message) ||
    /ChunkLoadError/i.test(message) ||
    /Failed to fetch dynamically imported module/i.test(message)
  );
}

function maybeRecoverFromChunkLoadFailure(/** @type {any} */ err) {
  if (!isChunkLoadFailure(err)) return false;

  // Avoid infinite reload loops. Allow at most 1 auto-reload per minute.
  const key = 'stratosort:chunk-reload-at';
  let last;
  try {
    last = Number(sessionStorage.getItem(key) || 0);
  } catch {
    last = 0;
  }

  const now = Date.now();
  if (Number.isFinite(last) && now - last < 60_000) {
    logger.warn('[ChunkLoadRecovery] Chunk load failed again within 60s; not auto-reloading', {
      message: err?.message,
      name: err?.name
    });
    return true; // handled (we intentionally didn't reload)
  }

  try {
    sessionStorage.setItem(key, String(now));
  } catch {
    // ignore
  }

  logger.warn('[ChunkLoadRecovery] Chunk load failed; reloading window to resync assets', {
    message: err?.message,
    name: err?.name
  });

  // A hard reload typically resolves mismatched dist chunks after rebuild/update.
  window.location.reload();
  return true;
}

// Enable smooth scrolling globally
if (typeof window !== 'undefined') {
  const scrollBehavior = getScrollBehavior();

  // Set smooth scroll on document
  document.documentElement.style.scrollBehavior = scrollBehavior;
  document.body.style.scrollBehavior = scrollBehavior;

  // Clean up any existing handlers first
  cleanupEventHandlers();

  // Add smooth scroll behavior to all internal links with proper cleanup
  eventHandlers.click = function handleSmoothScrollClick(/** @type {any} */ e) {
    const link = e.target.closest('a');
    if (link && link.getAttribute('href')?.startsWith('#')) {
      e.preventDefault();
      const targetId = link.getAttribute('href').slice(1);
      const target = document.getElementById(targetId);
      if (target) {
        target.scrollIntoView({
          behavior: scrollBehavior,
          block: 'start',
          inline: 'nearest'
        });
      }
    }
  };

  document.addEventListener('click', eventHandlers.click);

  // Add cleanup on page unload to prevent dangling references
  eventHandlers.beforeunload = function handleBeforeUnload() {
    window.__STRATOSORT_SHUTTING_DOWN__ = true;
    cleanupEventHandlers();
  };
  window.addEventListener('beforeunload', eventHandlers.beforeunload);

  // Recover from webpack chunk load errors (often caused by stale/mismatched dist assets)
  eventHandlers.unhandledrejection = function handleUnhandledRejection(/** @type {any} */ e) {
    const reason = e?.reason;
    if (maybeRecoverFromChunkLoadFailure(reason)) {
      try {
        e.preventDefault?.();
      } catch {
        // ignore
      }
    }
  };
  window.addEventListener('unhandledrejection', eventHandlers.unhandledrejection);

  eventHandlers.error = function handleWindowError(/** @type {any} */ e) {
    // Some chunk load failures surface as generic error events.
    // Prefer the Error instance if present.
    const err = e?.error || e;
    void maybeRecoverFromChunkLoadFailure(err);
  };
  window.addEventListener('error', eventHandlers.error);

  // Support HMR cleanup if module.hot is available
  if (typeof module !== 'undefined' && module.hot) {
    module.hot.dispose(() => {
      cleanupEventHandlers();
    });
  }
}

// Helper to update splash screen status
function updateSplashStatus(/** @type {any} */ message) {
  const statusEl = document.getElementById('splash-status');
  if (statusEl) {
    statusEl.textContent = message;
  }
}

// These flags prevent race conditions during HMR, StrictMode double-render, and rapid reloads
let isAppInitialized = false;
let splashRemovalInProgress = false;
let reactRoot = null;
const __REACT_ROOT_KEY__ = '__STRATOSORT_REACT_ROOT__';

function getOrCreateReactRoot(/** @type {any} */ container) {
  if (
    process.env.NODE_ENV === 'development' &&
    typeof window !== 'undefined' &&
    typeof module !== 'undefined' &&
    module.hot &&
    window[__REACT_ROOT_KEY__]
  ) {
    return window[__REACT_ROOT_KEY__];
  }
  const root = createRoot(container);
  if (
    process.env.NODE_ENV === 'development' &&
    typeof window !== 'undefined' &&
    typeof module !== 'undefined' &&
    module.hot
  ) {
    window[__REACT_ROOT_KEY__] = root;
  }
  return root;
}
const SPLASH_FADE_OUT_MS = 220;
const SPLASH_REMOVAL_FALLBACK_MS = SPLASH_FADE_OUT_MS + 160;
const SPLASH_POST_RENDER_DELAY_MS = 90;
/** Keep branded splash readable on fast machines (avoids a sub-100ms flash). Skipped when reduced motion. */
const SPLASH_MIN_VISIBLE_MS = 450;

function scheduleSplashRemoval() {
  const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

  // BrowserWindow starts with show:false until ready-to-show. While hidden,
  // Chromium throttles RAF/setTimeout (backgroundThrottling), so the animated
  // removal path may never complete and the main-process health check sees a
  // stuck splash even though React mounted. Remove synchronously — the splash
  // is not visible to the user yet anyway.
  if (typeof document !== 'undefined' && document.hidden) {
    removeSplashScreen({ immediate: true });
    return;
  }

  const delayMs = prefersReducedMotion ? 0 : SPLASH_POST_RENDER_DELAY_MS;
  const minHoldMs = prefersReducedMotion ? 0 : SPLASH_MIN_VISIBLE_MS;

  const splashAt =
    typeof window.__STRATOSORT_SPLASH_AT === 'number'
      ? window.__STRATOSORT_SPLASH_AT
      : typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
  const now =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  const minHoldRemainder = Math.max(0, minHoldMs - (now - splashAt));

  // Two RAFs gives React a full paint cycle before we fade the splash.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      setTimeout(removeSplashScreen, delayMs + minHoldRemainder);
    });
  });
}

/**
 * Safely remove the splash screen with proper guards against double removal
 * FIX: Prevents the "double splash" visual bug by ensuring removal only happens once
 */
function removeSplashScreen({ immediate = false } = {}) {
  // Guard: Don't start removal if already in progress or completed
  if (splashRemovalInProgress) {
    logger.debug('[Splash] Removal already in progress, skipping duplicate call');
    return;
  }

  const initialLoading = document.getElementById('initial-loading');
  if (!initialLoading) {
    // Already removed or never existed
    return;
  }

  splashRemovalInProgress = true;

  // Cancel the polyfill safety-net timeout — the app loaded fine
  if (typeof window.__STRATOSORT_CANCEL_SPLASH_TIMEOUT === 'function') {
    window.__STRATOSORT_CANCEL_SPLASH_TIMEOUT();
  }

  // Tear down the bootstrap error listeners now that the React error
  // boundary + the permanent handlers in this file have taken over.
  if (typeof window.__STRATOSORT_TEARDOWN_BOOT_LISTENERS === 'function') {
    try {
      window.__STRATOSORT_TEARDOWN_BOOT_LISTENERS();
    } catch {
      // Best-effort; teardown must never block splash removal.
    }
  }

  let finalized = false;
  const finalizeRemoval = () => {
    if (finalized) return;
    finalized = true;

    const element = document.getElementById('initial-loading');
    if (element) {
      element.remove();
      logger.debug('[Splash] Splash screen removed successfully');
    }

    // Route scroll through main-content to avoid layout jumps. Use the
    // ref-counted lock so modals/panels that lock/unlock on top of us don't
    // accidentally clear <html>/<body> overflow when their count hits zero.
    // A dedicated, never-released id keeps this "permanent" lock counted.
    //
    // `includeMain: false` is load-bearing: this is the *permanent* root
    // lock whose whole purpose is to keep the document root from scrolling
    // so that <main> (which has `overflow-y-auto` from AppShell) becomes
    // the app's scroll surface. If we also locked <main> here, phases
    // would be unable to scroll for the entire life of the app. Modals
    // and settings panels still acquire the default (root + main) scope
    // so the background is fully frozen while they're open.
    lockAppScroll('splash-permanent-root', { includeMain: false });
  };

  // Keep removal duration aligned with renderer motion tokens for smoother startup.
  const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  if (immediate || prefersReducedMotion) {
    initialLoading.style.pointerEvents = 'none';
    finalizeRemoval();
    return;
  }

  const fadeDuration = SPLASH_FADE_OUT_MS;

  // Add fade-out animation
  initialLoading.style.willChange = 'opacity';
  initialLoading.style.transition = `opacity ${fadeDuration}ms ease-out`;
  initialLoading.style.pointerEvents = 'none';
  initialLoading.style.opacity = '0';

  // Prefer transitionend for smoothness, with timeout fallback for reliability.
  initialLoading.addEventListener('transitionend', finalizeRemoval, { once: true });
  setTimeout(finalizeRemoval, SPLASH_REMOVAL_FALLBACK_MS);
}

// Wait for DOM to be ready before initializing React
function initializeApp() {
  // In production, init once per load. In development, allow re-entry after HMR resets
  // module scope so we can call render() again with the same persisted React root + Redux store.
  if (isAppInitialized && process.env.NODE_ENV === 'production') {
    logger.debug('[initializeApp] Already initialized, skipping duplicate call');
    return;
  }
  isAppInitialized = true;

  try {
    // Renderer bootstrap is alive; stop the polyfill timeout to avoid false
    // "startup timed out" logs on slower machines while React mounts.
    if (typeof window.__STRATOSORT_CANCEL_SPLASH_TIMEOUT === 'function') {
      window.__STRATOSORT_CANCEL_SPLASH_TIMEOUT();
    }

    updateSplashStatus('Loading local services...');

    // Debug logging in development mode
    if (process.env.NODE_ENV === 'development') {
      logger.debug('Initializing React application');
    }

    // Find the root container
    const container = document.getElementById('root');
    if (!container) {
      throw new Error(
        'Root container not found! Make sure there is a div with id="root" in the HTML.'
      );
    }

    updateSplashStatus('Preparing workspace...');

    // Debug logging in development mode
    if (process.env.NODE_ENV === 'development') {
      logger.debug('Root container found, creating React root');
    }

    reactRoot = getOrCreateReactRoot(container);

    updateSplashStatus('Opening StratoSort...');

    perfMarks.mark('startup:renderer:before-render');

    // Render the React app with global error boundary
    reactRoot.render(
      <React.StrictMode>
        <GlobalErrorBoundary>
          <Provider store={store}>
            <App />
          </Provider>
        </GlobalErrorBoundary>
      </React.StrictMode>
    );

    perfMarks.mark('startup:renderer:after-render');
    // Total time spent in the bootstrap path is surfaced in DevTools /
    // Chromium tracing without any manual correlation work.
    perfMarks.measure(
      'startup:renderer',
      'startup:renderer:module-eval',
      'startup:renderer:after-render'
    );

    scheduleSplashRemoval();

    // Debug logging in development mode
    if (process.env.NODE_ENV === 'development') {
      logger.debug('React application initialized successfully');
    }
  } catch (error) {
    logger.error('Failed to initialize React application', {
      error: error.message,
      stack: error.stack
    });

    // Show error message in the initial loading screen with polished styling
    // Security: Use textContent for error message to prevent XSS
    const initialLoading = document.getElementById('initial-loading');
    if (initialLoading) {
      const errorSection = document.createElement('section');
      errorSection.className = 'splash-error';

      const icon = document.createElement('div');
      icon.className = 'splash-error-icon';
      icon.textContent = '⚠️';
      icon.setAttribute('aria-hidden', 'true');

      const heading = document.createElement('h1');
      heading.className = 'splash-error-title';
      heading.textContent = 'Failed to load';

      const description = document.createElement('p');
      description.className = 'splash-error-message';
      description.textContent =
        'The application encountered an error during startup. Please try reloading.';

      const details = document.createElement('details');
      details.className = 'splash-error-details';

      const summary = document.createElement('summary');
      summary.textContent = 'View error details';

      const pre = document.createElement('pre');
      pre.textContent = error.message; // Safe: textContent escapes HTML

      details.appendChild(summary);
      details.appendChild(pre);
      errorSection.appendChild(icon);
      errorSection.appendChild(heading);
      errorSection.appendChild(description);
      errorSection.appendChild(details);

      // Clear existing content and show error
      while (initialLoading.firstChild) {
        initialLoading.removeChild(initialLoading.firstChild);
      }

      // Keep the background
      const bg = document.createElement('div');
      bg.className = 'splash-background';
      initialLoading.appendChild(bg);
      initialLoading.appendChild(errorSection);
    }
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeApp);
} else {
  // DOM is already ready
  initializeApp();
}
