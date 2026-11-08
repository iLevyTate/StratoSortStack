/**
 * @jest-environment node
 */
/**
 * A missing source must surface as FileSystemError(FILE_NOT_FOUND) from the
 * atomic move/copy paths, and must never be fabricated on disk. Runs against
 * the real filesystem in a temp dir so the production ENOENT path is the one
 * exercised (no environment-keyed behaviour in the module under test).
 */

jest.unmock('fs');
jest.unmock('fs/promises');

const fsp = require('fs').promises;
const path = require('path');
const realOs = jest.requireActual('os');

const { AtomicFileOperations } = require('../src/shared/atomicFileOperations');

/** @param {string} p */
async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

describe('atomic move/copy of a missing source', () => {
  /** @type {string} */
  let root;
  /** @type {InstanceType<typeof AtomicFileOperations>} */
  let ops;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(realOs.tmpdir(), 'ss-missing-src-'));
    ops = new AtomicFileOperations();
    ops.setBackupBaseDirectory(path.join(root, 'backups'));
    ops.setJournalBaseDirectory(path.join(root, 'journals'));
  });

  afterEach(async () => {
    ops.shutdown();
    await fsp.rm(root, { recursive: true, force: true });
  });

  test('atomicMove rejects with FILE_NOT_FOUND and creates nothing at the source', async () => {
    const source = path.join(root, 'nope', 'a.txt');
    const destination = path.join(root, 'out', 'a.txt');

    await expect(ops.atomicMove(source, destination)).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND'
    });
    expect(await exists(source)).toBe(false);
    expect(await exists(path.dirname(source))).toBe(false);
    expect(await exists(destination)).toBe(false);
  });

  test('atomicMove reports FILE_NOT_FOUND when the source is missing after a name-conflict retry', async () => {
    const source = path.join(root, 'nope', 'a.txt');
    const destination = path.join(root, 'out', 'a.txt');
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, 'OCCUPANT');

    await expect(ops.atomicMove(source, destination)).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND'
    });
    expect(await exists(source)).toBe(false);
    expect(await fsp.readFile(destination, 'utf8')).toBe('OCCUPANT');
    expect(await fsp.readdir(path.dirname(destination))).toEqual(['a.txt']);
  });

  test('atomicCopy rejects with FILE_NOT_FOUND and creates nothing at the source', async () => {
    const source = path.join(root, 'nope', 'b.txt');
    const destination = path.join(root, 'out', 'b.txt');

    await expect(ops.atomicCopy(source, destination)).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND'
    });
    expect(await exists(source)).toBe(false);
    expect(await exists(destination)).toBe(false);
  });

  test('executeOperation(move) rejects with FILE_NOT_FOUND and fabricates no source', async () => {
    const source = path.join(root, 'nope', 'c.txt');
    const destination = path.join(root, 'out', 'c.txt');
    const txId = await ops.beginTransaction();

    await expect(
      ops.executeOperation(txId, { type: 'move', source, destination })
    ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    expect(await exists(source)).toBe(false);
    expect(await exists(destination)).toBe(false);
  });
});
