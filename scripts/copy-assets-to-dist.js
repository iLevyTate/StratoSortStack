#!/usr/bin/env node
/**
 * Copies required assets into dist/ so the renderer can load them.
 * Run after webpack build. Used by npm run build and npm run dev.
 */
const fs = require('fs');
const path = require('path');

const { resolveSourceLogoPath } = require('./resolveSourceLogo');
const { MAIN_BUNDLE_MARKER } = require('./mainBundleMarker');

const projectRoot = path.resolve(__dirname, '..');
const assetsDir = path.join(projectRoot, 'assets');
const distDir = path.join(projectRoot, 'dist');
const distAssetsDir = path.join(distDir, 'assets');

const ASSETS_TO_COPY = [
  'stratosort-logo.png',
  ['icons', 'win', 'icon.ico'],
  ['icons', 'mac', 'icon.png'],
  ['icons', 'png', '512x512.png'],
  ['icons', 'png', '256x256.png'],
  ['icons', 'png', '128x128.png'],
  ['icons', 'png', '64x64.png'],
  ['icons', 'png', '48x48.png'],
  ['icons', 'png', '32x32.png'],
  ['icons', 'png', '24x24.png'],
  ['icons', 'png', '16x16.png']
];

// When --strict is passed (used by release pipelines), any missing required
// asset or missing top-level directory becomes a fatal error instead of a
// warn-and-skip. Release builds that silently ship without icons have been
// a recurring drift source; this flag makes the contract explicit.
const STRICT = process.argv.includes('--strict');

const missingAssets = [];

/**
 * Ensures the renderer webpack did not overwrite Electron's `dist/main.js`.
 *
 * Regression history: an unnamed array entry in `webpack.config.js` once
 * emitted `main.js` (React) on top of the main-process bundle. We catch that
 * by checking for a deterministic banner injected via `webpack.BannerPlugin`
 * in `webpack.main.config.js` (scoped to the `main` chunk via `include`).
 *
 * Earlier revisions of this verifier did a substring scan for `ipcMain` /
 * `BrowserWindow` / `electron` over the first 512 KiB of the file. That
 * heuristic produced false positives in development builds: webpack emits
 * vendor modules first (notably ~3 MiB of `wink-eng-lite-web-model` JSON),
 * pushing every Electron-API string past the head window even though the
 * file is the correct main bundle. The banner approach is exact: it lives
 * at byte 0 of the file and is preserved through Terser minification by
 * virtue of the leading `/*!` (bang comment) marker.
 */
function verifyDistLayout() {
  const mainPath = path.join(distDir, 'main.js');
  const rendererPath = path.join(distDir, 'renderer.js');
  if (!fs.existsSync(rendererPath)) {
    console.error(
      '[copy-assets] dist/renderer.js is missing — renderer entry must be named `renderer` in webpack.config.js'
    );
    process.exit(1);
  }
  if (!fs.existsSync(mainPath)) {
    console.error(
      '[copy-assets] dist/main.js is missing — run webpack.main.config.js (build:main) before the renderer build'
    );
    process.exit(1);
  }
  // Banner is on the first line; 8 KiB is a generous upper bound that still
  // covers webpack's runtime preamble in case BannerPlugin layout shifts.
  const headBytes = 8192;
  const fd = fs.openSync(mainPath, 'r');
  let head;
  try {
    const buf = Buffer.allocUnsafe(headBytes);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    head = buf.slice(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  if (!head.includes(MAIN_BUNDLE_MARKER)) {
    console.error(
      `[copy-assets] dist/main.js is missing the expected banner "${MAIN_BUNDLE_MARKER}".`
    );
    console.error(
      '[copy-assets] Either the renderer build overwrote dist/main.js, or the BannerPlugin in webpack.main.config.js was removed.'
    );
    process.exit(1);
  }
}

function copyAsset(asset) {
  const srcPath = Array.isArray(asset)
    ? path.join(assetsDir, ...asset)
    : path.join(assetsDir, asset);
  const relPath = Array.isArray(asset) ? path.join(...asset) : asset;
  const destPath = path.join(distAssetsDir, relPath);

  if (!fs.existsSync(srcPath)) {
    missingAssets.push(srcPath);
    console.warn(`[copy-assets] Skipping missing: ${srcPath}`);
    return;
  }

  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  fs.copyFileSync(srcPath, destPath);
}

function main() {
  if (!fs.existsSync(distDir)) {
    const msg = '[copy-assets] dist/ not found (run build first)';
    if (STRICT) {
      console.error(msg);
      process.exit(1);
    }
    console.warn(`${msg}, skipping`);
    return;
  }

  verifyDistLayout();

  if (!fs.existsSync(assetsDir)) {
    const msg = '[copy-assets] assets/ not found';
    if (STRICT) {
      console.error(msg);
      process.exit(1);
    }
    console.warn(msg);
    return;
  }

  for (const asset of ASSETS_TO_COPY) {
    copyAsset(asset);
  }

  const legacyLogoSrc = path.join(assetsDir, 'stratosort-logo.png');
  const legacyLogoDest = path.join(distAssetsDir, 'stratosort-logo.png');
  if (!fs.existsSync(legacyLogoSrc)) {
    const resolved = resolveSourceLogoPath(projectRoot);
    if (resolved && fs.existsSync(resolved)) {
      const destDir = path.dirname(legacyLogoDest);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      fs.copyFileSync(resolved, legacyLogoDest);
      console.log('[copy-assets] dist/assets/stratosort-logo.png aliased from source logo');
    }
  }

  console.log('[copy-assets] Copied assets to dist/assets/');

  if (STRICT && missingAssets.length > 0) {
    console.error(
      `[copy-assets] --strict: ${missingAssets.length} required asset(s) missing:\n  - ${missingAssets.join('\n  - ')}`
    );
    process.exit(1);
  }
}

main();
