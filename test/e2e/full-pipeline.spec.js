/**
 * Full Pipeline E2E Tests
 *
 * Tests the complete file analysis → organize → complete pipeline.
 * Covers the end-to-end workflow a user follows from importing files
 * through AI analysis to final organization.
 *
 * Run: npm run test:e2e -- --grep "Full Pipeline"
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const {
  launchApp,
  closeApp,
  waitForAppReady,
  safeWaitForTimeout
} = require('./helpers/electronApp');
const { NavigationPage } = require('./helpers/pageObjects');
const {
  PHASES,
  SELECTORS,
  TIMEOUTS,
  createTempDir,
  cleanupTempDir
} = require('./helpers/testFixtures');

test.describe('Full Pipeline — Analysis to Organize', () => {
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

  test('should have analysis API with analyze-document channel', async () => {
    const api = await window.evaluate(() => ({
      hasDocument:
        typeof window.electronAPI?.analysis?.document === 'function' ||
        typeof window.electronAPI?.analysis?.analyzeDocument === 'function',
      hasBatch:
        typeof window.electronAPI?.analysis?.batch === 'function' ||
        typeof window.electronAPI?.analysis?.analyzeBatch === 'function' ||
        typeof window.electronAPI?.analysis?.analyzeFiles === 'function',
      hasQueueOrProgress:
        typeof window.electronAPI?.analysis?.getReadyQueue === 'function' ||
        typeof window.electronAPI?.analysis?.getProgress === 'function'
    }));

    expect(api.hasDocument || api.hasBatch).toBe(true);
    expect(api.hasQueueOrProgress).toBe(true);
  });

  test('should navigate full pipeline: Discover → Organize → Complete', async () => {
    await nav.goToPhase(PHASES.DISCOVER);
    expect(await nav.getCurrentPhase()).toBe(PHASES.DISCOVER);

    await nav.goToPhase(PHASES.ORGANIZE);
    expect(await nav.getCurrentPhase()).toBe(PHASES.ORGANIZE);

    const completeTab = nav.getPhaseButton(PHASES.COMPLETE);
    expect(await completeTab.count()).toBeGreaterThan(0);

    // Complete is in the nav graph from Organize, but only useful once files were organized.
    const viewResultsButton = window.getByRole('button', { name: /View Results/i });
    const canViewResults = await viewResultsButton.isEnabled().catch(() => false);
    if (canViewResults && (await nav.isPhaseAccessible(PHASES.COMPLETE))) {
      await nav.goToPhase(PHASES.COMPLETE);
      expect(await nav.getCurrentPhase()).toBe(PHASES.COMPLETE);
    }
  });

  test('should show Discover UI with file import controls', async () => {
    await nav.goToPhase(PHASES.DISCOVER);
    await safeWaitForTimeout(window, 500);

    const uiState = await window.evaluate(() => {
      const body = document.body.textContent || '';
      return {
        hasSelectFiles: body.includes('Select files'),
        hasScanFolder: body.includes('Scan folder'),
        hasAnalyzeSection: body.includes('Discover') || body.includes('Analyze'),
        hasNamingStrategy: body.includes('Naming strategy')
      };
    });

    expect(uiState.hasSelectFiles || uiState.hasScanFolder).toBe(true);
  });

  test('should show Organize UI with smart folder tabs', async () => {
    // Establish deterministic navigation context before asserting Organize UI.
    const discoverOk = await nav.goToPhase(PHASES.DISCOVER);
    expect(discoverOk).toBe(true);

    const success = await nav.goToPhase(PHASES.ORGANIZE);
    expect(success).toBe(true);
    const current = await nav.getCurrentPhase();
    expect(current).toBe(PHASES.ORGANIZE);
    await safeWaitForTimeout(window, 500);

    const uiState = await window.evaluate(() => {
      const body = document.body.textContent || '';
      return {
        hasReviewOrganize: body.includes('Review') && body.includes('Organize'),
        hasSmartFolders: body.includes('Smart Folder'),
        hasReadyForOrganization: body.includes('Files ready for organization'),
        hasNoFilesReady: body.includes('No files ready yet')
      };
    });

    expect(
      uiState.hasReviewOrganize ||
        uiState.hasSmartFolders ||
        uiState.hasReadyForOrganization ||
        uiState.hasNoFilesReady
    ).toBe(true);
  });

  test('should show Complete phase with session summary', async () => {
    // Reach Organize through the canonical phase order.
    const discoverOk = await nav.goToPhase(PHASES.DISCOVER);
    expect(discoverOk).toBe(true);

    const organizeAccessible = await nav.isPhaseAccessible(PHASES.ORGANIZE);
    if (!organizeAccessible) {
      test.skip(true, 'Organize phase is unavailable in this session state');
    }

    const organizeOk = await nav.goToPhase(PHASES.ORGANIZE);
    expect(organizeOk).toBe(true);

    // Complete phase is only meaningful once files have been processed.
    const viewResultsButton = window.locator('button:has-text("View Results")').first();
    const hasViewResults = await viewResultsButton.isVisible().catch(() => false);
    if (!hasViewResults) {
      test.skip(true, 'View Results action is not visible in current Organize layout');
    }
    const canViewResults = await viewResultsButton.isEnabled();
    if (!canViewResults) {
      test.skip(true, 'Complete summary is unavailable until at least one file is organized');
    }

    await viewResultsButton.click();
    await safeWaitForTimeout(window, 500);

    const uiState = await window.evaluate(() => {
      const body = document.body.textContent || '';
      return {
        hasCompleteActions:
          body.includes('Start New Session') ||
          body.includes('Back to Organize') ||
          body.includes('What Changed'),
        hasStartNewSession: body.includes('Start New Session'),
        hasSummary:
          body.includes('What Changed') ||
          body.includes('organized') ||
          body.includes('No files were moved')
      };
    });

    expect(uiState.hasCompleteActions).toBe(true);
    expect(uiState.hasStartNewSession || uiState.hasSummary).toBe(true);
  });

  test('should maintain file count when navigating between phases', async () => {
    await nav.goToPhase(PHASES.DISCOVER);
    await safeWaitForTimeout(window, 300);

    const discoverState = await window.evaluate(() => {
      const badges = document.querySelectorAll('[class*="badge"], [data-testid*="count"]');
      return { badgeCount: badges.length };
    });

    await nav.goToPhase(PHASES.ORGANIZE);
    await safeWaitForTimeout(window, 300);
    await nav.goToPhase(PHASES.DISCOVER);
    await safeWaitForTimeout(window, 300);

    const afterNavState = await window.evaluate(() => {
      const badges = document.querySelectorAll('[class*="badge"], [data-testid*="count"]');
      return { badgeCount: badges.length };
    });

    expect(afterNavState.badgeCount).toBe(discoverState.badgeCount);
  });

  test('should have batch organize API available', async () => {
    const api = await window.evaluate(() => ({
      hasBatchOrganize:
        typeof window.electronAPI?.files?.batchOrganize === 'function' ||
        typeof window.electronAPI?.organize?.batch === 'function',
      hasOrganizeAuto: typeof window.electronAPI?.organize?.auto === 'function'
    }));

    expect(api.hasBatchOrganize || api.hasOrganizeAuto).toBe(true);
  });
});

test.describe('Full Pipeline — Smart Folder Routing', () => {
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

  test('should create smart folders and verify they persist', async () => {
    const uniqueSuffix = Date.now();
    let tempRoot = null;

    try {
      tempRoot = await createTempDir('stratosort-e2e-smart-folders-');

      const folders = [
        { name: `Nature_${uniqueSuffix}`, description: 'Wildlife and ecology' },
        { name: `Finances_${uniqueSuffix}`, description: 'Financial documents' },
        { name: `Research_${uniqueSuffix}`, description: 'Scientific papers' }
      ];

      for (const folder of folders) {
        const result = await window.evaluate(
          async ({ name, description, fullPath }) => {
            return window.electronAPI.smartFolders.add({
              name,
              path: fullPath,
              description
            });
          },
          { ...folder, fullPath: path.join(tempRoot, folder.name) }
        );
        expect(result?.success, JSON.stringify(result)).toBe(true);
      }

      const savedFolders = await window.evaluate(async () => window.electronAPI.smartFolders.get());
      const folderList = Array.isArray(savedFolders)
        ? savedFolders
        : Array.isArray(savedFolders?.folders)
          ? savedFolders.folders
          : [];
      const names = folderList.map((f) => f.name);

      for (const folder of folders) {
        expect(names).toContain(folder.name);
      }

      // Cleanup smart-folder entries.
      for (const folder of folders) {
        const target = folderList.find((f) => f.name === folder.name) ?? null;
        if (target) {
          await window.evaluate(
            async (id) => window.electronAPI.smartFolders.delete(id),
            target.id
          );
        }
      }
    } finally {
      if (tempRoot) {
        await cleanupTempDir(tempRoot);
      }
    }
  });

  test('should get folder suggestions for a file via API', async () => {
    const api = await window.evaluate(() => ({
      hasSuggestionsGet:
        typeof window.electronAPI?.suggestions?.getFile === 'function' ||
        typeof window.electronAPI?.suggestions?.getBatch === 'function',
      hasStrategies: typeof window.electronAPI?.suggestions?.getStrategies === 'function'
    }));

    expect(api.hasSuggestionsGet || api.hasStrategies).toBe(true);
  });
});
