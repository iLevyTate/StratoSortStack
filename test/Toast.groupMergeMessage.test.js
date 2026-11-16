/**
 * @jest-environment jsdom
 */

// A grouped toast that escalates to a higher severity must show the text that
// caused it. It used to keep the first message, so a warning or error arriving
// in the same group within the merge window showed the earlier, milder text.

import { act, renderHook } from '@testing-library/react';
import { useToast } from '../src/renderer/components/Toast';

describe('useToast group merge message', () => {
  it('shows the incoming error text when an info toast escalates', () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.addToast('Analysis complete!', 'success', 3000, 'analysis-complete');
      result.current.addToast('Analysis failed for all 3 files.', 'error', 0, 'analysis-complete', {
        details: 'code: E_ANALYSIS'
      });
    });
    expect(result.current.toasts).toHaveLength(1);
    const [toast] = result.current.toasts;
    expect(toast.severity).toBe('error');
    expect(toast.message).toBe('Analysis failed for all 3 files.');
    expect(toast.details).toBe('code: E_ANALYSIS');
    expect(toast.mergeCount).toBe(2);
  });

  it('shows the newest text when both toasts share a severity', () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.addToast('Removed from queue: A.pdf', 'info', 3000, 'file-actions');
      result.current.addToast('Removed from queue: B.pdf', 'info', 3000, 'file-actions');
    });
    expect(result.current.toasts[0].message).toBe('Removed from queue: B.pdf');
  });

  it('keeps the higher-severity text when a milder toast merges in', () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.addToast(
        'Removed from queue: B.pdf (cleanup incomplete)',
        'warning',
        3000,
        'file-actions',
        { actionable: true, type: 'open-file', data: { path: 'B.pdf' }, details: 'EBUSY' }
      );
      result.current.addToast('Removed from queue: C.pdf', 'info', 3000, 'file-actions');
    });
    const [toast] = result.current.toasts;
    expect(toast.severity).toBe('warning');
    expect(toast.message).toBe('Removed from queue: B.pdf (cleanup incomplete)');
    expect(toast.details).toBe('EBUSY');
    expect(toast.actionable).toBe(true);
    expect(toast.activationData).toEqual({ path: 'B.pdf' });
  });

  it('takes the click action of the message it shows', () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.addToast('First', 'info', 3000, 'g', {
        actionable: true,
        type: 'open-file',
        data: { path: 'a' }
      });
      result.current.addToast('Second', 'warning', 3000, 'g', {
        actionable: true,
        type: 'open-file',
        data: { path: 'b' }
      });
    });
    const [toast] = result.current.toasts;
    expect(toast.message).toBe('Second');
    expect(toast.activationData).toEqual({ path: 'b' });
  });
});
