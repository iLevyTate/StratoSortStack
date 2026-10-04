'use strict';

const { renderHook, act } = require('@testing-library/react');
const { useMediaQuery } = require('../../src/renderer/hooks/useMediaQuery');

// jsdom does not implement matchMedia, so we install a controllable fake.
function makeMatchMedia({ matches = false, legacy = false } = {}) {
  let current = matches;
  const listeners = new Set();
  const mql = {
    get matches() {
      return current;
    },
    media: '(max-width: 768px)'
  };
  if (legacy) {
    mql.addListener = (cb) => listeners.add(cb);
    mql.removeListener = (cb) => listeners.delete(cb);
  } else {
    mql.addEventListener = (_type, cb) => listeners.add(cb);
    mql.removeEventListener = (_type, cb) => listeners.delete(cb);
  }
  const dispatch = (next) => {
    current = next;
    for (const cb of listeners) cb({ matches: next });
  };
  return { mql, dispatch, listeners };
}

describe('useMediaQuery', () => {
  let original;
  beforeEach(() => {
    original = window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = original;
  });

  test('returns the initial matches value from matchMedia', () => {
    const { mql } = makeMatchMedia({ matches: true });
    window.matchMedia = jest.fn(() => mql);
    const { result } = renderHook(() => useMediaQuery('(max-width: 768px)'));
    expect(result.current).toBe(true);
  });

  test('re-renders when the media query flips', () => {
    const { mql, dispatch } = makeMatchMedia({ matches: false });
    window.matchMedia = jest.fn(() => mql);
    const { result } = renderHook(() => useMediaQuery('(max-width: 768px)'));
    expect(result.current).toBe(false);
    act(() => dispatch(true));
    expect(result.current).toBe(true);
  });

  test('unsubscribes the change listener on unmount', () => {
    const { mql, listeners } = makeMatchMedia({ matches: false });
    window.matchMedia = jest.fn(() => mql);
    const { unmount } = renderHook(() => useMediaQuery('(max-width: 768px)'));
    expect(listeners.size).toBe(1);
    unmount();
    expect(listeners.size).toBe(0);
  });

  test('supports the legacy addListener/removeListener API', () => {
    const { mql, dispatch } = makeMatchMedia({ matches: false, legacy: true });
    window.matchMedia = jest.fn(() => mql);
    const { result } = renderHook(() => useMediaQuery('(max-width: 768px)'));
    act(() => dispatch(true));
    expect(result.current).toBe(true);
  });

  test('returns false when matchMedia is unavailable', () => {
    window.matchMedia = undefined;
    const { result } = renderHook(() => useMediaQuery('(max-width: 768px)'));
    expect(result.current).toBe(false);
  });

  test('returns false when matchMedia throws (malformed query)', () => {
    window.matchMedia = jest.fn(() => {
      throw new Error('bad query');
    });
    const { result } = renderHook(() => useMediaQuery('@@@'));
    expect(result.current).toBe(false);
  });
});
