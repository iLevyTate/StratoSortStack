/**
 * @jest-environment node
 *
 * The directory scan behind the startup delta scan, folder-add scans and
 * "Reanalyze all" must reach the same directories as the live watcher.
 * chokidar reads a directory whose depth is <= `depth` (the root is 0); the
 * scan stopped one level short, so a file in the deepest directory chokidar
 * watches was analyzed when dropped in live but never found by a scan.
 */

jest.mock('fs', () => jest.requireActual('fs'));
jest.mock('fs/promises', () => jest.requireActual('fs/promises'));
jest.mock('os', () => jest.requireActual('os'));
jest.mock('chokidar', () => ({
  watch: jest.fn(() => ({
    on: jest.fn().mockReturnThis(),
    once: jest.fn(),
    close: jest.fn().mockResolvedValue()
  }))
}));
jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  };
  return { logger, createLogger: () => logger };
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const SmartFolderWatcher = require('../src/main/services/SmartFolderWatcher');

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfw-depth-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeWatcher() {
  return new SmartFolderWatcher({
    getSmartFolders: () => [{ id: 'f1', name: 'Smart', path: root }],
    analysisHistoryService: {},
    settingsService: { load: jest.fn().mockResolvedValue({}) },
    analyzeDocumentFile: jest.fn(),
    analyzeImageFile: jest.fn()
  });
}

/** Write report.pdf at root and in each of `levels` nested directories. */
function buildTree(levels) {
  const files = [path.join(root, 'report.pdf')];
  fs.writeFileSync(files[0], 'synthetic');
  let dir = root;
  for (let i = 1; i <= levels; i++) {
    dir = path.join(dir, `d${i}`);
    fs.mkdirSync(dir);
    const file = path.join(dir, 'report.pdf');
    fs.writeFileSync(file, 'synthetic');
    files.push(file);
  }
  return files;
}

describe('SmartFolderWatcher._scanDirectory depth', () => {
  test('reads directories down to the watcher depth, like chokidar', async () => {
    const files = buildTree(4);
    const watcher = makeWatcher();
    watcher.watcherDepth = 3;

    const found = await watcher._scanDirectory(root);

    // Depths 0..3 are read; the depth-4 directory is past the limit.
    expect(found.sort()).toEqual(files.slice(0, 4).sort());
  });

  test('depth 0 still reads the folder itself', async () => {
    const files = buildTree(1);
    const watcher = makeWatcher();
    watcher.watcherDepth = 0;

    await expect(watcher._scanDirectory(root)).resolves.toEqual([files[0]]);
  });
});
