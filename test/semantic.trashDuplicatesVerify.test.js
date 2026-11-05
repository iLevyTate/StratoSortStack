/**
 * @jest-environment node
 *
 * "Identical" duplicate sets are grouped on a fingerprint stored when each
 * file was indexed. A file edited later, while nothing was watching, keeps
 * that old fingerprint, so the dialog can offer to trash a copy that is no
 * longer the same as the one being kept. The trash handler reads the bytes
 * again and leaves such a copy alone.
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const mockTrashBatch = jest.fn();
jest.mock('../src/main/services/TrashService', () => ({
  TrashService: class {
    trashBatch(paths) {
      return mockTrashBatch(paths);
    }
  }
}));

const path = require('path');
const fs = require('fs').promises;
const os = require('os');

const { handleTrashDuplicates } = require('../src/main/ipc/semantic');

const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() };

describe('handleTrashDuplicates re-checks byte-identical sets before trashing', () => {
  let dir;
  let keep;
  let same;
  let edited;

  beforeEach(async () => {
    mockTrashBatch.mockReset();
    mockTrashBatch.mockImplementation(async (paths) => ({
      trashed: paths.map((p) => ({ path: p, size: 1 })),
      failed: [],
      totalBytes: paths.length
    }));
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trash-verify-'));
    keep = path.join(dir, 'keep.pdf');
    same = path.join(dir, 'same.pdf');
    edited = path.join(dir, 'edited.pdf');
    await fs.writeFile(keep, 'original bytes');
    await fs.writeFile(same, 'original bytes');
    // Was identical when indexed; edited since, so its stored hash is stale.
    await fs.writeFile(edited, 'original bytes, then edited');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('a copy that no longer matches the kept file is skipped and reported', async () => {
    const result = await handleTrashDuplicates(
      { logger },
      {},
      {
        paths: [same, edited],
        verifyIdentical: [{ keep, paths: [same, edited] }]
      }
    );

    expect(mockTrashBatch).toHaveBeenCalledWith([same]);
    expect(result.trashed.map((t) => t.path)).toEqual([same]);
    expect(result.skipped).toEqual([{ path: edited, reason: 'no-longer-identical' }]);
    await expect(fs.readFile(edited, 'utf8')).resolves.toBe('original bytes, then edited');
  });

  test('nothing in a set is trashed when the kept copy cannot be read', async () => {
    await fs.rm(keep);
    const result = await handleTrashDuplicates(
      { logger },
      {},
      {
        paths: [same],
        verifyIdentical: [{ keep, paths: [same] }]
      }
    );

    expect(mockTrashBatch).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([{ path: same, reason: 'kept-copy-unreadable' }]);
  });

  test('sets the user reviewed as similar (no verify list) are trashed as asked', async () => {
    await handleTrashDuplicates({ logger }, {}, { paths: [edited] });
    expect(mockTrashBatch).toHaveBeenCalledWith([edited]);
  });
});

describe('trashDuplicates request schema', () => {
  test('keeps the kept-copy list so the re-check reaches the handler', () => {
    const { schemas } = require('../src/main/ipc/validationSchemas');
    const keep = path.resolve(os.tmpdir(), 'keep.pdf');
    const copy = path.resolve(os.tmpdir(), 'copy.pdf');
    const parsed = schemas.trashDuplicates.parse({
      paths: [copy],
      verifyIdentical: [{ keep, paths: [copy] }]
    });
    expect(parsed.verifyIdentical).toEqual([{ keep, paths: [copy] }]);
  });
});
