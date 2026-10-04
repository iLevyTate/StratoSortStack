/**
 * Cloud AI Consent Dialog — theme correctness E2E (U-003)
 *
 * Guards the fix for the consent dialog rendering with stock-Tailwind
 * light/dark conventions this app does not use. The app themes via
 * `data-theme` (primary/dark/light) with an *inverted* gray scale in dark
 * palettes (system-gray-900 is near-white), while `dark:` utilities compile
 * to `@media (prefers-color-scheme: dark)` — the OS scheme. Result before
 * the fix: in the default `primary` theme on a light-scheme machine the
 * dialog was a forced white panel with near-white title text (~1.2:1).
 *
 * Deterministic oracle (no screenshot timing races):
 *   - panel computed background === a probe painted with var(--surface-raised)
 *     (the canonical Modal panel surface, Modal.jsx)
 *   - title color === var(--color-system-gray-900), body copy ===
 *     var(--color-system-gray-700) (theme-scoped ink tokens)
 *   - WCAG contrast (title|body vs panel) >= 4.5
 *   - all of the above hold under BOTH emulated OS color schemes, proving no
 *     prefers-color-scheme dependence remains.
 *
 * Run: npm run test:e2e -- --grep "Cloud AI consent dialog"
 */

const { test, expect } = require('@playwright/test');
const {
  launchApp,
  closeApp,
  waitForAppReady,
  dismissModelSetupWizard,
  createIsolatedE2eUserDataDir,
  cleanupE2eUserDataDir
} = require('./helpers/electronApp');
const { NavigationPage } = require('./helpers/pageObjects');

/**
 * Opens Settings and clicks the Anthropic default-provider radio. On a fresh
 * profile (no recorded consent) this raises the CloudAIConsentModal.
 * Returns false when the settings surface is not reachable in this build.
 */
async function openConsentModal(page) {
  const nav = new NavigationPage(page);
  const opened = await nav.openSettings();
  if (!opened) return false;

  await expect(page.locator('h2:has-text("Settings")').first()).toBeVisible({ timeout: 10000 });

  const expandAll = page.locator('button[aria-label="Expand all settings sections"]').first();
  if (await expandAll.isVisible().catch(() => false)) {
    await expandAll.click();
  }

  const radio = page.locator('input[name="ai-default-provider"][value="anthropic"]').first();
  if ((await radio.count()) === 0) return false;
  await radio.scrollIntoViewIfNeeded().catch(() => {});
  if (!(await radio.isVisible().catch(() => false))) return false;
  await expect(radio).toBeEnabled({ timeout: 10000 });
  await radio.click();

  await expect(page.getByTestId('cloud-ai-consent-modal')).toBeVisible({ timeout: 10000 });
  return true;
}

/**
 * Reads computed colors off the live consent dialog plus probe elements
 * painted with the expected theme tokens, and WCAG contrast ratios.
 */
async function readConsentStyles(page) {
  return page.evaluate(() => {
    const modal = document.querySelector('[data-testid="cloud-ai-consent-modal"]');
    const title = document.getElementById('cloud-ai-consent-title');
    if (!modal || !title) return { error: 'consent modal structure not found' };
    const panel = title.parentElement;
    const body = title.nextElementSibling;
    if (!panel || !body) return { error: 'consent panel/body not found' };

    const resolveToken = (cssVar) => {
      const probe = document.createElement('div');
      probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;background-color:var(${cssVar});color:var(${cssVar})`;
      document.body.appendChild(probe);
      const cs = getComputedStyle(probe);
      const out = { bg: cs.backgroundColor, color: cs.color };
      probe.remove();
      return out;
    };

    // Computed colors surface as either legacy rgb()/rgba() or, when they
    // come from color-mix() tokens like --surface-raised, as color(srgb r g b).
    const parseRgb = (value) => {
      const s = String(value);
      let m = s.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
      if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
      m = s.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
      if (m) return [Number(m[1]) * 255, Number(m[2]) * 255, Number(m[3]) * 255];
      return null;
    };
    const luminance = ([r, g, b]) => {
      const ch = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const contrast = (fg, bg) => {
      const a = parseRgb(fg);
      const b = parseRgb(bg);
      if (!a || !b) return 0;
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };

    const panelBg = getComputedStyle(panel).backgroundColor;
    const titleColor = getComputedStyle(title).color;
    const bodyColor = getComputedStyle(body).color;

    return {
      theme: document.documentElement.getAttribute('data-theme'),
      panelBg,
      titleColor,
      bodyColor,
      surfaceRaised: resolveToken('--surface-raised').bg,
      inkTitle: resolveToken('--color-system-gray-900').color,
      inkBody: resolveToken('--color-system-gray-700').color,
      contrastTitle: contrast(titleColor, panelBg),
      contrastBody: contrast(bodyColor, panelBg)
    };
  });
}

test.describe('Cloud AI consent dialog — theme correctness', () => {
  test('renders on theme tokens with readable text under both OS color schemes', async () => {
    const userDataDir = createIsolatedE2eUserDataDir();
    const { app, window } = await launchApp({ userDataDir });
    try {
      await waitForAppReady(window);
      await dismissModelSetupWizard(window).catch(() => {});

      const opened = await openConsentModal(window);
      if (!opened) {
        test.skip(true, 'AI provider settings not reachable in this build');
        return;
      }

      // Visual evidence artifact (assertions below are the oracle, not this).
      await window
        .screenshot({ path: test.info().outputPath('consent-dialog.png') })
        .catch(() => {});

      // Both emulated OS schemes must yield identical, token-driven colors —
      // any dependence on prefers-color-scheme is itself the bug.
      const schemes = ['light', 'dark'];
      const reports = {};
      for (const colorScheme of schemes) {
        await window.emulateMedia({ colorScheme });
        const report = await readConsentStyles(window);
        expect(report.error).toBeUndefined();
        reports[colorScheme] = report;

        expect(report.theme, 'default profile should be primary theme').toBe('primary');
        expect(
          report.panelBg,
          `[${colorScheme}] panel must use the canonical modal surface (--surface-raised)`
        ).toBe(report.surfaceRaised);
        expect(
          report.titleColor,
          `[${colorScheme}] title must use the theme ink token (--color-system-gray-900)`
        ).toBe(report.inkTitle);
        expect(
          report.bodyColor,
          `[${colorScheme}] body copy must use the theme ink token (--color-system-gray-700)`
        ).toBe(report.inkBody);
        expect(
          report.contrastTitle,
          `[${colorScheme}] title contrast ${report.contrastTitle.toFixed(2)}:1 must meet WCAG AA`
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          report.contrastBody,
          `[${colorScheme}] body contrast ${report.contrastBody.toFixed(2)}:1 must meet WCAG AA`
        ).toBeGreaterThanOrEqual(4.5);
      }

      // Scheme-independence: identical rendered colors under light and dark OS.
      expect(reports.light.panelBg).toBe(reports.dark.panelBg);
      expect(reports.light.titleColor).toBe(reports.dark.titleColor);
      expect(reports.light.bodyColor).toBe(reports.dark.bodyColor);

      // Leave routing untouched: decline closes the dialog without consent.
      await window.getByRole('button', { name: 'Keep local' }).click();
      await expect(window.getByTestId('cloud-ai-consent-modal')).toBeHidden({ timeout: 5000 });
    } finally {
      await closeApp(app);
      cleanupE2eUserDataDir(userDataDir);
    }
  });
});
