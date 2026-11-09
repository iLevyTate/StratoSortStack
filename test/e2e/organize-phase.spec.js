/**
 * Organization Phase E2E Tests
 *
 * Tests the file organization workflow including:
 * - Phase navigation and UI elements
 * - File listing and selection
 * - Batch operations (Select All, Approve)
 * - Organization execution
 *
 * Real selectors from OrganizePhase.jsx:
 * - .organize-page: Main page container
 * - "Review & Organize": Main heading
 * - "Organize Files Now": Main action button
 * - "Files Ready for Organization": Section heading
 * - "Select All" / "Deselect All": Selection toggle button
 *
 * Run: npm run test:e2e -- --grep "Organize Phase"
 */

const { test, expect } = require('@playwright/test');
const { launchApp, closeApp, waitForAppReady } = require('./helpers/electronApp');
const { NavigationPage } = require('./helpers/pageObjects');
const { PHASES } = require('./helpers/testFixtures');
const { createSyntheticFiles, seedAnalyzedFiles } = require('./helpers/seedState');

const SEEDED_FILE_NAME = 'quarterly-budget.txt';

// Block reasons from uiSlice (TRANSITION_BLOCK_REASONS and
// PHASE_PREREQUISITE_REASONS): a closed tab's tooltip, which is also its
// accessible description, states why.
const ORGANIZE_FROM_WELCOME_REASON = 'Organize opens from Discover. Go to Discover first.';
const ORGANIZE_NEEDS_ANALYZED_FILE_REASON = 'Analyze at least one file first.';
const COMPLETE_NEEDS_ORGANIZED_FILE_REASON = 'Organize at least one file to open Complete.';

/**
 * Open the Organize phase the way a user does. Organize opens only from
 * Discover, and only once Discover has an analyzed file (the same check as
 * Discover's Continue). Real analysis needs a model, so one analyzed file is
 * seeded into the persisted state first; the app then reaches Organize
 * through its real tabs. goToPhase throws when a step is unreachable, so a
 * navigation regression fails these tests instead of skipping them.
 */
async function goToOrganize(app, nav, window) {
  const files = createSyntheticFiles(app, [SEEDED_FILE_NAME]);
  await seedAnalyzedFiles(window, files);
  await nav.goToPhase(PHASES.DISCOVER);
  await nav.goToPhase(PHASES.ORGANIZE);
  await window.waitForTimeout(500);
}

test.describe('Organize Phase - Navigation', () => {
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

  test('should have Organize button in navigation', async () => {
    // Check if the Organize button exists (may be disabled without analyzed files)
    const organizeButton = window.locator('button:has-text("Organize")');
    const exists = (await organizeButton.count()) > 0;
    console.log('[Test] Organize button exists:', exists);
    expect(exists).toBe(true);
  });

  test('should show Organize button state correctly', async () => {
    // A fresh launch is on Welcome, and Organize opens only from Discover.
    const organizeButton = new NavigationPage(window).getPhaseButton(PHASES.ORGANIZE);
    await expect(organizeButton).toHaveAttribute('aria-disabled', 'true');
    await expect(organizeButton).toHaveAccessibleDescription(ORGANIZE_FROM_WELCOME_REASON);
  });
});

test.describe('Organize Phase - Closed without analyzed files', () => {
  let app;
  let window;
  let nav;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    nav = new NavigationPage(window);
    await nav.goToPhase(PHASES.DISCOVER);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should keep Organize closed with the Discover reason when no files', async () => {
    // Organize used to open on an empty queue. Now Discover must have an
    // analyzed file first, and the closed tab says so.
    const organizeButton = nav.getPhaseButton(PHASES.ORGANIZE);
    await expect(organizeButton).toHaveAttribute('aria-disabled', 'true');
    await expect(organizeButton).toHaveAccessibleDescription(ORGANIZE_NEEDS_ANALYZED_FILE_REASON);
    expect(await nav.isPhaseAccessible(PHASES.ORGANIZE)).toBe(false);

    // Clicking the closed tab explains itself and stays on Discover.
    await organizeButton.click({ force: true });
    await expect(window.getByText(ORGANIZE_NEEDS_ANALYZED_FILE_REASON).first()).toBeVisible({
      timeout: 5000
    });
    expect(await nav.getActivePhase()).toBe(PHASES.DISCOVER);
    await expect(window.getByTestId('phase-discover-content')).toBeVisible();
  });
});

test.describe('Organize Phase - File Section (requires navigation)', () => {
  let app;
  let window;
  let nav;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    nav = new NavigationPage(window);
    await goToOrganize(app, nav, window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should have files ready section when on Organize phase', async () => {
    const filesSectionHeading = window.locator('h2:has-text("Files ready for organization")');
    await expect(filesSectionHeading).toBeVisible();
    // The seeded analyzed file is the one queued for review.
    await expect(window.getByText('1 file', { exact: true })).toBeVisible();
    await expect(window.getByText(SEEDED_FILE_NAME).first()).toBeVisible();
    await expect(window.getByText('No files ready yet')).toHaveCount(0);
  });

  test('should have back to Discovery button when on Organize phase', async () => {
    const backButton = window.locator('button:has-text("Back to Discovery")');
    const isVisible = await backButton.isVisible().catch(() => false);
    console.log('[Test] Back to Discovery button visible:', isVisible);
    expect(isVisible).toBe(true);
  });

  test('should have View Results button when on Organize phase', async () => {
    const viewResultsButton = window.locator('button:has-text("View Results")');
    await expect(viewResultsButton).toBeVisible();
    // Nothing is organized yet, so results stay closed: the button and the tab.
    await expect(viewResultsButton).toBeDisabled();
    const completeTab = nav.getPhaseButton(PHASES.COMPLETE);
    await expect(completeTab).toHaveAttribute('aria-disabled', 'true');
    await expect(completeTab).toHaveAccessibleDescription(COMPLETE_NEEDS_ORGANIZED_FILE_REASON);
  });
});

test.describe('Organize Phase - Quick Access Toolbar (requires navigation)', () => {
  let app;
  let window;
  let nav;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    nav = new NavigationPage(window);
    await goToOrganize(app, nav, window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should have status button when on Organize phase', async () => {
    const statusButton = window.locator('button[aria-label^="View file status"]');
    await expect(statusButton).toBeVisible();
    await expect(statusButton).toContainText('1 Ready');
  });

  test('should have smart folders button when folders configured', async () => {
    // A fresh profile has the default Uncategorized folder.
    const foldersButton = window.locator('button:has-text("Smart Folders")');
    await expect(foldersButton.first()).toBeVisible();
  });
});

test.describe('Organize Phase - Undo/Redo Integration (requires navigation)', () => {
  let app;
  let window;
  let nav;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    nav = new NavigationPage(window);
    await goToOrganize(app, nav, window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should have undo/redo toolbar when on Organize phase', async () => {
    const undoButton = window.locator('button[aria-label*="Undo"], button:has-text("Undo")');
    const redoButton = window.locator('button[aria-label*="Redo"], button:has-text("Redo")');

    await expect(undoButton.first()).toBeVisible();
    await expect(redoButton.first()).toBeVisible();
  });
});

test.describe('Organize Phase - API Integration', () => {
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

  test('should have file organization API available', async () => {
    // Organize moves files through files.organize / files.performOperation.
    const hasAPI = await window.evaluate(() => {
      const files = window.electronAPI?.files;
      return {
        hasOrganize: typeof files?.organize === 'function',
        hasPerformOperation: typeof files?.performOperation === 'function'
      };
    });

    console.log('[Test] File operations API:', hasAPI);
    expect(hasAPI.hasOrganize).toBe(true);
    expect(hasAPI.hasPerformOperation).toBe(true);
  });

  test('should expose organize.batch IPC (dry-run preview and commits)', async () => {
    const hasBatch = await window.evaluate(
      () => typeof window.electronAPI?.organize?.batch === 'function'
    );
    expect(hasBatch).toBe(true);
  });

  test('should have undo/redo API available', async () => {
    const hasAPI = await window.evaluate(() => {
      const undoRedo = window.electronAPI?.undoRedo;
      return {
        hasUndo: typeof undoRedo?.undo === 'function',
        hasRedo: typeof undoRedo?.redo === 'function',
        hasCanUndo: typeof undoRedo?.canUndo === 'function',
        hasCanRedo: typeof undoRedo?.canRedo === 'function'
      };
    });

    console.log('[Test] Undo/Redo API:', hasAPI);
    expect(hasAPI.hasUndo).toBe(true);
    expect(hasAPI.hasRedo).toBe(true);
  });

  test('should have smart folders API available', async () => {
    const hasAPI = await window.evaluate(() => {
      const smartFolders = window.electronAPI?.smartFolders;
      return {
        hasGet: typeof smartFolders?.get === 'function',
        hasSave: typeof smartFolders?.save === 'function'
      };
    });

    console.log('[Test] Smart Folders API:', hasAPI);
    expect(hasAPI.hasGet).toBe(true);
  });
});

test.describe('Organize Phase - Modals (requires navigation)', () => {
  let app;
  let window;
  let nav;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    nav = new NavigationPage(window);
    await goToOrganize(app, nav, window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should open status overview modal', async () => {
    await window.locator('button[aria-label^="View file status"]').click();
    const dialog = window.getByRole('dialog', { name: /file status overview/i });
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // The footer Close button; Escape depends on where focus landed.
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(dialog).toBeHidden({ timeout: 5000 });
  });

  test('should open smart folders modal when available', async () => {
    await window.locator('button:has-text("Smart Folders")').first().click();
    const dialog = window.getByRole('dialog', { name: /target smart folders/i });
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // The footer Close button; Escape depends on where focus landed.
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(dialog).toBeHidden({ timeout: 5000 });
  });
});
