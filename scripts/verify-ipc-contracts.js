#!/usr/bin/env node

/**
 * Verify IPC contract coherence for high-risk boundaries:
 * - constants.js (source of truth)
 * - preload.js (renderer bridge)
 * - main ipc handlers (analysis/settings/semantic)
 *
 * This script complements:
 * - scripts/generate-preload-channels.js --check
 * - scripts/verify-ipc-handlers.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const constantsPath = path.join(repoRoot, 'src', 'shared', 'constants.js');
const preloadPath = path.join(repoRoot, 'src', 'preload', 'preload.js');

function collectJsFilesRecursive(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsFilesRecursive(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Map logical category -> absolute paths (concatenated when verifying main-side refs).
 * FILES spans multiple modules under ipc/files/.
 */
const MAIN_HANDLER_FILES = {
  ANALYSIS: [path.join(repoRoot, 'src', 'main', 'ipc', 'analysis.js')],
  SETTINGS: [path.join(repoRoot, 'src', 'main', 'ipc', 'settings.js')],
  EMBEDDINGS: [path.join(repoRoot, 'src', 'main', 'ipc', 'semantic.js')],
  ORGANIZE: [path.join(repoRoot, 'src', 'main', 'ipc', 'organize.js')],
  FILES: collectJsFilesRecursive(path.join(repoRoot, 'src', 'main', 'ipc', 'files'))
};

function runNodeScript(scriptRelativePath, args = []) {
  const scriptPath = path.join(repoRoot, scriptRelativePath);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8'
  });

  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`Failed: node ${scriptRelativePath} ${args.join(' ')}\n${details}`);
  }
}

function validateFileExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
}

function getCriticalRefs(IPC_CHANNELS) {
  const refs = [];
  const categories = ['ANALYSIS', 'SETTINGS', 'EMBEDDINGS', 'ORGANIZE', 'FILES'];
  for (const category of categories) {
    const endpoints = IPC_CHANNELS[category] || {};
    for (const endpoint of Object.keys(endpoints)) {
      refs.push({
        ref: `IPC_CHANNELS.${category}.${endpoint}`,
        category
      });
    }
  }
  return refs;
}

function main() {
  validateFileExists(constantsPath, 'constants.js');
  validateFileExists(preloadPath, 'preload.js');
  Object.entries(MAIN_HANDLER_FILES).forEach(([category, paths]) => {
    for (const filePath of paths) {
      validateFileExists(filePath, `${category} handler`);
    }
  });

  // Existing guards (full constant-sync + handler coverage)
  runNodeScript('scripts/generate-preload-channels.js', ['--check']);
  runNodeScript('scripts/verify-ipc-handlers.js');
  runNodeScript('scripts/verify-ipc-handler-schemas.js');
  runNodeScript('scripts/inventory-ipc-main-sends.js');

  const { IPC_CHANNELS } = require(constantsPath);
  const criticalRefs = getCriticalRefs(IPC_CHANNELS);
  const preloadSource = fs.readFileSync(preloadPath, 'utf8');
  const mainSourceByCategory = Object.fromEntries(
    Object.entries(MAIN_HANDLER_FILES).map(([category, paths]) => [
      category,
      paths.map((p) => fs.readFileSync(p, 'utf8')).join('\n')
    ])
  );

  const missingInPreload = [];
  const missingInMain = [];

  for (const entry of criticalRefs) {
    if (!preloadSource.includes(entry.ref)) {
      missingInPreload.push(entry.ref);
    }
    if (!mainSourceByCategory[entry.category].includes(entry.ref)) {
      missingInMain.push(`${entry.ref} (${entry.category})`);
    }
  }

  if (missingInPreload.length > 0 || missingInMain.length > 0) {
    console.error('\nIPC Contract Verification Failed\n');
    if (missingInPreload.length > 0) {
      console.error('Missing in preload bridge:');
      for (const ref of missingInPreload) console.error(`  - ${ref}`);
      console.error('');
    }
    if (missingInMain.length > 0) {
      console.error('Missing in main handlers:');
      for (const ref of missingInMain) console.error(`  - ${ref}`);
      console.error('');
    }
    process.exit(1);
  }

  console.log('OK: IPC contracts are coherent for constants/preload/main critical channels.');
}

main();
