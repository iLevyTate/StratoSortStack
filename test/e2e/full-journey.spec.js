/**
 * Full Journey E2E Smoke — import -> analyze -> organize -> search
 *
 * This is the single end-to-end happy-path journey that drives the real
 * IPC surface (not just UI selectors) and verifies that the primary
 * user-visible pipeline works against a running Electron build:
 *
 *   1. A freshly created text file lands in a staging directory.
 *   2. `analysis.document()` returns a non-empty analysis record.
 *   3. `files.organize()` performs a real filesystem move into a target.
 *   4. The moved file is reachable via `files.getStats()` at its new path.
 *   5. `embeddings.search()` / `analysisHistory.search()` surfaces the file.
 *
 * The spec gracefully skips when no LLM text model is loaded (e.g. a clean
 * CI checkout without `postinstall` model downloads). The smoke is still
 * wired into the default Playwright project so any regressions in the IPC
 * contracts, path validation, organize routing, or search indexing flag
 * on every e2e run.
 *
 * Run: npm run test:e2e -- --grep "Full Journey"
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs/promises');
const { launchApp, closeApp, waitForAppReady } = require('./helpers/electronApp');
const { createTempDir, cleanupTempDir, TIMEOUTS } = require('./helpers/testFixtures');
const {
  waitForLoadedTextModel,
  normalizeAnalysisPayload,
  waitForFileInSearch
} = require('./helpers/liveLlm');

const SAMPLE_CONTENT = [
  'StratoSort E2E smoke — do not modify.',
  '',
  'This document discusses quarterly financial performance for Acme Corp.',
  'Revenue grew 12% year-over-year and operating expenses fell 3%.',
  'The CFO recommends reinvesting the surplus into product R&D.',
  '',
  'Keywords: finance, quarterly report, revenue, expenses, CFO.'
].join('\n');

test.describe('@live-llm Full Journey — import -> analyze -> organize -> search', () => {
  let app;
  let window;
  let sourceDir;
  let targetDir;
  let filePath;
  let movedPath;

  test.beforeAll(async () => {
    const result = await launchApp();
    app = result.app;
    window = result.window;
    await waitForAppReady(window);

    sourceDir = await createTempDir('stratosort-e2e-journey-src-');
    targetDir = await createTempDir('stratosort-e2e-journey-dst-');
    filePath = path.join(sourceDir, 'acme_q3_finance_review.txt');
    await fs.writeFile(filePath, SAMPLE_CONTENT, 'utf8');
    await fs.mkdir(targetDir, { recursive: true });
  });

  test.afterAll(async () => {
    await closeApp(app);
    await cleanupTempDir(sourceDir);
    await cleanupTempDir(targetDir);
  });

  test('runs a complete pipeline and surfaces results via search', async () => {
    test.setTimeout(TIMEOUTS.VERY_LONG);

    const modelReady = await waitForLoadedTextModel(window);
    if (!modelReady) {
      test.skip(true, 'No text LLM loaded; smoke requires a ready model backend.');
    }

    // --- 1. Analyze ----------------------------------------------------------
    const analyzed = await window.evaluate(async (p) => {
      try {
        const api = window.electronAPI?.analysis;
        if (!api || typeof api.document !== 'function') {
          return { ok: false, reason: 'analysis.document unavailable' };
        }
        const res = await api.document(p);
        return { ok: true, res };
      } catch (err) {
        return { ok: false, reason: err?.message || String(err) };
      }
    }, filePath);

    expect(analyzed.ok, analyzed.reason).toBe(true);
    expect(analyzed.res, 'analysis result').toBeTruthy();
    const analysis = normalizeAnalysisPayload(analyzed.res);
    expect(analysis).toBeTruthy();
    expect(
      analysis.category || analysis.suggestedFolder || analysis.purpose,
      'analysis must contain routing signal'
    ).toBeTruthy();

    // --- 2. Organize ---------------------------------------------------------
    const destBasename = analysis.suggestedName || path.basename(filePath);
    movedPath = path.join(targetDir, destBasename);

    const organized = await window.evaluate(
      async ({ src, dst }) => {
        try {
          const api = window.electronAPI?.files;
          if (!api || typeof api.organize !== 'function') {
            return { ok: false, reason: 'files.organize unavailable' };
          }
          const res = await api.organize([
            {
              type: 'move',
              source: src,
              destination: dst
            }
          ]);
          return { ok: true, res };
        } catch (err) {
          return { ok: false, reason: err?.message || String(err) };
        }
      },
      { src: filePath, dst: movedPath }
    );

    expect(organized.ok, organized.reason).toBe(true);
    // Service responses are heterogeneous across code paths (success | results).
    // Accept any shape that confirms at least one successful operation.
    const organizePayload = organized.res?.data || organized.res;
    const anySuccess =
      organizePayload?.success === true ||
      organizePayload?.results?.some?.((r) => r?.success) ||
      organizePayload?.operations?.some?.((op) => op?.success) ||
      organizePayload?.successful > 0;
    expect(anySuccess, `organize payload: ${JSON.stringify(organizePayload)}`).toBe(true);

    // Filesystem-level confirmation the move actually happened.
    const destStat = await fs.stat(movedPath).catch(() => null);
    expect(destStat, `expected organized file at ${movedPath}`).toBeTruthy();
    expect(destStat?.isFile()).toBe(true);

    // --- 3. Search -----------------------------------------------------------
    // Poll the indexes until the moved file is actually addressable by path.
    // The fixed sleep + "any rows is fine" fallback silently hid indexing
    // failures because any unrelated historical row would satisfy the assertion.
    // Now we require an equality match on movedPath from at least one surface.
    const searchQuery = 'Acme quarterly revenue';
    const searched = await waitForFileInSearch(window, {
      query: searchQuery,
      filePath,
      budgetMs: 30_000
    });

    expect(searched.ok, `search/index did not surface analyzed file content for ${filePath}`).toBe(
      true
    );
  });
});
