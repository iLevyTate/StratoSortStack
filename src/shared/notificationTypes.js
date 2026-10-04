// @ts-check
/**
 * Unified Notification Types and Schema
 *
 * This module provides a single source of truth for notification structures
 * used across main process, renderer process, and IPC communication.
 *
 * @module shared/notificationTypes
 */

/**
 * Notification types for categorization
 */
const NotificationType = {
  FILE_ORGANIZED: 'file_organized',
  FILE_ANALYZED: 'file_analyzed',
  LOW_CONFIDENCE: 'low_confidence',
  WATCHER_ERROR: 'watcher_error',
  BATCH_COMPLETE: 'batch_complete',
  OPERATION_COMPLETE: 'operation_complete',
  OPERATION_ERROR: 'operation_error',
  SYSTEM: 'system'
};

/** Notification types that should focus the app and navigate when clicked. */
const ACTIVATABLE_NOTIFICATION_TYPES = new Set([
  NotificationType.FILE_ORGANIZED,
  NotificationType.FILE_ANALYZED,
  NotificationType.LOW_CONFIDENCE
]);

/**
 * Notification severity levels
 */
const NotificationSeverity = {
  INFO: 'info',
  SUCCESS: 'success',
  WARNING: 'warning',
  ERROR: 'error'
};

/**
 * Notification status for tracking lifecycle
 */
const NotificationStatus = {
  PENDING: 'pending',
  DISPLAYED: 'displayed',
  SEEN: 'seen',
  DISMISSED: 'dismissed'
};

/**
 * Standardized durations by severity (in milliseconds)
 */
const NOTIFICATION_DURATIONS = {
  [NotificationSeverity.INFO]: 2500,
  [NotificationSeverity.SUCCESS]: 3000,
  [NotificationSeverity.WARNING]: 4000,
  [NotificationSeverity.ERROR]: 5000,
  critical: 0 // Persist until dismissed
};

/**
 * Get standard duration for a severity level
 * @param {string} severity - Notification severity
 * @returns {number} Duration in milliseconds
 */
function getDefaultDuration(severity) {
  return NOTIFICATION_DURATIONS[severity] || NOTIFICATION_DURATIONS[NotificationSeverity.INFO];
}

/**
 * @typedef {{ id?: unknown, type?: string, title?: string, message?: string, severity?: string, variant?: string, duration?: number, timestamp?: string, data?: unknown, status?: string, seenAt?: string|null, dismissedAt?: string|null }} RawNotification
 */

/**
 * Normalize notification data to unified schema
 * Handles legacy format conversion (variant -> severity, title -> message)
 *
 * @param {RawNotification} notification - Raw notification data
 * @param {{source?: string}} [options] - Additional options
 * @returns {Object} Normalized notification object
 */
function normalizeNotification(notification, options = {}) {
  const { source = 'main' } = options;

  // Handle both legacy (variant) and new (severity) field names
  const severity = notification.severity || notification.variant || NotificationSeverity.INFO;

  // Handle both message and title fields
  const message = notification.message || notification.title || 'Notification';

  // Use provided duration or get default for severity
  const duration =
    typeof notification.duration === 'number'
      ? notification.duration
      : getDefaultDuration(severity);

  return {
    // Preserve ID if provided, otherwise will be set by recipient
    id: notification.id || null,
    type: notification.type || NotificationType.SYSTEM,
    title: notification.title || null,
    message,
    severity,
    duration,
    timestamp: notification.timestamp || new Date().toISOString(),
    source,
    data: notification.data || null,
    status: notification.status || NotificationStatus.PENDING,
    seenAt: notification.seenAt || null,
    dismissedAt: notification.dismissedAt || null
  };
}

/**
 * Create a notification object with required fields
 *
 * @param {{ type?: string, message: string, title?: string|null, severity?: string, duration?: number|null, data?: unknown, source?: string }} params - Notification parameters
 * @returns {Object} Notification object
 */
function createNotification({
  type = NotificationType.SYSTEM,
  message,
  title = null,
  severity = NotificationSeverity.INFO,
  duration = null,
  data = null,
  source = 'main'
}) {
  return {
    id: null, // Will be set by NotificationService
    type,
    title,
    message,
    severity,
    duration: duration !== null ? duration : getDefaultDuration(severity),
    timestamp: new Date().toISOString(),
    source,
    data,
    status: NotificationStatus.PENDING,
    seenAt: null,
    dismissedAt: null
  };
}

// Export both CommonJS and ES6 style
const exports_object = {
  NotificationType,
  NotificationSeverity,
  NotificationStatus,
  ACTIVATABLE_NOTIFICATION_TYPES,
  NOTIFICATION_DURATIONS,
  getDefaultDuration,
  normalizeNotification,
  createNotification
};

module.exports = exports_object;
