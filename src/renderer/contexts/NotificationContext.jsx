import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import PropTypes from 'prop-types';
import { useDispatch } from 'react-redux';
import { createLogger } from '../../shared/logger';
import { ACTIVATABLE_NOTIFICATION_TYPES } from '../../shared/notificationTypes';
import { ToastContainer, useToast } from '../components/Toast';
import {
  addNotification as addSystemNotification,
  markNotificationDismissed,
  clearNotifications
} from '../store/slices/systemSlice';

const logger = createLogger('NotificationContext');
const NotificationContext = createContext(null);

const createUniqueNotificationId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

export function NotificationProvider({ children }) {
  const dispatch = useDispatch();
  const {
    toasts,
    addToast,
    removeToast,
    clearAllToasts,
    showSuccess,
    showError,
    showWarning,
    showInfo,
    drainEvictedIds
  } = useToast();
  // Map toast IDs to notification IDs for consistent Redux dismissal
  const toastToNotificationIdRef = useRef(new Map());

  const reconcileEvictedToasts = useCallback(() => {
    for (const evictedId of drainEvictedIds()) {
      const evictedNotifId = toastToNotificationIdRef.current.get(evictedId);
      if (evictedNotifId) {
        toastToNotificationIdRef.current.delete(evictedId);
        dispatch(markNotificationDismissed(evictedNotifId));
      }
    }
  }, [dispatch, drainEvictedIds]);

  const bindToastToNotification = useCallback(
    (toastId, notificationId) => {
      if (toastId == null || !notificationId) return;
      const previousNotificationId = toastToNotificationIdRef.current.get(toastId);
      if (previousNotificationId && previousNotificationId !== notificationId) {
        dispatch(markNotificationDismissed(previousNotificationId));
      }
      toastToNotificationIdRef.current.set(toastId, notificationId);
    },
    [dispatch]
  );

  const addNotification = useCallback(
    (message, severity = 'info', duration = 5200, groupKey = null) => {
      const toastId = addToast(message, severity, duration, groupKey);
      const notificationId = createUniqueNotificationId();
      dispatch(
        addSystemNotification({
          id: notificationId,
          message,
          severity,
          duration,
          source: 'ui',
          type: 'ui'
        })
      );
      bindToastToNotification(toastId, notificationId);

      // Clean up mappings for any toasts evicted by the cap
      reconcileEvictedToasts();

      return toastId;
    },
    [addToast, bindToastToNotification, dispatch, reconcileEvictedToasts]
  );

  const removeNotification = useCallback(
    (id) => {
      removeToast(id);
      const notificationId = toastToNotificationIdRef.current.get(id);
      if (notificationId) {
        toastToNotificationIdRef.current.delete(id);
        // Sync dismissal to Redux to keep notification state consistent
        // This updates unreadNotificationCount and marks the notification as dismissed
        dispatch(markNotificationDismissed(notificationId));
      }
    },
    [removeToast, dispatch]
  );

  // Wrapper for clearAllToasts that also syncs to Redux
  const handleClearAll = useCallback(() => {
    clearAllToasts();
    toastToNotificationIdRef.current.clear();
    // Clear notifications from Redux as well
    dispatch(clearNotifications());
  }, [clearAllToasts, dispatch]);

  // NOTE: onAppError is handled by ipcMiddleware (dispatches addNotification to Redux
  // and emits 'app:notification' custom event). No duplicate listener needed here.

  // Listen for notifications via custom event (dispatched by ipcMiddleware)
  // This avoids duplicate IPC listeners - the middleware handles IPC and emits this event
  useEffect(() => {
    const handleNotification = (event) => {
      try {
        // Uses unified schema with 'severity' field (not 'variant')
        const {
          id: payloadId,
          notificationId: explicitNotificationId,
          message,
          severity,
          duration = 6000,
          type,
          data,
          groupKey = null
        } = event.detail || {};
        if (!message) return;

        const notificationId = explicitNotificationId || payloadId;
        // Grouped toasts keep the first message, so a type-only default key
        // would swallow distinct errors arriving in the same burst. Without an
        // explicit groupKey, only collapse identical repeats of the same message.
        const resolvedGroupKey = groupKey || `ipc:${type || 'notification'}:${message}`;

        const activationMeta = ACTIVATABLE_NOTIFICATION_TYPES.has(type)
          ? { actionable: true, type, data }
          : null;

        const toastSeverity =
          severity === 'success' || severity === 'error' || severity === 'warning'
            ? severity
            : 'info';
        const toastId = addToast(
          message,
          toastSeverity,
          duration,
          resolvedGroupKey,
          activationMeta
        );
        bindToastToNotification(toastId, notificationId);
        reconcileEvictedToasts();
      } catch (e) {
        logger.error('Failed to display notification', {
          error: e.message,
          stack: e.stack
        });
      }
    };

    window.addEventListener('app:notification', handleNotification);
    return () => window.removeEventListener('app:notification', handleNotification);
  }, [addToast, bindToastToNotification, reconcileEvictedToasts]);

  // All consumers only use action functions (addNotification, showSuccess, etc.)
  // and never read `notifications` directly. The ToastContainer receives `toasts`
  // as a direct prop below, so toast rendering is unaffected. By excluding `toasts`
  // from the context value and its dependencies, we prevent all 12+ consumers from
  // re-rendering every time a toast is added or removed.
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;

  const contextValue = useMemo(
    () => ({
      // Expose toasts via getter backed by ref so the context value object
      // does not change when toasts change. Components that truly need the
      // live toast list should read from ToastContainer (rendered below) or
      // subscribe to Redux notification state instead.
      get notifications() {
        return toastsRef.current;
      },
      addNotification,
      removeNotification,
      clearAllNotifications: handleClearAll,
      showSuccess,
      showError,
      showWarning,
      showInfo
    }),
    [
      addNotification,
      removeNotification,
      handleClearAll,
      showSuccess,
      showError,
      showWarning,
      showInfo
    ]
  );

  return (
    <NotificationContext.Provider value={contextValue}>
      {children}
      <ToastContainer
        toasts={toasts}
        onRemoveToast={removeNotification}
        onClearAll={handleClearAll}
        onActivateToast={(toast) => {
          if (!toast?.actionable || !toast?.activationType) return;
          try {
            window.dispatchEvent(
              new CustomEvent('app:notification-action', {
                detail: { type: toast.activationType, data: toast.activationData ?? null }
              })
            );
          } catch (error) {
            logger.error('Failed to handle toast activation', { error: error.message });
          }
        }}
      />
    </NotificationContext.Provider>
  );
}

NotificationProvider.propTypes = {
  children: PropTypes.node.isRequired
};

export function useNotification() {
  const context = useContext(NotificationContext);
  if (!context) throw new Error('useNotification must be used within NotificationProvider');
  return context;
}
