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
