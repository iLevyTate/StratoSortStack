/**
 * Smoke: Downloads triage IPC exposed to renderer (no full triage UI walkthrough).
 */
const { test, expect } = require('@playwright/test');
const { launchApp, closeApp, waitForAppReady } = require('./helpers/electronApp');

test.describe('Downloads triage API', () => {
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

  test('exposes downloads triage start/act/deep-scan on electronAPI', async () => {
    const apis = await window.evaluate(() => {
      const t = window.electronAPI?.downloads?.triage;
      return {
        hasStart: typeof t?.start === 'function',
        hasAct: typeof t?.act === 'function',
        hasDeepScan: typeof t?.deepScan === 'function'
      };
    });
    expect(apis.hasStart).toBe(true);
    expect(apis.hasAct).toBe(true);
    expect(apis.hasDeepScan).toBe(true);
  });
});
