/**
 * @jest-environment node
 */
import {
  registerOverlay,
  unregisterOverlay,
  isTopOverlay,
  hasActiveOverlay,
  canHotkeySwapSurface,
  setOverlayBlocking
} from '../src/renderer/utils/overlayStack';

describe('overlayStack', () => {
  afterEach(() => {
    // Drain whatever a test registered.
    for (const id of ['a', 'b', 'settings-panel', 'knowledge-os-modal', 'drawer']) {
      unregisterOverlay(id);
    }
  });

  test('empty stack allows hotkey surface swaps', () => {
    expect(hasActiveOverlay()).toBe(false);
    expect(canHotkeySwapSurface()).toBe(true);
  });

  test('a blocking overlay on top vetoes swaps; base surfaces do not', () => {
    registerOverlay('settings-panel');
    expect(canHotkeySwapSurface()).toBe(true);
    registerOverlay('a'); // e.g. a nested ConfirmModal
    expect(canHotkeySwapSurface()).toBe(false);
    unregisterOverlay('a');
    expect(canHotkeySwapSurface()).toBe(true);
  });

  test('non-blocking drawers keep Escape precedence but do not veto swaps', () => {
    registerOverlay('drawer', { blocking: false });
    expect(isTopOverlay('drawer')).toBe(true); // Escape goes to the drawer
    expect(hasActiveOverlay()).toBe(true);
    expect(canHotkeySwapSurface()).toBe(true); // Ctrl+, still works

    // A drawer stacked over Knowledge OS still allows the swap (the modal
    // beneath is a base surface)...
    registerOverlay('knowledge-os-modal');
    registerOverlay('drawer', { blocking: false });
    expect(canHotkeySwapSurface()).toBe(true);

    // ...but a drawer over a blocking dialog does not unblock it.
    registerOverlay('a');
    registerOverlay('drawer', { blocking: false });
    expect(canHotkeySwapSurface()).toBe(false);
  });

  test('re-registering moves an overlay to the top', () => {
    registerOverlay('a');
    registerOverlay('b');
    expect(isTopOverlay('b')).toBe(true);
    registerOverlay('a');
    expect(isTopOverlay('a')).toBe(true);
    unregisterOverlay('a');
    unregisterOverlay('b');
    expect(hasActiveOverlay()).toBe(false);
  });

  test('setOverlayBlocking flips the flag WITHOUT reordering the stack [F-181]', () => {
    // A SidePanel whose showOverlay prop flips mid-session must not hoist
    // itself above a modal opened after it (re-registering is remove-then-
    // push). The in-place mutator keeps Escape precedence with the modal
    // while canHotkeySwapSurface sees the updated flag.
    registerOverlay('drawer', { blocking: false });
    registerOverlay('a'); // blocking modal opened after the drawer
    expect(isTopOverlay('a')).toBe(true);
    expect(canHotkeySwapSurface()).toBe(false);

    setOverlayBlocking('drawer', true);
    // Order unchanged: the modal is still on top...
    expect(isTopOverlay('a')).toBe(true);
    unregisterOverlay('a');
    // ...and once it closes, the drawer's NEW blocking flag vetoes swaps.
    expect(canHotkeySwapSurface()).toBe(false);
    setOverlayBlocking('drawer', false);
    expect(canHotkeySwapSurface()).toBe(true);
  });
});
