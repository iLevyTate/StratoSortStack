// @ts-check
/**
 * Per-machine UI state of the Live Activity panel: position, size, minimized
 * and the selected tab. Lives in localStorage; every read and write is
 * guarded so blocked, full or corrupt storage never breaks the panel (it
 * just opens with the defaults and keeps its layout for this session).
 *
 * Reads check each field on its own: anything that is not a usable value
 * (wrong type, not finite, a negative or zero size, an absurd coordinate)
 * falls back to the default for that field. Fitting the panel inside the
 * current window is left to the drag hook, which clamps on mount.
 */

export const LIVE_ACTIVITY_PANEL_STORAGE_KEY = 'stratosort_live_activity_panel';
export const DEFAULT_PANEL_WIDTH = 420;
export const DEFAULT_PANEL_HEIGHT = 320;
const EDGE_GAP = 16;
/** Larger than any real display; a stored value past this is corrupt. */
const MAX_STORED_PIXELS = 100000;

/**
 * @typedef {'activity' | 'raw'} LiveActivityTab
 * @typedef {{ x: number, y: number, width: number, height: number, minimized: boolean, tab: LiveActivityTab }} LiveActivityPanelState
 */

/**
 * @param {{ width: number, height: number }} viewport
 * @returns {LiveActivityPanelState}
 */
export function defaultPanelState(viewport) {
  return {
    x: Math.max(0, viewport.width - DEFAULT_PANEL_WIDTH - EDGE_GAP),
    y: Math.max(0, viewport.height - DEFAULT_PANEL_HEIGHT - EDGE_GAP),
    width: DEFAULT_PANEL_WIDTH,
    height: DEFAULT_PANEL_HEIGHT,
    minimized: false,
    tab: 'activity'
  };
}

/**
 * A stored coordinate: finite, not negative, not absurdly large.
 * @param {unknown} value
 * @returns {value is number}
 */
function isStoredCoordinate(value) {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_STORED_PIXELS
  );
}

/**
 * A stored size: finite, greater than zero, not absurdly large.
 * @param {unknown} value
 * @returns {value is number}
 */
function isStoredSize(value) {
  return isStoredCoordinate(value) && value > 0;
}

/**
 * @param {unknown} value
 * @returns {LiveActivityTab}
 */
function toTab(value) {
  return value === 'raw' ? 'raw' : 'activity';
}

/**
 * @param {{ width: number, height: number }} viewport
 * @returns {LiveActivityPanelState}
 */
export function loadPanelState(viewport) {
  const fallback = defaultPanelState(viewport);
  try {
    const raw = window.localStorage.getItem(LIVE_ACTIVITY_PANEL_STORAGE_KEY);
    if (!raw) return fallback;
    /** @type {unknown} */
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    const stored = /** @type {Record<string, unknown>} */ (parsed);
    return {
      x: isStoredCoordinate(stored.x) ? stored.x : fallback.x,
      y: isStoredCoordinate(stored.y) ? stored.y : fallback.y,
      width: isStoredSize(stored.width) ? stored.width : fallback.width,
      height: isStoredSize(stored.height) ? stored.height : fallback.height,
      minimized: stored.minimized === true,
      tab: toTab(stored.tab)
    };
  } catch {
    return fallback;
  }
}

/** @param {LiveActivityPanelState} state */
export function savePanelState(state) {
  try {
    window.localStorage.setItem(
      LIVE_ACTIVITY_PANEL_STORAGE_KEY,
      JSON.stringify({
        x: state.x,
        y: state.y,
        width: state.width,
        height: state.height,
        minimized: state.minimized === true,
        tab: toTab(state.tab)
      })
    );
  } catch {
    // Storage unavailable or full: the layout holds for this session only.
  }
}
