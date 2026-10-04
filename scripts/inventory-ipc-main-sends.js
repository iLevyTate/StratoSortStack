#!/usr/bin/env node

/**
 * Inventory main-process push IPC (main → renderer).
 * Ensures new code prefers safeSend + ipcEventSchemas over raw webContents.send.
 *
 * Usage: node scripts/inventory-ipc-main-sends.js
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const MAIN_SRC = path.join(repoRoot, 'src', 'main');

function collectJsFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectJsFiles(full));
    else if (ent.isFile() && ent.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function main() {
  const files = collectJsFiles(MAIN_SRC);
  const rawSendHits = [];
  let safeSendCount = 0;

  for (const file of files) {
    const rel = path.relative(repoRoot, file);
    if (rel.replace(/\\/g, '/') === 'src/main/ipc/ipcWrappers.js') {
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    const safeMatches = text.match(/\bsafeSend\s*\(/g);
    if (safeMatches) safeSendCount += safeMatches.length;

    // Raw webContents.send( - exclude comments heuristically by line scan
    const lines = text.split(/\r?\n/);
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      if (/webContents\.send\s*\(/.test(line) && !/safeSend/.test(line)) {
        rawSendHits.push({ file: rel, line: idx + 1, text: trimmed.slice(0, 120) });
      }
    });
  }

  console.log('Main → renderer IPC send inventory');
  console.log(`  safeSend( calls (approx): ${safeSendCount}`);
  console.log(`  Raw webContents.send lines: ${rawSendHits.length}`);
  if (rawSendHits.length > 0) {
    console.log('\n  Raw sends (should be limited to ipcWrappers.js only):');
    for (const h of rawSendHits) {
      console.log(`    ${h.file}:${h.line} ${h.text}`);
    }
    process.exitCode = 1;
  } else {
    console.log('  OK: no raw webContents.send outside audited usage.');
  }
}

main();
