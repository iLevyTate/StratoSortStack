/**
 * Verifies the null-embedding guard in OramaVectorService update paths.
 *
 * Regression: "Reindex File Hashes" from Settings caused 14 consecutive
 * `Cannot read properties of null (reading 'length')` warnings, one per file,
 * because `updateFileHash` spread `existing` into Orama's `update()` and
 * Orama's `validateSchema` reads `.length` on the vector field. When a stored
 * row has `embedding: null` (sidecar-restore loss, malformed persist, etc.)
 * the validator throws.
 *
 * The fix is `_normalizeFileDocForUpdate(doc)` — a small private helper that
 * substitutes a zero-vector when the embedding field is null/missing. This
 * test pins the helper's contract and proves both call sites
 * (`updateFileHash`, `markFilesAsOrphaned`) survive the offending input.
 */

const fs = require('fs').promises;
const path = require('path');

jest.mock('electron', () => ({
  app: { getPath: jest.fn() }
}));

jest.mock('../src/shared/logger', () => {
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };
  return { createLogger: () => mockLogger, __mockLogger: mockLogger };
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

const TEMP_DIR = path.join(__dirname, 'temp-orama-update-hash-guard');

describe('OramaVectorService — null-embedding guard on update boundary', () => {
  let service;

  beforeAll(async () => {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  });

  afterAll(async () => {
    try {
      await fs.rm(TEMP_DIR, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  beforeEach(async () => {
    app.getPath.mockReturnValue(TEMP_DIR);
    service = new OramaVectorService();
    await service.initialize();
  });

  afterEach(async () => {
    if (service?.shutdown) await service.shutdown();
  });

  describe('_normalizeFileDocForUpdate', () => {
    test('returns the doc untouched when embedding is a valid array', () => {
      const embedding = new Array(service._dimension).fill(0.1);
      const doc = { id: 'f:a', embedding, fileHash: 'old' };
      const normalized = service._normalizeFileDocForUpdate(doc);
      // Same reference (no spread) when valid — cheaper hot path.
      expect(normalized).toBe(doc);
      expect(normalized.embedding).toBe(embedding);
    });

    test('substitutes a zero-vector when embedding is null', () => {
      const doc = { id: 'f:a', embedding: null, fileHash: 'old' };
      const normalized = service._normalizeFileDocForUpdate(doc);
      expect(Array.isArray(normalized.embedding)).toBe(true);
      expect(normalized.embedding).toHaveLength(service._dimension);
      expect(normalized.embedding.every((n) => n === 0)).toBe(true);
      // Other fields preserved
      expect(normalized.id).toBe('f:a');
      expect(normalized.fileHash).toBe('old');
      // Original doc not mutated (spread)
      expect(doc.embedding).toBe(null);
    });

    test('substitutes when embedding field is missing entirely', () => {
      const doc = { id: 'f:b', fileHash: 'old' };
      const normalized = service._normalizeFileDocForUpdate(doc);
      expect(Array.isArray(normalized.embedding)).toBe(true);
      expect(normalized.embedding).toHaveLength(service._dimension);
    });

    test('substitutes when embedding is a non-array object (string, number, {})', () => {
      for (const bad of ['not-array', 0, {}, true]) {
        const normalized = service._normalizeFileDocForUpdate({ id: 'x', embedding: bad });
        expect(Array.isArray(normalized.embedding)).toBe(true);
        expect(normalized.embedding).toHaveLength(service._dimension);
      }
    });
  });

  describe('updateFileHash with corrupted embedding', () => {
    test('updates hash and does not throw NPE when stored embedding is null', async () => {
      const { insert, getByID } = require('@orama/orama');
      const id = 'file:test-null-embedding';
      // Insert a record with null embedding directly into the Orama collection.
      // This is the exact malformed state that caused the production NPE.
      const validEmbedding = new Array(service._dimension).fill(0);
      await insert(service._databases.files, {
        id,
        embedding: validEmbedding, // insert requires valid array; we'll corrupt below
        path: '/x/test.txt',
        name: 'test.txt',
        category: 'document',
        fileHash: 'sha-old'
      });

      // Now corrupt the stored doc to simulate the post-restore "embedding: null"
      // state. Orama's getByID returns a reference to the internal doc, so
      // mutating its embedding field reproduces the production condition without
      // needing to monkey with the bundled @orama internals.
      const stored = await getByID(service._databases.files, id);
      stored.embedding = null;

      const ok = await service.updateFileHash(id, 'sha-new');
      expect(ok).toBe(true);

      const after = await getByID(service._databases.files, id);
      expect(after.fileHash).toBe('sha-new');
      // The guard substituted a zero-vector — the doc now has a valid embedding.
      expect(Array.isArray(after.embedding)).toBe(true);
      expect(after.embedding).toHaveLength(service._dimension);
    });

    test('returns false (without throwing) when record does not exist', async () => {
      const ok = await service.updateFileHash('file:does-not-exist', 'sha-new');
      expect(ok).toBe(false);
    });

    test('returns false (without throwing) for invalid inputs', async () => {
      expect(await service.updateFileHash(null, 'sha')).toBe(false);
      expect(await service.updateFileHash('', 'sha')).toBe(false);
      expect(await service.updateFileHash('id', null)).toBe(false);
      expect(await service.updateFileHash('id', 42)).toBe(false);
    });
  });

  describe('updateDocumentTags with corrupted embedding', () => {
    test('updates tags without NPE when stored embedding is null', async () => {
      const { insert, getByID } = require('@orama/orama');
      const id = 'file:test-tags-null-embedding';
      await insert(service._databases.files, {
        id,
        embedding: new Array(service._dimension).fill(0),
        path: '/z/tagged.txt',
        name: 'tagged.txt',
        category: 'document',
        tags: ['old']
      });

      // Corrupt the embedding to reproduce the sidecar-restore-loss state.
      const stored = await getByID(service._databases.files, id);
      stored.embedding = null;

      const ok = await service.updateDocumentTags(id, ['old', 'new']);
      expect(ok).toBe(true);

      const after = await getByID(service._databases.files, id);
      expect(after.tags).toEqual(['old', 'new']);
      expect(Array.isArray(after.embedding)).toBe(true);
      expect(after.embedding).toHaveLength(service._dimension);
    });
  });

  describe('markEmbeddingsOrphaned with corrupted embedding', () => {
    test('marks file orphaned without NPE when stored embedding is null', async () => {
      const { insert, getByID } = require('@orama/orama');
      const id = 'file:test-orphan-null';
      await insert(service._databases.files, {
        id,
        embedding: new Array(service._dimension).fill(0),
        path: '/y/orphan.txt',
        name: 'orphan.txt',
        category: 'document'
      });

      // Corrupt the embedding to reproduce the failure mode.
      const stored = await getByID(service._databases.files, id);
      stored.embedding = null;

      const result = await service.markEmbeddingsOrphaned([id]);
      expect(result.marked).toBe(1);
      expect(result.failed).toBe(0);

      const after = await getByID(service._databases.files, id);
      expect(after.isOrphaned).toBe(true);
      expect(typeof after.orphanedAt).toBe('string');
      expect(Array.isArray(after.embedding)).toBe(true);
    });
  });
});
