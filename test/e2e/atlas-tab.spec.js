// @ts-check
/**
 * Atlas tab smoke + accessibility gate.
 *
 * The Atlas map renders via embedding-atlas (WebGL) under the app's strict
 * CSP (script-src with no unsafe-eval). Its predecessor (regl-scatterplot)
 * failed at init with a CSP EvalError, which nothing in the automated suites
 * caught — so this spec asserts, from the real built app:
 *   1. the Knowledge OS modal opens and the Atlas tab is reachable,
 *   2. NO CSP/eval page errors fire while the tab initialises,
 *   3. the tab surface renders a valid state (empty-corpus hint in the
 *      isolated e2e profile) with no critical/serious axe violations.
 */
const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const {
  launchApp,
  cleanupE2eUserDataDir,
  dismissModelSetupWizard
} = require('./helpers/electronApp');
const { pressOpenSearchShortcut } = require('./helpers/e2eShortcuts');

// Mirrors the severity gate in accessibility.spec.js.
const HARD_FAIL_IMPACTS = new Set(['critical', 'serious']);
const HARD_FAIL_RULES = new Set([
  'aria-prohibited-attr',
  'aria-tooltip-name',
  'color-contrast',
  'heading-order'
]);

test.describe('Knowledge OS Atlas tab', () => {
  /** @type {any} */ let app;
  /** @type {any} */ let window;
  /** @type {string|undefined} */ let e2eUserData;
  /** @type {string[]} */ let pageErrors;

  test.beforeAll(async () => {
    ({ app, window, e2eUserData } = await launchApp());
    // Isolated E2E profiles have no models, so WelcomePhase auto-opens the
    // "Set up on-device AI" wizard ~2s after ready; its aria-modal overlay would
    // otherwise intercept the Atlas tab click (every other interaction spec skips
    // it too). Dismiss before wiring up error capture so the CSP/error assertions
    // reflect only the Atlas interaction, not wizard-dismissal noise.
    await dismissModelSetupWizard(window);
    pageErrors = [];
    window.on('pageerror', (/** @type {Error} */ err) => {
      pageErrors.push(String(err?.message || err));
    });
    window.on('console', (/** @type {any} */ msg) => {
      if (msg.type() === 'error') pageErrors.push(`console: ${msg.text()}`);
    });
  });

  test.afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (e2eUserData) cleanupE2eUserDataDir(e2eUserData);
    }
  });

  test('atlas tab opens without CSP/eval errors and shows a valid state', async () => {
    await pressOpenSearchShortcut(window);
    const kosDialog = window.getByRole('dialog', { name: 'Knowledge OS' });
    await expect(kosDialog).toBeVisible({ timeout: 10000 });

    const atlasTab = kosDialog.getByRole('button', { name: 'Atlas' });
    await expect(atlasTab).toBeVisible({ timeout: 5000 });
    await atlasTab.click();

    // Isolated e2e profiles start with an empty corpus: the tab must settle
    // on its empty-state hint (any other terminal state means the projection
    // pipeline or the WebGL renderer failed).
    await expect(kosDialog.getByText(/No embedded documents yet/i)).toBeVisible({
      timeout: 30000
    });

    // The regression this spec exists for: the renderer must not trip the
    // no-unsafe-eval CSP (regl-scatterplot did; embedding-atlas must not).
    const cspErrors = pageErrors.filter(
      (e) =>
        /Content Security Policy/i.test(e) ||
        /unsafe-eval/i.test(e) ||
        /Evaluating a string as JavaScript/i.test(e) ||
        /EvalError/i.test(e)
    );
    expect(cspErrors).toEqual([]);

    // Surface any other renderer errors for diagnosis without hard-failing
    // on unrelated noise; WebGL init failures WOULD surface in-tab, which the
    // empty-state assertion above already excludes.
    if (pageErrors.length > 0) {
      console.warn('[E2E][atlas] non-CSP page/console errors observed:', pageErrors);
    }
  });

  test('atlas tab has no critical accessibility violations', async () => {
    const { violations } = await new AxeBuilder({ page: window }).setLegacyMode(true).analyze();
    const blocking = violations.filter(
      (v) => HARD_FAIL_IMPACTS.has(v.impact) || HARD_FAIL_RULES.has(v.id)
    );
    expect(blocking.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }))).toEqual(
      []
    );
  });
});
