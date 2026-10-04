/**
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import uiReducer from '../../src/renderer/store/slices/uiSlice';
import GraphTour from '../../src/renderer/components/search/GraphTour';

// Mock localStorage
const localStorageMock = {
  _store: {},
  getItem: jest.fn((key) => localStorageMock._store[key] || null),
  setItem: jest.fn((key, value) => {
    localStorageMock._store[key] = value;
  }),
  removeItem: jest.fn((key) => {
    delete localStorageMock._store[key];
  }),
  clear: function () {
    this._store = {};
  }
};

Object.defineProperty(window, 'localStorage', { value: localStorageMock });

const renderWithRedux = (ui, { preloadedState } = {}) => {
  const store = configureStore({
    reducer: { ui: uiReducer },
    preloadedState
  });
  return render(<Provider store={store}>{ui}</Provider>);
};

describe('GraphTour', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    localStorageMock.clear();
    localStorageMock.getItem.mockReset();
    localStorageMock.setItem.mockReset();
    localStorageMock.removeItem.mockReset();
    localStorageMock.getItem.mockImplementation((key) => localStorageMock._store[key] || null);
    localStorageMock.setItem.mockImplementation((key, value) => {
      localStorageMock._store[key] = value;
    });
    localStorageMock.removeItem.mockImplementation((key) => {
      delete localStorageMock._store[key];
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('initial render', () => {
    it('should not render when isOpen is false', () => {
      renderWithRedux(<GraphTour isOpen={false} />);
      expect(screen.queryByText('Search for files')).not.toBeInTheDocument();
    });

    it('should show tour after delay when not seen before', () => {
      renderWithRedux(<GraphTour isOpen={true} />);

      expect(screen.queryByText('Search for files')).not.toBeInTheDocument();

      act(() => {
        jest.advanceTimersByTime(500);
      });

      expect(screen.getByText('Search for files')).toBeInTheDocument();
    });

    it('should not show tour if already dismissed (localStorage)', () => {
      localStorageMock.getItem.mockReturnValue('true');

      renderWithRedux(<GraphTour isOpen={true} />);

      act(() => {
        jest.advanceTimersByTime(500);
      });

      expect(screen.queryByText('Search for files')).not.toBeInTheDocument();
    });

    it('should not show tour if already dismissed (Redux)', () => {
      renderWithRedux(<GraphTour isOpen={true} />, {
        preloadedState: { ui: { graphTourDismissed: true } }
      });

      act(() => {
        jest.advanceTimersByTime(500);
      });

      expect(screen.queryByText('Search for files')).not.toBeInTheDocument();
    });
  });

  describe('navigation', () => {
    const renderAndShow = () => {
      renderWithRedux(<GraphTour isOpen={true} />);
      act(() => {
        jest.advanceTimersByTime(500);
      });
    };

    it('should show first step initially', () => {
      renderAndShow();
      expect(screen.getByText('Search for files')).toBeInTheDocument();
      expect(screen.getByText('Step 1 of 5')).toBeInTheDocument();
    });

    it('should navigate to next step when clicking Next', () => {
      renderAndShow();
      expect(screen.getByText('Search for files')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Next'));

      expect(screen.getByText('Explore clusters')).toBeInTheDocument();
      expect(screen.getByText('Step 2 of 5')).toBeInTheDocument();
    });

    it('should navigate back when clicking Back', () => {
      renderAndShow();
      expect(screen.getByText('Search for files')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Next'));
      expect(screen.getByText('Explore clusters')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Back'));

      expect(screen.getByText('Search for files')).toBeInTheDocument();
    });

    it('should show Get Started button on last step', () => {
      renderAndShow();
      expect(screen.getByText('Search for files')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Next'));
      fireEvent.click(screen.getByText('Next'));
      fireEvent.click(screen.getByText('Next'));
      fireEvent.click(screen.getByText('Next'));

      expect(screen.getByText('The Atlas, a companion view')).toBeInTheDocument();
      expect(screen.getByText('Get started')).toBeInTheDocument();
    });
  });

  describe('completion', () => {
    it('should save to localStorage and dispatch when completed', () => {
      renderWithRedux(<GraphTour isOpen={true} />);
      act(() => {
        jest.advanceTimersByTime(500);
      });

      expect(screen.getByText('Search for files')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Next'));
      fireEvent.click(screen.getByText('Next'));
      fireEvent.click(screen.getByText('Next'));
      fireEvent.click(screen.getByText('Next'));
      fireEvent.click(screen.getByText('Get started'));

      expect(localStorageMock.setItem).toHaveBeenCalledWith('graphTourDismissed', 'true');
    });

    it('should call onComplete callback when completed', () => {
      const onComplete = jest.fn();
      renderWithRedux(<GraphTour isOpen={true} onComplete={onComplete} />);
      act(() => {
        jest.advanceTimersByTime(500);
      });

      expect(screen.getByText('Search for files')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Next'));
      fireEvent.click(screen.getByText('Next'));
      fireEvent.click(screen.getByText('Next'));
      fireEvent.click(screen.getByText('Next'));
      fireEvent.click(screen.getByText('Get started'));

      expect(onComplete).toHaveBeenCalled();
    });

    it('should persist immediately when closed with checkbox checked', () => {
      renderWithRedux(<GraphTour isOpen={true} />);
      act(() => {
        jest.advanceTimersByTime(500);
      });

      expect(screen.getByText('Search for files')).toBeInTheDocument();

      // Checkbox is checked by default; clicking Close should persist and hide
      fireEvent.click(screen.getByText('Close'));

      expect(localStorageMock.setItem).toHaveBeenCalledWith('graphTourDismissed', 'true');
      expect(screen.queryByText('Search for files')).not.toBeInTheDocument();
    });

    it('should persist when closed via header close icon with checkbox checked', () => {
      renderWithRedux(<GraphTour isOpen={true} />);
      act(() => {
        jest.advanceTimersByTime(500);
      });

      expect(screen.getByText('Search for files')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Close tour' }));

      expect(localStorageMock.setItem).toHaveBeenCalledWith('graphTourDismissed', 'true');
      expect(screen.queryByText('Search for files')).not.toBeInTheDocument();
    });

    it('should not save when closed with checkbox unchecked', () => {
      renderWithRedux(<GraphTour isOpen={true} />);
      act(() => {
        jest.advanceTimersByTime(500);
      });

      expect(screen.getByText('Search for files')).toBeInTheDocument();

      const checkbox = screen.getByRole('checkbox');
      fireEvent.click(checkbox);

      fireEvent.click(screen.getByText('Close'));

      expect(localStorageMock.setItem).not.toHaveBeenCalled();
    });

    it('does not persist dismissal on unmount without explicit user action', () => {
      const { unmount } = renderWithRedux(<GraphTour isOpen={true} />);
      act(() => {
        jest.advanceTimersByTime(500);
      });

      expect(screen.getByText('Search for files')).toBeInTheDocument();

      unmount();

      expect(localStorageMock.setItem).not.toHaveBeenCalled();
    });

    it('does not persist dismissal when the parent closes without explicit user action', () => {
      const { rerender } = renderWithRedux(<GraphTour isOpen={true} />);
      act(() => {
        jest.advanceTimersByTime(500);
      });

      expect(screen.getByText('Search for files')).toBeInTheDocument();

      rerender(
        <Provider
          store={configureStore({
            reducer: { ui: uiReducer }
          })}
        >
          <GraphTour isOpen={false} />
        </Provider>
      );

      expect(localStorageMock.setItem).not.toHaveBeenCalled();
    });

    it('should respect unchecked preference when completing tour', () => {
      renderWithRedux(<GraphTour isOpen={true} />);
      act(() => {
        jest.advanceTimersByTime(500);
      });

      const checkbox = screen.getByRole('checkbox');
      fireEvent.click(checkbox);

      fireEvent.click(screen.getByText('Next'));
      fireEvent.click(screen.getByText('Next'));
      fireEvent.click(screen.getByText('Next'));
      fireEvent.click(screen.getByText('Next'));
      fireEvent.click(screen.getByText('Get started'));

      expect(localStorageMock.setItem).not.toHaveBeenCalled();
    });

    it('clears persisted dismissal when force-shown tour is closed unchecked', () => {
      localStorageMock._store.graphTourDismissed = 'true';

      renderWithRedux(<GraphTour isOpen={true} forceShow={true} />, {
        preloadedState: { ui: { graphTourDismissed: true } }
      });

      expect(screen.getByText('Search for files')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(screen.getByText('Close'));

      expect(localStorageMock.removeItem).toHaveBeenCalledWith('graphTourDismissed');
    });
  });

  describe('step indicators', () => {
    it('should navigate when clicking step dots', () => {
      renderWithRedux(<GraphTour isOpen={true} />);
      act(() => {
        jest.advanceTimersByTime(500);
      });

      expect(screen.getByText('Search for files')).toBeInTheDocument();

      const stepButtons = screen.getAllByRole('button', { name: /Go to step/i });
      fireEvent.click(stepButtons[3]);

      expect(screen.getByText('Navigate the graph')).toBeInTheDocument();
    });
  });

  describe('dialog a11y (U-011)', () => {
    it('renders as a modal dialog labeled by the step title', () => {
      renderWithRedux(<GraphTour isOpen={true} forceShow={true} />);

      const dialog = screen.getByRole('dialog', { name: 'Search for files' });
      expect(dialog.getAttribute('aria-modal')).toBe('true');
    });

    it('Escape closes the tour', () => {
      // No forceShow here: holding forceShow=true would re-show the tour as
      // soon as the dismissal lands (the visibility effect re-runs on the
      // graphTourDismissed change). The real parent drops forceShow via
      // onComplete, so the first-run (isOpen) path is the honest harness.
      const onComplete = jest.fn();
      renderWithRedux(<GraphTour isOpen={true} onComplete={onComplete} />);
      act(() => {
        jest.advanceTimersByTime(500);
      });
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      fireEvent.keyDown(document, { key: 'Escape' });

      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
