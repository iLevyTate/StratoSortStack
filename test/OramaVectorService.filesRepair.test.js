/**
 * Regression coverage for the files vector-index repair path.
 *
 * F-048: `_repairFilesVectorIndexFromCurrentState` re-inserted every existing
 * document with an explicit field list that omitted `fileHash`, silently
 * resetting it to the schema default ('') on each rebuild. Because
 * `findByHash` filters on `where: { fileHash }`, duplicate detection went
 * blind for the entire `files` index after any repair fired (and the repair
 * path is reachable on a normal startup vector-health probe). The repair must
 * carry `fileHash` forward, mirroring the sibling rebuild path and `upsertFile`.
 */

const fs = require('fs').promises;
const path = require('path');

jest.mock('electron', () => ({
  app: { getPath: jest.fn() }
}));

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('../src/shared/singletonFactory', () => ({
  createSingletonHelpers: () => ({
    getInstance: jest.fn(),
    createInstance: jest.fn(),
    registerWithContainer: jest.fn(),
    resetInstance: jest.fn()
  })
}));

// Mock only the persistence plugin (ESM in jest); the core Orama engine runs
// for real so the fileHash round-trip is exercised end to end.
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

const TEMP_DIR = path.join(__dirname, 'temp-orama-files-repair-test');

const { app } = require('electron');
const { OramaVectorService } = require('../src/main/services/OramaVectorService');

describe('OramaVectorService files repair preserves fileHash (F-048)', () => {
  let service;

  beforeAll(async () => {
    await fs.mkdir(TEMP_DIR, { recursive: true }).catch(() => {});
  });

  afterAll(async () => {
    await fs.rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    app.getPath.mockReturnValue(TEMP_DIR);
    service = new OramaVectorService();
    await service.initialize();
  });

  afterEach(async () => {
    await service.cleanup();
  });

  test('findByHash still resolves a repaired file after a full index rebuild', async () => {
    const HASH = 'sha256-deadbeefcafef00d';
    const upsert = await service.upsertFile({
      id: 'file-hash-1',
      vector: new Array(768).fill(0.1),
      meta: {
        path: '/docs/contract.pdf',
        fileName: 'contract.pdf',
        fileType: 'application/pdf',
        fileHash: HASH,
        analyzedAt: new Date().toISOString()
      }
    });
    expect(upsert.success).toBe(true);

    // Sanity: duplicate detection sees the file before any repair.
    const before = await service.findByHash(HASH);
    expect(before.map((d) => d.id)).toContain('file-hash-1');

    // The repair path runs off the vector-health probe on startup / post-batch.
    const result = await service._repairFilesVectorIndexFromCurrentState();
    expect(result.repaired).not.toBe(false);

    // RED before fix: the rebuilt doc dropped fileHash, so this returns [].
    const after = await service.findByHash(HASH);
    expect(after.map((d) => d.id)).toContain('file-hash-1');
    expect(after.find((d) => d.id === 'file-hash-1').fileHash).toBe(HASH);
  });
});
