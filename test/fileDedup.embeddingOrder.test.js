/**
 * @jest-environment node
 */
/**
 * handleDuplicateMove removes the source's embeddings only AFTER the source
 * file is gone. Removing first meant a failed unlink (EBUSY, EPERM) or a
 * destination that vanished in the TOCTOU window left the file on disk with
 * its vectors deleted — present in the folder, invisible to search.
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const path = require('path');
const fs = require('fs').promises;
const os = require('os');

const { handleDuplicateMove } = require('../src/main/utils/fileDedup');

describe('handleDuplicateMove embedding removal ordering', () => {
  let testDir;
  let source;
  let duplicate;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dedup-order-'));
    source = path.join(testDir, 'incoming.pdf');
    duplicate = path.join(testDir, 'kept.pdf');
    await fs.writeFile(source, 'same-bytes');
    await fs.writeFile(duplicate, 'same-bytes');
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // best-effort tmp cleanup
    }
  });

  test('keeps embeddings when the source unlink fails', async () => {
    const removeEmbeddings = jest.fn().mockResolvedValue(undefined);
    const unlinkFn = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('resource busy'), { code: 'EBUSY' }));

    await expect(
      handleDuplicateMove({
        sourcePath: source,
        destinationPath: duplicate,
        logger: null,
        removeEmbeddings,
        unlinkFn
      })
    ).rejects.toMatchObject({ code: 'EBUSY' });

    expect(removeEmbeddings).not.toHaveBeenCalled();
    expect(await fs.readFile(source, 'utf8')).toBe('same-bytes');
  });

  test('keeps embeddings when the duplicate disappears before the source unlink', async () => {
    const removeEmbeddings = jest.fn().mockResolvedValue(undefined);
    const unlinkFn = jest.fn(async (p) => fs.unlink(p));
    // Vanish the duplicate between detection and the re-check: the first
    // access() the function makes is the TOCTOU guard on the duplicate.
    const realAccess = fs.access;
    const accessSpy = jest.spyOn(fs, 'access').mockImplementation(async (p, mode) => {
      if (p === duplicate) {
        accessSpy.mockRestore();
        await fs.unlink(duplicate);
      }
      return realAccess.call(fs, p, mode);
    });

    const result = await handleDuplicateMove({
      sourcePath: source,
      destinationPath: duplicate,
      logger: null,
      removeEmbeddings,
      unlinkFn
    });

    expect(result).toBeNull();
    expect(unlinkFn).not.toHaveBeenCalled();
    expect(removeEmbeddings).not.toHaveBeenCalled();
    expect(await fs.readFile(source, 'utf8')).toBe('same-bytes');
  });

  test('removes embeddings exactly once, after the source unlink, on the happy path', async () => {
    const removeEmbeddings = jest.fn().mockResolvedValue(undefined);
    const unlinkFn = jest.fn(async (p) => fs.unlink(p));

    const result = await handleDuplicateMove({
      sourcePath: source,
      destinationPath: duplicate,
      logger: null,
      removeEmbeddings,
      unlinkFn
    });

    expect(result).toMatchObject({ skipped: true, destination: duplicate, reason: 'duplicate' });
    expect(unlinkFn).toHaveBeenCalledTimes(1);
    expect(removeEmbeddings).toHaveBeenCalledTimes(1);
    expect(removeEmbeddings).toHaveBeenCalledWith(source, null);
    expect(unlinkFn.mock.invocationCallOrder[0]).toBeLessThan(
      removeEmbeddings.mock.invocationCallOrder[0]
    );
    await expect(fs.access(source)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
