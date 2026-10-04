// @ts-check
/**
 * Custom `app://` protocol used to serve the renderer in production.
 *
 * Why not file://: the `grantFileProtocolExtraPrivileges` Electron fuse is
 * disabled for hardening (see electron-builder.json). With that fuse off,
 * file:// pages lose storage privileges, so `localStorage`/IndexedDB throw
 * `SecurityError: Access is denied for this document`. That crashed the
 * search/graph modal and silently broke all renderer state persistence.
 *
 * A custom scheme registered as `standard` + `secure` has a real, stable origin
 * (`app://bundle`), so storage APIs work normally while keeping the file://
 * hardening intact. This is the Electron-recommended production pattern.
 */

const { protocol } = require('electron');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../shared/logger');
const {
  getRendererIndexPath,
  getRendererContentType,
  isSubPath,
  resolveRendererAssetPath
} = require('./rendererAssets');
const { buildContentSecurityPolicy, STATIC_SECURITY_HEADERS } = require('./securityHeaders');

const logger = createLogger('AppProtocol');

const APP_SCHEME = 'app';
const APP_HOST = 'bundle';
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const APP_INDEX_URL = `${APP_ORIGIN}/index.html`;

let schemePrivileged = false;

/**
 * Register the `app://` scheme as privileged. MUST be called synchronously
 * before the Electron `app` `ready` event (registerSchemesAsPrivileged is a
 * no-op once the app is ready).
 */
function registerAppSchemePrivileged() {
  if (schemePrivileged) return;
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        // Allows webpack-emitted async chunks + V8 code cache to behave like a
        // normal https origin.
        codeCache: true,
        stream: true
      }
    }
  ]);
  schemePrivileged = true;
  logger.debug('[AppProtocol] Registered privileged scheme', { scheme: APP_SCHEME });
}

function buildResponseHeaders(/** @type {any} */ filePath) {
  const headers = new Headers();
  headers.set('content-type', getRendererContentType(filePath));
  // The bundle is versioned per build; never serve a stale cached document.
  headers.set('cache-control', 'no-cache');
  // No {isDev: false} override: plain `npm run dev` (without USE_DEV_SERVER)
  // also loads via app://, and forcing the production CSP here blocked the
  // style-loader <style> tags dev builds rely on (unstyled-app regression).
  // The default tracks NODE_ENV, so packaged builds still get the prod policy.
  headers.set('content-security-policy', buildContentSecurityPolicy());
  for (const [key, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
    headers.set(key, value);
  }
  return headers;
}

function errorResponse(/** @type {any} */ status, /** @type {any} */ message) {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' }
  });
}

const handledSessions = new WeakSet();

/**
 * Register the `app://` request handler on a session. Idempotent per session.
 * Safe to call after `app` is ready. Serves files from the renderer bundle
 * directory with the same traversal + symlink containment guarantees as the
 * dev HTTP server.
 *
 * @param {import('electron').Session} session
 */
function registerAppProtocolHandler(session) {
  if (!session || typeof session.protocol?.handle !== 'function') return;
  if (handledSessions.has(session)) return;

  const rendererRoot = path.dirname(getRendererIndexPath());
  // Resolve symlinks in the root once so per-request realpath checks compare
  // against a stable canonical parent.
  let rendererRootReal = rendererRoot;
  try {
    rendererRootReal = fs.realpathSync(rendererRoot);
  } catch {
    rendererRootReal = rendererRoot;
  }

  session.protocol.handle(APP_SCHEME, async (request) => {
    try {
      const requestUrl = new URL(request.url);
      if (requestUrl.host !== APP_HOST) {
        return errorResponse(404, 'Not Found');
      }

      let assetPath = resolveRendererAssetPath(rendererRoot, requestUrl.pathname);
      if (!assetPath) {
        return errorResponse(403, 'Forbidden');
      }

      // why-silent: stat() ENOENT is the EXPECTED signal for "not a real file
      // on disk" (SPA route → falls through to index.html below). Any
      // non-ENOENT error gets surfaced via the existing errorResponse path
      // below since stat=null short-circuits to 404, and the debug log here
      // gives ops a way to correlate "user reports 404" with the actual fs
      // error code in a JSONL log.
      let stat = await fs.promises.stat(assetPath).catch((/** @type {any} */ err) => {
        if (err?.code !== 'ENOENT') {
          logger.debug?.('[appProtocol] asset stat failed', { code: err?.code });
        }
        return /** @type {any} */ (null);
      });
      if (stat?.isDirectory()) {
        assetPath = path.join(assetPath, 'index.html');
        stat = await fs.promises.stat(assetPath).catch(() => /** @type {any} */ (null)); // why-silent: directory→index fallback; same logic as above
      } else if (!stat && !path.extname(assetPath)) {
        // SPA-style client navigation with no file extension: fall back to the
        // app shell so deep links resolve.
        assetPath = path.join(rendererRoot, 'index.html');
        stat = await fs.promises.stat(assetPath).catch(() => /** @type {any} */ (null)); // why-silent: SPA shell fallback; absence handled by 404 below
      }

      if (!stat || !stat.isFile() || !isSubPath(assetPath, rendererRoot)) {
        return errorResponse(404, 'Not Found');
      }

      // SECURITY: resolve symlinks and re-check containment so a symlink placed
      // under the renderer root (tampered/compromised bundle) can't escape it.
      let realAssetPath;
      try {
        realAssetPath = await fs.promises.realpath(assetPath);
      } catch (realErr) {
        logger.warn('[AppProtocol] Rejected asset: realpath failed', {
          assetPath,
          error: realErr?.message || String(realErr)
        });
        return errorResponse(404, 'Not Found');
      }
      if (!isSubPath(realAssetPath, rendererRootReal)) {
        logger.warn('[AppProtocol] Rejected asset: symlink escapes renderer root', {
          assetPath,
          realAssetPath,
          rendererRootReal
        });
        return errorResponse(403, 'Forbidden');
      }

      // Read the bundle file directly rather than net.fetch(file://) so serving
      // is independent of Electron's per-version file-scheme fetch support.
      // Renderer assets are small, locally trusted, and read once per request.
      const data = await fs.promises.readFile(realAssetPath);
      return new Response(data, {
        status: 200,
        headers: buildResponseHeaders(realAssetPath)
      });
    } catch (error) {
      logger.error('[AppProtocol] Failed to serve renderer asset', {
        url: request?.url,
        error: error?.message || String(error)
      });
      return errorResponse(500, 'Internal Server Error');
    }
  });

  handledSessions.add(session);
  logger.info('[AppProtocol] Registered app:// handler', { rendererRoot });
}

module.exports = {
  APP_SCHEME,
  APP_HOST,
  APP_ORIGIN,
  APP_INDEX_URL,
  registerAppSchemePrivileged,
  registerAppProtocolHandler
};
