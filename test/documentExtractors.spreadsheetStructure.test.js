/**
 * @jest-environment node
 *
 * Spreadsheet and CSV exports reach the model with their structure: each
 * sheet's name and a marked row of column names. CSV delimiters (comma,
 * semicolon, tab) are detected, and UTF-16 text without a byte-order mark
 * (common in Bing and Excel "Unicode text" exports) is decoded.
 * Real files in a temp dir; synthetic content only.
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

const {
  extractTextFromCsv,
  extractTextFromXlsxRaw,
  decodeTextBuffer
} = require('../src/main/analysis/documentExtractors');

/** UTF-16 big-endian bytes for a string (Node has no 'utf16be' encoding). */
function utf16be(text) {
  return Buffer.from(text, 'utf16le').swap16();
}

describe('spreadsheet and CSV structure', () => {
  let tmpDir;
  let n = 0;
  const write = (name, data) => {
    n += 1;
    const file = path.join(tmpDir, `${n}-${name}`);
    fsSync.writeFileSync(file, data);
    return file;
  };

  beforeAll(() => {
    tmpDir = fsSync.mkdtempSync(
      path.join(jest.requireActual('os').tmpdir(), 'stratosort-sheet-structure-')
    );
  });

  afterAll(() => {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('XLSX', () => {
    // xlsx-populate is mapped to test/mocks/xlsx.js; hand it workbooks with
    // the shape extractTextFromXlsx reads (cells() when available, else value()).
    const XlsxPopulate = require('xlsx-populate');
    const cellsSheet = (name, rows) => ({
      name: () => name,
      usedRange: () => ({
        value: () => rows,
        cells: () => rows.map((row) => row.map((v) => ({ value: () => v })))
      })
    });
    const valuesSheet = (name, rows) => ({
      name: () => name,
      usedRange: () => ({ value: () => rows })
    });
    const workbookOf = (...sheets) => ({ sheets: () => sheets });

    test('each sheet is named and its first row marked as columns', async () => {
      XlsxPopulate.fromFileAsync.mockResolvedValueOnce(
        workbookOf(
          cellsSheet('Queries', [
            ['Top queries', 'Clicks'],
            ['seo tool', 12]
          ]),
          valuesSheet('Countries', [
            ['Country', 'Clicks'],
            ['Austria', 3]
          ])
        )
      );
      const file = write('gsc-export.xlsx', 'placeholder');

      const text = await extractTextFromXlsxRaw(file);

      expect(text).toContain('## Sheet: Queries\nColumns: Top queries | Clicks\nseo tool 12');
      expect(text).toContain('## Sheet: Countries\nColumns: Country | Clicks\nAustria 3');
    });

    test('a sheet that starts with numbers gets its name but no columns line', async () => {
      XlsxPopulate.fromFileAsync.mockResolvedValueOnce(
        workbookOf(
          cellsSheet('Numbers', [
            [1, 2],
            [3, 4]
          ])
        )
      );
      const file = write('numbers.xlsx', 'placeholder');

      const text = await extractTextFromXlsxRaw(file);

      expect(text).toBe('## Sheet: Numbers\n1 2\n3 4');
    });

    test('an over-long or multi-line sheet name is cut to one line', async () => {
      XlsxPopulate.fromFileAsync.mockResolvedValueOnce(
        workbookOf(valuesSheet(`Long\nname ${'x'.repeat(200)}`, [['a', 'b']]))
      );
      const file = write('long-name.xlsx', 'placeholder');

      const text = await extractTextFromXlsxRaw(file);
      const heading = text.split('\n')[0];

      expect(heading.startsWith('## Sheet: Long name xx')).toBe(true);
      expect(heading.length).toBe('## Sheet: '.length + 80);
    });
  });

  describe('CSV', () => {
    test('a semicolon CSV is split on semicolons and its header marked', async () => {
      const file = write('bing.csv', 'Query;Clicks;CTR\nfoo;12;3,5%\n');
      const text = await extractTextFromCsv(file);
      const lines = text.split('\n');
      expect(lines[0]).toBe('Columns: Query | Clicks | CTR');
      expect(lines[1]).toBe('foo 12 3,5%');
    });

    test('a tab-separated CSV is split on tabs', async () => {
      const file = write('tabs.csv', 'Keyword\tImpressions\tPosition\nseo\t1,200\t4.5\n');
      const text = await extractTextFromCsv(file);
      expect(text.split('\n')).toEqual([
        'Columns: Keyword | Impressions | Position',
        'seo 1,200 4.5'
      ]);
    });

    test('a comma inside quotes does not make the file comma-separated', async () => {
      const file = write('quoted.csv', '"Page, title";Clicks\n"Home, main";5\n');
      const text = await extractTextFromCsv(file);
      expect(text.split('\n')[0]).toBe('Columns: Page, title | Clicks');
    });

    test('a CSV whose first row is numbers gets no columns line', async () => {
      const file = write('numeric.csv', '1,2\n3,4\n');
      const text = await extractTextFromCsv(file);
      expect(text).toBe('1 2\n3 4');
    });

    test('UTF-16 LE without a byte-order mark is decoded', async () => {
      const file = write('le-nobom.csv', Buffer.from('a,b\n1,2\n', 'utf16le'));
      const text = await extractTextFromCsv(file);
      expect(text).toContain('Columns: a | b');
      expect(text).not.toContain('\u0000');
    });

    test('UTF-16 LE with a byte-order mark and tabs (Excel "Unicode text")', async () => {
      const body = Buffer.from('Query\tClicks\nseo\t7\n', 'utf16le');
      const file = write('le-bom.csv', Buffer.concat([Buffer.from([0xff, 0xfe]), body]));
      const text = await extractTextFromCsv(file);
      expect(text.split('\n')).toEqual(['Columns: Query | Clicks', 'seo 7']);
    });

    test('UTF-16 BE with and without a byte-order mark', async () => {
      const body = utf16be('Query;Clicks\nseo;7\n');
      const withBom = write('be-bom.csv', Buffer.concat([Buffer.from([0xfe, 0xff]), body]));
      const noBom = write('be-nobom.csv', utf16be('Query;Clicks\nseo;7\n'));
      for (const file of [withBom, noBom]) {
        const text = await extractTextFromCsv(file);
        expect(text.split('\n')).toEqual(['Columns: Query | Clicks', 'seo 7']);
      }
    });

    test('UTF-8 with a byte-order mark', async () => {
      const file = write(
        'utf8-bom.csv',
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Größe,Wert\nä,1\n', 'utf8')])
      );
      const text = await extractTextFromCsv(file);
      expect(text.split('\n')).toEqual(['Columns: Größe | Wert', 'ä 1']);
    });
  });

  describe('decodeTextBuffer', () => {
    test('plain UTF-8 and Latin text are not mistaken for UTF-16', async () => {
      expect(await decodeTextBuffer(Buffer.from('hello, world', 'utf8'))).toBe('hello, world');
      expect(await decodeTextBuffer(Buffer.from('ab'))).toBe('ab');
    });

    test('UTF-16 LE without a byte-order mark', async () => {
      expect(await decodeTextBuffer(Buffer.from('Clicks,Impressions', 'utf16le'))).toBe(
        'Clicks,Impressions'
      );
    });

    test('UTF-16 BE without a byte-order mark', async () => {
      expect(await decodeTextBuffer(utf16be('Clicks,Impressions'))).toBe('Clicks,Impressions');
    });
  });
});
