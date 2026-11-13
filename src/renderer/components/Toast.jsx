import React, { useState, useEffect, useRef, useCallback } from 'react';
import PropTypes from 'prop-types';
import { CheckCircle2, XCircle, AlertTriangle, Info, X, Bell, Copy, Check } from 'lucide-react';
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
// Errors stay until dismissed. Only the newest few stay open, so there is
// always room for one other toast (a run's result, a warning).
const MAX_STICKY_ERRORS = 3;
const GROUP_WINDOW_MS = 2000; // merge toasts with same groupKey within 2s
// A warning needs time to be read; shorter requests are raised to this.
const MIN_WARNING_DURATION_MS = 10000;
const COPIED_FEEDBACK_MS = 2000;

/**
 * How long a toast of this severity stays. An error (often naming a path the
 * user needs to act on) stays until it is dismissed, whatever the caller
 * asked for; a warning stays at least MIN_WARNING_DURATION_MS unless it was
 * already asked to stay (0). Info and success keep the caller's duration.
 */
const durationForSeverity = (severity, duration) => {
  if (severity === 'error') return 0;
  if (severity === 'warning') {
    if (duration === 0) return 0;
    return Math.max(Number(duration) || 0, MIN_WARNING_DURATION_MS);
  }
  return duration;
};

/**
 * Apply the toast caps to `toasts` in place and return the evicted ids. The
 * toast `keepId` (the one just added or merged) is never evicted. Older
 * errors past MAX_STICKY_ERRORS go first, oldest first; then, while over
 * MAX_TOASTS, the oldest toast that is not an error, or else the oldest one.
 * @param {Array<{id: string, severity?: string}>} toasts
 * @param {string} keepId
 * @returns {string[]}
 */
const capToasts = (toasts, keepId) => {
  const evicted = [];
  const evictAt = (index) => {
    const [removed] = toasts.splice(index, 1);
    if (removed) evicted.push(removed.id);
  };
  const isError = (toast) => toast.severity === 'error';
  while (toasts.filter(isError).length > MAX_STICKY_ERRORS) {
    const index = toasts.findIndex((toast) => isError(toast) && toast.id !== keepId);
    if (index === -1) break;
    evictAt(index);
  }
  while (toasts.length > MAX_TOASTS) {
    let index = toasts.findIndex((toast) => !isError(toast) && toast.id !== keepId);
    if (index === -1) index = toasts.findIndex((toast) => toast.id !== keepId);
    if (index === -1) break;
    evictAt(index);
  }
  return evicted;
};

/** Plain text of a toast message, or '' when it is a React element. */
const messageToText = (message) => {
  if (React.isValidElement(message)) return '';
  if (message && typeof message === 'object') {
    const readable = message.message || message.text || message.title;
    if (typeof readable === 'string') return readable;
    try {
      return JSON.stringify(message);
    } catch {
      return String(message);
    }
  }
  return message == null ? '' : String(message);
};
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
  mergeCount = 0,
  details = null
}) {
  const [isVisible, setIsVisible] = useState(show);
  // The auto-dismiss timer waits while the pointer is over the toast or
  // focus is inside it, and starts again from the full duration after.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [copied, setCopied] = useState(false);
  const paused = hovered || focused;
  const closeTimerRef = useRef(null);
  const animationTimerRef = useRef(null);
  const copiedTimerRef = useRef(null);
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
      if (copiedTimerRef.current) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (show && duration > 0 && !paused) {
      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null;
        setIsVisible(false);
        animationTimerRef.current = setTimeout(
          () => onCloseRef.current?.(),
          TIMEOUTS.ANIMATION_MEDIUM
        );
      }, duration);

      // Only the pending close is cancelled: an exit animation that already
      // started (the toast is sliding out) finishes and removes the toast,
      // even if the pointer reaches it on the way out. Unmount clears both.
      return () => {
        if (closeTimerRef.current) {
          clearTimeout(closeTimerRef.current);
          closeTimerRef.current = null;
        }
      };
    }

    return undefined;
  }, [show, duration, paused]);

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

  const copyText = [messageToText(message), typeof details === 'string' ? details : '']
    .filter(Boolean)
    .join('\n\n');
  const canCopy = (severity === 'error' || severity === 'warning') && copyText.length > 0;

  const handleCopy = async (event) => {
    event.stopPropagation();
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard || typeof clipboard.writeText !== 'function') return;
    try {
      await clipboard.writeText(copyText);
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => {
        copiedTimerRef.current = null;
        setCopied(false);
      }, COPIED_FEEDBACK_MS);
    } catch (error) {
      logger.warn('Could not copy toast text', { error: error?.message });
    }
  };

  const handleBlur = (event) => {
    // Moving focus between the toast's own buttons keeps it paused.
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setFocused(false);
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
    if (React.isValidElement(message)) return message;
    if (message && typeof message === 'object') return messageToText(message);
    return message;
  };

  /* eslint-disable jsx-a11y/no-static-element-interactions, jsx-a11y/no-noninteractive-tabindex -- role/tabIndex/keydown are conditional on `actionable`; keyboard support exists when interactive */
  return (
    <div
      className={`toast-compact ${getSeverityClasses()} ${isVisible ? 'show' : ''} ${
        actionable ? 'cursor-pointer hover:brightness-[0.98]' : ''
      }`}
      style={fallbackStyle}
      role={actionable ? 'button' : severity === 'error' ? 'alert' : 'status'}
      tabIndex={actionable ? 0 : -1}
      onClick={actionable ? handleActivate : undefined}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={handleBlur}
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
        {canCopy && (
          <IconButton
            onClick={handleCopy}
            icon={
              copied ? (
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
              ) : (
                <Copy className="w-3.5 h-3.5" aria-hidden="true" />
              )
            }
            size="sm"
            variant="ghost"
            className="ml-1 h-6 w-6 text-current/70 hover:text-current hover:bg-current/10"
            aria-label={copied ? 'Copied' : 'Copy message'}
            title={copied ? 'Copied' : 'Copy message'}
          />
        )}
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
  mergeCount: PropTypes.number,
  details: PropTypes.string
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
      role="region"
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
                details={toast.details ?? null}
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
          const mergedSeverity = getHighestSeverity(
            existing.severity || 'info',
            severity || 'info'
          );
          const updated = {
            ...existing,
            id: existing.id, // keep id stable for animation
            message: existing.originalMessage || existing.message,
            originalMessage: existing.originalMessage || existing.message,
            mergeCount,
            severity: mergedSeverity,
            duration: durationForSeverity(mergedSeverity, duration ?? existing.duration),
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
            duration: durationForSeverity(severity, duration),
            show: true,
            groupKey: groupKey || null,
            createdAt: now,
            actionable: Boolean(meta?.actionable),
            activationType: meta?.type || null,
            activationData: meta?.data ?? null,
            // Extra text the Copy button adds after the message (an error
            // code, the full path), for a bug report.
            details: typeof meta?.details === 'string' && meta.details ? meta.details : null
          }
        ];
      }
      // Cap the stack (see capToasts) and track evicted IDs for caller
      // cleanup. A burst of info toasts cannot push an unread error off, and
      // the toast just added or merged always stays.
      if (nextToasts !== previousToasts) {
        evictedIdsRef.current.push(...capToasts(nextToasts, toastId));
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
    (message, duration = 0, meta = null) => addToast(message, 'error', duration, null, meta),
    [addToast]
  ); // Errors stay until dismissed (durationForSeverity)
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
