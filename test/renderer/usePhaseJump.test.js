/**
 * @jest-environment jsdom
 */
/**
 * usePhaseJump: the one way a surface outside the phase tab strip (dashboard
 * links, File-menu pickers, the knowledge graph) moves to a step. It follows
 * the tabs' rule (uiSlice.getPhaseNavigation via planPhaseRoute) and their
 * pause while work runs. Real uiSlice rules and selectors; only the store
 * hooks are mocked.
 */
import { renderHook } from '@testing-library/react';

const mockDispatch = jest.fn();
let mockState = {};

jest.mock('../../src/renderer/store/hooks', () => ({
  useAppDispatch: jest.fn(() => mockDispatch),
  useAppSelector: jest.fn((selector) => selector(mockState))
}));

import { NAVIGATION_PAUSED_REASON, usePhaseJump } from '../../src/renderer/utils/phaseNavigation';
import { PHASE_PREREQUISITE_REASONS } from '../../src/renderer/store/slices/uiSlice';

const UNCATEGORIZED = { id: 'uncat', name: 'Uncategorized', category: 'uncategorized' };
const INVOICES = { id: 'sf-1', name: 'Invoices' };

function buildState({
  phase = 'welcome',
  viewMode = 'dashboard',
  smartFolders = [UNCATEGORIZED, INVOICES],
  selectedFiles = [],
  results = [],
  organizedFiles = [],
  isAnalyzing = false,
  isOrganizing = false,
  isLoading = false
} = {}) {
  return {
    ui: { currentPhase: phase, viewMode, isOrganizing, isLoading },
    files: { smartFolders, selectedFiles, fileStates: {}, organizedFiles, organizedPathIndex: [] },
    analysis: { isAnalyzing, results }
  };
}

function dispatched() {
  return mockDispatch.mock.calls.map(([action]) => action);
}

function setPhaseDispatches() {
  return dispatched()
    .filter((action) => action.type === 'ui/setPhase')
    .map((action) => action.payload);
}

function jump(target, options = {}) {
  const notify = jest.fn();
  const { result } = renderHook(() => usePhaseJump({ notify, ...options }));
  const reached = result.current(target);
  return { reached, notify };
}

describe('usePhaseJump', () => {
  beforeEach(() => {
    mockDispatch.mockClear();
  });

  test('leaves the dashboard, then takes each step of the route', () => {
    mockState = buildState({
      phase: 'welcome',
      selectedFiles: [{ path: '/d/a.pdf', name: 'a.pdf' }],
      results: [{ path: '/d/a.pdf', analysis: { category: 'Invoices' } }]
    });
    const { reached, notify } = jump('organize');

    expect(reached).toBe(true);
    expect(dispatched().map((a) => a.type)).toEqual([
      'ui/setViewMode',
      'ui/setCameFromDashboard',
      'ui/setPhase',
      'ui/setPhase'
    ]);
    expect(setPhaseDispatches()).toEqual(['discover', 'organize']);
    expect(notify).not.toHaveBeenCalled();
  });

  test('a returning user with organized history and an empty queue reaches Organize', () => {
    mockState = buildState({
      phase: 'welcome',
      organizedFiles: [{ originalPath: '/d/a.pdf', path: '/Invoices/a.pdf' }]
    });
    const { reached, notify } = jump('organize');

    expect(reached).toBe(true);
    expect(setPhaseDispatches()).toEqual(['discover', 'organize']);
    expect(notify).not.toHaveBeenCalled();
  });

  test('in the guided view it does not touch the view mode', () => {
    mockState = buildState({ phase: 'organize', viewMode: 'phased' });
    jump('discover');

    expect(dispatched().map((a) => a.type)).toEqual(['ui/setPhase']);
    expect(setPhaseDispatches()).toEqual(['discover']);
  });

  test('a missing prerequisite stops at the last step it may take and says why', () => {
    mockState = buildState({ phase: 'welcome' });
    const { reached, notify } = jump('organize');

    expect(reached).toBe(false);
    expect(setPhaseDispatches()).toEqual(['discover']);
    expect(notify).toHaveBeenCalledWith(PHASE_PREREQUISITE_REASONS.needsAnalyzedFile, 5200);
  });

  test.each([
    ['analysis', { isAnalyzing: true }],
    ['a file move', { isOrganizing: true }],
    ['loading', { isLoading: true }]
  ])('pauses while %s runs: no move, no view switch, and says why', (_label, busy) => {
    mockState = buildState({ phase: 'organize', ...busy });
    const { reached, notify } = jump('discover');

    expect(reached).toBe(false);
    expect(dispatched()).toEqual([]);
    expect(notify).toHaveBeenCalledWith(NAVIGATION_PAUSED_REASON, 5200);
  });

  test('pauses while undo/redo moves files', () => {
    mockState = buildState({ phase: 'organize' });
    const { reached, notify } = jump('discover', { isUndoRedoExecuting: true });

    expect(reached).toBe(false);
    expect(dispatched()).toEqual([]);
    expect(notify).toHaveBeenCalledWith(NAVIGATION_PAUSED_REASON, 5200);
  });

  test('staying on the current step still leaves the dashboard, even while busy', () => {
    mockState = buildState({ phase: 'discover', isAnalyzing: true });
    const { reached, notify } = jump('discover');

    expect(reached).toBe(true);
    expect(dispatched().map((a) => a.type)).toEqual(['ui/setViewMode', 'ui/setCameFromDashboard']);
    expect(notify).not.toHaveBeenCalled();
  });
});
