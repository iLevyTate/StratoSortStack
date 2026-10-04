/**
 * @jest-environment node
 */

const path = require('path');
const {
  assertBackupPathContained,
  assertBackupPathNotSymlink
} = require('../src/shared/backupPathGuard');

describe('backupPathGuard', () => {
  const backupDir = path.resolve('/tmp/stratosort-settings-backups');

  test('accepts a file inside the backup directory', () => {
    const inside = path.join(backupDir, 'settings-1.json');
    expect(assertBackupPathContained(inside, backupDir)).toBe(
      process.platform === 'win32' ? path.normalize(inside).toLowerCase() : path.normalize(inside)
    );
  });

  test('rejects a sibling whose name only shares a prefix', () => {
    const sibling = path.resolve('/tmp/stratosort-settings-backups-evil/settings.json');
    expect(() => assertBackupPathContained(sibling, backupDir)).toThrow(/within backup directory/);
  });

  test('rejects the backup directory itself by default', () => {
    expect(() => assertBackupPathContained(backupDir, backupDir)).toThrow(
      /not the directory itself/
    );
    expect(() => assertBackupPathContained(`${backupDir}${path.sep}`, backupDir)).toThrow(
      /not the directory itself/
    );
  });

  test('accepts the backup directory itself only when allowExact is set', () => {
    const expected =
      process.platform === 'win32'
        ? path.normalize(backupDir).toLowerCase()
        : path.normalize(backupDir);
    expect(assertBackupPathContained(backupDir, backupDir, { allowExact: true })).toBe(expected);
    // allowExact must not loosen the prefix check for siblings.
    const sibling = path.resolve('/tmp/stratosort-settings-backups-evil');
    expect(() => assertBackupPathContained(sibling, backupDir, { allowExact: true })).toThrow(
      /within backup directory/
    );
  });

  test('rejects a non-string path', () => {
    expect(() => assertBackupPathContained('', backupDir)).toThrow(/non-empty string/);
  });

  test('refuses a symlink', async () => {
    const fsPromises = {
      lstat: async () => ({ isSymbolicLink: () => true })
    };
    await expect(assertBackupPathNotSymlink('/tmp/link.json', fsPromises)).rejects.toThrow(
      /symbolic link/
    );
  });
});
