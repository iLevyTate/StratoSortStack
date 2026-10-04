/**
 * E2E keyboard shortcuts — focus the main app surface before global shortcuts so
 * handlers (e.g. Ctrl+K) are not skipped when focus is in an editable control.
 */

const { focusAppForKeyboardShortcuts } = require('./electronApp');

async function pressOpenSearchShortcut(window) {
  await focusAppForKeyboardShortcuts(window);
  if (typeof window.isClosed === 'function' && window.isClosed()) return;
  await window.keyboard.press('Control+k');
}

module.exports = {
  pressOpenSearchShortcut,
  focusAppForKeyboardShortcuts
};
