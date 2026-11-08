/**
 * @jest-environment node
 */
/**
 * Concurrent movers claiming the same candidate NAME must never replace each
 * other's file. Runs against the REAL filesystem in a temp dir (memfs and the
 * suite-level fs mocks either serialize synchronously or throw EEXIST from
 * rename, which real fs.rename never does: it replaces the occupant).
 *
 * Shape: the destination already holds `report.pdf`; one mover targets
 * `report.pdf` (collides, walks to `report_1.pdf`) while another targets
 * `report_1.pdf` directly. Both see `report_1.pdf` as free unless the
 * candidate name is serialized across movers.
 */

jest.unmock('fs');
jest.unmock('fs/promises');

jest.mock('../src/main/utils/fileDedup', () => ({
  computeFileChecksum: jest.fn().mockResolvedValue('checksum'),
  handleDuplicateMove: jest.fn().mockResolvedValue(null),
  findSemanticDuplicates: jest.fn().mockResolvedValue({ hasDuplicates: false, matches: [] })
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
const crypto = require('crypto');
const realOs = jest.requireActual('os');

const {
  performFileMove,
  handleBatchOrganize
} = require('../src/main/ipc/files/batchOrganizeHandler');
const { renameNoReplace, atomicFileOps } = require('../src/shared/atomicFileOperations');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/** @type {string[]} */
const tempRoots = [];

async function makeRoot() {
  const root = await fsp.mkdtemp(path.join(realOs.tmpdir(), 'ss-name-race-'));
  tempRoots.push(root);
  return root;
}

afterAll(async () => {
  for (const root of tempRoots) {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/** @param {string|Buffer} buf */
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * sha256 of every file under `dir`, recursively.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function contentsUnder(dir) {
  const out = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await contentsUnder(p)));
    else out.push(sha(await fsp.readFile(p)));
  }
  return out;
}

/**
 * @param {string} p
 * @param {string} content
 */
async function writeFile(p, content) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, content);
}

const ITERATIONS = 25;

describe('concurrent movers claiming one candidate name (real filesystem)', () => {
  test('two renameNoReplace calls onto one free name: exactly one wins, the other gets EEXIST', async () => {
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const root = await makeRoot();
      const a = path.join(root, 'in', 'a.txt');
      const b = path.join(root, 'in', 'b.txt');
      const target = path.join(root, 'out', 'target.txt');
      await writeFile(a, `A-${iter}`);
      await writeFile(b, `B-${iter}`);
      await fsp.mkdir(path.dirname(target), { recursive: true });

      const settled = await Promise.allSettled([
        renameNoReplace(a, target),
        renameNoReplace(b, target)
      ]);
      const fulfilled = settled.filter((s) => s.status === 'fulfilled');
      const rejected = settled.filter((s) => s.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(/** @type {any} */ (rejected[0]).reason.code).toBe('EEXIST');

      // The loser's bytes are still at its source; nothing was replaced.
      const all = [
        ...(await contentsUnder(path.join(root, 'in'))),
        ...(await contentsUnder(path.join(root, 'out')))
      ].sort();
      expect(all).toEqual([sha(`A-${iter}`), sha(`B-${iter}`)].sort());
    }
  });

  test('performFileMove: a collision walk and a direct mover onto the walked-to name keep every file', async () => {
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const root = await makeRoot();
      const dest = path.join(root, 'D');
      await writeFile(path.join(dest, 'report.pdf'), `OCCUPANT-${iter}`);
      const srcA = path.join(root, 'downloads', 'report.pdf');
      const srcB = path.join(root, 'downloads', 'old', 'report_1.pdf');
      await writeFile(srcA, `CONTENT-A-${iter}`);
      await writeFile(srcB, `CONTENT-B-${iter}`);

      const [resA, resB] = await Promise.all([
        performFileMove({ source: srcA, destination: path.join(dest, 'report.pdf') }, silentLog),
        performFileMove({ source: srcB, destination: path.join(dest, 'report_1.pdf') }, silentLog)
      ]);

      expect(resA.destination).not.toBe(resB.destination);
      expect((await contentsUnder(dest)).sort()).toEqual(
        [sha(`OCCUPANT-${iter}`), sha(`CONTENT-A-${iter}`), sha(`CONTENT-B-${iter}`)].sort()
      );
      expect(await fsp.readFile(resA.destination, 'utf8')).toBe(`CONTENT-A-${iter}`);
      expect(await fsp.readFile(resB.destination, 'utf8')).toBe(`CONTENT-B-${iter}`);
    }
  });

  test('a single atomicMove racing a batch performFileMove onto the same candidate keeps every file', async () => {
    for (let iter = 0; iter < ITERATIONS; iter++) {
      const root = await makeRoot();
      const dest = path.join(root, 'D');
      await writeFile(path.join(dest, 'report.pdf'), `OCCUPANT-${iter}`);
      const srcA = path.join(root, 'downloads', 'report.pdf');
      const srcB = path.join(root, 'single', 'report_1.pdf');
      await writeFile(srcA, `CONTENT-A-${iter}`);
      await writeFile(srcB, `CONTENT-B-${iter}`);

      const [resA, resB] = await Promise.all([
        performFileMove({ source: srcA, destination: path.join(dest, 'report.pdf') }, silentLog),
        atomicFileOps.atomicMove(srcB, path.join(dest, 'report_1.pdf'))
      ]);

      expect(resA.destination).not.toBe(resB);
      expect((await contentsUnder(dest)).sort()).toEqual(
        [sha(`OCCUPANT-${iter}`), sha(`CONTENT-A-${iter}`), sha(`CONTENT-B-${iter}`)].sort()
      );
    }
  });

  test('handleBatchOrganize: a batch whose suffixed names coincide keeps every file at a distinct destination', async () => {
    for (let iter = 0; iter < 10; iter++) {
      const root = await makeRoot();
      const dest = path.join(root, 'Smart', 'Reports');
      await writeFile(path.join(dest, 'report.pdf'), `OCCUPANT-${iter}`);
      const sources = [
        path.join(root, 'in1', 'report.pdf'),
        path.join(root, 'in2', 'report_1.pdf'),
        path.join(root, 'in3', 'report_2.pdf'),
        path.join(root, 'in4', 'report_3.pdf'),
        path.join(root, 'in5', 'report_4.pdf')
      ];
      const expected = [sha(`OCCUPANT-${iter}`)];
      for (let k = 0; k < sources.length; k++) {
        await writeFile(sources[k], `FILE-${k}-${iter}`);
        expected.push(sha(`FILE-${k}-${iter}`));
      }

      const result = await handleBatchOrganize({
        operation: {
          operations: sources.map((s) => ({
            source: s,
            destination: path.join(dest, path.basename(s)),
            type: 'move'
          }))
        },
        logger: silentLog,
        getServiceIntegration: () => null,
        getMainWindow: () => null
      });

      expect(result.success).toBe(true);
      expect(result.successCount).toBe(sources.length);
      const destinations = result.results.map((r) => r.destination);
      expect(new Set(destinations).size).toBe(sources.length);
      // Every reported destination holds exactly that op's bytes.
      for (const r of result.results) {
        const k = sources.indexOf(r.source);
        expect(await fsp.readFile(r.destination, 'utf8')).toBe(`FILE-${k}-${iter}`);
      }
      expect((await contentsUnder(dest)).sort()).toEqual(expected.sort());
    }
  });
});
