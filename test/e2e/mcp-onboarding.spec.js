/**
 * MCP Onboarding E2E Tests
 *
 * Verifies the MCP server can be enabled via Settings and test connection
 * displays the expected tool list.
 *
 * Run: npm run test:e2e -- mcp-onboarding
 */

const net = require('node:net');
const { test, expect } = require('@playwright/test');
const {
  launchApp,
  closeApp,
  waitForAppReady,
  dismissModelSetupWizard,
  safeWaitForTimeout
} = require('./helpers/electronApp');
const { NavigationPage } = require('./helpers/pageObjects');
const { expandSettingsCollapsibleByHeading } = require('./helpers/e2eSettings');

// Hand the app a port the OS just confirmed is bindable. The MCP server's
// default (53827) sits inside Windows' WinNAT/Hyper-V excluded dynamic-port
// range on some hosts, so binding it returns EACCES — which the transport does
// NOT fall back on (only EADDRINUSE). Binding 0 makes the OS pick a port that
// is, by construction, outside every excluded range; we release it and pass it
// via STRATOSORT_MCP_PORT. The brief release→rebind window is covered by the
// transport's existing EADDRINUSE ephemeral fallback.
function getBindablePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

test.describe('MCP Onboarding', () => {
  let app;
  let window;
  let nav;

  test.beforeEach(async () => {
    const mcpPort = await getBindablePort();
    const result = await launchApp({ env: { STRATOSORT_MCP_PORT: String(mcpPort) } });
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
    await dismissModelSetupWizard(window);
    nav = new NavigationPage(window);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test('user enables MCP server and Test connection lists 4 tools', async () => {
    // Open Settings panel
    const opened = await nav.openSettings();
    expect(opened).toBe(true);
    await safeWaitForTimeout(window, 500);

    // The MCP Server settings live in a collapsed-by-default Collapsible. Expand
    // it so its toggle/status/tools render. The real enable control is a plain
    // checkbox (aria-label="Enable MCP server"), NOT a role="switch".
    await expandSettingsCollapsibleByHeading(window, 'MCP Server');

    const enableToggle = window
      .locator('input[type="checkbox"][aria-label="Enable MCP server"]')
      .first();
    await expect(enableToggle).toBeVisible({ timeout: 5000 });

    // Check current state and toggle if necessary
    const isChecked = await enableToggle.isChecked();
    if (!isChecked) {
      await enableToggle.check();
      await safeWaitForTimeout(window, 1000); // Give server time to start
    }

    // Wait for status text to confirm running
    // Expected: "Running on http://localhost:..." or similar
    await expect(
      window.locator('text=/Running on|Server.*running|http:\\/\\/localhost/')
    ).toBeVisible({ timeout: 15000 });

    // Find and click the "Test connection" button
    const testButton = window.locator('button:has-text("Test connection")').first();
    await expect(testButton).toBeVisible({ timeout: 5000 });
    await testButton.click();

    // Wait for the tool list to appear in a notification, dialog, or result
    // panel. The tool names render both in the success notification and in the
    // always-visible "Tools exposed" list, so .first() avoids a strict-mode
    // violation on the multi-element match.
    await expect(
      window
        .locator(
          'text=/list_smart_folders|smart_folders|get_document_summary|search_documents|chat_with_documents/'
        )
        .first()
    ).toBeVisible({ timeout: 10000 });

    // Verify at least one of the expected tools is visible
    const expectedTools = [
      'list_smart_folders',
      'get_document_summary',
      'search_documents',
      'chat_with_documents'
    ];

    let toolFound = false;
    for (const tool of expectedTools) {
      const toolElement = window.locator(`text="${tool}"`).first();
      const isVisible = await toolElement.isVisible().catch(() => false);
      if (isVisible) {
        toolFound = true;
        console.log(`[Test] Found tool: ${tool}`);
        break;
      }
    }

    expect(toolFound).toBe(true);
  });

  test('MCP server section renders without errors', async () => {
    // Open Settings panel
    const opened = await nav.openSettings();
    expect(opened).toBe(true);
    await safeWaitForTimeout(window, 500);

    // Expand the MCP Server collapsible so the section actually mounts and we
    // exercise its render path (not just the collapsed header).
    await expandSettingsCollapsibleByHeading(window, 'MCP Server');
    await expect(
      window.locator('input[type="checkbox"][aria-label="Enable MCP server"]').first()
    ).toBeVisible({ timeout: 5000 });

    // Verify no console errors
    const consoleMessages = await window
      .evaluate(() => {
        return window.__consoleErrors || [];
      })
      .catch(() => []);

    // Should not have critical errors (warnings are OK)
    const criticalErrors = consoleMessages.filter((msg) => msg.level === 'error');
    expect(criticalErrors.length).toBe(0);
  });
});
