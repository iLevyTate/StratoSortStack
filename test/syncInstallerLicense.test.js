/**
 * @jest-environment node
 *
 * scripts/sync-installer-license.js builds the Windows installer's license
 * page (build/license_en.txt) from LICENSE plus a third-party notice: the
 * installer may run Microsoft's Visual C++ Redistributable with /passive or
 * /quiet, which never shows Microsoft's own license page.
 */
// Reads the real LICENSE / electron-builder.json, not test-setup's memfs.
jest.mock('fs', () => jest.requireActual('fs'));

const fs = require('fs');
const path = require('path');
const {
  INSTALLER_THIRD_PARTY_NOTICE,
  buildInstallerLicenseText
} = require('../scripts/sync-installer-license');

describe('installer license text', () => {
  const license = fs.readFileSync(path.join(__dirname, '..', 'LICENSE'), 'utf8');

  test('is LICENSE unchanged, followed by the third-party notice', () => {
    const text = buildInstallerLicenseText(license);
    expect(text.startsWith(license.replace(/\s+$/, ''))).toBe(true);
    expect(text.endsWith(INSTALLER_THIRD_PARTY_NOTICE)).toBe(true);
  });

  test('names the VC++ Redistributable, Microsoft terms and the shipped notices file', () => {
    const notice = INSTALLER_THIRD_PARTY_NOTICE.replace(/\s+/g, ' ');
    expect(notice).toContain('This installer may install the Microsoft Visual C++ Redistributable');
    expect(notice).toContain("subject to Microsoft's license terms");
    expect(notice).toContain('https://visualstudio.microsoft.com/license-terms/');
    expect(notice).toContain('THIRD_PARTY_NOTICES.md');
  });

  test('THIRD_PARTY_NOTICES.md really ships with the app', () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'electron-builder.json'), 'utf8')
    );
    const shipped = JSON.stringify(config);
    expect(shipped).toContain('"to":"THIRD_PARTY_NOTICES.md"');
    expect(config.nsis.license).toBe('build/license_en.txt');
  });
});
