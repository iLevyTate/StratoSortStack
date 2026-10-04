const path = require('path');

const WORKER_POOLS_DIR = path.resolve(__dirname, '..', 'src', 'main', 'utils');
const RESOURCES_PATH = path.join('C:', 'Program Files', 'StratoSort Core', 'resources');
const UNPACKED_WORKER = path.join(RESOURCES_PATH, 'app.asar.unpacked', 'dist', 'ocrWorker.js');

describe('workerPools resolveWorkerPath', () => {
  const originalResourcesPath = process.resourcesPath;
  let existing;

  function loadWithPackaged(isPackaged) {
    jest.doMock('electron', () => ({
      app: { isPackaged, getAppPath: () => path.join(RESOURCES_PATH, 'app.asar') }
    }));
    return require('../src/main/utils/workerPools');
  }

  beforeEach(() => {
    jest.resetModules();
    existing = new Set();
    process.resourcesPath = RESOURCES_PATH;
    jest.doMock('fs', () => ({
      existsSync: jest.fn((candidate) => existing.has(candidate))
    }));
    jest.doMock('piscina', () => jest.fn());
  });

  afterEach(() => {
    process.resourcesPath = originalResourcesPath;
    jest.dontMock('fs');
    jest.dontMock('piscina');
    jest.dontMock('electron');
    jest.resetModules();
  });

  test('packaged app prefers the asar-unpacked worker over the __dirname copy inside the asar', () => {
    existing.add(UNPACKED_WORKER);
    existing.add(path.join(WORKER_POOLS_DIR, 'ocrWorker.js'));

    const { resolveWorkerPath } = loadWithPackaged(true);

    expect(resolveWorkerPath('ocrWorker')).toBe(UNPACKED_WORKER);
  });

  test('unpackaged app resolves the bundle next to the module first', () => {
    const sibling = path.join(WORKER_POOLS_DIR, 'ocrWorker.js');
    existing.add(UNPACKED_WORKER);
    existing.add(sibling);

    const { resolveWorkerPath } = loadWithPackaged(false);

    expect(resolveWorkerPath('ocrWorker')).toBe(sibling);
  });

  test('returns null when no candidate exists', () => {
    const { resolveWorkerPath } = loadWithPackaged(true);

    expect(resolveWorkerPath('ocrWorker')).toBeNull();
  });
});
