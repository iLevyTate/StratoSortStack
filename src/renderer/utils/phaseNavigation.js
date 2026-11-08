// @ts-check
/**
 * Inputs and routing for the phase rule (uiSlice.getPhaseNavigation) outside
 * the phase tab strip: the Alt+Left/Right shortcuts and the dashboard's jump
 * links. The context is built from the same values NavigationBar reads, so a
 * shortcut or a dashboard link opens a step exactly when its tab would.
 */
import { createSelector } from '@reduxjs/toolkit';
import { PHASES } from '../../shared/constants';
import { getPhaseNavigation } from '../store/slices/uiSlice';
import { selectFileStats, selectOrganizedCount, selectSmartFolders } from '../store/selectors';
import { hasDestinationFolder } from './smartFolderDestinations';

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
 * The moves to make from `fromPhase` toward `toPhase`, for a surface that
 * offers a jump to any step. One move when the rule allows it; otherwise the
 * route goes through Discover, which every phase can reach. Every move must
 * pass getPhaseNavigation, so a prerequisite is never skipped: the route stops
 * at the last step it may take and returns the reason the next one is closed.
 *
 * @param {string} fromPhase
 * @param {string} toPhase
 * @param {import('../store/slices/uiSlice').PhaseNavigationContext} context
 * @returns {{ steps: string[], reached: boolean, reason: string | null }}
 */
export function planPhaseRoute(fromPhase, toPhase, context) {
  if (fromPhase === toPhase) return { steps: [], reached: true, reason: null };

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
