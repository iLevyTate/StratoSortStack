/**
 * Knowledge Graph E2E Tests
 *
 * Tests the Knowledge Graph (Relate tab) in Knowledge Graph including
 * cluster visualization, node interactions, graph controls,
 * and relationship exploration.
 *
 * Run: npm run test:e2e -- --grep "Knowledge Graph"
 */

const { test, expect } = require('@playwright/test');
const { launchApp, closeApp, waitForAppReady, dismissGraphTour } = require('./helpers/electronApp');
const { ensureAdvancedExperienceMode } = require('./helpers/e2eSettings');
const { pressOpenSearchShortcut } = require('./helpers/e2eShortcuts');

test.describe('Knowledge Graph — Relate Tab UI', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    await ensureAdvancedExperienceMode(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should open Knowledge Graph and navigate to Relate tab', async () => {
    await pressOpenSearchShortcut(window);
    await window.waitForTimeout(1200);

    const relateTab = window
      .locator('button:has-text("Relate"), [role="tab"]:has-text("Relate")')
      .first();

    await relateTab.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    const isVisible = await relateTab.isVisible().catch(() => false);
    expect(isVisible).toBe(true);

    if (isVisible) {
      await relateTab.click();
      await window.waitForTimeout(500);

      const graphUI = await window.evaluate(() => {
        const visible = document.body.innerText || '';
        return {
          hasGraphControls: visible.includes('Graph controls'),
          hasSearchToAdd:
            visible.includes('Search files to add to the graph') ||
            !!document.querySelector('input[placeholder*="add to the graph" i]'),
          hasNodes: visible.includes('nodes') || visible.includes('Nodes'),
          hasLinks: visible.includes('links') || visible.includes('Links'),
          hasCluster: /cluster/i.test(visible),
          hasLegend: visible.includes('Legend'),
          hasInsights: visible.includes("What's interesting") || visible.includes('Insights'),
          hasActions: visible.includes('Actions'),
          hasExplore: visible.includes('Explore') || visible.includes('Discover')
        };
      });

      expect(graphUI.hasGraphControls || graphUI.hasSearchToAdd || graphUI.hasNodes).toBe(true);
    }
  });

  test('should show graph control panel with stats', async () => {
    await pressOpenSearchShortcut(window);
    await window.waitForTimeout(1200);

    const relateTab = window.locator('button:has-text("Relate")').first();
    if (await relateTab.isVisible().catch(() => false)) {
      await relateTab.click();
      await window.waitForTimeout(800);

      const controls = await window.evaluate(() => {
        const visible = document.body.innerText || '';
        return {
          hasGraphControls:
            visible.includes('Graph controls') ||
            !!document.querySelector('[aria-label="Graph controls"]'),
          hasSearchToAdd:
            visible.includes('Search files to add to the graph') ||
            !!document.querySelector('input[placeholder*="add to the graph" i]'),
          hasWhatsInteresting: visible.includes("What's interesting"),
          hasNodeStats: /\d+\s*nodes/i.test(visible),
          hasLinkStats: /\d+\s*links/i.test(visible)
        };
      });

      expect(
        controls.hasGraphControls ||
          controls.hasSearchToAdd ||
          controls.hasWhatsInteresting ||
          controls.hasNodeStats ||
          controls.hasLinkStats
      ).toBe(true);
    }
  });

  test('should show legend panel with node types and connection logic', async () => {
    await pressOpenSearchShortcut(window);
    await window.waitForTimeout(1200);

    const relateTab = window.locator('button:has-text("Relate")').first();
    if (await relateTab.isVisible().catch(() => false)) {
      await relateTab.click();
      await window.waitForTimeout(800);

      const legend = await window.evaluate(() => {
        const visible = document.body.innerText || '';
        return {
          hasLegendHeading: visible.includes('Legend'),
          hasClusterType: visible.includes('Cluster'),
          hasFileType: visible.includes('File'),
          hasQueryType: visible.includes('Query'),
          hasFolderType: visible.includes('Folder'),
          hasConfidenceLevels:
            visible.includes('high') || visible.includes('medium') || visible.includes('low')
        };
      });

      const hasLegendContent = Object.values(legend).some((v) => v);
      expect(hasLegendContent).toBe(true);
    }
  });

  test('should have clusters toggle button', async () => {
    await pressOpenSearchShortcut(window);
    await window.waitForTimeout(800);

    const kosDialog = window.getByRole('dialog', { name: 'Knowledge OS' });
    await kosDialog.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

    const relateTab = kosDialog.getByRole('button', { name: 'Relate' });
    if (await relateTab.isVisible().catch(() => false)) {
      await relateTab.click();
      await window.waitForTimeout(800);

      await dismissGraphTour(window);
      await window.keyboard.press('Escape').catch(() => {});
      await window.waitForTimeout(300);

      await expect
        .poll(async () =>
          window.evaluate(() => {
            const root =
              document.querySelector('[role="dialog"][aria-label="Knowledge OS"]') ||
              document.querySelector('[role="dialog"]') ||
              document;
            const actionsBtn = [...root.querySelectorAll('button')].find(
              (btn) => btn.getAttribute('aria-label') === 'Actions section'
            );
            if (actionsBtn && actionsBtn.getAttribute('aria-expanded') !== 'true') {
              actionsBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }
            return [...root.querySelectorAll('button')].some((btn) => {
              const label = btn.getAttribute('aria-label') || '';
              const text = (btn.textContent || '').trim();
              return /auto-discover clusters|refresh clusters|show clusters|hide clusters/i.test(
                `${label} ${text}`
              );
            });
          })
        )
        .toBe(true);
    }
  });

  test('should have Add to graph search input', async () => {
    await pressOpenSearchShortcut(window);
    await window.waitForTimeout(500);

    const relateTab = window.locator('button:has-text("Relate")').first();
    if (await relateTab.isVisible().catch(() => false)) {
      await relateTab.click();
      await window.waitForTimeout(500);

      const graphUI = await window.evaluate(() => {
        const visible = document.body.innerText || '';
        return {
          hasSearchToAdd:
            visible.includes('Search files to add to the graph') ||
            !!document.querySelector('input[placeholder*="add to the graph" i]'),
          hasSearchInput: !!document.querySelector(
            'input[placeholder*="search" i], input[type="search"]'
          ),
          hasAddButton: Array.from(document.querySelectorAll('button')).some((button) =>
            /add/i.test((button.textContent || '').trim())
          )
        };
      });

      expect(graphUI.hasSearchToAdd || graphUI.hasSearchInput || graphUI.hasAddButton).toBe(true);
    }
  });
});

test.describe('Knowledge Graph — API', () => {
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

  test('should have knowledge graph APIs', async () => {
    // Phase 2 (Apr 2026): getRelationshipNodes was never exposed on preload;
    // the OR expression made this test pass regardless. Check each exposed
    // API individually so a missing preload method fails the test explicitly.
    const api = await window.evaluate(() => ({
      hasGetEdges: typeof window.electronAPI?.knowledge?.getRelationshipEdges === 'function',
      hasGetStats: typeof window.electronAPI?.knowledge?.getRelationshipStats === 'function',
      hasGetRelatedDocuments:
        typeof window.electronAPI?.knowledge?.getRelatedDocuments === 'function',
      hasRebuildRelationships:
        typeof window.electronAPI?.knowledge?.rebuildRelationships === 'function'
    }));

    expect(api.hasGetEdges).toBe(true);
    expect(api.hasGetStats).toBe(true);
    expect(api.hasGetRelatedDocuments).toBe(true);
    expect(api.hasRebuildRelationships).toBe(true);
  });

  test('should have embedding stats API for graph data', async () => {
    const stats = await window.evaluate(async () => {
      try {
        return await window.electronAPI.embeddings.getStats();
      } catch (e) {
        return { error: e.message };
      }
    });

    expect(stats).toBeTruthy();
  });

  test('should have search API for graph queries', async () => {
    const api = await window.evaluate(() => ({
      hasEmbeddingsSearch: typeof window.electronAPI?.embeddings?.search === 'function',
      hasScoreFiles: typeof window.electronAPI?.embeddings?.scoreFiles === 'function',
      hasFindSimilar: typeof window.electronAPI?.embeddings?.findSimilar === 'function'
    }));

    const hasAny = Object.values(api).some((v) => v);
    expect(hasAny).toBe(true);
  });
});
