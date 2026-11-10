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
