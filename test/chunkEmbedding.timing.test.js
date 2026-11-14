/**
 * @jest-environment node
 *
 * embedFileChunks logs how many passages it embedded and how long that took,
 * as a '[CHUNK-TIMING]' line with the extension only (no file name).
 */

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../src/shared/logger', () => ({ createLogger: () => mockLogger }));

const { embedFileChunks } = require('../src/main/analysis/chunkEmbedding');

const TEXT = Array.from({ length: 80 }, (_, i) => `Sentence ${i} of a long export. `).join('');

describe('chunkEmbedding timing', () => {
  beforeEach(() => jest.clearAllMocks());

  test('logs the passage count and embedding time', async () => {
    const embedText = jest.fn(async () => ({ vector: [1, 2, 3], model: 'm' }));
    const result = await embedFileChunks({
      fileId: 'file:/docs/client-report.pdf',
      filePath: '/docs/client-report.pdf',
      extractedText: TEXT,
      embedText,
      vectorDb: {
        deleteFileChunks: jest.fn().mockResolvedValue(0),
        batchUpsertFileChunks: jest.fn(async (p) => p.length)
      },
      loadSettings: async () => ({ autoChunkOnAnalysis: true, experienceMode: 'advanced' })
    });

    const line = mockLogger.info.mock.calls.find(([msg]) => msg === '[CHUNK-TIMING]');
    expect(line).toBeDefined();
    expect(line[1]).toEqual({
      ext: '.pdf',
      chunks: result.persisted,
      embedMs: expect.any(Number)
    });
    expect(line[1].chunks).toBe(embedText.mock.calls.length);
    expect(JSON.stringify(line[1])).not.toContain('client-report');
  });
});
