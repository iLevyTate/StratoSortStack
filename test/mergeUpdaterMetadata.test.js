const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  mergeChannelFiles,
  mergeChannelFilePaths,
  parseChannelFile
} = require('../scripts/merge-updater-metadata');
const { verifyMac, verifyWin } = require('../scripts/verify-updater-metadata');
const { channelFile, sha512Base64, writeArtifacts } = require('./utils/updaterMetadataFixtures');

const X64_SETUP = 'StratoSortCore-Setup-4.0.2.exe';
const ARM64_SETUP = 'StratoSortCore-Setup-4.0.2-arm64.exe';

function fixture(name, size) {
  return { name, bytes: Buffer.alloc(size, name.length) };
}

describe('merge-updater-metadata', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-merge-updater-meta-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('unions files: across arch channel files, taking legacy fields from the first', () => {
    const x64 = fixture(X64_SETUP, 32);
    const arm64 = fixture(ARM64_SETUP, 48);
    const merged = mergeChannelFiles([
      { label: 'latest-x64.yml', text: channelFile('4.0.2', [x64]) },
      { label: 'latest-arm64.yml', text: channelFile('4.0.2', [arm64]) }
    ]);

    const doc = parseChannelFile(merged, 'merged');
    expect(doc.files.map((f) => f.url)).toEqual([X64_SETUP, ARM64_SETUP]);
    expect(doc.scalars).toEqual([
      { key: 'version', value: '4.0.2' },
      { key: 'path', value: X64_SETUP },
      { key: 'sha512', value: sha512Base64(x64.bytes) },
      { key: 'releaseDate', value: "'2026-06-08T00:00:00.000Z'" }
    ]);
    expect(merged).toContain(`    sha512: ${sha512Base64(arm64.bytes)}\n    size: 48\n`);
  });

  test('preserves extra per-entry fields such as blockMapSize verbatim', () => {
    const text = `version: 4.0.2
files:
  - url: ${X64_SETUP}
    sha512: abc==
    size: 32
    blockMapSize: 12
path: ${X64_SETUP}
sha512: abc==
releaseDate: '2026-06-08T00:00:00.000Z'
`;
    expect(mergeChannelFiles([{ label: 'a', text }])).toBe(text);
  });

  test('dedupes identical urls and rejects conflicting hashes for the same url', () => {
    const x64 = fixture(X64_SETUP, 32);
    const arm64 = fixture(ARM64_SETUP, 48);
    const merged = mergeChannelFiles([
      { label: 'a', text: channelFile('4.0.2', [x64, arm64]) },
      { label: 'b', text: channelFile('4.0.2', [arm64]) }
    ]);
    expect(parseChannelFile(merged, 'merged').files).toHaveLength(2);

    expect(() =>
      mergeChannelFiles([
        { label: 'a', text: channelFile('4.0.2', [arm64]) },
        { label: 'b', text: channelFile('4.0.2', [{ ...arm64, bytes: Buffer.alloc(48, 1) }]) }
      ])
    ).toThrow(/Conflicting sha512 for StratoSortCore-Setup-4\.0\.2-arm64\.exe/);
  });

  test('throws when channel files disagree on version', () => {
    expect(() =>
      mergeChannelFiles([
        { label: 'latest-x64.yml', text: channelFile('4.0.2', [fixture(X64_SETUP, 32)]) },
        { label: 'latest-arm64.yml', text: channelFile('4.0.3', [fixture(ARM64_SETUP, 48)]) }
      ])
    ).toThrow(/Version mismatch: latest-x64\.yml has 4\.0\.2 but latest-arm64\.yml has 4\.0\.3/);
  });

  test('synthesizes a files: entry from a legacy path/sha512-only document', () => {
    const legacy = `version: 4.0.2
path: ${ARM64_SETUP}
sha512: legacy==
releaseDate: '2026-06-08T00:00:00.000Z'
`;
    const merged = mergeChannelFiles([
      { label: 'x64', text: channelFile('4.0.2', [fixture(X64_SETUP, 32)]) },
      { label: 'arm64', text: legacy }
    ]);
    const entries = parseChannelFile(merged, 'merged').files;
    expect(entries.map((f) => f.url)).toEqual([X64_SETUP, ARM64_SETUP]);
    expect(entries[1].fields).toEqual([
      { key: 'url', value: ARM64_SETUP },
      { key: 'sha512', value: 'legacy==' }
    ]);
  });

  test('rejects nested structures the electron-builder schema does not use', () => {
    const text = `version: 4.0.2
releaseNotes:
  - note: hello
path: a.exe
sha512: x
`;
    expect(() => mergeChannelFiles([{ label: 'odd', text }])).toThrow(/nested content/);
  });

  test('requires at least one input and an output path on disk', () => {
    expect(() => mergeChannelFiles([])).toThrow(/At least one channel file/);
    expect(() => mergeChannelFilePaths([path.join(tempDir, 'nope.yml')], 'out.yml')).toThrow(
      /Channel file missing/
    );
  });

  test('merged Windows output satisfies verifyWin on a two-arch publish root', () => {
    const [x64, arm64] = writeArtifacts(tempDir, { [X64_SETUP]: 32, [ARM64_SETUP]: 48 });
    const x64Path = path.join(tempDir, 'latest-x64.yml');
    const arm64Path = path.join(tempDir, 'latest-arm64.yml');
    fs.writeFileSync(x64Path, channelFile('4.0.2', [x64]));
    fs.writeFileSync(arm64Path, channelFile('4.0.2', [arm64]));

    mergeChannelFilePaths([x64Path, arm64Path], path.join(tempDir, 'latest.yml'));
    fs.rmSync(x64Path);
    fs.rmSync(arm64Path);

    expect(() => verifyWin(tempDir)).not.toThrow();
  });

  test('merged macOS output satisfies verifyMac on a two-arch publish root', () => {
    const [x64Zip, x64Dmg, arm64Zip, arm64Dmg] = writeArtifacts(tempDir, {
      'StratoSortCore-4.0.2-mac-x64.zip': 32,
      'StratoSortCore-4.0.2-mac-x64.dmg': 40,
      'StratoSortCore-4.0.2-mac-arm64.zip': 48,
      'StratoSortCore-4.0.2-mac-arm64.dmg': 56
    });
    const x64Path = path.join(tempDir, 'latest-mac-x64.yml');
    const arm64Path = path.join(tempDir, 'latest-mac-arm64.yml');
    fs.writeFileSync(x64Path, channelFile('4.0.2', [x64Zip, x64Dmg]));
    fs.writeFileSync(arm64Path, channelFile('4.0.2', [arm64Zip, arm64Dmg]));

    mergeChannelFilePaths([x64Path, arm64Path], path.join(tempDir, 'latest-mac.yml'));
    fs.rmSync(x64Path);
    fs.rmSync(arm64Path);

    expect(() => verifyMac(tempDir)).not.toThrow();
  });
});
