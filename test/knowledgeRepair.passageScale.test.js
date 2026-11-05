/**
 * Startup passage repair at library scale, against the REAL Orama chunk
 * collection (its string `where` filter is token-based, not exact, which is
 * what made a per-file passage lookup page through every chunk in the store).
 *
 *  - Pass 1 reads passage health for the whole library in one scan, with the
 *    same answer per file as describeFileChunks.
 *  - Passage repair asks the embedding gate first: a file kept out of the
 *    local index gets no passages.
 *  - Passage repair never shrinks an existing set: broken rows are re-embedded
 *    in place from their own text, not rebuilt from the capped history copy.
 */

jest.mock('electron', () => ({ app: { getPath: jest.fn(() => 'C:/tmp') } }));

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })
}));

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
  }),
  getLlamaService: jest.fn(() => null)
}));

jest.mock('../src/main/services/SettingsService', () => ({
  getInstance: () => ({ load: async () => ({}) })
}));

// The real gate by default (no settings service registered = shipped
// defaults); single tests override it to stand in for global settings.
const mockShouldEmbed = jest.fn();
jest.mock('../src/main/services/embedding/embeddingGate', () => ({
  shouldEmbed: (...args) => mockShouldEmbed(...args)
}));

const { create, insert, count } = require('@orama/orama');
const { OramaVectorService } = require('../src/main/services/OramaVectorService');
const {
  repairKnowledge,
  repairStoredPassages
} = require('../src/main/services/embedding/knowledgeRepair');
const { getSemanticFileId } = require('../src/shared/fileIdUtils');

const realGate = jest.requireActual('../src/main/services/embedding/embeddingGate');

// Real-looking paths: the shared `file:` prefix and path segments are what
// make Orama's string filter match other files' chunks.
const DIR = 'C:\\Users\\tester\\Documents\\';
const pathOf = (name) => `${DIR}${name}`;
const idOf = (name) => getSemanticFileId(pathOf(name));
const ZERO = { count: 0, placeholderCount: 0, missingVectorCount: 0 };

async function makeService() {
  const db = await create({
    schema: {
      id: 'string',
      embedding: 'vector[3]',
      fileId: 'string',
      chunkIndex: 'number',
      content: 'string',
      startOffset: 'number',
      endOffset: 'number'
    }
  });
  const service = new OramaVectorService();
  service.initialize = jest.fn().mockResolvedValue();
  service._schedulePersist = jest.fn();
  service._emitSearchDataMutated = jest.fn();
  service._dimension = 3;
  service._databases.fileChunks = db;
  service.getFile = jest.fn(async (id) => ({ id, isOrphaned: false, hasVector: true }));
  service.hasUsableVector = jest.fn(async () => true);
  return { service, db };
}

/**
 * Write chunk rows for one file. 'ok' has a real vector in the sidecar,
 * 'placeholder' an all-zero one, 'missing' none (what a restore leaves).
 * @param {OramaVectorService} service
 * @param {string} fileId
 * @param {Array<'ok'|'placeholder'|'missing'>} states
 */
async function addChunks(service, fileId, states) {
  const store = service._chunkVectorStore();
  for (let i = 0; i < states.length; i++) {
    const id = `chunk:${fileId}:${i}`;
    await insert(service._databases.fileChunks, {
      id,
      embedding: states[i] === 'placeholder' ? [0, 0, 0] : [1, 0, 0],
      fileId,
      chunkIndex: i,
      content: `passage ${i} of ${fileId}`,
      startOffset: i * 800,
      endOffset: i * 800 + 1000
    });
    if (states[i] === 'ok') store.set(id, [0.5, 0.5, 0.5]);
    if (states[i] === 'placeholder') store.set(id, [0, 0, 0]);
  }
}

const entryFor = (name, extra = {}) => ({
  originalPath: pathOf(name),
  analysis: { summary: 's', extractedText: `${name} `.repeat(60) },
  ...extra
});

beforeEach(() => {
  mockShouldEmbed.mockReset().mockImplementation(realGate.shouldEmbed);
});

describe('describeAllFileChunks', () => {
  test('gives every file the same answer as describeFileChunks', async () => {
    const { service } = await makeService();
    await addChunks(service, idOf('a.pdf'), ['ok', 'ok', 'ok']);
    await addChunks(service, idOf('b.pdf'), ['ok', 'placeholder', 'missing']);
    await addChunks(service, idOf('c.pdf'), ['missing', 'missing']);

    const all = await service.describeAllFileChunks();

    expect(all.get(idOf('b.pdf'))).toEqual({
      count: 3,
      placeholderCount: 1,
      missingVectorCount: 1
    });
    for (const name of ['a.pdf', 'b.pdf', 'c.pdf', 'never-chunked.pdf']) {
      const single = await service.describeFileChunks(idOf(name));
      expect(all.get(idOf(name)) || ZERO).toEqual(single);
    }
  });

  test('reads the chunk collection once, however many files it holds', async () => {
    const { service } = await makeService();
    for (let i = 0; i < 8; i++) await addChunks(service, idOf(`f${i}.pdf`), ['ok', 'missing']);
    const scan = jest.spyOn(service, '_paginatedSearch');

    const all = await service.describeAllFileChunks();

    expect(all.size).toBe(8);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  test('describeFileChunks can list the broken rows with their own text', async () => {
    const { service } = await makeService();
    await addChunks(service, idOf('b.pdf'), ['ok', 'placeholder', 'missing']);

    const described = await service.describeFileChunks(idOf('b.pdf'), { includeUnusable: true });

    expect(described).toEqual(
      expect.objectContaining({ count: 3, placeholderCount: 1, missingVectorCount: 1 })
    );
    expect(described.unusable.map((row) => row.chunkIndex).sort()).toEqual([1, 2]);
    expect(described.unusable[0]).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^chunk:/),
        content: expect.stringContaining('passage'),
        startOffset: expect.any(Number),
        endOffset: expect.any(Number)
      })
    );
  });
});

describe('repairKnowledge pass 1 at scale', () => {
  test('one scan of the chunk collection for the whole library, same verdicts', async () => {
    const { service } = await makeService();
    const names = Array.from({ length: 12 }, (_, i) => `doc${i}.pdf`);
    for (const name of names) await addChunks(service, idOf(name), ['ok', 'ok']);
    await addChunks(service, idOf('broken.pdf'), ['ok', 'placeholder']);
    const entries = Object.fromEntries(
      [...names, 'broken.pdf', 'unbuilt.pdf'].map((name) => [name, entryFor(name)])
    );
    const repairPassages = jest.fn(async () => ({ action: 'repaired' }));
    const scan = jest.spyOn(service, '_paginatedSearch');

    const result = await repairKnowledge({
      entries,
      vectorDb: service,
      embedEntry: jest.fn(async () => ({ action: 'enqueued' })),
      repairPassages,
      fileExists: jest.fn(async () => true)
    });

    expect(scan).toHaveBeenCalledTimes(1);
    expect(repairPassages.mock.calls.map(([args]) => args.filePath).sort()).toEqual([
      pathOf('broken.pdf'),
      pathOf('unbuilt.pdf')
    ]);
    expect(result).toEqual(expect.objectContaining({ healthy: 12, passages: 2 }));
  });

  test('falls back to one lookup per file when the bulk read fails', async () => {
    const vectorDb = {
      getFile: jest.fn(async (id) => ({ id, hasVector: true })),
      hasUsableVector: jest.fn(async () => true),
      describeAllFileChunks: jest.fn(async () => null),
      describeFileChunks: jest.fn(async () => ({ ...ZERO }))
    };
    const repairPassages = jest.fn(async () => ({ action: 'repaired' }));

    const result = await repairKnowledge({
      entries: { a: entryFor('a.pdf'), b: entryFor('b.pdf') },
      vectorDb,
      embedEntry: jest.fn(),
      repairPassages,
      fileExists: jest.fn(async () => true)
    });

    expect(vectorDb.describeAllFileChunks).toHaveBeenCalledTimes(1);
    expect(vectorDb.describeFileChunks).toHaveBeenCalledTimes(2);
    expect(result.passages).toBe(2);
  });
});

describe('passage repair respects the embedding gate', () => {
  const embedText = () => jest.fn(async () => ({ vector: [0.1, 0.2, 0.3], model: 'm' }));

  test("a file set to 'skip' gets no passages, even with none stored", async () => {
    const { service } = await makeService();
    const embed = embedText();
    const result = await repairKnowledge({
      entries: { s: entryFor('secret.pdf', { embedding: { policy: 'skip' } }) },
      vectorDb: service,
      embedEntry: jest.fn(),
      repairPassages: ({ entry, filePath }) =>
        repairStoredPassages({ entry, filePath, embedText: embed, vectorDb: service }),
      fileExists: jest.fn(async () => true)
    });

    expect(embed).not.toHaveBeenCalled();
    expect(await count(service._databases.fileChunks)).toBe(0);
    expect(result.passages).toBe(0);
  });

  test("a file set to 'web_only' is refused by the gate itself", async () => {
    const { service } = await makeService();
    const embed = embedText();
    const result = await repairStoredPassages({
      entry: entryFor('web.pdf', { embedding: { policy: 'web_only' } }),
      filePath: pathOf('web.pdf'),
      embedText: embed,
      vectorDb: service
    });

    expect(result.action).toBe('skipped');
    expect(embed).not.toHaveBeenCalled();
    expect(await count(service._databases.fileChunks)).toBe(0);
  });

  test('a global gate that says no (manual timing) builds nothing', async () => {
    mockShouldEmbed.mockResolvedValue({ shouldEmbed: false, timing: 'manual', policy: 'embed' });
    const { service } = await makeService();
    const embed = embedText();
    const result = await repairStoredPassages({
      entry: entryFor('m.pdf'),
      filePath: pathOf('m.pdf'),
      embedText: embed,
      vectorDb: service,
      isInSmartFolder: true
    });

    expect(result).toEqual({ action: 'skipped', reason: 'disabled:manual:embed' });
    expect(mockShouldEmbed).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'analysis', isInSmartFolder: true })
    );
    expect(embed).not.toHaveBeenCalled();
    expect(await count(service._databases.fileChunks)).toBe(0);
  });

  test('a file the gate allows and that has no passages gets them from its stored text', async () => {
    const { service } = await makeService();
    const embed = embedText();
    const result = await repairStoredPassages({
      entry: entryFor('new.pdf'),
      filePath: pathOf('new.pdf'),
      embedText: embed,
      vectorDb: service
    });

    expect(result).toEqual({ action: 'repaired' });
    const described = await service.describeFileChunks(idOf('new.pdf'));
    expect(described.count).toBeGreaterThan(0);
    expect(described).toEqual(
      expect.objectContaining({ placeholderCount: 0, missingVectorCount: 0 })
    );
  });
});

describe('passage repair never shrinks an existing set', () => {
  test('re-embeds only the broken rows, in place, from their own text', async () => {
    const { service, db } = await makeService();
    const longId = idOf('long.pdf');
    // Six passages built from the full text; the history copy below is short
    // (like the 50k cap) and would only yield one passage.
    await addChunks(service, longId, ['ok', 'ok', 'placeholder', 'ok', 'missing', 'ok']);
    await addChunks(service, idOf('other.pdf'), ['ok', 'ok']);
    const embed = jest.fn(async () => ({ vector: [0.1, 0.2, 0.3], model: 'm' }));
    const deleteSpy = jest.spyOn(service, 'deleteFileChunks');

    const result = await repairStoredPassages({
      entry: { analysis: { extractedText: 'w'.repeat(300) } },
      filePath: pathOf('long.pdf'),
      embedText: embed,
      vectorDb: service
    });

    expect(result).toEqual({ action: 'repaired' });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(embed.mock.calls.map(([text]) => text).sort()).toEqual([
      `passage 2 of ${longId}`,
      `passage 4 of ${longId}`
    ]);
    expect(await service.describeFileChunks(longId)).toEqual({
      count: 6,
      placeholderCount: 0,
      missingVectorCount: 0
    });
    const chunks = await service.getChunksForFile(longId);
    expect(chunks.map((c) => c.text)).toEqual(
      [0, 1, 2, 3, 4, 5].map((i) => `passage ${i} of ${longId}`)
    );
    expect(await count(db)).toBe(8);
  });

  test('a set that is healthy by the time it is repaired is left alone', async () => {
    const { service } = await makeService();
    await addChunks(service, idOf('fine.pdf'), ['ok', 'ok', 'ok']);
    const embed = jest.fn(async () => ({ vector: [0.1, 0.2, 0.3], model: 'm' }));

    const result = await repairStoredPassages({
      entry: { analysis: { extractedText: 'v'.repeat(300) } },
      filePath: pathOf('fine.pdf'),
      embedText: embed,
      vectorDb: service
    });

    expect(result).toEqual({ action: 'skipped', reason: 'already-healthy' });
    expect(embed).not.toHaveBeenCalled();
    expect((await service.describeFileChunks(idOf('fine.pdf'))).count).toBe(3);
  });
});
