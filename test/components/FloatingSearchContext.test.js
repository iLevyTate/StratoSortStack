/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockDispatch = jest.fn();
let mockState;

jest.mock('../../src/renderer/store/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector) => selector(mockState)
}));

jest.mock('../../src/renderer/store/slices/uiSlice', () => ({
  closeSettings: jest.fn(() => ({ type: 'ui/closeSettings' }))
}));

jest.mock('../../src/renderer/components/search/SearchErrorBoundary', () => ({
  __esModule: true,
  default: ({ children }) => <>{children}</>
}));

jest.mock('../../src/renderer/components/search/UnifiedSearchModal', () => ({
  __esModule: true,
  default: ({ isOpen }) => (isOpen ? <div data-testid="unified-search-modal" /> : null)
}));

jest.mock('../../src/shared/logger', () => ({
  logger: {
    error: jest.fn()
  }
}));

import {
  FloatingSearchProvider,
  useFloatingSearch
} from '../../src/renderer/contexts/FloatingSearchContext';
// Real module (not mocked): the provider's overlay guard must respect the
// same singleton stack the app's dialogs register on.
import { registerOverlay, unregisterOverlay } from '../../src/renderer/utils/overlayStack';

function Opener() {
  const { openSearchModal } = useFloatingSearch();
  return (
    <button type="button" data-testid="open-search" onClick={() => openSearchModal('search')}>
      open
    </button>
  );
}

// Fresh element per call: reusing one element reference across rerender()
// lets React bail out on referentially-equal props and skip re-reading the
// mocked selector.
function makeTree() {
  return (
    <FloatingSearchProvider>
      <Opener />
      <div data-testid="child">app</div>
    </FloatingSearchProvider>
  );
}

function renderProvider() {
  return render(makeTree());
}

describe('FloatingSearchProvider', () => {
  beforeEach(() => {
    mockDispatch.mockClear();
    mockState = { ui: { showSettings: false } };
  });

  test('renders children', () => {
    renderProvider();

    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  test('opening Knowledge OS closes the settings overlay', async () => {
    // One overlay at a time: the settings panel and the Knowledge OS modal
    // both portal to document.body at the same z-index, so stacking them
    // leaves settings invisibly held open beneath the search modal.
    renderProvider();

    fireEvent.click(screen.getByTestId('open-search'));

    expect(await screen.findByTestId('unified-search-modal')).toBeInTheDocument();
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/closeSettings' });
  });

  test('opening settings closes Knowledge OS', async () => {
    const { rerender } = renderProvider();

    fireEvent.click(screen.getByTestId('open-search'));
    expect(await screen.findByTestId('unified-search-modal')).toBeInTheDocument();

    mockState = { ui: { showSettings: true } };
    rerender(makeTree());

    expect(screen.queryByTestId('unified-search-modal')).not.toBeInTheDocument();
  });

  describe('Ctrl+K overlay guard', () => {
    // The keyboard/tray openers must not swap surfaces while a dialog other
    // than Settings/Knowledge OS is on top (e.g. a destructive ConfirmModal):
    // opening Knowledge OS also dispatches closeSettings, which would tear
    // down an in-progress flow underneath the user.
    afterEach(() => {
      unregisterOverlay('confirm-dialog');
      unregisterOverlay('settings-panel');
    });

    function pressCtrlK() {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    }

    test('Ctrl+K is inert while a foreign dialog is on top', () => {
      renderProvider();
      registerOverlay('confirm-dialog');

      pressCtrlK();

      expect(screen.queryByTestId('unified-search-modal')).not.toBeInTheDocument();
      expect(mockDispatch).not.toHaveBeenCalledWith({ type: 'ui/closeSettings' });
    });

    test('Ctrl+K still swaps away from the settings panel', async () => {
      renderProvider();
      registerOverlay('settings-panel');

      pressCtrlK();

      expect(await screen.findByTestId('unified-search-modal')).toBeInTheDocument();
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'ui/closeSettings' });
    });

    test('Ctrl+K opens normally with no overlay active', async () => {
      renderProvider();

      pressCtrlK();

      expect(await screen.findByTestId('unified-search-modal')).toBeInTheDocument();
    });

    test('Ctrl+K works with Caps Lock (SW-77)', async () => {
      renderProvider();

      fireEvent.keyDown(window, { key: 'K', ctrlKey: true });

      expect(await screen.findByTestId('unified-search-modal')).toBeInTheDocument();
    });
  });
});
