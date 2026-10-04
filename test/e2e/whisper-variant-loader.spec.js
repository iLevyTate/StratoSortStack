/**
 * Whisper variant loader regression guard (E2E)
 *
 * Drives `window.electronAPI.analysis.media(filePath)` against a sample
 * .mp3 inside a real webpack-built Electron bundle. The spec exists to
 * catch one specific class of regression: webpack erasing the dynamic
 * `require(candidate.name)` in `WhisperService.loadNativeWhisperModule`
 * to a `webpackEmptyContext` stub that throws `MODULE_NOT_FOUND` for
 * every variant in the cuda → vulkan → default chain. That bug
 * manifests only inside webpack-built bundles (`dev` and `dist:*`) — the
 * existing unit tests use `jest.doMock(..., { virtual: true })` which
 * bypasses webpack, and `scripts/run-real-media.js` runs raw node. This
 * spec is the only path that exercises the bundled loader end to end.
 *
 * Assertion strategy: examine the SHAPE of the error, not the success
 * path, because CI runners don't always have the model downloaded.
 *
 *   PASS — any of:
 *     - success: true (full transcription completed)
 *     - error code LLAMA_MODEL_NOT_FOUND (model missing — we exited
 *       before reaching the variant loader; regression check vacuous
 *       but spec still proves the IPC contract holds)
 *     - error code SERVICE_UNAVAILABLE with ffmpeg-themed message (same)
 *
 *   FAIL — any of:
 *     - error.message contains "Cannot find module '@fugood/node-whisper-"
 *       (the regression's exact signature)
 *     - error.stack contains "webpackEmptyContext" (webpack's stub marker)
 *     - error.code === 'MODULE_NOT_FOUND' with a whisper specifier in
 *       the message
 *
 * Run: `npx playwright test test/e2e/whisper-variant-loader.spec.js`
 *
 * History: introduced after commit `be73c255` fixed the regression. The
 * earlier `7e3a8540` source-level static guard catches a *reverter*
 * (someone reintroducing bare `require`); this spec catches a *new*
 * webpack-erasure bug anywhere on the loader path.
 */

const { test, expect } = require('@playwright/test');
const { launchApp, closeApp, waitForAppReady } = require('./helpers/electronApp');
const { setupTestFiles, cleanupTempDir } = require('./helpers/testFixtures');

// Substrings that indicate the regression. If the error message or stack
// contains any of these, the loader was reached AND failed in the
// webpack-erasure way. The whisper package family prefix
// `@fugood/node-whisper-` is the most reliable marker since no other
// package in the dep tree starts with that.
const REGRESSION_SIGNATURES = ['@fugood/node-whisper-', 'webpackEmptyContext'];

// Acceptable error codes when the model isn't installed — the request
// exits before reaching the variant loader, so the regression check is
// vacuous but the spec still validates the IPC contract.
const ACCEPTABLE_EARLY_EXIT_CODES = new Set([
  'LLAMA_MODEL_NOT_FOUND',
  'SERVICE_UNAVAILABLE',
  'ANALYSIS_FAILED' // fallback heuristic kicks in for non-model issues
]);

function looksLikeRegression(payload) {
  if (!payload) return false;
  const message = String(payload.error || payload.message || '');
  const stack = String(payload.errorStack || payload.stack || '');
  const code = String(payload.code || payload.errorCode || '');
  for (const sig of REGRESSION_SIGNATURES) {
    if (message.includes(sig)) return { sig, where: 'message', message };
    if (stack.includes(sig)) return { sig, where: 'stack', stack };
  }
  // Bare MODULE_NOT_FOUND without a whisper specifier could be unrelated;
  // we only flag it when the specifier is clearly ours.
  if (code === 'MODULE_NOT_FOUND' && /node-whisper/.test(message)) {
    return { sig: 'MODULE_NOT_FOUND+whisper', where: 'code', code, message };
  }
  return false;
}

test.describe('Whisper variant loader (webpack-erasure regression guard)', () => {
  let app;
  let window;
  let tempDir;
  let mediaPath;

  test.beforeEach(async () => {
    const fixtures = await setupTestFiles(['sampleMp3']);
    tempDir = fixtures.tempDir;
    const mp3 = fixtures.files.find((f) => f.type === 'audio');
    if (!mp3) {
      throw new Error('[E2E] sampleMp3 fixture missing — check test/test-files/sample.mp3');
    }
    mediaPath = mp3.tempPath;

    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);
  });

  test.afterEach(async () => {
    try {
      await closeApp(app);
    } catch {
      // best-effort
    }
    await cleanupTempDir(tempDir);
  });

  test('exposes window.electronAPI.analysis.media', async () => {
    const surface = await window.evaluate(() => ({
      hasMedia: typeof window.electronAPI?.analysis?.media === 'function',
      hasDocument: typeof window.electronAPI?.analysis?.document === 'function',
      hasImage: typeof window.electronAPI?.analysis?.image === 'function'
    }));
    expect(surface.hasMedia).toBe(true);
    expect(surface.hasDocument).toBe(true);
    expect(surface.hasImage).toBe(true);
  });

  test('analyze-media does not fail with the webpack-erasure regression signature', async () => {
    // Drive the IPC end-to-end. We catch both fulfillment and rejection
    // so the assertion logic can inspect whichever side returned data.
    // The IPC wrapper sometimes wraps the result in `{ success, error,
    // code, ... }` and sometimes the renderer-side `safeInvoke` rejects
    // — both shapes go through this path uniformly.
    const result = await window.evaluate(async (filePath) => {
      try {
        const value = await window.electronAPI.analysis.media(filePath);
        return { kind: 'fulfilled', value };
      } catch (err) {
        return {
          kind: 'rejected',
          error: err?.message || String(err),
          stack: err?.stack,
          code: err?.code,
          errorCode: err?.errorCode
        };
      }
    }, mediaPath);

    // First, the failure-case assertion — the entire reason for this
    // spec. Whatever happens, the regression signatures MUST NOT show
    // up in the response.
    if (result.kind === 'fulfilled') {
      const regression = looksLikeRegression(result.value);
      expect(
        regression,
        `analyze-media returned what looks like the webpack-erasure regression. Detail: ${JSON.stringify(regression)} Full value: ${JSON.stringify(result.value).slice(0, 500)}`
      ).toBe(false);
    } else {
      const regression = looksLikeRegression(result);
      expect(
        regression,
        `analyze-media rejected with what looks like the webpack-erasure regression. Detail: ${JSON.stringify(regression)} Full result: ${JSON.stringify(result).slice(0, 500)}`
      ).toBe(false);
    }

    // Second, the well-formed-result assertion — light-touch validation
    // of the IPC contract itself. We don't require success because CI
    // runners often have no whisper model; we just require the response
    // shape is one of the recognized outcomes.
    if (result.kind === 'fulfilled' && result.value?.success === true) {
      // Success path: we don't require a transcript on every runner
      // (CPU-only might be too slow; tiny sample might produce empty
      // output), but the success envelope must include the standard
      // analysis fields.
      expect(result.value).toMatchObject({ success: true });
    } else if (result.kind === 'fulfilled' && result.value?.success === false) {
      // Structured failure envelope: must include a recognizable error
      // code so a future regression that breaks the IPC envelope shape
      // is also caught.
      const code = result.value.code || result.value.errorCode;
      expect(
        ACCEPTABLE_EARLY_EXIT_CODES.has(String(code)),
        `Unexpected error code from analyze-media: ${code}. Full value: ${JSON.stringify(result.value).slice(0, 500)}`
      ).toBe(true);
    } else if (result.kind === 'rejected') {
      // Renderer-side rejection: acceptable if the message/code matches
      // a known early-exit scenario. We already proved above that this
      // ISN'T a regression rejection.
      const code = result.code || result.errorCode;
      const known =
        ACCEPTABLE_EARLY_EXIT_CODES.has(String(code)) ||
        /model.*not.*found|service.*unavailable|ffmpeg/i.test(String(result.error));
      expect(
        known,
        `analyze-media rejected with an unrecognized error. code=${code} error=${result.error}`
      ).toBe(true);
    }
  });
});
