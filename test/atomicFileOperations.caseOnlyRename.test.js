/**
 * @jest-environment node
 */
/**
 * renameNoReplace exempts a case-only rename (a.pdf -> A.pdf) from its
 * occupancy preflight because on a case-insensitive filesystem the probe
 * finds the source itself. darwin is treated as case-insensitive, but APFS
 * can be formatted case-sensitive: there `A.pdf` may be a DIFFERENT file,
 * and the rename would replace it. The exemption must hold only when the
 * destination is missing or is the very same file (same dev + ino).
 */

jest.unmock('fs');
jest.unmock('fs/promises');

const path = require('path');
const fs = require('fs').promises;

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

function errorWithCode(code) {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

describe('renameNoReplace case-only rename on darwin', () => {
  let renameNoReplace;
  const source = path.resolve('/vol/docs/a.pdf');
  const dest = path.resolve('/vol/docs/A.pdf');

  beforeEach(() => {
    jest.resetModules();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    ({ renameNoReplace } = require('../src/shared/atomicFileOperations'));
    jest.spyOn(fs, 'rename').mockResolvedValue(undefined);
    jest.spyOn(fs, 'access').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(process, 'platform', originalPlatform);
  });

  function mockStats(byPath) {
    jest.spyOn(fs, 'stat').mockImplementation(async (p) => {
      const entry = byPath[path.resolve(String(p))];
      if (!entry) throw errorWithCode('ENOENT');
      return { dev: entry.dev, ino: entry.ino, isFile: () => true };
    });
  }

  test('case-sensitive volume: a different file at the other-cased name is EEXIST, not replaced', async () => {
    mockStats({ [source]: { dev: 1, ino: 100 }, [dest]: { dev: 1, ino: 200 } });

    await expect(renameNoReplace(source, dest)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fs.rename).not.toHaveBeenCalled();
  });

  test('case-insensitive volume: the other-cased name is the source itself, so the rename runs', async () => {
    mockStats({ [source]: { dev: 1, ino: 100 }, [dest]: { dev: 1, ino: 100 } });

    await renameNoReplace(source, dest);

    expect(fs.rename).toHaveBeenCalledWith(source, dest);
  });

  test('case-sensitive volume with the other-cased name free: the rename runs', async () => {
    mockStats({ [source]: { dev: 1, ino: 100 } });

    await renameNoReplace(source, dest);

    expect(fs.rename).toHaveBeenCalledWith(source, dest);
  });

  test('a destination probe failure other than ENOENT fails closed', async () => {
    jest.spyOn(fs, 'stat').mockImplementation(async (p) => {
      if (path.resolve(String(p)) === dest) throw errorWithCode('EACCES');
      return { dev: 1, ino: 100, isFile: () => true };
    });

    await expect(renameNoReplace(source, dest)).rejects.toMatchObject({ code: 'EACCES' });
    expect(fs.rename).not.toHaveBeenCalled();
  });
});
