// @ts-check
import { useEffect } from 'react';
import { useAppDispatch } from '../store/hooks';
import { NotificationType } from '../../shared/notificationTypes';
import { navigateToOrganizeFromNotification } from '../store/slices/uiSlice';

const ORGANIZE_ACTIVATION_TYPES = new Set([
  NotificationType.LOW_CONFIDENCE,
  NotificationType.FILE_ORGANIZED,
  NotificationType.FILE_ANALYZED
]);

/**
 * Focus-driven navigation when the user clicks a download/watcher notification.
 */
export function useNotificationActivation() {
  const dispatch = useAppDispatch();

  useEffect(() => {
    const handleActivation = (/** @type {any} */ event) => {
      const { type, data } = event.detail || {};
      if (!ORGANIZE_ACTIVATION_TYPES.has(type)) return;

      dispatch(
        navigateToOrganizeFromNotification({
          filePath: data?.filePath || data?.destination || null,
          fileName: data?.fileName || null,
          openDetails: true
        })
      );
    };

    window.addEventListener('app:notification-action', handleActivation);
    return () => window.removeEventListener('app:notification-action', handleActivation);
  }, [dispatch]);
}

export default useNotificationActivation;
