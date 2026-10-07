#!/usr/bin/env node

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { _electron: electron } = require('@playwright/test');

const repoRoot = path.resolve(__dirname, '../..');
const electronBinary = require('electron');
const mainEntryRelative = './src/main/simple-main.js';

function parseArgs(argv) {
  const args = {};
  for (const token of argv) {
    if (!token.startsWith('--')) continue;
    const [key, value = 'true'] = token.slice(2).split('=');
    args[key] = value;
  }
  return args;
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toMb(bytes) {
  return Number((bytes / (1024 * 1024)).toFixed(2));
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function listFilesRecursively(rootDir) {
  const results = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

async function waitForAppReady(window, timeoutMs = 45000) {
  await window.waitForSelector('nav[aria-label="Phase navigation"]', {
    state: 'visible',
    timeout: timeoutMs
  });
}

async function getMainAndRendererMemory(app) {
  return app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    let renderer = null;
    if (win?.webContents?.getProcessMemoryInfo) {
      try {
        renderer = await win.webContents.getProcessMemoryInfo();
      } catch {
        renderer = null;
      }
    }
    return {
      mainProcess: {
        rss: process.memoryUsage().rss,
        heapUsed: process.memoryUsage().heapUsed
      },
      renderer
    };
  });
}

async function startBatchInRenderer(window, payload) {
  return window.evaluate(async (data) => {
    window.__ssBench = {
      startedAt: Date.now(),
      done: false,
      progress: [],
      errors: [],
      readyQueueSamples: []
    };

    try {
      const unsubscribe = window.electronAPI.events.onOperationProgress((event) => {
        if (!event || event.type !== 'batch_analyze') return;
        window.__ssBench.progress.push({
          ts: Date.now(),
          batchId: event.batchId || null,
          completed: event.completed ?? null,
          total: event.total ?? null,
          percent: event.percent ?? null,
          phase: event.phase || null,
          successful: event.successful ?? null,
          failed: event.failed ?? null,
          currentFile: event.currentFile || null,
          section: event.section || null
        });
      });

      window.__ssBench.unsubscribe = unsubscribe;
      window.__ssBench.batchId = data.batchId;
      window.__ssBench.promise = window.electronAPI.analysis
        .batch({
          batchId: data.batchId,
          filePaths: data.filePaths,
          options: data.options
        })
        .then((result) => {
          window.__ssBench.result = result;
          return result;
        })
        .catch((error) => {
          const message = error?.message || String(error);
          window.__ssBench.errors.push(message);
          window.__ssBench.result = { success: false, error: message };
          return window.__ssBench.result;
        })
        .finally(() => {
          window.__ssBench.done = true;
          if (typeof window.__ssBench.unsubscribe === 'function') {
            window.__ssBench.unsubscribe();
          }
        });
      return { started: true };
    } catch (error) {
      return { started: false, error: error?.message || String(error) };
    }
  }, payload);
}

async function sampleRendererBench(window) {
  return window.evaluate(async () => {
    const state = window.__ssBench || {};
    let readyQueueLength = null;
    let embeddingStats = null;

    try {
      const ready = await window.electronAPI.analysis.getReadyQueue();
      if (ready && Array.isArray(ready.readyFiles)) {
        readyQueueLength = ready.readyFiles.length;
      }
    } catch {
      readyQueueLength = null;
    }

    try {
      const stats = await window.electronAPI.embeddings.getStats();
      if (stats) {
        embeddingStats = {
          buildInProgress: stats.embeddingBuildInProgress ?? null,
          totalDocuments: stats.totalDocuments ?? null,
          indexSize: stats.indexSize ?? null
        };
      }
    } catch {
      embeddingStats = null;
    }

    return {
      done: Boolean(state.done),
      progressCount: Array.isArray(state.progress) ? state.progress.length : 0,
      latestProgress:
        Array.isArray(state.progress) && state.progress.length > 0
          ? state.progress[state.progress.length - 1]
          : null,
      errors: Array.isArray(state.errors) ? state.errors : [],
      readyQueueLength,
      embeddingStats
    };
  });
}

async function finalizeRendererBench(window, options = {}) {
  const { awaitPromise = true } = options;
  return window.evaluate(
    async ({ shouldAwaitPromise }) => {
      const state = window.__ssBench || {};
      const result =
        shouldAwaitPromise && state && state.promise && typeof state.promise.then === 'function'
          ? await state.promise
          : state.result || null;
      return {
        startedAt: state.startedAt || null,
        done: Boolean(state.done),
        progress: Array.isArray(state.progress) ? state.progress : [],
        errors: Array.isArray(state.errors) ? state.errors : [],
        result
      };
    },
    { shouldAwaitPromise: awaitPromise }
  );
}

async function runDataset(app, window, dataset, globalOptions) {
  const { label, path: datasetPath } = dataset;
  let files = await listFilesRecursively(datasetPath);
  if (globalOptions.maxFiles > 0 && files.length > globalOptions.maxFiles) {
    files = files.slice(0, globalOptions.maxFiles);
    console.log(
      `[bench:${label}] Limiting to ${files.length} files (--max-files=${globalOptions.maxFiles})`
    );
  }
  const batchId = `bench_${label}_${Date.now()}`;
  const startedAt = Date.now();

  const startResponse = await startBatchInRenderer(window, {
    batchId,
    filePaths: files,
    options: {
      concurrency: globalOptions.concurrency,
      stopOnError: false,
      sectionOrder: 'documents-first'
    }
  });

  if (!startResponse?.started) {
    return {
      label,
      datasetPath,
      fileCount: files.length,
      started: false,
      error: startResponse?.error || 'Failed to start batch',
      durationMs: 0
    };
  }

  const timeoutAt = Date.now() + globalOptions.datasetTimeoutMs;
  const timeline = [];
  let timedOut = false;

  while (Date.now() < timeoutAt) {
    const [benchSample, memory] = await Promise.all([
      sampleRendererBench(window),
      getMainAndRendererMemory(app)
    ]);

    timeline.push({
      ts: Date.now(),
      progressCount: benchSample.progressCount,
      latestProgress: benchSample.latestProgress,
      readyQueueLength: benchSample.readyQueueLength,
      embeddingStats: benchSample.embeddingStats,
      memory: {
        mainRssMb: toMb(memory.mainProcess?.rss || 0),
        mainHeapMb: toMb(memory.mainProcess?.heapUsed || 0),
        rendererWorkingSetMb: Number(((memory.renderer?.workingSetSize || 0) / 1024).toFixed(2)),
        rendererPrivateMb: Number(((memory.renderer?.private || 0) / 1024).toFixed(2))
      }
    });

    if (timeline.length % 5 === 0) {
      const latest = benchSample.latestProgress || {};
      const emb = benchSample.embeddingStats || {};
      console.log(
        `[bench:${label}] sample=${timeline.length} done=${benchSample.done}` +
          ` completed=${latest.completed ?? 'n/a'}/${latest.total ?? 'n/a'}` +
          ` phase=${latest.phase ?? 'n/a'} file=${latest.currentFile ? path.basename(latest.currentFile) : 'n/a'}` +
          ` readyQueue=${benchSample.readyQueueLength ?? 'n/a'}` +
          ` embBuilding=${emb.buildInProgress ?? 'n/a'} embDocs=${emb.totalDocuments ?? 'n/a'}` +
          ` mainRssMb=${timeline[timeline.length - 1].memory.mainRssMb}`
      );
    }

    if (benchSample.done) break;
    await window.waitForTimeout(globalOptions.pollIntervalMs);
  }

  let finalState = await finalizeRendererBench(window, { awaitPromise: false });
  if (!finalState.done) {
    timedOut = true;
    await window.evaluate(async (id) => {
      try {
        await window.electronAPI.analysis.cancelBatch({
          batchId: id,
          reason: 'Benchmark timeout'
        });
      } catch {
        // Best effort timeout cancellation.
      }
    }, batchId);
    await window.waitForTimeout(1000);
    finalState = await finalizeRendererBench(window, { awaitPromise: false });
  }

  let embeddingDiagnostics = null;
  try {
    embeddingDiagnostics = await window.evaluate(async () => {
      if (window.electronAPI?.embeddings?.diagnoseSearch) {
        return window.electronAPI.embeddings.diagnoseSearch('benchmark');
      }
      return null;
    });
  } catch {
    // Best effort; embeddingDiagnostics stays null
  }

  const durationMs = Date.now() - startedAt;
  const peakMainRssMb = timeline.reduce((max, row) => Math.max(max, row.memory.mainRssMb), 0);
  const peakRendererWorkingSetMb = timeline.reduce(
    (max, row) => Math.max(max, row.memory.rendererWorkingSetMb),
    0
  );
  const peakReadyQueueLength = timeline.reduce(
    (max, row) => Math.max(max, row.readyQueueLength || 0),
    0
  );

  return {
    label,
    datasetPath,
    fileCount: files.length,
    started: true,
    timedOut,
    durationMs,
    peakMainRssMb,
    peakRendererWorkingSetMb,
    peakReadyQueueLength,
    progressEvents: finalState.progress.length,
    latestProgress:
      finalState.progress.length > 0 ? finalState.progress[finalState.progress.length - 1] : null,
    batchResult: finalState.result,
    rendererErrors: finalState.errors,
    embeddingDiagnostics,
    timeline
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const corpusRoot = path.resolve(
    args.corpus || path.join(repoRoot, '.tmp', 'stability', 'synthetic-corpus')
  );
  const outputPath = path.resolve(
    args.output || path.join(repoRoot, '.tmp', 'stability', 'e2e-batch-benchmark.json')
  );
  const runMode = String(args.mode || 'all').toLowerCase();
  const pollIntervalMs = toInt(args['poll-ms'], 2000);
  const datasetTimeoutMs = toInt(args['dataset-timeout-ms'], 900000); // 15 minutes
  const concurrency = toInt(args.concurrency, 2);
  const maxFiles = toInt(args['max-files'], 0); // 0 = no limit

  const datasets = [
    {
      id: 's1',
      label: 'S1-small-folder-import',
      path: path.join(corpusRoot, 'S1-small-folder-import')
    },
    {
      id: 's2',
      label: 'S2-large-folder-import',
      path: path.join(corpusRoot, 'S2-large-folder-import')
    }
  ].filter((dataset) => runMode === 'all' || runMode === dataset.id);

  for (const dataset of datasets) {
    if (!fs.existsSync(dataset.path)) {
      throw new Error(
        `Missing dataset path: ${dataset.path}. Run npm run stability:fixtures first.`
      );
    }
  }

  const appDataRoot =
    args.appdata ||
    path.join(repoRoot, '.tmp', 'stability', 'e2e-appdata', `run-${Date.now().toString(36)}`);
  const userDataPath = path.join(appDataRoot, 'StratoSort Stack');
  await ensureDir(userDataPath);

  const realUserData = path.join(
    process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
    'StratoSort Stack'
  );
  const realModelsDir = path.join(realUserData, 'models');
  const isolatedModelsDir = path.join(userDataPath, 'models');
  if (fs.existsSync(realModelsDir) && !fs.existsSync(isolatedModelsDir)) {
    await fsp.symlink(realModelsDir, isolatedModelsDir, 'junction');
    console.log(`[bench] Linked models: ${isolatedModelsDir} → ${realModelsDir}`);
  }

  const launchEnv = {
    ...process.env,
    STRATOSORT_E2E_USER_DATA: userDataPath,
    NODE_ENV: 'development',
    STRATOSORT_E2E: '1',
    STRATOSORT_FORCE_LAUNCH: '1',
    ELECTRON_ENABLE_LOGGING: '1'
  };

  const app = await electron.launch({
    executablePath: electronBinary,
    args: [mainEntryRelative, '--no-sandbox'],
    cwd: repoRoot,
    env: launchEnv,
    timeout: 90000
  });

  let window;
  try {
    console.log('[bench] Electron launched, waiting for first window...');
    window = await Promise.race([
      app.firstWindow(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for first Electron window')), 60000)
      )
    ]);
    console.log('[bench] First window acquired');
    await window.waitForLoadState('domcontentloaded');
    console.log('[bench] DOM content loaded');
    await waitForAppReady(window);
    console.log('[bench] App ready selector found');

    const appInfo = await app.evaluate(async ({ app: electronApp }) => ({
      userData: electronApp.getPath('userData'),
      version: electronApp.getVersion()
    }));

    let llamaConfig = null;
    const fetchLlamaConfig = async () => {
      try {
        return await window.evaluate(async () => {
          if (window.electronAPI?.llama?.getConfig) {
            return window.electronAPI.llama.getConfig();
          }
          return null;
        });
      } catch {
        return null;
      }
    };

    llamaConfig = await fetchLlamaConfig();
    if (!llamaConfig?.gpuBackend || llamaConfig.gpuBackend === 'unknown') {
      console.log('[bench] LLM not initialized yet, waiting 15s for model load...');
      await window.waitForTimeout(15000);
      llamaConfig = await fetchLlamaConfig();
    }
    console.log(
      `[bench] LLM backend: ${llamaConfig?.gpuBackend || 'unknown'}, ` +
        `gpuLayers: ${llamaConfig?.gpuLayers ?? 'auto'}, ` +
        `textModel: ${llamaConfig?.textModel || 'unknown'}, ` +
        `embeddingModel: ${llamaConfig?.embeddingModel || 'unknown'}, ` +
        `contextSize: ${llamaConfig?.contextSize ?? 'n/a'}`
    );

    let llamaHealth = null;
    try {
      llamaHealth = await window.evaluate(async () => {
        if (window.electronAPI?.llama?.testConnection) {
          return window.electronAPI.llama.testConnection();
        }
        return null;
      });
      console.log(
        `[bench] LLM health: ${llamaHealth?.status || 'unknown'}, ` +
          `models: ${llamaHealth?.modelCount ?? 'n/a'}, ` +
          `gpu: ${llamaHealth?.gpuBackend || 'n/a'}`
      );
    } catch (e) {
      console.warn(`[bench] Could not retrieve llama health: ${e?.message}`);
    }

    const globalOptions = {
      pollIntervalMs,
      datasetTimeoutMs,
      concurrency,
      maxFiles
    };

    const startedAt = Date.now();
    const datasetResults = [];
    for (const dataset of datasets) {
      console.log(`[bench] Running dataset ${dataset.label} ...`);
      const result = await runDataset(app, window, dataset, globalOptions);
      datasetResults.push(result);
      console.log(
        `[bench] Dataset ${dataset.label} done: duration=${result.durationMs}ms timedOut=${result.timedOut}`
      );
    }
    const elapsedMs = Date.now() - startedAt;

    const report = {
      generatedAt: new Date().toISOString(),
      node: process.version,
      runMode,
      options: globalOptions,
      appDataRoot,
      appInfo,
      llamaConfig,
      llamaHealth,
      elapsedMs,
      datasets: datasetResults
    };

    await ensureDir(path.dirname(outputPath));
    await fsp.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    console.log('E2E batch benchmark complete.');
    console.log(`Report: ${outputPath}`);
    console.log(`UserData: ${appInfo.userData}`);
    for (const result of datasetResults) {
      console.log(
        `${result.label}: duration=${result.durationMs}ms timedOut=${result.timedOut} peakMainRss=${result.peakMainRssMb}MB peakRendererWorkingSet=${result.peakRendererWorkingSetMb}MB`
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
