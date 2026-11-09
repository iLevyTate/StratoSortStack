#!/usr/bin/env node
/**
 * Launch a packaged StratoSort build with a throwaway profile and check that it
 * really works: startup completes, the local AI engine's native binaries load,
 * a packaged worker (OCR) runs on a dropped image, and a seeded search index is
 * restored through the packaged restore worker. Used by
 * .github/workflows/packaged-smoke.yml on Windows, macOS and Linux runners.
 *
 *   node scripts/packaged-launch-smoke.js --exe <path to app binary>
 *        [--arg <extra app argument>]... [--timeout-ms 300000] [--out <dir>]
 *
 * Exits 0 when every required log line appears and no failure signature does.
 * No network: model downloads are switched off in the seeded profile, and the
 * updater is disabled for the run.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

function parseArgs(argv) {
  const opts = { exe: null, args: [], timeoutMs: 300000, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--exe') opts.exe = argv[++i];
    else if (a === '--arg') opts.args.push(argv[++i]);
    else if (a === '--timeout-ms') opts.timeoutMs = Number(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.exe) throw new Error('--exe is required');
  if (!fs.existsSync(opts.exe)) throw new Error(`App binary not found: ${opts.exe}`);
  return opts;
}

// Lines that must appear: the app reached ready, finished coordinated startup,
// the native AI engine loaded, and a packaged worker handled the dropped image.
const REQUIRED = [
  { id: 'window-created', pattern: /\[STARTUP\] Creating window/ },
  { id: 'startup-complete', pattern: /Coordinated startup completed successfully/ },
  { id: 'ai-engine-loaded', pattern: /\[LlamaService\] Initialized successfully/ },
  {
    id: 'ocr-worker-ran',
    pattern: /OCR pre-extraction successful|\[WorkerPools\] OCR pool initialized/
  }
];

// Signatures of the failures this check exists to catch. NoBinaryFoundError is
// judged separately by gpuFallbackOrFailure: a GPU backend the machine cannot
// run (Vulkan on a Hyper-V virtual GPU) is expected when the engine then loads
// on the CPU, but the CPU floor failing is exactly the clean-PC break of 5.1.2.
const FORBIDDEN = [
  /Cannot find module/,
  /worker thread error/i,
  /ERR_DLOPEN_FAILED/,
  /Integrity check failed/,
  /Coordinated startup failed/
];

// The search index is read back at startup by the oramaRestoreWorker bundle,
// which decodes LZ4 with a native binding that must sit in app.asar.unpacked.
// It only runs for saved files of at least 4 MB (RESTORE_WORKER_MIN_BYTES in
// OramaVectorService), and when it cannot load, restore quietly falls back to
// the main thread. So the profile gets a real, compressed collection above
// that size, and the run passes only if the app restores it in the worker.
const RESTORE_WORKER_MIN_BYTES = 4 * 1024 * 1024;
const SEED_COLLECTION = 'fileChunks';
// A fresh profile's embedding dimension (all-MiniLM-L6-v2, the default model).
const SEED_DIMENSION = 384;

/**
 * The text of a saved collection, in the app's own compact form
 * (`{"docs":{"docs":{...},"count":N}}`, see serializeCollectionForDisk).
 * Embeddings are pseudo-random but deterministic, so the file barely
 * compresses and every run writes the same bytes.
 * @param {{ docCount: number, dimension?: number }} options
 * @returns {string}
 */
function buildSeedCollection({ docCount, dimension = SEED_DIMENSION }) {
  let state = 0x2545f491;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000 - 0.5;
  };
  const docs = {};
  for (let i = 0; i < docCount; i += 1) {
    const content = `Synthetic smoke-test passage ${i}. No real data.`;
    docs[String(i + 1)] = {
      id: `smoke-chunk-${i}`,
      embedding: Array.from({ length: dimension }, next),
      fileId: `smoke-file-${i % 50}`,
      chunkIndex: i,
      content,
      startOffset: 0,
      endOffset: content.length
    };
  }
  return JSON.stringify({ docs: { docs, count: docCount } });
}

/**
 * Write a compressed collection of at least RESTORE_WORKER_MIN_BYTES (with
 * margin) into the profile's vector-db folder, using the app's own LZ4 codec.
 * @param {string} userData
 * @param {{ lz4?: any }} [deps]
 * @returns {{ collection: string, docCount: number, bytes: number, file: string }}
 */
function seedVectorIndex(userData, deps = {}) {
  const lz4 = deps.lz4 || require('../src/shared/lz4Codec');
  if (!lz4.isLz4BindingAvailable) {
    throw new Error('lz4-napi does not load in this runner, so the search index cannot be seeded');
  }
  const dir = path.join(userData, 'vector-db');
  fs.mkdirSync(dir, { recursive: true });
  const target = Math.ceil(RESTORE_WORKER_MIN_BYTES * 1.25);
  let docCount = 800;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const compressed = lz4.compressSync(Buffer.from(buildSeedCollection({ docCount }), 'utf8'));
    if (compressed.length >= target) {
      const file = path.join(dir, `${SEED_COLLECTION}.json.lz4`);
      fs.writeFileSync(file, compressed);
      return { collection: SEED_COLLECTION, docCount, bytes: compressed.length, file };
    }
    docCount = Math.ceil(docCount * (target / Math.max(compressed.length, 1)) * 1.1);
  }
  throw new Error('Could not build a seeded collection large enough for the restore worker');
}

/**
 * Whether the seeded collection came back through the restore worker, read
 * from the app's structured "Restored <name> database" line.
 * @param {string} logs
 * @param {{ collection: string, docCount: number }} seed
 * @returns {{ ok: boolean, reason: string | null, line: any }}
 */
function restoreWorkerCheck(logs, seed) {
  const want = `[OramaVectorService] Restored ${seed.collection} database`;
  const entry = parseJsonLines(logs)
    .map((p) => p.entry)
    .find((e) => e.msg === want);
  if (!entry) return { ok: false, reason: `no "${want}" line`, line: null };
  const line = {
    parsedIn: entry.parsedIn,
    total: entry.total,
    inserted: entry.inserted,
    failed: entry.failed
  };
  if (entry.parsedIn !== 'worker') {
    return { ok: false, reason: `parsed in ${entry.parsedIn}, not the worker`, line };
  }
  if (entry.total !== seed.docCount || entry.inserted !== seed.docCount || entry.failed !== 0) {
    return { ok: false, reason: 'not every seeded document was restored', line };
  }
  return { ok: true, reason: null, line };
}

const GPU_BACKENDS = new Set(['vulkan', 'cuda', 'metal']);

function parseJsonLines(logs) {
  const out = [];
  for (const line of logs.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      out.push({ line, entry: JSON.parse(line) });
    } catch {
      /* not a structured line */
    }
  }
  return out;
}

/**
 * Split NoBinaryFoundError lines into tolerated GPU fallbacks and failures.
 * A line is a fallback only when it names a GPU backend and the engine's
 * "Llama backend selected" line reports a backend that did load.
 */
function gpuFallbackOrFailure(logs) {
  const parsed = parseJsonLines(logs);
  const selected = parsed.find(
    ({ entry }) => /\[LlamaService\] Llama backend selected/.test(entry.msg || '') && entry.actual
  );
  const fallbacks = [];
  const failures = [];
  const structured = new Map(parsed.map((p) => [p.line, p.entry]));
  for (const line of logs.split('\n')) {
    if (!/NoBinaryFoundError/.test(line)) continue;
    const entry = structured.get(line);
    // The selection summary lists every attempt, failed ones included.
    if (selected && entry === selected.entry) continue;
    const backend = entry && typeof entry.backend === 'string' ? entry.backend : null;
    if (selected && backend && GPU_BACKENDS.has(backend)) {
      fallbacks.push({ backend, loaded: selected.entry.actual });
    } else {
      failures.push({ signature: String(/NoBinaryFoundError/), line: line.slice(0, 400) });
    }
  }
  return { fallbacks, failures, selectedBackend: selected ? selected.entry.actual : null };
}

/**
 * The verdict on one run's logs. Pure, so it is unit-tested on recorded lines.
 * @param {string} logs
 * @param {{ seed?: { collection: string, docCount: number } | null }} [options]
 */
function evaluateLogs(logs, { seed = null } = {}) {
  const missing = REQUIRED.filter((r) => !r.pattern.test(logs)).map((r) => r.id);
  const restore = seed ? restoreWorkerCheck(logs, seed) : null;
  if (restore && !restore.ok) missing.push(`restore-worker (${restore.reason})`);
  const gpu = gpuFallbackOrFailure(logs);
  const failures = [
    ...gpu.failures,
    ...FORBIDDEN.filter((p) => p.test(logs)).map((p) => {
      const line = logs.split('\n').find((l) => p.test(l)) || '';
      return { signature: String(p), line: line.slice(0, 400) };
    })
  ];
  return {
    missing,
    failures,
    aiBackend: gpu.selectedBackend,
    gpuFallbacks: gpu.fallbacks,
    restore: restore ? restore.line : null
  };
}

function readLogs(userData) {
  const dir = path.join(userData, 'logs');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
      .join('\n');
  } catch {
    return '';
  }
}

function seedProfile(userData, inbox, uncategorized) {
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(uncategorized, { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'settings.json'),
    JSON.stringify({ modelAutoDownloadSkipped: true, smartFolderWatchEnabled: true }, null, 2)
  );
  fs.writeFileSync(
    path.join(userData, 'custom-folders.json'),
    JSON.stringify(
      [
        {
          id: 'smoke-inbox-folder',
          name: 'Inbox',
          path: inbox,
          description: 'Synthetic inbox for the packaged smoke check',
          keywords: ['invoice', 'notes'],
          isDefault: false
        },
        // Without a default folder the app adds Uncategorized under the real
        // Documents folder and watches it, which would analyze the runner's or
        // developer's own files. Keep it inside the throwaway directory.
        {
          id: 'smoke-uncategorized-folder',
          name: 'Uncategorized',
          path: uncategorized,
          description: 'Default folder for the packaged smoke check',
          keywords: [],
          isDefault: true
        }
      ],
      null,
      2
    )
  );
}

function writeSamples(dir) {
  const written = [];
  fs.writeFileSync(
    path.join(dir, 'smoke-notes.txt'),
    'Synthetic smoke-test notes. No real data.\n'
  );
  written.push('smoke-notes.txt');
  try {
    const { createCanvas } = require('@napi-rs/canvas');
    const canvas = createCanvas(900, 300);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 900, 300);
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 44px sans-serif';
    ['SYNTHETIC INVOICE 0042', 'Total Due: 1,234.56 USD'].forEach((line, i) =>
      ctx.fillText(line, 40, 90 + i * 80)
    );
    fs.writeFileSync(path.join(dir, 'smoke-invoice.png'), canvas.toBuffer('image/png'));
    written.push('smoke-invoice.png');
  } catch (error) {
    console.warn(`[smoke] could not generate the sample image: ${error.message}`);
  }
  return written;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stratosort-smoke-'));
  const userData = path.join(root, 'profile');
  const inbox = path.join(root, 'inbox');
  const uncategorized = path.join(root, 'Uncategorized');
  seedProfile(userData, inbox, uncategorized);
  const seed = seedVectorIndex(userData);
  console.log(
    `[smoke] seeded ${seed.collection} with ${seed.docCount} documents (${seed.bytes} bytes compressed)`
  );

  const started = Date.now();
  const child = spawn(opts.exe, opts.args, {
    env: {
      ...process.env,
      STRATOSORT_E2E_USER_DATA: userData,
      STRATOSORT_ENABLE_AUTO_UPDATES: 'false'
    },
    stdio: 'ignore',
    detached: process.platform !== 'win32'
  });
  let exitInfo = null;
  child.on('exit', (code, signal) => {
    exitInfo = { code, signal, afterMs: Date.now() - started };
  });

  let dropped = [];
  while (Date.now() - started < opts.timeoutMs && !exitInfo) {
    const current = readLogs(userData);
    if (!dropped.length && /Coordinated startup completed successfully/.test(current)) {
      dropped = writeSamples(inbox);
      console.log(
        `[smoke] startup complete after ${Date.now() - started} ms; dropped ${dropped.join(', ')}`
      );
    }
    if (dropped.length && evaluateLogs(current, { seed }).missing.length === 0) {
      await sleep(5000); // let in-flight work log any late failure
      break;
    }
    await sleep(1000);
  }
  const logs = readLogs(userData);
  killTree(child);

  const { missing, failures, aiBackend, gpuFallbacks, restore } = evaluateLogs(logs, { seed });
  const summary = {
    platform: process.platform,
    arch: process.arch,
    exe: opts.exe,
    elapsedMs: Date.now() - started,
    exitedEarly: exitInfo,
    droppedSamples: dropped,
    aiBackend,
    gpuFallbacks,
    seededIndex: { collection: seed.collection, docCount: seed.docCount, bytes: seed.bytes },
    restore,
    missing,
    failures,
    ok: missing.length === 0 && failures.length === 0 && !exitInfo
  };

  if (opts.out) {
    fs.mkdirSync(opts.out, { recursive: true });
    fs.writeFileSync(path.join(opts.out, 'smoke-summary.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(opts.out, 'app.log'), logs);
  }
  console.log(JSON.stringify(summary, null, 2));
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* leave it for the runner to clean */
  }
  process.exit(summary.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[smoke] ${error.stack || error.message}`);
    process.exit(1);
  });
}

module.exports = {
  evaluateLogs,
  gpuFallbackOrFailure,
  buildSeedCollection,
  seedVectorIndex,
  restoreWorkerCheck,
  RESTORE_WORKER_MIN_BYTES
};
