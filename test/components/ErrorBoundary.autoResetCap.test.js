/**
 * @jest-environment jsdom
 */
/**
 * The automatic reset gives up after a few tries.
 *
 * The auto-reset is scheduled only while errorCount < 3, but every reset used
 * to set errorCount back to 0, so a child that always throws was caught with
 * errorCount 1 every time and remounted forever, and the "Multiple errors
 * detected" hint never showed.
 */
import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
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

import ErrorBoundaryCore from '../../src/renderer/components/ErrorBoundary';

const DELAY = 1000;

describe('ErrorBoundaryCore auto-reset cap', () => {
  let consoleErrorSpy;
  let sendError;

  beforeEach(() => {
    jest.useFakeTimers();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    sendError = jest.fn();
    window.electronAPI = { events: { sendError } };
  });

  afterEach(() => {
    jest.useRealTimers();
    consoleErrorSpy.mockRestore();
    delete window.electronAPI;
  });

  function renderBoundary(child) {
    return render(
      <ErrorBoundaryCore
        variant="global"
        enableAutoReset
        autoResetDelay={DELAY}
        enableChunkRecovery={false}
      >
        {child}
      </ErrorBoundaryCore>
    );
  }

  test('a child that always throws stops being remounted and shows the hint', () => {
    function AlwaysThrows() {
      throw new Error('persistent boom');
    }
    renderBoundary(<AlwaysThrows />);
    expect(sendError).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 6; i += 1) {
      act(() => {
        jest.advanceTimersByTime(DELAY);
      });
    }

    // First catch plus two automatic retries, then no more.
    expect(sendError).toHaveBeenCalledTimes(3);
    expect(screen.getByText(/Multiple errors detected/)).toBeInTheDocument();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('manual Try again starts the count over', () => {
    function AlwaysThrows() {
      throw new Error('persistent boom');
    }
    renderBoundary(<AlwaysThrows />);
    for (let i = 0; i < 3; i += 1) {
      act(() => {
        jest.advanceTimersByTime(DELAY);
      });
    }
    expect(screen.getByText(/Multiple errors detected/)).toBeInTheDocument();
    expect(jest.getTimerCount()).toBe(0);

    fireEvent.click(screen.getByText('Try again'));

    // Caught again, but as the first error of a fresh run: retried, no hint.
    expect(sendError).toHaveBeenCalledTimes(4);
    expect(screen.queryByText(/Multiple errors detected/)).not.toBeInTheDocument();
    expect(jest.getTimerCount()).toBe(1);
  });

  test('children that stay up after an automatic reset clear the earlier failures', () => {
    let throws = true;
    let setTick;
    function Flaky() {
      const [, update] = React.useState(0);
      setTick = update;
      if (throws) throw new Error('flaky boom');
      return <div>ok</div>;
    }
    renderBoundary(<Flaky />);

    throws = false;
    act(() => {
      jest.advanceTimersByTime(DELAY);
    });
    expect(screen.getByText('ok')).toBeInTheDocument();
    // Healthy for a full delay: the count resets.
    act(() => {
      jest.advanceTimersByTime(DELAY);
    });

    // Two more failures in a row are still retried (count restarted at 0).
    throws = true;
    act(() => {
      setTick((n) => n + 1);
    });
    expect(sendError).toHaveBeenCalledTimes(2);
    act(() => {
      jest.advanceTimersByTime(DELAY);
    });
    expect(sendError).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(/Multiple errors detected/)).not.toBeInTheDocument();
    // Still under the cap, so one more retry runs.
    act(() => {
      jest.advanceTimersByTime(DELAY);
    });
    expect(sendError).toHaveBeenCalledTimes(4);
  });
});
