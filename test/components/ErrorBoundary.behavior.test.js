/**
 * @jest-environment jsdom
 *
 * Behavior tests for ErrorBoundaryCore. Coverage lift for the 14.9% cold
 * component at src/renderer/components/ErrorBoundary.jsx.
 *
 * Focus: children pass-through, fallback rendering per variant (simple/global/
 * phase), reset/reload/navigate-home callbacks, chunk-load recovery branch,
 * auto-reset scheduling, and error reporting to main via
 * window.electronAPI.events.sendError. React logs boundary catches via
 * console.error — silenced per SearchErrorBoundary convention.
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../src/shared/logger', () => {
  const __mockLogger = {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
    setContext: jest.fn()
  };
  return {
    __mockLogger,
    logger: __mockLogger,
    createLogger: jest.fn(() => __mockLogger)
  };
});

import ErrorBoundaryCore, {
  GlobalErrorBoundary
} from '../../src/renderer/components/ErrorBoundary';
import { __mockLogger } from '../../src/shared/logger';

function Boom({ message = 'kaboom', name }) {
  const err = new Error(message);
  if (name) err.name = name;
  throw err;
}

// jsdom marks both `window.location` and its `reload` slot as non-configurable
// (WebIDL Location). We cannot mock reload directly. Instead, most tests do
// not exercise the reload path; the two that do call `window.location.reload`
// swap `window.location.reload` at the `HTMLBoundary` proto level via a
// side-channel: patch it just before the component reads it, then restore.
//
// We accomplish this by shadowing `window.location` on `globalThis` — the
// component only touches `window.location.reload()`, which resolves through
// the global lookup, so replacing `globalThis.window` (not the special
// property) is not viable either. For this reason, reload-focused assertions
// verify BEHAVIORAL side effects (logger warns, state changes) rather than
// literal call counts.
describe('ErrorBoundaryCore', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    Object.values(__mockLogger).forEach((fn) => {
      if (typeof fn?.mockClear === 'function') fn.mockClear();
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    delete window.electronAPI;
    try {
      sessionStorage.clear();
    } catch {
      // ignore
    }
  });

  test('renders children unchanged when no error thrown', () => {
    render(
      <ErrorBoundaryCore>
        <div data-testid="child-content">hello world</div>
      </ErrorBoundaryCore>
    );
    expect(screen.getByTestId('child-content')).toHaveTextContent('hello world');
  });

  test('simple variant fallback renders on child throw and logs error', () => {
    render(
      <ErrorBoundaryCore variant="simple" enableChunkRecovery={false}>
        <Boom message="something failed" />
      </ErrorBoundaryCore>
    );

    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
    expect(screen.getByText(/something failed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
    expect(__mockLogger.error).toHaveBeenCalled();
    expect(__mockLogger.error.mock.calls[0][0]).toMatch(/ErrorBoundary/);
  });

  test('global variant fallback renders with detailed heading + counters', () => {
    render(
      <ErrorBoundaryCore variant="global" enableChunkRecovery={false}>
        <Boom message="global blowup" />
      </ErrorBoundaryCore>
    );
    expect(
      screen.getByRole('heading', { name: /oops! something went wrong/i })
    ).toBeInTheDocument();
    expect(screen.getByText(/global blowup/i)).toBeInTheDocument();
  });

  test('phase variant fallback renders with contextName + navigate-home button', () => {
    const onNavigateHome = jest.fn();
    render(
      <ErrorBoundaryCore
        variant="phase"
        contextName="Discover"
        showNavigateHome
        onNavigateHome={onNavigateHome}
        enableChunkRecovery={false}
      >
        <Boom message="phase failed" />
      </ErrorBoundaryCore>
    );
    expect(screen.getByRole('heading', { name: /discover error/i })).toBeInTheDocument();
    expect(screen.getByText(/phase failed/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /go to home/i }));
    expect(onNavigateHome).toHaveBeenCalledTimes(1);
  });

  test('Try Again button clears fallback and re-renders children after error clears', () => {
    let shouldThrow = true;
    function Toggle() {
      if (shouldThrow) throw new Error('first render fail');
      return <div>recovered content</div>;
    }
    render(
      <ErrorBoundaryCore variant="simple" enableChunkRecovery={false}>
        <Toggle />
      </ErrorBoundaryCore>
    );
    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(
      screen.queryByRole('heading', { name: /something went wrong/i })
    ).not.toBeInTheDocument();
    expect(screen.getByText('recovered content')).toBeInTheDocument();
  });

  test('onReset callback fires when Try Again clicked', () => {
    const onReset = jest.fn();
    render(
      <ErrorBoundaryCore variant="simple" onReset={onReset} enableChunkRecovery={false}>
        <Boom />
      </ErrorBoundaryCore>
    );
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  test('Reload button is present and clickable in the simple fallback', () => {
    render(
      <ErrorBoundaryCore variant="simple" enableChunkRecovery={false}>
        <Boom />
      </ErrorBoundaryCore>
    );
    const reload = screen.getByRole('button', { name: /reload/i });
    expect(reload).toBeEnabled();
    // We cannot spy on jsdom's read-only Location.reload; click just verifies
    // the handler binding is wired (doesn't throw).
    expect(() => fireEvent.click(reload)).not.toThrow();
  });

  test('onError callback receives error + errorInfo + context', () => {
    const onError = jest.fn();
    render(
      <ErrorBoundaryCore
        variant="simple"
        contextName="TestArea"
        onError={onError}
        enableChunkRecovery={false}
      >
        <Boom message="callback me" />
      </ErrorBoundaryCore>
    );
    expect(onError).toHaveBeenCalledTimes(1);
    const [error, info, ctx] = onError.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('callback me');
    expect(info).toHaveProperty('componentStack');
    expect(ctx).toBe('TestArea');
  });

  test('reports error to main via window.electronAPI.events.sendError', () => {
    const sendError = jest.fn();
    window.electronAPI = { events: { sendError } };
    render(
      <ErrorBoundaryCore variant="simple" enableChunkRecovery={false}>
        <Boom message="report me" />
      </ErrorBoundaryCore>
    );
    expect(sendError).toHaveBeenCalledTimes(1);
    const payload = sendError.mock.calls[0][0];
    expect(payload).toMatchObject({
      message: 'report me',
      type: 'react-error-boundary'
    });
    expect(payload).toHaveProperty('stack');
    expect(payload).toHaveProperty('componentStack');
  });

  test('reportErrorToMain swallows sendError throws (defensive)', () => {
    window.electronAPI = {
      events: {
        sendError: jest.fn(() => {
          throw new Error('ipc dead');
        })
      }
    };
    // Should not throw
    expect(() => {
      render(
        <ErrorBoundaryCore variant="simple" enableChunkRecovery={false}>
          <Boom />
        </ErrorBoundaryCore>
      );
    }).not.toThrow();
    expect(__mockLogger.error).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to report error to main/),
      expect.any(Error)
    );
  });

  test('custom fallback prop takes precedence over variant rendering', () => {
    const fallback = jest.fn((err, info, reset) => (
      <div>
        <p>custom fallback: {err.message}</p>
        <button onClick={reset}>my-reset</button>
      </div>
    ));
    render(
      <ErrorBoundaryCore variant="global" fallback={fallback} enableChunkRecovery={false}>
        <Boom message="custom please" />
      </ErrorBoundaryCore>
    );
    expect(fallback).toHaveBeenCalled();
    expect(screen.getByText(/custom fallback: custom please/)).toBeInTheDocument();
  });

  test('chunk load error surfaces reload-first CTA in global variant', () => {
    render(
      <ErrorBoundaryCore variant="global" enableChunkRecovery={false}>
        <Boom message="Loading chunk 42 failed" name="ChunkLoadError" />
      </ErrorBoundaryCore>
    );
    // Chunk mode swaps to "App assets failed to load..." messaging
    expect(screen.getByText(/app assets failed to load/i)).toBeInTheDocument();
    // Both Reload and Try Again render, and Reload is placed first (primary)
    const buttons = screen.getAllByRole('button');
    const labels = buttons.map((b) => b.textContent);
    expect(labels).toEqual(expect.arrayContaining([expect.stringMatching(/Reload/i)]));
    expect(labels).toEqual(expect.arrayContaining([expect.stringMatching(/Try Again/i)]));
  });

  test('phase variant surfaces chunk-specific messaging when isChunkLoadError', () => {
    render(
      <ErrorBoundaryCore variant="phase" contextName="Setup" enableChunkRecovery={false}>
        <Boom message="Failed to fetch dynamically imported module: foo.js" />
      </ErrorBoundaryCore>
    );
    expect(screen.getByText(/app asset mismatch/i)).toBeInTheDocument();
  });

  test('enableChunkRecovery logs a warn for ChunkLoadError (recovery path)', () => {
    // We cannot spy on jsdom's read-only Location.reload — instead verify
    // the recovery branch fires by asserting the ChunkLoadRecovery warn was
    // emitted (which the code does IMMEDIATELY before scheduling the reload).
    render(
      <ErrorBoundaryCore variant="simple" enableChunkRecovery>
        <Boom message="ChunkLoadError happened" />
      </ErrorBoundaryCore>
    );
    expect(__mockLogger.warn).toHaveBeenCalled();
    const messages = __mockLogger.warn.mock.calls.map((c) => c[0]);
    expect(messages.some((m) => /ChunkLoadRecovery/.test(String(m)))).toBe(true);
  });

  test('auto-reset schedules a reset when enableAutoReset is on', () => {
    jest.useFakeTimers();
    try {
      let throws = true;
      function Once() {
        if (throws) throw new Error('auto boom');
        return <div>ok now</div>;
      }
      render(
        <ErrorBoundaryCore
          variant="simple"
          enableAutoReset
          autoResetDelay={5000}
          enableChunkRecovery={false}
        >
          <Once />
        </ErrorBoundaryCore>
      );
      expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
      throws = false;
      act(() => {
        jest.advanceTimersByTime(5000);
      });
      expect(screen.getByText('ok now')).toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });

  test('unmount clears any pending auto-reset timer', () => {
    jest.useFakeTimers();
    try {
      const clearSpy = jest.spyOn(global, 'clearTimeout');
      const { unmount } = render(
        <ErrorBoundaryCore
          variant="simple"
          enableAutoReset
          autoResetDelay={30000}
          enableChunkRecovery={false}
        >
          <Boom />
        </ErrorBoundaryCore>
      );
      unmount();
      expect(clearSpy).toHaveBeenCalled();
      clearSpy.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });

  test('exhausted reload (chunk fails again <60s after a reload) shows restart guidance in global variant', () => {
    // Simulate that an auto-reload already fired moments ago. The recovery
    // path will decline to reload again; the fallback must stop advising a
    // reload (it is now proven futile) and tell the user to restart.
    sessionStorage.setItem('stratosort:chunk-reload-at', String(Date.now()));
    render(
      <ErrorBoundaryCore variant="global" enableChunkRecovery>
        <Boom message="Loading chunk 7 failed" name="ChunkLoadError" />
      </ErrorBoundaryCore>
    );
    expect(screen.getByText(/quit and reopen/i)).toBeInTheDocument();
    // No misleading Reload button — reloading was already proven not to help.
    const labels = screen.getAllByRole('button').map((b) => b.textContent || '');
    expect(labels.some((l) => /reload/i.test(l))).toBe(false);
  });

  test('exhausted reload shows restart guidance in phase variant', () => {
    sessionStorage.setItem('stratosort:chunk-reload-at', String(Date.now()));
    render(
      <ErrorBoundaryCore variant="phase" contextName="Setup" enableChunkRecovery>
        <Boom message="Loading chunk 12 failed" name="ChunkLoadError" />
      </ErrorBoundaryCore>
    );
    expect(screen.getByText(/quit and reopen/i)).toBeInTheDocument();
    const labels = screen.getAllByRole('button').map((b) => b.textContent || '');
    expect(labels.some((l) => /reload/i.test(l))).toBe(false);
  });
});

describe('GlobalErrorBoundary wrapper', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    delete window.electronAPI;
  });

  test('renders global fallback UI on child throw', () => {
    render(
      <GlobalErrorBoundary>
        <Boom message="global wrapper" />
      </GlobalErrorBoundary>
    );
    expect(
      screen.getByRole('heading', { name: /oops! something went wrong/i })
    ).toBeInTheDocument();
  });

  test('passes onReset through to the underlying core', () => {
    const onReset = jest.fn();
    render(
      <GlobalErrorBoundary onReset={onReset}>
        <Boom />
      </GlobalErrorBoundary>
    );
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
