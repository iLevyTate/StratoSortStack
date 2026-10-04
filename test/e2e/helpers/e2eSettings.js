/**
 * E2E helpers: Settings panel (Advanced mode, collapsible sections).
 * Backup, graph tab, and model tuning are hidden in Simple experience mode.
 */

const { NavigationPage } = require('./pageObjects');
const {
  dismissModelSetupWizard,
  focusAppForKeyboardShortcuts,
  safeWaitForTimeout
} = require('./electronApp');

async function ensureAdvancedExperienceMode(window) {
  if (typeof window.evaluate !== 'function') return;
  if (typeof window.isClosed === 'function' && window.isClosed()) return;
  // The first-run model wizard auto-opens ~2s after app-ready and its overlay
  // would swallow the focus click below (and the later search-shortcut / tab
  // interactions in the calling specs). Skip it before touching the chrome.
  await dismissModelSetupWizard(window);
  await focusAppForKeyboardShortcuts(window);
  try {
    await window.evaluate(async () => {
      if (typeof window.electronAPI?.settings?.update !== 'function') return;
      await window.electronAPI.settings.update('experienceMode', 'advanced');
    });
  } catch {
    return;
  }
  await safeWaitForTimeout(window, 400);
}

async function openSettingsAdvancedUI(window) {
  // Skip the first-run model wizard before opening Settings; its overlay would
  // otherwise intercept the Settings button click.
  await dismissModelSetupWizard(window);
  const nav = new NavigationPage(window);
  await nav.openSettings();
  await safeWaitForTimeout(window, 450);
  const advanced = window.locator('button:has-text("Advanced")').first();
  if (await advanced.isVisible().catch(() => false)) {
    await advanced.click();
    await safeWaitForTimeout(window, 350);
  }
}

async function expandSettingsCollapsibleByHeading(window, headingText) {
  const section = window
    .locator('section')
    .filter({ has: window.locator(`h3:has-text("${headingText}")`) })
    .first();
  const expand = section.locator('button[aria-label="Expand section"]');
  if (
    (await expand.count()) > 0 &&
    (await expand
      .first()
      .isVisible()
      .catch(() => false))
  ) {
    await expand.first().click();
    await safeWaitForTimeout(window, 400);
  }
}

module.exports = {
  ensureAdvancedExperienceMode,
  openSettingsAdvancedUI,
  expandSettingsCollapsibleByHeading
};
