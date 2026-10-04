// @ts-check
/**
 * Auto-Updater Module
 *
 * Handles automatic application updates in production.
 * Extracted from simple-main.js for better maintainability.
 *
 * @module core/autoUpdater
 */

const { BrowserWindow, app } = require('electron');
const { IPC_EVENTS } = require('../../shared/constants');
const { createLogger } = require('../../shared/logger');
const { safeSend } = require('../ipc/ipcWrappers');
const { getEnvBool } = require('../../shared/configDefaults');

const logger = createLogger('AutoUpdater');

// electron-updater exposes `autoUpdater` as a lazy getter whose first read
// CONSTRUCTS the platform updater. AppUpdater's constructor rejects
// app.getVersion() values that are not valid semver — and unpackaged Linux
// runs (e2e, `npm run dev`) report "0.0" — so destructuring it at module
// load crashes the main process before any isDev/isPackaged gate can run.
// Resolve it lazily, only after those gates have passed.
/** @type {any} */
let _autoUpdater = null;
function getAutoUpdater() {
  if (!_autoUpdater) {
    _autoUpdater = require('electron-updater').autoUpdater;
  }
  return _autoUpdater;
}

// Track active cleanup function and init guard
/** @type {any} */
let activeCleanup = null;
/** @type {any} */
let initPromise = null;
let initialized = false;
let hasDownloadedUpdate = false;

const UPDATER_DEGRADED_CODE = 'auto-updater.unavailable';

function _maybeRaiseUpdaterUnavailable(/** @type {any} */ err) {
  try {
    const tracker = require('../services/DegradedStateTracker').getInstance();
    tracker.raise({
      code: UPDATER_DEGRADED_CODE,
      subsystem: 'auto-updater',
      severity: 'warning',
      message:
        'Automatic updates are temporarily unavailable. The app will retry on the next ' +
        'periodic check; if this persists you may need to download the next release manually ' +
        'from the GitHub releases page.',
      detail: { errorMessage: String(err?.message || err || '').slice(0, 200) }
    });
  } catch {
    /* tracker is best-effort; never throw from an updater error path */
  }
}

function _clearUpdaterUnavailable() {
  try {
    require('../services/DegradedStateTracker').getInstance().clear(UPDATER_DEGRADED_CODE);
  } catch {
    /* never throw from a successful response path */
  }
}

// Periodic re-check interval. Without this, a long-running session
// (days/weeks) would never discover new releases — the user would have to
// quit and relaunch to see anything. 4 hours is conservative: long enough
// to be invisible to short sessions, short enough that a typical
// daily-driver session catches releases the same day they ship.
const PERIODIC_UPDATE_CHECK_MS = 4 * 60 * 60 * 1000;
/** @type {any} */
let periodicCheckTimer = null;

function areAutoUpdatesEnabled() {
  const raw = process.env.STRATOSORT_ENABLE_AUTO_UPDATES;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    return getEnvBool('STRATOSORT_ENABLE_AUTO_UPDATES', false);
  }
  // Packaged installs: off by default until an operator opts in with
  // STRATOSORT_ENABLE_AUTO_UPDATES=true and provides a working feed/channel.
  // This avoids noisy 404s for local/ad-hoc builds that are not published.
  return false;
}

// User preference mirrored from settings.autoUpdateCheck, layered on top of the
// env/build gate above. Automatic (startup + periodic) checks run only when the
// operator enabled updates AND the user has not opted out of background checks.
// Manual checkForUpdates() deliberately ignores this preference so a user who
// disabled background checks can still check on demand from Settings.
let autoUpdateCheckPreference = true;

/**
 * Mirror the persisted `autoUpdateCheck` setting. Called at startup and on every
 * settings change so toggling the preference takes effect without a restart.
 * @param {boolean} enabled
 */
function setAutoUpdateCheckEnabled(enabled) {
  autoUpdateCheckPreference = enabled !== false;
}

function areAutomaticUpdatesEnabled() {
  return areAutoUpdatesEnabled() && autoUpdateCheckPreference;
}

/**
 * Identify whether the current packaged build is a target electron-updater
 * can actually replace in place.
 *
 * - Windows PORTABLE (`.exe` launched from any directory, sets
 *   `PORTABLE_EXECUTABLE_DIR`): electron-updater throws
 *   "Portable App Installer Not Supported" when it tries to run the NSIS
 *   updater. We cannot install an update, so we return a reason instead
 *   of uselessly spinning the UpdateIndicator.
 * - Linux non-AppImage packaged builds (deb/rpm/tar.gz/snap): the
 *   electron-builder linux updater only supports AppImage. Native
 *   package managers own the binary.
 * - macOS unsigned / unnotarized builds: `autoUpdater` requires a
 *   signed and notarized app to install — we can still check and
 *   download, but quitAndInstall will fail. Leave detection to the
 *   existing error path there.
 *
 * Returns `{ supported: boolean, reason?: string }`.
 */
function getUpdateTargetCapability() {
  // Windows portable builds set PORTABLE_EXECUTABLE_DIR when run.
  if (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_DIR) {
    return {
      supported: false,
      reason:
        'Windows portable builds cannot auto-update in place. Download the NSIS installer instead.'
    };
  }

  // Microsoft Store (appx/MSIX) installs: the Store owns the update
  // lifecycle; self-updating would fight it (and the WindowsApps install
  // dir is not writable by the app anyway).
  if (process.platform === 'win32' && process.windowsStore === true) {
    return {
      supported: false,
      reason: 'Microsoft Store installs are updated by the Store, not in-app.'
    };
  }

  if (process.platform === 'linux') {
    // electron-builder exposes APPIMAGE only inside an AppImage runtime.
    // If we're packaged as linux but not AppImage, we can't self-update.
    if (!process.env.APPIMAGE) {
      return {
        supported: false,
        reason:
          'Linux auto-updates only work for AppImage distributions. Use your package manager to update.'
      };
    }
  }

  return { supported: true };
}

/**
 * Validate a custom update feed URL.
 *
 * SECURITY: the update feed drives which binaries autoUpdater downloads and
 * installs. Even with code signing the feed controls WHICH signed artifact
 * runs, and unsigned dev builds trust it outright. We therefore require:
 *   - https:// (no http://, no file://, no custom schemes)
 *   - no embedded credentials (user:pass@host)
 *   - hostname in the STRATOSORT_UPDATE_FEED_ALLOWED_HOSTS allowlist
 *     (comma-separated, subdomain match).
 *
 * Posture by environment:
 *   - Packaged / production builds (`app.isPackaged === true`): allowlist is
 *     REQUIRED. A missing or empty allowlist fails closed so an attacker who
 *     can seed only the feed URL env var cannot point a shipped installer at
 *     an arbitrary host.
 *   - Non-packaged (dev/test): allowlist is optional — when unset any HTTPS
 *     host is accepted so developers can iterate against localhost / staging
 *     CDNs without extra env wiring.
 *
 * @param {string} rawUrl - The raw STRATOSORT_UPDATE_FEED_URL value.
 * @returns {URL} Parsed, validated URL.
 * @throws {Error} On any validation failure; caller should fall back to
 *   the packaged provider rather than installing from an unsafe feed.
 */
function _validateUpdateFeedUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`STRATOSORT_UPDATE_FEED_URL is not a valid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `STRATOSORT_UPDATE_FEED_URL must use https:// (got ${parsed.protocol}//${parsed.host})`
    );
  }
  if (parsed.username || parsed.password) {
    throw new Error('STRATOSORT_UPDATE_FEED_URL must not contain credentials');
  }

  const rawAllowlist = process.env.STRATOSORT_UPDATE_FEED_ALLOWED_HOSTS;
  const allowlist =
    rawAllowlist && String(rawAllowlist).trim() !== ''
      ? String(rawAllowlist)
          .split(',')
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean)
      : [];

  // Packaged builds MUST provide an allowlist. Otherwise a compromised env
  // variable alone would be enough to redirect updates to an attacker host.
  // In dev we keep the old opt-in posture so local iteration does not require
  // setting two env vars just to point at a staging CDN.
  const isPackaged = (() => {
    try {
      return Boolean(app?.isPackaged);
    } catch {
      return false;
    }
  })();
  if (isPackaged && allowlist.length === 0) {
    throw new Error(
      'STRATOSORT_UPDATE_FEED_URL requires STRATOSORT_UPDATE_FEED_ALLOWED_HOSTS in packaged builds'
    );
  }

  if (allowlist.length > 0) {
    const host = parsed.hostname.toLowerCase();
    const allowed = allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`));
    if (!allowed) {
      throw new Error(
        `STRATOSORT_UPDATE_FEED_URL host '${host}' is not in STRATOSORT_UPDATE_FEED_ALLOWED_HOSTS`
      );
    }
  }
  return parsed;
}

/**
 * When STRATOSORT_UPDATE_FEED_URL is set, use a generic HTTPS feed (latest.yml + artifacts)
 * instead of the packaged app-update.yml GitHub provider. Use when hosting updates on your own CDN.
 *
 * On validation failure, logs and returns without calling setFeedURL so that
 * the updater falls back to the packaged provider rather than pointing at an
 * unsafe URL.
 */
function applyCustomUpdateFeedIfConfigured() {
  const raw = process.env.STRATOSORT_UPDATE_FEED_URL;
  if (raw == null || String(raw).trim() === '') {
    return;
  }
  const trimmed = String(raw).trim();
  let validated;
  try {
    validated = _validateUpdateFeedUrl(trimmed);
  } catch (error) {
    logger.error('[UPDATER] Rejected STRATOSORT_UPDATE_FEED_URL (falling back to packaged feed)', {
      error: error?.message || String(error)
    });
    return;
  }
  // electron-updater expects a trailing slash on generic feed URLs so that
  // `latest.yml` / artifact paths resolve against the directory.
  const base = validated.toString().replace(/\/+$/, '');
  const url = `${base}/`;
  try {
    getAutoUpdater().setFeedURL({ provider: 'generic', url });
    logger.info('[UPDATER] Using generic feed from STRATOSORT_UPDATE_FEED_URL', { url });
  } catch (error) {
    logger.error('[UPDATER] Failed to apply STRATOSORT_UPDATE_FEED_URL', {
      error: error?.message || String(error)
    });
  }
}

/**
 * Send update status to renderer
 * @param {Object|string} payload - Update payload or status string
 * @param {Function | undefined} getMainWindow - Accessor for the main window
 */
function notifyRenderer(payload, getMainWindow) {
  try {
    const win = (getMainWindow ? getMainWindow() : null) || BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      const updatePayload =
        typeof payload === 'string'
          ? { status: payload }
          : payload && typeof payload === 'object'
            ? payload
            : null;

      if (!updatePayload) {
        logger.warn('[UPDATER] Invalid update payload', { payload });
        return;
      }

      safeSend(win.webContents, IPC_EVENTS.APP_UPDATE, updatePayload);
    }
  } catch (error) {
    logger.error('[UPDATER] Failed to send update message:', error);
  }
}

/**
 * Handle updater errors
 * @param {Error} err - The error that occurred
 * @param {Function | undefined} getMainWindow - Accessor for the main window
 */
function handleError(err, getMainWindow) {
  logger.error('[UPDATER] Error:', err);
  hasDownloadedUpdate = false;
  notifyRenderer(
    {
      status: 'error',
      error: err?.message || 'Update error'
    },
    getMainWindow
  );
  // Surface auto-update failures (network, signature mismatch, manifest
  // fetch failure, missing latest*.yml) on the DegradedStateBanner so a
  // user who is not actively looking at the update UI can still tell that
  // future updates won't arrive. The success-path handlers below clear
  // the banner so a transient feed 503 doesn't leave the banner stuck.
  _maybeRaiseUpdaterUnavailable(err);
}

/**
 * Handle update available event
 * @param {Function | undefined} getMainWindow - Accessor for the main window
 */
function handleUpdateAvailable(getMainWindow) {
  logger.info('[UPDATER] Update available');
  hasDownloadedUpdate = false;
  // Manifest fetched successfully → updater is healthy; clear any prior
  // error banner so a transient outage no longer signals "broken".
  _clearUpdaterUnavailable();
  notifyRenderer('available', getMainWindow);
}

/**
 * Handle update not available event
 * @param {Function | undefined} getMainWindow - Accessor for the main window
 */
function handleUpdateNotAvailable(getMainWindow) {
  logger.info('[UPDATER] No updates available');
  hasDownloadedUpdate = false;
  // Successful "we checked, nothing new" round-trip — feed is reachable
  // and parseable. Clear any stale error banner.
  _clearUpdaterUnavailable();
  notifyRenderer('not-available', getMainWindow);
}

/**
 * Handle update downloaded event
 * @param {Function | undefined} getMainWindow - Accessor for the main window
 */
function handleUpdateDownloaded(getMainWindow) {
  logger.info('[UPDATER] Update downloaded');
  hasDownloadedUpdate = true;
  notifyRenderer('downloaded', getMainWindow);
}

/**
 * Handle update progress event
 * @param {any} progressObj - download progress
 * @param {Function | undefined} getMainWindow - Accessor for the main window
 */
function handleUpdateProgress(progressObj, getMainWindow) {
  try {
    const win = (getMainWindow ? getMainWindow() : null) || BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      safeSend(win.webContents, IPC_EVENTS.APP_UPDATE, {
        status: 'downloading',
        progress: progressObj.percent
      });
    }
  } catch (err) {
    logger.debug('[UPDATER] Progress notify failed', { error: err?.message || String(err) });
  }
}

/**
 * Initialize auto-updater (production only)
 * @param {boolean} isDev - Whether running in development mode
 * @param {Function | undefined} getMainWindow - Accessor for the main window
 * @returns {Promise<Object>} Result object with cleanup function
 */
async function initializeAutoUpdater(isDev, getMainWindow) {
  if (isDev) {
    logger.debug('[UPDATER] Skipping auto-updater setup in development mode');
    return { cleanup: () => {} };
  }

  if (!areAutoUpdatesEnabled()) {
    // Disambiguate the two distinct reasons so support logs tell us which
    // gate fired. The previous message made dev vs. env-flag triage a
    // guessing game when a packaged build shipped with the flag unset.
    const reason = !app.isPackaged
      ? 'non-packaged build'
      : 'STRATOSORT_ENABLE_AUTO_UPDATES is not enabled';
    logger.info(`[UPDATER] Auto-updates skipped (${reason})`);
    return { cleanup: () => {} };
  }

  const capability = getUpdateTargetCapability();
  if (!capability.supported) {
    logger.info('[UPDATER] Auto-updates skipped for this build target', {
      reason: capability.reason
    });
    // Tell the renderer once so the UpdateIndicator can surface a
    // meaningful status instead of sitting on "checking" forever.
    notifyRenderer({ status: 'unsupported', reason: capability.reason }, getMainWindow);
    return { cleanup: () => {} };
  }

  // Prevent duplicate initialization: return existing promise if in-progress,
  // or return cached cleanup if already completed
  if (initPromise) {
    logger.debug('[UPDATER] Initialization already in progress');
    return initPromise;
  }
  if (initialized && activeCleanup) {
    logger.debug('[UPDATER] Already initialized');
    return { cleanup: activeCleanup };
  }

  initPromise = (async () => {
    if (activeCleanup) {
      cleanupAutoUpdater();
    }

    try {
      const autoUpdater = getAutoUpdater();
      autoUpdater.autoDownload = false;
      applyCustomUpdateFeedIfConfigured();

      // Register event handlers
      const updateAvailableHandler = () => handleUpdateAvailable(getMainWindow);
      const updateNotAvailableHandler = () => handleUpdateNotAvailable(getMainWindow);
      const updateDownloadedHandler = () => handleUpdateDownloaded(getMainWindow);
      const downloadProgressHandler = (/** @type {any} */ progressObj) =>
        handleUpdateProgress(progressObj, getMainWindow);
      const updateErrorHandler = (/** @type {any} */ err) => handleError(err, getMainWindow);

      autoUpdater.on('error', updateErrorHandler);
      autoUpdater.on('update-available', updateAvailableHandler);
      autoUpdater.on('update-not-available', updateNotAvailableHandler);
      autoUpdater.on('update-downloaded', updateDownloadedHandler);
      autoUpdater.on('download-progress', downloadProgressHandler);

      // Store cleanup function
      const cleanup = () => {
        autoUpdater.removeListener('error', updateErrorHandler);
        autoUpdater.removeListener('update-available', updateAvailableHandler);
        autoUpdater.removeListener('update-not-available', updateNotAvailableHandler);
        autoUpdater.removeListener('update-downloaded', updateDownloadedHandler);
        autoUpdater.removeListener('download-progress', downloadProgressHandler);
        if (periodicCheckTimer) {
          clearInterval(periodicCheckTimer);
          periodicCheckTimer = null;
        }
        logger.debug('[UPDATER] Listeners cleaned up');
      };

      activeCleanup = cleanup;

      // Check for updates (with timeout to prevent hanging on network blackholes).
      // Use checkForUpdates(), not checkForUpdatesAndNotify(): the latter posts native
      // OS notifications and ignores Settings "notificationMode" (e.g. app-only toasts).
      // We already surface update status to the renderer via notifyRenderer + IPC_EVENTS.APP_UPDATE.
      // Startup check only runs when automatic checks are enabled. When the
      // user disabled autoUpdateCheck we still register handlers + feed above
      // so a manual checkForUpdates() works, but we skip the background check.
      if (!areAutomaticUpdatesEnabled()) {
        logger.info(
          '[UPDATER] Automatic startup update check skipped (autoUpdateCheck disabled by user)'
        );
      } else {
        let timeoutHandle;
        try {
          const UPDATE_CHECK_TIMEOUT_MS = 30000;
          await Promise.race([
            autoUpdater.checkForUpdates(),
            new Promise((_, reject) => {
              timeoutHandle = setTimeout(
                () => reject(new Error('Update check timed out')),
                UPDATE_CHECK_TIMEOUT_MS
              );
              if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();
            })
          ]);
          logger.info('[UPDATER] Update check completed');
        } catch (e) {
          // Route through the shared error handler so the renderer learns
          // the check failed. Previously we just logged, which meant the
          // UpdateIndicator UI sat in "checking" forever on network
          // outages / 404s / feed timeouts and the user had no signal the
          // check had given up. handleError also resets
          // `hasDownloadedUpdate` and emits a structured payload via
          // IPC_EVENTS.APP_UPDATE that the renderer already understands.
          handleError(e, getMainWindow);
        } finally {
          clearTimeout(timeoutHandle);
        }
      }

      // Schedule recurring re-check. Long-running sessions previously had no
      // way to learn about new releases without a manual quit/relaunch. The
      // timer is .unref()'d so it never blocks process exit, and any error
      // thrown by the recurring check is routed through the same handler as
      // the startup check so the renderer's UpdateIndicator stays accurate.
      if (!periodicCheckTimer) {
        periodicCheckTimer = setInterval(() => {
          if (!areAutomaticUpdatesEnabled()) return;
          const capability = getUpdateTargetCapability();
          if (!capability.supported) return;
          autoUpdater.checkForUpdates().catch((/** @type {any} */ err) => {
            logger.warn('[UPDATER] Periodic check failed', { error: err?.message });
            handleError(err, getMainWindow);
          });
        }, PERIODIC_UPDATE_CHECK_MS);
        if (typeof periodicCheckTimer.unref === 'function') {
          periodicCheckTimer.unref();
        }
      }

      return { cleanup };
    } catch (error) {
      logger.error('[UPDATER] Failed to setup auto-updater:', error);
      return { cleanup: () => {} };
    } finally {
      initPromise = null;
      initialized = true;
    }
  })();

  return initPromise;
}

/**
 * Clean up all auto-updater listeners
 */
function cleanupAutoUpdater() {
  if (!activeCleanup) return;

  try {
    activeCleanup();
  } catch (error) {
    logger.error('[UPDATER] Cleanup error:', error);
  } finally {
    activeCleanup = null;
    initialized = false;
  }
}

/**
 * Manually trigger an update check
 * @returns {Promise<{success: boolean, disabled?: boolean, unsupported?: boolean, error?: string}>}
 */
async function checkForUpdates() {
  if (!areAutoUpdatesEnabled()) {
    logger.info('[UPDATER] Manual update check skipped because auto-updates are disabled');
    return { success: true, disabled: true };
  }

  const capability = getUpdateTargetCapability();
  if (!capability.supported) {
    return { success: false, unsupported: true, error: capability.reason };
  }

  // Without successful initialization no event listeners are registered —
  // update-available/update-downloaded would fire unheard, the renderer
  // would never be notified, and hasDownloadedUpdate would never be set.
  // (Reachable: dev build with STRATOSORT_ENABLE_AUTO_UPDATES=true, where
  // initializeAutoUpdater early-returns on the non-packaged gate.)
  if (!activeCleanup) {
    logger.info('[UPDATER] Manual update check skipped: updater not initialized');
    return { success: false, error: 'Auto-updater is not initialized for this build' };
  }

  try {
    hasDownloadedUpdate = false;
    applyCustomUpdateFeedIfConfigured();
    await getAutoUpdater().checkForUpdates();
    return { success: true };
  } catch (error) {
    logger.error('[UPDATER] Manual update check failed:', error);
    return { success: false, error: error?.message || 'Failed to check for updates' };
  }
}

/**
 * Download an update after `update-available` (requires `autoDownload: false`).
 * @returns {Promise<{success: boolean, disabled?: boolean, unsupported?: boolean, error?: string}>}
 */
async function downloadUpdate() {
  if (!areAutoUpdatesEnabled()) {
    logger.info('[UPDATER] Download skipped because auto-updates are disabled');
    return { success: true, disabled: true };
  }

  const capability = getUpdateTargetCapability();
  if (!capability.supported) {
    return { success: false, unsupported: true, error: capability.reason };
  }

  // Same initialization gate as checkForUpdates(): downloading without
  // listeners means progress/downloaded events fire unheard.
  if (!activeCleanup) {
    logger.info('[UPDATER] Download skipped: updater not initialized');
    return { success: false, error: 'Auto-updater is not initialized for this build' };
  }

  try {
    applyCustomUpdateFeedIfConfigured();
    await getAutoUpdater().downloadUpdate();
    return { success: true };
  } catch (error) {
    logger.error('[UPDATER] downloadUpdate failed:', error);
    return { success: false, error: error?.message || 'Failed to download update' };
  }
}

/**
 * Quit and install the downloaded update
 */
function quitAndInstall() {
  if (!areAutoUpdatesEnabled()) {
    return {
      success: false,
      error: 'Automatic updates are disabled in this build.'
    };
  }

  const capability = getUpdateTargetCapability();
  if (!capability.supported) {
    return { success: false, unsupported: true, error: capability.reason };
  }

  if (!hasDownloadedUpdate) {
    logger.warn('[UPDATER] No downloaded update flag set; attempting best-effort install');
  }

  try {
    getAutoUpdater().quitAndInstall();
    return { success: true };
  } catch (error) {
    const message = error?.message || 'Failed to apply update';
    if (message.includes('No update filepath provided')) {
      return {
        success: false,
        error: 'No downloaded update available yet. Check for updates and finish download first.'
      };
    }
    logger.error('[UPDATER] quitAndInstall failed:', error);
    return { success: false, error: message };
  }
}

module.exports = {
  initializeAutoUpdater,
  cleanupAutoUpdater,
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
  hasPendingDownloadedUpdate: () => hasDownloadedUpdate,
  getUpdateTargetCapability,
  setAutoUpdateCheckEnabled,
  // Exported for tests only; not part of the public API surface.
  __test: {
    _validateUpdateFeedUrl,
    applyCustomUpdateFeedIfConfigured,
    areAutomaticUpdatesEnabled
  }
};
