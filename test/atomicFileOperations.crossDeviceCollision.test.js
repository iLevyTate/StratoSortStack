/**
 * @jest-environment node
 */
/**
 * A cross-device atomicMove whose destination name is taken by another
 * writer during the copy must move on to a unique name (as a same-device
 * EEXIST does), never fail the move and never replace the newcomer. Real
 * filesystem in a temp dir; only the first rename is forced to EXDEV and the
 * staging copy is used as the moment the other writer lands.
 */

jest.unmock('fs');
jest.unmock('fs/promises');

const fsp = require('fs').promises;
const path = require('path');
const realOs = jest.requireActual('os');

const { AtomicFileOperations, crossDeviceMove } = require('../src/shared/atomicFileOperations');

describe('cross-device move losing the name to another writer', () => {
  /** @type {string} */
  let root;
  /** @type {InstanceType<typeof AtomicFileOperations>} */
  let ops;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(realOs.tmpdir(), 'ss-exdev-race-'));
    ops = new AtomicFileOperations();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    ops.shutdown();
    await fsp.rm(root, { recursive: true, force: true });
  });

  /**
   * Force EXDEV for source->destination renames and plant an occupant at
   * `occupied` right after the staging copy is written.
   * @param {string} sourcePath
   * @param {string} occupied
   */
  function simulateCrossDeviceRace(sourcePath, occupied) {
    const realRename = fsp.rename.bind(fsp);
    jest.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (path.resolve(String(from)) === path.resolve(sourcePath)) {
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), {
          code: 'EXDEV'
        });
      }
      return realRename(from, to);
    });
    const realCopy = fsp.copyFile.bind(fsp);
    let planted = false;
    jest.spyOn(fsp, 'copyFile').mockImplementation(async (from, to, mode) => {
      await realCopy(from, to, mode);
      if (!planted) {
        planted = true;
        await fsp.writeFile(occupied, 'SOMEONE-ELSE');
      }
    });
  }

  test('atomicMove lands on a unique name and keeps the newcomer', async () => {
    const source = path.join(root, 'vol1', 'report.pdf');
    const destination = path.join(root, 'vol2', 'report.pdf');
    await fsp.mkdir(path.dirname(source), { recursive: true });
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(source, 'MINE');
    simulateCrossDeviceRace(source, destination);

    const finalPath = await ops.atomicMove(source, destination);

    expect(finalPath).not.toBe(destination);
    expect(path.dirname(finalPath)).toBe(path.dirname(destination));
    expect(await fsp.readFile(finalPath, 'utf8')).toBe('MINE');
    expect(await fsp.readFile(destination, 'utf8')).toBe('SOMEONE-ELSE');
    await expect(fsp.access(source)).rejects.toMatchObject({ code: 'ENOENT' });
    // No staging artifact left behind.
    const left = (await fsp.readdir(path.dirname(destination))).filter((n) => n.endsWith('.tmp'));
    expect(left).toEqual([]);
  });

  test('crossDeviceMove names the occupied destination when its publish is refused', async () => {
    const source = path.join(root, 'vol1', 'a.pdf');
    const destination = path.join(root, 'vol2', 'a.pdf');
    await fsp.mkdir(path.dirname(source), { recursive: true });
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(source, 'MINE');
    simulateCrossDeviceRace(source, destination);

    const error = await crossDeviceMove(source, destination).catch((e) => e);

    expect(error).toMatchObject({ code: 'FILE_EXISTS' });
    expect(error.metadata.path).toBe(path.resolve(destination));
    expect(await fsp.readFile(source, 'utf8')).toBe('MINE');
  });
});

/**
 * A caller that gives up on a cross-device move (cancel, strict-mode
 * rollback) aborts its signal. The copy itself cannot be interrupted, but
 * nothing may be published or deleted afterwards: the source stays, the
 * destination name stays free and the staging copy is removed.
 */
describe('cross-device move aborted by its caller', () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let source;
  /** @type {string} */
  let destination;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(realOs.tmpdir(), 'ss-exdev-abort-'));
    source = path.join(root, 'vol1', 'video.mp4');
    destination = path.join(root, 'vol2', 'video.mp4');
    await fsp.mkdir(path.dirname(source), { recursive: true });
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(source, 'MINE');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function expectNothingMoved() {
    expect(await fsp.readFile(source, 'utf8')).toBe('MINE');
    expect(await fsp.readdir(path.dirname(destination))).toEqual([]);
  }

  test('abort during the copy: nothing is published and the source stays', async () => {
    const controller = new AbortController();
    const realCopy = fsp.copyFile.bind(fsp);
    jest.spyOn(fsp, 'copyFile').mockImplementation(async (from, to, mode) => {
      await realCopy(from, to, mode);
      controller.abort('user-cancel-organize');
    });
    const checksumFn = jest.fn(async () => 'same');

    const error = await crossDeviceMove(source, destination, {
      checksumFn,
      signal: controller.signal
    }).then(
      () => null,
      (e) => e
    );

    expect(error).toMatchObject({ name: 'AbortError' });
    // The verification pass (two full-file hashes) is skipped too.
    expect(checksumFn).not.toHaveBeenCalled();
    await expectNothingMoved();
  });

  test('abort during verification: nothing is published and the source stays', async () => {
    const controller = new AbortController();
    const checksumFn = jest.fn(async () => {
      controller.abort();
      return 'same';
    });

    const error = await crossDeviceMove(source, destination, {
      checksumFn,
      signal: controller.signal
    }).then(
      () => null,
      (e) => e
    );

    expect(error).toMatchObject({ name: 'AbortError' });
    await expectNothingMoved();
  });

  test('abort landing with the publish: the copy is withdrawn and the source stays', async () => {
    const controller = new AbortController();
    const realRename = fsp.rename.bind(fsp);
    jest.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      await realRename(from, to);
      controller.abort();
    });

    const error = await crossDeviceMove(source, destination, { signal: controller.signal }).then(
      () => null,
      (e) => e
    );

    expect(error).toMatchObject({ name: 'AbortError' });
    await expectNothingMoved();
  });

  test('a signal that never aborts changes nothing', async () => {
    await crossDeviceMove(source, destination, { signal: new AbortController().signal });

    expect(await fsp.readFile(destination, 'utf8')).toBe('MINE');
    await expect(fsp.access(source)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('a signal already aborted copies nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const copySpy = jest.spyOn(fsp, 'copyFile');

    const error = await crossDeviceMove(source, destination, { signal: controller.signal }).then(
      () => null,
      (e) => e
    );

    expect(error).toMatchObject({ name: 'AbortError' });
    expect(copySpy).not.toHaveBeenCalled();
    await expectNothingMoved();
  });
});

/**
 * A cross-device move copies to a temporary name in the destination folder
 * and renames that into place. When something else removes or holds the
 * temporary copy (a sync client, a scanner), the failure is about that copy:
 * the error must say so and say the source was not moved, not report the
 * source as missing.
 */
describe('cross-device move losing its temporary copy', () => {
  /** @type {string} */
  let root;
  /** @type {string} */
  let source;
  /** @type {string} */
  let destination;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(realOs.tmpdir(), 'ss-exdev-staging-'));
    source = path.join(root, 'vol1', 'scan.pdf');
    destination = path.join(root, 'vol2', 'scan.pdf');
    await fsp.mkdir(path.dirname(source), { recursive: true });
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(source, 'MINE');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fsp.rm(root, { recursive: true, force: true });
  });

  const failure = () => crossDeviceMove(source, destination).catch((e) => e);

  async function expectNothingMoved() {
    expect(await fsp.readFile(source, 'utf8')).toBe('MINE');
    expect(await fsp.readdir(path.dirname(destination))).toEqual([]);
  }

  const removedMessage = () =>
    `The temporary copy in ${path.dirname(destination)} was removed before the move finished. ` +
    `The original was not moved: ${source}`;

  test('removed right after the copy: says so and that the original was not moved', async () => {
    const realCopy = fsp.copyFile.bind(fsp);
    jest.spyOn(fsp, 'copyFile').mockImplementation(async (from, to, mode) => {
      await realCopy(from, to, mode);
      await fsp.unlink(to);
    });

    const error = await failure();

    expect(error).toMatchObject({ code: 'STAGED_COPY_FAILED', isFileSystemError: true });
    expect(error.message).toBe(removedMessage());
    expect(error.message).not.toMatch(/not found/i);
    expect(error.metadata).toMatchObject({
      originalCode: 'ENOENT',
      source,
      destination,
      directory: path.dirname(destination)
    });
    await expectNothingMoved();
  });

  test('removed while its checksum is read: same report', async () => {
    const checksumFn = async (/** @type {string} */ file) => {
      if (file.endsWith('.tmp')) await fsp.unlink(file);
      return fsp.readFile(file, 'utf8');
    };

    const error = await crossDeviceMove(source, destination, { checksumFn }).catch((e) => e);

    expect(error).toMatchObject({ code: 'STAGED_COPY_FAILED' });
    expect(error.message).toBe(removedMessage());
    await expectNothingMoved();
  });

  test('removed between the check and the rename into place: same report', async () => {
    const realRename = fsp.rename.bind(fsp);
    jest.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      await fsp.unlink(from);
      return realRename(from, to);
    });

    const error = await failure();

    expect(error).toMatchObject({ code: 'STAGED_COPY_FAILED' });
    expect(error.message).toBe(removedMessage());
    await expectNothingMoved();
  });

  test('held by another program: names the code and cleans the copy up', async () => {
    jest.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      throw Object.assign(
        new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`),
        {
          code: 'EPERM',
          syscall: 'rename',
          path: from,
          dest: to
        }
      );
    });

    const error = await failure();

    expect(error).toMatchObject({ code: 'STAGED_COPY_FAILED' });
    expect(error.metadata.originalCode).toBe('EPERM');
    expect(error.message).toBe(
      `The temporary copy in ${path.dirname(destination)} could not be read or renamed (EPERM). ` +
        `The original was not moved: ${source}`
    );
    await expectNothingMoved();
  });

  test('a destination name that cannot be probed is reported as the destination', async () => {
    const realAccess = fsp.access.bind(fsp);
    jest.spyOn(fsp, 'access').mockImplementation(async (target, mode) => {
      if (String(target) === destination) {
        throw Object.assign(new Error(`EACCES: permission denied, access '${target}'`), {
          code: 'EACCES',
          syscall: 'access',
          path: target
        });
      }
      return realAccess(target, mode);
    });

    const error = await failure();

    expect(error).toMatchObject({ code: 'FILE_ACCESS_DENIED' });
    expect(error.metadata.path).toBe(destination);
    await expectNothingMoved();
  });

  test('a source that really is missing is still reported as the source', async () => {
    await fsp.unlink(source);

    const error = await failure();

    expect(error).toMatchObject({ code: 'FILE_NOT_FOUND' });
    expect(error.metadata.path).toBe(source);
    expect(await fsp.readdir(path.dirname(destination))).toEqual([]);
  });

  test('atomicMove reports it once instead of trying another name', async () => {
    const ops = new AtomicFileOperations();
    const realRename = fsp.rename.bind(fsp);
    jest.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === source) {
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), {
          code: 'EXDEV'
        });
      }
      return realRename(from, to);
    });
    const realCopy = fsp.copyFile.bind(fsp);
    const copySpy = jest.spyOn(fsp, 'copyFile').mockImplementation(async (from, to, mode) => {
      await realCopy(from, to, mode);
      await fsp.unlink(to);
    });

    try {
      await expect(ops.atomicMove(source, destination)).rejects.toMatchObject({
        code: 'STAGED_COPY_FAILED'
      });
      expect(copySpy).toHaveBeenCalledTimes(1);
      await expectNothingMoved();
    } finally {
      ops.shutdown();
    }
  });
});
