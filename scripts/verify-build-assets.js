#!/usr/bin/env node

/**
 * Fail fast when release branding assets are unavailable.
 *
 * Release workflows can either:
 * 1. Regenerate packaging assets from the resolved source logo (StratoSortCoreLogo.svg or legacy PNG), or
 * 2. Use pre-committed generated assets under assets/icons and assets/installer.
 *
 * This script verifies that at least one of those paths is available so
 * distribution jobs fail with a clear message before electron-builder starts.
 */

const fs = require('fs');
const path = require('path');

const { resolveSourceLogoPath } = require('./resolveSourceLogo');

const repoRoot = path.resolve(__dirname, '..');
const sourceLogo = resolveSourceLogoPath(repoRoot);

const REQUIRED_ASSETS = {
  win: [
    'assets/icons/win/icon.ico',
    'assets/installer/header.png',
    'assets/installer/welcome.png',
    'assets/installer/finish.png'
  ],
  mac: [
    'assets/icons/mac/icon.icns',
    'assets/icons/mac/icon.png',
    'assets/installer/dmg-background.png'
  ],
  linux: ['assets/icons/png/512x512.png']
};

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};

  args.forEach((arg) => {
    if (!arg.startsWith('--')) return;
    const [rawKey, rawValue] = arg.slice(2).split('=');
    parsed[rawKey] = rawValue === undefined ? true : rawValue;
  });

  return parsed;
}

function exists(targetPath) {
  return fs.existsSync(targetPath);
}

function resolveRequiredAssets(platform) {
  const assets = REQUIRED_ASSETS[platform];
  if (!assets) {
    throw new Error(`Unsupported platform "${platform}". Expected win, mac, or linux.`);
  }
  return assets.map((relativePath) => ({
    relativePath,
    absolutePath: path.join(repoRoot, relativePath)
  }));
}

function verifyPlatform(platform) {
  const requiredAssets = resolveRequiredAssets(platform);
  const missing = requiredAssets.filter((asset) => !exists(asset.absolutePath));
  const hasSourceLogo = Boolean(sourceLogo && exists(sourceLogo));

  if (missing.length === 0) {
    console.log(
      `[verify-build-assets] All ${platform} packaging assets present` +
        (hasSourceLogo ? ' (source logo also available for regeneration).' : '.')
    );
    return;
  }

  const missingList = missing.map((asset) => `- ${asset.relativePath}`).join('\n');

  if (hasSourceLogo) {
    // Don't blanket-pass on source-logo presence: surface exactly which
    // assets the downstream `generate:branding-if-source` step is now
    // REQUIRED to produce, so a skipped/failed regeneration is traceable
    // back to this log instead of a cryptic electron-builder error.
    console.warn(
      `[verify-build-assets] WARNING: ${missing.length} ${platform} packaging asset(s) missing; ` +
        `they MUST be regenerated from ${path.relative(repoRoot, sourceLogo)} ` +
        `(generate:branding-if-source) before electron-builder runs:\n${missingList}`
    );
    return;
  }

  throw new Error(
    `Missing ${platform} release branding assets.\n` +
      `Either commit the generated assets below or add assets/icons/StratoSortCoreLogo.svg (or legacy PNG under assets/) so the workflow can regenerate them.\n` +
      `${missingList}`
  );
}

function main() {
  const args = parseArgs();
  const platformArg = String(args.platform || 'all').toLowerCase();
  const platforms = platformArg === 'all' ? ['win', 'mac'] : [platformArg];

  platforms.forEach(verifyPlatform);
  console.log('[verify-build-assets] Asset verification passed.');
}

try {
  main();
} catch (error) {
  console.error(`[verify-build-assets] ${error.message}`);
  process.exit(1);
}
