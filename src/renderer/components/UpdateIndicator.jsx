import React, { useEffect, useState, useRef, useCallback } from 'react';
import { createLogger } from '../../shared/logger';
import { CheckCircle2 } from 'lucide-react';
import { Button } from './ui';
import { useNotification } from '../contexts/NotificationContext';

const logger = createLogger('UpdateIndicator');
const UpdateIndicator = React.memo(function UpdateIndicator() {
  const [status, setStatus] = useState('idle');
  const [visible, setVisible] = useState(false);
  const isMountedRef = useRef(true);
  const unsubscribeRef = useRef(null);
  const { addNotification } = useNotification();

  const notifyUpdateError = useCallback(
    (message) => {
      const detail = message || 'Update check failed. You can retry from Settings.';
      addNotification(detail, 'error', 7000, 'update-error');
      setStatus('idle');
      setVisible(false);
    },
    [addNotification]
  );

  useEffect(() => {
    isMountedRef.current = true;

    if (!window?.electronAPI?.events?.onAppUpdate) {
      logger.warn('Update API not available');
      return undefined;
    }

    try {
      unsubscribeRef.current = window.electronAPI.events.onAppUpdate((payload) => {
        if (!isMountedRef.current) return;

        try {
          if (!payload || !payload.status) {
            logger.warn('Invalid update payload', { payload });
            return;
          }

          if (payload.status === 'ready' || payload.status === 'downloaded') {
            setStatus('ready');
            setVisible(true);
          } else if (payload.status === 'available') {
            setStatus('downloading');
            setVisible(false);
            if (typeof window?.electronAPI?.system?.downloadUpdate === 'function') {
              void window.electronAPI.system
                .downloadUpdate()
                .then((res) => {
                  if (!isMountedRef.current) return undefined;
                  if (res && typeof res === 'object' && res.success === false) {
                    notifyUpdateError(res.error || 'Failed to download update.');
                  }
                  return undefined;
                })
                .catch((downloadErr) => {
                  // If the IPC itself rejects (channel torn down, preload error,
                  // timeout) we still owe the user a banner and a log entry;
                  // the previous chain would swallow this as an unhandled
                  // rejection and leave the UI stuck in "downloading".
                  if (!isMountedRef.current) return;
                  logger.error('downloadUpdate IPC rejected', {
                    error: downloadErr?.message || String(downloadErr)
                  });
                  notifyUpdateError(downloadErr?.message || 'Failed to start update download.');
                });
            }
          } else if (payload.status === 'downloading') {
            setStatus('downloading');
            setVisible(false);
          } else if (payload.status === 'none' || payload.status === 'not-available') {
            setStatus('idle');
            setVisible(false);
          } else if (payload.status === 'error') {
            notifyUpdateError(payload.error);
          }
        } catch (error) {
          logger.error('Error handling update event', {
            error: error.message,
            stack: error.stack
          });
        }
      });
    } catch (error) {
      logger.error('Failed to set up update listener', {
        error: error.message,
        stack: error.stack
      });
    }

    return () => {
      isMountedRef.current = false;
      if (unsubscribeRef.current && typeof unsubscribeRef.current === 'function') {
        try {
          unsubscribeRef.current();
        } catch (error) {
          logger.error('Error during cleanup', {
            error: error.message,
            stack: error.stack
          });
        }
      }
      unsubscribeRef.current = null;
    };
  }, [notifyUpdateError]);

  if (!visible) return null;

  const isApplying = status === 'applying';
  const label =
    status === 'applying' ? 'Updating…' : status === 'ready' ? 'Update ready' : 'Update';
  const toneClass =
    'bg-stratosort-success/10 text-stratosort-success border-stratosort-success/30 hover:bg-stratosort-success/20';

  return (
    <Button
      onClick={async () => {
        if (isApplying) return;

        try {
          if (!window?.electronAPI?.system?.applyUpdate) {
            logger.error('Apply update API not available');
            notifyUpdateError('Update install is unavailable right now. Try again from Settings.');
            return;
          }

          setStatus('applying');

          const updatePromise = window.electronAPI.system.applyUpdate();
          const UPDATE_TIMEOUT_MS = 30000;
          let timeoutId;
          const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('Update timeout')), UPDATE_TIMEOUT_MS);
          });

          let res;
          try {
            res = await Promise.race([updatePromise, timeoutPromise]);
          } finally {
            if (timeoutId) clearTimeout(timeoutId);
          }

          if (!res?.success) {
            logger.error('Failed to apply update');
            notifyUpdateError('Failed to apply the downloaded update. Try again from Settings.');
          }
        } catch (error) {
          logger.error('Error applying update', {
            error: error.message,
            stack: error.stack
          });
          notifyUpdateError(error?.message || 'Failed to apply the downloaded update.');
        }
      }}
      variant="subtle"
      size="sm"
      isLoading={isApplying}
      disabled={isApplying}
      leftIcon={isApplying ? null : <CheckCircle2 className="w-4 h-4" />}
      className={`border shadow-sm hover:shadow ${toneClass}`}
      title="Apply downloaded update"
      aria-label="Apply update"
    >
      {label}
    </Button>
  );
});

export default UpdateIndicator;
