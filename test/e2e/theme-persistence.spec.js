/**
 * Theme Persistence / No-Flash-On-Reopen E2E Tests
 *
 * Guards the fix for the theme-flash bug (U-001): choosing a non-default palette,
 * closing the app, and reopening it must restore that palette from the very first
 * pre-React frame — the splash/reload screen must match the theme instead of
 * flashing the default dark "primary".
 *
 * Deterministic oracle (no screenshot timing races):
 *   - <body data-theme> === saved theme. React (App.js) only sets data-theme on
 *     <html>; the pre-paint inline script in index.html sets BOTH <html> and
 *     <body>. So a correct <body data-theme> after reopen can ONLY have come from
 *     the pre-paint bootstrap — proving it ran with the persisted value.
 *   - <html data-theme> === saved theme (applied).
 *   - --surface-muted resolves to the theme's surface color (what the reload
 *     screen is painted with).
 *   - localStorage['stratosort_theme'] mirror key round-trips (the pre-paint
 *     script's primary input).
 *
 * Run: npm run test:e2e -- --grep "Theme Persistence"
 */

const { test, expect } = require('@playwright/test');
const {
  launchApp,
  closeApp,
  waitForAppReady,
  dismissModelSetupWizard,
  createIsolatedE2eUserDataDir,
  cleanupE2eUserDataDir,
  evaluateInMain
} = require('./helpers/electronApp');
const { NavigationPage } = require('./helpers/pageObjects');

// --surface-muted per theme (source of truth: src/renderer/styles.css). This is
// the color the html/body + splash surface paints with, so it is the "reload
// screen is the right color" oracle.
const EXPECTED_SURFACE = {
  primary: '#0f1820',
  dark: '#0a0c0e',
  light: '#eef2f6'
};

const THEME_LABEL = { primary: 'Primary', dark: 'Dark', light: 'Light' };

async function readThemeState(page) {
  return page.evaluate(() => {
    const html = document.documentElement;
    return {
      htmlTheme: html.getAttribute('data-theme'),
      bodyTheme: document.body ? document.body.getAttribute('data-theme') : null,
      surfaceMuted: getComputedStyle(html).getPropertyValue('--surface-muted').trim().toLowerCase(),
      mirrorKey: (() => {
        try {
          return window.localStorage.getItem('stratosort_theme');
        } catch {
          return null;
        }
      })()
    };
  });
}

async function selectTheme(page, theme) {
  const nav = new NavigationPage(page);
  const opened = await nav.openSettings();
  if (!opened) return false;

  await expect(page.locator('h2:has-text("Settings")').first()).toBeVisible({ timeout: 10000 });

  const expandAll = page.locator('button[aria-label="Expand all settings sections"]').first();
  if (await expandAll.isVisible().catch(() => false)) {
    await expandAll.click();
  }

  const themeButton = page
    .getByRole('group', { name: 'App color theme' })
    .getByRole('button', { name: THEME_LABEL[theme] });
  if (!(await themeButton.isVisible().catch(() => false))) {
    return false;
  }
  await themeButton.click();
  // The picker sets aria-pressed on the active option once the dispatch lands.
  await expect(themeButton).toHaveAttribute('aria-pressed', 'true', { timeout: 5000 });

  // Close the panel so nothing intercepts the close/relaunch.
  await page.keyboard.press('Escape').catch(() => {});
  return true;
}

for (const theme of ['dark', 'light']) {
  test.describe(`Theme Persistence — ${theme}`, () => {
    test(`restores "${theme}" from the pre-paint frame after reopen (no flash)`, async () => {
      const userDataDir = createIsolatedE2eUserDataDir();

      // Session 1: pick the theme through the real UI so the app's own
      // persistence (Redux blob + mirror key) writes it.
      const s1 = await launchApp({ userDataDir });
      await waitForAppReady(s1.window);
      await dismissModelSetupWizard(s1.window).catch(() => {});

      const picked = await selectTheme(s1.window, theme);
      if (!picked) {
        await closeApp(s1.app);
        cleanupE2eUserDataDir(userDataDir);
        test.skip(true, 'Appearance theme picker not reachable in this build');
        return;
      }

      // Confirm it applied live before we close.
      await expect
        .poll(async () => (await readThemeState(s1.window)).htmlTheme, { timeout: 5000 })
        .toBe(theme);

      await closeApp(s1.app);

      // Session 2: reopen the same profile. launchApp resolves once the app
      // surface is mounted; by then the pre-paint inline script has already run.
      const s2 = await launchApp({ userDataDir });
      try {
        await waitForAppReady(s2.window);

        const state = await readThemeState(s2.window);

        // Pre-paint proof: only the inline bootstrap sets <body data-theme>.
        expect(state.bodyTheme).toBe(theme);
        expect(state.htmlTheme).toBe(theme);
        // The reload screen is painted with the theme surface, not primary.
        expect(state.surfaceMuted).toBe(EXPECTED_SURFACE[theme]);
        // The mirror key the pre-paint script reads survived the restart.
        expect(state.mirrorKey).toBe(theme);
        // U-002: the NATIVE window surface (pre-HTML frame) was constructed
        // with the persisted theme's background, not the primary hardcode.
        const nativeBackground = await evaluateInMain(
          s2.app,
          ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBackgroundColor?.() ?? null
        );
        expect(String(nativeBackground).toLowerCase()).toBe(EXPECTED_SURFACE[theme]);
      } finally {
        await closeApp(s2.app);
        cleanupE2eUserDataDir(userDataDir);
      }
    });
  });
}

test.describe('Theme Persistence — primary (default)', () => {
  test('default profile paints the primary surface from first frame', async () => {
    const { app, window } = await launchApp();
    try {
      await waitForAppReady(window);
      const state = await readThemeState(window);
      expect(state.htmlTheme).toBe('primary');
      expect(state.bodyTheme).toBe('primary');
      expect(state.surfaceMuted).toBe(EXPECTED_SURFACE.primary);
    } finally {
      await closeApp(app);
    }
  });
});
