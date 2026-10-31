const fs = require('fs');
const os = require('os');
const path = require('path');

const { verifyWin } = require('../scripts/verify-updater-metadata');
const { channelFile, writeArtifacts } = require('./utils/updaterMetadataFixtures');

const X64_SETUP = 'StratoSortStack-Setup-4.0.2.exe';
const ARM64_SETUP = 'StratoSortStack-Setup-4.0.2-arm64.exe';
const X64_ZIP = 'StratoSortStack-4.0.2-win-x64.zip';

describe('verify-updater-metadata (windows)', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-updater-meta-win-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeChannel(name, artifacts) {
    fs.writeFileSync(path.join(tempDir, name), channelFile('4.0.2', artifacts));
  }

  test('arm64 matrix leg passes with electron-builder output scoped to arch=arm64', () => {
    const [arm64] = writeArtifacts(tempDir, { [ARM64_SETUP]: 48 });
    writeChannel('latest.yml', [arm64]);

    expect(() => verifyWin(tempDir, 'arm64')).not.toThrow();
  });

  test('x64 scoping ignores an arm64 installer the channel file does not list', () => {
    const [x64] = writeArtifacts(tempDir, { [X64_SETUP]: 32, [ARM64_SETUP]: 48 });
    writeChannel('latest.yml', [x64]);

    expect(() => verifyWin(tempDir, 'x64')).not.toThrow();
  });

  test('rejects arch-suffixed staging metadata that Windows clients never request', () => {
    const [arm64] = writeArtifacts(tempDir, { [ARM64_SETUP]: 48 });
    writeChannel('latest-arm64.yml', [arm64]);

    expect(() => verifyWin(tempDir, 'arm64')).toThrow(/latest-arm64\.yml/);
  });

  test('merged publish root requires latest.yml to reference both installers', () => {
    const [x64, arm64] = writeArtifacts(tempDir, { [X64_SETUP]: 32, [ARM64_SETUP]: 48 });
    writeChannel('latest.yml', [x64]);

    expect(() => verifyWin(tempDir)).toThrow(/does not reference the arm64 installer/);

    writeChannel('latest.yml', [x64, arm64]);
    expect(() => verifyWin(tempDir)).not.toThrow();
  });

  test('requires the x64 installer to be listed before the arm64 one', () => {
    const [x64, arm64] = writeArtifacts(tempDir, { [X64_SETUP]: 32, [ARM64_SETUP]: 48 });
    writeChannel('latest.yml', [arm64, x64]);

    expect(() => verifyWin(tempDir)).toThrow(/arm64 installer before the x64 one/);
  });

  test('ignores the no-install zip that ships next to the x64 installer', () => {
    const [x64] = writeArtifacts(tempDir, { [X64_SETUP]: 32, [X64_ZIP]: 40 });
    writeChannel('latest.yml', [x64]);

    expect(() => verifyWin(tempDir, 'x64')).not.toThrow();
  });

  test('rejects a channel file that offers the zip as an update', () => {
    const [x64, zip] = writeArtifacts(tempDir, { [X64_SETUP]: 32, [X64_ZIP]: 40 });
    writeChannel('latest.yml', [zip, x64]);

    expect(() => verifyWin(tempDir, 'x64')).toThrow(
      /must list only the NSIS installers, found: StratoSortStack-4\.0\.2-win-x64\.zip/
    );
  });

  test('fails on sha512 mismatch between metadata and installer bytes', () => {
    writeArtifacts(tempDir, { [X64_SETUP]: 32 });
    writeChannel('latest.yml', [{ name: X64_SETUP, bytes: Buffer.alloc(64) }]);

    expect(() => verifyWin(tempDir, 'x64')).toThrow(/sha512 mismatch/);
  });

  test('fails when metadata references a missing installer', () => {
    const [x64] = writeArtifacts(tempDir, { [X64_SETUP]: 32 });
    writeChannel('latest.yml', [{ ...x64, name: 'StratoSortStack-Setup-4.0.2-missing.exe' }]);

    expect(() => verifyWin(tempDir, 'x64')).toThrow(/missing artifact/);
  });
});
