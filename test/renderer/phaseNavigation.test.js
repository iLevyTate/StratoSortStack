/**
 * @jest-environment node
 */
/**
 * utils/phaseNavigation: the phase-rule inputs built from store state (the
 * values NavigationBar reads) and the route a jump link takes under that rule.
 */
import {
  NAVIGATION_PAUSED_REASON,
  planPhaseRoute,
  selectIsNavigationPaused,
  selectPhaseNavigationContext
} from '../../src/renderer/utils/phaseNavigation';
import { PHASE_PREREQUISITE_REASONS } from '../../src/renderer/store/slices/uiSlice';

const UNCATEGORIZED = { id: 'uncat', name: 'Uncategorized', category: 'uncategorized' };
const INVOICES = { id: 'sf-1', name: 'Invoices' };

function state({ smartFolders = [], selectedFiles = [], results = [], organizedFiles = [] } = {}) {
  return {
    files: { smartFolders, selectedFiles, fileStates: {}, organizedFiles, organizedPathIndex: [] },
    analysis: { results }
  };
}

describe('selectPhaseNavigationContext', () => {
  test('Uncategorized alone is a smart folder but not a destination', () => {
    expect(selectPhaseNavigationContext(state({ smartFolders: [UNCATEGORIZED] }))).toEqual({
      hasDestinationFolder: false,
      hasSmartFolders: true,
      hasAnalyzedFiles: false,
      hasFailedFiles: false,
      hasProcessedFiles: false
    });
  });

  test('reads analyzed, failed and organized files', () => {
    const ctx = selectPhaseNavigationContext(
      state({
        smartFolders: [UNCATEGORIZED, INVOICES],
        selectedFiles: [
          { path: '/d/a.pdf', name: 'a.pdf' },
          { path: '/d/b.pdf', name: 'b.pdf' }
        ],
        results: [
          { path: '/d/a.pdf', analysis: { category: 'Invoices' } },
          { path: '/d/b.pdf', error: 'boom' }
        ],
        organizedFiles: [{ originalPath: '/d/c.pdf', path: '/Invoices/c.pdf' }]
      })
    );
    expect(ctx).toEqual({
      hasDestinationFolder: true,
      hasSmartFolders: true,
      hasAnalyzedFiles: true,
      hasFailedFiles: true,
      hasProcessedFiles: true
    });
  });
});

describe('planPhaseRoute', () => {
  const ready = {
    hasDestinationFolder: true,
    hasSmartFolders: true,
    hasAnalyzedFiles: true,
    hasProcessedFiles: true
  };

  test('staying put takes no step', () => {
    expect(planPhaseRoute('discover', 'discover', {})).toEqual({
      steps: [],
      reached: true,
      reason: null
    });
  });

  test('one allowed move is taken directly', () => {
    expect(planPhaseRoute('welcome', 'setup', {})).toEqual({
      steps: ['setup'],
      reached: true,
      reason: null
    });
  });

  test('going back is always one move', () => {
    expect(planPhaseRoute('complete', 'setup', {})).toEqual({
      steps: ['setup'],
      reached: true,
      reason: null
    });
  });

  test('a step the graph does not offer goes through Discover', () => {
    expect(planPhaseRoute('welcome', 'organize', ready)).toEqual({
      steps: ['discover', 'organize'],
      reached: true,
      reason: null
    });
    expect(planPhaseRoute('setup', 'complete', ready).steps).toEqual(['discover']);
  });

  test('stops at Discover when the next hop is closed, with its reason', () => {
    expect(planPhaseRoute('welcome', 'organize', { hasDestinationFolder: true })).toEqual({
      steps: ['discover'],
      reached: false,
      reason: PHASE_PREREQUISITE_REASONS.needsAnalyzedFile
    });
  });

  test('takes no step when even Discover is closed', () => {
    expect(planPhaseRoute('welcome', 'organize', {})).toEqual({
      steps: [],
      reached: false,
      reason: PHASE_PREREQUISITE_REASONS.needsDestination
    });
  });

  test('from Discover a closed Organize takes no step', () => {
    expect(planPhaseRoute('discover', 'organize', { hasFailedFiles: true })).toEqual({
      steps: [],
      reached: false,
      reason: PHASE_PREREQUISITE_REASONS.allAnalysisFailed
    });
  });
});

describe('returning user: organized history, empty queue', () => {
  // The 24h state expiry resets the phase to Welcome and clears the queue,
  // but keeps the organized history.
  const returning = {
    hasDestinationFolder: true,
    hasSmartFolders: true,
    hasAnalyzedFiles: false,
    hasFailedFiles: false,
    hasProcessedFiles: true
  };

  test('Organize is reachable from Welcome, Setup and Discover', () => {
    expect(planPhaseRoute('welcome', 'organize', returning)).toEqual({
      steps: ['discover', 'organize'],
      reached: true,
      reason: null
    });
    expect(planPhaseRoute('setup', 'organize', returning).reached).toBe(true);
    expect(planPhaseRoute('discover', 'organize', returning)).toEqual({
      steps: ['organize'],
      reached: true,
      reason: null
    });
  });

  test('Complete opens from Organize', () => {
    expect(planPhaseRoute('organize', 'complete', returning)).toEqual({
      steps: ['complete'],
      reached: true,
      reason: null
    });
  });
});

describe('navigation pause', () => {
  const ready = {
    hasDestinationFolder: true,
    hasSmartFolders: true,
    hasAnalyzedFiles: true,
    hasProcessedFiles: true
  };

  test('a paused route takes no step and says why, even going back', () => {
    for (const [from, to] of [
      ['welcome', 'organize'],
      ['discover', 'organize'],
      ['complete', 'setup']
    ]) {
      expect(planPhaseRoute(from, to, ready, { paused: true })).toEqual({
        steps: [],
        reached: false,
        reason: NAVIGATION_PAUSED_REASON
      });
    }
  });

  test('staying put is not a move, so a pause does not refuse it', () => {
    expect(planPhaseRoute('discover', 'discover', ready, { paused: true })).toEqual({
      steps: [],
      reached: true,
      reason: null
    });
  });

  test('the pause text is the one the tabs and Alt+arrows give', () => {
    expect(NAVIGATION_PAUSED_REASON).toBe(
      'Navigation is paused until the current operation finishes.'
    );
  });

  test('selectIsNavigationPaused reads moves and loading; a running analysis does not pause', () => {
    expect(selectIsNavigationPaused({ ui: {}, analysis: {} })).toBe(false);
    expect(selectIsNavigationPaused({ ui: { isOrganizing: true }, analysis: {} })).toBe(true);
    expect(selectIsNavigationPaused({ ui: { isLoading: true }, analysis: {} })).toBe(true);
    // The run lives in AnalysisRunProvider above the phases and keeps going.
    expect(selectIsNavigationPaused({ ui: {}, analysis: { isAnalyzing: true } })).toBe(false);
  });
});
