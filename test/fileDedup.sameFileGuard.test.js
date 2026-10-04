/**
 * @jest-environment node
 */
/**
 * F-082 regression guard: handleDuplicateMove must never treat the source
 * file ITSELF (seen through a case-variant path on case-insensitive
 * filesystems, or any same-inode alias) as a "duplicate at the
 * destination" — doing so checksums the file against itself, reports a
 * duplicate, and unlinks the source, destroying the only copy.
 *
 * Reachable in production whenever a naming convention produces a
 * case-only change for a file already in its target folder (batch
 * organize, single move, DownloadWatcher all funnel through
 * handleDuplicateMove before moving).
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const path = require('path');
const fs = require('fs').promises;
const os = require('os');

const { handleDuplicateMove, findDuplicateForDestination } = require('../src/main/utils/fileDedup');

describe('fileDedup same-file guard [F-082]', () => {
  let testDir;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dedup-samefile-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // best-effort tmp cleanup
    }
  });

  test('a case-only destination variant of the source is NOT a duplicate and the file survives', async () => {
    const source = path.join(testDir, 'CaseFile.TXT');
    await fs.writeFile(source, 'THE-ONLY-COPY');
    const destination = path.join(testDir, 'casefile.txt');

    const result = await handleDuplicateMove({
      sourcePath: source,
      destinationPath: destination,
      logger: null
    });

    // No dedup: the "duplicate" is the source itself on case-insensitive
    // filesystems (win32, default darwin). On case-sensitive filesystems
    // the destination simply does not exist. Either way: null, file intact.
    expect(result).toBeNull();
    expect(await fs.readFile(source, 'utf8')).toBe('THE-ONLY-COPY');
  });

  test('findDuplicateForDestination returns null for a same-file destination alias', async () => {
    const source = path.join(testDir, 'Report.PDF');
    await fs.writeFile(source, 'report-bytes');

    const match = await findDuplicateForDestination({
      sourcePath: source,
      destinationPath: path.join(testDir, 'report.pdf')
    });

    expect(match).toBeNull();
  });

  test('a genuine identical-content duplicate at the destination still dedupes (source removed)', async () => {
    const source = path.join(testDir, 'incoming.pdf');
    const destination = path.join(testDir, 'kept.pdf');
    await fs.writeFile(source, 'same-bytes');
    await fs.writeFile(destination, 'same-bytes');

    const result = await handleDuplicateMove({
      sourcePath: source,
      destinationPath: destination,
      logger: null,
      // The default removal goes through the OS trash (fileDedup.trash.test.js
      // covers it); this guard is about which file is removed, so unlink.
      unlinkFn: fs.unlink
    });

    expect(result).toMatchObject({ skipped: true, reason: 'duplicate', sourceRemoval: 'deleted' });
    await expect(fs.access(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(destination, 'utf8')).toBe('same-bytes');
  });
});
