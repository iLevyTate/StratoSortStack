/**
 * @jest-environment node
 */
/**
 * Organize numbers two files of one batch headed for the same name apart
 * before it sends them (report.pdf, report_1.pdf). When a file of that name
 * is already in the folder, the move numbers the file whose name is taken.
 * Runs the real batch handler and dry-run preview against a temp dir.
 *
 * The failure this pins: the move did not know the batch's own numbered
 * names, so with report.pdf in the folder Preview showed both files going to
 * report_1.pdf while the move gave them report_1.pdf and report_2.pdf the
 * other way round, and a taken report_1.pdf became report_1_1.pdf.
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

afterAll(async () => {
  for (const root of tempRoots) {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/**
 * @param {string} filePath
 * @param {string} content
 */
async function writeFile(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content);
}

/**
 * Put `existing` (name -> content) in a Sorted folder and `incoming` in an
 * Inbox, then preview and run the batch Organize sends for them.
 * @param {Record<string, string>} existing
 * @param {{ name: string, content: string, to: string, renumbered?: boolean }[]} incoming
 */
async function runBatch(existing, incoming, logger = silentLog) {
  const root = await fsp.mkdtemp(path.join(realOs.tmpdir(), 'ss-batch-numbering-'));
  tempRoots.push(root);
  const sorted = path.join(root, 'Sorted');
  await fsp.mkdir(sorted, { recursive: true });
  for (const [name, content] of Object.entries(existing)) {
    await writeFile(path.join(sorted, name), content);
  }
  const operations = [];
  for (const file of incoming) {
    await writeFile(path.join(root, 'Inbox', file.name), file.content);
    operations.push({
      type: 'move',
      source: path.join(root, 'Inbox', file.name),
      destination: path.join(sorted, file.to),
      ...(file.renumbered ? { renumbered: true } : {})
    });
  }
  const plan = await previewBatchOrganize({ operation: { operations }, log: silentLog });
  const result = await handleBatchOrganize({
    operation: { operations },
    logger,
    getServiceIntegration: () => null,
    getMainWindow: () => null
  });
  /** @type {Record<string, string>} */
  const onDisk = {};
  for (const name of (await fsp.readdir(sorted)).sort()) {
    onDisk[name] = await fsp.readFile(path.join(sorted, name), 'utf8');
  }
  /** @param {{ source: string, destination: string }} row */
  const landing = (row) => `${path.basename(row.source)} -> ${path.basename(row.destination)}`;
  return {
    preview: plan.wouldMove.map(landing),
    moved: result.results.filter((row) => row.success).map(landing),
    result,
    onDisk
  };
}

// What Organize sends for two exports that get the same new name: the first
// keeps it, the second is numbered `_1` and marked renumbered.
const twoReports = [
  { name: 'a.pdf', content: 'AAA', to: 'r.pdf' },
  { name: 'b.pdf', content: 'BBB', to: 'r_1.pdf', renumbered: true }
];

/**
 * @param {Awaited<ReturnType<typeof runBatch>>} run
 * @param {string[]} expected
 */
function expectPreviewMatchesMove(run, expected) {
  expect(run.result.success).toBe(true);
  expect([...run.moved].sort()).toEqual([...expected].sort());
  expect([...run.preview].sort()).toEqual([...expected].sort());
  // Nothing is numbered twice.
  expect(Object.keys(run.onDisk).filter((name) => /_\d+_\d+\./.test(name))).toEqual([]);
}

describe('a batch Organize numbered apart, into a folder that already has the name', () => {
  test('the file whose name is taken skips the number another file is headed for', async () => {
    const run = await runBatch({ 'r.pdf': 'OLD' }, twoReports);

    expectPreviewMatchesMove(run, ['a.pdf -> r_2.pdf', 'b.pdf -> r_1.pdf']);
    expect(run.onDisk).toEqual({ 'r.pdf': 'OLD', 'r_1.pdf': 'BBB', 'r_2.pdf': 'AAA' });
  });

  test('a numbered name taken on disk counts on from the name, not from the number', async () => {
    const run = await runBatch({ 'r.pdf': 'OLD', 'r_1.pdf': 'OLD1' }, twoReports);

    expectPreviewMatchesMove(run, ['a.pdf -> r_2.pdf', 'b.pdf -> r_3.pdf']);
    expect(run.onDisk).toEqual({
      'r.pdf': 'OLD',
      'r_1.pdf': 'OLD1',
      'r_2.pdf': 'AAA',
      'r_3.pdf': 'BBB'
    });
  });

  test('only the numbered name taken: the first file keeps its name', async () => {
    const run = await runBatch({ 'r_1.pdf': 'OLD1' }, twoReports);

    expectPreviewMatchesMove(run, ['a.pdf -> r.pdf', 'b.pdf -> r_2.pdf']);
    expect(run.onDisk).toEqual({ 'r.pdf': 'AAA', 'r_1.pdf': 'OLD1', 'r_2.pdf': 'BBB' });
  });

  test('three files, two of their names taken: every file lands where Preview said', async () => {
    const run = await runBatch({ 'r.pdf': 'OLD', 'r_2.pdf': 'OLD2' }, [
      ...twoReports,
      { name: 'c.pdf', content: 'CCC', to: 'r_2.pdf', renumbered: true }
    ]);

    expectPreviewMatchesMove(run, ['a.pdf -> r_3.pdf', 'b.pdf -> r_1.pdf', 'c.pdf -> r_4.pdf']);
    expect(run.onDisk).toEqual({
      'r.pdf': 'OLD',
      'r_1.pdf': 'BBB',
      'r_2.pdf': 'OLD2',
      'r_3.pdf': 'AAA',
      'r_4.pdf': 'CCC'
    });
  });
});

test('a name of the file’s own that ends in a number is numbered as before', async () => {
  // Not marked renumbered: `_1` is part of the file's name, not Organize's.
  const run = await runBatch({ 'notes_1.pdf': 'OLD' }, [
    { name: 'n.pdf', content: 'NNN', to: 'notes_1.pdf' }
  ]);

  expect(run.moved).toEqual(['n.pdf -> notes_1_1.pdf']);
  expect(run.preview).toEqual(['n.pdf -> notes_1_1.pdf']);
  expect(run.onDisk).toEqual({ 'notes_1.pdf': 'OLD', 'notes_1_1.pdf': 'NNN' });
});

describe('files numbered from one name run in batch order', () => {
  const orderNote = /move in batch order/;
  const spyLog = () => ({ ...silentLog, info: jest.fn() });
  /** @param {{ info: jest.Mock }} log */
  const ranInOrder = (log) => log.info.mock.calls.some(([message]) => orderNote.test(message));

  test('only when one of their names is already taken', async () => {
    const taken = spyLog();
    await runBatch({ 'r.pdf': 'OLD' }, twoReports, taken);
    expect(ranInOrder(taken)).toBe(true);
  });

  test('not when every name is free, so they move alongside the rest of the batch', async () => {
    const free = spyLog();
    const run = await runBatch({}, twoReports, free);
    expect(ranInOrder(free)).toBe(false);
    expect(run.onDisk).toEqual({ 'r.pdf': 'AAA', 'r_1.pdf': 'BBB' });
  });
});
