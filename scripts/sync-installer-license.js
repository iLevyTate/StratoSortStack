#!/usr/bin/env node
/**
 * Generates build/license_en.txt from the canonical LICENSE at the repo root.
 * Single source of truth: LICENSE. The generated copy is what NSIS
 * (nsis.license) and dmg-license (dmg.license) consume during packaging.
 *
 * .gitignore excludes build/* except *.nsh, so this output is intentionally
 * untracked and regenerated on every `npm run build`.
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const src = path.join(repoRoot, 'LICENSE');
const destDir = path.join(repoRoot, 'build');
const dest = path.join(destDir, 'license_en.txt');

if (!fs.existsSync(src)) {
  console.error('[sync-installer-license] LICENSE not found at repo root');
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);

const bytes = fs.statSync(dest).size;
console.log(`[sync-installer-license] LICENSE -> build/license_en.txt (${bytes} bytes)`);
