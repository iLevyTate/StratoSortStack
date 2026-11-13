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

// macOS returns decomposed accents (a + U+0308) while the app builds composed
// names (U+00E4). APFS treats both as one name, so a rename between the two
// spellings finds the source itself at the destination, exactly like a
// case-only rename.
describe('renameNoReplace between accent spellings on darwin', () => {
  let renameNoReplace;
  let withPathLock;
  const source = path.resolve('/vol/docs/Ma\u0308rz.pdf');
  const dest = path.resolve('/vol/docs/M\u00e4rz.pdf');

  beforeEach(() => {
    jest.resetModules();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    ({ renameNoReplace, withPathLock } = require('../src/shared/atomicFileOperations'));
    jest.spyOn(fs, 'rename').mockResolvedValue(undefined);
    // access() finds the source under either spelling, as APFS does.
    jest.spyOn(fs, 'access').mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(process, 'platform', originalPlatform);
  });

  function mockStats(byPath) {
    jest.spyOn(fs, 'stat').mockImplementation(async (p) => {
      const entry = byPath[path.resolve(String(p)).normalize('NFC')];
      if (!entry) throw errorWithCode('ENOENT');
      return { dev: entry.dev, ino: entry.ino, isFile: () => true };
    });
  }

  test('the other spelling is the source itself, so the rename runs', async () => {
    mockStats({ [dest.normalize('NFC')]: { dev: 1, ino: 100 } });

    await renameNoReplace(source, dest);

    expect(fs.rename).toHaveBeenCalledWith(source, dest);
  });

  test('a different file under the other spelling is EEXIST, not replaced', async () => {
    jest.spyOn(fs, 'stat').mockImplementation(async (p) => {
      const ino = String(p) === source ? 100 : 200;
      return { dev: 1, ino, isFile: () => true };
    });

    await expect(renameNoReplace(source, dest)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(fs.rename).not.toHaveBeenCalled();
  });

  test('both spellings contend on one path lock', async () => {
    const order = [];
    let releaseFirst;
    const first = withPathLock(source, async () => {
      order.push('first-start');
      await new Promise((resolve) => {
        releaseFirst = resolve;
      });
      order.push('first-end');
    });
    const second = withPathLock(dest, async () => {
      order.push('second');
    });
    await new Promise((resolve) => setImmediate(resolve));
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });
});

// NTFS keeps decomposed and composed spellings as two names, so on Windows
// they do not share a path lock (case still does).
describe('path locks on win32', () => {
  let withPathLock;

  beforeEach(() => {
    jest.resetModules();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    ({ withPathLock } = require('../src/shared/atomicFileOperations'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(process, 'platform', originalPlatform);
  });

  async function runsWhileHeld(firstPath, secondPath) {
    const order = [];
    let releaseFirst;
    const first = withPathLock(firstPath, async () => {
      order.push('first-start');
      await new Promise((resolve) => {
        releaseFirst = resolve;
      });
      order.push('first-end');
    });
    const second = withPathLock(secondPath, async () => {
      order.push('second');
    });
    await new Promise((resolve) => setImmediate(resolve));
    releaseFirst();
    await Promise.all([first, second]);
    return order[1] === 'second';
  }

  test('the two accent spellings do not contend on one lock', async () => {
    const a = path.resolve('/vol/docs/Ma\u0308rz.pdf');
    const b = path.resolve('/vol/docs/M\u00e4rz.pdf');
    expect(await runsWhileHeld(a, b)).toBe(true);
  });

  test('a case-only difference still contends on one lock', async () => {
    const a = path.resolve('/vol/docs/Report.pdf');
    const b = path.resolve('/vol/docs/REPORT.pdf');
    expect(await runsWhileHeld(a, b)).toBe(false);
  });
});
