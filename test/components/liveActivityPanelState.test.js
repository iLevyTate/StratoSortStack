/**
 * Per-machine UI state of the Live Activity panel. Storage can be blocked or
 * full; the panel must still open with sensible defaults.
 */
import {
  LIVE_ACTIVITY_PANEL_STORAGE_KEY,
  defaultPanelState,
  loadPanelState,
  savePanelState
} from '../../src/renderer/components/diagnostics/liveActivityPanelState';

const VIEWPORT = { width: 1200, height: 900 };

describe('liveActivityPanelState', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('uses the documented storage key', () => {
    expect(LIVE_ACTIVITY_PANEL_STORAGE_KEY).toBe('stratosort_live_activity_panel');
  });

  test('defaults to the bottom-right corner, expanded, on the Activity tab', () => {
    expect(defaultPanelState(VIEWPORT)).toEqual({
      x: 764,
      y: 564,
      width: 420,
      height: 320,
      minimized: false,
      tab: 'activity'
    });
  });

  test('the default position never goes negative in a tiny window', () => {
    const state = defaultPanelState({ width: 300, height: 200 });
    expect(state.x).toBe(0);
    expect(state.y).toBe(0);
  });

  test('loads the defaults when nothing is stored', () => {
    expect(loadPanelState(VIEWPORT)).toEqual(defaultPanelState(VIEWPORT));
  });

  test('round-trips a saved state', () => {
    const state = { x: 10, y: 20, width: 500, height: 400, minimized: true, tab: 'raw' };
    savePanelState(state);
    expect(loadPanelState(VIEWPORT)).toEqual(state);
  });

  test('saves only the known fields', () => {
    savePanelState({
      x: 1,
      y: 2,
      width: 330,
      height: 230,
      minimized: false,
      tab: 'activity',
      extra: 'nope'
    });
    const stored = JSON.parse(window.localStorage.getItem(LIVE_ACTIVITY_PANEL_STORAGE_KEY));
    expect(Object.keys(stored).sort()).toEqual(
      ['height', 'minimized', 'tab', 'width', 'x', 'y'].sort()
    );
  });

  test('falls back field by field on garbage values', () => {
    window.localStorage.setItem(
      LIVE_ACTIVITY_PANEL_STORAGE_KEY,
      JSON.stringify({ x: 'a', y: 5, width: null, tab: 'other', minimized: 'yes' })
    );
    expect(loadPanelState(VIEWPORT)).toEqual({
      x: 764,
      y: 5,
      width: 420,
      height: 320,
      minimized: false,
      tab: 'activity'
    });
  });

  test('falls back field by field on numbers outside a sane range', () => {
    // 1e400 parses to Infinity; negative or zero sizes and absurd coordinates
    // are corrupt values, not a layout to restore.
    window.localStorage.setItem(
      LIVE_ACTIVITY_PANEL_STORAGE_KEY,
      '{"x":-40,"y":1e400,"width":0,"height":-5,"minimized":true,"tab":"raw"}'
    );
    expect(loadPanelState(VIEWPORT)).toEqual({
      x: 764,
      y: 564,
      width: 420,
      height: 320,
      minimized: true,
      tab: 'raw'
    });

    window.localStorage.setItem(
      LIVE_ACTIVITY_PANEL_STORAGE_KEY,
      JSON.stringify({ x: 5e9, y: 12, width: 5e9, height: 300 })
    );
    expect(loadPanelState(VIEWPORT)).toMatchObject({ x: 764, y: 12, width: 420, height: 300 });
  });

  test('keeps a stored position even when it lies outside the current window', () => {
    // Clamping to the window is the drag hook's job; storage only rejects
    // values that cannot be a real layout.
    savePanelState({ x: 3000, y: 2000, width: 500, height: 400, minimized: false, tab: 'raw' });
    expect(loadPanelState(VIEWPORT)).toMatchObject({ x: 3000, y: 2000 });
  });

  test.each([['not json'], ['[1,2,3]'], ['null'], ['42'], ['"text"']])(
    'ignores stored text that is not a state object: %s',
    (stored) => {
      window.localStorage.setItem(LIVE_ACTIVITY_PANEL_STORAGE_KEY, stored);
      expect(loadPanelState(VIEWPORT)).toEqual(defaultPanelState(VIEWPORT));
    }
  );

  test('survives storage that throws on read and on write', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });

    expect(loadPanelState(VIEWPORT)).toEqual(defaultPanelState(VIEWPORT));
    expect(() => savePanelState(defaultPanelState(VIEWPORT))).not.toThrow();
  });
});
