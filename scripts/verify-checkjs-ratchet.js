#!/usr/bin/env node
/**
 * Ratchet guard for the JSDoc checkjs lane (tsconfig.checkjs.json).
 *
 * Two monotonic guarantees:
 *   1. Every .js file under a directory listed in COVERED_DIRS carries a
 *      `// @ts-check` directive within its first 5 lines.
 *   2. The total number of opted-in .js files under src/ never drops below
 *      GLOBAL_DIRECTIVE_FLOOR.
 *
 * When a wave (or batch) lands: bump GLOBAL_DIRECTIVE_FLOOR to the printed
 * count; when a directory reaches 100%, add it to COVERED_DIRS.
 *
 * CLI:
 *   node scripts/verify-checkjs-ratchet.js            # run the checks
 *   node scripts/verify-checkjs-ratchet.js --list [DIR] # files lacking directive (default: src)
 *
 * Wire into CI via `npm run verify:checkjs-ratchet`.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

// ── Ratchet state — update as waves land (see header) ──────────────────
const COVERED_DIRS = [
  'src/shared',
  'src/main/ipc',
  'src/main/services',
  'src/main/analysis',
  'src/main/errors',
  'src/main/utils',
  'src/main/workers',
  'src/main/transports',
  'src/main/core',
  'src/preload',
  'src/renderer/services',
  'src/renderer/hooks',
  'src/renderer/phases',
  'src/renderer/store',
  'src/renderer/utils',
  'src/renderer/components'
];
const GLOBAL_DIRECTIVE_FLOOR = 449;
// ────────────────────────────────────────────────────────────────────────

const DIRECTIVE_SCAN_LINES = 5;

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      out.push(...listJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function hasDirective(filePath) {
  const head = fs.readFileSync(filePath, 'utf8').split('\n', DIRECTIVE_SCAN_LINES);
  return head.some((line) => line.trim() === '// @ts-check');
}

function resolveDir(dir) {
  return path.isAbsolute(dir) ? dir : path.join(REPO_ROOT, dir);
}

function runChecks({
  srcRoot = SRC_ROOT,
  coveredDirs = COVERED_DIRS,
  floor = GLOBAL_DIRECTIVE_FLOOR
} = {}) {
  const failures = [];
  const allJs = listJsFiles(srcRoot);
  const optedIn = allJs.filter(hasDirective);

  for (const dir of coveredDirs) {
    for (const file of listJsFiles(resolveDir(dir))) {
      if (!hasDirective(file)) {
        failures.push(
          `${path.relative(REPO_ROOT, file)} is inside covered dir ${dir} but lacks // @ts-check`
        );
      }
    }
  }

  if (optedIn.length < floor) {
    failures.push(
      `opted-in file count ${optedIn.length} fell below floor ${floor} — a // @ts-check directive was removed`
    );
  }

  return {
    total: allJs.length,
    optedIn: optedIn.length,
    floor,
    failures
  };
}

function main() {
  if (process.argv[2] === '--list') {
    const dir = resolveDir(process.argv[3] || 'src');
    for (const file of listJsFiles(dir)) {
      if (!hasDirective(file)) {
        console.log(path.relative(REPO_ROOT, file));
      }
    }
    return;
  }

  const result = runChecks();
  for (const message of result.failures) {
    console.error(`FAIL: ${message}`);
  }
  console.log(
    `verify:checkjs-ratchet: ${result.optedIn}/${result.total} src .js files opted in (floor ${result.floor}), ${result.failures.length} failures.`
  );
  if (result.failures.length === 0 && result.optedIn > result.floor) {
    console.log(
      `INFO: floor can ratchet up to ${result.optedIn} (edit GLOBAL_DIRECTIVE_FLOOR in scripts/verify-checkjs-ratchet.js).`
    );
  }
  if (result.failures.length > 0) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = { runChecks, hasDirective, listJsFiles };
