/**
 * _getAllFileDocuments / _getAllFolderDocuments used to start with
 * persist(db). Its default 'binary' format returns an encoded string, never
 * the `{ docs: { docs } }` object the code looked for, so every call encoded
 * the whole collection (vector index included) on the main thread and threw
 * the result away before falling back to paged search. They now read Orama's
 * docs store directly.
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
// for real so the docs store has its real shape.
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

const TEMP_DIR = path.join(__dirname, 'temp-orama-read-all-docs-test');

const { app } = require('electron');
const { persist } = require('@orama/plugin-data-persistence');
const { OramaVectorService } = require('../src/main/services/OramaVectorService');

const vec = (/** @type {number} */ seed) =>
  Array.from({ length: 768 }, (_, i) => Math.sin(seed * 31 + i));

describe('OramaVectorService reads every document from the docs store', () => {
  /** @type {any} */
  let service;

  beforeAll(async () => {
    await fs.mkdir(TEMP_DIR, { recursive: true }).catch(() => {});
  });

  afterAll(async () => {
    await fs.rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    /** @type {any} */ (app.getPath).mockReturnValue(TEMP_DIR);
    service = new OramaVectorService();
    await service.initialize();
  });

  afterEach(async () => {
    await service.cleanup();
  });

  test('files: no full persist() export, every doc returned with its vector, as copies', async () => {
    await service.batchUpsertFiles([
      { id: 'file:A', vector: vec(1), meta: { path: '/lib/A.pdf', fileName: 'A.pdf' } },
      { id: 'file:B', vector: vec(2), meta: { path: '/lib/B.pdf', fileName: 'B.pdf' } }
    ]);
    /** @type {any} */ (persist).mockClear();

    const docs = await service._getAllFileDocuments();

    expect(persist).not.toHaveBeenCalled();
    expect(docs.map((/** @type {any} */ d) => d.id).sort()).toEqual(['file:A', 'file:B']);
    // The store's docs keep their vectors (the paged-search fallback nulls them on its copies).
    expect(docs.every((/** @type {any} */ d) => Array.isArray(d.embedding))).toBe(true);

    // A caller changing a returned doc must not change the stored one.
    docs[0].fileName = 'changed.pdf';
    const again = await service._getAllFileDocuments();
    expect(again.find((/** @type {any} */ d) => d.id === docs[0].id).fileName).not.toBe(
      'changed.pdf'
    );
  });

  test('folders: no full persist() export, every folder returned', async () => {
    await service.upsertFolder({
      id: 'folder:Finance',
      vector: vec(3),
      meta: { path: '/lib/Finance', name: 'Finance' }
    });
    /** @type {any} */ (persist).mockClear();

    const docs = await service._getAllFolderDocuments();

    expect(persist).not.toHaveBeenCalled();
    expect(docs.map((/** @type {any} */ d) => d.id)).toEqual(['folder:Finance']);
    expect(docs[0].folderName).toBe('Finance');
  });
});
