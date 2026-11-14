/**
 * @jest-environment jsdom
 */

import { act, renderHook } from '@testing-library/react';
import { useToast } from '../../src/renderer/components/Toast';

describe('useToast', () => {
  it('returns the merged toast id for back-to-back grouped adds', () => {
    const { result } = renderHook(() => useToast());

    let firstId;
    let secondId;
    act(() => {
      firstId = result.current.addToast('First', 'info', 3000, 'group-1');
      secondId = result.current.addToast('Second', 'warning', 3000, 'group-1');
    });

    expect(secondId).toBe(firstId);
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].mergeCount).toBe(2);
  });

  it('assigns a UUID-format id to a new toast', () => {
    const { result } = renderHook(() => useToast());
    let id;
    act(() => {
      id = result.current.addToast('Unique', 'info', 3000);
    });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

// An error (often a long path) must stay until the user dismisses it, and a
// burst of lesser toasts must not push it off the stack before it is read.
describe('useToast severity rules', () => {
  it('error toasts ignore the passed duration and stay until dismissed', () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.addToast('Disk full', 'error', 5000);
    });
    expect(result.current.toasts[0].duration).toBe(0);
  });

  it('showError stays until dismissed', () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.showError('Could not move /Volumes/SSD/a.xlsx');
    });
    expect(result.current.toasts[0].duration).toBe(0);
  });

  it('warning toasts stay at least 10 s', () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.addToast('w', 'warning', 3000);
    });
    expect(result.current.toasts[0].duration).toBe(10000);
  });

  it('a warning that asked to stay until dismissed still does', () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.addToast('w', 'warning', 0);
    });
    expect(result.current.toasts[0].duration).toBe(0);
  });

  it('info and success keep the duration they were given', () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.addToast('i', 'info', 3000);
      result.current.addToast('s', 'success', 2000);
    });
    expect(result.current.toasts.map((t) => t.duration)).toEqual([3000, 2000]);
  });

  it('an info toast merged into an error group becomes sticky', () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.addToast('first', 'info', 3000, 'g');
      result.current.addToast('second', 'error', 3000, 'g');
    });
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0].severity).toBe('error');
    expect(result.current.toasts[0].duration).toBe(0);
  });

  it('a fifth toast evicts the oldest non-error toast and keeps the error', () => {
    const { result } = renderHook(() => useToast());
    let errorId;
    let firstInfoId;
    act(() => {
      errorId = result.current.addToast('Disk full', 'error');
      firstInfoId = result.current.addToast('info 1', 'info');
      result.current.addToast('info 2', 'info');
      result.current.addToast('info 3', 'info');
      result.current.addToast('info 4', 'info');
    });
    const ids = result.current.toasts.map((t) => t.id);
    expect(ids).toContain(errorId);
    expect(ids).not.toContain(firstInfoId);
    expect(result.current.toasts).toHaveLength(4);
    expect(result.current.drainEvictedIds()).toEqual([firstInfoId]);
  });

  it('keeps only the newest three errors open', () => {
    const { result } = renderHook(() => useToast());
    const ids = [];
    act(() => {
      for (let i = 1; i <= 5; i += 1) ids.push(result.current.addToast(`e${i}`, 'error'));
    });
    expect(result.current.toasts.map((t) => t.id)).toEqual(ids.slice(2));
    expect(result.current.drainEvictedIds()).toEqual(ids.slice(0, 2));
  });

  // Errors stay until dismissed, so with four of them open a new success
  // toast (the end-of-run report) used to be evicted the moment it was added.
  it('a new toast is never evicted by its own addition', () => {
    const { result } = renderHook(() => useToast());
    const errorIds = [];
    let successId;
    act(() => {
      for (let i = 1; i <= 4; i += 1) errorIds.push(result.current.addToast(`e${i}`, 'error'));
      successId = result.current.addToast('Organized 275 files', 'success');
    });
    const ids = result.current.toasts.map((t) => t.id);
    expect(ids).toContain(successId);
    expect(ids).toEqual([...errorIds.slice(1), successId]);
    expect(result.current.drainEvictedIds()).not.toContain(successId);
  });

  it('a new info toast stays when the other three open toasts are errors', () => {
    const { result } = renderHook(() => useToast());
    let infoId;
    act(() => {
      result.current.addToast('old info', 'info');
      for (let i = 1; i <= 3; i += 1) result.current.addToast(`e${i}`, 'error');
      infoId = result.current.addToast('new info', 'info');
    });
    const toasts = result.current.toasts;
    expect(toasts).toHaveLength(4);
    expect(toasts[toasts.length - 1].id).toBe(infoId);
    expect(toasts.filter((t) => t.severity === 'error')).toHaveLength(3);
  });

  it('stores copyable details passed in meta', () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.addToast('Could not move', 'error', 0, null, { details: 'EPERM' });
      result.current.addToast('plain', 'info', 0);
    });
    expect(result.current.toasts[0].details).toBe('EPERM');
    expect(result.current.toasts[1].details).toBeNull();
  });
});
