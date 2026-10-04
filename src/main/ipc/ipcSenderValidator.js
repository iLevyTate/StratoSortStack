// @ts-check
/**
 * Reject ipcMain.handle invocations from unexpected sender origins (defense in depth).
 * Production renderers load from the custom app:// scheme; dev loads from
 * http://localhost / http://127.0.0.1 (and file:// for the offline fallback).
 *
 * Test and dev bypasses are gated by explicit setters (setTestBypass,
 * setDevPermissive) rather than `process.env.NODE_ENV` checks, so an
 * environment-variable leak into a packaged build can never disable origin
 * validation. Production code never calls the setters; flags default to off.
 *
 * Flags live on `globalThis` (not module scope) because some test suites call
 * `jest.resetModules()` and re-require this module, which would lose any
 * module-local state. Production code never touches the global keys.
 */

const { createLogger } = require('../../shared/logger');

const logger = createLogger('IpcSender');

const TEST_BYPASS_KEY = '__stratosort_ipc_test_bypass__';
const DEV_PERMISSIVE_KEY = '__stratosort_ipc_dev_permissive__';

/**
 * Bypass flags stored on globalThis (survives jest.resetModules(); see module
 * header). Typed here so the element accesses below are checked.
 * @typedef {{ __stratosort_ipc_test_bypass__?: boolean, __stratosort_ipc_dev_permissive__?: boolean }} IpcSenderGlobalFlags
 */

/**
 * @param {import('electron').IpcMainInvokeEvent} event
 * @returns {string} Sender URL, or '' when unavailable
 */
function resolveInvocationUrl(event) {
  try {
    const frameUrl = event?.senderFrame?.url;
    if (typeof frameUrl === 'string' && frameUrl.length > 0) return frameUrl;
  } catch {
    // senderFrame may be unavailable in some Electron versions
  }
  try {
    const u = event?.sender?.getURL?.();
    if (typeof u === 'string') return u;
  } catch {
    // destroyed webContents
  }
  return '';
}

/**
 * @param {string} url
 * @returns {boolean}
 */
function isAllowedRendererUrl(url) {
  if (!url) return false;
  // Production renderer origin. The app:// scheme is registered and served
  // exclusively by this app (see core/appProtocol.js), so any app:// sender is
  // our own bundle.
  if (url.startsWith('app://')) return true;
  if (url.startsWith('file://')) return true;
  if (url.startsWith('http://127.0.0.1:')) return true;
  if (url.startsWith('http://localhost:')) return true;
  // NOTE: data: URLs are NOT allowed. The renderer-bundle-missing error page
  // (createWindow.js renderMissingBundle) is loaded from a data: URL but
  // contains only static HTML with no script — it never invokes IPC. Any
  // future code path that tries to invoke from a data: URL is rejected here
  // so an XSS-via-data-URL escalation can't reach the IPC surface.
  return false;
}

/**
 * Test-only: enable/disable full sender-validation bypass for unit tests that
 * construct synthetic ipcMain events without real sender frames. Call once in
 * test setup with `true`. NEVER call from production code.
 * @param {boolean} enabled
 */
function setTestBypass(enabled) {
  /** @type {IpcSenderGlobalFlags} */ (globalThis)[TEST_BYPASS_KEY] = Boolean(enabled);
}

/**
 * Dev-only: allow invocations with missing sender URLs (devtools / hot-reload
 * scenarios where senderFrame.url may be empty). Should be called once at app
 * startup with the dev-build boolean, not on a runtime env check. When false,
 * missing sender URLs are rejected just like unknown URLs.
 * @param {boolean} enabled
 */
function setDevPermissive(enabled) {
  /** @type {IpcSenderGlobalFlags} */ (globalThis)[DEV_PERMISSIVE_KEY] = Boolean(enabled);
}

function isPackagedApp() {
  try {
    // Lazy require: unit tests run without a real electron module.
    const { app } = require('electron');
    return Boolean(app?.isPackaged);
  } catch {
    return false;
  }
}

/**
 * @param {import('electron').IpcMainInvokeEvent} event
 * @param {string} channel
 * @returns {null|{ success: false, error: { code: string, message: string } }}
 */
function assertAllowedIpcSender(event, channel) {
  // The explicit test bypass is never honored in a packaged build — even a
  // leaked bypass flag must not disable sender-origin validation in prod.
  if (
    /** @type {IpcSenderGlobalFlags} */ (globalThis)[TEST_BYPASS_KEY] === true &&
    !isPackagedApp()
  ) {
    return null;
  }
  const url = resolveInvocationUrl(event);
  // Same packaged-build gate as the test bypass: isDev is derived from
  // NODE_ENV, which an attacker-controlled `.env` or environment could flip,
  // so dev-permissive must never relax validation in a packaged app.
  if (
    !url &&
    /** @type {IpcSenderGlobalFlags} */ (globalThis)[DEV_PERMISSIVE_KEY] === true &&
    !isPackagedApp()
  ) {
    logger.debug('[IPC] Missing sender URL in dev mode; allowing invoke', { channel });
    return null;
  }
  if (isAllowedRendererUrl(url)) {
    return null;
  }
  logger.warn('[IPC] Rejecting invoke from unexpected sender', { channel, url });
  return {
    success: false,
    error: {
      code: 'IPC_SENDER_REJECTED',
      message: 'Invalid or unknown sender origin'
    }
  };
}

module.exports = {
  assertAllowedIpcSender,
  resolveInvocationUrl,
  isAllowedRendererUrl,
  setTestBypass,
  setDevPermissive
};
