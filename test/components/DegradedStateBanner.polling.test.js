/**
 * @jest-environment jsdom
 *
 * The degraded-state banner polls the main process for flags. Nobody can read
 * it while the window is hidden, so it must not poll then, and it must fetch
 * once as soon as the window is shown again.
 */
import React from 'react';
import { render, act } from '@testing-library/react';

const mockDispatch = jest.fn();
jest.mock('../../src/renderer/store/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector) =>
    selector({
      system: { degradedFlags: [] },
      files: { smartFoldersError: null },
      ui: { settingsError: null }
    })
}));

jest.mock('../../src/renderer/store/slices/systemSlice', () => ({
  fetchDegradedState: () => ({ type: 'system/fetchDegradedState' }),
  dismissDegradedFlag: (code) => ({ type: 'system/dismissDegradedFlag', payload: code })
}));

jest.mock('../../src/renderer/services/ipc', () => ({
  whisperIpc: { installModel: jest.fn() }
}));

jest.mock('../../src/shared/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() })
}));

import DegradedStateBanner from '../../src/renderer/components/layout/DegradedStateBanner';

let hidden = false;
const setHidden = (value) => {
  hidden = value;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};
const fetchCount = () =>
  mockDispatch.mock.calls.filter(([a]) => a?.type === 'system/fetchDegradedState').length;
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe('DegradedStateBanner polling', () => {
  beforeAll(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  });

  afterAll(() => {
    delete document.hidden;
  });

  beforeEach(() => {
    jest.useFakeTimers();
    hidden = false;
    mockDispatch.mockReset();
    mockDispatch.mockImplementation(() => Promise.resolve([]));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('does not poll while the window is hidden, and fetches once when shown', async () => {
    render(<DegradedStateBanner />);
    await flush();
    expect(fetchCount()).toBe(1);

    setHidden(true);
    await act(async () => {
      jest.advanceTimersByTime(60 * 60 * 1000);
    });
    await flush();
    expect(fetchCount()).toBe(1);

    setHidden(false);
    await flush();
    expect(fetchCount()).toBe(2);

    // Normal cadence resumes afterwards.
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    await flush();
    expect(fetchCount()).toBe(3);
  });

  test('a banner mounted in a hidden window waits until it is shown', async () => {
    hidden = true;
    render(<DegradedStateBanner />);
    await flush();
    expect(fetchCount()).toBe(0);

    setHidden(false);
    await flush();
    expect(fetchCount()).toBe(1);
  });

  test('showing the window while a fetch is still running does not start a second loop', async () => {
    let resolveFirst;
    mockDispatch.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveFirst = r;
        })
    );
    render(<DegradedStateBanner />);
    await flush();
    expect(fetchCount()).toBe(1);

    setHidden(true);
    setHidden(false);
    await flush();
    expect(fetchCount()).toBe(1);

    await act(async () => {
      resolveFirst([]);
    });
    await flush();
    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });
    await flush();
    expect(fetchCount()).toBe(2);
  });
});
