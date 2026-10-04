#!/usr/bin/env node
/**
 * Runtime Prerequisite Verifier
 *
 * Checks that everything the app needs at startup is present and loadable
 * on THIS machine: model files at the productName-aware userData path,
 * bundled native binaries, and platform-specific whisper.node variants.
 *
 * This complements the existing verify-* scripts (which check static
 * project state) by reporting a matrix of "what works at runtime on
 * this machine right now." Useful as a 30-second diagnostic before
 * digging into log files when media analysis misbehaves.
 *
 * Exit code 0: all critical checks passed (warnings OK).
 * Exit code 1: at least one critical check failed.
 *
 * Usage:
 *   node scripts/verify-runtime-prereqs.js              # full check
 *   node scripts/verify-runtime-prereqs.js --json       # machine-readable
 *   node scripts/verify-runtime-prereqs.js --quick      # skip dlopen attempts
 *   node scripts/verify-runtime-prereqs.js --no-color   # plain output
 */

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const QUICK = args.includes('--quick');
const useColor = process.stdout.isTTY && !args.includes('--no-color');

const RED = useColor ? '\x1b[31m' : '';
const GREEN = useColor ? '\x1b[32m' : '';
const YELLOW = useColor ? '\x1b[33m' : '';
const DIM = useColor ? '\x1b[2m' : '';
const RESET = useColor ? '\x1b[0m' : '';

const pkg = require('../package.json');
const PRODUCT_NAME = pkg.productName || pkg.name || 'StratoSort Core';

// Mirror Electron's `app.getPath('userData')` resolution. This script runs
// outside Electron, so we synthesize the same path from productName +
// platform conventions. If this drifts from Electron's logic the runtime
// will read from a different dir and downstream "model present" reports
// will be wrong.
function getUserDataDir() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), PRODUCT_NAME);
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', PRODUCT_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), PRODUCT_NAME);
}

const userDataDir = getUserDataDir();
const modelsDir = path.join(userDataDir, 'models');
const repoRoot = path.join(__dirname, '..');

// Source-of-truth constants are in src/main/services/WhisperService.js
// (WHISPER_SUBDIR, DEFAULT_MODEL_FILENAME). Hardcoded here to keep this
// script Node-only — importing WhisperService transitively pulls in
// modules that assume an Electron context.
const WHISPER_SUBDIR = 'whisper';
const WHISPER_DEFAULT_MODEL = 'ggml-base.en.bin';
const WHISPER_DEFAULT_SIZE_BYTES = 141 * 1024 * 1024; // ggml-base.en.bin

const results = [];

function add(category, label, status, detail, opts = {}) {
  results.push({
    category,
    label,
    status,
    detail,
    hint: opts.hint || null,
    critical: opts.critical !== false
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function checkFile(category, label, filepath, opts = {}) {
  try {
    const st = fs.statSync(filepath);
    if (!st.isFile()) {
      add(category, label, 'fail', `Not a regular file: ${filepath}`, opts);
      return;
    }
    if (opts.minSize && st.size < opts.minSize * 0.9) {
      add(
        category,
        label,
        'warn',
        `${formatSize(st.size)} (expected ~${formatSize(opts.minSize)}; may be incomplete)`,
        opts
      );
      return;
    }
    add(category, label, 'ok', formatSize(st.size), opts);
  } catch (err) {
    if (err.code === 'ENOENT') {
      add(category, label, 'fail', `Missing: ${filepath}`, opts);
    } else {
      add(category, label, 'fail', err.message, opts);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. LLM / embedding / vision GGUF models (from the central registry).
// ---------------------------------------------------------------------------
let recommendedModels = {};
try {
  recommendedModels = require('../src/shared/modelRegistry').getRecommendedModels();
} catch (err) {
  add('models', 'modelRegistry', 'fail', `Cannot load registry: ${err.message}`);
}

for (const [filename, info] of Object.entries(recommendedModels)) {
  checkFile('models', filename, path.join(modelsDir, filename), { minSize: info.size });
  // Multimodal vision models pair a primary GGUF with an mmproj clip model;
  // the registry surfaces this via `clipModel` and the runtime will fail
  // to do vision inference if it's missing even though the main model is OK.
  if (info.clipModel && info.clipModel.name) {
    checkFile('models', info.clipModel.name, path.join(modelsDir, info.clipModel.name), {
      minSize: info.clipModel.size
    });
  }
}

// ---------------------------------------------------------------------------
// 2. Whisper model. Separate from the GGUF registry; lives in models/whisper.
// ---------------------------------------------------------------------------
checkFile(
  'models',
  WHISPER_DEFAULT_MODEL,
  path.join(modelsDir, WHISPER_SUBDIR, WHISPER_DEFAULT_MODEL),
  { minSize: WHISPER_DEFAULT_SIZE_BYTES }
);

// ---------------------------------------------------------------------------
// 3. Bundled native binaries shipped alongside the app.
// ---------------------------------------------------------------------------
const exeExt = process.platform === 'win32' ? '.exe' : '';
checkFile(
  'runtime',
  `ffmpeg${exeExt}`,
  path.join(repoRoot, 'assets', 'runtime', 'ffmpeg', `ffmpeg${exeExt}`),
  { minSize: 30 * 1024 * 1024, hint: 'Run `npm run setup:ffmpeg-runtime` if missing' }
);
checkFile(
  'runtime',
  `llama-server${exeExt}`,
  path.join(repoRoot, 'assets', 'runtime', `llama-server${exeExt}`),
  { minSize: 1024 * 1024, hint: 'Run `npm run setup:vision-runtime` if missing' }
);

// ---------------------------------------------------------------------------
// 4. Whisper.node variants — actually try to dlopen each. This is the check
//    that catches CUDA runtime mismatches (ERR_DLOPEN_FAILED) and webpack-
//    erased require() bugs that bench-only tests miss.
// ---------------------------------------------------------------------------
if (!QUICK) {
  const nativeRequire = createRequire(__filename);
  const platform = process.platform;
  const arch = process.arch;
  // Variants must mirror the order WhisperService.loadNativeWhisperModule
  // walks. `null` represents the default platform package (CPU; on darwin
  // it bundles Metal).
  const variantList = ['cuda', 'vulkan', null];
  for (const variant of variantList) {
    const pkgName = variant
      ? `@fugood/node-whisper-${platform}-${arch}-${variant}`
      : `@fugood/node-whisper-${platform}-${arch}`;
    const label = variant || 'default (CPU/Metal)';
    try {
      const mod = nativeRequire(pkgName);
      if (mod && mod.WhisperContext) {
        add('whisper-variant', label, 'ok', `${pkgName} loaded`, { critical: false });
      } else {
        add('whisper-variant', label, 'warn', `${pkgName} loaded but no WhisperContext export`, {
          critical: false
        });
      }
    } catch (err) {
      if (err.code === 'MODULE_NOT_FOUND') {
        add('whisper-variant', label, 'warn', `${pkgName} not installed (optional)`, {
          critical: false
        });
      } else if (err.code === 'ERR_DLOPEN_FAILED') {
        const hint =
          variant === 'cuda'
            ? 'CUDA runtime version mismatch likely — needs cudart64_12.dll + cublas64_12.dll on PATH (the prebuilt @fugood/whisper.node CUDA variant links CUDA 12.x). Install the CUDA 12.x runtime side-by-side or stay on the Vulkan fallback.'
            : variant === 'vulkan'
              ? 'Vulkan driver may be missing or incompatible with this build.'
              : 'Default native binding failed to load — check Node ABI compatibility.';
        add('whisper-variant', label, 'fail', `${pkgName}: ${err.code}`, {
          critical: false,
          hint
        });
      } else {
        add('whisper-variant', label, 'fail', `${pkgName}: ${err.message}`, { critical: false });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Render.
// ---------------------------------------------------------------------------
if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        productName: PRODUCT_NAME,
        userDataDir,
        modelsDir,
        platform: process.platform,
        arch: process.arch,
        results
      },
      null,
      2
    )
  );
} else {
  const byCategory = {};
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = [];
    byCategory[r.category].push(r);
  }
  for (const [cat, list] of Object.entries(byCategory)) {
    console.log(`\n[${cat}]`);
    for (const r of list) {
      const icon =
        r.status === 'ok' ? `${GREEN}OK ` : r.status === 'warn' ? `${YELLOW}WARN` : `${RED}FAIL`;
      console.log(`  ${icon}${RESET}  ${r.label.padEnd(44)} ${r.detail}`);
      if (r.hint) console.log(`        ${DIM}- ${r.hint}${RESET}`);
    }
  }
  console.log('');
  console.log(`${DIM}productName:${RESET}  ${PRODUCT_NAME}`);
  console.log(`${DIM}userData:${RESET}     ${userDataDir}`);
  console.log(`${DIM}platform:${RESET}     ${process.platform}-${process.arch}`);
}

const criticalFails = results.filter((r) => r.status === 'fail' && r.critical);
process.exit(criticalFails.length > 0 ? 1 : 0);
