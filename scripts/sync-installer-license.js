#!/usr/bin/env node
/**
 * Generates build/license_en.txt from the canonical LICENSE at the repo root,
 * followed by the installer's third-party component notice. Single source of
 * truth for the license itself: LICENSE. The generated copy is what NSIS
 * (nsis.license) shows on the Windows installer's license page.
 *
 * The appended notice exists because the Windows installer may run
 * Microsoft's Visual C++ Redistributable with /passive or /quiet, which never
 * shows Microsoft's own license page.
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

const INSTALLER_THIRD_PARTY_NOTICE = [
  '',
  '---',
  '',
  'Third-party components installed by this installer',
  '',
  'This installer may install the Microsoft Visual C++ Redistributable, a',
  'separate Microsoft component that StratoSort Stack needs on Windows. It is',
  "subject to Microsoft's license terms",
  '(https://visualstudio.microsoft.com/license-terms/), not to the license',
  'above. Notices for this and other third-party components are in',
  'THIRD_PARTY_NOTICES.md, installed with the app (in its resources folder).',
  ''
].join('\n');

/**
 * @param {string} licenseText contents of LICENSE
 * @returns {string} what the installer's license page shows
 */
function buildInstallerLicenseText(licenseText) {
  return `${String(licenseText).replace(/\s+$/, '')}\n${INSTALLER_THIRD_PARTY_NOTICE}`;
}

function main() {
  if (!fs.existsSync(src)) {
    console.error('[sync-installer-license] LICENSE not found at repo root');
    process.exit(1);
  }

  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(dest, buildInstallerLicenseText(fs.readFileSync(src, 'utf8')));

  const bytes = fs.statSync(dest).size;
  console.log(
    `[sync-installer-license] LICENSE + third-party notice -> build/license_en.txt (${bytes} bytes)`
  );
}

if (require.main === module) {
  main();
}

module.exports = { INSTALLER_THIRD_PARTY_NOTICE, buildInstallerLicenseText };
