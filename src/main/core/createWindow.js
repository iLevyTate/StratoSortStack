// @ts-check
const { BrowserWindow, shell, app, nativeImage, screen } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { createLogger } = require('../../shared/logger');
const { TIMEOUTS } = require('../../shared/performanceConstants');
const { bringWindowToForeground } = require('./platformBehavior');
const errorHandler = require('../errors/ErrorHandler');

const logger = createLogger('CreateWindow');

// Invariant: webContents.executeJavaScript must use static script strings only (no user input,
// file paths, or other dynamic interpolation). Treat any future dynamic injection as a security bug.
const windowStateKeeper = require('electron-window-state');
const { isDevelopment, getEnvBool } = require('../../shared/configDefaults');
const {
  getAppRootPath,
  getRendererIndexPath,
  getRendererContentType,
  isSubPath,
  resolveRendererAssetPath
} = require('./rendererAssets');
const { APP_INDEX_URL, registerAppProtocolHandler } = require('./appProtocol');
const { buildContentSecurityPolicy, toWebRequestHeaderArrays } = require('./securityHeaders');
const { getEffectiveMaxPathLength } = require('../../shared/securityConfig');
const {
  resolveThemeBackground,
  isKnownTheme,
  THEME_BACKGROUND_FILE
} = require('../../shared/themeBackgrounds');

const isDev = isDevelopment();
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const disableBackgroundThrottling = getEnvBool('STRATOSORT_DISABLE_BACKGROUND_THROTTLING');
const DEFAULT_WINDOW_WIDTH = 1400;
const DEFAULT_WINDOW_HEIGHT = 900;
const MIN_WINDOW_WIDTH = 800;
const MIN_WINDOW_HEIGHT = 600;

/**
 * Native window background for the theme persisted by the
 * window:set-theme-background handler; primary surface when absent/corrupt.
 * Sync read on purpose: it must resolve before the BrowserWindow exists.
 */
function resolvePersistedThemeBackground() {
  try {
    const raw = fs.readFileSync(path.join(app.getPath('userData'), THEME_BACKGROUND_FILE), 'utf8');
    const theme = JSON.parse(raw)?.theme;
    if (isKnownTheme(theme)) return resolveThemeBackground(theme);
  } catch {
    // First run (no file) or unreadable content — fall through to default.
  }
  return resolveThemeBackground();
}

function asFiniteNumber(/** @type {any} */ value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** @param {any} value */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getDisplayWorkArea(/** @type {any} */ display) {
  if (!display) return { x: 0, y: 0, width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT };
  const source = display.workArea || display.bounds || {};
  return {
    x: asFiniteNumber(source.x) ?? 0,
    y: asFiniteNumber(source.y) ?? 0,
    width: Math.max(MIN_WINDOW_WIDTH, asFiniteNumber(source.width) ?? DEFAULT_WINDOW_WIDTH),
    height: Math.max(MIN_WINDOW_HEIGHT, asFiniteNumber(source.height) ?? DEFAULT_WINDOW_HEIGHT)
  };
}

function getBestDisplayForBounds(/** @type {any} */ bounds) {
  try {
    if (screen?.getDisplayMatching) {
      return screen.getDisplayMatching(bounds);
    }
    const displays = typeof screen?.getAllDisplays === 'function' ? screen.getAllDisplays() : [];
    const center = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2
    };
    return (
      displays.find((display) => {
        const area = getDisplayWorkArea(display);
        return (
          center.x >= area.x &&
          center.x <= area.x + area.width &&
          center.y >= area.y &&
          center.y <= area.y + area.height
        );
      }) || screen.getPrimaryDisplay()
    );
  } catch {
    return screen.getPrimaryDisplay();
  }
}

function isCenterInWorkArea(/** @type {any} */ bounds, /** @type {any} */ workArea) {
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  return (
    centerX >= workArea.x &&
    centerX <= workArea.x + workArea.width &&
    centerY >= workArea.y &&
    centerY <= workArea.y + workArea.height
  );
}

function sanitizeRestoredWindowBounds(
  /** @type {any} */ { x, y, width, height, forceDefaultPosition = false }
) {
  const primaryDisplay = screen.getPrimaryDisplay();
  const primaryWorkArea = getDisplayWorkArea(primaryDisplay);
  const requestedWidth = asFiniteNumber(width) ?? DEFAULT_WINDOW_WIDTH;
  const requestedHeight = asFiniteNumber(height) ?? DEFAULT_WINDOW_HEIGHT;
  const requestedX = asFiniteNumber(x);
  const requestedY = asFiniteNumber(y);

  // Round to integer pixels at the boundary. BrowserWindow accepts fractional
  // pixels but persists them, and over many sessions subpixel drift
  // accumulates (each restore quantizes slightly differently between
  // platforms). Integer pixels are visually identical and stable.
  const roundBounds = (/** @type {any} */ b) => ({
    width: Math.round(b.width),
    height: Math.round(b.height),
    x: typeof b.x === 'number' ? Math.round(b.x) : b.x,
    y: typeof b.y === 'number' ? Math.round(b.y) : b.y
  });

  if (forceDefaultPosition || requestedX === undefined || requestedY === undefined) {
    return roundBounds({
      width: Math.min(Math.max(requestedWidth, MIN_WINDOW_WIDTH), primaryWorkArea.width),
      height: Math.min(Math.max(requestedHeight, MIN_WINDOW_HEIGHT), primaryWorkArea.height),
      x: undefined,
      y: undefined
    });
  }

  const requestedBounds = {
    x: requestedX,
    y: requestedY,
    width: Math.max(requestedWidth, MIN_WINDOW_WIDTH),
    height: Math.max(requestedHeight, MIN_WINDOW_HEIGHT)
  };
  const workArea = getDisplayWorkArea(getBestDisplayForBounds(requestedBounds));
  const safeWidth = Math.min(requestedBounds.width, workArea.width);
  const safeHeight = Math.min(requestedBounds.height, workArea.height);
  const maxX = workArea.x + workArea.width - safeWidth;
  const maxY = workArea.y + workArea.height - safeHeight;
  const safeBounds = {
    x: Math.min(Math.max(requestedBounds.x, workArea.x), maxX),
    y: Math.min(Math.max(requestedBounds.y, workArea.y), maxY),
    width: safeWidth,
    height: safeHeight
  };

  if (!isCenterInWorkArea(safeBounds, workArea)) {
    return roundBounds({
      ...safeBounds,
      x: undefined,
      y: undefined
    });
  }

  return roundBounds(safeBounds);
}

const getAssetPath = (/** @type {string[]} */ ...paths) => {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(getAppRootPath(), 'assets');
  return path.join(base, ...paths);
};

function getWindowIconCandidatePaths() {
  // In dev, icon assets may be available from either assets/ or dist/assets/
  // depending on whether source assets are present locally.
  const devAssetRoots = app.isPackaged
    ? []
    : Array.from(
        new Set(
          [
            path.join(getAppRootPath(), 'assets'),
            path.join(getAppRootPath(), 'dist', 'assets'),
            path.join(process.cwd(), 'assets'),
            path.join(process.cwd(), 'dist', 'assets'),
            path.join(__dirname, '..', 'assets'),
            path.join(__dirname, '..', '..', 'assets')
          ].filter(Boolean)
        )
      );

  const fallbackPath = (/** @type {any} */ filePath) =>
    devAssetRoots.map((root) => path.join(root, filePath));

  if (isWindows) {
    // process.cwd() is most reliable in dev when running from project root
    const cwdIco = path.join(process.cwd(), 'assets', 'icons', 'win', 'icon.ico');
    const cwdPng = path.join(process.cwd(), 'assets', 'icons', 'png', '512x512.png');
    const primary = [
      cwdIco,
      getAssetPath('icons', 'win', 'icon.ico'),
      getAssetPath('icons', 'png', 'StratoSortStackLogo.png'),
      getAssetPath('stratosort-logo.png'),
      cwdPng,
      getAssetPath('icons', 'png', '512x512.png')
    ];
    const fallbacks = fallbackPath(path.join('icons', 'win', 'icon.ico')).concat(
      fallbackPath(path.join('icons', 'png', 'StratoSortStackLogo.png')),
      fallbackPath('stratosort-logo.png'),
      fallbackPath(path.join('icons', 'png', '512x512.png'))
    );
    return Array.from(new Set([...primary, ...fallbacks]));
  }

  if (process.platform === 'linux') {
    const primary = [
      getAssetPath('icons', 'png', '512x512.png'),
      getAssetPath('icons', 'png', 'StratoSortStackLogo.png'),
      getAssetPath('stratosort-logo.png')
    ];
    const fallbacks = fallbackPath(path.join('icons', 'png', '512x512.png')).concat(
      fallbackPath(path.join('icons', 'png', 'StratoSortStackLogo.png')),
      fallbackPath('stratosort-logo.png')
    );
    return Array.from(new Set([...primary, ...fallbacks]));
  }

  // macOS
  const primary = [
    getAssetPath('icons', 'png', '512x512.png'),
    getAssetPath('icons', 'png', 'StratoSortStackLogo.png'),
    getAssetPath('stratosort-logo.png')
  ];
  const fallbacks = fallbackPath(path.join('icons', 'png', '512x512.png')).concat(
    fallbackPath(path.join('icons', 'png', 'StratoSortStackLogo.png')),
    fallbackPath('stratosort-logo.png')
  );
  return Array.from(new Set([...primary, ...fallbacks]));
}

function getPreloadPath() {
  // In dev and in packaged builds, main/preload are emitted to `dist/`
  // We avoid using `__dirname` because webpack outputs `dist/main.js` and the old
  // relative traversal can accidentally resolve outside the repo (as seen in logs).
  const root = getAppRootPath();
  return path.join(root, 'dist', 'preload.js');
}

function startLocalRendererServer(/** @type {any} */ rendererRootPath) {
  const rendererRoot = path.resolve(rendererRootPath);

  // SECURITY: resolve symlinks in the renderer root once so later realpath
  // checks can use a stable, canonical parent. If the root itself can't be
  // realpath'd (e.g. freshly built on a filesystem without the directory
  // yet) we fall back to the resolved path; the per-request realpath call
  // still catches any symlink escapes below the root.
  let rendererRootReal = rendererRoot;
  try {
    rendererRootReal = fs.realpathSync(rendererRoot);
  } catch {
    rendererRootReal = rendererRoot;
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      try {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.statusCode = 405;
          response.setHeader('Content-Type', 'text/plain; charset=utf-8');
          response.end('Method Not Allowed');
          return;
        }

        const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
        let assetPath = resolveRendererAssetPath(rendererRoot, requestUrl.pathname);
        if (!assetPath) {
          response.statusCode = 403;
          response.end('Forbidden');
          return;
        }

        try {
          // why-silent: stat() ENOENT is the EXPECTED signal for "not a real
          // file on disk" (SPA route → falls through to index.html below).
          // Non-ENOENT failures still get debug-logged so ops can correlate
          // user-visible 404s with underlying fs errors.
          const stat = await fs.promises.stat(assetPath).catch(
            /** @returns {any} */
            (/** @type {any} */ err) => {
              if (err?.code !== 'ENOENT') {
                logger.debug?.('[createWindow] asset stat failed', { code: err?.code });
              }
              return null;
            }
          );
          if (stat?.isDirectory()) {
            assetPath = path.join(assetPath, 'index.html');
          } else if (!stat && !path.extname(assetPath)) {
            // SPA-style client navigation: fall back to index.html
            assetPath = path.join(rendererRoot, 'index.html');
          }

          const finalStat = stat?.isFile()
            ? stat
            : await fs.promises.stat(assetPath).catch(/** @returns {any} */ () => null); // why-silent: SPA shell fallback; null handled by 404 below
          if (!finalStat || !isSubPath(assetPath, rendererRoot)) {
            response.statusCode = 404;
            response.end('Not Found');
            return;
          }

          // SECURITY: resolve symlinks on the final asset path and re-check
          // containment. Otherwise a symlink placed anywhere under
          // `rendererRoot` (e.g. by a compromised build step or tampered
          // dist folder) would escape to arbitrary files even though the
          // logical path still satisfies isSubPath.
          let realAssetPath;
          try {
            realAssetPath = await fs.promises.realpath(assetPath);
          } catch (realErr) {
            logger.warn('[WINDOW] Rejected renderer asset: realpath failed', {
              assetPath,
              error: realErr?.message || String(realErr)
            });
            response.statusCode = 404;
            response.end('Not Found');
            return;
          }
          if (!isSubPath(realAssetPath, rendererRootReal)) {
            logger.warn('[WINDOW] Rejected renderer asset: symlink escapes rendererRoot', {
              assetPath,
              realAssetPath,
              rendererRootReal
            });
            response.statusCode = 403;
            response.end('Forbidden');
            return;
          }
          assetPath = realAssetPath;
        } catch (err) {
          logger.debug('[WINDOW] Renderer asset resolve failed', {
            error: err?.message || String(err)
          });
          response.statusCode = 404;
          response.end('Not Found');
          return;
        }

        response.statusCode = 200;
        response.setHeader('Content-Type', getRendererContentType(assetPath));
        response.setHeader('Cache-Control', 'no-store');

        if (request.method === 'HEAD') {
          response.end();
          return;
        }

        fs.createReadStream(assetPath)
          .on('error', (streamError) => {
            logger.warn('[WINDOW] Failed to stream renderer asset', {
              assetPath,
              error: streamError.message
            });
            if (!response.headersSent) {
              response.statusCode = 500;
            }
            response.end('Internal Server Error');
          })
          .pipe(response);
      } catch (error) {
        logger.warn('[WINDOW] Renderer HTTP request failed', { error: error.message });
        response.statusCode = 500;
        response.end('Internal Server Error');
      }
    });

    server.once('error', reject);
    server.unref(); // Don't keep process alive just for dev server
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address !== 'object' || typeof address.port !== 'number') {
        server.close(() => reject(new Error('Renderer server failed to bind to a local port')));
        return;
      }

      resolve({
        server,
        // Trailing slash keeps document base URL stable for resolving relative chunk URLs.
        url: `http://127.0.0.1:${address.port}/`
      });
    });
  });
}

function createMainWindow() {
  logger.debug('Creating new window');

  // Ensure AppUserModelID for Windows integration (notifications, jump list)
  try {
    if (app.isPackaged) {
      app.setAppUserModelId('com.stratosort.app');
    } else {
      app.setAppUserModelId(process.execPath);
    }
  } catch (error) {
    logger.debug('Failed to set AppUserModelId', { error: error.message });
  }

  // Restore previous window position/size
  const mainWindowState = windowStateKeeper({
    defaultWidth: DEFAULT_WINDOW_WIDTH,
    defaultHeight: DEFAULT_WINDOW_HEIGHT
  });

  logger.debug('Window state loaded', {
    width: mainWindowState.width,
    height: mainWindowState.height,
    x: mainWindowState.x,
    y: mainWindowState.y,
    isMaximized: mainWindowState.isMaximized,
    isFullScreen: mainWindowState.isFullScreen
  });

  // This prevents the maximize button from only changing size by ~1px
  // Improved threshold: Only reset if VERY close to maximized (within 20px) to avoid
  // resetting users who intentionally want large windows.
  const primaryDisplay = screen.getPrimaryDisplay();
  const primaryWorkArea = getDisplayWorkArea(primaryDisplay);
  const { width: screenWidth, height: screenHeight } = primaryWorkArea;

  const savedIsMaximized = Boolean(mainWindowState.isMaximized);
  const savedIsFullScreen = Boolean(mainWindowState.isFullScreen);

  // Use a tight threshold (20px) to avoid false positives
  const widthDiff = screenWidth - mainWindowState.width;
  const heightDiff = screenHeight - mainWindowState.height;
  const isNearMaximized = widthDiff >= 0 && widthDiff <= 20 && heightDiff >= 0 && heightDiff <= 20;

  // Only reset if we are essentially maximized but the state says we aren't
  const shouldResetToDefault = !savedIsMaximized && !savedIsFullScreen && isNearMaximized;

  const sanitizedBounds = sanitizeRestoredWindowBounds({
    x: mainWindowState.x,
    y: mainWindowState.y,
    width: shouldResetToDefault ? DEFAULT_WINDOW_WIDTH : mainWindowState.width,
    height: shouldResetToDefault ? DEFAULT_WINDOW_HEIGHT : mainWindowState.height,
    forceDefaultPosition: shouldResetToDefault
  });
  const windowWidth = sanitizedBounds.width;
  const windowHeight = sanitizedBounds.height;
  const windowX = sanitizedBounds.x;
  const windowY = sanitizedBounds.y;

  if (
    shouldResetToDefault ||
    windowWidth !== mainWindowState.width ||
    windowHeight !== mainWindowState.height ||
    windowX !== mainWindowState.x ||
    windowY !== mainWindowState.y
  ) {
    logger.debug('Window state sanitized before creation', {
      reason: shouldResetToDefault ? 'near-maximized-unmaximized-state' : 'out-of-work-area-bounds',
      saved: {
        savedWidth: mainWindowState.width,
        savedHeight: mainWindowState.height,
        savedX: mainWindowState.x,
        savedY: mainWindowState.y
      },
      sanitized: {
        width: windowWidth,
        height: windowHeight,
        x: windowX,
        y: windowY
      },
      screenWidth,
      screenHeight
    });
  }

  // Load app icon with platform-specific preference order.
  const iconPaths = getWindowIconCandidatePaths();
  let appIcon;
  let appIconPath;
  try {
    for (const iconPath of iconPaths) {
      if (!fs.existsSync(iconPath)) {
        continue;
      }

      const candidate = nativeImage.createFromPath(iconPath);
      if (candidate.isEmpty()) {
        logger.warn('App icon loaded but image is empty', { iconPath });
        continue;
      }

      appIcon = candidate;
      appIconPath = iconPath;
      logger.info('App icon loaded', { iconPath, size: candidate.getSize() });
      break;
    }

    if (!appIcon) {
      logger.warn('No usable app icon found, using Electron default', {
        attemptedPaths: iconPaths
      });
    }
  } catch (err) {
    logger.warn('Failed to load app icon', { attemptedPaths: iconPaths, error: err.message });
  }

  const win = new BrowserWindow({
    x: windowX,
    y: windowY,
    width: windowWidth,
    height: windowHeight,
    minWidth: 800,
    minHeight: 600,
    // Frameless chrome with platform-sensitive styling
    frame: !!isMac,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { windowButtonPosition: { x: 16, y: 16 } } : {}),
    // Match the CHOSEN theme's splash/renderer shell (persisted by the
    // window:set-theme-background handler) so the native frame never
    // flashes the wrong palette pre-HTML (U-002).
    backgroundColor: resolvePersistedThemeBackground(),
    darkTheme: false,
    webPreferences: /** @type {any} */ ({
      nodeIntegration: false,
      contextIsolation: true,
      // Sandbox enabled: preload script is bundled with webpack (target: 'web')
      // and only uses contextBridge to expose safe APIs.
      sandbox: true,
      preload: getPreloadPath(),
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      // Chromium's spellchecker downloads Hunspell dictionaries from a Google
      // CDN on Windows and Linux. docs/NETWORK_TRANSPARENCY.md promises that
      // an install with no cloud provider makes no outbound requests, and
      // the app's inputs are paths and short queries, so it stays off.
      spellcheck: false,
      // Throttle timers/painting when hidden to reduce background CPU usage.
      // Opt-out via STRATOSORT_DISABLE_BACKGROUND_THROTTLING=1 for diagnostics.
      backgroundThrottling: !disableBackgroundThrottling,
      // Enable the DevTools *capability* in dev, when forced, or under e2e (so the
      // window-state DevTools spec can open/close them). This only permits opening — the
      // auto-open block below stays gated on isDev/FORCE_DEV_TOOLS so e2e does not pop a
      // stray DevTools window on every launch. Packaged builds are unaffected (isPackaged).
      devTools:
        isDev ||
        (!app.isPackaged && (getEnvBool('FORCE_DEV_TOOLS') || getEnvBool('STRATOSORT_E2E'))),
      hardwareAcceleration: true,
      enableWebGL: true,
      safeDialogs: true,
      offscreen: false,
      webviewTag: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      // The sandboxed preload cannot probe the LongPathsEnabled registry key
      // itself; hand it main's effective limit so its path-length gate matches
      // what the filesystem actually accepts (preload reads process.argv).
      additionalArguments: [`--stratosort-max-path-length=${getEffectiveMaxPathLength()}`]
    }),
    // On Windows, passing the string path to the .ico file works best for the taskbar
    ...(appIconPath ? { icon: isWindows ? appIconPath : appIcon } : {}),
    show: false,
    autoHideMenuBar: true // Keep menu accessible via Alt while preserving a clean chrome
  });

  logger.debug('BrowserWindow created');

  // Serve the production renderer from app:// on this window's session. No
  // partition is set, so this is the default session; idempotent per session.
  // Must run before loadContent() issues loadURL(APP_INDEX_URL).
  registerAppProtocolHandler(win.webContents.session);

  if (appIconPath && typeof win.setIcon === 'function') {
    try {
      win.setIcon(isWindows ? appIconPath : appIcon);
    } catch (error) {
      logger.debug('Failed to force-apply BrowserWindow icon', { error: error.message });
    }
  }

  // Manage window state with cleanup tracking
  mainWindowState.manage(win);

  // Restore saved window states so user sizing persists between runs
  if (savedIsFullScreen) {
    win.setFullScreen(true);
  } else if (savedIsMaximized) {
    win.maximize();
  }

  // The library uses debounced saves which may not complete if window closes quickly
  // We call saveState() directly to ensure state is persisted synchronously
  win.on('close', () => {
    try {
      const isMaximized = win.isMaximized();
      const isFullScreen = win.isFullScreen();

      logger.debug('Window closing, triggering state save', {
        isMaximized,
        isFullScreen
      });

      // Force electron-window-state to save immediately
      // This uses its internal tracking which properly handles pre-maximized bounds
      mainWindowState.saveState(win);
      logger.debug('Window state saved via electron-window-state');
    } catch (e) {
      logger.warn('Could not save window state on close', { error: e.message });
    }
  });

  // Add cleanup for window state keeper on window close
  win.once('closed', () => {
    try {
      mainWindowState.unmanage();
    } catch {
      // State keeper might already be cleaned up
    }
  });

  // Wait for webContents to be fully ready before loading content
  /** @type {any} */
  let rendererStaticServer = null;
  let isWindowClosed = false;
  let isStartingRendererServer = false;
  let rendererRecoveryAttempts = 0;
  const MAX_RENDERER_RECOVERY_ATTEMPTS = 2;
  const rendererDistPath = getRendererIndexPath();
  /** @type {any} */
  let _healthCheckTimerId = null;

  const closeRendererStaticServer = (server = rendererStaticServer) => {
    if (!server) return;
    try {
      server.close();
    } catch (error) {
      logger.debug('[WINDOW] Failed to close renderer static server', { error: error.message });
    }
    if (rendererStaticServer === server) {
      rendererStaticServer = null;
    }
  };

  const clearHealthCheckTimer = () => {
    if (_healthCheckTimerId) {
      clearTimeout(_healthCheckTimerId);
      _healthCheckTimerId = null;
    }
  };
  win.once('closed', clearHealthCheckTimer);
  win.once(/** @type {any} */ ('destroy'), clearHealthCheckTimer);

  const renderMissingBundle = (/** @type {any} */ reason, /** @type {any} */ attemptedPath) => {
    logger.error('[WINDOW] Renderer bundle missing', { reason, attemptedPath });
    const helpText = isDev
      ? 'Run `npm run build:dev` or `npm run dev` to generate renderer assets.'
      : 'Reinstall the app or rebuild the package.';
    const html = `<!doctype html><html><head><meta charset="utf-8"/><title>StratoSort</title></head><body style="font-family:Segoe UI,Arial,sans-serif;padding:24px;color:#1f2937;background:#f8fafc;"><h1 style="margin:0 0 12px;">StratoSort failed to load</h1><p style="margin:0 0 12px;">${escapeHtml(reason)}</p><p style="margin:0 0 12px;">${helpText}</p><pre style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px;overflow:auto;">${escapeHtml(attemptedPath)}</pre></body></html>`;
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch((e) => {
      logger.error('[WINDOW] Failed to load error page', { error: e.message });
    });
  };

  const loadRendererFromFileFallback = () => {
    if (!fs.existsSync(rendererDistPath)) {
      renderMissingBundle('Renderer bundle not found.', rendererDistPath);
      return;
    }
    win.loadFile(rendererDistPath).catch((fallbackError) => {
      renderMissingBundle('Failed to load renderer bundle.', rendererDistPath);
      logger.error('Failed to load renderer bundle:', fallbackError);
    });
  };

  const loadRendererFromLocalServer = ({ forceRestart = false } = {}) => {
    if (!fs.existsSync(rendererDistPath)) {
      renderMissingBundle('Renderer bundle not found.', rendererDistPath);
      return;
    }
    if (isStartingRendererServer) {
      logger.debug('[WINDOW] Renderer static server startup already in progress');
      return;
    }
    if (forceRestart && rendererStaticServer) {
      closeRendererStaticServer(rendererStaticServer);
    }

    isStartingRendererServer = true;
    const rendererRoot = path.dirname(rendererDistPath);
    startLocalRendererServer(rendererRoot)
      .then(
        /** @returns {any} */ ({ server, url }) => {
          if (isWindowClosed || win.isDestroyed()) {
            closeRendererStaticServer(server);
            return undefined;
          }
          if (rendererStaticServer && rendererStaticServer !== server) {
            closeRendererStaticServer(rendererStaticServer);
          }
          rendererStaticServer = server;
          win.loadURL(url).catch((error) => {
            logger.error('Failed to load renderer over local HTTP, falling back to file://', {
              error: error.message
            });
            closeRendererStaticServer(server);
            loadRendererFromFileFallback();
          });
          return undefined;
        }
      )
      .catch((error) => {
        logger.error('Failed to start local renderer server:', error);
        loadRendererFromFileFallback();
      })
      .finally(() => {
        isStartingRendererServer = false;
      });
  };

  const loadContent = () => {
    const useDevServer = isDev && getEnvBool('USE_DEV_SERVER');
    if (useDevServer) {
      win.loadURL('http://localhost:3000/').catch((error) => {
        logger.info('Development server not available:', error.message);
        // Dev fallback still uses the local HTTP server so async webpack
        // chunks fetched via dynamic imports resolve correctly (file://
        // asset URLs don't emit http-compatible Origin headers for CSP).
        logger.info('Loading from local renderer HTTP server instead...');
        loadRendererFromLocalServer({ forceRestart: true });
      });
      return;
    }

    // Production: serve the renderer from the custom app:// scheme instead of
    // file://. A standard + secure scheme has a real, stable origin
    // (app://bundle), so storage APIs (localStorage/IndexedDB) work — file://
    // loses those privileges under the grantFileProtocolExtraPrivileges fuse
    // (disabled for hardening), which crashed the search/graph modal with a
    // localStorage SecurityError. The app:// handler is registered on this
    // window's session in createMainWindow before this load runs.
    if (!fs.existsSync(rendererDistPath)) {
      renderMissingBundle('Renderer bundle not found.', rendererDistPath);
      return;
    }
    win.loadURL(APP_INDEX_URL).catch((error) => {
      logger.error('[WINDOW] loadURL(app://) failed in production, using error page', {
        error: error.message,
        rendererDistPath
      });
      renderMissingBundle('Failed to load renderer bundle.', rendererDistPath);
    });
  };

  /** @type {any} */
  let _loadTimerId = null;
  const scheduleLoad = () => {
    _loadTimerId = setTimeout(loadContent, TIMEOUTS.WINDOW_LOAD_DELAY);
  };
  if (win.webContents.isLoading()) {
    win.webContents.once('did-stop-loading', scheduleLoad);
  } else {
    // Add a small delay to ensure window is fully initialized
    scheduleLoad();
  }
  win.once('closed', () => {
    isWindowClosed = true;
    closeRendererStaticServer();
    if (_loadTimerId) clearTimeout(_loadTimerId);
  });

  // Security headers for dev loads (http://127.0.0.1 / http://localhost / file://).
  // The production app:// path sets the same headers directly on its Response
  // (see appProtocol.js) because custom standard schemes do not reliably pass
  // through webRequest. Both paths share securityHeaders.js so they can't drift.
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [buildContentSecurityPolicy({ isDev })],
        ...toWebRequestHeaderArrays()
      }
    });
  });

  win.once('ready-to-show', () => {
    /** @type {any[]} */
    const pendingTimers = [];
    const track = (/** @type {any} */ id) => {
      pendingTimers.push(id);
      return id;
    };
    const clearPendingTimers = () => pendingTimers.forEach(clearTimeout);
    win.once('closed', clearPendingTimers);
    win.once(/** @type {any} */ ('destroy'), clearPendingTimers);

    track(
      setTimeout(() => {
        if (!win.isDestroyed()) {
          win.show();

          // Additional delay before focus to ensure window is fully rendered
          track(
            setTimeout(() => {
              if (!win.isDestroyed()) {
                win.focus();
                logger.info('StratoSort window ready and focused');
                logger.debug('Window state', {
                  isVisible: win.isVisible(),
                  isFocused: win.isFocused(),
                  isMinimized: win.isMinimized()
                });

                // Auto-open DevTools in development (or FORCE_DEV_TOOLS). E2E/tour
                // launches set STRATOSORT_E2E=1: keep the capability, do not spawn a
                // detached DevTools window that Playwright can record instead of the app.
                const autoOpenDevTools =
                  !getEnvBool('STRATOSORT_E2E') &&
                  (isDev || (!app.isPackaged && getEnvBool('FORCE_DEV_TOOLS')));
                if (autoOpenDevTools) {
                  // This ensures we act after DevTools has fully opened and stolen focus
                  win.webContents.once('devtools-opened', () => {
                    // Small delay to let DevTools finish rendering
                    track(
                      setTimeout(() => {
                        if (!win.isDestroyed()) {
                          bringWindowToForeground(win);
                          // Second attempt in case DevTools grabs focus again
                          track(
                            setTimeout(() => {
                              if (!win.isDestroyed()) {
                                bringWindowToForeground(win);
                              }
                            }, 300)
                          );
                        }
                      }, 100)
                    );
                  });
                  win.webContents.openDevTools({ mode: 'detach' });
                }
              }
            }, 50)
          );
        }
      }, 100)
    );
  });

  win.on('closed', () => {
    // noop; main process holds the reference
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logger.error('[WINDOW] did-fail-load', {
      errorCode,
      errorDescription,
      validatedURL
    });

    const isLocalRendererRefusal =
      errorCode === -102 &&
      typeof validatedURL === 'string' &&
      validatedURL.startsWith('http://127.0.0.1:');

    if (!isLocalRendererRefusal || isWindowClosed || win.isDestroyed()) {
      return;
    }

    if (rendererRecoveryAttempts >= MAX_RENDERER_RECOVERY_ATTEMPTS) {
      logger.error('[WINDOW] Renderer recovery attempts exhausted; using file fallback', {
        validatedURL,
        attempts: rendererRecoveryAttempts
      });
      closeRendererStaticServer();
      loadRendererFromFileFallback();
      return;
    }

    rendererRecoveryAttempts += 1;
    logger.warn('[WINDOW] Recovering from local renderer connection refusal', {
      validatedURL,
      attempt: rendererRecoveryAttempts,
      maxAttempts: MAX_RENDERER_RECOVERY_ATTEMPTS
    });
    loadRendererFromLocalServer({ forceRestart: true });
  });

  // Renderer crash classification: transient causes (oom, crashed) are
  // auto-reloaded silently instead of pulling up the "App needs to restart"
  // dialog mid-chat-stream. This handler owns the whole oom/crashed policy —
  // reload while budget remains, escalate to the critical-error dialog once
  // it is spent. It cannot be split with ErrorHandler's app-level
  // 'render-process-gone' listener because Electron fires the app-level event
  // *before* this webContents-level one, so any flag set here is read too
  // late. ErrorHandler's listener skips oom/crashed for that reason and only
  // escalates the remaining reasons (killed, abnormal-exit, launch-failed…).
  let _rendererReloadCount = 0;
  let _lastRendererReloadAt = 0;
  const RENDERER_RELOAD_WINDOW_MS = 60_000;
  const RENDERER_RELOAD_BUDGET = 2;
  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error('[WINDOW] Render process gone', details);
    const reason = details?.reason;
    if (reason !== 'oom' && reason !== 'crashed') return;
    const now = Date.now();
    if (now - _lastRendererReloadAt > RENDERER_RELOAD_WINDOW_MS) {
      _rendererReloadCount = 0;
    }
    if (_rendererReloadCount >= RENDERER_RELOAD_BUDGET) {
      logger.error('[WINDOW] Renderer reload budget exhausted; escalating to critical error', {
        reason,
        attempts: _rendererReloadCount,
        windowMs: RENDERER_RELOAD_WINDOW_MS
      });
      const exitCode =
        typeof details?.exitCode === 'number' ? `, exitCode=${details.exitCode}` : '';
      void errorHandler.handleCriticalError(
        `Renderer Process Crashed after ${_rendererReloadCount} auto-reloads (reason=${reason}${exitCode})`,
        { details, webContentsId: win.webContents?.id }
      );
      return;
    }
    _rendererReloadCount++;
    _lastRendererReloadAt = now;
    logger.warn(
      `[WINDOW] Auto-reloading renderer after ${reason} (attempt ${_rendererReloadCount}/${RENDERER_RELOAD_BUDGET})`
    );
    try {
      if (!win.isDestroyed()) win.webContents.reload();
    } catch (reloadErr) {
      logger.error('[WINDOW] Renderer reload failed', { error: reloadErr?.message });
    }
  });

  // Capture renderer console output for diagnosis (always enabled)
  // Electron 40+ passes properties on the event object
  win.webContents.on('console-message', (/** @type {any} */ event) => {
    const level = event.level ?? 0;
    const message = event.message ?? '';
    const line = event.line ?? 0;
    const sourceId = event.sourceId ?? '';
    const prefix = '[RENDERER]';
    const meta = { line, sourceId: sourceId ? sourceId.split('/').pop() : '' };

    const normalizedMessage =
      typeof message === 'string'
        ? message.trim().replace(/^['"](.*)['"]$/, '$1')
        : String(message);

    const truncatedMessage =
      normalizedMessage.length > 8192
        ? normalizedMessage.substring(0, 8192) + '...[truncated]'
        : normalizedMessage;

    // Pino's browser logger calls console.* with structured objects which serialise
    // as "[object Object]" through Electron's console-message event. Chromium may
    // wrap the literal value in quotes, so normalize first and drop both forms.
    // Structured log payloads are already forwarded via window.electronAPI.system.log.
    if (truncatedMessage === '[object Object]') {
      // Prevent Chromium from echoing noisy raw console payloads to the terminal.
      if (typeof event?.preventDefault === 'function') {
        event.preventDefault();
      }
      return;
    }

    if (level >= 3) {
      logger.error(`${prefix} ${truncatedMessage}`, meta);
    } else if (level >= 2) {
      logger.warn(`${prefix} ${truncatedMessage}`, meta);
    } else {
      logger.info(`${prefix} ${truncatedMessage}`, meta);
    }
  });

  // Log when the page finishes loading for startup diagnosis
  win.webContents.on('did-finish-load', () => {
    logger.info('[WINDOW] did-finish-load fired');
    // Check splash status after page load to detect stuck splash
    win.webContents
      .executeJavaScript('document.getElementById("splash-status")?.textContent || "NO_SPLASH"')
      .then(
        /** @returns {any} */ (/** @type {any} */ status) => {
          logger.info('[WINDOW] Splash status after load: ' + status);
          return undefined;
        }
      )
      .catch((e) => {
        logger.debug('[WINDOW] Failed to get splash status', { error: e.message });
      });

    // Delayed health check: verify the app fully rendered. Splash fade can
    // outlast the first probe on slow cold starts (GPU model load, dev HMR),
    // so we re-check before logging an error.
    const POST_LOAD_CHECK_SCRIPT = `JSON.stringify({
        splashPresent: !!document.getElementById('initial-loading'),
        rootChildren: document.getElementById('root')?.children?.length ?? 0,
        hasElectronAPI: !!window.electronAPI,
        bootErrors: (window.__STRATOSORT_BOOT_ERRORS || []).length
      })`;

    const runPostLoadCheck = (/** @type {any} */ attempt, /** @type {any} */ maxAttempts) => {
      if (win.isDestroyed()) return;
      win.webContents
        .executeJavaScript(POST_LOAD_CHECK_SCRIPT)
        .then(
          /** @returns {any} */ (/** @type {any} */ json) => {
            const state = JSON.parse(json);
            const mounted = state.rootChildren > 0 && state.hasElectronAPI;
            const failed = state.bootErrors > 0 || !mounted;

            if (failed) {
              logger.error('[WINDOW] Post-load check: app may not have rendered', {
                ...state,
                attempt,
                maxAttempts
              });
              return undefined;
            }

            if (state.splashPresent && attempt < maxAttempts) {
              logger.debug('[WINDOW] Post-load check: splash still visible, retrying', {
                ...state,
                attempt,
                maxAttempts
              });
              _healthCheckTimerId = setTimeout(
                () => runPostLoadCheck(attempt + 1, maxAttempts),
                5000
              );
              return undefined;
            }

            if (state.splashPresent) {
              logger.warn('[WINDOW] Post-load check: app mounted but splash still present', state);
            } else {
              logger.info('[WINDOW] Post-load check: app rendered successfully', { attempt });
            }
            return undefined;
          }
        )
        .catch((e) => {
          logger.error('[WINDOW] Post-load check failed', { error: e.message, attempt });
        });
    };

    clearHealthCheckTimer();
    _healthCheckTimerId = setTimeout(() => runPostLoadCheck(1, 3), TIMEOUTS.HEALTH_CHECK);
  });

  // Block navigation attempts within the app (e.g., dropped links or external redirects)
  win.webContents.on('will-navigate', (event, url) => {
    try {
      // Always prevent in-app navigations; open externally only if explicitly allowed elsewhere
      event.preventDefault();
      logger.debug('Blocked navigation attempt', { url });
    } catch (error) {
      logger.debug('Error blocking navigation', { error: error.message });
    }
  });

  // Disallow embedding arbitrary webviews
  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
    logger.warn('Blocked webview attachment attempt');
  });

  // Deny all permission requests by default, but allow clipboard access
  try {
    win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
      if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') {
        callback(true);
        return;
      }
      // Upgraded from debug → warn so the deny is visible in default-level
      // production logs. Without this, a future renderer dependency that
      // requests a new permission type (notifications, geolocation, midi,
      // etc.) gets silently denied and the resulting feature breakage looks
      // like a generic "doesn't work" with no breadcrumb. Capture the URL
      // too so the operator can see WHICH page asked.
      logger.warn('[Security] Denied permission request', {
        permission,
        requestingURL: wc?.getURL?.() || null
      });
      callback(false);
    });
  } catch (error) {
    logger.debug('Failed to set permission handler', { error: error.message });
  }

  try {
    win.webContents.session.setPermissionCheckHandler((_wc, permission) => {
      if (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write') {
        return true;
      }
      return false;
    });
  } catch (error) {
    logger.debug('Failed to set permission check handler', { error: error.message });
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    // SECURITY: Use URL hostname matching instead of startsWith to prevent
    // subdomain bypass (e.g., github.com.evil.com matching github.com)
    const allowedHosts = [
      'github.com',
      'docs.github.com',
      'microsoft.com',
      'docs.microsoft.com',
      'huggingface.co'
    ];
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'mailto:') {
        shell.openExternal(url).catch((e) => {
          logger.error('[WINDOW] Failed to open mailto URL', { url, error: e.message });
        });
        return { action: 'deny' };
      }
      if (parsed.protocol === 'https:' && allowedHosts.some((host) => parsed.hostname === host)) {
        shell.openExternal(url).catch((e) => {
          logger.error('[WINDOW] Failed to open external URL', { url, error: e.message });
        });
      }
    } catch {
      // Invalid URL -- deny silently
    }
    return { action: 'deny' };
  });

  return win;
}

module.exports = createMainWindow;
module.exports.escapeHtml = escapeHtml;
