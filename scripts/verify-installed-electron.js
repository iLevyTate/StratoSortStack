#!/usr/bin/env node
/**
 * Verifies that the Electron installed in node_modules matches the version
 * pinned in package-lock.json. A drifted node_modules (e.g. `npm install`
 * never re-run after a lockfile bump) lets `npm run dist:win` package an
 * Electron binary + V8 snapshot pair that differs from what CI ships,
 * producing non-reproducible builds and — if the drift ever widens across a
 * V8 ABI boundary (Electron 41 -> 42, ABI 136 -> 137) — a "corrupted"
 * installer whose native modules fail to load at launch.
 *
 * Policy (same standalone-friendly shape as scripts/verify-version-tag.js):
 *   - installed == lockfile                     -> silent OK
 *   - installed != lockfile                     -> FAIL with `npm ci` hint
 *   - electron not installed / lockfile absent  -> silent OK (CI tarball,
 *                                                  pre-install checkout, etc.)
 *
 * Wired into `npm run local:gate` and `predist:win`. Run standalone:
 * `npm run verify:installed-electron`.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const LOCKFILE = path.join(REPO_ROOT, 'package-lock.json');
const INSTALLED_PACKAGE_JSON = path.join(REPO_ROOT, 'node_modules', 'electron', 'package.json');
const LOCK_KEY = 'node_modules/electron';

function readJsonOrNull(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readLockedElectronVersion() {
  const lock = readJsonOrNull(LOCKFILE);
  const version = lock?.packages?.[LOCK_KEY]?.version;
  return typeof version === 'string' && version ? version : null;
}

function readInstalledElectronVersion() {
  const pkg = readJsonOrNull(INSTALLED_PACKAGE_JSON);
  const version = pkg?.version;
  return typeof version === 'string' && version ? version : null;
}

function main() {
  const locked = readLockedElectronVersion();
  const installed = readInstalledElectronVersion();

  if (!locked) {
    console.log('verify:installed-electron: no electron entry in package-lock.json — OK.');
    return;
  }

  if (!installed) {
    console.log('verify:installed-electron: electron not installed in node_modules — OK.');
    return;
  }

  if (installed === locked) {
    console.log(`verify:installed-electron: electron ${installed} matches package-lock.json — OK.`);
    return;
  }

  console.error(
    `FAIL: installed electron ${installed} does not match package-lock.json ${locked}. ` +
      `node_modules has drifted from the lockfile; a local package build would bundle a ` +
      `mismatched Electron binary / V8 snapshot. Run \`npm ci\` to resync.`
  );
  process.exit(1);
}

main();
