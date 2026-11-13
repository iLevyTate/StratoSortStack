/**
 * @jest-environment node
 */
/**
 * A file that is not where it should be right after its move (a sync client
 * or an antivirus took it, or put it back) is one failed row; the rest of the
 * run stays moved. Runs the real batch handler, the real move, the real check
 * after it and the real rollback against a temp dir.
 *
 * The only stand-in is the other program: `afterEachMove` runs a real
 * filesystem call of its own right after a file lands, which is the one
 * moment the check cannot see past.
 */

jest.unmock('fs');
jest.unmock('fs/promises');

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

const { handleBatchOrganize } = require('../src/main/ipc/files/batchOrganizeHandler');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/** @type {string[]} */
const tempRoots = [];

async function makeRoot() {
  const root = await fsp.mkdtemp(path.join(realOs.tmpdir(), 'ss-move-check-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  jest.restoreAllMocks();
});

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
 * `count` files in Input, each to be moved to Sorted under the same name.
 * @param {string} root
 * @param {number} count
 */
async function seedMoves(root, count) {
  const moves = [];
  await fsp.mkdir(path.join(root, 'Input'), { recursive: true });
  for (let k = 1; k <= count; k++) {
    const source = path.join(root, 'Input', `doc${k}.txt`);
    await fsp.writeFile(source, `DOC-${k}`);
    moves.push({ source, destination: path.join(root, 'Sorted', `doc${k}.txt`) });
  }
  return moves;
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

/**
 * The other program with a hand on the folder: `act` runs right after a file
 * has really landed in Sorted, before the handler looks at it.
 * @param {(source: string, destination: string) => Promise<void>} act
 */
function afterEachMove(act) {
  const realRename = fsp.rename.bind(fsp);
  jest.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
    await realRename(from, to);
    if (path.basename(path.dirname(String(to))) === 'Sorted') {
      await act(String(from), String(to));
    }
  });
}

/**
 * @param {any} result
 * @param {string} name
 */
const rowFor = (result, name) =>
  result.results.find((/** @type {any} */ row) => path.basename(row.source) === name);

describe('a file that is not where it should be after its move (real filesystem)', () => {
  test('a file taken from its destination fails alone; the others stay moved', async () => {
    const root = await makeRoot();
    const moves = await seedMoves(root, 5);
    afterEachMove(async (_source, destination) => {
      if (path.basename(destination) === 'doc3.txt') await fsp.unlink(destination);
    });

    const result = await organize(moves);

    expect(result.rolledBack).toBeFalsy();
    expect(result.successCount).toBe(4);
    expect(result.failCount).toBe(1);
    expect(rowFor(result, 'doc3.txt')).toMatchObject({
      success: false,
      errorCode: 'MOVE_VERIFICATION_DESTINATION_FAILED',
      critical: false
    });
    expect(rowFor(result, 'doc3.txt').error).toBe(
      `Move verification failed: destination does not exist after move: ${moves[2].destination}. The file is no longer at its original location either.`
    );
    expect(await tree(root)).toEqual([
      'Sorted/doc1.txt',
      'Sorted/doc2.txt',
      'Sorted/doc4.txt',
      'Sorted/doc5.txt'
    ]);
  });

  test('a file put back where it came from fails alone and is reported as still there', async () => {
    const root = await makeRoot();
    const moves = await seedMoves(root, 3);
    afterEachMove(async (source, destination) => {
      if (path.basename(destination) === 'doc2.txt') await fsp.rename(destination, source);
    });

    const result = await organize(moves);

    expect(result.rolledBack).toBeFalsy();
    expect(result.successCount).toBe(2);
    expect(rowFor(result, 'doc2.txt')).toMatchObject({
      success: false,
      errorCode: 'MOVE_VERIFICATION_DESTINATION_FAILED'
    });
    expect(rowFor(result, 'doc2.txt').error).toMatch(
      /The file is still at its original location\.$/
    );
    expect(await tree(root)).toEqual(['Input/doc2.txt', 'Sorted/doc1.txt', 'Sorted/doc3.txt']);
    expect(await fsp.readFile(moves[1].source, 'utf8')).toBe('DOC-2');
  });

  test('a file that is at both places after its move fails alone, and neither copy is touched', async () => {
    const root = await makeRoot();
    const moves = await seedMoves(root, 3);
    afterEachMove(async (source, destination) => {
      if (path.basename(destination) === 'doc2.txt') await fsp.copyFile(destination, source);
    });

    const result = await organize(moves);

    expect(result.rolledBack).toBeFalsy();
    expect(result.successCount).toBe(2);
    expect(rowFor(result, 'doc2.txt')).toMatchObject({
      success: false,
      errorCode: 'MOVE_VERIFICATION_SOURCE_EXISTS',
      critical: false
    });
    expect(rowFor(result, 'doc2.txt').error).toContain(moves[1].source);
    expect(await tree(root)).toEqual([
      'Input/doc2.txt',
      'Sorted/doc1.txt',
      'Sorted/doc2.txt',
      'Sorted/doc3.txt'
    ]);
  });

  test('a destination that keeps losing files is rolled back, and the confirmed file returns', async () => {
    const root = await makeRoot();
    const moves = await seedMoves(root, 8);
    // One confirmed move can split seven failures into two runs at most, so
    // one run reaches the three in a row that make it systemic.
    afterEachMove(async (_source, destination) => {
      if (path.basename(destination) !== 'doc1.txt') await fsp.unlink(destination);
    });

    const result = await organize(moves);

    expect(result.rolledBack).toBe(true);
    const after = await tree(root);
    expect(after).toContain('Input/doc1.txt');
    expect(after.filter((file) => file.startsWith('Sorted/'))).toEqual([]);
    expect(await fsp.readFile(moves[0].source, 'utf8')).toBe('DOC-1');
  });
});
