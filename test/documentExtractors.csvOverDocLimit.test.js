/**
 * @jest-environment node
 *
 * A CSV over the text size limit is read from its head (maxBytes). The
 * document size limit (maxDocumentFileSize) guards whole-file reads, so it
 * must not reject a capped read: a 300 MB export used to fail with
 * FILE_TOO_LARGE before the head read ran, while a .log of the same size was
 * analyzed from its head. Real files in a temp dir; synthetic content only.
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const fsSync = require('fs');
const path = require('path');

jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  };
  return { createLogger: jest.fn(() => logger), logger };
});

// A document limit far below the file size stands in for a 300 MB CSV
// against the default 200 MB limit.
const TINY_LIMIT = 256;
jest.mock('../src/main/analysis/analysisLimits', () => ({
  getAnalysisLimits: jest.fn().mockResolvedValue({
    maxFileSize: 256,
    maxImageFileSize: 256,
    maxDocumentFileSize: 256
  }),
  getDefaultLimits: jest.fn().mockReturnValue({
    maxFileSize: 256,
    maxImageFileSize: 256,
    maxDocumentFileSize: 256
  }),
  invalidateCache: jest.fn()
}));

const { extractTextFromCsv } = require('../src/main/analysis/documentExtractors');

describe('extractTextFromCsv over the document size limit', () => {
  let tmpDir;
  let csvPath;

  beforeAll(() => {
    tmpDir = fsSync.mkdtempSync(
      path.join(jest.requireActual('os').tmpdir(), 'stratosort-csv-doclimit-')
    );
    csvPath = path.join(tmpDir, 'export.csv');
    const rows = ['id,name,amount'];
    for (let i = 1; i <= 200; i += 1) rows.push(`${i},item${i},${i * 10}`);
    fsSync.writeFileSync(csvPath, `${rows.join('\n')}\n`, 'utf8');
    expect(fsSync.statSync(csvPath).size).toBeGreaterThan(TINY_LIMIT);
  });

  afterAll(() => {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a capped read returns the head instead of FILE_TOO_LARGE', async () => {
    const text = await extractTextFromCsv(csvPath, { maxBytes: 64 });
    expect(text).toContain('Columns: id | name | amount');
    expect(text).toContain('item1');
    expect(text).not.toContain('item200');
  });

  test('an uncapped read still enforces the document size limit', async () => {
    await expect(extractTextFromCsv(csvPath)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  test('a capped read of a missing file still reports FILE_READ_ERROR', async () => {
    await expect(
      extractTextFromCsv(path.join(tmpDir, 'missing.csv'), { maxBytes: 64 })
    ).rejects.toMatchObject({ code: 'FILE_READ_ERROR' });
  });
});
