// @ts-check
/**
 * Renderer asset resolution helpers shared by the production app:// protocol
 * handler (appProtocol.js) and the dev-only local HTTP renderer server
 * (createWindow.js).
 *
 * Kept in a dependency-light leaf module so both consumers can share the same
 * path-resolution and traversal-safety logic without creating a circular
 * require between createWindow.js and appProtocol.js.
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../shared/logger');
const { getAppRoot } = require('../utils/bundledResourcePaths');

const logger = createLogger('RendererAssets');

function getAppRootPath() {
  try {
    return getAppRoot(app);
  } catch (err) {
    logger.debug('[RendererAssets] getAppRootPath fallback to cwd', {
      error: err?.message || String(err)
    });
    return process.cwd();
  }
}

function getRendererIndexPath() {
  // Packaged builds keep renderer HTML/JS inside the integrity-validated asar
  // (`asarUnpack` is worker bundles only). Prefer `app.asar/dist/index.html`.
  // Fall back to `app.asar.unpacked/dist/index.html` for leftover 4.0.6-era
  // unpacks that still ship the renderer outside the asar.
  if (app.isPackaged) {
    const asarIndex = path.join(getAppRootPath(), 'dist', 'index.html');
    if (fs.existsSync(asarIndex)) {
      return asarIndex;
    }
    const unpackedIndex = path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'dist',
      'index.html'
    );
    if (fs.existsSync(unpackedIndex)) {
      return unpackedIndex;
    }
    return asarIndex;
  }
  const root = getAppRootPath();
  const distCandidate = path.join(root, 'dist', 'index.html');
  if (fs.existsSync(distCandidate)) {
    return distCandidate;
  }
  const directCandidate = path.join(root, 'index.html');
  if (fs.existsSync(directCandidate)) {
    return directCandidate;
  }
  return distCandidate;
}

const RENDERER_CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
});

function getRendererContentType(/** @type {any} */ filePath) {
  return (
    /** @type {Record<string, string>} */ (RENDERER_CONTENT_TYPES)[
      path.extname(filePath).toLowerCase()
    ] || 'application/octet-stream'
  );
}

function isSubPath(/** @type {any} */ candidatePath, /** @type {any} */ parentPath) {
  const candidate = path.resolve(candidatePath);
  const parent = path.resolve(parentPath);
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveRendererAssetPath(
  /** @type {any} */ rendererRoot,
  /** @type {any} */ requestPathname
) {
  const normalizedPathname =
    typeof requestPathname === 'string' && requestPathname.length > 0 ? requestPathname : '/';
  const decodedPathname = decodeURIComponent(normalizedPathname);
  const candidateRelativePath = decodedPathname === '/' ? 'index.html' : decodedPathname.slice(1);
  const normalizedRelativePath = path.normalize(candidateRelativePath);
  const resolvedPath = path.resolve(rendererRoot, normalizedRelativePath);

  if (!isSubPath(resolvedPath, rendererRoot)) {
    return null;
  }

  return resolvedPath;
}

module.exports = {
  getAppRootPath,
  getRendererIndexPath,
  getRendererContentType,
  isSubPath,
  resolveRendererAssetPath,
  RENDERER_CONTENT_TYPES
};
