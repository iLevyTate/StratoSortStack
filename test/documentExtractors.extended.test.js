const fs = require('fs').promises;
const documentExtractors = require('../src/main/analysis/documentExtractors');
const { LIMITS } = require('../src/shared/constants');

// Mock external dependencies
jest.mock('fs', () => {
  const originalFs = jest.requireActual('fs');
  return {
    ...originalFs,
    promises: {
      readFile: jest.fn(),
      stat: jest.fn(),
      access: jest.fn(),
      open: jest.fn()
    }
  };
});

jest.mock('fast-xml-parser', () => ({
  XMLParser: jest.fn().mockImplementation(() => ({
    parse: jest.fn((xml) => {
      if (xml.includes('error')) throw new Error('Parse error');
      return { root: { text: 'parsed content' } };
    })
  }))
}));

jest.mock('csv-parse/sync', () => ({
  parse: jest.fn()
}));

jest.mock('xlsx-populate', () => ({
  fromFileAsync: jest.fn()
}));

jest.mock('mammoth', () => ({
  extractRawText: jest.fn()
}));

jest.mock('../src/main/utils/tesseractUtils', () => ({
  isTesseractAvailable: jest.fn().mockResolvedValue(true),
  recognizeIfAvailable: jest.fn().mockResolvedValue({ success: true, text: 'OCR text from image' })
}));

jest.mock('sharp', () => {
  const sharpMock = jest.fn(() => ({
    metadata: jest.fn().mockResolvedValue({ width: 1200, height: 800 }),
    resize: jest.fn().mockReturnThis(),
    png: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.from('png data'))
  }));
  return sharpMock;
});

jest.mock('officeparser', () => ({
  parseOfficeAsync: jest.fn()
}));

jest.mock('adm-zip', () => {
  return jest.fn().mockImplementation(() => ({
    getEntries: jest.fn().mockReturnValue([]),
    getEntry: jest.fn().mockReturnValue(null)
  }));
});

jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

// Mock analysisLimits so checkFileSize uses a known limit (100MB)
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

describe('Document Extractors Extended', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default stat size to be small
    fs.stat.mockResolvedValue({ size: 1000 });
  });

  describe('extractTextFromDocx - OCR fallback', () => {
    const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);

    const mockSignature = async () => {
      const handle = {
        read: jest.fn().mockImplementation(async (buffer, offset, length) => {
          ZIP_SIGNATURE.copy(buffer, offset, 0, length);
          return { bytesRead: length, buffer };
        }),
        close: jest.fn().mockResolvedValue()
      };
      fs.open.mockResolvedValue(handle);
      return handle;
    };

    test('extracts text from embedded images when text is empty', async () => {
      const mammoth = require('mammoth');
      const officeParser = require('officeparser');
      const { recognizeIfAvailable } = require('../src/main/utils/tesseractUtils');
      const AdmZip = require('adm-zip');

      mammoth.extractRawText.mockResolvedValue({ value: '' });
      officeParser.parseOfficeAsync.mockResolvedValue('');
      recognizeIfAvailable.mockResolvedValue({ success: true, text: 'OCR text from image' });
      await mockSignature();

      AdmZip.mockImplementation(() => ({
        getEntries: () => [
          { entryName: 'word/media/image1.png', getData: () => Buffer.from('image') }
        ]
      }));

      const result = await documentExtractors.extractTextFromDocx('doc.docx');
      expect(result).toContain('OCR text from image');
      expect(recognizeIfAvailable).toHaveBeenCalled();
    });
  });

  describe('extractTextFromPptx - OCR fallback', () => {
    test('extracts text from embedded images when slides are empty', async () => {
      const officeParser = require('officeparser');
      const { recognizeIfAvailable } = require('../src/main/utils/tesseractUtils');
      const AdmZip = require('adm-zip');

      officeParser.parseOfficeAsync.mockResolvedValue('');
      recognizeIfAvailable.mockResolvedValue({ success: true, text: 'Slide OCR text' });

      AdmZip.mockImplementation(() => ({
        getEntries: () => [
          { entryName: 'ppt/media/slide1.png', getData: () => Buffer.from('image') }
        ]
      }));

      const result = await documentExtractors.extractTextFromPptx('slides.pptx');
      expect(result).toContain('Slide OCR text');
      expect(recognizeIfAvailable).toHaveBeenCalled();
    });

    test('processes embedded image OCR with bounded concurrency', async () => {
      const officeParser = require('officeparser');
      const { recognizeIfAvailable } = require('../src/main/utils/tesseractUtils');
      const AdmZip = require('adm-zip');

      officeParser.parseOfficeAsync.mockResolvedValue('');
      const resolvers = [];
      recognizeIfAvailable.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvers.push(resolve);
          })
      );

      AdmZip.mockImplementation(() => ({
        getEntries: () => [
          { entryName: 'ppt/media/slide1.png', getData: () => Buffer.from('image1') },
          { entryName: 'ppt/media/slide2.png', getData: () => Buffer.from('image2') },
          { entryName: 'ppt/media/slide3.png', getData: () => Buffer.from('image3') }
        ]
      }));

      const extractionPromise = documentExtractors.extractTextFromPptx('slides.pptx');
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(recognizeIfAvailable).toHaveBeenCalledTimes(2);

      resolvers.shift()({ success: true, text: 'page one' });
      resolvers.shift()({ success: true, text: 'page two' });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(recognizeIfAvailable).toHaveBeenCalledTimes(3);

      resolvers.shift()({ success: true, text: 'page three' });
      const result = await extractionPromise;

      expect(result).toContain('page one');
      expect(result).toContain('page two');
      expect(result).toContain('page three');
    });
  });

  describe('extractTextFromCsv', () => {
    const { parse } = require('csv-parse/sync');

    test('parses structured CSV content', async () => {
      fs.readFile.mockResolvedValue('col1,col2\nval1,val2');
      parse.mockReturnValue([
        ['col1', 'col2'],
        ['val1', 'val2']
      ]);

      const result = await documentExtractors.extractTextFromCsv('data.csv');

      expect(result).toContain('col1 col2');
      expect(result).toContain('val1 val2');
    });

    test('handles empty CSV', async () => {
      fs.readFile.mockResolvedValue('');
      parse.mockReturnValue([]);

      const result = await documentExtractors.extractTextFromCsv('empty.csv');
      expect(result).toBe('');
    });

    test('falls back to raw text on parse error', async () => {
      fs.readFile.mockResolvedValue('raw content');
      parse.mockImplementation(() => {
        throw new Error('Parse error');
      });

      const result = await documentExtractors.extractTextFromCsv('bad.csv');
      expect(result).toBe('raw content');
    });
  });

  describe('extractTextFromXlsx', () => {
    const XLSX = require('xlsx-populate');
    const officeParser = require('officeparser');
    const AdmZip = require('adm-zip');

    test('extracts text from valid workbook', async () => {
      const mockSheet = {
        name: () => 'Sheet1',
        usedRange: () => ({
          value: () => [
            ['Head1', 'Head2'],
            ['Val1', 'Val2']
          ]
        })
      };

      XLSX.fromFileAsync.mockResolvedValue({
        sheets: () => [mockSheet]
      });

      const result = await documentExtractors.extractTextFromXlsx('test.xlsx');
      expect(result).toContain('Head1 Head2');
      expect(result).toContain('Val1 Val2');
    });

    test('uses officeParser fallback when primary method fails', async () => {
      // Mock successful load but empty content to trigger fallback
      XLSX.fromFileAsync.mockResolvedValue({
        sheets: () => [{ usedRange: () => ({ value: () => [] }) }]
      });
      officeParser.parseOfficeAsync.mockResolvedValue('Fallback content');

      const result = await documentExtractors.extractTextFromXlsx('encrypted.xlsx');
      expect(result).toBe('Fallback content');
    });

    test('handles sheets with no used range', async () => {
      const mockSheet = {
        name: () => 'Empty',
        usedRange: () => null // No range
      };
      XLSX.fromFileAsync.mockResolvedValue({
        sheets: () => [mockSheet]
      });

      // Should fall back to officeParser since no content found
      officeParser.parseOfficeAsync.mockResolvedValue('Fallback');

      const result = await documentExtractors.extractTextFromXlsx('empty.xlsx');
      expect(result).toBe('Fallback');
    });

    test('uses ZIP fallback when XLSX parsers crash', async () => {
      XLSX.fromFileAsync.mockRejectedValue(
        new TypeError("Cannot read properties of null (reading 'children')")
      );
      officeParser.parseOfficeAsync.mockRejectedValue(
        new TypeError("Cannot read properties of null (reading 'children')")
      );

      const mockZip = {
        getEntries: jest.fn().mockReturnValue([
          {
            entryName: 'xl/sharedStrings.xml',
            header: { size: 256 },
            getData: () =>
              Buffer.from('<sst><si><t>Budget</t></si><si><t>Total</t></si></sst>', 'utf8')
          },
          {
            entryName: 'xl/worksheets/sheet1.xml',
            header: { size: 512 },
            getData: () =>
              Buffer.from(
                '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>123</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>',
                'utf8'
              )
          }
        ])
      };
      AdmZip.mockImplementation(() => mockZip);

      const result = await documentExtractors.extractTextFromXlsx('broken.xlsx');
      expect(result).toContain('Budget');
      expect(result).toContain('Total');
      expect(result).toContain('123');

      // ZIP fallback succeeded, so officeParser should not be invoked.
      expect(officeParser.parseOfficeAsync).not.toHaveBeenCalled();
    });
  });

  describe('extractTextFromPptx', () => {
    const officeParser = require('officeparser');
    const AdmZip = require('adm-zip');

    test('extracts text using officeParser', async () => {
      officeParser.parseOfficeAsync.mockResolvedValue('Slide content');

      const result = await documentExtractors.extractTextFromPptx('pres.pptx');
      expect(result).toBe('Slide content');
    });

    test('falls back to ZIP extraction if officeParser returns empty', async () => {
      officeParser.parseOfficeAsync.mockResolvedValue('');

      // Mock ZIP behavior
      const mockZip = {
        getEntries: jest
          .fn()
          .mockReturnValue([
            { entryName: 'ppt/slides/slide1.xml', getData: () => Buffer.from('<p>Slide 1</p>') }
          ])
      };
      AdmZip.mockImplementation(() => mockZip);

      const result = await documentExtractors.extractTextFromPptx('pres.pptx');
      expect(result).toContain('Slide 1');
    });

    test('handles JSON result from officeParser', async () => {
      officeParser.parseOfficeAsync.mockResolvedValue({ text: 'Structured content' });

      const result = await documentExtractors.extractTextFromPptx('pres.pptx');
      expect(result).toBe('Structured content');
    });
  });

  describe('Regex Cleaning Utilities', () => {
    test('extractPlainTextFromRtf cleans RTF', async () => {
      const rtf = '{\\rtf1\\ansi Hello \\b World\\b0}';
      const result = await documentExtractors.extractPlainTextFromRtf(rtf);
      // Regex is simple, might leave some artifacts but should remove control words
      // Based on implementation: replaces rtfControlWords (/\\[a-zA-Z]+-?\d* ?/g)
      expect(result).not.toContain('\\rtf1');
      expect(result).not.toContain('\\b');
    });

    test('extractPlainTextFromHtml removes tags and scripts', async () => {
      const html = '<html><script>alert(1)</script><body><p>Hello</p></body></html>';
      const result = await documentExtractors.extractPlainTextFromHtml(html);
      expect(result).not.toContain('alert(1)');
      expect(result).not.toContain('<p>');
      expect(result).toContain('Hello');
    });
  });

  describe('checkFileSize', () => {
    test('throws if file too large', async () => {
      fs.stat.mockResolvedValue({ size: LIMITS.MAX_FILE_SIZE + 1 });

      try {
        await documentExtractors.extractTextFromPdf('huge.pdf', 'huge.pdf');
        fail('Should have thrown');
      } catch (error) {
        expect(error.code).toBe('FILE_TOO_LARGE');
      }
    });
  });
});
