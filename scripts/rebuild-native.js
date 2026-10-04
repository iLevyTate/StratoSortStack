// scripts/rebuild-native.js

const { rebuild } = require('@electron/rebuild');
const path = require('path');
const { getRebuildTargets } = require('./native-modules');

function parseTargetArch() {
  const archArg = process.argv.find((a) => a.startsWith('--arch='));
  return archArg ? archArg.split('=')[1] : process.arch;
}

async function rebuildNativeModules() {
  const electronVersion = require('electron/package.json').version;
  const targetArch = parseTargetArch();
  const onlyModules = getRebuildTargets();

  if (onlyModules.length === 0) {
    console.log('No modules flagged for Electron rebuild; skipping.');
    return;
  }

  console.log(
    `Rebuilding native modules for Electron ${electronVersion} (${targetArch}): ${onlyModules.join(', ')}`
  );

  // `useElectronClang` downloads and uses Electron's bundled toolchain
  // (libc++ on darwin). It is ONLY supported on macOS — setting it on
  // Linux / Windows makes @electron/rebuild fetch a compiler archive that
  // doesn't apply to the host, which at best wastes bandwidth and at
  // worst causes spurious rebuild failures on GitHub Actions Windows
  // runners. See electron/rebuild README and upstream issue discussions.
  const useElectronClang = process.platform === 'darwin';

  await rebuild({
    buildPath: path.resolve(__dirname, '..'),
    electronVersion,
    arch: targetArch,
    onlyModules,
    useElectronClang
  });

  console.log('Native module rebuild complete!');
}

rebuildNativeModules().catch((error) => {
  console.error('Native module rebuild failed:', error);
  process.exitCode = 1;
});
