/**
 * @jest-environment node
 */
/**
 * handleDuplicateMove removes the source when identical content is already
 * in the destination folder. Two cases where that "already there" copy is
 * not one the user can count on:
 *
 * - the destination folder is the folder the source is already in (a rename
 *   in place): an identical file beside it is a second file the user kept,
 *   not a filed copy;
 * - the identical file is itself waiting to be moved by the same batch.
 *
 * Both cost real files: two identical files renamed in place each took the
 * other for the kept copy, and both went to the trash.
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const path = require('path');
const fs = require('fs').promises;
const os = require('os');

const { handleDuplicateMove } = require('../src/main/utils/fileDedup');

describe('fileDedup: copies that do not count as already filed', () => {
  let testDir;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dedup-pending-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // best-effort tmp cleanup
    }
  });

  /**
   * @param {string[]} parts
   * @param {string} content
   */
  async function write(parts, content) {
    const filePath = path.join(testDir, ...parts);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
    return filePath;
  }

  // Removal through the OS trash is covered by fileDedup.trash.test.js; these
  // tests are about whether the source is removed at all.
  const dedup = (/** @type {Record<string, any>} */ params) =>
    handleDuplicateMove({ logger: null, unlinkFn: fs.unlink, ...params });

  test('a rename in place keeps the source although an identical file sits beside it', async () => {
    const source = await write(['Inbox', 'export.csv'], 'same-bytes');
    const sibling = await write(['Inbox', 'export (1).csv'], 'same-bytes');

    const result = await dedup({
      sourcePath: source,
      destinationPath: path.join(testDir, 'Inbox', '2026-10 Search performance.csv')
    });

    expect(result).toBeNull();
    expect(await fs.readFile(source, 'utf8')).toBe('same-bytes');
    expect(await fs.readFile(sibling, 'utf8')).toBe('same-bytes');
  });

  test('two identical files renamed in place: neither is removed for the other', async () => {
    const first = await write(['Inbox', 'a.csv'], 'same-bytes');
    const second = await write(['Inbox', 'b.csv'], 'same-bytes');

    const results = await Promise.all([
      dedup({ sourcePath: first, destinationPath: path.join(testDir, 'Inbox', 'A new.csv') }),
      dedup({ sourcePath: second, destinationPath: path.join(testDir, 'Inbox', 'B new.csv') })
    ]);

    expect(results).toEqual([null, null]);
    expect((await fs.readdir(path.join(testDir, 'Inbox'))).sort()).toEqual(['a.csv', 'b.csv']);
  });

  test('an identical file at the exact destination still dedupes within one folder', async () => {
    const source = await write(['Inbox', 'incoming.pdf'], 'same-bytes');
    const destination = await write(['Inbox', 'kept.pdf'], 'same-bytes');

    const result = await dedup({ sourcePath: source, destinationPath: destination });

    expect(result).toMatchObject({ skipped: true, destination, reason: 'duplicate' });
    await expect(fs.access(source)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('an identical file that the batch has still to move is not a filed copy', async () => {
    const source = await write(['Inbox', 'a.csv'], 'same-bytes');
    const pendingTwin = await write(['Reports', 'b.csv'], 'same-bytes');
    const destinationPath = path.join(testDir, 'Reports', 'A new.csv');

    const result = await dedup({
      sourcePath: source,
      destinationPath,
      pendingSources: [source, pendingTwin]
    });

    expect(result).toBeNull();
    expect(await fs.readFile(source, 'utf8')).toBe('same-bytes');
  });

  test('a pending source is recognised through a differently written path', async () => {
    const source = await write(['Inbox', 'a.csv'], 'same-bytes');
    await write(['Reports', 'b.csv'], 'same-bytes');
    // What a batch holds before it validates its paths: unresolved segments.
    const pendingTwinAsQueued = path.join(testDir, 'Reports', '..', 'Reports', 'b.csv');

    const result = await dedup({
      sourcePath: source,
      destinationPath: path.join(testDir, 'Reports', 'A new.csv'),
      pendingSources: [pendingTwinAsQueued]
    });

    expect(result).toBeNull();
  });

  test('a pending source at the exact destination is not a filed copy either', async () => {
    const source = await write(['Inbox', 'a.csv'], 'same-bytes');
    const pendingTwin = await write(['Reports', 'a.csv'], 'same-bytes');

    const result = await dedup({
      sourcePath: source,
      destinationPath: pendingTwin,
      pendingSources: [source, pendingTwin]
    });

    expect(result).toBeNull();
    expect(await fs.readFile(source, 'utf8')).toBe('same-bytes');
  });

  test('an identical file in another folder that is not pending still dedupes', async () => {
    const source = await write(['Inbox', 'a.csv'], 'same-bytes');
    const filed = await write(['Reports', 'already filed.csv'], 'same-bytes');
    const otherPending = await write(['Inbox', 'c.csv'], 'other-bytes');

    const result = await dedup({
      sourcePath: source,
      destinationPath: path.join(testDir, 'Reports', 'A new.csv'),
      pendingSources: [source, otherPending]
    });

    expect(result).toMatchObject({ skipped: true, destination: filed, reason: 'duplicate' });
    await expect(fs.access(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(filed, 'utf8')).toBe('same-bytes');
  });
});
