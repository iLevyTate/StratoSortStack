#!/usr/bin/env node
/**
 * Launch a packaged StratoSort build with a throwaway profile and check that it
 * really works: startup completes, the local AI engine's native binaries load,
 * and a packaged worker (OCR) runs on a dropped image. Used by
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

// Signatures of the failures this check exists to catch.
const FORBIDDEN = [
  /NoBinaryFoundError/,
  /Cannot find module/,
  /worker thread error/i,
  /ERR_DLOPEN_FAILED/,
  /Integrity check failed/,
  /Coordinated startup failed/
];

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
  let logs = '';
  while (Date.now() - started < opts.timeoutMs && !exitInfo) {
    logs = readLogs(userData);
    if (!dropped.length && /Coordinated startup completed successfully/.test(logs)) {
      dropped = writeSamples(inbox);
      console.log(
        `[smoke] startup complete after ${Date.now() - started} ms; dropped ${dropped.join(', ')}`
      );
    }
    const missing = REQUIRED.filter((r) => !r.pattern.test(logs));
    if (dropped.length && missing.length === 0) {
      await sleep(5000); // let in-flight work log any late failure
      break;
    }
    await sleep(1000);
  }
  logs = readLogs(userData);
  killTree(child);

  const missing = REQUIRED.filter((r) => !r.pattern.test(logs)).map((r) => r.id);
  const failures = FORBIDDEN.filter((p) => p.test(logs)).map((p) => {
    const line = logs.split('\n').find((l) => p.test(l)) || '';
    return { signature: String(p), line: line.slice(0, 400) };
  });
  const summary = {
    platform: process.platform,
    arch: process.arch,
    exe: opts.exe,
    elapsedMs: Date.now() - started,
    exitedEarly: exitInfo,
    droppedSamples: dropped,
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

main().catch((error) => {
  console.error(`[smoke] ${error.stack || error.message}`);
  process.exit(1);
});
