/**
 * Electron App Helper for E2E Testing
 *
 * Provides utilities to launch, control, and interact with the StratoSort Electron app.
 * Uses Playwright's Electron support via the _electron fixture.
 *
 * Usage:
 *   const { launchApp, closeApp, getMainWindow } = require('./helpers/electronApp');
 *
 *   test('my test', async () => {
 *     const { app, window } = await launchApp();
 *     // ... test code
 *     await closeApp(app);
 *   });
 */

const { _electron: electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

// Configuration
const APP_ROOT = path.resolve(__dirname, '../../..');
// Launch the webpack-bundled main (what production actually ships) rather
// than src/main/simple-main.js. Running the unbundled source skipped every
// webpack-specific failure mode (externals, __non_webpack_require__, worker
// chunk resolution) — E2E green told us nothing about the shipped bundle.
// globalSetup.js rebuilds dist/ when sources are newer.
const MAIN_ENTRY = path.join(APP_ROOT, 'dist/main.js');
// Use relative path from APP_ROOT for proper app.getAppPath() resolution
const MAIN_ENTRY_RELATIVE = './dist/main.js';
const ELECTRON_PATH = require('electron');

// Default launch options
const DEFAULT_LAUNCH_OPTIONS = {
  // Use development environment for testing
  env: {
    ...process.env,
    // Avoid passing --inspect to the Electron child (can break Playwright's launch handshake)
    NODE_OPTIONS: String(process.env.NODE_OPTIONS || '')
      .replace(/--inspect(-brk)?(=\d+)?/g, '')
      .trim(),
    NODE_ENV: 'development',
    // Enable startup behavior optimized for deterministic E2E launch timing
    STRATOSORT_E2E: '1',
    STRATOSORT_FORCE_SOFTWARE_GPU: '1',
    // Disable hardware acceleration for more stable CI testing
    ELECTRON_DISABLE_GPU: '1',
    // Enable logging for debugging
    ELECTRON_ENABLE_LOGGING: '1',
    // Force launch to bypass single instance lock during testing
    STRATOSORT_FORCE_LAUNCH: '1'
  },
  // Timeout for app launch (startup can be slower on CI runners)
  timeout: 60000
};

const LAUNCH_MAX_ATTEMPTS = 3;

function createIsolatedE2eUserDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stratosort-e2e-userdata-'));
}

function cleanupE2eUserDataDir(userDataPath) {
  if (!userDataPath || typeof userDataPath !== 'string') return;
  try {
    fs.rmSync(userDataPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  } catch {
    // Non-fatal — temp dir may still be locked briefly after app.close().
  }
}

const EVIDENCE_TAIL_BYTES = 8 * 1024;

function tailFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return null;
    const fd = fs.openSync(filePath, 'r');
    try {
      const start = Math.max(0, stat.size - EVIDENCE_TAIL_BYTES);
      const buf = Buffer.alloc(Math.min(stat.size, EVIDENCE_TAIL_BYTES));
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Surface whatever a hung/dead app left behind in its isolated userData dir
 * (Chromium's ELECTRON_LOG_FILE output + the app's JSONL startup logs), then
 * preserve those files under test-results/ so the CI artifact upload captures
 * them. stdio capture alone is unreliable here: Playwright's own listeners put
 * the child's streams in flowing mode at spawn, so anything the app printed
 * before electron.launch() resolved is gone by the time we can attach.
 */
function dumpLaunchFailureEvidence(userDataPath, attempt) {
  if (!userDataPath) return;
  const candidates = [path.join(userDataPath, 'chromium.log')];
  try {
    const logsDir = path.join(userDataPath, 'logs');
    for (const name of fs.readdirSync(logsDir)) {
      candidates.push(path.join(logsDir, name));
    }
  } catch {
    console.warn(
      '[E2E] No app logs/ dir in userData — startup hung before file logging was configured'
    );
  }
  const existing = candidates.filter((file) => fs.existsSync(file));
  for (const file of existing) {
    const tail = tailFile(file);
    if (tail && tail.trim()) {
      console.warn(`[E2E] ---- tail of ${path.basename(file)} ----\n${tail.trim()}`);
    }
  }
  if (existing.length === 0) return;
  try {
    const dest = path.join(
      APP_ROOT,
      'test-results',
      `launch-failure-attempt${attempt}-${Date.now()}`
    );
    fs.mkdirSync(dest, { recursive: true });
    for (const file of existing) {
      fs.copyFileSync(file, path.join(dest, path.basename(file)));
    }
    console.warn(`[E2E] Preserved launch-failure logs at ${dest}`);
  } catch (copyError) {
    console.warn(`[E2E] Could not preserve launch-failure logs: ${copyError.message}`);
  }
}

/**
 * Best-effort cleanup of StratoSort Electron child processes between E2E tests.
 */
function killOrphanStratoSortElectronProcesses() {
  try {
    if (process.platform === 'win32') {
      // Match both the bundled (dist\main.js) and legacy (simple-main) entry
      // args, scoped to electron.exe spawned from THIS repo's node_modules so
      // unrelated Electron apps are never touched.
      const repoMarker = APP_ROOT.replace(/'/g, "''");
      execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = \'electron.exe\'\\" | ' +
          `Where-Object { $_.CommandLine -like '*${repoMarker}*' -and ($_.CommandLine -like '*dist*main.js*' -or $_.CommandLine -like '*simple-main*') } | ` +
          'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"',
        { stdio: 'ignore', timeout: 8000 }
      );
    } else {
      execSync(
        `pkill -f "electron.*(simple-main|${APP_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*dist/main\\.js)" || true`,
        {
          stdio: 'ignore',
          timeout: 5000
        }
      );
    }
  } catch {
    // Non-fatal — process may already be gone.
  }
}

/**
 * Launch the StratoSort Electron application
 *
 * @param {Object} options - Additional launch options
 * @param {Object} options.env - Additional environment variables
 * @param {number} options.timeout - Launch timeout in milliseconds
 * @param {boolean} options.headed - Run with visible window (default: false)
 * @param {{ dir: string, size?: { width: number, height: number } }} [options.recordVideo]
 *   Playwright video capture for the Electron window (used by the product tour).
 * @returns {Promise<{app: ElectronApplication, window: Page}>}
 */
async function launchApp(options = {}, attempt = 1) {
  const e2eUserData = options.userDataDir || createIsolatedE2eUserDataDir();
  const mergedOptions = {
    ...DEFAULT_LAUNCH_OPTIONS,
    ...options,
    env: {
      ...DEFAULT_LAUNCH_OPTIONS.env,
      STRATOSORT_E2E_USER_DATA: e2eUserData,
      // With ELECTRON_ENABLE_LOGGING set, route Chromium's internal logging to
      // a file in the isolated userData dir — survives the stdio attach race
      // and is dumped by dumpLaunchFailureEvidence() on launch failure.
      ELECTRON_LOG_FILE: path.join(e2eUserData, 'chromium.log'),
      ...(options.env || {})
    }
  };

  // Playwright's `npx playwright test --headed` does not pass { headed: true } into this helper;
  // detect CLI --headed so Electron gets a real window when using test:e2e:headed.
  // Video recording does not require a visible window — Playwright captures the
  // page compositor. The product tour records headless so it does not steal the
  // user's only display; pass headed: true when you want to watch it live.
  const headed =
    Boolean(options.headed) || (Array.isArray(process.argv) && process.argv.includes('--headed'));

  // Add args for CI / headless mode if not headed
  // Use relative path from APP_ROOT so app.getAppPath() returns correct root
  // On Linux CI with xvfb, omit --headless so Electron creates a real window
  // (xvfb provides a virtual display; --headless can prevent window creation)
  const args = [MAIN_ENTRY_RELATIVE];
  if (!headed) {
    args.push('--disable-gpu', '--no-sandbox');
    if (process.platform !== 'linux' || !process.env.CI) {
      args.push('--headless');
    }
  }

  console.log('[E2E] Launching Electron app...');
  console.log('[E2E] Main entry:', MAIN_ENTRY_RELATIVE);
  console.log('[E2E] Working directory:', APP_ROOT);

  // Buffer the app's own stdout/stderr so launch failures are diagnosable.
  // Without this, a main-process hang (e.g. window never created on a CI
  // runner) times out firstWindow() with zero evidence of where startup
  // stopped — ELECTRON_ENABLE_LOGGING=1 output otherwise goes nowhere.
  const childOutput = [];
  const MAX_CAPTURED_CHUNKS = 400;
  const captureStream = (stream, label) => {
    if (!stream || typeof stream.on !== 'function') return;
    stream.on('data', (chunk) => {
      childOutput.push(`[app:${label}] ${String(chunk).trimEnd()}`);
      if (childOutput.length > MAX_CAPTURED_CHUNKS) childOutput.shift();
    });
  };

  let app;
  try {
    app = await electron.launch({
      executablePath: ELECTRON_PATH,
      args,
      cwd: APP_ROOT, // Set working directory so app.getAppPath() returns correct path
      env: mergedOptions.env,
      timeout: mergedOptions.timeout,
      ...(options.recordVideo ? { recordVideo: options.recordVideo } : {})
    });
    app.__e2eUserData = e2eUserData;
    // Ownership rule: closeApp only deletes userData dirs this helper created.
    // Specs that pass options.userDataDir (e.g. persistence-across-restart
    // tests relaunching into the same profile) manage their dir's lifetime.
    app.__e2eUserDataOwned = !options.userDataDir;
    const child = typeof app.process === 'function' ? app.process() : null;
    if (child) {
      captureStream(child.stdout, 'stdout');
      captureStream(child.stderr, 'stderr');
    }

    // Wait for the first BrowserWindow to open
    console.log('[E2E] Waiting for main window...');
    const window = await app.firstWindow();

    // Wait for the window to be ready (DOM loaded)
    await window.waitForLoadState('domcontentloaded');
    console.log('[E2E] Main window ready');

    // Optional: Wait for the app to be fully initialized
    // This waits for the React app to mount
    try {
      await window.waitForSelector('.app-surface', { timeout: 15000 });
      console.log('[E2E] App UI rendered');
    } catch (error) {
      console.warn('[E2E] Warning: App UI may not be fully rendered:', error.message);
    }

    return { app, window, e2eUserData };
  } catch (error) {
    if (childOutput.length > 0) {
      console.warn(
        `[E2E] App output before launch failure:\n${childOutput.slice(-120).join('\n')}`
      );
    }
    // Probe the main process over the still-open CDP connection. One datapoint,
    // three diagnoses: ready=false → Chromium init never finished; ready=true
    // with 0 windows → startup chain hung before createWindow(); windows > 0 →
    // the window exists and Playwright missed the event.
    if (app) {
      try {
        const state = await Promise.race([
          app.evaluate(({ app: electronApp, BrowserWindow }) => ({
            isReady: electronApp.isReady(),
            windowCount: BrowserWindow.getAllWindows().length
          })),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('main-process probe timed out after 5s')), 5000)
          )
        ]);
        console.warn(`[E2E] Main process state at launch failure: ${JSON.stringify(state)}`);
      } catch (probeError) {
        console.warn(`[E2E] Main process probe failed: ${probeError.message}`);
      }
    }
    // The app may be alive with no window (firstWindow timeout) — close it,
    // otherwise every retry leaks a running Electron main process. close()
    // waits for process exit, which a wedged main process never delivers, so
    // race it against a hard kill.
    if (app) {
      await Promise.race([
        app.close().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 10000))
      ]);
      try {
        const child = typeof app.process === 'function' ? app.process() : null;
        if (child && !child.killed) child.kill();
      } catch {
        // already gone
      }
    }
    dumpLaunchFailureEvidence(e2eUserData, attempt);
    if (!options.userDataDir) {
      cleanupE2eUserDataDir(e2eUserData);
    }
    if (attempt < LAUNCH_MAX_ATTEMPTS) {
      console.warn(
        `[E2E] Launch failed (attempt ${attempt}/${LAUNCH_MAX_ATTEMPTS}): ${error.message}`
      );
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      return launchApp(options, attempt + 1);
    }
    throw error;
  }
}

/**
 * Focus the main renderer surface before shortcuts like Ctrl+K / Cmd+K.
 * Avoids FloatingSearchContext skipping the shortcut when focus is editable.
 *
 * @param {import('@playwright/test').Page} window
 */
async function focusAppForKeyboardShortcuts(window) {
  if (!window || (typeof window.isClosed === 'function' && window.isClosed())) {
    return;
  }
  await window.bringToFront().catch(() => {});
  await window
    .locator('.app-surface')
    .click({ position: { x: 8, y: 8 } })
    .catch(() => {});
}

/**
 * Like page.waitForTimeout but no-ops when the page/context is already closed
 * (avoids failing hooks or trailing waits during Electron teardown races).
 *
 * @param {import('@playwright/test').Page} window
 * @param {number} ms
 */
async function safeWaitForTimeout(window, ms) {
  if (!window || (typeof window.isClosed === 'function' && window.isClosed())) return;
  try {
    await window.waitForTimeout(ms);
  } catch {
    // ignore
  }
}

/**
 * Close the Electron application gracefully
 *
 * @param {ElectronApplication} app - The Electron app instance
 */
async function closeApp(app, e2eUserData) {
  const userDataPath =
    e2eUserData || (app && typeof app.__e2eUserData === 'string' ? app.__e2eUserData : null);
  // An explicitly passed dir is an explicit cleanup request; otherwise respect
  // the ownership flag so spec-provided userDataDir survives an app restart.
  const shouldCleanupUserData = Boolean(e2eUserData) || !app || app.__e2eUserDataOwned !== false;

  if (!app) {
    console.warn('[E2E] No app to close');
    cleanupE2eUserDataDir(userDataPath);
    return;
  }

  if (userDataPath) {
    app.__e2eUserData = userDataPath;
  }

  console.log('[E2E] Closing Electron app...');
  try {
    // Brief settle so in-flight renderer work can finish before process exit (reduces hook races).
    await new Promise((resolve) => setTimeout(resolve, 250));
    await app.close();
    console.log('[E2E] App closed successfully');
  } catch (error) {
    console.error('[E2E] Error closing app:', error.message);
    // Force quit if graceful close fails
    try {
      const windows = await app.windows();
      for (const window of windows) {
        await window.close();
      }
    } catch (e) {
      // Ignore errors during forced close
    }
  } finally {
    if (shouldCleanupUserData) {
      cleanupE2eUserDataDir(userDataPath);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

/**
 * Get the main BrowserWindow
 *
 * @param {ElectronApplication} app - The Electron app instance
 * @returns {Promise<Page>}
 */
async function getMainWindow(app) {
  const windows = await app.windows();
  if (windows.length === 0) {
    throw new Error('No windows found');
  }
  return windows[0];
}

/**
 * Wait for the app to be ready for interaction
 *
 * @param {Page} window - The Playwright page object
 * @param {{ timeout?: number, dismissModals?: boolean, dismissModelWizard?: boolean }} [options]
 *   timeout - maximum wait time in milliseconds (default 30000).
 *   dismissModals - close any open modal before returning (default true).
 *   Pass false when the modal is what the test is about: the first-run model
 *   wizard opens with no delay when the background setup has already fetched
 *   the embedding model (under 2 s on a fast runner), so it can be open by now.
 *   dismissModelWizard - also wait for the first-run model wizard, which opens
 *   ~2 s AFTER ready in a model-less profile, and skip it (default: the value
 *   of dismissModals). Without this the single dismissModals() pass above can
 *   run before the wizard mounts, and its aria-modal overlay then swallows the
 *   test's later clicks. Costs up to 7 s when no wizard appears.
 */
async function waitForAppReady(
  window,
  { timeout = 30000, dismissModals: dismiss = true, dismissModelWizard = dismiss } = {}
) {
  console.log('[E2E] Waiting for app to be ready...');

  // Wait for the navigation bar to be visible (indicates app is loaded)
  await window.waitForSelector('nav[aria-label="Phase navigation"]', {
    state: 'visible',
    timeout
  });

  // Phase roots live inside lazy-loaded phase components; they may appear shortly after the nav.
  // Do not block here on phase-*-content — NavigationPage.goToPhase waits for that when navigating.
  await window
    .locator('[data-testid="phase-nav"]')
    .first()
    .waitFor({
      state: 'visible',
      timeout: Math.min(timeout, 15000)
    });

  // Wait for any loading spinners to disappear
  const spinners = window.locator('.animate-spin');
  const spinnerCount = await spinners.count();
  if (spinnerCount > 0) {
    await spinners
      .first()
      .waitFor({ state: 'hidden', timeout: 10000 })
      .catch(() => {
        // Ignore timeout - spinner may have already disappeared
      });
  }

  // Dismiss any modal dialogs that might be blocking (e.g., first-launch setup dialogs)
  if (dismiss) await dismissModals(window);
  if (dismissModelWizard) await dismissModelSetupWizard(window);

  console.log('[E2E] App is ready');
}

/**
 * Dismiss any modal dialogs that might be blocking the UI
 * This handles first-launch setup dialogs and other modals that appear on startup
 *
 * @param {Page} window - The Playwright page object
 */
async function dismissModals(window) {
  // Check for modal overlay
  const modalOverlay = window.locator('[role="presentation"].fixed.inset-0, .z-modal');
  const hasModal = await modalOverlay
    .first()
    .isVisible()
    .catch(() => false);

  if (hasModal) {
    console.log('[E2E] Modal detected, attempting to dismiss...');

    // Try clicking "Skip" or "Later" or "Close" buttons
    const dismissButtons = [
      'button:has-text("Skip")',
      'button:has-text("Later")',
      'button:has-text("Close")',
      'button:has-text("Not Now")',
      'button:has-text("Dismiss")',
      'button[aria-label="Close"]',
      '[role="dialog"] button:has-text("×")',
      '[role="dialog"] button:has-text("X")'
    ];

    for (const selector of dismissButtons) {
      const button = window.locator(selector).first();
      const isVisible = await button.isVisible().catch(() => false);
      if (isVisible) {
        console.log(`[E2E] Clicking dismiss button: ${selector}`);
        await button.click().catch(() => {});
        await safeWaitForTimeout(window, 300);
        break;
      }
    }

    // If no dismiss button found, try pressing Escape
    const stillHasModal = await modalOverlay
      .first()
      .isVisible()
      .catch(() => false);
    if (stillHasModal) {
      console.log('[E2E] Pressing Escape to dismiss modal');
      await window.keyboard.press('Escape');
      await safeWaitForTimeout(window, 300);
    }

    // Wait for modal to close
    await modalOverlay
      .first()
      .waitFor({ state: 'hidden', timeout: 5000 })
      .catch(() => {
        console.log('[E2E] Modal may still be visible');
      });
  }
}

/** Windows whose first-run model wizard was skipped (see dismissModelSetupWizard). */
const modelWizardSkippedWindows = new WeakSet();

/**
 * Dismiss the first-run "Set up on-device AI" model wizard if/when it appears.
 *
 * WelcomePhase auto-opens this wizard ~2s AFTER the app becomes ready: its
 * model-check effect waits RETRY_DELAY_MS (1800ms) when no models are present
 * (the usual case in an isolated E2E profile), re-checks getModels(), then
 * opens the wizard Modal. When the first-run background download has already
 * landed the small embedding model, it opens at once instead and
 * waitForAppReady's dismissModals() pass closes it. Otherwise that single early
 * pass runs before the overlay mounts, so specs that interact with the chrome
 * after ~2s (open Settings, press the search shortcut, click a tab) get their
 * pointer events swallowed by the wizard's aria-modal overlay.
 *
 * This helper waits a bounded time for the late overlay, clicks "Continue with
 * limited AI" (the wizard's only skip affordance, present in the select and
 * downloading steps), and no-ops if the wizard never appears. The skip latches
 * modelCheckLockedRef in WelcomePhase, so the wizard will not re-open this
 * session.
 *
 * @param {Page} window - The Playwright page object
 * @param {{ timeout?: number }} [options] - timeout = how long to wait for the
 *   overlay to appear before treating its absence as "no wizard" (default 7000;
 *   comfortably covers the 1800ms retry + getModels() on a slow runner).
 * @returns {Promise<boolean>} true if a wizard was dismissed, false otherwise
 */
async function dismissModelSetupWizard(window, { timeout = 7000 } = {}) {
  if (!window || (typeof window.isClosed === 'function' && window.isClosed())) return false;
  // Skipping latches the wizard closed for this renderer session, so a later
  // call on the same window (waitForAppReady already ran this) returns at once
  // instead of waiting `timeout` for a wizard that cannot reopen.
  if (modelWizardSkippedWindows.has(window)) return false;

  // Identify the wizard by the hosting Modal's title (a stable, human-readable
  // string) rather than the Modal's generated aria id.
  const wizardDialog = window.locator('[role="dialog"]').filter({ hasText: 'Set up on-device AI' });

  const appeared = await wizardDialog
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return false;

  console.log('[E2E] Model setup wizard detected, skipping with "Continue with limited AI"');

  const skipButton = wizardDialog.getByRole('button', { name: 'Continue with limited AI' });
  const skipVisible = await skipButton
    .first()
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);

  if (skipVisible) {
    await skipButton
      .first()
      .click()
      .catch(() => {});
  } else {
    // Fallback: Escape closes the Modal in every step except 'downloading'
    // (closeOnEsc={wizardStep !== 'downloading'}). The wizard lands on 'select'
    // within ~1s in E2E, so this path is rarely taken.
    await window.keyboard.press('Escape').catch(() => {});
  }

  const closed = await wizardDialog
    .first()
    .waitFor({ state: 'hidden', timeout: 5000 })
    .then(() => true)
    .catch(() => {
      console.log('[E2E] Model setup wizard may still be visible after dismiss attempt');
      return false;
    });
  if (closed) modelWizardSkippedWindows.add(window);

  return true;
}

/**
 * Dismiss the first-run GraphTour overlay if/when it appears.
 *
 * GraphTour mounts a full-viewport scrim (role="presentation",
 * .fixed.inset-0.z-50) ~500ms AFTER the graph/Relate tab opens (GraphTour.jsx
 * setTimeout). Under load that delay can exceed a single fixed click timeout,
 * and once visible the scrim intercepts every click — including the next tab
 * the caller wants to reach, which then times out. Wait (bounded) for the
 * "Close tour" control, click it with retries, and confirm the overlay is gone.
 * The tour's "Don't show again" box is checked by default, so dismissal latches
 * in Redux and the tour won't re-open this session. No-ops if it never appears.
 *
 * @param {Page} window - The Playwright page object
 * @param {{ timeout?: number }} [options] - timeout = how long to wait for the
 *   overlay before treating its absence as "no tour" (default 6000).
 * @returns {Promise<boolean>} true if a tour was dismissed, false otherwise
 */
async function dismissGraphTour(window, { timeout = 6000 } = {}) {
  if (!window || (typeof window.isClosed === 'function' && window.isClosed())) return false;

  const closeButton = window.getByRole('button', { name: 'Close tour' });
  const appeared = await closeButton
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return false;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await closeButton
      .first()
      .click({ timeout: 2000 })
      .catch(() => {});
    const gone = await closeButton
      .first()
      .waitFor({ state: 'hidden', timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    if (gone) return true;
  }
  return false;
}

/**
 * Take a screenshot with a descriptive name
 *
 * @param {Page} window - The Playwright page object
 * @param {string} name - Screenshot name
 * @param {string} testName - Test name for organization
 * @returns {Promise<string>} Path to screenshot
 */
async function takeScreenshot(window, name, testName = 'unknown') {
  const screenshotDir = path.join(APP_ROOT, 'test-results', 'e2e', 'screenshots');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${testName}_${name}_${timestamp}.png`;
  const filepath = path.join(screenshotDir, filename);

  await window.screenshot({ path: filepath, fullPage: true });
  console.log(`[E2E] Screenshot saved: ${filepath}`);
  return filepath;
}

/**
 * Execute JavaScript in the Electron main process
 *
 * @param {ElectronApplication} app - The Electron app instance
 * @param {Function} fn - Function to execute in main process
 * @param {any} arg - Argument to pass to the function
 * @returns {Promise<any>}
 */
async function evaluateInMain(app, fn, arg) {
  return app.evaluate(fn, arg);
}

/**
 * Get app info from the main process
 *
 * @param {ElectronApplication} app - The Electron app instance
 * @returns {Promise<{name: string, version: string, paths: Object}>}
 */
async function getAppInfo(app) {
  return app.evaluate(async ({ app }) => {
    return {
      name: app.getName(),
      version: app.getVersion(),
      paths: {
        userData: app.getPath('userData'),
        documents: app.getPath('documents'),
        temp: app.getPath('temp')
      }
    };
  });
}

/**
 * Check if the app window is maximized
 *
 * @param {ElectronApplication} app - The Electron app instance
 * @returns {Promise<boolean>}
 */
async function isWindowMaximized(app) {
  return app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return win ? win.isMaximized() : false;
  });
}

/**
 * Check if the app window is visible
 *
 * @param {ElectronApplication} app - The Electron app instance
 * @returns {Promise<boolean>}
 */
async function isWindowVisible(app) {
  return app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return win ? win.isVisible() : false;
  });
}

/**
 * MinimizableGuideCard defaults to collapsed; children (e.g. Naming Strategy) are not mounted until expanded.
 */
async function expandDiscoverGuideIfCollapsed(window) {
  if (!window || (typeof window.isClosed === 'function' && window.isClosed())) return;
  const expand = window.getByRole('button', { name: 'Expand discover guide' });
  if (await expand.isVisible().catch(() => false)) {
    await expand.click();
    await safeWaitForTimeout(window, 400);
  }
}

/**
 * Close Knowledge OS when it overlaps phase navigation or sidebar controls.
 */
async function ensureKnowledgeOsClosed(window) {
  if (!window || (typeof window.isClosed === 'function' && window.isClosed())) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const closeBtn = window.getByRole('button', { name: 'Close Knowledge OS' });
    if (!(await closeBtn.isVisible().catch(() => false))) {
      return;
    }
    await closeBtn.click({ force: true }).catch(() => {});
    await safeWaitForTimeout(window, 250);
  }
  await window.keyboard.press('Escape').catch(() => {});
  await safeWaitForTimeout(window, 200);
}

module.exports = {
  launchApp,
  closeApp,
  createIsolatedE2eUserDataDir,
  cleanupE2eUserDataDir,
  killOrphanStratoSortElectronProcesses,
  focusAppForKeyboardShortcuts,
  safeWaitForTimeout,
  getMainWindow,
  waitForAppReady,
  dismissModals,
  dismissModelSetupWizard,
  dismissGraphTour,
  ensureKnowledgeOsClosed,
  expandDiscoverGuideIfCollapsed,
  takeScreenshot,
  evaluateInMain,
  getAppInfo,
  isWindowMaximized,
  isWindowVisible,
  APP_ROOT,
  MAIN_ENTRY
};
