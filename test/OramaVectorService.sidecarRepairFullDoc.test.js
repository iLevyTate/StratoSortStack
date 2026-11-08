/**
 * Restore's sidecar repair must keep the whole document.
 *
 * When a saved row comes back with a zero-placeholder embedding (the Orama
 * 3.1.x vector-loss), restore copies the real vector back in from the
 * persisted sidecar. Orama 3.x `update(db, id, doc)` is `remove(id)` then
 * `insert(doc)` (methods/update.js), so it stores exactly the document it is
 * given. The repair passed `{ embedding, hasVector }` only: the row lost
 * filePath, fileName, fileHash, tags and every other field, and since the
 * partial doc had no `id`, insert() gave it a random one, so the original id
 * vanished from the collection. A sidecar entry with no matching row made
 * remove() a no-op and insert() a phantom vectors-only row.
 *
 * Real Orama, no module mock.
 */

const os = require('os');
const path = require('path');
const fsp = require('fs').promises;

jest.mock('fs', () => jest.requireActual('fs'));
jest.mock('fs/promises', () => jest.requireActual('fs/promises'));
jest.mock('electron', () => ({ app: { getPath: jest.fn() } }));
jest.mock('../src/shared/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: () => logger };
});
jest.mock('../src/shared/singletonFactory', () => ({
  createSingletonHelpers: () => ({
    getInstance: jest.fn(),
    createInstance: jest.fn(),
    registerWithContainer: jest.fn(),
    resetInstance: jest.fn()
  })
}));
jest.mock('@orama/plugin-data-persistence', () => ({
  persist: jest.fn(async () => '{}'),
  restore: jest.fn(async () => {
    throw new Error('restore not available in test');
  })
}));
jest.mock('../src/main/llamaUtils', () => ({
  getEmbeddingModel: jest.fn(() => 'nomic-embed-text-v1.5-Q8_0.gguf'),
  loadLlamaConfig: jest.fn().mockResolvedValue({
    selectedEmbeddingModel: 'nomic-embed-text-v1.5-Q8_0.gguf'
  })
}));

const { app } = require('electron');
const { getByID, update, count } = require('@orama/orama');
const { OramaVectorService } = require('../src/main/services/OramaVectorService');

const TEMP_ROOT = require('fs').mkdtempSync(
  path.join(jest.requireActual('os').tmpdir(), 'strato-orama-repair-')
);

const vectorFor = (dimension, seed) => {
  const v = new Array(dimension).fill(0.001);
  v[seed % dimension] = 1;
  v[(seed * 7 + 3) % dimension] = 0.5;
  return v;
};

const META = {
  'file:a': {
    path: '/lib/reports/q3-report.pdf',
    fileName: 'q3-report.pdf',
    fileType: 'application/pdf',
    analyzedAt: '2026-09-01T00:00:00.000Z',
    suggestedName: 'Q3 Financial Report.pdf',
    keywords: ['finance', 'quarterly'],
    tags: ['work'],
    extractionMethod: 'pdf-text',
    fileHash: 'a'.repeat(64)
  },
  'file:b': {
    path: '/lib/photos/beach.jpg',
    fileName: 'beach.jpg',
    fileType: 'image/jpeg',
    analyzedAt: '2026-09-02T00:00:00.000Z',
    suggestedName: 'Beach Sunset.jpg',
    keywords: ['beach'],
    tags: ['holiday'],
    extractionMethod: 'vision',
    fileHash: 'b'.repeat(64)
  }
};

afterAll(async () => {
  await fsp.rm(TEMP_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('OramaVectorService restore sidecar repair keeps full documents', () => {
  let dir;
  let services;

  const startService = async () => {
    const service = new OramaVectorService();
    services.push(service);
    await service.initialize();
    return service;
  };

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(TEMP_ROOT, 'run-'));
    app.getPath.mockReturnValue(dir);
    services = [];
    // The test file system cannot fsync a handle; stub just the .bak tmp file
    // (same approach as OramaVectorService.persistDurability.test.js).
    const realOpen = fsp.open.bind(fsp);
    jest
      .spyOn(fsp, 'open')
      .mockImplementation((file, ...rest) =>
        String(file).includes('.bak.tmp.')
          ? Promise.resolve({ sync: async () => {}, close: async () => {} })
          : realOpen(file, ...rest)
      );
  });

  afterEach(async () => {
    for (const service of services) {
      await service.shutdown().catch(() => {});
    }
    jest.restoreAllMocks();
  });

  test('a zero-placeholder row repaired from the sidecar keeps its id and every field', async () => {
    const first = await startService();
    const dimension = first._dimension;
    for (const [i, id] of Object.keys(META).entries()) {
      await first.upsertFile({ id, vector: vectorFor(dimension, i + 1), meta: META[id] });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    const before = { ...(await getByID(first._databases.files, 'file:a')) };
    expect(before.filePath).toBe(META['file:a'].path);

    // The vector-loss: the stored row is saved with a zero embedding while the
    // sidecar still holds the real vector.
    await update(first._databases.files, 'file:a', {
      ...before,
      embedding: new Array(dimension).fill(0),
      hasVector: false
    });
    const saved = await first.persistAll();
    expect(saved.success).toBe(true);

    // A sidecar entry whose row is gone must not become a row of its own.
    const sidecarPath = path.join(first._dataPath, 'files.sidecar.json');
    const sidecar = JSON.parse(await fsp.readFile(sidecarPath, 'utf8'));
    expect(sidecar['file:a']).toEqual(vectorFor(dimension, 1));
    sidecar['file:gone'] = vectorFor(dimension, 9);
    await fsp.writeFile(sidecarPath, JSON.stringify(sidecar));
    await first.shutdown();

    const second = await startService();
    const files = second._databases.files;

    const repaired = await getByID(files, 'file:a');
    expect(repaired).toBeTruthy();
    expect(repaired).toEqual({
      ...before,
      embedding: vectorFor(dimension, 1),
      hasVector: true
    });
    expect(second._embeddingStore.files.get('file:a')).toEqual(vectorFor(dimension, 1));
    await expect(second.hasUsableVector('file:a')).resolves.toBe(true);

    // The untouched row is untouched, and no extra rows appeared.
    const other = await getByID(files, 'file:b');
    expect(other.filePath).toBe(META['file:b'].path);
    expect(other.fileHash).toBe(META['file:b'].fileHash);
    expect(await getByID(files, 'file:gone')).toBeFalsy();
    expect(await count(files)).toBe(2);
  });
});
