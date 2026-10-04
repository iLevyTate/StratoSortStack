/**
 * @jest-environment node
 *
 * A duplicate source is a file the user never asked to delete. It goes to
 * the OS trash, where it can be recovered; a hard delete is only the
 * fallback when the platform has no trash or a caller insists on unlink.
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const mockTrashOne = jest.fn();
jest.mock('../src/main/services/TrashService', () => ({
  TrashService: class {
    trashOne(p) {
      return mockTrashOne(p);
    }
  }
}));

const path = require('path');
const fs = require('fs').promises;
const os = require('os');

const { handleDuplicateMove } = require('../src/main/utils/fileDedup');

describe('handleDuplicateMove removes the source through the trash', () => {
  let testDir;
  let source;
  let duplicate;

  beforeEach(async () => {
    mockTrashOne.mockReset();
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dedup-trash-'));
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

  test('the duplicate source goes to the OS trash by default', async () => {
    mockTrashOne.mockResolvedValue({ success: true, path: source });
    const removeEmbeddings = jest.fn().mockResolvedValue(undefined);

    const result = await handleDuplicateMove({
      sourcePath: source,
      destinationPath: duplicate,
      logger: null,
      removeEmbeddings
    });

    expect(result).toEqual({
      skipped: true,
      destination: duplicate,
      reason: 'duplicate',
      sourceRemoval: 'trashed'
    });
    expect(mockTrashOne).toHaveBeenCalledWith(source);
    expect(removeEmbeddings).toHaveBeenCalledWith(source, null);
    // The trash is mocked, so the file is untouched: nothing unlinked it.
    expect(await fs.readFile(source, 'utf8')).toBe('same-bytes');
  });

  test('when the trash refuses, the source is deleted and the result says so', async () => {
    mockTrashOne.mockResolvedValue({ success: false, path: source, code: 'TRASH_FAILED' });

    const result = await handleDuplicateMove({
      sourcePath: source,
      destinationPath: duplicate,
      logger: null,
      removeEmbeddings: jest.fn()
    });

    expect(result.sourceRemoval).toBe('deleted');
    await expect(fs.access(source)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('when the trash throws, the source is deleted', async () => {
    mockTrashOne.mockRejectedValue(new Error('shell unavailable'));

    const result = await handleDuplicateMove({
      sourcePath: source,
      destinationPath: duplicate,
      logger: null,
      removeEmbeddings: jest.fn()
    });

    expect(result.sourceRemoval).toBe('deleted');
    await expect(fs.access(source)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('an explicit unlinkFn is used as given and the trash is not consulted', async () => {
    const unlinkFn = jest.fn().mockResolvedValue(undefined);

    const result = await handleDuplicateMove({
      sourcePath: source,
      destinationPath: duplicate,
      logger: null,
      removeEmbeddings: jest.fn(),
      unlinkFn
    });

    expect(unlinkFn).toHaveBeenCalledWith(source);
    expect(mockTrashOne).not.toHaveBeenCalled();
    expect(result.sourceRemoval).toBe('deleted');
  });
});
