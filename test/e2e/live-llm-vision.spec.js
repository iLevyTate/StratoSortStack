/**
 * @live-llm — Vision model analysis on a real image fixture.
 *
 * Run: npm run test:e2e:live-llm -- test/e2e/live-llm-vision.spec.js
 * with STRATOSORT_E2E_MODELS_DIR set to a folder of .gguf models; without it
 * the isolated profile has no models and the spec skips.
 */

const { test, expect } = require('@playwright/test');
const fs = require('fs/promises');
const { launchApp, closeApp, waitForAppReady } = require('./helpers/electronApp');
const { STRATO_TEST_FILES, TIMEOUTS } = require('./helpers/testFixtures');
const {
  waitForLoadedVisionModel,
  normalizeAnalysisPayload,
  assertAnalysisRoutingSignal
} = require('./helpers/liveLlm');

const IMAGE_FIXTURE = STRATO_TEST_FILES.pngImage;

test.describe('@live-llm Vision image analysis', () => {
  let app;
  let window;

  test.beforeAll(async () => {
    const result = await launchApp({ localModels: true });
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
  });

  test.afterAll(async () => {
    await closeApp(app);
  });

  test('returns summary or category from analysis.image on a PNG fixture', async () => {
    test.setTimeout(TIMEOUTS.VERY_LONG * 2);

    const visionReady = await waitForLoadedVisionModel(window);
    if (!visionReady) {
      test.skip(
        true,
        'No vision model in the profile: set STRATOSORT_E2E_MODELS_DIR to a folder of .gguf models.'
      );
    }

    await fs.access(IMAGE_FIXTURE.path);

    const analyzed = await window.evaluate(async (imagePath) => {
      try {
        const api = window.electronAPI?.analysis;
        if (!api || typeof api.image !== 'function') {
          return { ok: false, reason: 'analysis.image unavailable' };
        }
        const res = await api.image(imagePath);
        return { ok: true, res };
      } catch (err) {
        return { ok: false, reason: err?.message || String(err) };
      }
    }, IMAGE_FIXTURE.path);

    expect(analyzed.ok, analyzed.reason).toBe(true);
    const analysis = normalizeAnalysisPayload(analyzed.res);
    assertAnalysisRoutingSignal(analysis);

    const hasDescription = Boolean(
      analysis.summary ||
      analysis.description ||
      (Array.isArray(analysis.keywords) && analysis.keywords.length > 0) ||
      analysis.category
    );
    expect(hasDescription, JSON.stringify(analysis)).toBe(true);
  });
});
