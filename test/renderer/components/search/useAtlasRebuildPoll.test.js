/**
 * @jest-environment jsdom
 *
 * While the Atlas projection is rebuilding the tab re-asks for it, because
 * the rebuild pushes no "done" signal. That re-ask used to run every 3 s for
 * as long as the rebuild lasted, hidden window or not. It now backs off to
 * one request a minute and pauses while the window is hidden.
 */
import { renderHook, act } from '@testing-library/react';
import {
  useAtlasRebuildPoll,
  rebuildPollDelay,
  REBUILD_POLL_BASE_MS,
  REBUILD_POLL_MAX_MS
} from '../../../../src/renderer/components/search/hooks/useAtlasRebuildPoll';

let hidden = false;

beforeAll(() => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
});
afterAll(() => {
  delete document.hidden;
});

/**
 * Mount the hook with a reload that behaves like the tab's loadProjection:
 * the status goes to 'loading' and comes back as `answer()`.
 */
function mount({ active = true, answer = () => 'rebuilding' } = {}) {
  let rerenderRef = null;
  let currentActive = active;
  const reload = jest.fn(() => {
    rerenderRef({ status: 'loading', active: currentActive });
    rerenderRef({ status: answer(), active: currentActive });
  });
  const hook = renderHook((p) => useAtlasRebuildPoll({ reload, ...p }), {
    initialProps: { status: 'rebuilding', active }
  });
  rerenderRef = (p) => act(() => hook.rerender(p));
  return {
    reload,
    rerender: (p) => {
      currentActive = p.active ?? currentActive;
      rerenderRef(p);
    }
  };
}

const advance = (ms) =>
  act(() => {
    jest.advanceTimersByTime(ms);
  });

describe('useAtlasRebuildPoll', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    hidden = false;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('the wait doubles from 3 s and stops growing at a minute', () => {
    expect(rebuildPollDelay(0)).toBe(REBUILD_POLL_BASE_MS);
    expect(rebuildPollDelay(1)).toBe(REBUILD_POLL_BASE_MS * 2);
    expect(rebuildPollDelay(2)).toBe(REBUILD_POLL_BASE_MS * 4);
    expect(rebuildPollDelay(50)).toBe(REBUILD_POLL_MAX_MS);
  });

  test('a long rebuild is polled far less often than every 3 s', () => {
    const { reload } = mount();
    advance(10 * 60 * 1000);
    // 3 + 6 + 12 + 24 + 48 s, then once a minute: about 14 polls in ten
    // minutes, against 200 at a flat 3 s.
    expect(reload.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(reload.mock.calls.length).toBeLessThanOrEqual(16);
  });

  test('the first poll still comes after 3 s', () => {
    const { reload } = mount();
    advance(REBUILD_POLL_BASE_MS - 1);
    expect(reload).not.toHaveBeenCalled();
    advance(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('nothing is asked while the window is hidden; showing it polls at once', () => {
    const { reload } = mount();
    hidden = true;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    advance(10 * 60 * 1000);
    expect(reload).not.toHaveBeenCalled();

    hidden = false;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('a finished rebuild stops polling, and the next rebuild starts fast again', () => {
    let next = 'rebuilding';
    const { reload, rerender } = mount({ answer: () => next });
    advance(3000 + 6000 + 12000);
    expect(reload).toHaveBeenCalledTimes(3);

    next = 'ready';
    advance(24000);
    expect(reload).toHaveBeenCalledTimes(4);
    advance(10 * 60 * 1000);
    expect(reload).toHaveBeenCalledTimes(4);

    next = 'rebuilding';
    rerender({ status: 'rebuilding', active: true });
    advance(REBUILD_POLL_BASE_MS);
    expect(reload).toHaveBeenCalledTimes(5);
  });

  test('leaving the tab stops polling', () => {
    const { reload, rerender } = mount();
    rerender({ status: 'rebuilding', active: false });
    advance(10 * 60 * 1000);
    expect(reload).not.toHaveBeenCalled();
  });
});
