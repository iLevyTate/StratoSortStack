/**
 * @jest-environment node
 */
/**
 * Byte-identical files in one batch (the same report exported twice) must
 * not be removed as duplicates of each other. Runs the real batch handler
 * and the real duplicate check against a temp dir; only the OS trash is
 * replaced, by a `_TRASH` folder the test can inspect.
 *
 * The failure this pins: a Smart Folder that is also the input folder, so
 * some files are renamed in place. Each of two identical files found the
 * other in "the destination folder", both went to the trash, verification
 * then failed for the missing kept copy, and the whole batch rolled back.
 *
 * The same setup leaves some files at the path they already have. The run
 * must not touch them, and the dry-run preview must not show them as a name
 * clash with themselves.
 */

jest.unmock('fs');
jest.unmock('fs/promises');

jest.mock('../src/main/services/TrashService', () => ({
  TrashService: class {
    /** @param {string} filePath */
    async trashOne(filePath) {
      const fsp = require('fs').promises;
      const pathMod = require('path');
      const trashDir = pathMod.join(pathMod.dirname(pathMod.dirname(filePath)), '_TRASH');
      await fsp.mkdir(trashDir, { recursive: true });
      await fsp.rename(filePath, pathMod.join(trashDir, pathMod.basename(filePath)));
      return { success: true };
    }
  }
}));

jest.mock('../src/main/ipc/files/embeddingSync', () => ({
  removeEmbeddingsForPathBestEffort: jest.fn(),
  syncEmbeddingForMove: jest.fn(),
  verifyEmbeddingAfterMove: jest.fn().mockResolvedValue({ valid: true, issues: [] })
}));

jest.mock('../src/main/ipc/files/batchLockManager', () => ({
  acquireBatchLock: jest.fn().mockResolvedValue(true),
  renewBatchLock: jest.fn().mockReturnValue(true),
  releaseBatchLock: jest.fn()
}));

jest.mock('../src/main/ipc/files/batchProgressReporter', () => ({
  sendFileOperationBatchComplete: jest.fn(),
  sendOperationProgress: jest.fn(),
  sendChunkedResults: jest.fn().mockResolvedValue({ sent: true })
}));

jest.mock('../src/main/services/ServiceContainer', () => ({
  container: { has: jest.fn(() => false), resolve: jest.fn(), tryResolve: jest.fn(() => null) },
  ServiceIds: { FILE_PATH_COORDINATOR: 'filePathCoordinator', LEARNING_FEEDBACK: 'lf' }
}));

jest.mock('../src/main/ipc/files/destinationPolicy', () => ({
  authorizeDestinations: jest.fn().mockResolvedValue(new Map()),
  authorizeDestination: jest.fn().mockResolvedValue({ allowed: true }),
  decisionForDestination: jest.fn(() => ({ allowed: true })),
  buildStrictFileOpsAllowlist: jest.fn(() => ({ enabled: false, allowlist: [] }))
}));

jest.mock('../src/shared/pathSanitization', () => ({
  validateFileOperationPath: jest.fn(async (p) => ({
    valid: true,
    normalizedPath: require('path').resolve(p)
  })),
  normalizePathForIndex: jest.fn((p) => String(p).replace(/\\/g, '/'))
}));

jest.mock('../src/main/services/FolderMatchingService', () => ({
  matchCategoryToFolder: jest.fn(() => null)
}));

jest.mock('../src/main/ipc/semantic', () => ({
  getSearchServiceInstance: jest.fn(() => null)
}));

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const realOs = jest.requireActual('os');

const {
  handleBatchOrganize,
  previewBatchOrganize
} = require('../src/main/ipc/files/batchOrganizeHandler');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/** @type {string[]} */
const tempRoots = [];

async function makeRoot() {
  const root = await fsp.mkdtemp(path.join(realOs.tmpdir(), 'ss-dup-sources-'));
  tempRoots.push(root);
  return root;
}

afterAll(async () => {
  for (const root of tempRoots) {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/**
 * Every file under `dir`, as sorted forward-slash paths relative to it.
 * @param {string} dir
 * @param {string} [base]
 * @returns {Promise<string[]>}
 */
async function tree(dir, base = dir) {
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tree(full, base)));
    else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out.sort();
}

/**
 * @param {string} filePath
 * @param {string} content
 */
async function writeFile(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content);
}

/** @param {{ source: string, destination: string }[]} moves */
function organize(moves) {
  return handleBatchOrganize({
    operation: { operations: moves.map((move) => ({ type: 'move', ...move })) },
    logger: silentLog,
    getServiceIntegration: () => null,
    getMainWindow: () => null
  });
}

describe('identical files in one organize batch (real filesystem)', () => {
  test('two identical files renamed in place both survive under their new names', async () => {
    const root = await makeRoot();
    const input = path.join(root, 'Input');
    await writeFile(path.join(input, 'a.csv'), 'SAME');
    await writeFile(path.join(input, 'b.csv'), 'SAME');

    const result = await organize([
      { source: path.join(input, 'a.csv'), destination: path.join(input, 'A new.csv') },
      { source: path.join(input, 'b.csv'), destination: path.join(input, 'B new.csv') }
    ]);

    expect(result.success).toBe(true);
    expect(result.rolledBack).toBeFalsy();
    expect(result.successCount).toBe(2);
    expect(result.failCount).toBe(0);
    expect(await tree(root)).toEqual(['Input/A new.csv', 'Input/B new.csv']);
  });

  test('an identical pair renamed in place does not roll back the rest of the batch', async () => {
    const root = await makeRoot();
    const input = path.join(root, 'Input');
    const moves = [];
    for (let k = 0; k < 12; k++) {
      if (k === 4) {
        await writeFile(path.join(input, 'a.csv'), 'SAME');
        await writeFile(path.join(input, 'b.csv'), 'SAME');
        moves.push(
          { source: path.join(input, 'a.csv'), destination: path.join(input, 'A new.csv') },
          { source: path.join(input, 'b.csv'), destination: path.join(input, 'B new.csv') }
        );
      }
      await writeFile(path.join(input, `u${k}.csv`), `UNIQUE-${k}`);
      moves.push({
        source: path.join(input, `u${k}.csv`),
        destination: path.join(root, k % 2 ? 'Reports' : 'Exports', `U${k}.csv`)
      });
    }

    const result = await organize(moves);

    expect(result.success).toBe(true);
    expect(result.rolledBack).toBeFalsy();
    expect(result.successCount).toBe(14);
    expect(result.results.filter((/** @type {any} */ row) => !row.success)).toEqual([]);
    const after = await tree(root);
    expect(after.filter((file) => file.startsWith('_TRASH/'))).toEqual([]);
    expect(after.filter((file) => file.startsWith('Input/'))).toEqual([
      'Input/A new.csv',
      'Input/B new.csv'
    ]);
    expect(after).toHaveLength(14);
  });

  test('identical files swapping folders are both moved, neither removed for the other', async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, 'Left', 'a.csv'), 'SAME');
    await writeFile(path.join(root, 'Right', 'b.csv'), 'SAME');

    const result = await organize([
      {
        source: path.join(root, 'Left', 'a.csv'),
        destination: path.join(root, 'Right', 'A new.csv')
      },
      {
        source: path.join(root, 'Right', 'b.csv'),
        destination: path.join(root, 'Left', 'B new.csv')
      }
    ]);

    expect(result.success).toBe(true);
    expect(result.successCount).toBe(2);
    expect(await tree(root)).toEqual(['Left/B new.csv', 'Right/A new.csv']);
  });

  test('a copy that was already filed before the batch still dedupes the incoming file', async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, 'Input', 'a.csv'), 'SAME');
    await writeFile(path.join(root, 'Reports', 'filed last month.csv'), 'SAME');

    const result = await organize([
      {
        source: path.join(root, 'Input', 'a.csv'),
        destination: path.join(root, 'Reports', 'A new.csv')
      }
    ]);

    expect(result.success).toBe(true);
    expect(result.results).toEqual([
      expect.objectContaining({
        success: true,
        skipped: true,
        reason: 'duplicate',
        destination: path.join(root, 'Reports', 'filed last month.csv')
      })
    ]);
    expect(await tree(root)).toEqual(['Reports/filed last month.csv', '_TRASH/a.csv']);
  });
});

describe('files already in the folder chosen for them (real filesystem)', () => {
  test('a file already at its destination stays as it is, and the preview says the same', async () => {
    const root = await makeRoot();
    const filed = path.join(root, 'Input', 'report.csv');
    await writeFile(filed, 'REPORT');
    const moves = [{ source: filed, destination: filed }];

    const plan = await previewBatchOrganize({ operation: { operations: moves }, log: silentLog });

    expect(plan.conflicts).toBe(0);
    expect(plan.wouldMove).toEqual([
      { source: filed, destination: filed, originalDestination: filed, collision: false }
    ]);

    const result = await organize(moves);

    expect(result.success).toBe(true);
    expect(result.results).toEqual([
      expect.objectContaining({ success: true, source: filed, destination: filed })
    ]);
    expect(await tree(root)).toEqual(['Input/report.csv']);
    expect(await fsp.readFile(filed, 'utf8')).toBe('REPORT');
  });

  test('a rename in place onto a name another file has is still a clash', async () => {
    const root = await makeRoot();
    const input = path.join(root, 'Input');
    await writeFile(path.join(input, 'draft.csv'), 'DRAFT');
    await writeFile(path.join(input, 'report.csv'), 'REPORT');
    const moves = [
      { source: path.join(input, 'draft.csv'), destination: path.join(input, 'report.csv') }
    ];

    const plan = await previewBatchOrganize({ operation: { operations: moves }, log: silentLog });

    expect(plan.conflicts).toBe(1);
    expect(plan.wouldMove).toEqual([
      expect.objectContaining({
        destination: path.join(input, 'report_1.csv'),
        collision: true
      })
    ]);

    const result = await organize(moves);

    expect(result.success).toBe(true);
    expect(await tree(root)).toEqual(['Input/report.csv', 'Input/report_1.csv']);
    expect(await fsp.readFile(path.join(input, 'report.csv'), 'utf8')).toBe('REPORT');
    expect(await fsp.readFile(path.join(input, 'report_1.csv'), 'utf8')).toBe('DRAFT');
  });
});
