/**
 * AI Provider Configuration E2E Tests (T24)
 *
 * Verifies the multi-provider AI flow end-to-end through the real preload
 * bridge: paste API key → key persisted → set default → routing applied →
 * verify badge state → revert → badge gone.
 *
 * Network-dependent steps (testProvider against real Anthropic/OpenAI) are
 * intentionally skipped — the unit tests under test/unit/ai/providers/
 * cover wire-format handling with mocked HTTP. This e2e exercises the
 * IPC bridge, persistence, and renderer-state plumbing that unit tests
 * can't.
 *
 * Run: npm run test:e2e -- --grep "AI Provider"
 */

const { test, expect } = require('@playwright/test');
const { launchApp, closeApp, waitForAppReady } = require('./helpers/electronApp');

test.describe('AI Provider — IPC bridge', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
  });

  test.afterEach(async () => {
    // Best-effort cleanup: clear any test API key we may have set.
    try {
      await window.evaluate(async () => {
        await window.electronAPI?.aiProvider?.acknowledgeCloud?.();
        await window.electronAPI?.aiProvider?.removeKey?.('anthropic');
        await window.electronAPI?.aiProvider?.setRouting?.({ default: 'local' });
      });
    } catch {
      // ignore cleanup failures
    }
    await closeApp(app);
  });

  test('exposes the aiProvider bridge on window.electronAPI', async () => {
    const surface = await window.evaluate(() => ({
      hasGetConfig: typeof window.electronAPI?.aiProvider?.getConfig === 'function',
      hasSetKey: typeof window.electronAPI?.aiProvider?.setKey === 'function',
      hasGetKeyStatus: typeof window.electronAPI?.aiProvider?.getKeyStatus === 'function',
      hasRemoveKey: typeof window.electronAPI?.aiProvider?.removeKey === 'function',
      hasTestProvider: typeof window.electronAPI?.aiProvider?.testProvider === 'function',
      hasSetRouting: typeof window.electronAPI?.aiProvider?.setRouting === 'function',
      hasGetUsage: typeof window.electronAPI?.aiProvider?.getUsage === 'function',
      hasOnStatusChanged: typeof window.electronAPI?.aiProvider?.onStatusChanged === 'function'
    }));

    expect(surface.hasGetConfig).toBe(true);
    expect(surface.hasSetKey).toBe(true);
    expect(surface.hasGetKeyStatus).toBe(true);
    expect(surface.hasRemoveKey).toBe(true);
    expect(surface.hasTestProvider).toBe(true);
    expect(surface.hasSetRouting).toBe(true);
    expect(surface.hasGetUsage).toBe(true);
    expect(surface.hasOnStatusChanged).toBe(true);
  });

  test('getConfig returns the default config (local provider only)', async () => {
    const config = await window.evaluate(async () => window.electronAPI.aiProvider.getConfig());

    expect(config.settings.providers.local.enabled).toBe(true);
    expect(config.settings.routing.default).toBe('local');
    expect(Array.isArray(config.status.providers)).toBe(true);
  });

  test('getUsage returns zero usage when no calls have been recorded', async () => {
    const usage = await window.evaluate(async () => window.electronAPI.aiProvider.getUsage());

    expect(usage.thisMonth.anthropic.estCostUsd).toBe(0);
    expect(usage.thisMonth.openaiCompatible.estCostUsd).toBe(0);
  });

  test('setKey + getKeyStatus round-trip: paste a key and verify it is stored', async () => {
    const result = await window.evaluate(async () => {
      await window.electronAPI.aiProvider.acknowledgeCloud();
      await window.electronAPI.aiProvider.setKey('anthropic', 'sk-ant-test-1234567890abcdef', {
        allowPlaintext: true
      });
      return window.electronAPI.aiProvider.getKeyStatus('anthropic');
    });

    expect(result.hasKey).toBe(true);
    // Last 4 chars of the test key are 'cdef'
    expect(result.lastFour).toBe('cdef');
  });

  test('removeKey clears the stored key', async () => {
    const result = await window.evaluate(async () => {
      await window.electronAPI.aiProvider.acknowledgeCloud();
      await window.electronAPI.aiProvider.setKey('anthropic', 'sk-ant-test-XYZW', {
        allowPlaintext: true
      });
      const before = await window.electronAPI.aiProvider.getKeyStatus('anthropic');
      await window.electronAPI.aiProvider.removeKey('anthropic');
      const after = await window.electronAPI.aiProvider.getKeyStatus('anthropic');
      return { before, after };
    });

    expect(result.before.hasKey).toBe(true);
    expect(result.after.hasKey).toBe(false);
    expect(result.after.lastFour).toBeNull();
  });

  test('setRouting applies the new default and survives a getConfig round-trip', async () => {
    const result = await window.evaluate(async () => {
      await window.electronAPI.aiProvider.acknowledgeCloud();
      await window.electronAPI.aiProvider.setKey('anthropic', 'sk-ant-test-routing', {
        allowPlaintext: true
      });
      await window.electronAPI.aiProvider.setProviderConfig('anthropic', { enabled: true });
      await window.electronAPI.aiProvider.setRouting({ default: 'anthropic' });
      return window.electronAPI.aiProvider.getConfig();
    });

    expect(result.settings.routing.default).toBe('anthropic');
  });

  test('per-folder override persists via setRouting and clears when set to null', async () => {
    const result = await window.evaluate(async () => {
      await window.electronAPI.aiProvider.acknowledgeCloud();
      await window.electronAPI.aiProvider.setKey('anthropic', 'sk-ant-folder-test', {
        allowPlaintext: true
      });
      await window.electronAPI.aiProvider.setProviderConfig('anthropic', { enabled: true });

      // Set override
      await window.electronAPI.aiProvider.setRouting({
        perFolder: { 'folder-x': 'anthropic' }
      });
      const set = await window.electronAPI.aiProvider.getConfig();

      // Clear override via null
      await window.electronAPI.aiProvider.setRouting({
        perFolder: { 'folder-x': null }
      });
      const cleared = await window.electronAPI.aiProvider.getConfig();

      return {
        setValue: set.settings.routing.perFolder['folder-x'],
        clearedValue: cleared.settings.routing.perFolder['folder-x']
      };
    });

    expect(result.setValue).toBe('anthropic');
    expect(result.clearedValue).toBeUndefined();
  });

  test('testProvider against an unconfigured provider fails cleanly', async () => {
    // No key configured yet — testProvider should report not ready
    const result = await window.evaluate(async () => {
      try {
        return await window.electronAPI.aiProvider.testProvider('openaiCompatible');
      } catch (e) {
        return { thrown: true, message: e.message };
      }
    });

    // Either the call returns a structured failure or throws — both are
    // acceptable; the contract is that it does NOT silently succeed and does
    // NOT leak the (missing) key.
    if (result.thrown) {
      expect(result.message).toBeTruthy();
      expect(result.message).not.toMatch(/sk-/);
    } else {
      expect(result.ok).toBeFalsy();
    }
  });
});

test.describe('AI Provider — Settings UI', () => {
  let app;
  let window;

  test.beforeEach(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
  });

  test.afterEach(async () => {
    try {
      await window.evaluate(async () => {
        await window.electronAPI?.aiProvider?.acknowledgeCloud?.();
        await window.electronAPI?.aiProvider?.removeKey?.('anthropic');
        await window.electronAPI?.aiProvider?.setRouting?.({ default: 'local' });
      });
    } catch {
      // ignore cleanup failures
    }
    await closeApp(app);
  });

  test('AIProviderBadge is hidden when default routing is local', async () => {
    await window.evaluate(async () => {
      await window.electronAPI.aiProvider.acknowledgeCloud();
      await window.electronAPI.aiProvider.setRouting({ default: 'local' });
    });
    await window.waitForTimeout(200);

    const hasBadge = await window.evaluate(() => {
      return Boolean(document.querySelector('[role="status"][aria-label^="Cloud AI —"]'));
    });
    expect(hasBadge).toBe(false);
  });
});
