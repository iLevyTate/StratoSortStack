#!/usr/bin/env node
/**
 * Ensures electron-builder.json declares production Electron fuses and does not
 * undo them via asarUnpack.
 *
 * `enableEmbeddedAsarIntegrityValidation` + `onlyLoadAppFromAsar` only protect
 * code that lives inside app.asar. Any asarUnpack pattern that matches the main,
 * preload or renderer bundles moves them into the writable app.asar.unpacked
 * directory and silently voids both fuses for all application code, so only the
 * worker_threads entry bundles may be unpacked.
 *
 * Full fuse bits are applied at pack time; run `npx @electron/fuses read --app <path>`
 * on a built app to verify the binary.
 */

const fs = require('fs');
const path = require('path');
const { minimatch } = require('minimatch');

const CONFIG_PATH = path.join(__dirname, '..', 'electron-builder.json');

const EXPECTED_FUSE_VALUES = Object.freeze({
  runAsNode: false,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  loadBrowserProcessSpecificV8Snapshot: false,
  grantFileProtocolExtraPrivileges: false
});

// Representative app-code paths that must stay inside the asar.
const INTEGRITY_PROTECTED_PATHS = Object.freeze([
  'dist/main.js',
  'dist/preload.js',
  'dist/index.html',
  'dist/renderer.js',
  'src/shared/constants.js',
  'package.json'
]);

/**
 * @param {unknown} cfg Parsed electron-builder.json
 * @returns {string[]} Human-readable violations (empty when the config is sane)
 */
function validateConfig(cfg) {
  const errors = [];
  const config = /** @type {Record<string, any>} */ (cfg ?? {});
  const fuses = config.electronFuses;

  if (!fuses || typeof fuses !== 'object') {
    errors.push('missing top-level "electronFuses" object');
  } else {
    for (const [key, expectedValue] of Object.entries(EXPECTED_FUSE_VALUES)) {
      if (!(key in fuses)) {
        errors.push(`electronFuses.${key} is required`);
      } else if (fuses[key] !== expectedValue) {
        errors.push(`electronFuses.${key} must be ${JSON.stringify(expectedValue)}`);
      }
    }
  }

  const asarUnpack = Array.isArray(config.asarUnpack) ? config.asarUnpack : [];
  for (const pattern of asarUnpack) {
    const leaked = INTEGRITY_PROTECTED_PATHS.filter((file) =>
      minimatch(file, String(pattern), { dot: true })
    );
    if (leaked.length > 0) {
      errors.push(
        `asarUnpack pattern ${JSON.stringify(pattern)} unpacks ${leaked.join(', ')} out of the integrity-validated asar; only worker entry bundles may be unpacked`
      );
    }
  }

  return errors;
}

function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const errors = validateConfig(cfg);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`electron-builder.json: ${error}`);
    }
    process.exit(1);
  }
  console.log('OK: electronFuses configuration present and asarUnpack keeps app code in the asar.');
}

module.exports = { validateConfig, INTEGRITY_PROTECTED_PATHS };

if (require.main === module) {
  main();
}
