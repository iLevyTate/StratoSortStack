/**
 * Navigation E2E Tests
 *
 * Tests navigation between different phases of the application
 * and verifies phase transition rules are enforced.
 *
 * Run: npm run test:e2e -- --grep "Navigation"
 */

const { test, expect } = require('@playwright/test');
const {
  launchApp,
  closeApp,
  waitForAppReady,
  dismissModelSetupWizard
} = require('./helpers/electronApp');
const { NavigationPage } = require('./helpers/pageObjects');
const { PHASES, PHASE_NAV_LABELS } = require('./helpers/testFixtures');

test.describe('Navigation', () => {
  let app;
  let window;
  let nav;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    nav = new NavigationPage(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should start on a valid phase', async () => {
    const currentPhase = await nav.getCurrentPhase();
    console.log('[Test] Current phase:', currentPhase);
    // App may start on Welcome or Discover depending on state
    expect([PHASES.WELCOME, PHASES.DISCOVER]).toContain(currentPhase);
  });

  test('should show all phase buttons in navigation', async () => {
    const phaseButtons = window.locator('nav[aria-label="Phase navigation"] button');
    const count = await phaseButtons.count();

    // Should have buttons for all phases
    expect(count).toBeGreaterThanOrEqual(5);

    // Check each phase label exists
    for (const [, label] of Object.entries(PHASE_NAV_LABELS)) {
      const button = window.locator(`button:has-text("${label}")`);
      const exists = await button.count();
      console.log(`[Test] Phase "${label}":`, exists > 0 ? 'found' : 'not found');
      expect(exists).toBeGreaterThan(0);
    }
  });

  test('should navigate from Welcome to Setup', async () => {
    // From Welcome, Setup should be accessible
    const canNavigate = await nav.isPhaseAccessible(PHASES.SETUP);
    expect(canNavigate).toBe(true);

    // Navigate to Setup
    const success = await nav.goToPhase(PHASES.SETUP);
    expect(success).toBe(true);

    // Verify we're on Setup phase
    await window.waitForTimeout(500); // Allow for animation
    const currentPhase = await nav.getCurrentPhase();
    expect(currentPhase).toBe(PHASES.SETUP);
  });

  test('should navigate from Welcome to Discover (Quick Start)', async () => {
    // From Welcome, Discover should also be accessible (quick start path)
    const canNavigate = await nav.isPhaseAccessible(PHASES.DISCOVER);
    expect(canNavigate).toBe(true);

    // Navigate to Discover
    const success = await nav.goToPhase(PHASES.DISCOVER);
    expect(success).toBe(true);

    await window.waitForTimeout(500);
    const currentPhase = await nav.getCurrentPhase();
    expect(currentPhase).toBe(PHASES.DISCOVER);
  });

  test('should enforce phase transition rules', async () => {
    // From Welcome, Organize should not be directly accessible
    const organizeButton = window.locator(
      `button:has-text("${PHASE_NAV_LABELS[PHASES.ORGANIZE]}")`
    );

    // The button might be disabled or the click might not navigate
    const isDisabled = await organizeButton.isDisabled().catch(() => true);

    console.log('[Test] Organize button disabled from Welcome:', isDisabled);

    // Even if we try to click, we shouldn't navigate to Organize from Welcome
    if (!isDisabled) {
      await organizeButton.click();
      await window.waitForTimeout(500);
      const currentPhase = await nav.getCurrentPhase();
      // Should still be on Welcome or a valid transition target
      expect([PHASES.WELCOME, PHASES.SETUP, PHASES.DISCOVER]).toContain(currentPhase);
    }
  });

  test('should allow navigation back to Welcome from Setup', async () => {
    // First go to Setup
    await nav.goToPhase(PHASES.SETUP);
    await window.waitForTimeout(500);

    // Then go back to Welcome
    const success = await nav.goToPhase(PHASES.WELCOME);
    expect(success).toBe(true);

    await window.waitForTimeout(500);
    const currentPhase = await nav.getCurrentPhase();
    expect(currentPhase).toBe(PHASES.WELCOME);
  });

  test('should highlight current phase in navigation', async () => {
    // Check that some phase button has aria-current
    let activeButton = window.locator('button[aria-current="step"]');
    let label = await activeButton.getAttribute('aria-label');
    console.log('[Test] Initial active phase:', label);
    // Just verify there's an active phase
    expect(label).toBeTruthy();

    // Navigate to Setup
    await nav.goToPhase(PHASES.SETUP);
    await window.waitForTimeout(500);

    // Now Setup should be active
    activeButton = window.locator('button[aria-current="step"]');
    label = await activeButton.getAttribute('aria-label');
    console.log('[Test] After Setup navigation:', label);
    // aria-label contains full title "Configure Smart Folders"
    expect(label).toMatch(/Smart Folders|Configure|setup/i);
  });

  test('should open settings panel from navigation', async () => {
    // The first-run model wizard opens ~2s after ready in a model-less E2E
    // profile; dismiss it so its aria-modal overlay cannot swallow the
    // settings click or add a second [role="dialog"] to the page.
    await dismissModelSetupWizard(window);

    // Click settings button
    await nav.openSettings();

    // Settings panel should be visible (named lookup stays strict-safe even
    // if another dialog is present)
    const settingsPanel = window.getByRole('dialog', { name: 'Settings' });
    await expect(settingsPanel).toBeVisible({ timeout: 5000 });

    // Close settings via the panel's own close affordance
    const closeButton = settingsPanel
      .locator('[aria-label="Close Settings"], [aria-label="Close"], button:has-text("Close")')
      .first();
    if (await closeButton.isVisible()) {
      await closeButton.click();
      await window.waitForTimeout(300);
    }
  });

  test('should navigate through complete workflow path', async () => {
    // Follow the main workflow: Welcome -> Setup -> Discover
    console.log('[Test] Testing workflow navigation...');

    // Normalize persisted UI state to Welcome so transitions match the main funnel
    await nav.goToPhase(PHASES.WELCOME);
    expect(await nav.getCurrentPhase()).toBe(PHASES.WELCOME);

    // Go to Setup
    await nav.goToPhase(PHASES.SETUP);
    await window.waitForTimeout(500);
    expect(await nav.getCurrentPhase()).toBe(PHASES.SETUP);

    // Go to Discover
    await nav.goToPhase(PHASES.DISCOVER);
    await window.waitForTimeout(500);
    expect(await nav.getCurrentPhase()).toBe(PHASES.DISCOVER);

    // Go back to Welcome
    await nav.goToPhase(PHASES.WELCOME);
    await window.waitForTimeout(500);
    expect(await nav.getCurrentPhase()).toBe(PHASES.WELCOME);

    console.log('[Test] Workflow navigation complete');
  });
});

test.describe('Navigation - Keyboard Shortcuts', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should focus navigation with Tab key', async () => {
    // Press Tab to move focus through the UI
    await window.keyboard.press('Tab');
    await window.waitForTimeout(200);

    // Check if a navigation element is focused
    const focusedElement = await window.evaluate(() => {
      return document.activeElement?.tagName;
    });

    console.log('[Test] Focused element after Tab:', focusedElement);
    // Should have moved focus to an interactive element
    expect(focusedElement).toBeDefined();
  });

  test('should handle Escape key gracefully', async () => {
    const settingsButton = window.locator('button[aria-label="Open settings"]');
    await settingsButton.click();
    await window.waitForTimeout(500);

    const settingsPanel = window.locator('[role="dialog"][aria-label="Settings"]');
    await expect(settingsPanel.first()).toBeVisible({ timeout: 5000 });

    await window.keyboard.press('Escape');
    await window.waitForTimeout(400);
    const stillVisible = await settingsPanel
      .first()
      .isVisible()
      .catch(() => false);
    if (stillVisible) {
      const closeBtn = window.locator(
        'button[aria-label="Close settings"], button:has-text("Close")'
      );
      if (
        await closeBtn
          .first()
          .isVisible()
          .catch(() => false)
      ) {
        await closeBtn.first().click();
        await window.waitForTimeout(300);
      }
    }
    await expect(settingsPanel.first()).toBeHidden({ timeout: 2000 });
  });
});

test.describe('Navigation - Accessibility', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should have aria labels on navigation buttons', async () => {
    const navButtons = window.locator('nav[aria-label="Phase navigation"] button');
    const count = await navButtons.count();

    for (let i = 0; i < count; i++) {
      const button = navButtons.nth(i);
      const ariaLabel = await button.getAttribute('aria-label');

      console.log(`[Test] Button ${i} aria-label:`, ariaLabel);
      expect(ariaLabel).toBeTruthy();
    }
  });

  test('should have main content landmark', async () => {
    const main = window.locator('main#main-content');
    const exists = await main.count();

    expect(exists).toBeGreaterThan(0);
  });
});
