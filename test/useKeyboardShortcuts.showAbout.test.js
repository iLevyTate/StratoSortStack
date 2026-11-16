/**
 * @jest-environment jsdom
 */
/**
 * "About StratoSort Stack" (macOS app menu, Help > About elsewhere) sends the
 * 'show-about' menu action. The renderer opens Settings deep-linked to the
 * Application section, which holds AboutSection. Uses the real uiSlice so the
 * dispatched action is checked against the reducer that consumes it.
 */
// fs is mocked (memfs) in the shared jest setup; read the real source file.
const fs = jest.requireActual('fs');
import path from 'path';
import { renderHook } from '@testing-library/react';

const mockDispatch = jest.fn();
const mockState = {
  ui: { currentPhase: 'discover', viewMode: 'phased', showSettings: false },
  files: {
    smartFolders: [],
    selectedFiles: [],
    fileStates: {},
    organizedFiles: [],
    organizedPathIndex: []
  },
  analysis: { isAnalyzing: false, results: [] }
};

jest.mock('../src/renderer/store/hooks', () => ({
  useAppDispatch: jest.fn(() => mockDispatch),
  useAppSelector: jest.fn((selector) => selector(mockState))
}));

jest.mock('../src/renderer/contexts/NotificationContext', () => ({
  useNotification: jest.fn(() => ({ addNotification: jest.fn(), showInfo: jest.fn() }))
}));

jest.mock('../src/renderer/components/UndoRedoSystem', () => ({
  useUndoRedo: () => ({ undo: jest.fn(), redo: jest.fn(), canUndo: false, canRedo: false })
}));

jest.mock('../src/renderer/utils/overlayStack', () => ({
  isTopOverlay: jest.fn(() => false),
  canHotkeySwapSurface: jest.fn(() => true),
  hasActiveOverlay: jest.fn(() => false)
}));

jest.mock('../src/renderer/store/thunks/liveActivityThunks', () => ({
  toggleShowLiveActivity: jest.fn(() => ({ type: 'test/toggleShowLiveActivity' }))
}));

import { useKeyboardShortcuts } from '../src/renderer/hooks/useKeyboardShortcuts';
import uiReducer, { openSettings } from '../src/renderer/store/slices/uiSlice';
import { canHotkeySwapSurface } from '../src/renderer/utils/overlayStack';

describe("'show-about' menu action", () => {
  let menuHandler = null;

  beforeEach(() => {
    mockDispatch.mockClear();
    canHotkeySwapSurface.mockReturnValue(true);
    menuHandler = null;
    window.electronAPI = {
      events: {
        onMenuAction: jest.fn((handler) => {
          menuHandler = handler;
          return () => {};
        })
      }
    };
  });

  afterEach(() => {
    delete window.electronAPI;
  });

  function openSettingsDispatches() {
    return mockDispatch.mock.calls
      .map(([action]) => action)
      .filter((action) => action && action.type === openSettings.type);
  }

  test('opens Settings scrolled to the section that holds About', () => {
    renderHook(() => useKeyboardShortcuts());

    menuHandler('show-about');

    const dispatched = openSettingsDispatches();
    expect(dispatched).toHaveLength(1);
    const next = uiReducer(undefined, dispatched[0]);
    expect(next.showSettings).toBe(true);
    expect(next.settingsScrollTargetId).toBe('settings-app');
  });

  test('does nothing while another blocking dialog owns the screen', () => {
    canHotkeySwapSurface.mockReturnValue(false);
    renderHook(() => useKeyboardShortcuts());

    menuHandler('show-about');

    expect(openSettingsDispatches()).toEqual([]);
  });

  test('open-settings still opens Settings without a scroll target', () => {
    renderHook(() => useKeyboardShortcuts());

    menuHandler('open-settings');

    const dispatched = openSettingsDispatches();
    expect(dispatched).toHaveLength(1);
    expect(uiReducer(undefined, dispatched[0]).settingsScrollTargetId).toBeNull();
  });

  test('the deep-link target renders AboutSection and is an expandable section', () => {
    // The scroll target is a DOM id in SettingsPanel; pin it so a rename there
    // does not silently turn the About menu item back into a no-op.
    const source = fs.readFileSync(
      path.join(__dirname, '../src/renderer/components/SettingsPanel.jsx'),
      'utf8'
    );
    const start = source.indexOf('id="settings-app"');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('</Collapsible>', start);
    expect(source.slice(start, end)).toContain('<AboutSection');
    expect(source).toMatch(/SECTION_KEYS\s*=\s*\[[^\]]*'settings-app'/);
  });
});
