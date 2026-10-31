#!/usr/bin/env node
/**
 * Build Windows x64 + arm64 installers sequentially and stage both under
 * release/dual-windows/ without losing the x64 artifacts to the arm64 pass.
 *
 * Restores host-arch native modules after the arm64 leg so `npm run dev` keeps
 * working on the machine that ran this script.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const packageVersion = require(path.join(repoRoot, 'package.json')).version;
const buildDir = path.join(repoRoot, 'release', 'build');
const dualRoot = path.join(repoRoot, 'release', 'dual-windows');
const nodeCmd = process.execPath;

function runNpmScript(scriptName) {
  const printable = `npm run ${scriptName}`;
  console.log(`\n> ${printable}`);
  const args = process.env.npm_execpath
    ? [process.env.npm_execpath, 'run', scriptName]
    : process.platform === 'win32'
      ? ['run', scriptName]
      : ['run', scriptName];
  const command = process.env.npm_execpath
    ? nodeCmd
    : process.platform === 'win32'
      ? 'npm.cmd'
      : 'npm';
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', env: process.env });
  if (result.error) {
    throw new Error(`${printable} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${printable} exited with code ${result.status ?? 1}`);
  }
}

// The x64 leg's no-install zip (electron-builder `zip` target). The arm64 leg
// builds the installer only, so a copy of this name in its output is stale.
// Compared as a plain lowercase string so the version never reaches a RegExp.
const X64_ZIP_NAME = `StratoSortStack-${packageVersion}-win-x64.zip`.toLowerCase();

/** @param {string} name */
function isX64Zip(name) {
  return name.toLowerCase() === X64_ZIP_NAME;
}

function listInstallerArtifacts(dir) {
  if (!fs.existsSync(dir)) {
    throw new Error(`Expected build output at ${dir}`);
  }
  return fs.readdirSync(dir).filter((name) => {
    const lower = name.toLowerCase();
    return (
      lower.endsWith('.exe') ||
      lower.endsWith('.zip') ||
      lower.endsWith('.blockmap') ||
      /^latest(-arm64)?\.yml$/i.test(name)
    );
  });
}

function copyBuildOutput(targetDir, leg) {
  const names = listInstallerArtifacts(buildDir);
  if (names.length === 0) {
    throw new Error(`No installer artifacts found in ${buildDir}`);
  }
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });

  for (const name of names) {
    if (leg === 'arm64' && isX64Zip(name)) {
      continue;
    }
    if (leg === 'x64' && /-arm64\.(exe|blockmap)$/i.test(name)) {
      continue;
    }

    const src = path.join(buildDir, name);
    let destName = name;
    if (leg === 'arm64' && /^latest\.yml$/i.test(name)) {
      destName = 'latest-arm64.yml';
    }
    const dest = path.join(targetDir, destName);
    fs.cpSync(src, dest, { recursive: true });
  }
}

function mergeIntoCombined() {
  const combinedDir = path.join(dualRoot, 'combined');
  fs.rmSync(combinedDir, { recursive: true, force: true });
  fs.mkdirSync(combinedDir, { recursive: true });

  for (const leg of ['x64', 'arm64']) {
    const legDir = path.join(dualRoot, leg);
    if (!fs.existsSync(legDir)) continue;
    for (const name of fs.readdirSync(legDir)) {
      if (leg === 'arm64' && isX64Zip(name)) {
        continue;
      }
      const src = path.join(legDir, name);
      let destName = name;
      if (leg === 'arm64' && /^latest\.yml$/i.test(name)) {
        destName = 'latest-arm64.yml';
      }
      const dest = path.join(combinedDir, destName);
      if (fs.existsSync(dest)) {
        throw new Error(`Conflicting dual-windows artifact name: ${destName}`);
      }
      fs.cpSync(src, dest, { recursive: true });
    }
  }
}

function cleanBuildDir() {
  fs.rmSync(buildDir, { recursive: true, force: true });
}

function main() {
  fs.mkdirSync(path.join(repoRoot, 'release'), { recursive: true });

  cleanBuildDir();
  runNpmScript('dist:win');
  copyBuildOutput(path.join(dualRoot, 'x64'), 'x64');

  cleanBuildDir();
  runNpmScript('rebuild');
  runNpmScript('dist:win:arm64');
  copyBuildOutput(path.join(dualRoot, 'arm64'), 'arm64');

  runNpmScript('rebuild');
  mergeIntoCombined();

  console.log('\nDual Windows build complete.');
  console.log(`  x64 artifacts:      ${path.join(dualRoot, 'x64')}`);
  console.log(`  arm64 artifacts:    ${path.join(dualRoot, 'arm64')}`);
  console.log(`  merged for upload:  ${path.join(dualRoot, 'combined')}`);
}

try {
  if (require.main === module) {
    main();
  }
} catch (error) {
  console.error(`Dual Windows build failed: ${error?.message || error}`);
  process.exit(1);
}

module.exports = { mergeIntoCombined };
