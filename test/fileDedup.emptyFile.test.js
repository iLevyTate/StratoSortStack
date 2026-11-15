/**
 * @jest-environment node
 */
/**
 * Every empty file has the same size and hash, so two unrelated 0-byte files
 * looked like duplicates and the source being organized was trashed instead
 * of moved. An empty source is never deduplicated.
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const path = require('path');
const fs = require('fs').promises;
const os = require('os');

const { handleDuplicateMove, findDuplicateForDestination } = require('../src/main/utils/fileDedup');

describe('fileDedup empty source', () => {
  let testDir;
  let sourceDir;
  let destDir;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dedup-empty-'));
    sourceDir = path.join(testDir, 'incoming');
    destDir = path.join(testDir, 'target');
    await fs.mkdir(sourceDir);
    await fs.mkdir(destDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // best-effort tmp cleanup
    }
  });

  test('an empty file already at the exact destination is not a duplicate', async () => {
    const source = path.join(sourceDir, 'notes.txt');
    const destination = path.join(destDir, 'notes.txt');
    await fs.writeFile(source, '');
    await fs.writeFile(destination, '');

    expect(
      await findDuplicateForDestination({ sourcePath: source, destinationPath: destination })
    ).toBeNull();

    const unlinkFn = jest.fn();
    const result = await handleDuplicateMove({
      sourcePath: source,
      destinationPath: destination,
      unlinkFn,
      logger: null
    });
    expect(result).toBeNull();
    expect(unlinkFn).not.toHaveBeenCalled();
    await expect(fs.access(source)).resolves.toBeUndefined();
  });

  test('an unrelated empty file in the destination folder is not a duplicate', async () => {
    const source = path.join(sourceDir, 'placeholder.md');
    await fs.writeFile(source, '');
    await fs.writeFile(path.join(destDir, 'other-empty.log'), '');

    const unlinkFn = jest.fn();
    const result = await handleDuplicateMove({
      sourcePath: source,
      destinationPath: path.join(destDir, 'placeholder.md'),
      unlinkFn,
      logger: null
    });
    expect(result).toBeNull();
    expect(unlinkFn).not.toHaveBeenCalled();
    await expect(fs.access(source)).resolves.toBeUndefined();
  });

  test('a non-empty identical file in the destination folder still dedupes', async () => {
    const source = path.join(sourceDir, 'report.pdf');
    await fs.writeFile(source, 'same-bytes');
    await fs.writeFile(path.join(destDir, 'report-copy.pdf'), 'same-bytes');

    const unlinkFn = jest.fn().mockResolvedValue(undefined);
    const result = await handleDuplicateMove({
      sourcePath: source,
      destinationPath: path.join(destDir, 'report.pdf'),
      unlinkFn,
      logger: null
    });
    expect(result).toEqual(
      expect.objectContaining({
        skipped: true,
        destination: path.join(destDir, 'report-copy.pdf')
      })
    );
    expect(unlinkFn).toHaveBeenCalledWith(source);
  });
});
