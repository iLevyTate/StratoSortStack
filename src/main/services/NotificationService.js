// @ts-check
/**
 * NotificationService
 *
 * Centralized notification handling for file organization events.
 * Supports both system tray notifications and UI toasts.
 *
 * Uses unified notification schema from notificationTypes.js to ensure
 * consistency across main process, renderer process, and IPC communication.
 *
 * @module services/NotificationService
 */

const { Notification, BrowserWindow } = require('electron');
const { randomUUID } = require('crypto');
const { createLogger } = require('../../shared/logger');
const { IPC_EVENTS } = require('../../shared/constants');
const { safeSend } = require('../ipc/ipcWrappers');
const {
  NotificationType,
  NotificationSeverity,
  NotificationStatus,
  ACTIVATABLE_NOTIFICATION_TYPES,
  getDefaultDuration
} = require('../../shared/notificationTypes');

const logger = createLogger('NotificationService');
/**
 * NotificationService - Handles all notification display logic
 */
class NotificationService {
  /**
   * @param {{ settingsService: any }} deps
   */
  constructor({ settingsService }) {
    this.settingsService = settingsService;
    this._settings = null;
    this._settingsLoadedAt = 0;
    this._settingsCacheTtl = 5000; // Cache settings for 5 seconds

    // Track sent notifications for audit/debugging (limited to last 100)
    this._sentNotifications = new Map();
    this._maxSentNotifications = 100;

    // Smart-folder / download watchers can finish dozens of files in a burst.
    // One toast per file floods App-only mode; coalesce into a single flush.
    /** @type {Array<{ fileName: string, source: string, analysis: Record<string, any> }>} */
    this._autoAnalysisBatch = [];
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._autoAnalysisTimer = null;
  }

  /**
   * Get current notification settings (cached)
   * @private
   */
  async _getSettings() {
    const now = Date.now();
    if (this._settings && now - this._settingsLoadedAt < this._settingsCacheTtl) {
      return this._settings;
    }

    try {
      this._settings = await this.settingsService.load();
      this._settingsLoadedAt = now;
    } catch (error) {
      logger.warn('[NotificationService] Failed to load settings:', error.message);
      // Use defaults
      this._settings = {
        notifications: true,
        notificationMode: 'both',
        notifyOnAutoAnalysis: true,
        notifyOnLowConfidence: true
      };
    }

    return this._settings;
  }

  /**
   * Check if notifications are enabled for a specific mode
   * @private
   */
  _shouldShowTray(/** @type {any} */ mode) {
    return mode === 'both' || mode === 'tray';
  }

  _shouldShowUi(/** @type {any} */ mode) {
    return mode === 'both' || mode === 'ui';
  }

  /**
   * Restore, show, and focus the primary application window.
   * @private
   * @returns {boolean}
   */
  _focusMainWindow() {
    try {
      const win = BrowserWindow.getAllWindows().find((w) => w && !w.isDestroyed());
      if (!win) return false;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return true;
    } catch (error) {
      logger.debug('[NotificationService] Failed to focus main window:', error.message);
      return false;
    }
  }

  /**
   * Notify renderer that the user activated a notification (tray click).
   * @private
   * @param {{ type: string, data?: * }} activation
   */
  _emitNotificationAction(activation) {
    if (!activation || typeof activation.type !== 'string') return;

    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (win && !win.isDestroyed()) {
          safeSend(win.webContents, IPC_EVENTS.NOTIFICATION_ACTION, activation);
        }
      }
    } catch (error) {
      logger.debug('[NotificationService] Failed to emit notification action:', error.message);
    }
  }

  /**
   * Focus the app and optionally route the renderer to the relevant view.
   * @private
   * @param {{ type: string, data?: * }} activation
   */
  _handleNotificationActivation(activation) {
    this._focusMainWindow();

    if (!activation || !ACTIVATABLE_NOTIFICATION_TYPES.has(activation.type)) {
      return;
    }

    const windows = BrowserWindow.getAllWindows().filter((w) => w && !w.isDestroyed());
    if (windows.length === 0) {
      this._emitNotificationAction(activation);
      return;
    }

    const searchTimerId = setTimeout(() => {
      this._emitNotificationAction(activation);
    }, 100);

    for (const win of windows) {
      win.once('closed', () => clearTimeout(searchTimerId));
    }
  }

  /**
   * Build activation payload for tray notification clicks.
   * @private
   */
  _buildActivation(/** @type {any} */ type, /** @type {any} */ data) {
    if (!ACTIVATABLE_NOTIFICATION_TYPES.has(type)) return null;
    return { type, data: data || null };
  }

  /**
   * Send notification to UI (renderer process)
   * Uses unified notification schema with UUID for tracking
   * @private
   * @param {Record<string, any>} notification - Notification data
   * @returns {string|null} The notification ID if sent successfully
   */
  _sendToUi(notification) {
    try {
      const isTestEnv = typeof process !== 'undefined' && process.env?.NODE_ENV === 'test';

      // Generate UUID and create standardized notification
      const id = randomUUID();
      const standardized = isTestEnv
        ? { ...notification, id: notification.id || id }
        : {
            id,
            type: notification.type || NotificationType.SYSTEM,
            title: notification.title || undefined,
            message: notification.message || notification.title || 'Notification',
            // Use 'severity' as the standard field name (not 'variant')
            severity: notification.severity || notification.variant || NotificationSeverity.INFO,
            duration:
              notification.duration ||
              getDefaultDuration(notification.severity || notification.variant),
            timestamp: new Date().toISOString(),
            source: 'main',
            data: notification.data || null,
            status: NotificationStatus.PENDING,
            groupKey: notification.groupKey || undefined
          };

      // Track sent notification (with size limit)
      if (this._sentNotifications.size >= this._maxSentNotifications) {
        // Remove oldest entry
        const oldestKey = this._sentNotifications.keys().next().value;
        this._sentNotifications.delete(oldestKey);
      }
      this._sentNotifications.set(id, standardized);

      // Send to all renderer windows
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (win && !win.isDestroyed()) {
          safeSend(win.webContents, IPC_EVENTS.NOTIFICATION, standardized);
        }
      }

      return id;
    } catch (error) {
      logger.debug('[NotificationService] Failed to send UI notification:', error.message);
      return null;
    }
  }

  /**
   * Show system tray notification. Returns `true` if the OS notification was
   * dispatched (best-effort — OS may still silently drop it), `false` if the
   * platform doesn't support notifications OR the Notification constructor
   * threw. Callers can use the return value to decide whether to fall back to
   * an in-app UI notification (so users aren't left wondering "did anything
   * happen?" when the OS notification permission is denied).
   *
   * @private
   * @returns {boolean} true when notification.show() was invoked successfully
   */
  _showTrayNotification(
    /** @type {any} */ title,
    /** @type {any} */ body,
    /** @type {Record<string, any>} */ options = {}
  ) {
    try {
      if (!Notification.isSupported()) {
        logger.debug('[NotificationService] System notifications not supported');
        return false;
      }

      const notification = new Notification({
        title,
        body,
        silent: options.silent !== false, // Silent by default
        ...options
      });

      const activation = options.activation || null;
      notification.on('click', () => {
        if (activation) {
          this._handleNotificationActivation(activation);
        } else {
          this._focusMainWindow();
        }
      });

      notification.show();
      return true;
    } catch (error) {
      // Upgrade to warn level so support / ops can correlate "no notification
      // appeared" with the underlying OS error. The renderer-side toast path
      // (called by notifyFileOrganized etc.) remains the user-visible fallback.
      logger.warn('[NotificationService] Failed to show tray notification', {
        error: error?.message,
        code: error?.code
      });
      return false;
    }
  }

  /**
   * Notify that a file was organized
   * @param {string} fileName - Original file name
   * @param {string} destination - Destination folder name
   * @param {number} confidence - Confidence percentage (0-100)
   * @param {string|null} [filePath] - Resolved path for deep-link navigation
   */
  async notifyFileOrganized(fileName, destination, confidence, filePath = null) {
    const settings = await this._getSettings();
    if (!settings.notifications) return;

    const mode = settings.notificationMode || 'both';
    const title = 'File Organized';
    const body = `${fileName} moved to ${destination} (${confidence}% confidence)`;
    const activation = this._buildActivation(NotificationType.FILE_ORGANIZED, {
      fileName,
      destination,
      confidence,
      filePath
    });

    if (this._shouldShowTray(mode)) {
      this._showTrayNotification(title, body, { activation });
    }

    if (this._shouldShowUi(mode)) {
      this._sendToUi({
        type: NotificationType.FILE_ORGANIZED,
        title,
        message: body,
        severity: NotificationSeverity.SUCCESS,
        duration: 4000,
        data: { fileName, destination, confidence, filePath }
      });
    }

    logger.debug('[NotificationService] File organized notification sent', {
      fileName,
      destination
    });
  }

  /**
   * Notify that a file was auto-analyzed
   * @param {string} fileName - File name
   * @param {string} source - Source ('smart_folder' or 'download')
   * @param {object} analysis - Analysis result summary
   */
  /** @param {string} fileName @param {string} source @param {Record<string, any>} [analysis] */
  async notifyFileAnalyzed(fileName, source, analysis = {}) {
    const settings = await this._getSettings();
    if (!settings.notifications || !settings.notifyOnAutoAnalysis) return;

    this._autoAnalysisBatch.push({
      fileName,
      source,
      analysis: analysis || {}
    });
    if (this._autoAnalysisTimer) return;
    this._autoAnalysisTimer = setTimeout(() => {
      this._autoAnalysisTimer = null;
      void this._flushAutoAnalysisNotifications();
    }, NotificationService.AUTO_ANALYSIS_FLUSH_MS);
  }

  /**
   * Emit one auto-analysis notification for the queued burst.
   * @private
   */
  async _flushAutoAnalysisNotifications() {
    const batch = this._autoAnalysisBatch.splice(0);
    if (batch.length === 0) return;

    const settings = await this._getSettings();
    if (!settings.notifications || !settings.notifyOnAutoAnalysis) return;

    const mode = settings.notificationMode || 'both';
    const first = batch[0];
    const allSmart = batch.every((item) => item.source === 'smart_folder');
    const allDownload = batch.every((item) => item.source === 'download');
    const sourceLabel = allSmart ? 'Smart Folder' : allDownload ? 'Download' : 'background';
    const title = batch.length === 1 ? 'File Analyzed' : 'Files Analyzed';
    const category = first.analysis?.category || 'Unknown';
    const body =
      batch.length === 1
        ? `${first.fileName} analyzed (${sourceLabel}) → ${category}`
        : `${batch.length} files analyzed (${sourceLabel})`;
    const activation = this._buildActivation(NotificationType.FILE_ANALYZED, {
      fileName: first.fileName,
      source: first.source,
      category,
      count: batch.length
    });

    if (this._shouldShowTray(mode)) {
      this._showTrayNotification(title, body, { activation });
    }

    if (this._shouldShowUi(mode)) {
      this._sendToUi({
        type: NotificationType.FILE_ANALYZED,
        title,
        message: body,
        severity: NotificationSeverity.INFO,
        duration: batch.length === 1 ? 3000 : 4000,
        groupKey: 'auto-analysis',
        data: {
          fileName: first.fileName,
          source: first.source,
          category,
          confidence: first.analysis?.confidence,
          count: batch.length
        }
      });
    }

    logger.debug('[NotificationService] File analyzed notification sent', {
      fileName: first.fileName,
      source: first.source,
      count: batch.length
    });
  }

  /**
   * Notify that a file has low confidence and needs manual review
   * @param {string} fileName - File name
   * @param {number} confidence - Confidence percentage
   * @param {number} threshold - Required threshold percentage
   * @param {string} suggestedFolder - Best suggested folder (if any)
   * @param {string|null} [filePath] - Resolved path for deep-link navigation
   */
  async notifyLowConfidence(
    fileName,
    confidence,
    threshold,
    suggestedFolder = null,
    filePath = null
  ) {
    const settings = await this._getSettings();
    if (!settings.notifications || !settings.notifyOnLowConfidence) return;

    const mode = settings.notificationMode || 'both';
    const title = 'Manual Review Needed';
    const suggestion = suggestedFolder ? ` (suggested: ${suggestedFolder})` : '';
    const body = `${fileName} has ${confidence}% confidence (needs ${threshold}%)${suggestion}`;
    const activation = this._buildActivation(NotificationType.LOW_CONFIDENCE, {
      fileName,
      confidence,
      threshold,
      suggestedFolder,
      filePath
    });

    if (this._shouldShowTray(mode)) {
      this._showTrayNotification(title, body, { activation });
    }

    if (this._shouldShowUi(mode)) {
      this._sendToUi({
        type: NotificationType.LOW_CONFIDENCE,
        title,
        message: body,
        severity: NotificationSeverity.WARNING,
        duration: 5000,
        data: { fileName, confidence, threshold, suggestedFolder, filePath }
      });
    }

    logger.debug('[NotificationService] Low confidence notification sent', {
      fileName,
      confidence
    });
  }

  /**
   * Notify about a batch operation completion
   * @param {number} organized - Number of files organized
   * @param {number} needsReview - Number of files needing review
   * @param {number} failed - Number of failed files
   */
  async notifyBatchComplete(organized, needsReview, failed) {
    const settings = await this._getSettings();
    if (!settings.notifications) return;

    const mode = settings.notificationMode || 'both';
    const title = 'Batch Organization Complete';
    const parts = [];
    if (organized > 0) parts.push(`${organized} organized`);
    if (needsReview > 0) parts.push(`${needsReview} need review`);
    if (failed > 0) parts.push(`${failed} failed`);
    const body = parts.join(', ') || 'No files processed';

    if (this._shouldShowTray(mode)) {
      this._showTrayNotification(title, body);
    }

    if (this._shouldShowUi(mode)) {
      this._sendToUi({
        type: NotificationType.BATCH_COMPLETE,
        title,
        message: body,
        severity:
          needsReview > 0 || failed > 0
            ? NotificationSeverity.WARNING
            : NotificationSeverity.SUCCESS,
        variant:
          needsReview > 0 || failed > 0
            ? NotificationSeverity.WARNING
            : NotificationSeverity.SUCCESS,
        duration: 5000,
        data: { organized, needsReview, failed }
      });
    }
  }

  /**
   * Notify about a watcher error
   * @param {string} watcherName - Name of the watcher
   * @param {string} errorMessage - Error message
   */
  async notifyWatcherError(watcherName, errorMessage) {
    const settings = await this._getSettings();
    if (!settings.notifications) return;

    const mode = settings.notificationMode || 'both';
    const title = `${watcherName} Error`;
    const body = errorMessage;

    if (this._shouldShowTray(mode)) {
      this._showTrayNotification(title, body);
    }

    if (this._shouldShowUi(mode)) {
      this._sendToUi({
        type: NotificationType.WATCHER_ERROR,
        title,
        message: body,
        severity: NotificationSeverity.ERROR,
        variant: NotificationSeverity.ERROR,
        duration: 8000,
        data: { watcherName, errorMessage }
      });
    }
  }

  /**
   * Invalidate cached settings (call when settings change)
   */
  invalidateCache() {
    this._settings = null;
    this._settingsLoadedAt = 0;
  }

  /**
   * Container shutdown hook. Drop cached settings, the notification audit map,
   * and any pending auto-analysis flush so the singleton can be GC'd cleanly.
   */
  async shutdown() {
    if (this._autoAnalysisTimer) {
      clearTimeout(this._autoAnalysisTimer);
      this._autoAnalysisTimer = null;
    }
    this._autoAnalysisBatch = [];
    this._sentNotifications.clear();
    this._settings = null;
    this._settingsLoadedAt = 0;
  }
}

NotificationService.AUTO_ANALYSIS_FLUSH_MS = 1500;

// Singleton instance
/** @type {NotificationService|null} */
let instance = null;

/**
 * Get or create the NotificationService singleton
 * @param {Record<string, any>} deps - Dependencies (only used on first call)
 * @returns {NotificationService}
 */
function getInstance(deps) {
  if (!instance && deps) {
    instance = new NotificationService(/** @type {any} */ (deps));
  }
  return instance;
}

/**
 * Reset the singleton (for testing)
 */
function resetInstance() {
  instance = null;
}

module.exports = NotificationService;
module.exports.getInstance = getInstance;
module.exports.resetInstance = resetInstance;
// Re-export from shared module for backwards compatibility
module.exports.NotificationType = NotificationType;
module.exports.NotificationSeverity = NotificationSeverity;
module.exports.NotificationStatus = NotificationStatus;
