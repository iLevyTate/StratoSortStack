/**
 * Tests for useKeyboardShortcuts hook
 * Covers: undo/redo, settings toggle, escape, phase navigation, menu actions
 */

import React from 'react';
import { renderHook, act } from '@testing-library/react';

// Mock dependencies before importing the hook
const mockDispatch = jest.fn();
const mockUndo = jest.fn().mockResolvedValue(undefined);
const mockRedo = jest.fn().mockResolvedValue(undefined);
const mockAddNotification = jest.fn();
let mockCurrentPhase = 'discover';
let mockShowSettings = false;
let mockViewMode = 'phased';
let mockCanUndo = true;
let mockCanRedo = true;

jest.mock('../src/shared/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }))
}));

jest.mock('../src/renderer/store/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector) =>
    selector({
      ui: {
        currentPhase: mockCurrentPhase,
        showSettings: mockShowSettings,
        viewMode: mockViewMode
      }
    })
}));

jest.mock('../src/renderer/store/slices/uiSlice', () => ({
  openSettings: jest.fn(() => ({ type: 'ui/openSettings' })),
  setPhase: jest.fn((phase) => ({ type: 'ui/setPhase', payload: phase })),
  setViewMode: jest.fn((mode) => ({ type: 'ui/setViewMode', payload: mode })),
  setCameFromDashboard: jest.fn((value) => ({
    type: 'ui/setCameFromDashboard',
    payload: value
  })),
  canTransitionTo: jest.fn(() => true)
}));

jest.mock('../src/renderer/contexts/NotificationContext', () => ({
  useNotification: () => ({ addNotification: mockAddNotification })
}));

jest.mock('../src/renderer/components/UndoRedoSystem', () => ({
  useUndoRedo: () => ({
    undo: mockUndo,
    redo: mockRedo,
    canUndo: mockCanUndo,
    canRedo: mockCanRedo
  })
}));

jest.mock('../src/shared/performanceConstants', () => ({
  TIMEOUTS: { WINDOW_LOAD_DELAY: 100 }
}));

jest.mock('../src/renderer/utils/overlayStack', () => ({
  isTopOverlay: jest.fn(() => true),
  canHotkeySwapSurface: jest.fn(() => true),
  hasActiveOverlay: jest.fn(() => false)
}));

jest.mock('../src/shared/constants', () => ({
  PHASES: {
    WELCOME: 'welcome',
    DISCOVER: 'discover',
    ORGANIZE: 'organize'
  },
  PHASE_TRANSITIONS: {
    welcome: ['discover'],
    discover: ['welcome', 'organize'],
    organize: ['discover']
  },
  PHASE_METADATA: {
    welcome: { title: 'Welcome' },
    discover: { title: 'Discover' },
    organize: { title: 'Organize' }
  }
}));

// Import after mocks
import { useKeyboardShortcuts } from '../src/renderer/hooks/useKeyboardShortcuts';
import { hasActiveOverlay } from '../src/renderer/utils/overlayStack';

describe('useKeyboardShortcuts', () => {
  let keydownHandler;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCurrentPhase = 'discover';
    mockShowSettings = false;
    mockViewMode = 'phased';
    mockCanUndo = true;
    mockCanRedo = true;
    hasActiveOverlay.mockReturnValue(false);

    // Capture the keydown handler registered on document
    jest.spyOn(document, 'addEventListener').mockImplementation((event, handler) => {
      if (event === 'keydown') keydownHandler = handler;
    });
    jest.spyOn(document, 'removeEventListener').mockImplementation(() => {});

    global.window.electronAPI = {
      events: { onMenuAction: jest.fn() },
      undoRedo: { onStateChanged: jest.fn() }
    };
  });

  afterEach(() => {
    document.addEventListener.mockRestore?.();
    document.removeEventListener.mockRestore?.();
  });

  function renderShortcuts() {
    return renderHook(() => useKeyboardShortcuts());
  }

  function fireKey(key, modifiers = {}) {
    const event = {
      key,
      ctrlKey: modifiers.ctrl || false,
      metaKey: modifiers.meta || false,
      shiftKey: modifiers.shift || false,
      altKey: modifiers.alt || false,
      preventDefault: jest.fn()
    };
    if (keydownHandler) keydownHandler(event);
    return event;
  }

  describe('Ctrl+Z (Undo)', () => {
    test('calls undo action when canUndo is true', async () => {
      renderShortcuts();
      await act(async () => {
        fireKey('z', { ctrl: true });
      });
      expect(mockUndo).toHaveBeenCalled();
    });

    test('does not call undo when canUndo is false', async () => {
      mockCanUndo = false;
      renderShortcuts();
      await act(async () => {
        fireKey('z', { ctrl: true });
      });
      expect(mockUndo).not.toHaveBeenCalled();
    });

    test('prevents default on Ctrl+Z', async () => {
      renderShortcuts();
      let event;
      await act(async () => {
        event = fireKey('z', { ctrl: true });
      });
      expect(event.preventDefault).toHaveBeenCalled();
    });

    test('does not undo while an overlay is open', async () => {
      hasActiveOverlay.mockReturnValue(true);
      renderShortcuts();
      await act(async () => {
        fireKey('z', { ctrl: true });
      });
      expect(mockUndo).not.toHaveBeenCalled();
    });
  });

  describe('Ctrl+Shift+Z / Ctrl+Y (Redo)', () => {
    test('calls redo with Ctrl+Shift+Z', async () => {
      renderShortcuts();
      await act(async () => {
        fireKey('z', { ctrl: true, shift: true });
      });
      expect(mockRedo).toHaveBeenCalled();
    });

    test('calls redo with Ctrl+Y', async () => {
      renderShortcuts();
      await act(async () => {
        fireKey('y', { ctrl: true });
      });
      expect(mockRedo).toHaveBeenCalled();
    });

    test('does not call redo when canRedo is false', async () => {
      mockCanRedo = false;
      renderShortcuts();
      await act(async () => {
        fireKey('z', { ctrl: true, shift: true });
      });
      expect(mockRedo).not.toHaveBeenCalled();
    });
  });

  describe('Ctrl+, (Settings)', () => {
    test('opens settings when settings are closed', () => {
      renderShortcuts();
      const event = fireKey(',', { ctrl: true });
      expect(event.preventDefault).toHaveBeenCalled();
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/openSettings' });
    });

    test('does not open settings while a non-swappable overlay is on top', () => {
      // A nested dialog (destructive ConfirmModal, TriageModal, ...) is on
      // top: opening Settings would close Knowledge OS underneath it and
      // unmount the in-progress flow.
      const { canHotkeySwapSurface } = require('../src/renderer/utils/overlayStack');
      canHotkeySwapSurface.mockReturnValueOnce(false);
      renderShortcuts();
      fireKey(',', { ctrl: true });
      expect(mockDispatch).not.toHaveBeenCalledWith({ type: 'ui/openSettings' });
    });
  });

  describe('Ctrl+, (Close Settings Request)', () => {
    test('requests settings close when settings are already open', () => {
      mockShowSettings = true;
      const dispatchEventSpy = jest.spyOn(window, 'dispatchEvent');
      renderShortcuts();
      const event = fireKey(',', { ctrl: true });
      expect(event.preventDefault).toHaveBeenCalled();
      expect(dispatchEventSpy).toHaveBeenCalledWith(expect.any(CustomEvent));
      expect(dispatchEventSpy.mock.calls.at(-1)?.[0]?.type).toBe('app:close-settings-request');
      dispatchEventSpy.mockRestore();
    });

    test('does not dispatch settings actions on Escape when settings are closed', () => {
      mockShowSettings = false;
      renderShortcuts();
      fireKey('Escape');
      expect(mockDispatch).not.toHaveBeenCalledWith({ type: 'ui/openSettings' });
    });
  });

  describe('Alt+Arrow phase navigation', () => {
    test('Alt+ArrowRight advances to next phase', () => {
      mockCurrentPhase = 'discover';
      renderShortcuts();
      const event = fireKey('ArrowRight', { alt: true });
      expect(event.preventDefault).toHaveBeenCalled();
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setPhase', payload: 'organize' });
      expect(mockAddNotification).toHaveBeenCalledWith(
        expect.stringContaining('Organize'),
        'info',
        2000
      );
    });

    test('Alt+ArrowLeft goes to previous phase', () => {
      mockCurrentPhase = 'discover';
      renderShortcuts();
      const event = fireKey('ArrowLeft', { alt: true });
      expect(event.preventDefault).toHaveBeenCalled();
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setPhase', payload: 'welcome' });
    });

    test('does not navigate past the last phase', () => {
      mockCurrentPhase = 'organize';
      renderShortcuts();
      fireKey('ArrowRight', { alt: true });
      // Should not dispatch setPhase since organize is the last phase
      expect(mockDispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ui/setPhase' })
      );
    });

    test('does not navigate before the first phase', () => {
      mockCurrentPhase = 'welcome';
      renderShortcuts();
      fireKey('ArrowLeft', { alt: true });
      expect(mockDispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ui/setPhase' })
      );
    });
  });

  describe('Alt+Arrow in dashboard view mode', () => {
    // The dashboard surface hides the phase tab strip, blocked banner, and
    // Brand step subtitle. The Alt+Arrow shortcut is the keyboard twin of a
    // phase tab, so it must be inert exactly when those tabs are hidden —
    // otherwise it fires an invisible phase change plus a misleading toast.
    test('still navigates phases in phased view mode (control)', () => {
      mockViewMode = 'phased';
      mockCurrentPhase = 'discover';
      renderShortcuts();
      fireKey('ArrowRight', { alt: true });
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setPhase', payload: 'organize' });
    });

    test('Alt+ArrowRight is a no-op in dashboard mode', () => {
      mockViewMode = 'dashboard';
      mockCurrentPhase = 'discover';
      renderShortcuts();
      fireKey('ArrowRight', { alt: true });
      expect(mockDispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ui/setPhase' })
      );
      expect(mockAddNotification).not.toHaveBeenCalled();
    });

    test('Alt+ArrowLeft is a no-op in dashboard mode', () => {
      mockViewMode = 'dashboard';
      mockCurrentPhase = 'discover';
      renderShortcuts();
      fireKey('ArrowLeft', { alt: true });
      expect(mockDispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ui/setPhase' })
      );
      expect(mockAddNotification).not.toHaveBeenCalled();
    });
  });

  describe('menu file-picker actions from dashboard mode', () => {
    // The hook now lives at App level, so it is active on the dashboard —
    // where phases render nothing. A File-menu picker action must leave the
    // dashboard first, or the phase change (and the picker event) fires
    // invisibly beneath it.
    function fireMenuAction(action) {
      const handler = global.window.electronAPI.events.onMenuAction.mock.calls[0][0];
      act(() => handler(action));
    }

    test('select-files leaves the dashboard before jumping to discover', () => {
      mockViewMode = 'dashboard';
      mockCurrentPhase = 'welcome';
      renderShortcuts();

      fireMenuAction('select-files');

      const types = mockDispatch.mock.calls.map(([action]) => action.type);
      // setViewMode clears the came-from-dashboard breadcrumb, so it must be
      // dispatched first (same ordering as DashboardView.goToPhase).
      expect(types.indexOf('ui/setViewMode')).toBeGreaterThanOrEqual(0);
      expect(types.indexOf('ui/setViewMode')).toBeLessThan(
        types.indexOf('ui/setCameFromDashboard')
      );
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setViewMode', payload: 'phased' });
      expect(mockDispatch).toHaveBeenCalledWith({
        type: 'ui/setCameFromDashboard',
        payload: true
      });
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setPhase', payload: 'discover' });
    });

    test('select-files does not touch view mode when already phased', () => {
      mockViewMode = 'phased';
      mockCurrentPhase = 'welcome';
      renderShortcuts();

      fireMenuAction('select-files');

      expect(mockDispatch).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ui/setViewMode' })
      );
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/setPhase', payload: 'discover' });
    });
  });

  describe('cleanup', () => {
    test('removes keydown listener on unmount', () => {
      const { unmount } = renderShortcuts();
      unmount();
      expect(document.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
    });
  });
});
