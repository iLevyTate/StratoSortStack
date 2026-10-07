const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  classifyLinuxArtifacts,
  selectLinuxMetadataFiles,
  verifyLinux
} = require('../scripts/verify-updater-metadata');

function sha512Base64(contents) {
  return crypto.createHash('sha512').update(contents).digest('base64');
}

describe('verify-updater-metadata (linux)', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-updater-meta-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('classifyLinuxArtifacts separates x64 and arm64 installers', () => {
    const files = [
      'StratoSortStack-4.0.2-linux-x64.AppImage',
      'StratoSortStack-4.0.2-linux-arm64.deb',
      'latest-linux-arm64.yml'
    ];
    expect(classifyLinuxArtifacts(files)).toEqual({
      x64: ['StratoSortStack-4.0.2-linux-x64.AppImage'],
      arm64: ['StratoSortStack-4.0.2-linux-arm64.deb']
    });
  });

  test('arm64 matrix leg passes after metadata rename when scoped with --arch=arm64', () => {
    const appImage = 'StratoSortStack-4.0.2-linux-arm64.AppImage';
    const deb = 'StratoSortStack-4.0.2-linux-arm64.deb';
    const appBytes = Buffer.alloc(32);
    const debBytes = Buffer.alloc(32);
    const appHash = sha512Base64(appBytes);
    const debHash = sha512Base64(debBytes);
    const metadata = `version: 4.0.2
files:
  - url: ${appImage}
    sha512: ${appHash}
    size: 32
  - url: ${deb}
    sha512: ${debHash}
    size: 32
path: ${appImage}
sha512: ${appHash}
releaseDate: '2026-06-08T00:00:00.000Z'
`;

    fs.writeFileSync(path.join(tempDir, appImage), appBytes);
    fs.writeFileSync(path.join(tempDir, deb), debBytes);
    fs.writeFileSync(path.join(tempDir, 'latest-linux-arm64.yml'), metadata);

    expect(() => verifyLinux(tempDir, 'arm64')).not.toThrow();
  });

  test('arm64 matrix leg does not require x64 metadata after rename', () => {
    const appImage = 'StratoSortStack-4.0.2-linux-arm64.AppImage';
    const appBytes = Buffer.alloc(32);
    const appHash = sha512Base64(appBytes);
    const metadata = `version: 4.0.2
path: ${appImage}
sha512: ${appHash}
releaseDate: '2026-06-08T00:00:00.000Z'
`;

    fs.writeFileSync(path.join(tempDir, appImage), appBytes);
    fs.writeFileSync(path.join(tempDir, 'latest-linux-arm64.yml'), metadata);

    expect(() => verifyLinux(tempDir, 'arm64')).not.toThrow();
  });

  test('merged publish root still requires both feeds when both arches are present', () => {
    const x64Image = 'StratoSortStack-4.0.2-linux-x64.AppImage';
    const arm64Image = 'StratoSortStack-4.0.2-linux-arm64.AppImage';
    const x64Bytes = Buffer.alloc(32);
    const arm64Bytes = Buffer.alloc(48);
    const x64Hash = sha512Base64(x64Bytes);
    const arm64Hash = sha512Base64(arm64Bytes);
    const x64Meta = `version: 4.0.2
path: ${x64Image}
sha512: ${x64Hash}
releaseDate: '2026-06-08T00:00:00.000Z'
`;
    const arm64Meta = `version: 4.0.2
path: ${arm64Image}
sha512: ${arm64Hash}
releaseDate: '2026-06-08T00:00:00.000Z'
`;

    fs.writeFileSync(path.join(tempDir, x64Image), x64Bytes);
    fs.writeFileSync(path.join(tempDir, arm64Image), arm64Bytes);
    fs.writeFileSync(path.join(tempDir, 'latest-linux.yml'), x64Meta);
    fs.writeFileSync(path.join(tempDir, 'latest-linux-arm64.yml'), arm64Meta);

    expect(() => verifyLinux(tempDir)).not.toThrow();
  });

  test('selectLinuxMetadataFiles filters by architecture', () => {
    const files = ['latest-linux.yml', 'latest-linux-arm64.yml', 'latest.yml'];
    expect(selectLinuxMetadataFiles(files, 'arm64')).toEqual(['latest-linux-arm64.yml']);
    expect(selectLinuxMetadataFiles(files, 'x64')).toEqual(['latest-linux.yml', 'latest.yml']);
  });
});
