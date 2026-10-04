/**
 * @jest-environment jsdom
 *
 * Behavior tests for the Toast component (default export). Complements
 * Toast.position.test.js (container placement) and Toast.useToast.test.js
 * (hook grouping) — this file covers the uncovered rendering + interaction
 * branches on the visual Toast: severity classes/icons, actionable a11y
 * surface (role/tabIndex/keyboard activation), auto-dismiss timer, and
 * the dismiss IconButton.
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../src/shared/logger', () => {
  const noop = jest.fn();
  return {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    createLogger: jest.fn(() => ({ info: noop, warn: noop, error: noop, debug: noop }))
  };
});

import Toast, { ToastContainer } from '../../src/renderer/components/Toast';

describe('Toast (visual component)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('non-actionable rendering', () => {
    test('defaults to role="alert" with tabIndex=-1', () => {
      render(<Toast message="hello" duration={0} onClose={jest.fn()} />);
      const el = screen.getByRole('alert');
      expect(el).toBeInTheDocument();
      expect(el).toHaveAttribute('tabIndex', '-1');
      expect(el).toHaveAttribute('aria-live', 'polite');
    });

    test('renders the message text', () => {
      render(<Toast message="Hi there" duration={0} onClose={jest.fn()} />);
      expect(screen.getByText('Hi there')).toBeInTheDocument();
    });

    test('applies severity-specific class for success/error/warning/info', () => {
      const { rerender, container } = render(
        <Toast message="m" severity="success" duration={0} onClose={jest.fn()} />
      );
      expect(container.querySelector('.toast-success')).toBeTruthy();

      rerender(<Toast message="m" severity="error" duration={0} onClose={jest.fn()} />);
      expect(container.querySelector('.toast-error')).toBeTruthy();

      rerender(<Toast message="m" severity="warning" duration={0} onClose={jest.fn()} />);
      expect(container.querySelector('.toast-warning')).toBeTruthy();

      rerender(<Toast message="m" severity="info" duration={0} onClose={jest.fn()} />);
      expect(container.querySelector('.toast-info')).toBeTruthy();
    });

    test('renders mergeCount badge when > 1', () => {
      render(<Toast message="grouped" mergeCount={3} duration={0} onClose={jest.fn()} />);
      expect(screen.getByText('3')).toBeInTheDocument();
    });

    test('does not render mergeCount badge when <= 1', () => {
      const { container } = render(
        <Toast message="alone" mergeCount={1} duration={0} onClose={jest.fn()} />
      );
      // The badge span has bg-current/15 class; assert its absence
      expect(container.querySelector('.bg-current\\/15')).toBeNull();
    });
  });

  describe('actionable rendering', () => {
    test('sets role="button", tabIndex=0, and pointer cursor styling', () => {
      render(
        <Toast
          message="open me"
          actionable
          onActivate={jest.fn()}
          onClose={jest.fn()}
          duration={0}
        />
      );
      const btn = screen.getByRole('button', { name: /open me/i });
      expect(btn).toHaveAttribute('tabIndex', '0');
      expect(btn.className).toMatch(/cursor-pointer/);
      expect(btn).toHaveAttribute('title', 'Open in StratoSort');
    });

    test('click activates the toast and calls onActivate', () => {
      const onActivate = jest.fn();
      render(
        <Toast
          message="click me"
          actionable
          onActivate={onActivate}
          onClose={jest.fn()}
          duration={0}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /click me/i }));
      expect(onActivate).toHaveBeenCalledTimes(1);
    });

    test('Enter key activates the toast', () => {
      const onActivate = jest.fn();
      render(
        <Toast
          message="enter me"
          actionable
          onActivate={onActivate}
          onClose={jest.fn()}
          duration={0}
        />
      );
      fireEvent.keyDown(screen.getByRole('button', { name: /enter me/i }), { key: 'Enter' });
      expect(onActivate).toHaveBeenCalledTimes(1);
    });

    test('Space key activates the toast', () => {
      const onActivate = jest.fn();
      render(
        <Toast
          message="space me"
          actionable
          onActivate={onActivate}
          onClose={jest.fn()}
          duration={0}
        />
      );
      fireEvent.keyDown(screen.getByRole('button', { name: /space me/i }), { key: ' ' });
      expect(onActivate).toHaveBeenCalledTimes(1);
    });

    test('Enter/Space are ignored when not actionable', () => {
      const onActivate = jest.fn();
      render(
        <Toast
          message="not clickable"
          actionable={false}
          onActivate={onActivate}
          onClose={jest.fn()}
          duration={0}
        />
      );
      fireEvent.keyDown(screen.getByRole('alert'), { key: 'Enter' });
      fireEvent.keyDown(screen.getByRole('alert'), { key: ' ' });
      expect(onActivate).not.toHaveBeenCalled();
    });

    test('non-actionable toast click does nothing', () => {
      const onActivate = jest.fn();
      render(<Toast message="static" onActivate={onActivate} onClose={jest.fn()} duration={0} />);
      fireEvent.click(screen.getByRole('alert'));
      expect(onActivate).not.toHaveBeenCalled();
    });
  });

  describe('dismissal', () => {
    test('Escape key triggers close', () => {
      jest.useFakeTimers();
      const onClose = jest.fn();
      render(<Toast message="esc me" duration={0} onClose={onClose} />);
      fireEvent.keyDown(screen.getByRole('alert'), { key: 'Escape' });
      // handleClose starts an animation-out timer before firing onClose
      act(() => {
        jest.runAllTimers();
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('dismiss button (X) fires onClose after animation timer', () => {
      jest.useFakeTimers();
      const onClose = jest.fn();
      render(<Toast message="dismissable" duration={0} onClose={onClose} />);
      const dismiss = screen.getByRole('button', { name: /dismiss/i });
      fireEvent.click(dismiss);
      act(() => {
        jest.runAllTimers();
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('dismiss button click on actionable toast does NOT bubble to activate', () => {
      jest.useFakeTimers();
      const onActivate = jest.fn();
      const onClose = jest.fn();
      render(
        <Toast
          message="both handlers"
          actionable
          onActivate={onActivate}
          onClose={onClose}
          duration={0}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
      act(() => {
        jest.runAllTimers();
      });
      expect(onActivate).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('auto-dismisses after `duration` ms + animation delay', () => {
      jest.useFakeTimers();
      const onClose = jest.fn();
      render(<Toast message="auto" duration={2000} onClose={onClose} />);
      expect(onClose).not.toHaveBeenCalled();
      act(() => {
        jest.advanceTimersByTime(2000);
      });
      // After duration, animation timer starts
      act(() => {
        jest.runAllTimers();
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('duration=0 disables auto-dismiss', () => {
      jest.useFakeTimers();
      const onClose = jest.fn();
      render(<Toast message="sticky" duration={0} onClose={onClose} />);
      act(() => {
        jest.advanceTimersByTime(30_000);
      });
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('message rendering flexibility', () => {
    test('renders a React element message directly', () => {
      render(
        <Toast
          message={<span data-testid="rich-msg">rich</span>}
          duration={0}
          onClose={jest.fn()}
        />
      );
      expect(screen.getByTestId('rich-msg')).toHaveTextContent('rich');
    });

    test('renders {message} from object payload', () => {
      render(<Toast message={{ message: 'from-object' }} duration={0} onClose={jest.fn()} />);
      expect(screen.getByText('from-object')).toBeInTheDocument();
    });

    test('renders {title} when message not present on object payload', () => {
      render(<Toast message={{ title: 'title-fallback' }} duration={0} onClose={jest.fn()} />);
      expect(screen.getByText('title-fallback')).toBeInTheDocument();
    });

    test('falls back to JSON.stringify when object has no readable field', () => {
      render(<Toast message={{ foo: 1 }} duration={0} onClose={jest.fn()} />);
      expect(screen.getByText(/"foo":1/)).toBeInTheDocument();
    });
  });

  describe('visibility control', () => {
    test('returns null when show=false and internal state has faded', () => {
      const { container, rerender } = render(
        <Toast message="fade" duration={0} onClose={jest.fn()} show={false} />
      );
      expect(container.firstChild).toBeNull();
      rerender(<Toast message="fade" duration={0} onClose={jest.fn()} show={true} />);
      expect(container.querySelector('[role="alert"]')).toBeTruthy();
    });
  });
});

describe('ToastContainer (rendering-focused)', () => {
  afterEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      // ignore
    }
  });

  test('renders visible toasts and forwards onRemove/onActivate handlers', () => {
    const onRemoveToast = jest.fn();
    const onActivateToast = jest.fn();
    const toasts = [
      { id: 1, message: 'first', severity: 'info', duration: 0, actionable: false, show: true },
      { id: 2, message: 'second', severity: 'success', duration: 0, actionable: true, show: true }
    ];
    render(
      <ToastContainer
        toasts={toasts}
        onRemoveToast={onRemoveToast}
        onActivateToast={onActivateToast}
      />
    );
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();

    // Activate the actionable one
    fireEvent.click(screen.getByRole('button', { name: /second/i }));
    expect(onActivateToast).toHaveBeenCalledTimes(1);
    expect(onActivateToast.mock.calls[0][0].id).toBe(2);
  });

  test('collapse button toggles the notification stack visibility', () => {
    const toasts = [
      { id: 1, message: 'hello', severity: 'info', duration: 0, show: true, actionable: false }
    ];
    render(<ToastContainer toasts={toasts} onRemoveToast={jest.fn()} />);

    expect(screen.getByText('hello')).toBeInTheDocument();
    const collapse = screen.getByRole('button', { name: /collapse notification list/i });
    fireEvent.click(collapse);
    expect(screen.queryByText('hello')).not.toBeInTheDocument();
    // The badge count appears when collapsed
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  test('caps visible toasts and shows a +N more indicator', () => {
    // MAX_TOASTS = 4; include 6 to force overflow
    const toasts = Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      message: `m-${i + 1}`,
      severity: 'info',
      duration: 0,
      show: true,
      actionable: false
    }));
    render(<ToastContainer toasts={toasts} onRemoveToast={jest.fn()} />);
    expect(screen.getByText('+2 more')).toBeInTheDocument();
    // The last 4 are visible (m-3..m-6)
    expect(screen.getByText('m-6')).toBeInTheDocument();
    expect(screen.getByText('m-3')).toBeInTheDocument();
    // m-1, m-2 were dropped
    expect(screen.queryByText('m-1')).not.toBeInTheDocument();
    expect(screen.queryByText('m-2')).not.toBeInTheDocument();
  });
});
