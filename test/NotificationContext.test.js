/**
 * @jest-environment jsdom
 */

import React from 'react';
import { act, render } from '@testing-library/react';
import {
  NotificationProvider,
  useNotification
} from '../src/renderer/contexts/NotificationContext';
import { markNotificationDismissed } from '../src/renderer/store/slices/systemSlice';

const mockDispatch = jest.fn();
const mockAddToast = jest.fn();
const mockRemoveToast = jest.fn();
const mockClearAllToasts = jest.fn();
const mockShowSuccess = jest.fn();
const mockShowError = jest.fn();
const mockShowWarning = jest.fn();
const mockShowInfo = jest.fn();
const mockDrainEvictedIds = jest.fn();

jest.mock('react-redux', () => ({
  useDispatch: () => mockDispatch
}));

jest.mock('../src/renderer/components/Toast', () => ({
  ToastContainer: () => null,
  useToast: () => ({
    toasts: [],
    addToast: mockAddToast,
    removeToast: mockRemoveToast,
    clearAllToasts: mockClearAllToasts,
    showSuccess: mockShowSuccess,
    showError: mockShowError,
    showWarning: mockShowWarning,
    showInfo: mockShowInfo,
    drainEvictedIds: mockDrainEvictedIds
  })
}));

describe('NotificationProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDrainEvictedIds.mockReturnValue([]);
    mockShowSuccess.mockReturnValue('toast-success');
    mockShowError.mockReturnValue('toast-error');
    mockShowWarning.mockReturnValue('toast-warning');
    mockShowInfo.mockReturnValue('toast-info');
  });

  it('dismisses Redux notifications for toasts evicted on app notifications', () => {
    mockAddToast.mockReturnValueOnce('toast-1').mockReturnValueOnce('toast-2');
    mockDrainEvictedIds.mockReturnValueOnce([]).mockReturnValueOnce(['toast-1']);

    render(
      <NotificationProvider>
        <div data-testid="child" />
      </NotificationProvider>
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent('app:notification', {
          detail: { id: 'notif-1', message: 'First', severity: 'success', duration: 1000 }
        })
      );
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent('app:notification', {
          detail: { id: 'notif-2', message: 'Second', severity: 'success', duration: 1000 }
        })
      );
    });

    expect(mockDispatch).toHaveBeenCalledWith(markNotificationDismissed('notif-1'));
  });

  it('uses unique Redux IDs even when toast ID is grouped/reused', () => {
    mockAddToast.mockReturnValue('grouped-toast');
    const TriggerGroupedNotifications = () => {
      const { addNotification } = useNotification();
      React.useEffect(() => {
        addNotification('First grouped message', 'info', 1000, 'group-key');
        addNotification('Second grouped message', 'info', 1000, 'group-key');
      }, [addNotification]);
      return null;
    };

    act(() => {
      render(
        <NotificationProvider>
          <TriggerGroupedNotifications />
        </NotificationProvider>
      );
    });

    const allActions = mockDispatch.mock.calls.map(([action]) => action);
    const addActions = allActions.filter((action) => action.type === 'system/addNotification');
    const dismissActions = allActions.filter(
      (action) => action.type === 'system/markNotificationDismissed'
    );

    expect(addActions).toHaveLength(2);
    expect(addActions[0].payload.id).not.toBe(addActions[1].payload.id);
    expect(dismissActions[0].payload).toBe(addActions[0].payload.id);
  });

  it('binds IPC toasts with id and groupKey (SW-75)', () => {
    mockAddToast.mockReturnValue('toast-app-error');

    render(
      <NotificationProvider>
        <div data-testid="child" />
      </NotificationProvider>
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent('app:notification', {
          detail: {
            id: 'app-error-1',
            notificationId: 'app-error-1',
            message: 'Disk full',
            severity: 'error',
            type: 'error',
            groupKey: 'app-error'
          }
        })
      );
    });

    expect(mockAddToast).toHaveBeenCalledWith('Disk full', 'error', 6000, 'app-error', null);
  });

  it('does not group distinct same-type IPC messages without an explicit groupKey (M8)', () => {
    mockAddToast.mockReturnValueOnce('toast-1').mockReturnValueOnce('toast-2');

    render(
      <NotificationProvider>
        <div data-testid="child" />
      </NotificationProvider>
    );

    const emit = (id, message) =>
      act(() => {
        window.dispatchEvent(
          new CustomEvent('app:notification', {
            detail: { id, message, severity: 'error', type: 'error' }
          })
        );
      });

    emit('err-1', 'Disk full');
    emit('err-2', 'Permission denied');
    emit('err-3', 'Disk full');

    const groupKeys = mockAddToast.mock.calls.map(([, , , key]) => key);
    expect(groupKeys[0]).not.toBe(groupKeys[1]);
    expect(groupKeys[2]).toBe(groupKeys[0]);
  });
});
