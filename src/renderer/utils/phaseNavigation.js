// @ts-check
/**
 * Inputs and routing for the phase rule (uiSlice.getPhaseNavigation) outside
 * the phase tab strip: the Alt+Left/Right shortcuts, the dashboard's jump
 * links, the File-menu pickers and the knowledge graph's "Go to Discover".
 * The context is built from the same values NavigationBar reads, so a
 * shortcut or a link opens a step exactly when its tab would, and pauses
 * while work runs exactly when the tabs do.
 */
import { useCallback } from 'react';
import { createSelector } from '@reduxjs/toolkit';
import { PHASES } from '../../shared/constants';
import {
  getPhaseNavigation,
  setPhase,
  setViewMode,
  setCameFromDashboard
} from '../store/slices/uiSlice';
import { selectFileStats, selectOrganizedCount, selectSmartFolders } from '../store/selectors';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { hasDestinationFolder } from './smartFolderDestinations';

/** What a phase move says while work in flight pauses navigation. */
export const NAVIGATION_PAUSED_REASON =
  'Navigation is paused until the current operation finishes.';

/**
 * The PhaseNavigationContext for getPhaseNavigation. Each field is the value
 * the matching in-phase button reads: Welcome's destination check, Setup's
 * Continue (any folder), Discover's Continue (ready count from
 * selectFileStats) and Organize's View results (organized history).
 */
export const selectPhaseNavigationContext = createSelector(
  [selectSmartFolders, selectFileStats, selectOrganizedCount],
  (smartFolders, stats, organizedCount) => ({
    hasDestinationFolder: hasDestinationFolder(smartFolders),
    hasSmartFolders: Array.isArray(smartFolders) && smartFolders.length > 0,
    hasAnalyzedFiles: (stats?.ready ?? 0) > 0,
    hasFailedFiles: (stats?.failed ?? 0) > 0,
    hasProcessedFiles: organizedCount > 0
  })
);

/**
 * Work in flight that pauses every phase move: file moves and loading
 * (NavigationBar's isBlockedByOperation). Undo/redo is the other half; it
 * lives in UndoRedoProvider state, so callers inside that provider add
 * useUndoRedo().isExecuting. A running analysis does not pause phase moves:
 * the run lives in AnalysisRunProvider above the phases and keeps going.
 * Leaving the phased view for the dashboard still waits for it
 * (selectIsAnalyzing), since the dashboard replaces that provider.
 * @param {any} state
 * @returns {boolean}
 */
export function selectIsNavigationPaused(state) {
  return Boolean(state?.ui?.isOrganizing) || Boolean(state?.ui?.isLoading);
}

/**
 * The moves to make from `fromPhase` toward `toPhase`, for a surface that
 * offers a jump to any step. One move when the rule allows it; otherwise the
 * route goes through Discover, which every phase can reach. Every move must
 * pass getPhaseNavigation, so a prerequisite is never skipped: the route stops
 * at the last step it may take and returns the reason the next one is closed.
 * While `paused`, no move is taken at all (staying put is not a move).
 *
 * @param {string} fromPhase
 * @param {string} toPhase
 * @param {import('../store/slices/uiSlice').PhaseNavigationContext} context
 * @param {{ paused?: boolean }} [options]
 * @returns {{ steps: string[], reached: boolean, reason: string | null }}
 */
export function planPhaseRoute(fromPhase, toPhase, context, { paused = false } = {}) {
  if (fromPhase === toPhase) return { steps: [], reached: true, reason: null };
  if (paused) return { steps: [], reached: false, reason: NAVIGATION_PAUSED_REASON };

  const direct = getPhaseNavigation(fromPhase, toPhase, context);
  if (direct.allowed) return { steps: [toPhase], reached: true, reason: null };

  const hub = PHASES?.DISCOVER ?? 'discover';
  if (fromPhase === hub || toPhase === hub) {
    return { steps: [], reached: false, reason: direct.reason };
  }

  const toHub = getPhaseNavigation(fromPhase, hub, context);
  if (!toHub.allowed) {
    return { steps: [], reached: false, reason: toHub.reason || direct.reason };
  }
  const fromHub = getPhaseNavigation(hub, toPhase, context);
  if (fromHub.allowed) return { steps: [hub, toPhase], reached: true, reason: null };
  return { steps: [hub], reached: false, reason: fromHub.reason };
}

/**
 * A jump to a step from outside the phase tab strip, under the tabs' rule.
 * The returned function plans the route (planPhaseRoute) and then:
 * - while paused, changes nothing and shows the pause notice;
 * - otherwise leaves the dashboard if it is showing (a breadcrumb lets the
 *   nav offer a way home), takes each allowed step, and shows the reason
 *   when a prerequisite stopped it short.
 * It returns whether the target step was reached.
 *
 * @param {{ isUndoRedoExecuting?: boolean, notify?: (message: string, duration?: number) => void }} [options]
 *   isUndoRedoExecuting: useUndoRedo().isExecuting where that provider is in
 *   scope; notify: NotificationContext's showInfo.
 * @returns {(target: string) => boolean}
 */
export function usePhaseJump({ isUndoRedoExecuting = false, notify } = {}) {
  const dispatch = useAppDispatch();
  const currentPhase = useAppSelector((/** @type {any} */ state) => state.ui?.currentPhase);
  const viewMode = useAppSelector((/** @type {any} */ state) => state.ui?.viewMode);
  const context = useAppSelector(selectPhaseNavigationContext);
  const pausedInStore = useAppSelector(selectIsNavigationPaused);
  const paused = pausedInStore || Boolean(isUndoRedoExecuting);

  return useCallback(
    (/** @type {string} */ target) => {
      const route = planPhaseRoute(currentPhase, target, context, { paused });
      if (paused && !route.reached) {
        if (route.reason) notify?.(route.reason, 5200);
        return false;
      }
      if (viewMode === 'dashboard') {
        // setViewMode clears the came-from-dashboard breadcrumb, so it must
        // be dispatched first.
        dispatch(setViewMode('phased'));
        dispatch(setCameFromDashboard(true));
      }
      for (const step of route.steps) dispatch(setPhase(step));
      if (!route.reached && route.reason) notify?.(route.reason, 5200);
      return route.reached;
    },
    [dispatch, currentPhase, viewMode, context, paused, notify]
  );
}
