/**
 * Accessibility E2E Tests (axe-core, real renderer)
 *
 * Runs axe against the fully-composed app in a real Electron/Chromium renderer,
 * where layout and color exist — so this pass catches what the jsdom unit audits
 * (test/a11y/uiComponents.a11y.test.js) cannot: color-contrast, focus order,
 * landmark composition, and cross-component interactions on real screens.
 *
 * Gate policy (warn -> error ratchet, matching jsx-a11y / promise rules in the
 * repo): CRITICAL and SERIOUS violations FAIL the test (ratcheted 2026-07-02;
 * the audited screens carry zero violations of any impact). MODERATE and below
 * are logged as warnings, except the rules in HARD_FAIL_RULES which fail at
 * any impact.
 *
 * This spec is model-free (no LLM/model downloads) and mirrors the smoke specs,
 * so it is eligible to join the `e2e-smoke` job's explicit spec list in
 * .github/workflows/ci.yml once it has gone green once on CI.
 *
 * Run: npm run test:e2e -- test/e2e/accessibility.spec.js
 */

const { test, expect } = require('@playwright/test');
const { AxeBuilder } = require('@axe-core/playwright');
const {
  launchApp,
  closeApp,
  waitForAppReady,
  dismissModelSetupWizard
} = require('./helpers/electronApp');
const { NavigationPage } = require('./helpers/pageObjects');
const { PHASES } = require('./helpers/testFixtures');
const { pressOpenSearchShortcut } = require('./helpers/e2eShortcuts');

// Impacts that FAIL the test. Ratcheted critical → critical+serious on
// 2026-07-02 when every audited screen (incl. dark/light themes, search modal,
// first-run wizard) measured zero violations of any impact.
const HARD_FAIL_IMPACTS = new Set(['critical', 'serious']);

// Rules that FAIL the test at ANY impact — ratcheted once their last offender
// was fixed so they can never regress (U-008 nav status dot, U-009 tooltip
// clone, U-010 gray-400/500/600 contrast token lift, U-013 discover heading
// hierarchy).
const HARD_FAIL_RULES = new Set([
  'aria-prohibited-attr',
  'aria-tooltip-name',
  'color-contrast',
  'heading-order'
]);

/**
 * Run axe on the current page state and split violations by severity.
 * Logs every violation (so CI output is the backlog), then asserts that none
 * of the hard-fail-impact violations are present.
 */
async function auditCurrentScreen(window, label) {
  // setLegacyMode injects axe directly into the page under test instead of
  // spinning up a second helper page via browserContext.newPage(). Electron's
  // CDP rejects Target.createTarget, so without legacy mode analyze() throws
  // ("context.newPage is not supported") before evaluating any DOM.
  const { violations } = await new AxeBuilder({ page: window }).setLegacyMode(true).analyze();

  const summarize = (v) =>
    `[${v.impact || 'n/a'}] ${v.id} (${v.nodes.length} node${v.nodes.length === 1 ? '' : 's'}): ${v.help}`;

  if (violations.length > 0) {
    console.warn(
      `[a11y][${label}] ${violations.length} axe violation(s):\n  ${violations
        .map(summarize)
        .join('\n  ')}`
    );
    // A11Y_VERBOSE=1 dumps per-node targets + failure data (e.g. the exact
    // fg/bg colors behind a color-contrast hit) for triage.
    if (process.env.A11Y_VERBOSE) {
      for (const v of violations) {
        for (const node of v.nodes.slice(0, 15)) {
          const detail = (node.any || [])
            .concat(node.all || [])
            .map((c) => c.message)
            .join(' | ');
          console.warn(`[a11y][${label}][${v.id}] ${node.target.join(' ')}\n    ${detail}`);
        }
      }
    }
  } else {
    console.log(`[a11y][${label}] no violations`);
  }

  const blocking = violations.filter(
    (v) => HARD_FAIL_IMPACTS.has(v.impact) || HARD_FAIL_RULES.has(v.id)
  );
  expect(
    blocking,
    `[a11y][${label}] blocking (${[...HARD_FAIL_IMPACTS].join('/')} impact or ${[
      ...HARD_FAIL_RULES
    ].join('/')} rule) violations:\n${blocking.map((v) => summarize(v)).join('\n')}`
  ).toEqual([]);
}

test.describe('Accessibility (axe)', () => {
  let app;
  let window;
  let nav;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    // The first-run model wizard auto-opens ~2s after ready; its overlay would
    // block phase navigation and the Settings dialog audited below, and skews
    // the baseline a11y snapshot. Skip it so each screen audits a clean state.
    await dismissModelSetupWizard(window);
    nav = new NavigationPage(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('initial screen has no critical violations', async () => {
    await auditCurrentScreen(window, 'initial');
  });

  test('Setup phase has no critical violations', async () => {
    await nav.goToPhase(PHASES.SETUP);
    await window.waitForTimeout(500);
    await auditCurrentScreen(window, 'setup');
  });

  test('Discover phase has no critical violations', async () => {
    await nav.goToPhase(PHASES.DISCOVER);
    await window.waitForTimeout(500);
    await auditCurrentScreen(window, 'discover');
  });

  test('Settings dialog has no critical violations', async () => {
    await nav.openSettings();
    const dialog = window.locator('[role="dialog"]');
    await expect(dialog.first()).toBeVisible({ timeout: 5000 });
    await window.waitForTimeout(300);
    await auditCurrentScreen(window, 'settings');
  });

  test('Organize phase has no critical violations', async () => {
    // Same convention as organize-phase.spec.js: the Organize tab is disabled
    // until files have been analyzed, which never happens in the model-free
    // isolated profile — skip rather than fail.
    const organizeButton = window.locator('button:has-text("Organize")');
    const isDisabled = await organizeButton.isDisabled().catch(() => true);
    test.skip(isDisabled, 'Organize navigation disabled (no analyzed files in isolated profile)');
    await nav.goToPhase(PHASES.ORGANIZE);
    await window.waitForTimeout(500);
    await auditCurrentScreen(window, 'organize');
  });

  test('Search modal has no critical violations', async () => {
    await pressOpenSearchShortcut(window);
    const searchInput = window
      .locator(
        'input[type="search"], input[placeholder*="Search"], input[placeholder*="Describe"], [role="combobox"][aria-label*="Search"]'
      )
      .first();
    await expect(searchInput).toBeVisible({ timeout: 5000 });
    await window.waitForTimeout(500);
    await auditCurrentScreen(window, 'search-modal');
  });

  // Dark/light palettes were previously unaudited — the four base screens above
  // all run in the default theme, so color-contrast regressions in the other
  // palettes were invisible to this gate.
  for (const theme of ['Dark', 'Light']) {
    test(`initial screen in ${theme} theme has no critical violations`, async () => {
      const opened = await nav.openSettings();
      expect(opened).toBeTruthy();
      const expandAll = window.locator('button[aria-label="Expand all settings sections"]').first();
      if (await expandAll.isVisible().catch(() => false)) {
        await expandAll.click();
      }
      const themeButton = window
        .getByRole('group', { name: 'App color theme' })
        .getByRole('button', { name: theme });
      await expect(themeButton).toBeVisible({ timeout: 5000 });
      await themeButton.click();
      await expect(themeButton).toHaveAttribute('aria-pressed', 'true', { timeout: 5000 });
      await window.keyboard.press('Escape');
      await window.waitForTimeout(400);
      await auditCurrentScreen(window, `initial-${theme.toLowerCase()}`);
    });
  }
});

test.describe('Accessibility (axe) — first-run wizard', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    // Leave modals alone: the wizard is what this test audits, and it can
    // already be open here (see dismissModelSetupWizard in electronApp.js).
    await waitForAppReady(window, { dismissModals: false });
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('Model setup wizard has no critical violations', async () => {
    // The wizard auto-opens on a profile without the text model: at once when
    // the background setup has already fetched the embedding model, else ~2s
    // after app-ready. Audit it instead of dismissing it.
    const wizard = window.getByRole('dialog', { name: /set up on-device ai/i });
    await expect(wizard).toBeVisible({ timeout: 10000 });
    await window.waitForTimeout(300);
    await auditCurrentScreen(window, 'model-setup-wizard');
  });
});
