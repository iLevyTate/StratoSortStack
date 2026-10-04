'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { patchMacUpdaterMetadata } = require('../scripts/patch-mac-updater-metadata');

function sha512b64(buf) {
  return crypto.createHash('sha512').update(buf).digest('base64');
}

function makeYml(dir, name, dmgName, dmgSha, zipName, zipSha) {
  const yml = [
    'version: 4.0.4',
    'files:',
    `  - url: ${zipName}`,
    `    sha512: ${zipSha}`,
    '    size: 1000',
    `  - url: ${dmgName}`,
    `    sha512: ${dmgSha}`,
    '    size: 2000',
    `path: ${zipName}`,
    `sha512: ${zipSha}`,
    'size: 1000',
    'releaseDate: 2026-06-13T00:00:00.000Z'
  ].join('\n');
  const p = path.join(dir, name);
  fs.writeFileSync(p, yml, 'utf8');
  return p;
}

describe('patchMacUpdaterMetadata', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-mac-meta-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('updates only the DMG sha512 when ZIP is the primary artifact (top-level sha512)', () => {
    const preStaleDmgContent = Buffer.from('pre-staple-dmg-bytes');
    const staledDmgContent = Buffer.from('stapled-dmg-bytes-with-ticket-embedded');
    const zipContent = Buffer.from('zip-content-unchanged');

    const preStaleSha = sha512b64(preStaleDmgContent);
    const newDmgSha = sha512b64(staledDmgContent);
    const zipSha = sha512b64(zipContent);

    const dmgPath = path.join(tmpDir, 'StratoSort-4.0.4-mac-arm64.dmg');
    fs.writeFileSync(dmgPath, staledDmgContent);

    const ymlPath = makeYml(
      tmpDir,
      'latest-mac-arm64.yml',
      'StratoSort-4.0.4-mac-arm64.dmg',
      preStaleSha,
      'StratoSort-4.0.4-mac-arm64.zip',
      zipSha
    );

    const updated = patchMacUpdaterMetadata(dmgPath, ymlPath);
    expect(updated).toBe(true);

    const patched = fs.readFileSync(ymlPath, 'utf8');

    // DMG sha512 updated everywhere
    expect(patched).toContain(newDmgSha);
    expect(patched).not.toContain(preStaleSha);

    // ZIP sha512 untouched
    expect(patched).toContain(zipSha);

    // ZIP remains the top-level primary artifact
    const topSha = patched.match(/^sha512:\s*(\S+)/m)[1];
    expect(topSha).toBe(zipSha);
  });

  test('returns false and leaves yml unchanged when sha512 already matches', () => {
    const dmgContent = Buffer.from('already-stapled-bytes');
    const currentSha = sha512b64(dmgContent);
    const zipSha = sha512b64(Buffer.from('zip'));

    const dmgPath = path.join(tmpDir, 'StratoSort-4.0.4-mac-arm64.dmg');
    fs.writeFileSync(dmgPath, dmgContent);

    const ymlPath = makeYml(
      tmpDir,
      'latest-mac-arm64.yml',
      'StratoSort-4.0.4-mac-arm64.dmg',
      currentSha,
      'StratoSort-4.0.4-mac-arm64.zip',
      zipSha
    );
    const before = fs.readFileSync(ymlPath, 'utf8');

    const updated = patchMacUpdaterMetadata(dmgPath, ymlPath);
    expect(updated).toBe(false);
    expect(fs.readFileSync(ymlPath, 'utf8')).toBe(before);
  });

  test('throws when yml does not reference the DMG filename', () => {
    const dmgContent = Buffer.from('dmg-content');
    const dmgPath = path.join(tmpDir, 'Other-mac-arm64.dmg');
    fs.writeFileSync(dmgPath, dmgContent);

    const ymlPath = makeYml(
      tmpDir,
      'latest-mac-arm64.yml',
      'StratoSort-4.0.4-mac-arm64.dmg',
      sha512b64(Buffer.from('old')),
      'StratoSort-4.0.4-mac-arm64.zip',
      sha512b64(Buffer.from('zip'))
    );

    expect(() => patchMacUpdaterMetadata(dmgPath, ymlPath)).toThrow(/Cannot find sha512/);
  });

  test('handles DMG as primary artifact (top-level sha512 is DMG hash)', () => {
    const preStaleDmgContent = Buffer.from('pre-staple-bytes');
    const staledDmgContent = Buffer.from('stapled-bytes');
    const preStaleSha = sha512b64(preStaleDmgContent);
    const newDmgSha = sha512b64(staledDmgContent);

    const dmgPath = path.join(tmpDir, 'StratoSort-4.0.4-mac-arm64.dmg');
    fs.writeFileSync(dmgPath, staledDmgContent);

    // yml where DMG is primary (top-level sha512 = DMG sha)
    const yml = [
      'version: 4.0.4',
      'files:',
      `  - url: StratoSort-4.0.4-mac-arm64.dmg`,
      `    sha512: ${preStaleSha}`,
      '    size: 2000',
      `path: StratoSort-4.0.4-mac-arm64.dmg`,
      `sha512: ${preStaleSha}`,
      'size: 2000',
      'releaseDate: 2026-06-13T00:00:00.000Z'
    ].join('\n');
    const ymlPath = path.join(tmpDir, 'latest-mac-arm64.yml');
    fs.writeFileSync(ymlPath, yml, 'utf8');

    patchMacUpdaterMetadata(dmgPath, ymlPath);
    const patched = fs.readFileSync(ymlPath, 'utf8');

    expect(patched).not.toContain(preStaleSha);
    expect(patched.split(newDmgSha).length - 1).toBe(2); // both occurrences updated
  });
});
