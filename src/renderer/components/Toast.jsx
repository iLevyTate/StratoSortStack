import React, { useState, useEffect, useRef, useCallback } from 'react';
import PropTypes from 'prop-types';
import { CheckCircle2, XCircle, AlertTriangle, Info, X, Bell } from 'lucide-react';
import { createLogger } from '../../shared/logger';
import { TIMEOUTS } from '../../shared/performanceConstants';
import { IconButton } from './ui';
import { Text } from './ui/Typography';

const logger = createLogger('Toast');
const generateSecureId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `toast-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const MAX_TOASTS = 4;
const GROUP_WINDOW_MS = 2000; // merge toasts with same groupKey within 2s
const getHighestSeverity = (a, b) => {
  const order = { error: 3, warning: 2, success: 1, info: 0 };
  const aScore = order[a] ?? 0;
  const bScore = order[b] ?? 0;
  return aScore >= bScore ? a : b;
};

function Toast({
  message,
  severity = 'info',
  duration = 4500,
  onClose,
  onActivate,
  actionable = false,
  show = true,
  mergeCount = 0
}) {
  const [isVisible, setIsVisible] = useState(show);
  const closeTimerRef = useRef(null);
  const animationTimerRef = useRef(null);
  const onCloseRef = useRef(onClose);

  // Keep onClose ref in sync
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    setIsVisible(show);
  }, [show]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      if (animationTimerRef.current) {
        clearTimeout(animationTimerRef.current);
        animationTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (show && duration > 0) {
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null;
        setIsVisible(false);
        animationTimerRef.current = setTimeout(
          () => onCloseRef.current?.(),
          TIMEOUTS.ANIMATION_MEDIUM
        );
      }, duration);

      return () => {
        if (closeTimerRef.current) {
          clearTimeout(closeTimerRef.current);
          closeTimerRef.current = null;
        }
        if (animationTimerRef.current) {
          clearTimeout(animationTimerRef.current);
          animationTimerRef.current = null;
        }
      };
    }

    return undefined;
  }, [show, duration]);

  const handleClose = () => {
    setIsVisible(false);
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (animationTimerRef.current) {
      clearTimeout(animationTimerRef.current);
      animationTimerRef.current = null;
    }
    animationTimerRef.current = setTimeout(() => {
      animationTimerRef.current = null;
      onCloseRef.current?.();
    }, TIMEOUTS.ANIMATION_MEDIUM);
  };

  const handleActivate = () => {
    if (!actionable) return;
    onActivate?.();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      handleClose();
      return;
    }
    if (actionable && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      handleActivate();
    }
  };

  // Compact, modern severity styling
  const getSeverityClasses = () => {
    switch (severity) {
      case 'success':
        return 'toast-success';
      case 'error':
        return 'toast-error';
      case 'warning':
        return 'toast-warning';
      case 'info':
      default:
        return 'toast-info';
    }
  };

  // Smaller icons for compact design
  const getSeverityIcon = () => {
    const iconClass = 'w-4 h-4 flex-shrink-0';
    switch (severity) {
      case 'success':
        return <CheckCircle2 className={iconClass} />;
      case 'error':
        return <XCircle className={iconClass} />;
      case 'warning':
        return <AlertTriangle className={iconClass} />;
      case 'info':
      default:
        return <Info className={iconClass} />;
    }
  };

  // Comprehensive fallback style that matches the CSS exactly
  const fallbackStyle = {
    transform: isVisible ? 'translateX(0)' : 'translateX(100%)',
    transition: 'all var(--duration-slow) ease-in-out'
  };

  if (!show && !isVisible) return null;

  const renderMessageContent = () => {
    if (React.isValidElement(message)) {
      return message;
    }

    if (message && typeof message === 'object') {
      try {
        const readableType = message.message || message.text || message.title;
        if (typeof readableType === 'string') return readableType;
        return JSON.stringify(message);
      } catch {
        return String(message);
      }
    }

    return message;
  };

  /* eslint-disable jsx-a11y/no-static-element-interactions, jsx-a11y/no-noninteractive-tabindex -- role/tabIndex/keydown are conditional on `actionable`; keyboard support exists when interactive */
  return (
    <div
      className={`toast-compact ${getSeverityClasses()} ${isVisible ? 'show' : ''} ${
        actionable ? 'cursor-pointer hover:brightness-[0.98]' : ''
      }`}
      style={fallbackStyle}
      role={actionable ? 'button' : 'alert'}
      aria-live="polite"
      tabIndex={actionable ? 0 : -1}
      onClick={actionable ? handleActivate : undefined}
      onKeyDown={handleKeyDown}
      title={actionable ? 'Open in StratoSort' : undefined}
    >
      {/* eslint-enable jsx-a11y/no-static-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true">{getSeverityIcon()}</span>
        <Text
          as="span"
          variant="small"
          className="flex-1 min-w-0 text-[13px] font-medium leading-snug break-words"
        >
          {renderMessageContent()}
          {mergeCount > 1 && (
            <Text
              as="span"
              variant="tiny"
              className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-current/15 text-[10px] font-semibold"
            >
              {mergeCount}
            </Text>
          )}
        </Text>
        <IconButton
          onClick={(event) => {
            event.stopPropagation();
            handleClose();
          }}
          icon={<X className="w-3.5 h-3.5" aria-hidden="true" />}
          size="sm"
          variant="ghost"
          className="ml-1 h-6 w-6 text-current/70 hover:text-current hover:bg-current/10"
          aria-label="Dismiss"
        />
      </div>
    </div>
  );
}

Toast.propTypes = {
  message: PropTypes.oneOfType([PropTypes.string, PropTypes.node, PropTypes.object]),
  severity: PropTypes.oneOf(['info', 'success', 'error', 'warning']),
  duration: PropTypes.number,
  onClose: PropTypes.func,
  onActivate: PropTypes.func,
  actionable: PropTypes.bool,
  show: PropTypes.bool,
  mergeCount: PropTypes.number
};

// Toast Container for managing multiple toasts - compact design
export function ToastContainer({ toasts = [], onRemoveToast, onActivateToast }) {
  const [position] = useState(() => {
    try {
      return localStorage.getItem('toastPosition') || 'top-right';
    } catch {
      return 'top-right';
    }
  });
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('toastCollapsed') === 'true';
    } catch {
      return false;
    }
  });

  const containerStyle = () => {
    const base = { position: 'fixed', zIndex: 'var(--z-toast, 700)' };
    const bottomOffset = 'var(--toast-offset, 72px)';
    const topOffset = 'var(--toast-top-offset, calc(var(--app-nav-height) + 16px))';
    switch (position) {
      case 'top-right':
        return { ...base, top: topOffset, right: '16px' };
      case 'top-left':
        return { ...base, top: topOffset, left: '16px' };
      case 'bottom-left':
        return { ...base, bottom: `calc(${bottomOffset})`, left: '16px' };
      default:
        return { ...base, bottom: `calc(${bottomOffset})`, right: '16px' };
    }
  };

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      try {
        localStorage.setItem('toastCollapsed', String(!prev));
      } catch (error) {
        logger.warn('Failed to save toast collapsed state to localStorage', {
          error: error.message
        });
      }
      return !prev;
    });
  };

  const visibleToasts = toasts.slice(-MAX_TOASTS);
  const hiddenCount = Math.max(0, toasts.length - visibleToasts.length);

  return (
    <div
      aria-live="polite"
      aria-label="Notifications"
      className="z-toast pointer-events-none"
      style={containerStyle()}
    >
      {/* Compact toggle button */}
      <div className="pointer-events-auto mb-2 flex items-center justify-end">
        <div className="relative">
          <IconButton
            onClick={toggleCollapsed}
            icon={
              collapsed ? (
                <Bell className="w-4 h-4" aria-hidden="true" />
              ) : (
                <X className="w-4 h-4" aria-hidden="true" />
              )
            }
            size="sm"
            variant="ghost"
            className="h-8 w-8 rounded-full bg-system-gray-100/95 border border-system-gray-200/80 text-system-gray-600 hover:bg-system-gray-100 hover:text-system-gray-800 shadow-sm backdrop-blur-sm"
            aria-label={
              collapsed
                ? 'Expand notification list (alerts are not muted; this only hides the list)'
                : 'Collapse notification list'
            }
            title={
              collapsed
                ? 'Show the notification stack (does not mute alerts)'
                : 'Hide the notification stack (does not mute alerts)'
            }
            aria-expanded={!collapsed}
            aria-controls="toast-panel"
          />
          {toasts.length > 0 && collapsed && (
            <Text
              as="span"
              variant="tiny"
              className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-stratosort-blue text-white text-[9px] font-medium leading-4 text-center"
            >
              {toasts.length}
            </Text>
          )}
        </div>
      </div>

      {/* Toast stack */}
      <div id="toast-panel" aria-hidden={collapsed} className="flex flex-col gap-compact">
        {!collapsed &&
          visibleToasts.map((toast) => (
            <div key={toast.id} className="pointer-events-auto">
              <Toast
                message={toast.message}
                severity={toast.severity || toast.type}
                duration={toast.duration}
                show={toast.show !== false}
                actionable={Boolean(toast.actionable)}
                onActivate={() => onActivateToast?.(toast)}
                onClose={() => onRemoveToast?.(toast.id)}
                mergeCount={toast.mergeCount || 0}
              />
            </div>
          ))}
        {!collapsed && hiddenCount > 0 && (
          <Text
            as="div"
            variant="tiny"
            className="pointer-events-none text-system-gray-400 text-right"
          >
            +{hiddenCount} more
          </Text>
        )}
      </div>
    </div>
  );
}

ToastContainer.propTypes = {
  toasts: PropTypes.arrayOf(PropTypes.object),
  onRemoveToast: PropTypes.func,
  onActivateToast: PropTypes.func
};

// Hook for using toasts (with simple grouping and caps)
export const useToast = () => {
  const [toasts, setToasts] = useState([]);
  const toastsRef = useRef(toasts);
  // Track IDs of toasts evicted by the cap so callers can clean up external mappings
  const evictedIdsRef = useRef([]);

  useEffect(() => {
    toastsRef.current = toasts;
  }, [toasts]);

  const addToast = useCallback(
    (message, severity = 'info', duration = 5200, groupKey = null, meta = null) => {
      const previousToasts = toastsRef.current;
      const now = Date.now();
      const existingGroupedToast = groupKey
        ? previousToasts.find(
            (toast) =>
              toast.groupKey === groupKey && now - (toast.createdAt || now) <= GROUP_WINDOW_MS
          )
        : null;
      const toastId = existingGroupedToast?.id || generateSecureId();
      let nextToasts = previousToasts;

      // If grouping, try to merge with an existing toast
      if (groupKey) {
        const idx = previousToasts.findIndex(
          (toast) =>
            toast.groupKey === groupKey && now - (toast.createdAt || now) <= GROUP_WINDOW_MS
        );
        if (idx !== -1) {
          const existing = previousToasts[idx];
          const mergeCount = (existing.mergeCount || 1) + 1;
          const updated = {
            ...existing,
            id: existing.id, // keep id stable for animation
            message: existing.originalMessage || existing.message,
            originalMessage: existing.originalMessage || existing.message,
            mergeCount,
            severity: getHighestSeverity(existing.severity || 'info', severity || 'info'),
            duration: duration ?? existing.duration,
            createdAt: existing.createdAt || now
          };
          nextToasts = previousToasts.slice();
          nextToasts[idx] = updated;
        }
      }

      if (nextToasts === previousToasts) {
        nextToasts = [
          ...previousToasts,
          {
            id: toastId,
            message,
            severity,
            duration,
            show: true,
            groupKey: groupKey || null,
            createdAt: now,
            actionable: Boolean(meta?.actionable),
            activationType: meta?.type || null,
            activationData: meta?.data ?? null
          }
        ];
        // Cap visible toasts - track evicted IDs for caller cleanup
        while (nextToasts.length > MAX_TOASTS) {
          const evicted = nextToasts.shift();
          if (evicted) evictedIdsRef.current.push(evicted.id);
        }
      }

      toastsRef.current = nextToasts;
      setToasts(nextToasts);

      return toastId;
    },
    []
  );

  const removeToast = useCallback((id) => {
    const nextToasts = toastsRef.current.filter((toast) => toast.id !== id);
    toastsRef.current = nextToasts;
    setToasts(nextToasts);
  }, []);

  const clearAllToasts = useCallback(() => {
    toastsRef.current = [];
    setToasts([]);
  }, []);

  const showSuccess = useCallback(
    (message, duration = 5200, meta = null) => addToast(message, 'success', duration, null, meta),
    [addToast]
  );
  const showError = useCallback(
    (message, duration = 6200, meta = null) => addToast(message, 'error', duration, null, meta),
    [addToast]
  ); // Errors stay longer
  const showWarning = useCallback(
    (message, duration = 5200, meta = null) => addToast(message, 'warning', duration, null, meta),
    [addToast]
  );
  const showInfo = useCallback(
    (message, duration = 5200, meta = null) => addToast(message, 'info', duration, null, meta),
    [addToast]
  ); // Info disappears quickly

  /**
   * Drain and return IDs of toasts that were evicted by the cap.
   * Callers should use this after addToast() to clean up any external
   * mappings (e.g., toast-to-notification ID maps).
   */
  const drainEvictedIds = useCallback(() => {
    const ids = evictedIdsRef.current;
    evictedIdsRef.current = [];
    return ids;
  }, []);

  return {
    toasts,
    addToast,
    removeToast,
    clearAllToasts,
    // Legacy alias used throughout app
    addNotification: addToast,
    // Convenience methods with shorter defaults for less invasiveness
    showSuccess,
    showError,
    showWarning,
    showInfo,
    // Eviction tracking for external cleanup
    drainEvictedIds
  };
};

export default Toast;
