#!/usr/bin/env node
'use strict';

/**
 * Patches a latest-mac*.yml file to reflect the sha512 of a stapled DMG.
 *
 * xcrun stapler staple embeds the notarization ticket directly into the DMG
 * binary, changing its sha512. electron-builder writes the yml before
 * notarization, so the recorded DMG hash is stale. This script:
 *   1. Computes the sha512 of the stapled DMG.
 *   2. Finds the DMG's old sha512 in the yml's `files:` block (by url match).
 *   3. Replaces all occurrences of the old sha512 with the new one.
 *
 * The ZIP is NOT stapled and its sha512 is untouched. On macOS,
 * electron-builder puts the ZIP as the primary artifact (top-level path/sha512)
 * and the DMG as a secondary entry — so we must NOT use the top-level sha512
 * to locate the DMG hash.
 *
 * Usage: node scripts/patch-mac-updater-metadata.js --dmg=<path> --yml=<path>
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

/**
 * Patches updater yml so its DMG sha512 reflects the post-staple binary.
 * Returns true when the yml was updated, false when the sha512 was already current.
 * Throws on invalid input (missing file, DMG not referenced in yml).
 */
function patchMacUpdaterMetadata(dmgPath, ymlPath) {
  const dmgBasename = path.basename(dmgPath);

  const dmgBuf = fs.readFileSync(dmgPath);
  const newSha512 = crypto.createHash('sha512').update(dmgBuf).digest('base64');

  let yml = fs.readFileSync(ymlPath, 'utf8');

  // Locate the DMG's sha512 in the files: block by matching the url line for
  // this DMG, then capturing the sha512 on the very next sha512: line.
  // The files: entry looks like:
  //   - url: StratoSortStack-4.0.4-mac-arm64.dmg
  //     sha512: <OLDSHA>
  //     size: ...
  const escaped = dmgBasename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entryPattern = new RegExp(`url:[^\\n]*${escaped}[^\\n]*\\n\\s*sha512:\\s*(\\S+)`);
  const entryMatch = yml.match(entryPattern);

  if (!entryMatch) {
    throw new Error(`Cannot find sha512 for ${dmgBasename} in ${path.basename(ymlPath)}`);
  }

  const oldSha512 = entryMatch[1];

  if (oldSha512 === newSha512) {
    return false;
  }

  // Replace all occurrences of the old DMG sha512 (appears once in files[] and
  // potentially once at top level if the DMG is the primary artifact).
  // sha512 values are 88-character base64 strings — practically unique.
  yml = yml.split(oldSha512).join(newSha512);
  fs.writeFileSync(ymlPath, yml, 'utf8');
  return true;
}

module.exports = { patchMacUpdaterMetadata };

if (require.main === module) {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const k = arg.slice(2, eq === -1 ? undefined : eq);
    const v = eq === -1 ? true : arg.slice(eq + 1);
    args[k] = v;
  }

  if (!args.dmg || !args.yml) {
    console.error('patch-mac-updater-metadata: Usage: --dmg=<path> --yml=<path>');
    process.exit(1);
  }

  const dmgPath = path.resolve(String(args.dmg));
  const ymlPath = path.resolve(String(args.yml));

  if (!fs.existsSync(dmgPath)) {
    console.error(`patch-mac-updater-metadata: DMG not found: ${dmgPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(ymlPath)) {
    console.error(`patch-mac-updater-metadata: YML not found: ${ymlPath}`);
    process.exit(1);
  }

  try {
    const updated = patchMacUpdaterMetadata(dmgPath, ymlPath);
    const dmgBasename = path.basename(dmgPath);
    const ymlBasename = path.basename(ymlPath);
    if (updated) {
      console.log(`Patched ${ymlBasename}: sha512 updated for ${dmgBasename} (post-staple)`);
    } else {
      console.log(`sha512 already current for ${dmgBasename} — staple may not have run`);
    }
  } catch (err) {
    console.error(`patch-mac-updater-metadata: ${err.message}`);
    process.exit(1);
  }
}
