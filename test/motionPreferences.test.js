/**
 * @jest-environment jsdom
 *
 * Verifies that the shared reduced-motion utilities read from
 * `matchMedia('(prefers-reduced-motion: reduce)')` and that the
 * `useReducedMotion` hook reacts to runtime changes of the OS preference.
 */

const React = require('react');
const { renderHook, act } = require('@testing-library/react');

const {
  prefersReducedMotion,
  getScrollBehavior,
  useReducedMotion
} = require('../src/renderer/utils/motionPreferences');

function installMatchMediaMock(initialMatches) {
  let currentMatches = initialMatches;
  const listeners = new Set();

  const mediaQueryList = {
    get matches() {
      return currentMatches;
    },
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener: jest.fn((event, handler) => {
      if (event === 'change') listeners.add(handler);
    }),
    removeEventListener: jest.fn((event, handler) => {
      if (event === 'change') listeners.delete(handler);
    }),
    addListener: jest.fn((handler) => listeners.add(handler)),
    removeListener: jest.fn((handler) => listeners.delete(handler)),
    dispatchEvent: jest.fn()
  };

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: jest.fn().mockImplementation(() => mediaQueryList)
  });

  return {
    setMatches(next) {
      currentMatches = next;
      listeners.forEach((handler) => handler({ matches: next }));
    }
  };
}

describe('motionPreferences', () => {
  afterEach(() => {
    delete window.matchMedia;
  });

  describe('prefersReducedMotion', () => {
    it('returns false when matchMedia is unavailable', () => {
      expect(prefersReducedMotion()).toBe(false);
    });

    it('returns the matchMedia result when available', () => {
      installMatchMediaMock(true);
      expect(prefersReducedMotion()).toBe(true);
    });
  });

  describe('getScrollBehavior', () => {
    it('returns "smooth" by default', () => {
      installMatchMediaMock(false);
      expect(getScrollBehavior()).toBe('smooth');
    });

    it('returns "auto" when reduced motion is requested', () => {
      installMatchMediaMock(true);
      expect(getScrollBehavior()).toBe('auto');
    });
  });

  describe('useReducedMotion', () => {
    it('returns false when matchMedia is unavailable', () => {
      const { result } = renderHook(() => useReducedMotion());
      expect(result.current).toBe(false);
    });

    it('reflects the current matchMedia value', () => {
      installMatchMediaMock(true);
      const { result } = renderHook(() => useReducedMotion());
      expect(result.current).toBe(true);
    });

    it('re-renders when the OS preference toggles at runtime', () => {
      const controls = installMatchMediaMock(false);
      const { result } = renderHook(() => useReducedMotion());
      expect(result.current).toBe(false);

      act(() => {
        controls.setMatches(true);
      });
      expect(result.current).toBe(true);

      act(() => {
        controls.setMatches(false);
      });
      expect(result.current).toBe(false);
    });
  });
});
