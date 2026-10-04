/**
 * E2E Page Objects
 *
 * Lightweight page objects used by the Playwright E2E specs.
 * This restores the shared API expected by legacy tests while
 * keeping selectors aligned with the current renderer UI.
 */

const { expect } = require('@playwright/test');
const { SELECTORS, PHASES } = require('./testFixtures');
const { ensureKnowledgeOsClosed } = require('./electronApp');

const SETTINGS_PANEL_WAIT_MS = 2000;

const PHASE_ARIA_LABEL = {
  [PHASES.WELCOME]: 'Welcome',
  [PHASES.SETUP]: 'Setup',
  [PHASES.DISCOVER]: 'Discover',
  [PHASES.ORGANIZE]: 'Organize',
  [PHASES.COMPLETE]: 'Complete'
};

function normalizePhaseLabel(value) {
  const label = String(value || '')
    .trim()
    .toLowerCase();
  if (!label) return null;
  if (label.includes('welcome')) return PHASES.WELCOME;
  if (label.includes('setup') || label.includes('smart folders') || label.includes('configure')) {
    return PHASES.SETUP;
  }
  if (label.includes('discover')) return PHASES.DISCOVER;
  if (label.includes('organize')) return PHASES.ORGANIZE;
  if (label.includes('complete')) return PHASES.COMPLETE;
  return null;
}

function phaseContentTestId(phase) {
  return `phase-${phase}-content`;
}

class NavigationPage {
  constructor(page) {
    this.page = page;
  }

  getNavRoot() {
    return this.page.locator(SELECTORS.navBar);
  }

  getPhaseButton(phase) {
    const label = PHASE_ARIA_LABEL[phase] || String(phase || '');
    if (phase === PHASES.SETUP) {
      return this.getNavRoot()
        .locator(
          `${SELECTORS.phaseButton('Setup')}, ${SELECTORS.phaseButton('Smart Folders')}, ${SELECTORS.phaseButton('Configure')}`
        )
        .first();
    }
    return this.getNavRoot().locator(SELECTORS.phaseButton(label)).first();
  }

  /**
   * Active phase from nav [data-active-phase] (authoritative) with aria-current fallback.
   */
  async getActivePhase() {
    if (typeof this.page.isClosed === 'function' && this.page.isClosed()) return null;
    try {
      const nav = this.page.locator('[data-testid="phase-nav"]').first();
      if ((await nav.count()) > 0) {
        const attr = await nav.getAttribute('data-active-phase');
        if (attr) {
          const normalized = String(attr).trim().toLowerCase();
          if (
            [
              PHASES.WELCOME,
              PHASES.SETUP,
              PHASES.DISCOVER,
              PHASES.ORGANIZE,
              PHASES.COMPLETE
            ].includes(normalized)
          ) {
            return normalized;
          }
        }
      }
      return this.getCurrentPhaseFromAria();
    } catch {
      return null;
    }
  }

  async getCurrentPhaseFromAria() {
    if (typeof this.page.isClosed === 'function' && this.page.isClosed()) return null;
    try {
      const activeButton = this.getNavRoot().locator('button[aria-current="step"]').first();
      if ((await activeButton.count()) === 0) return null;

      const [ariaLabel, text] = await Promise.all([
        activeButton.getAttribute('aria-label'),
        activeButton.innerText().catch(() => '')
      ]);

      return normalizePhaseLabel(ariaLabel) || normalizePhaseLabel(text);
    } catch {
      return null;
    }
  }

  /** @deprecated Prefer getActivePhase */
  async getCurrentPhase() {
    return this.getActivePhase();
  }

  async isPhaseAccessible(phase) {
    const button = this.getPhaseButton(phase);
    if ((await button.count()) === 0) return false;
    const ariaDisabled = await button.getAttribute('aria-disabled');
    if (ariaDisabled === 'true') return false;
    return !(await button.isDisabled());
  }

  /**
   * Navigate to a workflow phase and wait until that phase's root content is visible.
   * Throws on failure so tests surface real navigation bugs instead of silent `false`.
   */
  async goToPhase(phase, options = {}) {
    const { timeoutMs = 12000 } = options;
    if (typeof this.page.isClosed === 'function' && this.page.isClosed()) {
      throw new Error('goToPhase: page is closed');
    }

    const contentLocator = this.page.getByTestId(phaseContentTestId(phase));

    const current = await this.getActivePhase();
    if (current === phase) {
      await expect(contentLocator).toBeVisible({ timeout: timeoutMs });
      return true;
    }

    const button = this.getPhaseButton(phase);
    if ((await button.count()) === 0) {
      throw new Error(`goToPhase: no button found for phase "${phase}"`);
    }
    if (await button.isDisabled()) {
      throw new Error(`goToPhase: phase "${phase}" navigation is disabled`);
    }

    // Knowledge OS modal and header badges can overlap phase tabs on narrow viewports.
    await ensureKnowledgeOsClosed(this.page);

    try {
      await button.click({ timeout: 8000 });
    } catch {
      await ensureKnowledgeOsClosed(this.page);
      await button.click({ force: true });
    }

    await expect
      .poll(async () => this.getActivePhase(), {
        message: `goToPhase: timed out waiting for active phase "${phase}" (nav data-active-phase / aria)`,
        timeout: timeoutMs
      })
      .toBe(phase);

    await expect(contentLocator).toBeVisible({
      timeout: timeoutMs,
      message: `goToPhase: phase "${phase}" nav updated but content root was not visible`
    });

    return true;
  }

  async openSettings() {
    if (typeof this.page.isClosed === 'function' && this.page.isClosed()) return false;
    try {
      const settingsButton = this.page.locator(SELECTORS.settingsButton).first();
      if ((await settingsButton.count()) === 0) return false;
      await settingsButton.click();
      // Prefer deterministic wait for panel visibility, fallback to short settle delay.
      const settingsPanel = this.page.locator(SELECTORS.settingsPanel).first();
      try {
        await settingsPanel.waitFor({ state: 'visible', timeout: SETTINGS_PANEL_WAIT_MS });
      } catch {
        if (typeof this.page.isClosed === 'function' && !this.page.isClosed()) {
          await this.page.waitForTimeout(200);
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  async isConnected() {
    const indicator = this.page
      .locator(`${SELECTORS.connectionStatus}, [aria-label="AI Engine Ready"]`)
      .first();
    return (await indicator.count()) > 0 && (await indicator.isVisible().catch(() => false));
  }
}

class DiscoverPage {
  constructor(page) {
    this.page = page;
  }

  async getFileCount() {
    // Matches the row wrapper rendered by AnalysisResultsList (discover phase).
    return this.page.locator('[data-testid="file-item"]').count();
  }
}

module.exports = {
  NavigationPage,
  DiscoverPage
};
