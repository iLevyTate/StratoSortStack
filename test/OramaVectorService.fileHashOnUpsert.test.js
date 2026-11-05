/**
 * Every file row carries its content fingerprint.
 *
 * Before this, nothing on the analysis or embedding path wrote `fileHash`:
 * only the manual "Reindex File Hashes" action did. So the Exact tier of
 * Find Duplicates and triage's findByHash were empty for anyone who had not
 * run it. upsertFile now hashes the file (through the persistent hash cache)
 * when the caller does not supply a hash.
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

jest.mock('electron', () => ({
  app: { getPath: jest.fn() }
}));

jest.mock('../src/shared/logger', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { createLogger: () => mockLogger };
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
const { OramaVectorService } = require('../src/main/services/OramaVectorService');

const TEMP_DIR = path.join(__dirname, 'temp-orama-file-hash-upsert');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

describe('OramaVectorService.upsertFile stores the content fingerprint', () => {
  let service;
  const docPath = path.join(TEMP_DIR, 'report.txt');
  const twinPath = path.join(TEMP_DIR, 'report copy.txt');
  const vector = () => new Array(768).fill(0.1);

  beforeAll(async () => {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    app.getPath.mockReturnValue(TEMP_DIR);
    await fs.writeFile(docPath, 'quarterly numbers');
    await fs.writeFile(twinPath, 'quarterly numbers');
    service = new OramaVectorService();
    await service.initialize();
  });

  afterEach(async () => {
    if (service?.shutdown) await service.shutdown();
  });

  test('hashes the file when no hash is supplied, so findByHash sees both copies', async () => {
    await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: docPath } });
    await service.upsertFile({ id: 'file:b', vector: vector(), meta: { path: twinPath } });

    const row = await service.getFile('file:a');
    expect(row.fileHash).toBe(sha256('quarterly numbers'));

    const twins = await service.findByHash(sha256('quarterly numbers'));
    expect(twins.map((doc) => doc.id).sort()).toEqual(['file:a', 'file:b']);
  });

  test('a supplied meta.fileHash wins over hashing', async () => {
    await service.upsertFile({
      id: 'file:a',
      vector: vector(),
      meta: { path: docPath, fileHash: 'supplied-hash' }
    });
    expect((await service.getFile('file:a')).fileHash).toBe('supplied-hash');
  });

  test('a file that cannot be read keeps the fingerprint its row already had', async () => {
    await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: docPath } });
    await fs.rm(docPath);
    await service.upsertFile({ id: 'file:a', vector: vector(), meta: { path: docPath } });
    expect((await service.getFile('file:a')).fileHash).toBe(sha256('quarterly numbers'));
  });

  test('a row with no path and no hash stores an empty fingerprint', async () => {
    await service.upsertFile({ id: 'file:none', vector: vector(), meta: {} });
    expect((await service.getFile('file:none')).fileHash).toBe('');
  });
});
