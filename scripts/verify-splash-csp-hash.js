#!/usr/bin/env node
/**
 * Ensures the sha256 in the renderer CSP script-src matches the built
 * dist/index.html inline splash script. HtmlWebpackPlugin output can drift from
 * src/renderer/index.html; a mismatch blocks the inline script under CSP and can
 * break window loading.
 *
 * The allowed hashes live in src/main/core/securityHeaders.js
 * (INLINE_SPLASH_SCRIPT_HASHES), the single source of truth shared by the
 * onHeadersReceived CSP and the app:// protocol handler.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const repoRoot = path.resolve(__dirname, '..');
const indexPath = path.join(repoRoot, 'dist', 'index.html');
const securityHeadersPath = path.join(repoRoot, 'src', 'main', 'core', 'securityHeaders.js');

function main() {
  if (!fs.existsSync(indexPath)) {
    console.error('[verify-splash-csp] dist/index.html not found. Run npm run build first.');
    process.exit(1);
  }
  const html = fs.readFileSync(indexPath, 'utf8');
  const inlineBodies = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const body = m[2];
    if (/src\s*=/i.test(attrs)) {
      continue;
    }
    if (!body.trim()) {
      continue;
    }
    inlineBodies.push(body);
  }
  if (inlineBodies.length !== 1) {
    console.error(
      `[verify-splash-csp] expected exactly one inline <script> in dist/index.html, found ${inlineBodies.length}`
    );
    process.exit(1);
  }
  const digest = crypto.createHash('sha256').update(inlineBodies[0], 'utf8').digest('base64');
  const expected = `sha256-${digest}`;

  const securityHeadersSrc = fs.readFileSync(securityHeadersPath, 'utf8');
  const hashesBlock = securityHeadersSrc.match(
    /INLINE_SPLASH_SCRIPT_HASHES\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/
  );
  if (!hashesBlock) {
    console.error(
      '[verify-splash-csp] could not find INLINE_SPLASH_SCRIPT_HASHES in securityHeaders.js'
    );
    process.exit(1);
  }
  const declaredHashes = [...hashesBlock[1].matchAll(/sha256-[A-Za-z0-9+/=]+/g)].map((m) => m[0]);
  if (!declaredHashes.length) {
    console.error(
      '[verify-splash-csp] could not find script-src sha256 entries in securityHeaders.js'
    );
    process.exit(1);
  }
  if (!declaredHashes.includes(expected)) {
    console.error('[verify-splash-csp] CSP hash mismatch.');
    console.error(`  dist/index.html inline script -> ${expected}`);
    console.error(`  securityHeaders.js script-src hashes -> ${declaredHashes.join(', ')}`);
    console.error(
      '  Add or update the matching sha256 in src/main/core/securityHeaders.js (INLINE_SPLASH_SCRIPT_HASHES).'
    );
    process.exit(1);
  }
  console.log('[verify-splash-csp] Inline splash script hash matches securityHeaders.js CSP.');

  // Same contract for the one inline <style> (S-1: style-src-elem is
  // hash-allowlisted in production — a drifted hash blocks the splash CSS).
  const styleBodies = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((match) => match[1])
    .filter((body) => body.trim());
  if (styleBodies.length !== 1) {
    console.error(
      `[verify-splash-csp] expected exactly one inline <style> in dist/index.html, found ${styleBodies.length}`
    );
    process.exit(1);
  }
  const styleDigest = crypto.createHash('sha256').update(styleBodies[0], 'utf8').digest('base64');
  const expectedStyle = `sha256-${styleDigest}`;
  const styleHashesBlock = securityHeadersSrc.match(
    /INLINE_SPLASH_STYLE_HASHES\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/
  );
  if (!styleHashesBlock) {
    console.error(
      '[verify-splash-csp] could not find INLINE_SPLASH_STYLE_HASHES in securityHeaders.js'
    );
    process.exit(1);
  }
  const declaredStyleHashes = [...styleHashesBlock[1].matchAll(/sha256-[A-Za-z0-9+/=]+/g)].map(
    (match) => match[0]
  );
  if (!declaredStyleHashes.includes(expectedStyle)) {
    console.error('[verify-splash-csp] CSP style hash mismatch.');
    console.error(`  dist/index.html inline style -> ${expectedStyle}`);
    console.error(
      `  securityHeaders.js style-src-elem hashes -> ${declaredStyleHashes.join(', ')}`
    );
    console.error(
      '  Add or update the matching sha256 in src/main/core/securityHeaders.js (INLINE_SPLASH_STYLE_HASHES).'
    );
    process.exit(1);
  }
  console.log('[verify-splash-csp] Inline splash style hash matches securityHeaders.js CSP.');
}

main();
