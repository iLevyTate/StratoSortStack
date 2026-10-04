/**
 * Single source of truth for the marker banner injected into `dist/main.js`.
 *
 * The Electron main-process bundle is large (12+ MiB in dev) and webpack emits
 * vendor modules — including ~3 MiB of `wink-eng-lite-web-model` JSON — at the
 * head of the file. That pushes any Electron API references (`ipcMain`,
 * `BrowserWindow`, …) tens of thousands of lines deep, so a head-window
 * substring scan can no longer reliably identify the bundle.
 *
 * Instead, `webpack.main.config.js` injects this exact banner via
 * `webpack.BannerPlugin` (scoped to the `main` chunk only). The post-build
 * verifier in `copy-assets-to-dist.js` reads the first few KB of `dist/main.js`
 * and asserts the banner is present — a deterministic check that catches the
 * regression where the renderer build accidentally clobbers `dist/main.js`.
 *
 * Keep `MAIN_BUNDLE_MARKER` short, namespaced, and stable; bump the version
 * suffix only if the verifier contract changes.
 */
'use strict';

const MAIN_BUNDLE_MARKER = 'StratoSort:main-process-bundle@v1';

module.exports = { MAIN_BUNDLE_MARKER };
