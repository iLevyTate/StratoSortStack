#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { scanDirectory } = require('../../src/main/folderScanner');

const repoRoot = path.resolve(__dirname, '../..');

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

function countScannedFiles(nodes) {
  let count = 0;
  const stack = Array.isArray(nodes) ? [...nodes] : [];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'file') count += 1;
    if (Array.isArray(node.children) && node.children.length > 0) {
      stack.push(...node.children);
    }
  }
  return count;
}

async function benchmarkDataset(label, datasetPath, options) {
  const iterations = options.iterations;
  const runs = [];

  for (let i = 0; i < iterations; i += 1) {
    let peakRss = process.memoryUsage().rss;
    let peakHeap = process.memoryUsage().heapUsed;

    const sampler = setInterval(() => {
      const usage = process.memoryUsage();
      if (usage.rss > peakRss) peakRss = usage.rss;
      if (usage.heapUsed > peakHeap) peakHeap = usage.heapUsed;
    }, 50);

    const startedAt = Date.now();
    const tree = await scanDirectory(datasetPath, undefined, {
      includeStats: true,
      maxDepth: options.maxDepth,
      maxFiles: options.maxFiles,
      timeoutMs: options.timeoutMs,
      perDirectoryTimeoutMs: options.perDirectoryTimeoutMs
    });
    const durationMs = Date.now() - startedAt;
    clearInterval(sampler);

    const after = process.memoryUsage();
    const scanMeta = tree.__scanMeta || {};
    const filesFound = countScannedFiles(tree);

    runs.push({
      iteration: i + 1,
      durationMs,
      filesFound,
      partial: Boolean(scanMeta.partial),
      reasons: Array.isArray(scanMeta.reasons) ? scanMeta.reasons : [],
      directoriesVisited: scanMeta.directoriesVisited ?? null,
      filesIncluded: scanMeta.filesIncluded ?? null,
      timeouts: scanMeta.timeouts ?? null,
      skippedDirectories: scanMeta.skippedDirectories ?? null,
      skippedErrors: scanMeta.skippedErrors ?? null,
      rssMbAfter: toMb(after.rss),
      heapMbAfter: toMb(after.heapUsed),
      peakRssMb: toMb(peakRss),
      peakHeapMb: toMb(peakHeap)
    });
  }

  const durationValues = runs.map((run) => run.durationMs);
  const peakRssValues = runs.map((run) => run.peakRssMb);
  const peakHeapValues = runs.map((run) => run.peakHeapMb);

  return {
    label,
    datasetPath,
    iterations,
    options,
    summary: {
      avgDurationMs: Math.round(durationValues.reduce((a, b) => a + b, 0) / durationValues.length),
      minDurationMs: Math.min(...durationValues),
      maxDurationMs: Math.max(...durationValues),
      maxPeakRssMb: Math.max(...peakRssValues),
      maxPeakHeapMb: Math.max(...peakHeapValues)
    },
    runs
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function mainDatasetPaths(outputRoot) {
  return {
    s1: path.join(outputRoot, 'S1-small-folder-import'),
    s2: path.join(outputRoot, 'S2-large-folder-import')
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const corpusRoot = path.resolve(
    args.corpus || path.join(repoRoot, '.tmp', 'stability', 'synthetic-corpus')
  );
  const outputPath = path.resolve(
    args.output || path.join(repoRoot, '.tmp', 'stability', 'synthetic-benchmark.json')
  );

  const options = {
    iterations: toInt(args.iterations, 3),
    maxDepth: toInt(args['max-depth'], 20),
    maxFiles: toInt(args['max-files'], 200000),
    timeoutMs: toInt(args['timeout-ms'], 300000),
    perDirectoryTimeoutMs: toInt(args['per-dir-timeout-ms'], 5000)
  };

  const datasets = mainDatasetPaths(corpusRoot);
  if (!fs.existsSync(datasets.s1) || !fs.existsSync(datasets.s2)) {
    throw new Error(
      `Expected fixture datasets at:\n- ${datasets.s1}\n- ${datasets.s2}\nRun: npm run stability:fixtures`
    );
  }

  const startedAt = Date.now();
  const s1Result = await benchmarkDataset('S1-small-folder-import', datasets.s1, options);
  const s2Result = await benchmarkDataset('S2-large-folder-import', datasets.s2, options);
  const elapsedMs = Date.now() - startedAt;

  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    elapsedMs,
    options,
    datasets: [s1Result, s2Result]
  };

  ensureDir(path.dirname(outputPath));
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log('Synthetic benchmark complete.');
  console.log(`Report: ${outputPath}`);
  console.log(
    `S1 avg: ${s1Result.summary.avgDurationMs}ms, S2 avg: ${s2Result.summary.avgDurationMs}ms`
  );
  console.log(
    `Peak RSS MB (max): S1 ${s1Result.summary.maxPeakRssMb}, S2 ${s2Result.summary.maxPeakRssMb}`
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
