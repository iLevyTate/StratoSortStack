/**
 * @jest-environment node
 *
 * extractTextFromCsv honours a byte cap: a CSV over the user's text size
 * limit is read from its head only (never loaded whole), and the row cut in
 * half by the cap is dropped rather than analyzed as a corrupt record.
 * Real files in a temp dir; synthetic content only.
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const fsSync = require('fs');
const os = require('os');
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

jest.mock('../src/main/analysis/analysisLimits', () => ({
  getAnalysisLimits: jest.fn().mockResolvedValue({
    maxFileSize: 100 * 1024 * 1024,
    maxImageFileSize: 100 * 1024 * 1024,
    maxDocumentFileSize: 100 * 1024 * 1024
  }),
  getDefaultLimits: jest.fn().mockReturnValue({
    maxFileSize: 100 * 1024 * 1024,
    maxImageFileSize: 100 * 1024 * 1024,
    maxDocumentFileSize: 100 * 1024 * 1024
  }),
  invalidateCache: jest.fn()
}));

const fs = require('fs').promises;
const { extractTextFromCsv } = require('../src/main/analysis/documentExtractors');

describe('extractTextFromCsv byte cap', () => {
  let tmpDir;
  let csvPath;

  beforeAll(() => {
    tmpDir = fsSync.mkdtempSync(
      path.join(jest.requireActual('os').tmpdir(), 'stratosort-csv-head-')
    );
    csvPath = path.join(tmpDir, 'ledger.csv');
    const rows = ['id,name,amount'];
    for (let i = 1; i <= 200; i += 1) rows.push(`${i},item${i},${i * 10}`);
    fsSync.writeFileSync(csvPath, `${rows.join('\n')}\n`, 'utf8');
  });

  afterAll(() => {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('reads only the head of the file and never the whole of it', async () => {
    const readFileSpy = jest.spyOn(fs, 'readFile');
    const openSpy = jest.spyOn(fs, 'open');

    // 64 bytes: the header plus a few rows, ending part-way through a row.
    const text = await extractTextFromCsv(csvPath, { maxBytes: 64 });

    expect(readFileSpy.mock.calls.map(([target]) => target)).not.toContain(csvPath);
    expect(openSpy.mock.calls.map(([target]) => target)).toContain(csvPath);
    expect(text).toContain('Columns: id | name | amount');
    expect(text).not.toContain('item200');
    // The header is rewritten as a "Columns:" line; the data rows after it
    // must still come from the 64-byte head.
    const dataRows = text.split('\n').slice(1).join('\n');
    expect(Buffer.byteLength(dataRows, 'utf8')).toBeLessThanOrEqual(64 - 'id,name,amount\n'.length);
  });

  test('drops the row the cap cut in half', async () => {
    const head = fsSync.readFileSync(csvPath, 'utf8').slice(0, 64);
    const lastNewline = head.lastIndexOf('\n');
    // Precondition: the cap really does land mid-row.
    expect(lastNewline).toBeLessThan(63);
    const completeRows = head.slice(0, lastNewline).split('\n').length;

    const text = await extractTextFromCsv(csvPath, { maxBytes: 64 });

    expect(text.split('\n')).toHaveLength(completeRows);
    const lastRow = text.split('\n').pop();
    // Every kept data row has all three cells.
    expect(lastRow.split(' ')).toHaveLength(3);
  });

  test('a file within the cap is read in full', async () => {
    const text = await extractTextFromCsv(csvPath, { maxBytes: 1024 * 1024 });

    expect(text).toContain('200 item200 2000');
    expect(text.split('\n')).toHaveLength(201);
  });

  test('no cap keeps the whole-file read', async () => {
    const text = await extractTextFromCsv(csvPath);

    expect(text).toContain('200 item200 2000');
  });
});
