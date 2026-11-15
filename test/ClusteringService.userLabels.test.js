/**
 * Cluster names the user gives must survive a restart and stay with the same
 * files when k-means renumbers clusters on a recompute.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

jest.mock('../src/main/llamaUtils', () => ({
  getTextModel: jest.fn(() => 'test-model')
}));

let mockUserDataDir = '';
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => mockUserDataDir) }
}));

const { ClusteringService } = require('../src/main/services/ClusteringService');

const LABELS_FILE = 'cluster-user-labels.json';

/** Files whose ids name the group they belong to; embeddings are unused because kmeans is stubbed. */
const makeFiles = (/** @type {string[]} */ ids) =>
  ids.map((id) => ({ id, embedding: [1, 0, 0], metadata: { name: `${id}.txt` } }));

/**
 * A service whose next computeClusters groups files exactly as given.
 * @param {string[][]} groups
 */
function stubClustering(/** @type {any} */ service, groups) {
  const ids = groups.flat();
  const assignments = [];
  groups.forEach((group, clusterIdx) => group.forEach(() => assignments.push(clusterIdx)));
  service.getAllFileEmbeddings = jest.fn(async () => makeFiles(ids));
  service.kmeans = jest.fn(() => ({
    assignments,
    centroids: groups.map(() => [1, 0, 0])
  }));
}

const newService = () =>
  new ClusteringService({ vectorDbService: { peekFiles: jest.fn() }, llamaService: null });

const labelsById = (/** @type {any} */ service) =>
  Object.fromEntries(service.getClustersForGraph().map((c) => [c.id, c.label]));

describe('ClusteringService user cluster names', () => {
  beforeEach(() => {
    mockUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-labels-'));
  });

  afterEach(() => {
    fs.rmSync(mockUserDataDir, { recursive: true, force: true });
  });

  const taxes = ['tax-1', 'tax-2', 'tax-3', 'tax-4'];
  const photos = ['photo-1', 'photo-2', 'photo-3', 'photo-4'];

  test('a rename is loaded again after a restart', async () => {
    const first = newService();
    stubClustering(first, [photos, taxes]);
    await first.computeClusters(2);
    await first.renameCluster('cluster:1', 'Taxes', path.join(mockUserDataDir, LABELS_FILE));

    // A new service is what the app has after a restart
    const second = newService();
    stubClustering(second, [photos, taxes]);
    await second.computeClusters(2);

    expect(labelsById(second)['cluster:1']).toBe('Taxes');
  });

  test('the name follows its files when the cluster indices change', async () => {
    const service = newService();
    stubClustering(service, [photos, taxes]);
    await service.computeClusters(2);
    await service.renameCluster('cluster:1', 'Taxes', path.join(mockUserDataDir, LABELS_FILE));

    // Recompute puts the photos at index 1 and the tax files at index 0
    stubClustering(service, [taxes, photos]);
    await service.computeClusters(2);

    const labels = labelsById(service);
    expect(labels['cluster:0']).toBe('Taxes');
    expect(labels['cluster:1']).not.toBe('Taxes');
  });

  test('the name is not shown on a cluster that now holds mostly other files', async () => {
    const service = newService();
    stubClustering(service, [photos, taxes]);
    await service.computeClusters(2);
    await service.renameCluster('cluster:1', 'Taxes', path.join(mockUserDataDir, LABELS_FILE));

    // Two tax files were removed and the other two landed among new files:
    // overlaps 1/9 and 1/5, both below the bar
    const others = ['note-1', 'note-2', 'note-3', 'note-4', 'note-5', 'note-6'];
    stubClustering(service, [photos, ['tax-1', ...others.slice(0, 5)], ['tax-2', 'note-6']]);
    await service.computeClusters(3);

    expect(Object.values(labelsById(service))).not.toContain('Taxes');
  });

  test('a group that grows step by step keeps its name', async () => {
    const service = newService();
    stubClustering(service, [photos, taxes]);
    await service.computeClusters(2);
    await service.renameCluster('cluster:1', 'Taxes', path.join(mockUserDataDir, LABELS_FILE));

    // Each step keeps the overlap above half, though the last group shares
    // only 4 of 9 files with the one that was renamed.
    stubClustering(service, [photos, [...taxes, 'tax-5', 'tax-6']]);
    await service.computeClusters(2);
    stubClustering(service, [photos, [...taxes, 'tax-5', 'tax-6', 'tax-7', 'tax-8', 'tax-9']]);
    await service.computeClusters(2);

    expect(labelsById(service)['cluster:1']).toBe('Taxes');
  });

  test('a rename in a later session keeps names saved earlier', async () => {
    const filePath = path.join(mockUserDataDir, LABELS_FILE);
    const first = newService();
    stubClustering(first, [photos, taxes]);
    await first.computeClusters(2);
    await first.renameCluster('cluster:0', 'Photos', filePath);

    // After a restart, a new rename must not overwrite the earlier name in the file
    const second = newService();
    stubClustering(second, [photos, taxes]);
    await second.computeClusters(2);
    await second.renameCluster('cluster:1', 'Taxes', filePath);

    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(saved.labels.map((/** @type {any} */ e) => e.label).sort()).toEqual(['Photos', 'Taxes']);
  });

  test('renaming a cluster again replaces its saved name', async () => {
    const filePath = path.join(mockUserDataDir, LABELS_FILE);
    const service = newService();
    stubClustering(service, [photos, taxes]);
    await service.computeClusters(2);
    await service.renameCluster('cluster:1', 'Taxes', filePath);
    await service.renameCluster('cluster:1', 'Tax returns', filePath);

    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(saved.labels).toHaveLength(1);
    expect(saved.labels[0].label).toBe('Tax returns');
    expect(labelsById(service)['cluster:1']).toBe('Tax returns');
  });

  test('index-keyed names from an older file are not applied to new clusters', async () => {
    fs.writeFileSync(
      path.join(mockUserDataDir, LABELS_FILE),
      JSON.stringify({ 'cluster:1': 'Old' })
    );
    const service = newService();
    stubClustering(service, [photos, taxes]);
    await service.computeClusters(2);

    expect(Object.values(labelsById(service))).not.toContain('Old');
  });

  test('renaming a cluster that no longer exists fails instead of storing it by index', async () => {
    const service = newService();
    stubClustering(service, [photos, taxes]);
    await service.computeClusters(2);

    await expect(
      service.renameCluster('cluster:7', 'Taxes', path.join(mockUserDataDir, LABELS_FILE))
    ).rejects.toThrow('Cluster not found');
    expect(fs.existsSync(path.join(mockUserDataDir, LABELS_FILE))).toBe(false);
  });
});
