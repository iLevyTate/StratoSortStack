/**
 * "Reanalyze all" with the local models: does the embedding pipeline record
 * errors, and why?
 *
 * A reanalysis of a full library logged a steady 25% embedding error rate
 * from the moment "Reanalyze all" started, while analysis through Discover
 * recorded none. This puts a few files inside a Smart Folder (3D models
 * first, as in that run), runs Reanalyze all, waits for the Smart Folder
 * watcher to finish and reports the embedding pipeline's outcomes and error
 * reasons. Writes test-results/reanalyze-embedding-errors/report.json.
 *
 * Run (Windows, from the repo root, after `npm run build`):
 *   $env:STRATOSORT_E2E_REANALYZE_EMBEDDINGS='1'
 *   $env:STRATOSORT_E2E_MODELS_DIR="$env:APPDATA\StratoSort Stack\models"
 *   npx playwright test test/e2e/manual/reanalyze-embedding-errors.spec.js --retries=0
 */

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs/promises');
const { launchApp, closeApp, waitForAppReady } = require('../helpers/electronApp');
const { createTempDir, cleanupTempDir } = require('../helpers/testFixtures');
const { waitForLoadedTextModel } = require('../helpers/liveLlm');

const ENABLED = process.env.STRATOSORT_E2E_REANALYZE_EMBEDDINGS === '1';
const REPORT_DIR = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'test-results',
  'reanalyze-embedding-errors'
);

/** An ASCII STL: a few triangles and next to no words. */
function asciiStl(name, facets) {
  const lines = [`solid ${name}`];
  for (let i = 0; i < facets; i += 1) {
    lines.push(
      '  facet normal 0 0 1',
      '    outer loop',
      `      vertex ${i} 0 0`,
      `      vertex ${i + 1} 0 0`,
      `      vertex ${i} 1 0`,
      '    endloop',
      '  endfacet'
    );
  }
  lines.push(`endsolid ${name}`);
  return lines.join('\n');
}

async function writeLibrary(dir) {
  await fs.mkdir(dir, { recursive: true });
  const files = {
    '17-round-2025-05-27.stl': asciiStl('round', 40),
    '1mm-1-2025-05-30.stl': asciiStl('spacer', 12),
    '2.stl': asciiStl('part', 4),
    'bracket-notes.txt':
      'Notes on the shelf bracket print: PETG, 0.2 mm layers, 30% infill, supports off.',
    'print-log.csv':
      'date,model,minutes,filament_g\n2026-11-01,bracket,95,41\n2026-11-03,spacer,12,3\n',
    'empty-notes.txt': ''
  };
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), content, 'utf8');
  }
  return Object.keys(files);
}

test.describe('Reanalyze all: embedding outcomes (real models)', () => {
  test.skip(!ENABLED, 'Set STRATOSORT_E2E_REANALYZE_EMBEDDINGS=1 to run.');

  let app;
  let window;
  let workDir;

  test.afterAll(async () => {
    if (app) await closeApp(app);
    if (workDir) await cleanupTempDir(workDir);
  });

  test('records why embeddings fail during Reanalyze all', async () => {
    test.setTimeout(30 * 60_000);
    ({ app, window } = await launchApp({ localModels: true }));
    await waitForAppReady(window);
    const modelReady = await waitForLoadedTextModel(window);
    test.skip(!modelReady, 'No text model: set STRATOSORT_E2E_MODELS_DIR.');

    workDir = await createTempDir('stratosort-reanalyze-');
    const folderPath = path.join(workDir, '3D print');
    const names = await writeLibrary(folderPath);

    const added = await window.evaluate(
      async (p) =>
        window.electronAPI.smartFolders.add({
          name: '3D print',
          path: p,
          description: '3D printer models (STL) and print notes'
        }),
      folderPath
    );
    expect(added?.success, JSON.stringify(added)).toBe(true);

    const metrics = async () =>
      window.evaluate(async () => (await window.electronAPI.system.getMetrics())?.pipeline);
    const before = await metrics();

    const started = Date.now();
    const reanalyze = await window.evaluate(async () =>
      window.electronAPI.embeddings.reanalyzeAll({})
    );
    console.log('[reanalyze] started:', JSON.stringify(reanalyze).slice(0, 300));

    // Wait for the watcher to take the files and finish them.
    let status = null;
    let sawWork = false;
    while (Date.now() - started < 20 * 60_000) {
      await new Promise((r) => setTimeout(r, 5000));
      status = await window.evaluate(async () => window.electronAPI.smartFolders.watcherStatus());
      const s = status?.status || status;
      const busy = (Number(s?.queueLength) || 0) + (Number(s?.processingCount) || 0);
      if (busy > 0) sawWork = true;
      if (sawWork && busy === 0) break;
      if (!sawWork && Date.now() - started > 120_000) break;
    }
    const after = await metrics();

    const report = {
      files: names,
      reanalyze,
      watcherStatus: status,
      seconds: Math.round((Date.now() - started) / 1000),
      embeddingBefore: before?.embedding || null,
      embeddingAfter: after?.embedding || null,
      documentAfter: after?.document || null
    };
    await fs.mkdir(REPORT_DIR, { recursive: true });
    await fs.writeFile(path.join(REPORT_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log('[reanalyze] embedding after:', JSON.stringify(after?.embedding, null, 1));
    expect(after?.embedding, 'embedding pipeline metrics').toBeTruthy();
  });
});
