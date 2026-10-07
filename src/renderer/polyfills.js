// @ts-check
import { createLogger } from '../shared/logger';

const logger = createLogger('Polyfills');

// Ensure global/globalThis polyfills for libraries expecting Node-like globals
if (typeof global === 'undefined') {
  window.global = window;
}
if (typeof globalThis === 'undefined') {
  // Window.globalThis is readonly in TS lib.dom, but we're polyfilling on
  // engines that don't have it yet, so the assignment is intentional.
  /** @type {any} */ (window).globalThis = window;
}

// When the main process serves dist/ over http://127.0.0.1:<random>/, webpack async chunks must load
// from that origin. `output.publicPath: './'` is correct for file://; on http(s), pin to origin root.
/* global __webpack_public_path__:writable */
if (typeof __webpack_public_path__ !== 'undefined') {
  try {
    const loc = typeof window !== 'undefined' ? window.location : null;
    if (
      loc &&
      (loc.protocol === 'http:' || loc.protocol === 'https:') &&
      loc.origin &&
      loc.origin !== 'null'
    ) {
      __webpack_public_path__ = `${loc.origin}/`;
    }
  } catch {
    // ignore
  }
}

// Best-effort platform detection for the splash diagnostic hint. We can't
// import Node APIs here (renderer context) and `electronAPI` may be missing
// when preload fails, which is exactly when this hint is most useful. The
// returned path uses the product's real userData folder name ("StratoSort
// Core") so the hint matches what `electron.app.getPath('userData')` resolves
// to at runtime.
function describeLogsPath() {
  try {
    var ua = (navigator && navigator.userAgent) || '';
    if (/Windows/i.test(ua)) {
      return '%APPDATA%\\StratoSort Stack\\logs\\';
    }
    if (/Mac OS|Macintosh/i.test(ua)) {
      return '~/Library/Application Support/StratoSort Stack/logs/';
    }
    if (/Linux/i.test(ua)) {
      return '~/.config/StratoSort Stack/logs/';
    }
  } catch {
    // ignore — fall through to generic hint
  }
  return 'the app data folder (StratoSort Stack/logs/)';
}

// Splash safety timeout: if the React app doesn't remove the splash within 15 seconds,
// replace it with a diagnostic message so the user isn't stuck on "Initializing..." forever.
// This fires even if renderer/index.js completely fails to load or execute.
(function splashSafetyNet() {
  var TIMEOUT_MS = 15000;
  var timerId = setTimeout(function () {
    var splash = document.getElementById('initial-loading');
    if (!splash) return; // splash already removed, app loaded fine

    // Collect diagnostic info
    var hasElectronAPI = !!window.electronAPI;
    var hasReactRoot = !!(
      document.getElementById('root') && document.getElementById('root').children.length > 0
    );
    var errors = window.__STRATOSORT_BOOT_ERRORS || [];
    var errorText =
      errors.length > 0
        ? errors
            .map(function (e) {
              return e.message || String(e);
            })
            .join('\n')
        : 'No errors captured (renderer.js may not have loaded)';

    logger.error('[SPLASH-TIMEOUT] App did not initialize within ' + TIMEOUT_MS + 'ms', {
      hasElectronAPI: hasElectronAPI,
      hasReactRoot: hasReactRoot,
      errorCount: errors.length
    });

    // Replace splash with diagnostic info
    var statusEl = document.getElementById('splash-status');
    if (statusEl) {
      statusEl.textContent = 'Startup timed out';
      statusEl.style.color = '#ef4444';
    }

    // Add diagnostic section below the loader
    var loaderContainer = splash.querySelector('.splash-loader-container');
    if (loaderContainer) {
      var diagDiv = document.createElement('div');
      diagDiv.style.cssText =
        'margin-top:16px;padding:16px;background:#fff;border:1px solid #e5e7eb;border-radius:8px;max-width:480px;text-align:left;font-size:13px;color:#374151;word-break:break-word;';
      var heading = document.createElement('p');
      heading.style.cssText = 'margin:0 0 8px;font-weight:600;';
      heading.textContent = 'Startup diagnostic';
      diagDiv.appendChild(heading);

      var apiLine = document.createElement('p');
      apiLine.style.cssText = 'margin:0 0 4px;';
      apiLine.textContent = 'Electron API: ' + (hasElectronAPI ? 'OK' : 'MISSING');
      if (!hasElectronAPI) apiLine.style.color = '#ef4444';
      diagDiv.appendChild(apiLine);

      var reactLine = document.createElement('p');
      reactLine.style.cssText = 'margin:0 0 4px;';
      reactLine.textContent = 'React mounted: ' + (hasReactRoot ? 'Yes' : 'No');
      if (!hasReactRoot) reactLine.style.color = '#ef4444';
      diagDiv.appendChild(reactLine);

      var pre = document.createElement('pre');
      pre.style.cssText =
        'margin:8px 0 0;padding:8px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;overflow:auto;max-height:120px;font-size:11px;white-space:pre-wrap;';
      pre.textContent = errorText;
      diagDiv.appendChild(pre);

      var hint = document.createElement('p');
      hint.style.cssText = 'margin:8px 0 0;font-size:11px;color:#6b7280;';
      hint.textContent = 'Logs are in ' + describeLogsPath() + '.';
      diagDiv.appendChild(hint);

      // Offer a one-click shortcut when the preload IPC bridge is live; the
      // raw APPDATA/Application Support path hint is useless to most users.
      if (
        hasElectronAPI &&
        window.electronAPI.settings &&
        typeof window.electronAPI.settings.openLogsFolder === 'function'
      ) {
        var openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.textContent = 'Open logs folder';
        openBtn.style.cssText =
          'margin-top:8px;padding:6px 12px;font-size:12px;font-weight:500;color:#1f2937;background:#f3f4f6;border:1px solid #d1d5db;border-radius:6px;cursor:pointer;';
        openBtn.addEventListener('click', function () {
          try {
            var promise = window.electronAPI.settings.openLogsFolder();
            if (promise && typeof promise.catch === 'function') {
              promise.catch(function (/** @type {any} */ err) {
                logger.warn('[SPLASH-TIMEOUT] Failed to open logs folder', {
                  error: err && err.message ? err.message : String(err)
                });
              });
            }
          } catch (err) {
            logger.warn('[SPLASH-TIMEOUT] Failed to open logs folder', {
              error: err && err.message ? err.message : String(err)
            });
          }
        });
        diagDiv.appendChild(openBtn);
      }

      loaderContainer.parentNode.insertBefore(diagDiv, loaderContainer.nextSibling);
    }
  }, TIMEOUT_MS);

  // Let the React app cancel the timeout on successful boot
  window.__STRATOSORT_CANCEL_SPLASH_TIMEOUT = function () {
    clearTimeout(timerId);
  };

  // Capture early errors before React's error boundary loads.
  // Bounded: permanent listeners + unbounded array previously meant a buggy
  // boot loop (or a renderer that never finished hydrating) could grow the
  // array without limit. Cap the ring and expose a teardown hook so the
  // React bootstrap path can stop recording once it's rendered.
  var BOOT_ERRORS_MAX = 50;
  window.__STRATOSORT_BOOT_ERRORS = [];
  window.__STRATOSORT_BOOT_ERRORS_DROPPED = 0;

  function pushBootError(/** @type {any} */ entry) {
    if (!window.__STRATOSORT_BOOT_CAPTURE_ACTIVE) return;
    if (window.__STRATOSORT_BOOT_ERRORS.length >= BOOT_ERRORS_MAX) {
      window.__STRATOSORT_BOOT_ERRORS_DROPPED += 1;
      return;
    }
    window.__STRATOSORT_BOOT_ERRORS.push(entry);
  }

  function onBootError(/** @type {any} */ e) {
    pushBootError({
      message: (e.error ? e.error.message : e.message) || String(e),
      stack: e.error ? e.error.stack : '',
      filename: e.filename,
      lineno: e.lineno
    });
  }
  function onBootRejection(/** @type {any} */ e) {
    pushBootError({
      message: e.reason ? e.reason.message || String(e.reason) : 'unhandled promise rejection',
      stack: e.reason ? e.reason.stack : ''
    });
  }

  window.__STRATOSORT_BOOT_CAPTURE_ACTIVE = true;
  window.addEventListener('error', onBootError);
  window.addEventListener('unhandledrejection', onBootRejection);

  // React entrypoint calls this after the first successful paint so the
  // permanent error-boundary + global `src/renderer/index.js` handlers
  // become the single source of truth (no duplicate reporting).
  window.__STRATOSORT_TEARDOWN_BOOT_LISTENERS = function () {
    if (!window.__STRATOSORT_BOOT_CAPTURE_ACTIVE) return;
    window.__STRATOSORT_BOOT_CAPTURE_ACTIVE = false;
    window.removeEventListener('error', onBootError);
    window.removeEventListener('unhandledrejection', onBootRejection);
  };
})();
