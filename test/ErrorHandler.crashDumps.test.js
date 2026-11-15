/**
 * cleanupCrashDumps must sweep Crashpad's report folders (reports/ on
 * Windows, new/pending/completed on macOS/Linux) and never delete Crashpad's
 * own database files (root `metadata`, `settings.dat`). Uses a real temp dir.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const errorHandler = require('../src/main/errors/ErrorHandler');

const DAY = 24 * 60 * 60 * 1000;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Write a file and backdate its mtime by `ageMs`. */
function writeAged(filePath, ageMs) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, 'x');
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, t, t);
}

describe('ErrorHandler.cleanupCrashDumps (Crashpad layout)', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-dumps-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('deletes stale dumps under reports/ with their attachments and keeps Crashpad database files', async () => {
    writeAged(path.join(dir, 'metadata'), 60 * DAY);
    writeAged(path.join(dir, 'settings.dat'), 60 * DAY);
    writeAged(path.join(dir, 'reports', `${uuid(1)}.dmp`), 45 * DAY);
    writeAged(path.join(dir, 'attachments', uuid(1), 'log.txt'), 45 * DAY);
    writeAged(path.join(dir, 'reports', `${uuid(2)}.dmp`), 2 * DAY);

    await errorHandler.cleanupCrashDumps(dir, 30, 20);

    expect(fs.existsSync(path.join(dir, 'metadata'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'settings.dat'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'reports', `${uuid(1)}.dmp`))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'attachments', uuid(1)))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'reports', `${uuid(2)}.dmp`))).toBe(true);
  });

  test('sweeps completed/ and pending/ and removes the sibling .meta', async () => {
    writeAged(path.join(dir, 'completed', `${uuid(3)}.dmp`), 40 * DAY);
    writeAged(path.join(dir, 'completed', `${uuid(3)}.meta`), 40 * DAY);
    writeAged(path.join(dir, 'pending', `${uuid(4)}.dmp`), 40 * DAY);

    await errorHandler.cleanupCrashDumps(dir, 30, 20);

    expect(fs.readdirSync(path.join(dir, 'completed'))).toEqual([]);
    expect(fs.readdirSync(path.join(dir, 'pending'))).toEqual([]);
  });

  test('applies the count cap across all report folders combined, oldest first', async () => {
    writeAged(path.join(dir, 'reports', `${uuid(5)}.dmp`), 5 * DAY);
    writeAged(path.join(dir, 'completed', `${uuid(6)}.dmp`), 4 * DAY);
    writeAged(path.join(dir, 'pending', `${uuid(7)}.dmp`), 3 * DAY);
    writeAged(path.join(dir, 'reports', `${uuid(8)}.dmp`), 1 * DAY);

    await errorHandler.cleanupCrashDumps(dir, 30, 2);

    expect(fs.existsSync(path.join(dir, 'reports', `${uuid(5)}.dmp`))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'completed', `${uuid(6)}.dmp`))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'pending', `${uuid(7)}.dmp`))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'reports', `${uuid(8)}.dmp`))).toBe(true);
  });

  test('leaves a just-written dump in new/ alone even when over the cap', async () => {
    writeAged(path.join(dir, 'new', `${uuid(9)}.dmp`), 0);
    writeAged(path.join(dir, 'reports', `${uuid(10)}.dmp`), 1 * DAY);

    await errorHandler.cleanupCrashDumps(dir, 30, 0);

    expect(fs.existsSync(path.join(dir, 'new', `${uuid(9)}.dmp`))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'reports', `${uuid(10)}.dmp`))).toBe(false);
  });

  test('still clears stray root-level dumps from older layouts', async () => {
    writeAged(path.join(dir, 'old.dmp'), 40 * DAY);
    writeAged(path.join(dir, 'old.ips'), 40 * DAY);

    await errorHandler.cleanupCrashDumps(dir, 30, 20);

    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test('is a no-op when the crash-dumps folder does not exist', async () => {
    await expect(
      errorHandler.cleanupCrashDumps(path.join(dir, 'missing'), 30, 20)
    ).resolves.toBeUndefined();
  });
});
