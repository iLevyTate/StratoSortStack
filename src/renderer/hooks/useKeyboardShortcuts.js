// @ts-check
import { useEffect, useCallback, useMemo, useRef } from 'react';
import { createLogger } from '../../shared/logger';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { openSettings, setPhase, getPhaseNavigation } from '../store/slices/uiSlice';
import { useNotification } from '../contexts/NotificationContext';
import { useUndoRedo } from '../components/UndoRedoSystem';
import { PHASES, PHASE_METADATA, PHASE_ORDER } from '../../shared/constants';
import { TIMEOUTS } from '../../shared/performanceConstants';
import { canHotkeySwapSurface, hasActiveOverlay, isTopOverlay } from '../utils/overlayStack';
import { isEditableTarget } from '../utils/isEditableTarget';
import { dispatchAcked } from '../utils/dispatchAcked';
import { toggleShowLiveActivity } from '../store/thunks/liveActivityThunks';
import {
  NAVIGATION_PAUSED_REASON,
  selectIsNavigationPaused,
  selectPhaseNavigationContext,
  usePhaseJump
} from '../utils/phaseNavigation';

const logger = createLogger('useKeyboardShortcuts');

export function useKeyboardShortcuts() {
  const dispatch = useAppDispatch();
  const currentPhase = useAppSelector((/** @type {any} */ state) => state.ui.currentPhase);
  const showSettings = useAppSelector((/** @type {any} */ state) => state.ui.showSettings);
  const viewMode = useAppSelector((/** @type {any} */ state) => state.ui.viewMode);
  // Same inputs the phase tabs read, so Alt+Left/Right open a step exactly
  // when its tab would.
  const navContext = useAppSelector(selectPhaseNavigationContext);
  const { addNotification, showInfo } = useNotification();
  // This ensures state callbacks (onUndo/onRedo) are invoked, updating UI properly
  const {
    undo: undoAction,
    redo: redoAction,
    canUndo,
    canRedo,
    isExecuting: isUndoRedoExecuting
  } = useUndoRedo();

  // Use refs to avoid re-attaching event listeners when these values change
  const currentPhaseRef = useRef(currentPhase);
  const showSettingsRef = useRef(showSettings);
  const viewModeRef = useRef(viewMode);
  const navContextRef = useRef(navContext);
  // Same busy test as NavigationBar's isBlockedByOperation.
  const isBusyInStore = useAppSelector(selectIsNavigationPaused);
  const isBusy = isBusyInStore || Boolean(isUndoRedoExecuting);
  // File-menu pickers reach Discover the way a dashboard link does: under the
  // tabs' rule and pause, leaving the dashboard so the move is visible.
  const jumpToPhase = usePhaseJump({ isUndoRedoExecuting, notify: showInfo });
  const jumpToPhaseRef = useRef(jumpToPhase);
  const busyRef = useRef(isBusy);
  const undoActionRef = useRef(undoAction);
  const redoActionRef = useRef(redoAction);
  const canUndoRef = useRef(canUndo);
  const canRedoRef = useRef(canRedo);

  // Keep refs in sync
  useEffect(() => {
    currentPhaseRef.current = currentPhase;
  }, [currentPhase]);
  useEffect(() => {
    showSettingsRef.current = showSettings;
  }, [showSettings]);
  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);
  useEffect(() => {
    navContextRef.current = navContext;
  }, [navContext]);
  useEffect(() => {
    busyRef.current = isBusy;
  }, [isBusy]);
  useEffect(() => {
    jumpToPhaseRef.current = jumpToPhase;
  }, [jumpToPhase]);
  useEffect(() => {
    undoActionRef.current = undoAction;
  }, [undoAction]);
  useEffect(() => {
    redoActionRef.current = redoAction;
  }, [redoAction]);
  useEffect(() => {
    canUndoRef.current = canUndo;
  }, [canUndo]);
  useEffect(() => {
    canRedoRef.current = canRedo;
  }, [canRedo]);

  const handleOpenSettings = useCallback(() => dispatch(openSettings()), [dispatch]);
  const handleAdvancePhase = useCallback(
    (/** @type {any} */ phase) => dispatch(setPhase(phase)),
    [dispatch]
  );
  const requestCloseSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent('app:close-settings-request'));
  }, []);

  const handleToggleLiveActivity = useCallback(() => {
    dispatch(/** @type {any} */ (toggleShowLiveActivity()));
  }, [dispatch]);

  const actions = useMemo(
    () => ({
      openSettings: handleOpenSettings,
      requestCloseSettings,
      advancePhase: handleAdvancePhase,
      toggleLiveActivity: handleToggleLiveActivity
    }),
    [handleOpenSettings, requestCloseSettings, handleAdvancePhase, handleToggleLiveActivity]
  );

  useEffect(() => {
    const handleKeyDown = async (/** @type {any} */ event) => {
      if (event.defaultPrevented) return;

      const settingsShortcut = (event.ctrlKey || event.metaKey) && event.key === ',';
      if (settingsShortcut) {
        event.preventDefault();
        if (showSettingsRef.current) {
          if (isTopOverlay('settings-panel')) {
            actions.requestCloseSettings();
          }
        } else if (canHotkeySwapSurface()) {
          // Same guard as Ctrl+K: opening Settings closes Knowledge OS
          // (one overlay at a time), which would also unmount any dialog
          // nested inside it (destructive ConfirmModal, TriageModal, ...)
          // mid-flow.
          actions.openSettings();
        }
        return;
      }

      // Ctrl/Cmd+Shift+L: show or hide the Live Activity panel. Like Ctrl+,
      // it works from anywhere (text fields, open overlays, either experience
      // mode) — it only flips a setting and has no text-editing meaning.
      // Matched by the L the layout types; the physical key (`code`) is only
      // a fallback when the layout types no Latin letter there (Cyrillic,
      // Greek, ...), so Dvorak's Ctrl+Shift+N on that key never toggles.
      // Auto-repeat is claimed but ignored, so holding the keys toggles once.
      const shortcutKey = String(event.key || '').toLowerCase();
      const isLKey = shortcutKey === 'l' || (!/^[a-z]$/.test(shortcutKey) && event.code === 'KeyL');
      const liveActivityShortcut =
        (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && isLKey;
      if (liveActivityShortcut) {
        event.preventDefault();
        if (!event.repeat) {
          actions.toggleLiveActivity();
        }
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }

      // File-op undo/redo and Alt+Arrow phase jumps must not fire while a
      // modal/settings overlay owns the screen — they mutate state behind the
      // dialog and feel like the app is ignoring the open UI.
      if (hasActiveOverlay()) {
        return;
      }

      // Ctrl/Cmd + Z for Undo
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        try {
          // Use the React UndoRedo system which invokes stateCallbacks (onUndo)
          // This ensures the UI state is properly updated after the operation
          if (canUndoRef.current && undoActionRef.current) {
            await undoActionRef.current();
          } else {
            logger.debug('Undo shortcut: nothing to undo');
          }
        } catch (error) {
          logger.error('Undo shortcut failed', {
            error: error.message,
            stack: error.stack
          });
        }
      }

      // Ctrl/Cmd + Shift + Z for Redo (also support Ctrl+Y on Windows)
      if (
        (event.ctrlKey || event.metaKey) &&
        ((event.key.toLowerCase() === 'z' && event.shiftKey) || event.key.toLowerCase() === 'y')
      ) {
        event.preventDefault();
        try {
          // Use the React UndoRedo system which invokes stateCallbacks (onRedo)
          // This ensures the UI state is properly updated after the operation
          if (canRedoRef.current && redoActionRef.current) {
            await redoActionRef.current();
          } else {
            logger.debug('Redo shortcut: nothing to redo');
          }
        } catch (error) {
          logger.error('Redo shortcut failed', {
            error: error.message,
            stack: error.stack
          });
        }
      }

      // Alt + Arrow keys for phase navigation: the keyboard twin of the phase
      // tabs, under the same rule (uiSlice.getPhaseNavigation). Back is always
      // open; forward needs the step being left to pass its Continue check.
      // A refused move stays put and gives the reason the tab's tooltip gives.
      // Inert in dashboard view mode: the phase tab strip is hidden there, so a
      // keyboard phase jump would change state invisibly under the dashboard.
      if (
        event.altKey &&
        (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
        viewModeRef.current !== 'dashboard'
      ) {
        event.preventDefault();
        const phase = currentPhaseRef.current;
        const phases = PHASE_ORDER || (PHASES ? Object.values(PHASES) : []);
        const currentIndex = phases.indexOf(phase);
        const targetIndex = event.key === 'ArrowLeft' ? currentIndex - 1 : currentIndex + 1;
        if (currentIndex < 0 || targetIndex < 0 || targetIndex >= phases.length) return;

        // Paused while work is in flight, exactly like the phase tabs.
        if (busyRef.current) {
          showInfo(NAVIGATION_PAUSED_REASON, 5200);
          return;
        }
        const targetPhase = phases[targetIndex];
        const navigation = getPhaseNavigation(phase, targetPhase, navContextRef.current);
        if (!navigation.allowed) {
          if (navigation.reason) showInfo(navigation.reason, 5200);
          return;
        }
        actions.advancePhase(targetPhase);
        addNotification(
          `Navigated to ${PHASE_METADATA[targetPhase]?.title || targetPhase}`,
          'info',
          2000
        );
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
    // Only re-attach when actions or the notifiers change (all memoized/stable)
  }, [actions, addNotification, showInfo]);

  // Handle menu actions from main process (File menu shortcuts)
  useEffect(() => {
    // One live retry loop per bridge event: a second trigger inside the retry
    // window cancels the first (double menu click otherwise queued TWO file
    // dialogs once DiscoverPhase mounted), and unmount cancels whatever is
    // still pending so no orphaned loop fires a surprise picker later.
    /** @type {Map<string, () => void>} */
    const pendingDispatches = new Map();
    const dispatchAckedOnce = (/** @type {string} */ eventName) => {
      pendingDispatches.get(eventName)?.();
      pendingDispatches.set(
        eventName,
        dispatchAcked(eventName, { intervalMs: TIMEOUTS.WINDOW_LOAD_DELAY || 100 })
      );
    };

    const dispatchDiscoverEvent = (/** @type {any} */ eventName) => {
      // This hook is App-level, so it is active on the dashboard surface —
      // where phases render nothing. The jump leaves the dashboard first, or
      // the phase change (and the picker event) fires invisibly beneath it.
      // Getting to Discover is a phase move: it follows the tabs' rule and
      // pauses while work runs, and a refused move opens no picker.
      if (!jumpToPhaseRef.current(PHASES?.DISCOVER ?? 'discover')) return;
      // Retry-until-acked: DiscoverPhase is a lazy chunk, so a single
      // fixed-delay dispatch silently dropped the picker action whenever the
      // chunk took longer than one tick to mount (cold renderer), and right
      // after a phase switch it may still be mid-load.
      dispatchAckedOnce(eventName);
    };

    const cleanup = window.electronAPI?.events?.onMenuAction?.((/** @type {any} */ action) => {
      switch (action) {
        case 'open-settings':
          // File-menu path needs the same nested-dialog guard as Ctrl+, above.
          if (canHotkeySwapSurface()) {
            actions.openSettings();
          }
          break;
        case 'select-files':
          dispatchDiscoverEvent('app:select-files');
          break;
        case 'select-folder':
          dispatchDiscoverEvent('app:select-folder');
          break;
        default:
          logger.debug('Unknown menu action:', action);
      }
    });
    return () => {
      for (const cancel of pendingDispatches.values()) cancel();
      pendingDispatches.clear();
      cleanup?.();
    };
  }, [actions]);

  // Listen for undo/redo state changes from main process and dispatch DOM event
  // NOTE: Since we now use the React UndoRedo system for keyboard shortcuts,
  // the stateCallbacks (onUndo/onRedo) handle UI updates and notifications.
  // This listener is kept for external triggers (e.g., if undo/redo is called
  // from main process menu) but doesn't show notifications to avoid duplicates.
  useEffect(() => {
    const cleanup = window.electronAPI?.undoRedo?.onStateChanged?.((/** @type {any} */ data) => {
      logger.debug('Undo/redo state changed (from main process):', data);
      // Dispatch custom event for any components that need to know about state changes
      window.dispatchEvent(new CustomEvent('app:undo-redo-state-changed', { detail: data }));
      // NOTE: Notifications are handled by the React UndoRedo system's undo/redo methods
      // to avoid duplicate notifications
    });
    return cleanup;
  }, []);
}
