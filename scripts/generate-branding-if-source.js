#!/usr/bin/env node
/**
 * Regenerate branding assets when a source logo is present.
 * On macOS runners, fail if icon.icns was not produced (requires iconutil).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { hasSourceLogo, resolveSourceLogoPath } = require('./resolveSourceLogo');

const repoRoot = path.resolve(__dirname, '..');

function runNpmScript(scriptName) {
  const result = spawnSync('npm', ['run', scriptName], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
    env: process.env
  });
  if (result.error) {
    throw new Error(`npm run ${scriptName} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function verifyMacIcns() {
  const icnsPath = path.join(repoRoot, 'assets', 'icons', 'mac', 'icon.icns');
  if (!fs.existsSync(icnsPath) || fs.statSync(icnsPath).size === 0) {
    console.error(
      '[generate-branding-if-source] Expected assets/icons/mac/icon.icns after generation on macOS (iconutil may have failed).'
    );
    process.exit(1);
  }
  console.log(`[generate-branding-if-source] Verified ${path.relative(repoRoot, icnsPath)}`);
}

function main() {
  if (!hasSourceLogo(repoRoot)) {
    console.warn('[generate-branding-if-source] No source logo found; skipping asset generation.');
    return;
  }

  const source = resolveSourceLogoPath(repoRoot);
  console.log(`[generate-branding-if-source] Source logo: ${path.relative(repoRoot, source)}`);

  runNpmScript('generate:assets');

  if (process.platform === 'darwin') {
    verifyMacIcns();
  }
}

main();
