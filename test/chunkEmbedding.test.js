/**
 * @jest-environment node
 */

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })
}));

const { embedFileChunks, buildFileChunkPayloads } = require('../src/main/analysis/chunkEmbedding');
const { CHUNKING } = require('../src/shared/performanceConstants');

const LONG_TEXT = Array.from({ length: 60 }, (_, i) => `Sentence ${i} of a long document. `).join(
  ''
);

function makeStore() {
  return {
    deleteFileChunks: jest.fn().mockResolvedValue(0),
    batchUpsertFileChunks: jest.fn(async (payloads) => payloads.length)
  };
}

const embedText = jest.fn(async (text) => ({ vector: [text.length, 1, 2], model: 'test-model' }));

describe('chunkEmbedding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('builds one payload per chunk with the shared id and meta shape', async () => {
    const { payloads, aborted } = await buildFileChunkPayloads({
      fileId: 'file:/docs/a.pdf',
      filePath: '/docs/a.pdf',
      text: LONG_TEXT,
      embedText
    });

    expect(aborted).toBe(false);
    expect(payloads.length).toBeGreaterThan(1);
    expect(payloads.length).toBeLessThanOrEqual(CHUNKING.MAX_CHUNKS);
    expect(payloads[0]).toMatchObject({
      id: 'chunk:file:/docs/a.pdf:0',
      model: 'test-model',
      meta: expect.objectContaining({
        fileId: 'file:/docs/a.pdf',
        path: '/docs/a.pdf',
        name: 'a.pdf',
        chunkIndex: 0,
        startOffset: 0,
        model: 'test-model'
      })
    });
    expect(payloads[0].document).toBe(payloads[0].meta.snippet);
    expect(payloads[1].id).toBe('chunk:file:/docs/a.pdf:1');
  });

  test('persists chunks, replacing the old ones only after the new set exists', async () => {
    const vectorDb = makeStore();
    const order = [];
    vectorDb.deleteFileChunks.mockImplementation(async () => order.push('delete'));
    vectorDb.batchUpsertFileChunks.mockImplementation(async (p) => {
      order.push('upsert');
      return p.length;
    });

    const result = await embedFileChunks({
      fileId: 'file:/docs/a.pdf',
      filePath: '/docs/a.pdf',
      extractedText: LONG_TEXT,
      embedText,
      vectorDb,
      loadSettings: async () => ({ autoChunkOnAnalysis: true, experienceMode: 'advanced' })
    });

    expect(result.skipped).toBeNull();
    expect(result.persisted).toBeGreaterThan(1);
    expect(order).toEqual(['delete', 'upsert']);
    expect(vectorDb.deleteFileChunks).toHaveBeenCalledWith('file:/docs/a.pdf');
  });

  test('does nothing when the resolved setting is off', async () => {
    const vectorDb = makeStore();
    const result = await embedFileChunks({
      fileId: 'file:/docs/a.pdf',
      filePath: '/docs/a.pdf',
      extractedText: LONG_TEXT,
      embedText,
      vectorDb,
      loadSettings: async () => ({ autoChunkOnAnalysis: false, experienceMode: 'advanced' })
    });

    expect(result).toEqual({ persisted: 0, skipped: 'disabled' });
    expect(embedText).not.toHaveBeenCalled();
    expect(vectorDb.batchUpsertFileChunks).not.toHaveBeenCalled();
  });

  test('Simple mode forces chunking on even when the raw setting says off', async () => {
    const vectorDb = makeStore();
    const result = await embedFileChunks({
      fileId: 'file:/docs/a.pdf',
      filePath: '/docs/a.pdf',
      extractedText: LONG_TEXT,
      embedText,
      vectorDb,
      loadSettings: async () => ({ autoChunkOnAnalysis: false, experienceMode: 'simple' })
    });

    expect(result.skipped).toBeNull();
    expect(vectorDb.batchUpsertFileChunks).toHaveBeenCalled();
  });

  test('skips short text without touching the store', async () => {
    const vectorDb = makeStore();
    const result = await embedFileChunks({
      fileId: 'file:/docs/a.pdf',
      filePath: '/docs/a.pdf',
      extractedText: 'too short',
      embedText,
      vectorDb,
      loadSettings: async () => ({})
    });

    expect(result).toEqual({ persisted: 0, skipped: 'short_text' });
    expect(vectorDb.deleteFileChunks).not.toHaveBeenCalled();
  });

  test('keeps the old chunks when every embedding fails', async () => {
    const vectorDb = makeStore();
    const result = await embedFileChunks({
      fileId: 'file:/docs/a.pdf',
      filePath: '/docs/a.pdf',
      extractedText: LONG_TEXT,
      embedText: jest.fn().mockRejectedValue(new Error('model not loaded')),
      vectorDb,
      loadSettings: async () => ({})
    });

    expect(result).toEqual({ persisted: 0, skipped: 'no_embeddings' });
    expect(vectorDb.deleteFileChunks).not.toHaveBeenCalled();
    expect(vectorDb.batchUpsertFileChunks).not.toHaveBeenCalled();
  });

  test('an abort mid-way leaves the store untouched', async () => {
    const vectorDb = makeStore();
    const controller = new AbortController();
    const abortingEmbed = jest.fn(async (text) => {
      controller.abort();
      return { vector: [text.length], model: 'm' };
    });

    const result = await embedFileChunks({
      fileId: 'file:/docs/a.pdf',
      filePath: '/docs/a.pdf',
      extractedText: LONG_TEXT,
      embedText: abortingEmbed,
      vectorDb,
      loadSettings: async () => ({}),
      signal: controller.signal
    });

    expect(result).toEqual({ persisted: 0, skipped: 'aborted' });
    expect(abortingEmbed).toHaveBeenCalledTimes(1);
    expect(vectorDb.batchUpsertFileChunks).not.toHaveBeenCalled();
  });

  test('a store failure is reported, not thrown', async () => {
    const vectorDb = makeStore();
    vectorDb.batchUpsertFileChunks.mockRejectedValue(new Error('disk full'));

    const result = await embedFileChunks({
      fileId: 'file:/docs/a.pdf',
      filePath: '/docs/a.pdf',
      extractedText: LONG_TEXT,
      embedText,
      vectorDb,
      loadSettings: async () => ({})
    });

    expect(result).toEqual({ persisted: 0, skipped: 'error' });
  });
});
