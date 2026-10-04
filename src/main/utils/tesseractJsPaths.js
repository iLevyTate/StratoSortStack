// @ts-check
const fs = require('fs');
const os = require('os');
const { createRequire } = require('module');
const path = require('path');

/**
 * Resolve paths to tesseract.js and tesseract.js-core assets for createWorker().
 *
 * Uses createRequire(__filename) instead of bare require.resolve() so that:
 * 1. Webpack does not bundle tesseract assets into the worker (which would turn paths into
 *    module ids and break OCR at runtime).
 * 2. We still avoid a dynamic resolver(request) pattern that triggers "Critical dependency" warnings.
 *
 * Paths match tesseract.js v7 (see node_modules/tesseract.js/src/worker/node/defaultOptions.js).
 */
const requireFromThisModule = createRequire(__filename);
const { getAppRoot } = require('./bundledResourcePaths');

// Guarded electron require: this module is also bundled into the Piscina OCR
// worker (dist/ocrWorker.js), where worker threads cannot load the electron
// module. Same pattern as workerPools.js.
/** @type {any} */
let electronApp = null;
try {
  ({ app: electronApp } = require('electron'));
} catch {
  electronApp = null;
}

function resolveTesseractCoreFile() {
  try {
    return requireFromThisModule.resolve('tesseract.js-core/tesseract-core.wasm.js');
  } catch (originalError) {
    try {
      const packageJsonPath = requireFromThisModule.resolve('tesseract.js-core/package.json');
      const assetPath = path.join(path.dirname(packageJsonPath), 'tesseract-core.wasm.js');
      if (fs.existsSync(assetPath)) {
        return assetPath;
      }
    } catch {
      // Ignore package-root fallback failures and rethrow the original resolution error.
    }
    throw originalError;
  }
}

function resolveTesseractWorkerNodeScript() {
  try {
    return requireFromThisModule.resolve('tesseract.js/src/worker-script/node/index.js');
  } catch (originalError) {
    try {
      const packageJsonPath = requireFromThisModule.resolve('tesseract.js/package.json');
      const assetPath = path.join(path.dirname(packageJsonPath), 'src/worker-script/node/index.js');
      if (fs.existsSync(assetPath)) {
        return assetPath;
      }
    } catch {
      // Ignore package-root fallback failures and rethrow the original resolution error.
    }
    throw originalError;
  }
}

function resolveTesseractWorkerBrowserMin() {
  try {
    return requireFromThisModule.resolve('tesseract.js/dist/worker.min.js');
  } catch (originalError) {
    try {
      const packageJsonPath = requireFromThisModule.resolve('tesseract.js/package.json');
      const assetPath = path.join(path.dirname(packageJsonPath), 'dist/worker.min.js');
      if (fs.existsSync(assetPath)) {
        return assetPath;
      }
    } catch {
      // Ignore package-root fallback failures and rethrow the original resolution error.
    }
    throw originalError;
  }
}

const TESSDATA_CACHE_DIRNAME = 'tessdata-cache';

function _getAppRoot() {
  return getAppRoot(electronApp);
}

/**
 * Directory where bundled Tesseract traineddata lives. Follows the ffmpeg
 * runtime-asset pattern (src/main/utils/runtimePaths.js): STRATOSORT_RUNTIME_DIR
 * override -> packaged resources (process.resourcesPath/assets/runtime, shipped
 * by the electron-builder extraResources `runtime/**` glob) -> dev checkout
 * (appRoot/assets/runtime).
 */
function resolveBundledTessdataDir() {
  const override = process.env.STRATOSORT_RUNTIME_DIR;
  if (override && override.trim()) {
    return path.join(override.trim(), 'tessdata');
  }
  const resourcesCandidate = process.resourcesPath
    ? path.join(process.resourcesPath, 'assets', 'runtime', 'tessdata')
    : null;
  if (
    resourcesCandidate &&
    typeof fs.existsSync === 'function' &&
    fs.existsSync(resourcesCandidate)
  ) {
    return resourcesCandidate;
  }
  return path.join(_getAppRoot(), 'assets', 'runtime', 'tessdata');
}

/**
 * Locate a bundled `<lang>.traineddata[.gz]` file.
 *
 * NOTE: the traineddata asset itself is NOT committed to this repo — the
 * release pipeline drops `assets/runtime/tessdata/eng.traineddata.gz` in place
 * (picked up by the existing extraResources `runtime/**` glob, same as the
 * bundled ffmpeg binary). This resolver just wires the path when the file exists.
 *
 * @param {string} lang
 * @returns {{ langPath: string, gzip: boolean } | null}
 */
function resolveBundledTessdata(lang) {
  const dir = resolveBundledTessdataDir();
  try {
    if (fs.existsSync(path.join(dir, `${lang}.traineddata.gz`))) {
      return { langPath: dir, gzip: true };
    }
    if (fs.existsSync(path.join(dir, `${lang}.traineddata`))) {
      return { langPath: dir, gzip: false };
    }
  } catch {
    // Treat unreadable dirs as "no bundle"
  }
  return null;
}

/**
 * Writable directory for tesseract.js's traineddata cache. Without an explicit
 * cachePath, tesseract.js v7 writes to '.' (process cwd) — '/' when launched
 * from Finder, the install dir on Windows — which is unwritable and leaks
 * files outside userData.
 *
 * Worker threads cannot use electron's app.getPath, so callers inside a worker
 * must receive the path from the parent process (see ocrWorker payload); the
 * os.tmpdir() fallback here only covers non-Electron contexts with no
 * parent-provided path.
 */
function resolveTessdataCacheDir() {
  try {
    const userData = electronApp?.getPath?.('userData');
    if (userData) {
      return path.join(userData, TESSDATA_CACHE_DIRNAME);
    }
  } catch {
    // fall through to tmpdir
  }
  return path.join(os.tmpdir(), 'stratosort-tessdata-cache');
}

/** @param {string} dir @param {any} [logger] */
function _ensureDirExists(dir, logger) {
  // Skip real-filesystem writes under Jest (the shared electron mock points
  // userData at a fake absolute path). Same env gate as workerPools/tesseractUtils.
  if (process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'test') return;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    logger?.debug?.('[OCR] Could not create tessdata cache dir', {
      dir,
      error: /** @type {any} */ (error)?.message
    });
  }
}

// Single-fire warning (same pattern as MediaTranscoder._warnFfmpegFallbackOnce):
// when no bundled/cached traineddata exists, tesseract.js WILL fetch it from
// cdn.jsdelivr.net on first OCR. On a privacy-first product that network fetch
// must at least be observable in logs, once per process rather than per worker.
let _warnedTessdataCdnFallback = false;
/** @param {any} logger @param {string} lang @param {string} cachePath */
function _warnTessdataCdnFallbackOnce(logger, lang, cachePath) {
  if (_warnedTessdataCdnFallback) return;
  _warnedTessdataCdnFallback = true;
  logger?.warn?.(
    `[OCR] No bundled ${lang}.traineddata found under assets/runtime/tessdata and none cached yet; ` +
      `tesseract.js will download it from cdn.jsdelivr.net on first OCR and cache it to ${cachePath}. ` +
      'Bundle assets/runtime/tessdata/eng.traineddata.gz (extraResources runtime/** glob) to keep OCR fully offline.'
  );
}

/**
 * Resolve langPath/cachePath/gzip for tesseract.js createWorker() so OCR stays
 * on-device when a local traineddata copy exists and never caches to cwd.
 *
 * Precedence for language data:
 *   1. Bundled `assets/runtime/tessdata/<lang>.traineddata[.gz]`.
 *   2. A previously cached copy under userData/tessdata-cache.
 *   3. tesseract.js's CDN default (langPath omitted) — warned once; the
 *      download lands in cachePath so subsequent runs are offline.
 *
 * @param {any} [logger]
 * @param {{ lang?: string, cachePath?: string }} [options] `cachePath` MUST be
 *   supplied by the parent process when running inside a worker thread.
 * @returns {{ cachePath: string, langPath?: string, gzip?: boolean }}
 */
function resolveTesseractLanguageOptions(logger, options = {}) {
  const lang = options.lang || 'eng';
  const cachePath =
    typeof options.cachePath === 'string' && options.cachePath
      ? options.cachePath
      : resolveTessdataCacheDir();
  _ensureDirExists(cachePath, logger);

  const bundled = resolveBundledTessdata(lang);
  if (bundled) {
    return { cachePath, langPath: bundled.langPath, gzip: bundled.gzip };
  }

  try {
    if (fs.existsSync(path.join(cachePath, `${lang}.traineddata`))) {
      // Cached from an earlier download. Point langPath here too so the
      // non-cache read path also stays local (cache files are gunzipped).
      return { cachePath, langPath: cachePath, gzip: false };
    }
  } catch {
    // Unreadable cache dir: behave as if empty
  }

  _warnTessdataCdnFallbackOnce(logger, lang, cachePath);
  return { cachePath };
}

/** @param {any} [logger] */
function resolveTesseractJsOptions(logger) {
  try {
    const coreFile = resolveTesseractCoreFile();
    const corePath = path.dirname(coreFile);
    const isRenderer = typeof process !== 'undefined' && process.type === 'renderer';
    if (isRenderer) {
      const workerPath = resolveTesseractWorkerBrowserMin();
      return { workerPath, corePath };
    }
    const workerPath = resolveTesseractWorkerNodeScript();
    return { workerPath, corePath, workerBlobURL: false };
  } catch (error) {
    logger?.warn?.('[OCR] Failed to resolve tesseract.js assets', { error: error?.message });
    return null;
  }
}

module.exports = {
  resolveTesseractJsOptions,
  resolveTesseractLanguageOptions,
  resolveBundledTessdataDir,
  resolveTessdataCacheDir
};
