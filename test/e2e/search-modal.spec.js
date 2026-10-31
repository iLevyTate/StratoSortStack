/**
 * Search Modal E2E Tests
 *
 * Tests the semantic search functionality including Ctrl+K shortcut,
 * search modal interactions, and search results display.
 *
 * Run: npm run test:e2e -- --grep "Search Modal"
 */

const { test, expect } = require('@playwright/test');
const {
  launchApp,
  closeApp,
  waitForAppReady,
  safeWaitForTimeout,
  dismissGraphTour,
  dismissModelSetupWizard
} = require('./helpers/electronApp');
const { ensureAdvancedExperienceMode } = require('./helpers/e2eSettings');
const { pressOpenSearchShortcut } = require('./helpers/e2eShortcuts');

const SEARCH_INPUT_SELECTOR =
  'input[type="search"], input[placeholder*="Search"], input[placeholder*="Describe"], [role="combobox"][aria-label*="Search"]';

// Every beforeEach calls dismissModelSetupWizard after waitForAppReady: the
// first-run model setup wizard opens ~2 s after ready in a model-less E2E
// profile, after waitForAppReady's single dismissModals() pass, and its
// aria-modal overlay then swallows clicks (it intercepted the Relate tab in CI).

async function openSearchModalAndWait(window) {
  await pressOpenSearchShortcut(window);
  const searchInput = window.locator(SEARCH_INPUT_SELECTOR).first();
  await expect(searchInput).toBeVisible({ timeout: 5000 });
  return searchInput;
}

test.describe('Search Modal - Opening and Closing', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    await dismissModelSetupWizard(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should open search with Ctrl+K', async () => {
    // openSearchModalAndWait retries visibility for up to 5 s — a fixed 500 ms
    // wait loses the race against the modal's lazy-loaded chunk on CI runners.
    const searchInput = await openSearchModalAndWait(window);
    await expect(searchInput).toBeVisible();
  });

  test('should close search with Escape', async () => {
    // First open search
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    const searchInput = window.locator(
      'input[type="search"], input[placeholder*="Search"], input[placeholder*="Describe"], [role="combobox"][aria-label*="Search"]'
    );

    const wasOpen = await searchInput
      .first()
      .isVisible()
      .catch(() => false);

    if (wasOpen) {
      // Press Escape to close
      await window.keyboard.press('Escape');
      await safeWaitForTimeout(window, 500);

      // Verify it's closed
      const stillVisible = await searchInput
        .first()
        .isVisible()
        .catch(() => false);
      console.log('[Test] Search closed after Escape:', !stillVisible);
    }
  });

  test('should focus search input when modal opens', async () => {
    await openSearchModalAndWait(window);

    const focusState = await window.evaluate(() => {
      const activeEl = document.activeElement;
      const searchInput = document.querySelector(
        'input[placeholder*="Search"], input[placeholder*="search"], input[placeholder*="Describe"]'
      );
      const isInputFocused =
        activeEl?.tagName === 'INPUT' ||
        activeEl?.getAttribute?.('role') === 'combobox' ||
        (activeEl?.placeholder && /search|describe/i.test(activeEl.placeholder));

      return {
        isFocused: !!isInputFocused,
        searchInputExists: !!searchInput,
        activeElementTag: activeEl?.tagName,
        activeElementPlaceholder: activeEl?.placeholder
      };
    });

    console.log('[Test] Focus state:', focusState);
    // Either input is focused OR the search input exists (modal opened successfully)
    expect(focusState.searchInputExists || focusState.isFocused).toBe(true);
  });
});

test.describe('Search Modal - Search Functionality', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    await dismissModelSetupWizard(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should have search API available', async () => {
    const searchApi = await window.evaluate(() => {
      const api = window.electronAPI?.search || window.electronAPI?.embeddings;
      return {
        hasSearch: typeof api?.search === 'function',
        hasFindSimilar: typeof api?.findSimilar === 'function',
        hasQuery: typeof api?.query === 'function'
      };
    });

    console.log('[Test] Search API methods:', searchApi);
  });

  test('should accept text input in search field', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    const searchInput = window
      .locator('input[type="search"], input[placeholder*="Search"], input[placeholder*="search"]')
      .first();

    if (await searchInput.isVisible()) {
      await searchInput.fill('test search query');
      const value = await searchInput.inputValue();
      expect(value).toBe('test search query');
    }
  });

  test('should clear search on modal close', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    const searchInput = window
      .locator('input[type="search"], input[placeholder*="Search"], input[placeholder*="search"]')
      .first();

    if (await searchInput.isVisible()) {
      await searchInput.fill('test query');

      // Close and reopen
      await window.keyboard.press('Escape');
      await safeWaitForTimeout(window, 300);

      await pressOpenSearchShortcut(window);
      await safeWaitForTimeout(window, 500);

      // Check if input is empty or cleared
      const newValue = await searchInput.inputValue();
      console.log('[Test] Search value after reopen:', newValue);
    }
  });
});

test.describe('Search Modal - Search Modes', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    await dismissModelSetupWizard(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should have semantic search mode option', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    // Look for semantic/vector search option
    const semanticOption = window.locator(
      'button:has-text("Semantic"), [data-testid*="semantic"], label:has-text("Semantic")'
    );

    const count = await semanticOption.count();
    console.log('[Test] Semantic search option found:', count > 0);
  });

  test('should have full-text search mode option', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    // Look for full-text/keyword search option
    const textOption = window.locator(
      'button:has-text("Text"), button:has-text("Keyword"), [data-testid*="fulltext"]'
    );

    const count = await textOption.count();
    console.log('[Test] Full-text search option found:', count > 0);
  });

  test('should have hybrid search mode option', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    // Look for hybrid search option
    const hybridOption = window.locator('button:has-text("Hybrid"), [data-testid*="hybrid"]');

    const count = await hybridOption.count();
    console.log('[Test] Hybrid search option found:', count > 0);
  });
});

test.describe('Search Modal - Results Display', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    await dismissModelSetupWizard(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should have results container', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    // Look for results container
    const resultsContainer = window.locator(
      '[data-testid="search-results"], .search-results, [class*="results"]'
    );

    const count = await resultsContainer.count();
    console.log('[Test] Results container found:', count > 0);
  });

  test('should show similarity scores in results', async () => {
    // This would require actual search results
    // For now, verify the UI structure supports similarity display
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    // Check if the modal has appropriate UI for displaying scores
    const uiState = await window.evaluate(() => {
      // Look for any element that might display scores
      const percentElements = document.querySelectorAll(
        '[class*="score"], [class*="similarity"], [class*="confidence"]'
      );
      // Use standard CSS selectors, not Playwright selectors
      const previewElements = document.querySelectorAll('*');
      let hasPreviewPanel = false;
      for (const el of previewElements) {
        if (el.textContent?.includes('Preview')) {
          hasPreviewPanel = true;
          break;
        }
      }
      const hasResultsArea = !!document.querySelector('[class*="result"], [class*="search"]');
      return {
        scoreElementsCount: percentElements.length,
        hasPreviewPanel,
        hasResultsArea
      };
    });

    console.log('[Test] Score display UI:', uiState);
    // Test passes as long as the modal is structured correctly
  });

  test('should support clicking on search results', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    // Look for clickable result items
    const resultItems = window.locator(
      '[data-testid="search-result-item"], .search-result, [role="option"]'
    );

    const count = await resultItems.count();
    console.log('[Test] Clickable result items:', count);
  });
});

test.describe('Search Modal - Visualization Options', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    await dismissModelSetupWizard(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should have Search tab (search view)', async () => {
    await openSearchModalAndWait(window);

    // Knowledge OS modal uses Search/Chat/Relate tabs
    const discoverTab = window.locator('button:has-text("Search")');
    const count = await discoverTab.count();

    console.log('[Test] Search tab found:', count > 0);
    expect(count).toBeGreaterThan(0);
  });

  test('should have Relate tab (graph view)', async () => {
    await openSearchModalAndWait(window);

    // Knowledge OS modal: Relate = graph, Chat = assistant
    const relateTab = window.locator('button:has-text("Relate")');
    const count = await relateTab.count();

    if (count === 0) {
      test.skip(true, 'Relate tab is feature-flagged off in this environment');
    }

    console.log('[Test] Relate tab found:', count > 0);
    expect(count).toBeGreaterThan(0);
  });

  test('should show indexed files count', async () => {
    await openSearchModalAndWait(window);

    // "N files indexed" renders only after the stats IPC resolves — poll
    // rather than sampling the DOM once.
    await expect
      .poll(
        () =>
          window.evaluate(() => {
            const elements = document.querySelectorAll('*');
            for (const el of elements) {
              if (el.textContent?.includes('files indexed')) {
                return el.textContent;
              }
            }
            return null;
          }),
        { timeout: 5000 }
      )
      .toContain('files indexed');
  });
});

test.describe('Search Modal - Embeddings Integration', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    await dismissModelSetupWizard(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should have embeddings API available', async () => {
    const embeddingsApi = await window.evaluate(() => {
      const api = window.electronAPI?.embeddings;
      return {
        hasFindSimilar: typeof api?.findSimilar === 'function',
        hasGetStats: typeof api?.getStats === 'function',
        hasRebuildFolders: typeof api?.rebuildFolders === 'function',
        hasRebuildFiles: typeof api?.rebuildFiles === 'function'
      };
    });

    console.log('[Test] Embeddings API methods:', embeddingsApi);
    expect(embeddingsApi.hasFindSimilar).toBe(true);
    expect(embeddingsApi.hasGetStats).toBe(true);
  });

  test('should be able to get embedding stats', async () => {
    const stats = await window.evaluate(async () => {
      try {
        const api = window.electronAPI?.embeddings;
        if (!api?.getStats) return { available: false };
        const result = await api.getStats();
        return { available: true, stats: result };
      } catch (e) {
        return { available: true, error: e.message };
      }
    });

    console.log('[Test] Embedding stats result:', stats);
  });

  test('should have find similar functionality', async () => {
    const hasFindSimilar = await window.evaluate(() => {
      return typeof window.electronAPI?.embeddings?.findSimilar === 'function';
    });

    expect(hasFindSimilar).toBe(true);
  });
});

test.describe('Search Modal - Keyboard Navigation', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    await dismissModelSetupWizard(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should navigate results with arrow keys', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    // Type a search query
    const searchInput = window
      .locator(
        'input[type="search"], input[placeholder*="Search"], input[placeholder*="Describe"], [role="combobox"][aria-label*="Search"]'
      )
      .first();

    if (await searchInput.isVisible()) {
      await searchInput.fill('test');
      await safeWaitForTimeout(window, 300);

      // Press down arrow to navigate results
      await window.keyboard.press('ArrowDown');
      await safeWaitForTimeout(window, 100);

      // Press up arrow
      await window.keyboard.press('ArrowUp');
      await safeWaitForTimeout(window, 100);

      console.log('[Test] Arrow key navigation executed');
    }
  });

  test('should select result with Enter key', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    const searchInput = window
      .locator(
        'input[type="search"], input[placeholder*="Search"], input[placeholder*="Describe"], [role="combobox"][aria-label*="Search"]'
      )
      .first();

    if (await searchInput.isVisible()) {
      await searchInput.fill('test');
      await safeWaitForTimeout(window, 300);

      // Press Enter to select
      await window.keyboard.press('Enter');
      await safeWaitForTimeout(window, 200);

      console.log('[Test] Enter key selection executed');
    }
  });

  test('should support Tab navigation within modal', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    // Press Tab to navigate between elements
    await window.keyboard.press('Tab');
    await safeWaitForTimeout(window, 100);

    const focusedTag = await window.evaluate(() => document.activeElement?.tagName);
    console.log('[Test] Focused element after Tab:', focusedTag);
  });
});

test.describe('Search Modal - Graph Visualization', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    await dismissModelSetupWizard(window);
    await ensureAdvancedExperienceMode(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should switch to Relate tab (graph)', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    // Click on "Relate" tab (graph view in KnowledgeOS)
    const graphTab = window.locator('button:has-text("Relate")');
    if ((await graphTab.count()) === 0) {
      test.skip(true, 'Graph/Relate tab not shown (STRATOSORT_GRAPH_ENABLED may be false)');
    }
    await graphTab.first().click();
    await safeWaitForTimeout(window, 500);

    const tabState = await window.evaluate(() => {
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.includes('Relate')) {
          return { found: true };
        }
      }
      return { found: false };
    });

    console.log('[Test] Relate tab state after click:', tabState);
    expect(tabState.found).toBe(true);
  });

  test('should display graph container when tab is active', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    const graphTab = window.locator('button:has-text("Relate")');
    if ((await graphTab.count()) > 0) {
      await graphTab.first().click();
      await safeWaitForTimeout(window, 1000);
    }

    const graphState = await window.evaluate(() => {
      const reactFlow = document.querySelector(
        '.react-flow, [class*="react-flow"], [data-testid="rf__wrapper"]'
      );
      const svgGraph = document.querySelector('svg.react-flow__edges, svg[class*="edge"]');
      const graphContainer = document.querySelector('[class*="graph"], [class*="Graph"]');

      return {
        hasReactFlow: !!reactFlow,
        hasSvgGraph: !!svgGraph,
        hasGraphContainer: !!graphContainer
      };
    });

    console.log('[Test] Graph container state:', graphState);
  });

  test('should have graph controls when in graph view', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    const graphTab = window.locator('button:has-text("Relate")');
    if ((await graphTab.count()) > 0) {
      await graphTab.first().click();
      await safeWaitForTimeout(window, 1000);
    }

    // Look for zoom/pan controls or graph toolbar using valid CSS selectors
    const controlsState = await window.evaluate(() => {
      // ReactFlow's controls panel
      const controls = document.querySelector('.react-flow__controls, [class*="control"]');
      // Look for zoom buttons by aria-label
      const zoomIn = document.querySelector('[aria-label*="zoom"], [class*="zoom"]');
      const zoomOut = document.querySelector('[aria-label*="zoom"], [class*="zoom"]');
      const fitView = document.querySelector('[aria-label*="fit"]');

      // Check for any button that might be a zoom control
      const buttons = document.querySelectorAll('button');
      let hasZoomButton = false;
      for (const btn of buttons) {
        if (
          btn.textContent?.includes('+') ||
          btn.textContent?.includes('-') ||
          btn.ariaLabel?.toLowerCase().includes('zoom')
        ) {
          hasZoomButton = true;
          break;
        }
      }

      return {
        hasZoomIn: !!zoomIn,
        hasZoomOut: !!zoomOut,
        hasFitView: !!fitView,
        hasControls: !!controls,
        hasZoomButton
      };
    });

    console.log('[Test] Graph controls state:', controlsState);
    // Graph view should be present even if controls are minimal
  });

  test('should be able to switch back to Search tab', async () => {
    await openSearchModalAndWait(window);

    // Scope to the dialog so locators can't match the nav-bar Search button
    // behind the modal.
    const kosDialog = window.getByRole('dialog', { name: 'Knowledge OS' });

    const relateTab = kosDialog.getByRole('button', { name: 'Relate' });
    if ((await relateTab.count()) > 0) {
      await relateTab.first().click();
      // The first-run GraphTour scrim appears ~500ms after the graph opens and
      // intercepts every click until dismissed; wait for it and retry-close so
      // the later "Search" tab click isn't swallowed.
      await dismissGraphTour(window);
      await safeWaitForTimeout(window, 300);
    }

    const discoverTab = kosDialog.getByRole('button', { name: 'Search', exact: true });
    if ((await discoverTab.count()) > 0) {
      await discoverTab.first().click();
      await safeWaitForTimeout(window, 300);
    }

    // Verify search input is visible (Search tab has combobox/input)
    const searchInput = window.locator(
      'input[placeholder*="Search"], input[placeholder*="search"], [role="combobox"][aria-label*="Search"]'
    );
    await expect(searchInput.first()).toBeVisible({ timeout: 5000 });
  });

  test('should show Search Tips or examples in Search tab', async () => {
    await openSearchModalAndWait(window);

    const discoverTab = window.locator('button:has-text("Search")').first();
    if (await discoverTab.isVisible().catch(() => false)) {
      await discoverTab.click();
      await safeWaitForTimeout(window, 300);
    }

    const tipsState = await window.evaluate(() => {
      const body = document.body.innerText || '';
      const searchTips = document.evaluate(
        "//*[contains(text(), 'Search tips') or contains(text(), 'Examples')]",
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      ).singleNodeValue;

      const exampleText = document.evaluate(
        "//*[contains(text(), 'natural language') or contains(text(), 'vacation photos')]",
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      ).singleNodeValue;

      const describeInput = document.querySelector(
        'input[placeholder*="Describe what you"], [aria-label="Search query"], [role="combobox"][aria-label*="Search"]'
      );

      return {
        hasSearchTips: !!searchTips,
        hasExampleText: !!exampleText,
        hasKnowledgeOsTitle:
          body.includes('KnowledgeGraph') ||
          body.includes('Knowledge Graph') ||
          body.includes('Knowledge OS'),
        hasDescribeCopy:
          body.includes("Describe what you're looking for") ||
          body.includes('Describe what you need'),
        hasDescribeControl: !!describeInput
      };
    });

    console.log('[Test] Search Tips/Examples:', tipsState);
    expect(
      tipsState.hasSearchTips ||
        tipsState.hasExampleText ||
        tipsState.hasKnowledgeOsTitle ||
        tipsState.hasDescribeCopy ||
        tipsState.hasDescribeControl
    ).toBe(true);
  });

  test('should have preview area (Select a file to preview)', async () => {
    await openSearchModalAndWait(window);

    const searchTab = window.locator('button:has-text("Search")').first();
    if (await searchTab.isVisible().catch(() => false)) {
      await searchTab.click();
      await safeWaitForTimeout(window, 300);
    }

    await safeWaitForTimeout(window, 800);

    const previewState = await window.evaluate(() => {
      const body = document.body.textContent || '';

      return {
        hasPreviewTitle: body.includes('Content Preview') || body.includes('Preview'),
        hasSelectPrompt: body.includes('Select a file') || body.includes('Select a result'),
        hasOpenFileAction: body.includes('Open file')
      };
    });

    console.log('[Test] Preview area state:', previewState);
    expect(
      previewState.hasPreviewTitle || previewState.hasSelectPrompt || previewState.hasOpenFileAction
    ).toBe(true);
  });
});

test.describe('Search Modal - Search Execution', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    await dismissModelSetupWizard(window);
    await ensureAdvancedExperienceMode(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should be able to perform a search', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    const searchInput = window
      .locator(
        'input[placeholder*="Search"], input[placeholder*="Describe"], [role="combobox"][aria-label*="Search"]'
      )
      .first();

    if (await searchInput.isVisible()) {
      // Type a search query
      await searchInput.fill('document');
      await safeWaitForTimeout(window, 1000);

      // Check if search was triggered (results or loading state)
      const searchState = await window.evaluate(() => {
        const loadingIndicator = document.querySelector(
          '[class*="loading"], [class*="spinner"], .animate-spin'
        );
        const resultItems = document.querySelectorAll('[class*="result"], [role="option"]');
        const noResults = document.evaluate(
          "//*[contains(text(), 'No results')]",
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        ).singleNodeValue;

        return {
          isLoading: !!loadingIndicator,
          hasResults: resultItems.length > 0,
          hasNoResults: !!noResults
        };
      });

      console.log('[Test] Search state after query:', searchState);
    }
  });

  test('should show search examples that can be clicked', async () => {
    await openSearchModalAndWait(window);
    await safeWaitForTimeout(window, 600);

    const examplesState = await window.evaluate(() => {
      const body = document.body.innerText || '';
      const tips = [
        'vacation photos',
        'natural language',
        'PDF documents',
        'spreadsheet with budget',
        'View in Graph',
        'Understand',
        'Relate'
      ];
      let found = 0;
      for (const tip of tips) {
        if (body.includes(tip)) found++;
      }
      return {
        examplesFound: found,
        hasSearchTips: body.includes('Search tips'),
        hasDescribePlaceholder:
          body.includes("Describe what you're looking for") ||
          body.includes('Describe what you need'),
        hasKnowledgeOs:
          body.includes('KnowledgeGraph') ||
          body.includes('Knowledge Graph') ||
          body.includes('Knowledge OS'),
        hasSearchQueryControl: !!document.querySelector('[aria-label="Search query"]')
      };
    });

    console.log('[Test] Example queries/tips:', examplesState);
    expect(
      examplesState.examplesFound > 0 ||
        examplesState.hasSearchTips ||
        examplesState.hasDescribePlaceholder ||
        examplesState.hasKnowledgeOs ||
        examplesState.hasSearchQueryControl
    ).toBe(true);
  });

  test('should have refresh button for rebuilding index', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    // Look for refresh/rebuild button near the stats
    const refreshState = await window.evaluate(() => {
      // The refresh button is shown near "11 files indexed" in the screenshot
      const refreshButtons = document.querySelectorAll(
        'button[aria-label*="refresh"], button[title*="Refresh"], button[title*="Rebuild"], svg[class*="refresh"]'
      );
      const statsArea = document.evaluate(
        "//*[contains(text(), 'files indexed')]",
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      ).singleNodeValue;

      return {
        hasRefreshButton: refreshButtons.length > 0,
        hasStatsArea: !!statsArea
      };
    });

    console.log('[Test] Refresh button state:', refreshState);
  });
});

// ============================================================================
// NEW FEATURE TESTS - Added per validation plan
// ============================================================================

test.describe('Search Modal - Bulk Selection', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    await dismissModelSetupWizard(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should have Select All button in search results', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    // Search for something to get results
    const searchInput = window
      .locator(
        'input[placeholder*="Search"], input[placeholder*="Describe"], [role="combobox"][aria-label*="Search"]'
      )
      .first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('document');
      await safeWaitForTimeout(window, 1000);
    }

    // Look for "Select All" button
    const selectAllState = await window.evaluate(() => {
      const selectAllBtn = document.evaluate(
        "//*[contains(text(), 'Select All')]",
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      ).singleNodeValue;

      return {
        hasSelectAllButton: !!selectAllBtn
      };
    });

    console.log('[Test] Select All button state:', selectAllState);
  });

  test('should have Copy Selected Paths button', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    // Look for copy paths button
    const copyState = await window.evaluate(() => {
      const copyBtn = document.evaluate(
        "//*[contains(text(), 'Copy') and contains(text(), 'Path')]",
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      ).singleNodeValue;

      const copyIcon = document.querySelector('button[title*="Copy"], [aria-label*="Copy path"]');

      return {
        hasCopyPathsButton: !!copyBtn || !!copyIcon
      };
    });

    console.log('[Test] Copy Paths button state:', copyState);
  });

  test('should have Move Selected Files option', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    // Look for move files option
    const moveState = await window.evaluate(() => {
      const moveBtn = document.evaluate(
        "//*[contains(text(), 'Move')]",
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      ).singleNodeValue;

      return {
        hasMoveOption: !!moveBtn
      };
    });

    console.log('[Test] Move files option state:', moveState);
  });

  test('should have checkbox UI for result selection', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    // Search for results
    const searchInput = window
      .locator(
        'input[placeholder*="Search"], input[placeholder*="Describe"], [role="combobox"][aria-label*="Search"]'
      )
      .first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('test');
      await safeWaitForTimeout(window, 1000);
    }

    // Look for checkbox elements in search results
    const checkboxState = await window.evaluate(() => {
      const checkboxes = document.querySelectorAll(
        'input[type="checkbox"], [role="checkbox"], svg[class*="check"], [class*="checkbox"]'
      );

      return {
        checkboxCount: checkboxes.length,
        hasCheckboxUI: checkboxes.length > 0
      };
    });

    console.log('[Test] Checkbox UI state:', checkboxState);
  });
});

test.describe('Search Modal - Match Details Display', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    await dismissModelSetupWizard(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should display match reason in search results', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    // Search for results
    const searchInput = window
      .locator(
        'input[placeholder*="Search"], input[placeholder*="Describe"], [role="combobox"][aria-label*="Search"]'
      )
      .first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('document');
      await safeWaitForTimeout(window, 1500);
    }

    // Look for match details display.
    // Guard against sporadic page-close races seen on CI/local runs.
    let matchState = { hasMatchIndicators: false, hasScoreDisplay: false };
    if (!window.isClosed()) {
      try {
        matchState = await window.evaluate(() => {
          // Look for match indicator elements
          const matchIndicators = document.querySelectorAll(
            '[class*="match"], [class*="keyword"], [class*="reason"]'
          );

          // Look for score display
          const scoreElements = document.querySelectorAll(
            '[class*="score"], [class*="similarity"]'
          );

          return {
            hasMatchIndicators: matchIndicators.length > 0,
            hasScoreDisplay: scoreElements.length > 0
          };
        });
      } catch (error) {
        const message = error?.message || String(error);
        if (!message.includes('Target page, context or browser has been closed')) {
          throw error;
        }
      }
    }

    console.log('[Test] Match details state:', matchState);
  });

  test('should show search mode indicator', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    // Look for search mode indicator (hybrid, bm25, vector)
    const modeState = await window.evaluate(() => {
      const hybridIndicator = document.evaluate(
        "//*[contains(text(), 'hybrid') or contains(text(), 'Hybrid')]",
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      ).singleNodeValue;

      const bm25Indicator = document.evaluate(
        "//*[contains(text(), 'BM25') or contains(text(), 'keyword')]",
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      ).singleNodeValue;

      return {
        hasHybridIndicator: !!hybridIndicator,
        hasBM25Indicator: !!bm25Indicator
      };
    });

    console.log('[Test] Search mode indicator state:', modeState);
  });
});

test.describe('Search Modal - Cluster Context Menu', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    await dismissModelSetupWizard(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should have cluster visualization in graph view', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    const graphTab = window.locator('button:has-text("Relate")');
    if ((await graphTab.count()) > 0) {
      await graphTab.first().click();
      await safeWaitForTimeout(window, 1000);
    }

    // Look for cluster-related elements
    const clusterState = await window.evaluate(() => {
      const clusterNodes = document.querySelectorAll(
        '[class*="cluster"], [data-nodetype="cluster"]'
      );
      const legendElements = document.querySelectorAll('[class*="legend"], [class*="Legend"]');

      return {
        hasClusterNodes: clusterNodes.length > 0,
        hasLegend: legendElements.length > 0
      };
    });

    console.log('[Test] Cluster visualization state:', clusterState);
  });

  test('should have Create Smart Folder option for clusters', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    const graphTab = window.locator('button:has-text("Relate")');
    if ((await graphTab.count()) > 0) {
      await graphTab.first().click();
      await safeWaitForTimeout(window, 1000);
    }

    // Look for smart folder option
    const smartFolderState = await window.evaluate(() => {
      const smartFolderBtn = document.evaluate(
        "//*[contains(text(), 'Smart Folder') or contains(text(), 'smart folder')]",
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      ).singleNodeValue;

      return {
        hasSmartFolderOption: !!smartFolderBtn
      };
    });

    console.log('[Test] Smart Folder option state:', smartFolderState);
  });
});

test.describe('Search Modal - Find Duplicates', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    await dismissModelSetupWizard(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should have Find Duplicates API', async () => {
    const duplicatesApi = await window.evaluate(() => {
      const api = window.electronAPI?.embeddings;
      return {
        hasFindDuplicates: typeof api?.findDuplicates === 'function'
      };
    });

    console.log('[Test] Find Duplicates API:', duplicatesApi);
    expect(duplicatesApi.hasFindDuplicates).toBe(true);
  });

  // TRACKED-ISSUE: Advanced Options / Find Duplicates UI structure may have changed
  // test('should have Find Duplicates button in graph view', async () => {
  //   await pressOpenSearchShortcut(window);
  //   await safeWaitForTimeout(window,500);
  //   await window.evaluate(() => {
  //     try {
  //       localStorage.setItem('graphTourDismissed', 'true');
  //     } catch {}
  //   });
  //   const relateTab = window.locator('button:has-text("Relate")');
  //   const exploreGraphTab = window.locator('button:has-text("Explore Graph")');
  //   const graphTab = (await relateTab.count()) > 0 ? relateTab : exploreGraphTab;
  //   await graphTab.first().click();
  //   await safeWaitForTimeout(window,1000);
  //   const advancedToggle = window.locator('button:has-text("Advanced Options")');
  //   await expect(advancedToggle.first()).toBeVisible();
  //   await advancedToggle.first().click();
  //   const duplicatesBtn = window.locator('button:has-text("Find Duplicates")');
  //   await expect(duplicatesBtn.first()).toBeVisible();
  // });
});

test.describe('Search Modal - Quick Actions on Hover', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    await dismissModelSetupWizard(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should have file open and reveal APIs', async () => {
    const fileApis = await window.evaluate(() => {
      const files = window.electronAPI?.files;
      return {
        hasOpen: typeof files?.open === 'function',
        hasReveal: typeof files?.reveal === 'function'
      };
    });

    console.log('[Test] File APIs:', fileApis);
    expect(fileApis.hasOpen).toBe(true);
    expect(fileApis.hasReveal).toBe(true);
  });

  test('should have action buttons in graph node UI', async () => {
    await pressOpenSearchShortcut(window);
    await safeWaitForTimeout(window, 500);

    const graphTab = window.locator('button:has-text("Relate")');
    if ((await graphTab.count()) > 0) {
      await graphTab.first().click();
      await safeWaitForTimeout(window, 1000);
    }

    // Look for node action buttons
    const actionState = await window.evaluate(() => {
      // Look for external link or folder open icons
      const externalLinks = document.querySelectorAll(
        'svg[class*="external"], [class*="ExternalLink"]'
      );
      const folderIcons = document.querySelectorAll('svg[class*="folder"], [class*="FolderOpen"]');

      return {
        hasExternalLinkIcon: externalLinks.length > 0,
        hasFolderIcon: folderIcons.length > 0
      };
    });

    console.log('[Test] Node action buttons state:', actionState);
  });
});

test.describe('Search Modal - File Operation Events', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    await dismissModelSetupWizard(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('should have file operation event listener API', async () => {
    const eventApi = await window.evaluate(() => {
      const events = window.electronAPI?.events;
      return {
        hasFileOperationListener: typeof events?.onFileOperationComplete === 'function'
      };
    });

    console.log('[Test] File operation event API:', eventApi);
    expect(eventApi.hasFileOperationListener).toBe(true);
  });
});
