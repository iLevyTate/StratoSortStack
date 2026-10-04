// @ts-check
/** @type {Array<{ id: any, blocking: boolean }>} */
const overlayStack = [];

function removeOverlay(/** @type {any} */ id) {
  for (let i = overlayStack.length - 1; i >= 0; i--) {
    if (overlayStack[i].id === id) {
      overlayStack.splice(i, 1);
      return;
    }
  }
}

/**
 * @param {any} id
 * @param {{ blocking?: boolean }} [opts] - blocking:false marks a non-modal
 *   surface (drawer-style SidePanel: no scrim, page still interactive). It
 *   keeps its place in the stack for Escape precedence but does not veto
 *   hotkey surface swaps.
 */
export function registerOverlay(id, { blocking = true } = {}) {
  if (!id) return;
  removeOverlay(id);
  overlayStack.push({ id, blocking });
}

export function unregisterOverlay(/** @type {any} */ id) {
  if (!id) return;
  removeOverlay(id);
}

/**
 * Update an overlay's blocking flag IN PLACE. registerOverlay is
 * remove-then-push (re-registering moves an overlay to the top), so a
 * component whose blocking prop flips mid-session must use this instead —
 * re-pushing would hoist it above modals opened after it, stealing their
 * Escape precedence and the canHotkeySwapSurface veto.
 * @param {any} id
 * @param {boolean} blocking
 */
export function setOverlayBlocking(id, blocking) {
  if (!id) return;
  for (let i = overlayStack.length - 1; i >= 0; i--) {
    if (overlayStack[i].id === id) {
      overlayStack[i].blocking = Boolean(blocking);
      return;
    }
  }
}

export function isTopOverlay(/** @type {any} */ id) {
  if (!id) return false;
  return overlayStack[overlayStack.length - 1]?.id === id;
}

export function hasActiveOverlay() {
  return overlayStack.length > 0;
}

// Hotkey/tray/menu surface swaps (Ctrl+K search, Ctrl+, settings) may only
// replace the base surfaces — Settings or Knowledge OS — which close each
// other by design ("one overlay at a time"). Any other BLOCKING overlay on
// top (destructive ConfirmModal, TriageModal, consent prompt, ...) is an
// in-progress modal flow a swap would silently tear down. Non-blocking
// drawers don't count: the page (and its hotkeys) is still interactive
// beneath them, so swapping surfaces is an ordinary navigation.
export function canHotkeySwapSurface() {
  let topBlocking = null;
  for (let i = overlayStack.length - 1; i >= 0; i--) {
    if (overlayStack[i].blocking) {
      topBlocking = overlayStack[i].id;
      break;
    }
  }
  return (
    topBlocking === null || topBlocking === 'settings-panel' || topBlocking === 'knowledge-os-modal'
  );
}
