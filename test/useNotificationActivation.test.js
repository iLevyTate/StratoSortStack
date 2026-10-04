/**
 * @jest-environment jsdom
 */
import { renderHook, act } from '@testing-library/react';
import { NotificationType } from '../src/shared/notificationTypes';

const mockDispatch = jest.fn();

jest.mock('../src/renderer/store/hooks', () => ({
  useAppDispatch: () => mockDispatch
}));

jest.mock('../src/renderer/store/slices/uiSlice', () => ({
  navigateToOrganizeFromNotification: jest.fn((payload) => ({
    type: 'ui/navigateToOrganizeFromNotification',
    payload
  }))
}));

import { useNotificationActivation } from '../src/renderer/hooks/useNotificationActivation';
import { navigateToOrganizeFromNotification } from '../src/renderer/store/slices/uiSlice';

describe('useNotificationActivation', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('dispatches organize navigation for LOW_CONFIDENCE activation', () => {
    renderHook(() => useNotificationActivation());

    act(() => {
      window.dispatchEvent(
        new CustomEvent('app:notification-action', {
          detail: {
            type: NotificationType.LOW_CONFIDENCE,
            data: { filePath: '/tmp/invoice.pdf', fileName: 'invoice.pdf' }
          }
        })
      );
    });

    expect(navigateToOrganizeFromNotification).toHaveBeenCalledWith({
      filePath: '/tmp/invoice.pdf',
      fileName: 'invoice.pdf',
      openDetails: true
    });
    expect(mockDispatch).toHaveBeenCalledWith({
      type: 'ui/navigateToOrganizeFromNotification',
      payload: {
        filePath: '/tmp/invoice.pdf',
        fileName: 'invoice.pdf',
        openDetails: true
      }
    });
  });

  test('uses destination as filePath fallback for FILE_ORGANIZED', () => {
    renderHook(() => useNotificationActivation());

    act(() => {
      window.dispatchEvent(
        new CustomEvent('app:notification-action', {
          detail: {
            type: NotificationType.FILE_ORGANIZED,
            data: { destination: '/dest/finance/invoice.pdf', fileName: 'invoice.pdf' }
          }
        })
      );
    });

    expect(navigateToOrganizeFromNotification).toHaveBeenCalledWith({
      filePath: '/dest/finance/invoice.pdf',
      fileName: 'invoice.pdf',
      openDetails: true
    });
  });

  test('ignores non-organize notification types', () => {
    renderHook(() => useNotificationActivation());

    act(() => {
      window.dispatchEvent(
        new CustomEvent('app:notification-action', {
          detail: {
            type: NotificationType.SYSTEM,
            data: { filePath: '/tmp/x.pdf' }
          }
        })
      );
    });

    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
