/**
 * Tests for the userData orphan .tmp sweep.
 *
 * Atomic writers create sibling temp files (`<name>.<uuid>.tmp` in
 * organization/persistence.js, `<name>.tmp.<ts>.<hex>` in
 * atomicFileOperations.js) and unlink them on every JS-observable failure —
 * but a process death between write and rename leaves the temp behind
 * forever (observed in production: an orphaned user-patterns.json.<uuid>.tmp
 * in userData). The sweep reaps stale ones at startup.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { sweepOrphanUserDataTmpFiles } = require('../src/main/services/userDataTmpSweeper');

describe('sweepOrphanUserDataTmpFiles', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strato-tmp-sweep-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function createFile(name, ageMs = 0) {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, 'x');
    if (ageMs > 0) {
      const past = new Date(Date.now() - ageMs);
      fs.utimesSync(filePath, past, past);
    }
    return filePath;
  }

  test('removes stale .tmp files from both atomic-writer naming schemes', async () => {
    const twoHours = 2 * 60 * 60 * 1000;
    const uuidStyle = createFile(
      'user-patterns.json.e4482741-90fe-4b5a-8c18-51113c3f80e0.tmp',
      twoHours
    );
    const tsStyle = createFile('settings.json.tmp.1780360995617.a1b2', twoHours);

    const stats = await sweepOrphanUserDataTmpFiles({ userDataDir: dir });

    expect(fs.existsSync(uuidStyle)).toBe(false);
    expect(fs.existsSync(tsStyle)).toBe(false);
    expect(stats.removed).toBe(2);
  });

  test('keeps fresh .tmp files (in-flight atomic writes)', async () => {
    const fresh = createFile('user-patterns.json.abcd.tmp');

    const stats = await sweepOrphanUserDataTmpFiles({ userDataDir: dir });

    expect(fs.existsSync(fresh)).toBe(true);
    expect(stats.skipped).toBe(1);
    expect(stats.removed).toBe(0);
  });

  test('never touches non-tmp files or directories', async () => {
    const twoHours = 2 * 60 * 60 * 1000;
    const real = createFile('user-patterns.json', twoHours);
    const lookalike = createFile('tmp-notes.txt', twoHours);
    fs.mkdirSync(path.join(dir, 'stale.tmp')); // directory, must be ignored

    const stats = await sweepOrphanUserDataTmpFiles({ userDataDir: dir });

    expect(fs.existsSync(real)).toBe(true);
    expect(fs.existsSync(lookalike)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'stale.tmp'))).toBe(true);
    expect(stats.removed).toBe(0);
  });

  test('is resilient when the directory cannot be read', async () => {
    const stats = await sweepOrphanUserDataTmpFiles({
      userDataDir: path.join(dir, 'does-not-exist')
    });

    expect(stats).toMatchObject({ scanned: 0, removed: 0, errors: 0 });
  });
});

describe('sweepStaleRecoveryManifests', () => {
  const { sweepStaleRecoveryManifests } = require('../src/main/services/userDataTmpSweeper');
  let dir;
  let recoveryDir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strato-recovery-sweep-'));
    recoveryDir = path.join(dir, 'recovery');
    fs.mkdirSync(recoveryDir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function createManifest(name, ageMs = 0) {
    const filePath = path.join(recoveryDir, name);
    fs.writeFileSync(filePath, '{"status":"partial_failure"}');
    if (ageMs > 0) {
      const past = new Date(Date.now() - ageMs);
      fs.utimesSync(filePath, past, past);
    }
    return filePath;
  }

  test('removes rollback manifests older than the retention window', async () => {
    const twoHundredDays = 200 * 24 * 60 * 60 * 1000;
    const stale = createManifest('rollback_batch-abc.json', twoHundredDays);

    const stats = await sweepStaleRecoveryManifests({ userDataDir: dir });

    expect(fs.existsSync(stale)).toBe(false);
    expect(stats.removed).toBe(1);
  });

  test('keeps manifests inside the retention window (recent forensics)', async () => {
    const tenDays = 10 * 24 * 60 * 60 * 1000;
    const recent = createManifest('rollback_batch-def.json', tenDays);

    const stats = await sweepStaleRecoveryManifests({ userDataDir: dir });

    expect(fs.existsSync(recent)).toBe(true);
    expect(stats.skipped).toBe(1);
    expect(stats.removed).toBe(0);
  });

  test('never touches files that are not rollback manifests', async () => {
    const twoHundredDays = 200 * 24 * 60 * 60 * 1000;
    const other = createManifest('important-notes.json', twoHundredDays);

    const stats = await sweepStaleRecoveryManifests({ userDataDir: dir });

    expect(fs.existsSync(other)).toBe(true);
    expect(stats.removed).toBe(0);
  });

  test('is a silent no-op when the recovery directory does not exist', async () => {
    const stats = await sweepStaleRecoveryManifests({
      userDataDir: path.join(dir, 'nowhere')
    });

    expect(stats).toMatchObject({ scanned: 0, removed: 0, errors: 0 });
  });
});
