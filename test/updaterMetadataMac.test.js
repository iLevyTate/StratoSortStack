const fs = require('fs');
const os = require('os');
const path = require('path');

const { verifyMac } = require('../scripts/verify-updater-metadata');
const { channelFile, writeArtifacts } = require('./utils/updaterMetadataFixtures');

const X64_ZIP = 'StratoSortStack-4.0.2-mac-x64.zip';
const X64_DMG = 'StratoSortStack-4.0.2-mac-x64.dmg';
const ARM64_ZIP = 'StratoSortStack-4.0.2-mac-arm64.zip';
const ARM64_DMG = 'StratoSortStack-4.0.2-mac-arm64.dmg';

describe('verify-updater-metadata (mac)', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-updater-meta-mac-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeChannel(name, artifacts) {
    fs.writeFileSync(path.join(tempDir, name), channelFile('4.0.2', artifacts));
  }

  test('single-arch build root passes with electron-builder output', () => {
    const artifacts = writeArtifacts(tempDir, { [ARM64_ZIP]: 32, [ARM64_DMG]: 40 });
    writeChannel('latest-mac.yml', artifacts);

    expect(() => verifyMac(tempDir)).not.toThrow();
  });

  test('root with only latest-mac-arm64.yml throws (darwin clients request latest-mac.yml)', () => {
    const artifacts = writeArtifacts(tempDir, { [ARM64_ZIP]: 32, [ARM64_DMG]: 40 });
    writeChannel('latest-mac-arm64.yml', artifacts);

    expect(() => verifyMac(tempDir)).toThrow(/latest-mac-arm64\.yml.*latest-mac\.yml/);
  });

  test('missing latest-mac.yml throws even when no staging files are present', () => {
    writeArtifacts(tempDir, { [ARM64_ZIP]: 32 });

    expect(() => verifyMac(tempDir)).toThrow(/Missing canonical macOS updater metadata/);
  });

  test('merged latest-mac.yml lacking the arm64 zip while arm64 artifacts are present throws', () => {
    const [x64Zip, x64Dmg] = writeArtifacts(tempDir, {
      [X64_ZIP]: 32,
      [X64_DMG]: 40,
      [ARM64_ZIP]: 48,
      [ARM64_DMG]: 56
    });
    writeChannel('latest-mac.yml', [x64Zip, x64Dmg]);

    expect(() => verifyMac(tempDir)).toThrow(/does not reference the macOS arm64 zip/);
  });

  test('merged latest-mac.yml referencing both arch zips passes and is hash-verified', () => {
    const artifacts = writeArtifacts(tempDir, {
      [X64_ZIP]: 32,
      [X64_DMG]: 40,
      [ARM64_ZIP]: 48,
      [ARM64_DMG]: 56
    });
    writeChannel('latest-mac.yml', artifacts);
    expect(() => verifyMac(tempDir)).not.toThrow();

    fs.writeFileSync(path.join(tempDir, ARM64_ZIP), Buffer.alloc(48, 0xff));
    expect(() => verifyMac(tempDir)).toThrow(/sha512 mismatch/);
  });

  test('ignores Linux channel files sharing the publish root', () => {
    const artifacts = writeArtifacts(tempDir, { [ARM64_ZIP]: 32 });
    writeChannel('latest-mac.yml', artifacts);
    fs.writeFileSync(path.join(tempDir, 'latest-linux.yml'), 'version: 4.0.2\n');
    fs.writeFileSync(path.join(tempDir, 'latest-linux-arm64.yml'), 'version: 4.0.2\n');

    expect(() => verifyMac(tempDir)).not.toThrow();
  });
});
