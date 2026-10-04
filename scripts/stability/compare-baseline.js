#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '../..');
const generateLedgerScript = path.join(__dirname, 'generate-baseline-ledger.js');
const smokeSuiteScript = path.join(__dirname, 'run-smoke-suite.js');
const tempRoot = path.join(repoRoot, '.tmp', 'stability-worktrees');
const reportRoot = path.join(repoRoot, '.tmp', 'stability');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function parseArgs(argv) {
  const args = {};
  for (const token of argv) {
    if (!token.startsWith('--')) continue;
    const [key, value = 'true'] = token.slice(2).split('=');
    args[key] = value;
  }
  return args;
}

function run(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed\n${details}`);
  }
  return String(result.stdout || '').trim();
}

function runInherit(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function runInheritNpm(args, cwd) {
  const result = spawnSync(npmCmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (result.error) {
    throw new Error(`${npmCmd} ${args.join(' ')} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${npmCmd} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function safeRm(targetPath) {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function hasLocalJest(modulesDir) {
  if (fs.existsSync(path.join(modulesDir, 'jest', 'package.json'))) {
    return true;
  }
  if (process.platform === 'win32') {
    return fs.existsSync(path.join(modulesDir, '.bin', 'jest.cmd'));
  }
  return fs.existsSync(path.join(modulesDir, '.bin', 'jest'));
}

/**
 * The worktree's node_modules is a junction into the MAIN repo's node_modules
 * (see ensureWorktreeDependencies). `git worktree remove --force` and recursive
 * fs.rmSync can traverse Windows junctions and delete the main repo's real
 * dependencies (observed 2026-07-02: wiped node_modules/.bin and @-scopes
 * until open file handles aborted it). Always detach the link itself first —
 * rmdirSync on a junction removes only the reparse point, never the target.
 */
function removeNodeModulesLink(worktreePath) {
  const linkPath = path.join(worktreePath, 'node_modules');
  let stats;
  try {
    stats = fs.lstatSync(linkPath);
  } catch {
    return;
  }
  if (stats.isSymbolicLink()) {
    fs.rmdirSync(linkPath);
  }
}

function addWorktree(ref, label, runId) {
  const worktreePath = path.join(tempRoot, `${label}-${runId}`);
  removeNodeModulesLink(worktreePath);
  tryRun('git', ['worktree', 'remove', '--force', worktreePath]);
  safeRm(worktreePath);
  tryRun('git', ['worktree', 'prune']);
  run('git', ['worktree', 'add', '--detach', worktreePath, ref]);
  return worktreePath;
}

function removeWorktree(worktreePath) {
  removeNodeModulesLink(worktreePath);
  try {
    run('git', ['worktree', 'remove', '--force', worktreePath]);
  } catch {
    safeRm(worktreePath);
  } finally {
    tryRun('git', ['worktree', 'prune']);
  }
}

function tryRun(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim();
}

/**
 * Git worktrees contain only tracked files; smoke Jest resolves node_modules from the worktree cwd.
 * Link the main repo's node_modules into the worktree (junction on Windows) so smoke runs do not
 * require a full npm ci per worktree (slow, duplicate postinstall, and brittle on Windows spawn).
 *
 * Opt out: STRATOSORT_STABILITY_SKIP_WORKTREE_INSTALL=1 (you already linked or copied deps).
 * Full install: STRATOSORT_STABILITY_FULL_WORKTREE_INSTALL=1 runs npm ci in the worktree instead.
 */
function ensureWorktreeDependencies(worktreePath) {
  if (process.env.STRATOSORT_STABILITY_SKIP_WORKTREE_INSTALL === '1') {
    return;
  }
  const jestMarker = path.join(worktreePath, 'node_modules', 'jest');
  if (fs.existsSync(jestMarker)) {
    return;
  }
  const mainModules = path.join(repoRoot, 'node_modules');
  if (!hasLocalJest(mainModules)) {
    throw new Error(
      'Main repo node_modules is missing Jest; run npm install at the repository root first.'
    );
  }
  if (process.env.STRATOSORT_STABILITY_FULL_WORKTREE_INSTALL === '1') {
    console.log(`[stability] npm ci in worktree (full install): ${worktreePath}`);
    runInheritNpm(['ci'], worktreePath);
    return;
  }
  const dest = path.join(worktreePath, 'node_modules');
  console.log(`[stability] junction node_modules -> main repo (smoke Jest): ${worktreePath}`);
  fs.symlinkSync(mainModules, dest, 'junction');
}

function resolveBaselineRef(targetRef) {
  const exactTag = tryRun('git', ['describe', '--tags', '--exact-match', targetRef]);
  const mergedTagsOutput = run('git', ['tag', '--merged', targetRef, '--sort=-version:refname']);
  const mergedTags = mergedTagsOutput
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));

  const baselineTag = mergedTags.find((tag) => tag !== exactTag);
  if (!baselineTag) {
    throw new Error(`Unable to resolve a baseline tag prior to target '${targetRef}'.`);
  }
  return baselineTag;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetRef = args.target || 'HEAD';
  const baselineRef = args.baseline || resolveBaselineRef(targetRef);
  const outputPath = path.resolve(
    args.output || path.join(repoRoot, 'docs', 'STABILITY_BASELINE_LEDGER.md')
  );
  const runId = `${Date.now()}-${process.pid}`;

  ensureDir(tempRoot);
  ensureDir(reportRoot);

  const baselineWorktree = addWorktree(baselineRef, 'baseline', runId);
  const targetWorktree = addWorktree(targetRef, 'target', runId);
  ensureWorktreeDependencies(baselineWorktree);
  ensureWorktreeDependencies(targetWorktree);

  const baselineReport = path.join(reportRoot, 'baseline-smoke.json');
  const targetReport = path.join(reportRoot, 'target-smoke.json');

  try {
    runInherit(process.execPath, [
      smokeSuiteScript,
      `--project-root=${baselineWorktree}`,
      '--label=baseline',
      '--allow-failures=true',
      `--output=${baselineReport}`
    ]);

    runInherit(process.execPath, [
      smokeSuiteScript,
      `--project-root=${targetWorktree}`,
      '--label=target',
      '--allow-failures=true',
      `--output=${targetReport}`
    ]);

    runInherit(process.execPath, [
      generateLedgerScript,
      `--baseline=${baselineRef}`,
      `--target=${targetRef}`,
      `--baseline-report=${baselineReport}`,
      `--target-report=${targetReport}`,
      `--output=${outputPath}`
    ]);

    fs.writeFileSync(path.join(reportRoot, 'baseline-smoke.json'), fs.readFileSync(baselineReport));
    fs.writeFileSync(path.join(reportRoot, 'target-smoke.json'), fs.readFileSync(targetReport));
  } finally {
    removeWorktree(baselineWorktree);
    removeWorktree(targetWorktree);
  }

  console.log(`\nStability comparison complete: ${outputPath}`);
}

main();
