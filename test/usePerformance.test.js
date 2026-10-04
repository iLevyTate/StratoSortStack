/**
 * Tests for usePerformance hooks
 * Tests debounce hooks
 */

import { renderHook, act } from '@testing-library/react';

// Mock the performance utilities
jest.mock('../src/renderer/utils/performance', () => ({
  debounce: (fn, delay) => {
    let timeoutId;
    const debounced = (...args) => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => fn(...args), delay);
    };
    debounced.cancel = () => clearTimeout(timeoutId);
    return debounced;
  }
}));

import { useDebounce, useDebouncedCallback } from '../src/renderer/hooks/usePerformance';

describe('usePerformance hooks', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('useDebounce', () => {
    test('returns initial value immediately', () => {
      const { result } = renderHook(() => useDebounce('initial', 500));

      expect(result.current).toBe('initial');
    });

    test('updates value after delay', () => {
      const { result, rerender } = renderHook(({ value }) => useDebounce(value, 500), {
        initialProps: { value: 'initial' }
      });

      expect(result.current).toBe('initial');

      rerender({ value: 'updated' });

      // Value should still be initial before delay
      expect(result.current).toBe('initial');

      // Advance timer
      act(() => {
        jest.advanceTimersByTime(500);
      });

      expect(result.current).toBe('updated');
    });

    test('resets timer on rapid changes', () => {
      const { result, rerender } = renderHook(({ value }) => useDebounce(value, 500), {
        initialProps: { value: 'initial' }
      });

      rerender({ value: 'first' });
      act(() => {
        jest.advanceTimersByTime(200);
      });

      rerender({ value: 'second' });
      act(() => {
        jest.advanceTimersByTime(200);
      });

      rerender({ value: 'third' });
      act(() => {
        jest.advanceTimersByTime(200);
      });

      // Should still be initial
      expect(result.current).toBe('initial');

      // Complete the debounce
      act(() => {
        jest.advanceTimersByTime(300);
      });

      expect(result.current).toBe('third');
    });

    test('clears timeout on unmount', () => {
      const { unmount } = renderHook(() => useDebounce('value', 500));

      unmount();

      expect(() => {
        act(() => {
          jest.advanceTimersByTime(500);
        });
      }).not.toThrow();
    });

    test('updates immediately when delay changes', () => {
      const { result, rerender } = renderHook(({ value, delay }) => useDebounce(value, delay), {
        initialProps: { value: 'initial', delay: 500 }
      });

      rerender({ value: 'updated', delay: 100 });

      act(() => {
        jest.advanceTimersByTime(100);
      });

      expect(result.current).toBe('updated');
    });
  });

  describe('useDebouncedCallback', () => {
    test('returns a function', () => {
      const callback = jest.fn();
      const { result } = renderHook(() => useDebouncedCallback(callback, 500));

      expect(typeof result.current).toBe('function');
    });

    test('debounces the callback', () => {
      const callback = jest.fn();
      const { result } = renderHook(() => useDebouncedCallback(callback, 500));

      act(() => {
        result.current('arg1');
        result.current('arg2');
        result.current('arg3');
      });

      expect(callback).not.toHaveBeenCalled();

      act(() => {
        jest.advanceTimersByTime(500);
      });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith('arg3');
    });

    test('passes arguments to callback', () => {
      const callback = jest.fn();
      const { result } = renderHook(() => useDebouncedCallback(callback, 500));

      act(() => {
        result.current('arg1', 'arg2', { key: 'value' });
      });

      act(() => {
        jest.advanceTimersByTime(500);
      });

      expect(callback).toHaveBeenCalledWith('arg1', 'arg2', { key: 'value' });
    });

    test('cancels on unmount', () => {
      const callback = jest.fn();
      const { result, unmount } = renderHook(() => useDebouncedCallback(callback, 500));

      act(() => {
        result.current('arg1');
      });

      unmount();

      act(() => {
        jest.advanceTimersByTime(500);
      });

      expect(callback).not.toHaveBeenCalled();
    });

    test('uses latest callback via ref', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      const { result, rerender } = renderHook(({ cb }) => useDebouncedCallback(cb, 500), {
        initialProps: { cb: callback1 }
      });

      act(() => {
        result.current('first call');
      });

      // Update callback
      rerender({ cb: callback2 });

      act(() => {
        jest.advanceTimersByTime(500);
      });

      // Should call the updated callback
      expect(callback1).not.toHaveBeenCalled();
      expect(callback2).toHaveBeenCalledWith('first call');
    });
  });
});
