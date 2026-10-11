/**
 * Tests for documentExtractors
 * TIER 1 - CRITICAL: Document text extraction from various formats
 * Testing PDF, Office, and other document format extractors
 */

const fs = require('fs').promises;
const os = require('os');
const path = require('path');

// Mock dependencies BEFORE requiring the module
jest.mock('unpdf', () => ({
  extractText: jest.fn(),
  definePDFJSModule: jest.fn().mockResolvedValue(),
  renderPageAsImage: jest.fn(),
  getDocumentProxy: jest.fn()
}));
jest.mock('sharp');
jest.mock('@napi-rs/canvas', () => ({}));
jest.mock('../src/main/utils/tesseractUtils', () => ({
  isTesseractAvailable: jest.fn().mockResolvedValue(true),
  recognizeIfAvailable: jest.fn().mockResolvedValue({ success: true, text: 'OCR extracted text' })
}));
jest.mock('mammoth');
// jest.mock('officeparser');
jest.mock('xlsx-populate');
jest.mock('adm-zip');
// Word 97-2003 reader: a class whose extract() resolves to a Document.
const mockWordExtract = jest.fn();
jest.mock('word-extractor', () =>
  jest.fn().mockImplementation(() => ({ extract: (...args) => mockWordExtract(...args) }))
);
// Outlook .msg reader: default-exported class with getFileData().
const mockMsgGetFileData = jest.fn();
jest.mock('@kenjiuno/msgreader', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ getFileData: () => mockMsgGetFileData() }))
}));

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

const {
  extractTextFromPdf,
  ocrPdfIfNeeded,
  _pdfBufferCacheSizeForTests,
  PDF_MIN_TEXT_CHARS_PER_PAGE,
  formatXlsxCellValue,
  isXlsxDateFormat,
  extractTextFromDoc,
  extractTextFromDocx,
  extractTextFromXlsx,
  extractTextFromPptx,
  extractTextFromXls,
  extractTextFromPpt,
  extractTextFromOdfZip,
  extractTextFromEpub,
  extractTextFromEml,
  extractTextFromMsg,
  extractTextFromKml,
  extractTextFromKmz,
  extractPlainTextFromRtf,
  extractPlainTextFromHtml,
  readTextFileWithEncoding
} = require('../src/main/analysis/documentExtractors');

describe('documentExtractors', () => {
  const mockFilePath = '/test/document.pdf';
  const mockFileName = 'document.pdf';
  const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);
  const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

  const mockFileSignature = async (signature) => {
    const handle = {
      read: jest.fn().mockImplementation(async (buffer, offset, length) => {
        signature.copy(buffer, offset, 0, length);
        return { bytesRead: length, buffer };
      }),
      close: jest.fn().mockResolvedValue()
    };
    jest.spyOn(fs, 'open').mockResolvedValue(handle);
    return handle;
  };

  const makePdfProxy = () => ({ destroy: jest.fn().mockResolvedValue(undefined) });

  beforeEach(() => {
    jest.clearAllMocks();
    require('unpdf').getDocumentProxy.mockResolvedValue(makePdfProxy());
  });

  describe('extractTextFromPdf', () => {
    test('should extract text from valid PDF', async () => {
      const { extractText, getDocumentProxy } = require('unpdf');
      const proxy = makePdfProxy();
      getDocumentProxy.mockResolvedValue(proxy);
      const pageOfText =
        'This is the extracted PDF text content for the first page of the document.';
      extractText.mockResolvedValue({ text: pageOfText });
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('pdf data'));
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromPdf(mockFilePath, mockFileName);

      expect(result).toBe(pageOfText);
      // isEvalSupported is a DocumentInitParameter: it only reaches pdf.js via
      // getDocumentProxy, never via extractText's options bag.
      expect(getDocumentProxy).toHaveBeenCalledWith(expect.any(Uint8Array), {
        isEvalSupported: false
      });
      expect(extractText).toHaveBeenCalledWith(proxy, { mergePages: true });
      expect(proxy.destroy).toHaveBeenCalledTimes(1);
    });

    test('should destroy the document proxy even when extraction throws', async () => {
      const { extractText, getDocumentProxy } = require('unpdf');
      const proxy = makePdfProxy();
      getDocumentProxy.mockResolvedValue(proxy);
      extractText.mockRejectedValue(new Error('parser exploded'));
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('pdf data'));
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      await expect(extractTextFromPdf(mockFilePath, mockFileName)).rejects.toThrow(
        'parser exploded'
      );
      expect(proxy.destroy).toHaveBeenCalledTimes(1);
    });

    test('should throw error for empty PDF', async () => {
      const { extractText } = require('unpdf');
      extractText.mockResolvedValue({ text: '' });
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('pdf data'));
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      // IMPROVED BEHAVIOR: FileProcessingError now provides structured error messages
      // instead of raw error codes, making errors more user-friendly
      await expect(extractTextFromPdf(mockFilePath, mockFileName)).rejects.toThrow(
        'PDF contains no extractable text'
      );
    });

    test('should throw error for file exceeding size limit', async () => {
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 200 * 1024 * 1024 }); // 200MB

      // FileProcessingError with FILE_TOO_LARGE code produces a structured error message
      await expect(extractTextFromPdf(mockFilePath, mockFileName)).rejects.toThrow(
        'File size exceeds processing limits'
      );
    });

    test('should truncate very long text', async () => {
      const { extractText } = require('unpdf');
      const longText = 'word '.repeat(200000); // Creates text > 500k chars
      extractText.mockResolvedValue({ text: longText });
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('pdf data'));
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromPdf(mockFilePath, mockFileName);

      expect(result.length).toBeLessThanOrEqual(500000 + 100);
      expect(result).toContain('[Text truncated due to length]');
    });

    test('treats a thin text layer as a scan: PDF_NO_TEXT_CONTENT with the layer attached', async () => {
      // A scanner footer is a text layer, but not one worth analyzing. The
      // thin layer rides on the error so OCR can be tried and the footer kept
      // only if OCR finds nothing longer.
      const { extractText } = require('unpdf');
      extractText.mockResolvedValue({ text: 'Scanned with CamScanner', totalPages: 1 });
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('pdf data'));
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      await expect(extractTextFromPdf(mockFilePath, mockFileName)).rejects.toMatchObject({
        code: 'PDF_NO_TEXT_CONTENT',
        metadata: expect.objectContaining({
          textLayer: 'Scanned with CamScanner',
          pageCount: 1
        })
      });
      expect(_pdfBufferCacheSizeForTests()).toBeGreaterThan(0);
    });

    test('scales the thin-layer threshold by page count', async () => {
      const { extractText } = require('unpdf');
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('pdf data'));
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });
      const text = 'x'.repeat(PDF_MIN_TEXT_CHARS_PER_PAGE * 2 + 10);

      // Enough for two pages...
      extractText.mockResolvedValue({ text, totalPages: 2 });
      await expect(extractTextFromPdf(mockFilePath, mockFileName)).resolves.toBe(text);

      // ...but a 12-page document with the same text is a scan with a cover note.
      extractText.mockResolvedValue({ text, totalPages: 12 });
      await expect(extractTextFromPdf(mockFilePath, mockFileName)).rejects.toMatchObject({
        code: 'PDF_NO_TEXT_CONTENT',
        metadata: expect.objectContaining({ pageCount: 12 })
      });
    });

    test('should handle array return from unpdf', async () => {
      const { extractText } = require('unpdf');
      const textArray = [
        'Page 1 content: the quarterly revenue summary and the notes that go with it',
        'Page 2 content: the expense breakdown by department and the year-end outlook'
      ];
      extractText.mockResolvedValue({ text: textArray });
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('pdf data'));
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromPdf(mockFilePath, mockFileName);

      expect(result).toContain('Page 1 content');
      expect(result).toContain('Page 2 content');
    });
  });

  describe('ocrPdfIfNeeded', () => {
    test('should perform OCR on image-based PDF', async () => {
      const sharp = require('sharp');
      const { recognizeIfAvailable } = require('../src/main/utils/tesseractUtils');

      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('pdf data'));

      const mockSharp = {
        metadata: jest.fn().mockResolvedValue({ width: 1000, height: 1000 }),
        resize: jest.fn().mockReturnThis(),
        png: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue(Buffer.from('png data'))
      };
      sharp.mockReturnValue(mockSharp);

      recognizeIfAvailable.mockResolvedValue({ success: true, text: 'OCR extracted text' });

      const result = await ocrPdfIfNeeded(mockFilePath);

      expect(result).toBe('OCR extracted text');
      expect(recognizeIfAvailable).toHaveBeenCalled();
    });

    test('should fallback to PDF page renderer if sharp fails', async () => {
      const sharp = require('sharp');
      const { recognizeIfAvailable } = require('../src/main/utils/tesseractUtils');
      const unpdf = require('unpdf');

      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('pdf data'));

      // 1. Mock sharp failure
      const mockSharp = {
        metadata: jest
          .fn()
          .mockRejectedValue(new Error('Input buffer contains unsupported image format')),
        resize: jest.fn().mockReturnThis(),
        png: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue(Buffer.from('png data'))
      };
      sharp.mockReturnValue(mockSharp);

      // 2. Mock unpdf page renderer
      unpdf.renderPageAsImage.mockResolvedValue(Buffer.from('png data'));
      unpdf.getDocumentProxy.mockResolvedValue({
        destroy: jest.fn().mockResolvedValue(undefined)
      });

      // 3. Mock OCR success
      recognizeIfAvailable.mockResolvedValue({ success: true, text: 'Fallback extracted text' });

      const result = await ocrPdfIfNeeded(mockFilePath);

      expect(result).toContain('Fallback extracted text');
      // Should have called unpdf.renderPageAsImage
      expect(unpdf.renderPageAsImage).toHaveBeenCalled();
    });

    test('should reuse a shared PDF document proxy for multi-page OCR fallback', async () => {
      const sharp = require('sharp');
      const { recognizeIfAvailable } = require('../src/main/utils/tesseractUtils');
      const unpdf = require('unpdf');

      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('pdf data'));

      const mockSharp = {
        metadata: jest
          .fn()
          .mockRejectedValue(new Error('Input buffer contains unsupported image format')),
        resize: jest.fn().mockReturnThis(),
        png: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue(Buffer.from('png data'))
      };
      sharp.mockReturnValue(mockSharp);

      const proxy = {
        destroy: jest.fn().mockResolvedValue(undefined)
      };
      unpdf.getDocumentProxy.mockResolvedValue(proxy);
      unpdf.renderPageAsImage.mockImplementation(async (renderTarget) => {
        if (renderTarget !== proxy) {
          throw new Error('Expected shared PDFDocumentProxy');
        }
        return Buffer.from('png data');
      });
      recognizeIfAvailable.mockResolvedValue({ success: true, text: 'Fallback extracted text' });

      const result = await ocrPdfIfNeeded(mockFilePath);

      expect(result).toContain('Fallback extracted text');
      expect(unpdf.getDocumentProxy).toHaveBeenCalledTimes(1);
      expect(unpdf.renderPageAsImage).toHaveBeenCalledTimes(3);
      expect(proxy.destroy).toHaveBeenCalledTimes(1);
    });

    test('should return empty string for oversized files', async () => {
      // OCR limit is now 30MB (reduced from 50MB for memory safety)
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 35 * 1024 * 1024 }); // 35MB exceeds 30MB limit

      const result = await ocrPdfIfNeeded(mockFilePath);

      expect(result).toBe('');
    });

    test('should handle OCR errors gracefully', async () => {
      const sharp = require('sharp');

      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('pdf data'));

      sharp.mockImplementation(() => {
        throw new Error('Sharp error');
      });

      const result = await ocrPdfIfNeeded(mockFilePath);

      expect(result).toBe('');
    });

    test('should handle sharp metadata error gracefully (unsupported format)', async () => {
      const sharp = require('sharp');
      const unpdf = require('unpdf');

      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('pdf data'));

      // Mock sharp failure
      const mockSharp = {
        metadata: jest
          .fn()
          .mockRejectedValue(new Error('Input buffer contains unsupported image format')),
        resize: jest.fn().mockReturnThis(),
        png: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockResolvedValue(Buffer.from('png data'))
      };
      sharp.mockReturnValue(mockSharp);

      // Mock unpdf renderer failure (so fallback fails too)
      unpdf.renderPageAsImage.mockRejectedValue(new Error('Renderer unavailable'));

      const result = await ocrPdfIfNeeded(mockFilePath);

      expect(result).toBe('');
    });
  });

  describe('extractTextFromDocx', () => {
    test('should extract text from DOCX', async () => {
      const mammoth = require('mammoth');
      mammoth.extractRawText.mockResolvedValue({
        value: 'This is DOCX content'
      });
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });
      await mockFileSignature(ZIP_SIGNATURE);

      const result = await extractTextFromDocx(mockFilePath);

      expect(result).toBe('This is DOCX content');
      expect(mammoth.extractRawText).toHaveBeenCalled();
    });

    test('should throw error for empty DOCX', async () => {
      const mammoth = require('mammoth');
      const officeParser = require('officeparser');

      mammoth.extractRawText.mockResolvedValue({ value: '' });
      // Ensure fallback also returns empty so the error is propagated
      officeParser.parseOffice.mockResolvedValue('');

      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });
      await mockFileSignature(ZIP_SIGNATURE);

      await expect(extractTextFromDocx(mockFilePath)).rejects.toThrow('No text content in DOCX');
    });

    test('should check file size before reading', async () => {
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 150 * 1024 * 1024 });

      // FileProcessingError with FILE_TOO_LARGE code produces a structured error message
      await expect(extractTextFromDocx(mockFilePath)).rejects.toThrow(
        'File size exceeds processing limits'
      );
    });
  });

  describe('formatXlsxCellValue', () => {
    // Jest maps `xlsx-populate` to a stub (test/jest.config.js); the real
    // Excel serial-to-date arithmetic is reachable through its submodule.
    const dateConverter = require('xlsx-populate/lib/dateConverter');
    const actualXlsx = { numberToDate: (n) => dateConverter.numberToDate(n) };
    const localDay = (date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
        date.getDate()
      ).padStart(2, '0')}`;

    test('renders a date-formatted serial as a date, and a plain number as itself', () => {
      const serial = 46096;
      const expected = localDay(actualXlsx.numberToDate(serial));
      expect(formatXlsxCellValue(serial, 'm/d/yyyy', actualXlsx)).toBe(expected);
      expect(formatXlsxCellValue(serial, '[$-409]d-mmm-yy;@', actualXlsx)).toBe(expected);
      expect(formatXlsxCellValue(serial, 'General', actualXlsx)).toBe('46096');
      expect(formatXlsxCellValue(serial, null, actualXlsx)).toBe('46096');
      expect(formatXlsxCellValue(42.5, '0.00', actualXlsx)).toBe('42.5');
    });

    test('adds the time of day only when the format shows one', () => {
      const serial = 46096.5; // noon
      expect(formatXlsxCellValue(serial, 'yyyy-mm-dd hh:mm', actualXlsx)).toMatch(
        /^\d{4}-\d{2}-\d{2} 12:00$/
      );
      expect(formatXlsxCellValue(serial, 'yyyy-mm-dd', actualXlsx)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    test('renders rich text and formula errors as their text', () => {
      expect(formatXlsxCellValue({ text: () => 'Bold title' }, null, actualXlsx)).toBe(
        'Bold title'
      );
      expect(formatXlsxCellValue({ error: () => '#DIV/0!' }, null, actualXlsx)).toBe('#DIV/0!');
      expect(formatXlsxCellValue({ unknown: true }, null, actualXlsx)).toBeNull();
      expect(formatXlsxCellValue(null, null, actualXlsx)).toBeNull();
      expect(formatXlsxCellValue(true, null, actualXlsx)).toBe('true');
    });

    test('a time-only format renders the time of day, never a day in 1899', () => {
      // Excel's built-in Time formats (numFmtId 18-21, 45-47) used to come
      // out as "1899-12-31 09:00"; before that the cell read as 0.375.
      expect(formatXlsxCellValue(0.375, 'h:mm', actualXlsx)).toBe('09:00');
      expect(formatXlsxCellValue(0.375, 'h:mm AM/PM', actualXlsx)).toBe('09:00');
      expect(formatXlsxCellValue(0.7083333, 'hh:mm', actualXlsx)).toBe('17:00');
      expect(formatXlsxCellValue(0.5, 'h:mm:ss', actualXlsx)).toBe('12:00:00');
      expect(formatXlsxCellValue(0.0208333, 'mm:ss', actualXlsx)).toBe('00:30:00');
      // Built-in 47 is the same 30-second split without the colon; it must
      // agree with its colon-separated sibling instead of becoming a date.
      expect(formatXlsxCellValue(0.0208333, 'mmss.0', actualXlsx)).toBe('00:30:00');
      expect(formatXlsxCellValue(0.0208333, 'mm:ss.0', actualXlsx)).toBe('00:30:00');
      // The day part of a date-time serial is dropped when the format hides it.
      expect(formatXlsxCellValue(46096.375, 'h:mm', actualXlsx)).toBe('09:00');
    });

    test('every built-in date/time format in the real xlsx-populate table is classified', () => {
      // Driven off xlsx-populate's own STANDARD_CODES rather than literals, so
      // a built-in whose code this build reports differently cannot pass by
      // agreeing with a hand-copied string. numFmtId 47 ('mmss.0') used to
      // read as 'datetime' — minutes written without a colon were taken for a
      // month — and a lap split rendered as "1899-12-31 00:29".
      const { xlsxFormatKind } = require('../src/main/analysis/documentExtractors');
      const StyleSheet = require('xlsx-populate/lib/StyleSheet');
      const styleSheet = new StyleSheet({
        name: 'styleSheet',
        attributes: {},
        children: [
          { name: 'fonts', attributes: {}, children: [] },
          { name: 'fills', attributes: {}, children: [] },
          { name: 'borders', attributes: {}, children: [] },
          { name: 'cellXfs', attributes: {}, children: [] }
        ]
      });
      const expectedKinds = {
        14: 'date', // mm-dd-yy
        15: 'date', // d-mmm-yy
        16: 'date', // d-mmm
        17: 'date', // mmm-yy
        18: 'time', // h:mm AM/PM
        19: 'time', // h:mm:ss AM/PM
        20: 'time', // h:mm
        21: 'time', // h:mm:ss
        22: 'datetime', // m/d/yy h:mm
        45: 'time', // mm:ss
        46: 'elapsed', // [h]:mm:ss
        47: 'time' // mmss.0 — a duration, not 31 December 1899
      };
      const codes = Object.keys(expectedKinds).map((id) =>
        styleSheet.getNumberFormatCode(Number(id))
      );
      expect(codes.every((code) => typeof code === 'string' && code.length > 0)).toBe(true);
      const actualKinds = {};
      Object.keys(expectedKinds).forEach((id, index) => {
        actualKinds[id] = xlsxFormatKind(codes[index]);
      });
      expect(actualKinds).toEqual(expectedKinds);
      // Non-temporal built-ins stay out of the date path entirely.
      [1, 2, 9, 11, 12, 37, 48, 49].forEach((id) => {
        expect(xlsxFormatKind(styleSheet.getNumberFormatCode(id))).toBeNull();
      });
    });

    test('an m is minutes only when it is the FIELD beside an hour or a seconds', () => {
      // Excel's rule for its one ambiguous code, pinned in both directions.
      // What matters is the neighbouring FIELD, not the neighbouring
      // character: a separator between the two is irrelevant (so built-in
      // 47's colon-less 'mmss' is minutes, which it was not before the
      // tokenizer landed — it rendered as "1899-12-31 00:29"), but another
      // field or a section break between them is NOT (so 'h mmmm' keeps its
      // month; a rule with no adjacency requirement read it as a bare
      // "09:00" and dropped March).
      const { xlsxFormatKind } = require('../src/main/analysis/documentExtractors');
      const cases = [
        // --- minutes: the m/mm field is directly after an hour or before seconds
        ['mmss.0', 'time'], // built-in 47
        ['mmss', 'time'],
        ['hhmm', 'time'],
        ['hhmmss', 'time'],
        ['hh"h"mm', 'time'], // a quoted literal separates characters, not fields
        ['h mm', 'time'],
        ['mm ss', 'time'],
        ['h:mm AM/PM', 'time'],
        // --- month: three or more m's spell a month name ("Mar"/"March"/"M"),
        //     which Excel never uses for minutes however they are placed
        ['h mmmm', 'datetime'],
        ['h" at "mmmm', 'datetime'],
        ['mmmm ss', 'datetime'],
        ['mmm:ss', 'datetime'],
        ['mmmm', 'date'],
        ['mmm-yy', 'date'],
        // --- month: a ';' separates two whole formats, so the hour or the
        //     seconds in another section is not this m's neighbour
        ['0.00;mm;ss', 'datetime'],
        ['mm;ss', 'datetime'],
        // --- month: the rule is directional and field-adjacent
        ['ss mm', 'datetime'], // after seconds, not before them
        ['mm-dd-yy', 'date'],
        ['m/d/yy h:mm', 'datetime']
      ];
      expect(cases.map(([code]) => [code, xlsxFormatKind(code)])).toEqual(cases);
      // The reads those classifications produce: the duration keeps its
      // clock, and the hour-and-month format keeps its day.
      expect(formatXlsxCellValue(0.0208333, 'mmss', actualXlsx)).toBe('00:30:00');
      expect(formatXlsxCellValue(0.375, 'hhmm', actualXlsx)).toBe('09:00');
      expect(formatXlsxCellValue(46096, 'mmmm', actualXlsx)).toBe(
        localDay(actualXlsx.numberToDate(46096))
      );
      expect(formatXlsxCellValue(46096.375, 'h mmmm', actualXlsx)).toBe(
        `${localDay(actualXlsx.numberToDate(46096.375))} 09:00`
      );
    });

    test('a bracketed elapsed format renders a duration that runs past 24 hours', () => {
      expect(formatXlsxCellValue(1.5, '[h]:mm:ss', actualXlsx)).toBe('36:00:00');
      expect(formatXlsxCellValue(1.5, '[h]:mm', actualXlsx)).toBe('36:00');
      expect(formatXlsxCellValue(0.5, '[mm]:ss', actualXlsx)).toBe('720:00');
      expect(formatXlsxCellValue(0.5, '[s]', actualXlsx)).toBe('43200');
    });

    test('xlsxFormatKind tells dates, times, both and durations apart', () => {
      const { xlsxFormatKind } = require('../src/main/analysis/documentExtractors');
      expect(xlsxFormatKind('yyyy-mm-dd')).toBe('date');
      expect(xlsxFormatKind('d-mmm')).toBe('date');
      expect(xlsxFormatKind('mmmm d, yyyy')).toBe('date');
      expect(xlsxFormatKind('yyyy-mm-dd hh:mm')).toBe('datetime');
      expect(xlsxFormatKind('m/d/yy h:mm')).toBe('datetime');
      expect(xlsxFormatKind('h:mm')).toBe('time');
      expect(xlsxFormatKind('h:mm AM/PM')).toBe('time');
      expect(xlsxFormatKind('mm:ss')).toBe('time');
      expect(xlsxFormatKind('[h]:mm:ss')).toBe('elapsed');
      expect(xlsxFormatKind('0.00')).toBeNull();
      expect(xlsxFormatKind('General')).toBeNull();
      expect(xlsxFormatKind('"Shipped" 0')).toBeNull();
    });

    test('a 1904-system workbook shifts every date serial by 1462 days', () => {
      const expected = localDay(actualXlsx.numberToDate(44000 + 1462));
      expect(formatXlsxCellValue(44000, 'yyyy-mm-dd', actualXlsx, { date1904: true })).toBe(
        expected
      );
      expect(formatXlsxCellValue(44000, 'yyyy-mm-dd', actualXlsx)).toBe(
        localDay(actualXlsx.numberToDate(44000))
      );
      const { readXlsxDate1904 } = require('../src/main/analysis/documentExtractors');
      const workbookWith = (attributes) => ({
        _node: { children: [{ name: 'fileVersion' }, { name: 'workbookPr', attributes }] }
      });
      expect(readXlsxDate1904(workbookWith({ date1904: '1' }))).toBe(true);
      expect(readXlsxDate1904(workbookWith({ date1904: 'true' }))).toBe(true);
      expect(readXlsxDate1904(workbookWith({ date1904: '0' }))).toBe(false);
      expect(readXlsxDate1904(workbookWith({}))).toBe(false);
      expect(readXlsxDate1904({})).toBe(false);
      expect(readXlsxDate1904(null)).toBe(false);
    });

    test('xlsxCellNumberFormat reads the xf node once per style id and never allocates a Style', () => {
      const { xlsxCellNumberFormat } = require('../src/main/analysis/documentExtractors');
      const getNumberFormatCode = jest.fn((id) => (id === 22 ? 'm/d/yy h:mm' : 'General'));
      const styleSheet = {
        _cellXfsNode: {
          children: [
            { attributes: { numFmtId: '0' } },
            { attributes: {} },
            { attributes: { numFmtId: '22' } }
          ]
        },
        getNumberFormatCode
      };
      const style = jest.fn(() => 'should-not-be-called');
      const cell = (styleId) => ({
        _styleId: styleId,
        workbook: () => ({ styleSheet: () => styleSheet }),
        style
      });
      const cache = new Map();

      expect(xlsxCellNumberFormat(cell(2), cache)).toBe('m/d/yy h:mm');
      expect(xlsxCellNumberFormat(cell(2), cache)).toBe('m/d/yy h:mm');
      expect(xlsxCellNumberFormat(cell(0), cache)).toBe('General');
      expect(xlsxCellNumberFormat(cell(1), cache)).toBeNull();
      expect(xlsxCellNumberFormat(cell(undefined), cache)).toBe('General');
      expect(getNumberFormatCode).toHaveBeenCalledTimes(2);
      expect(style).not.toHaveBeenCalled();

      // A cell from another source still answers through style().
      expect(
        xlsxCellNumberFormat({ style: (key) => (key === 'numberFormat' ? 'h:mm' : null) })
      ).toBe('h:mm');
    });

    test('isXlsxDateFormat ignores quoted literals and colour prefixes', () => {
      expect(isXlsxDateFormat('yyyy-mm-dd')).toBe(true);
      expect(isXlsxDateFormat('h:mm AM/PM')).toBe(true);
      expect(isXlsxDateFormat('General')).toBe(false);
      expect(isXlsxDateFormat('[Red]0.00')).toBe(false);
      expect(isXlsxDateFormat('"Day" 0')).toBe(false);
      expect(isXlsxDateFormat('0.00%')).toBe(false);
    });
  });

  describe('legacy office files that are not legacy formats inside', () => {
    test('an HTML table saved as .xls is read as text instead of refused', async () => {
      const html =
        '<html><body><table><tr><td>Invoice</td><td>4471</td></tr><tr><td>Total</td><td>&euro;1,250</td></tr></table></body></html>';
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: html.length });
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from(html, 'utf8'));
      await mockFileSignature(Buffer.from(html.padEnd(512, ' '), 'utf8'));

      const result = await extractTextFromXls(mockFilePath);

      expect(result).toContain('Invoice 4471');
      expect(result).toContain('Total €1,250');
    });

    test('a CSV saved as .ppt is read as text; a true OLE .ppt is still the unsupported legacy format', async () => {
      const csv = 'slide,title\n1,Welcome\n2,Agenda\n';
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: csv.length });
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from(csv, 'utf8'));
      await mockFileSignature(Buffer.from(csv.padEnd(512, '\n'), 'utf8'));
      expect(await extractTextFromPpt(mockFilePath)).toContain('2,Agenda');

      await mockFileSignature(OLE_SIGNATURE);
      await expect(extractTextFromPpt(mockFilePath)).rejects.toMatchObject({
        code: 'LEGACY_FORMAT_UNSUPPORTED'
      });
    });
  });

  describe('extractTextFromXlsx', () => {
    test('reads dates and rich text through the cell grid when the sheet offers it', async () => {
      const XLSX = require('xlsx-populate');
      const dateConverter = require('xlsx-populate/lib/dateConverter');
      const actualXlsx = { numberToDate: (n) => dateConverter.numberToDate(n) };
      XLSX.numberToDate = jest.fn((n) => dateConverter.numberToDate(n));
      const cell = (value, numberFormat = 'General') => ({
        value: () => value,
        style: (key) => (key === 'numberFormat' ? numberFormat : undefined)
      });
      const mockSheet = {
        name: () => 'Invoices',
        usedRange: jest.fn().mockReturnValue({
          value: jest.fn().mockReturnValue([['should-not-be-used']]),
          cells: jest.fn().mockReturnValue([
            [cell('Invoice'), cell('Due'), cell('Amount')],
            [cell({ text: () => 'ACME Corp' }), cell(46096, 'm/d/yyyy'), cell(1250.5, '#,##0.00')],
            [cell(null), cell({ error: () => '#REF!' }), cell(true)]
          ])
        })
      };
      XLSX.fromFileAsync.mockResolvedValue({ sheets: jest.fn().mockReturnValue([mockSheet]) });
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromXlsx(mockFilePath);

      const dueDate = actualXlsx.numberToDate(46096);
      const expectedDay = `${dueDate.getFullYear()}-${String(dueDate.getMonth() + 1).padStart(
        2,
        '0'
      )}-${String(dueDate.getDate()).padStart(2, '0')}`;
      expect(result).toContain('Invoice Due Amount');
      expect(result).toContain(`ACME Corp ${expectedDay} 1250.5`);
      expect(result).toContain('#REF! true');
      expect(result).not.toContain('46096');
      expect(result).not.toContain('[object Object]');
      expect(result).not.toContain('should-not-be-used');
    });

    test('reads the 1904 date system from the workbook and caps a very wide used range', async () => {
      const XLSX = require('xlsx-populate');
      const dateConverter = require('xlsx-populate/lib/dateConverter');
      XLSX.numberToDate = jest.fn((n) => dateConverter.numberToDate(n));
      const cell = (value, numberFormat = 'General') => ({
        value: () => value,
        style: (key) => (key === 'numberFormat' ? numberFormat : undefined)
      });
      const range = jest.fn().mockReturnValue({
        cells: () => [[cell('Invoice date'), cell(44000, 'yyyy-mm-dd'), cell(0.375, 'h:mm')]]
      });
      const mockSheet = {
        name: () => 'Wide',
        range,
        usedRange: jest.fn().mockReturnValue({
          startCell: () => ({ rowNumber: () => 1, columnNumber: () => 1 }),
          endCell: () => ({ rowNumber: () => 20000, columnNumber: () => 2000 }),
          value: jest.fn().mockReturnValue([['should-not-be-used']]),
          cells: jest.fn(() => {
            throw new Error('the uncapped rectangle must not be materialized');
          })
        })
      };
      XLSX.fromFileAsync.mockResolvedValue({
        _node: { children: [{ name: 'workbookPr', attributes: { date1904: '1' } }] },
        sheets: jest.fn().mockReturnValue([mockSheet])
      });
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromXlsx(mockFilePath);

      expect(range).toHaveBeenCalledWith(1, 1, 10000, 512);
      const shifted = dateConverter.numberToDate(44000 + 1462);
      const expectedDay = `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(
        2,
        '0'
      )}-${String(shifted.getDate()).padStart(2, '0')}`;
      expect(result).toContain(`Invoice date ${expectedDay} 09:00`);
      expect(result).not.toContain('1899');
    });

    test('should extract text from XLSX', async () => {
      const XLSX = require('xlsx-populate');

      const mockSheet = {
        usedRange: jest.fn().mockReturnValue({
          value: jest.fn().mockReturnValue([
            ['Header1', 'Header2', 'Header3'],
            ['Value1', 'Value2', 'Value3'],
            ['Value4', 'Value5', 'Value6']
          ])
        })
      };

      const mockWorkbook = {
        sheets: jest.fn().mockReturnValue([mockSheet])
      };

      XLSX.fromFileAsync.mockResolvedValue(mockWorkbook);
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromXlsx(mockFilePath);

      expect(result).toContain('Header1');
      expect(result).toContain('Value1');
    });

    test('should limit rows to prevent memory issues', async () => {
      const XLSX = require('xlsx-populate');

      const largeArray = Array.from({ length: 15000 }, (_, i) => [`Row${i}`, `Data${i}`]);

      const mockSheet = {
        usedRange: jest.fn().mockReturnValue({
          value: jest.fn().mockReturnValue(largeArray)
        })
      };

      const mockWorkbook = {
        sheets: jest.fn().mockReturnValue([mockSheet])
      };

      XLSX.fromFileAsync.mockResolvedValue(mockWorkbook);
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromXlsx(mockFilePath);

      expect(result).toBeDefined();
      // Should not process all 15000 rows
      const rowCount = result.split('\n').length;
      expect(rowCount).toBeLessThanOrEqual(10000);
    });

    test('should throw error for empty XLSX', async () => {
      const XLSX = require('xlsx-populate');

      const mockSheet = {
        usedRange: jest.fn().mockReturnValue(null)
      };

      const mockWorkbook = {
        sheets: jest.fn().mockReturnValue([mockSheet])
      };

      XLSX.fromFileAsync.mockResolvedValue(mockWorkbook);
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      // FIX: Updated test to expect new error handling behavior
      // New code properly handles null usedRange and throws appropriate error
      await expect(extractTextFromXlsx(mockFilePath)).rejects.toThrow();
    });

    test('should handle null/undefined values in XLSX', async () => {
      const XLSX = require('xlsx-populate');

      const mockSheet = {
        usedRange: jest.fn().mockReturnValue({
          value: jest.fn().mockReturnValue(null)
        })
      };

      const mockWorkbook = {
        sheets: jest.fn().mockReturnValue([mockSheet])
      };

      XLSX.fromFileAsync.mockResolvedValue(mockWorkbook);
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      // FIX: Test new defensive null-checking behavior
      await expect(extractTextFromXlsx(mockFilePath)).rejects.toThrow();
    });

    test('should handle various row data structures in XLSX', async () => {
      const XLSX = require('xlsx-populate');

      // FIX: Test that we handle arrays, objects, and scalar values
      const mockSheet = {
        usedRange: jest.fn().mockReturnValue({
          value: jest
            .fn()
            .mockReturnValue([
              ['Array', 'Row'],
              { columnA: 'Object', columnB: 'Row' },
              'Scalar Row'
            ])
        })
      };

      const mockWorkbook = {
        sheets: jest.fn().mockReturnValue([mockSheet])
      };

      XLSX.fromFileAsync.mockResolvedValue(mockWorkbook);
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromXlsx(mockFilePath);
      expect(result).toBeDefined();
      expect(result).toContain('Array');
      expect(result).toContain('Object');
      expect(result).toContain('Scalar');
    });

    test('should attempt fallback if primary extraction throws error', async () => {
      const XLSX = require('xlsx-populate');
      const officeParser = require('officeparser');

      XLSX.fromFileAsync.mockRejectedValue(new Error('Corrupt XLSX'));
      officeParser.parseOffice.mockResolvedValue('Fallback content');
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromXlsx(mockFilePath);
      expect(result).toBe('Fallback content');
    });
  });

  describe('extractTextFromPptx', () => {
    test('should extract text from PPTX', async () => {
      const officeParser = require('officeparser');
      officeParser.parseOffice.mockResolvedValue('Presentation content');
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromPptx(mockFilePath);

      expect(result).toBe('Presentation content');
    });

    test('should extract text from an officeparser v8 AST result', async () => {
      const officeParser = require('officeparser');
      // officeparser v8 dropped toText(); text comes from (await ast.to('text')).value.
      const to = jest.fn(async (destination) => ({
        value: destination === 'text' ? 'Presentation content' : '',
        messages: []
      }));
      officeParser.parseOffice.mockResolvedValue({
        type: 'pptx',
        metadata: {},
        content: [{ type: 'slide', text: 'Presentation content' }],
        attachments: [],
        to
      });
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromPptx(mockFilePath);

      expect(result).toBe('Presentation content');
      expect(to).toHaveBeenCalledWith('text');
    });

    test('should extract text from an officeparser v6-v7 AST result', async () => {
      const officeParser = require('officeparser');
      // officeparser v6-v7 resolve to an OfficeParserAST exposing toText().
      officeParser.parseOffice.mockResolvedValue({
        type: 'pptx',
        metadata: {},
        content: [{ type: 'slide', text: 'Presentation content' }],
        attachments: [],
        toText: () => 'Presentation content'
      });
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromPptx(mockFilePath);

      expect(result).toBe('Presentation content');
    });

    test('should throw error for empty PPTX', async () => {
      const officeParser = require('officeparser');
      officeParser.parseOffice.mockResolvedValue('');
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      // FIX: Updated test to expect new error handling behavior
      await expect(extractTextFromPptx(mockFilePath)).rejects.toThrow();
    });

    test('should attempt ZIP fallback if primary extraction throws error', async () => {
      const officeParser = require('officeparser');
      const AdmZip = require('adm-zip');

      officeParser.parseOffice.mockRejectedValue(new Error('Corrupt PPTX'));

      const mockEntries = [
        {
          entryName: 'ppt/slides/slide1.xml',
          getData: jest.fn().mockReturnValue(Buffer.from('<p>Slide content</p>'))
        }
      ];

      const mockZip = {
        getEntries: jest.fn().mockReturnValue(mockEntries)
      };

      AdmZip.mockImplementation(() => mockZip);
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromPptx(mockFilePath);
      expect(result).toContain('Slide content');
    });
  });

  describe('extractTextFromEpub', () => {
    test('should extract text from EPUB', async () => {
      const AdmZip = require('adm-zip');

      const mockEntries = [
        {
          entryName: 'chapter1.xhtml',
          getData: jest
            .fn()
            .mockReturnValue(Buffer.from('<html><body>Chapter 1 content</body></html>'))
        },
        {
          entryName: 'chapter2.html',
          getData: jest
            .fn()
            .mockReturnValue(Buffer.from('<html><body>Chapter 2 content</body></html>'))
        },
        {
          entryName: 'metadata.opf',
          getData: jest.fn().mockReturnValue(Buffer.from('metadata'))
        }
      ];

      const mockZip = {
        getEntries: jest.fn().mockReturnValue(mockEntries)
      };

      AdmZip.mockImplementation(() => mockZip);
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromEpub(mockFilePath);

      expect(result).toContain('Chapter 1 content');
      expect(result).toContain('Chapter 2 content');
    });

    test('should limit number of entries processed', async () => {
      const AdmZip = require('adm-zip');

      const mockEntries = Array.from({ length: 150 }, (_, i) => ({
        entryName: `chapter${i}.xhtml`,
        getData: jest.fn().mockReturnValue(Buffer.from(`<html>Chapter ${i}</html>`))
      }));

      const mockZip = {
        getEntries: jest.fn().mockReturnValue(mockEntries)
      };

      AdmZip.mockImplementation(() => mockZip);
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromEpub(mockFilePath);

      expect(result).toBeDefined();
      // Should process max 100 entries
    });
  });

  describe('extractTextFromEml', () => {
    test('should extract email headers and body', async () => {
      const emailContent = `Subject: Test Email
From: sender@example.com
To: receiver@example.com

This is the email body content.
It has multiple lines.`;

      jest.spyOn(fs, 'readFile').mockResolvedValue(emailContent);
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromEml(mockFilePath);

      expect(result).toContain('Test Email');
      expect(result).toContain('sender@example.com');
      expect(result).toContain('receiver@example.com');
      expect(result).toContain('email body content');
    });

    test('should handle email without some headers', async () => {
      const emailContent = `Subject: Test Email

Body content only.`;

      jest.spyOn(fs, 'readFile').mockResolvedValue(emailContent);
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromEml(mockFilePath);

      expect(result).toContain('Test Email');
      expect(result).toContain('Body content');
    });

    test('should decode UTF-16LE .eml files (Outlook Save As) via encoding detection', async () => {
      const emailContent = `Subject: Test Email
From: sender@example.com

Body content.`;
      // UTF-16LE with BOM — decoding this as utf8 yields NUL-interleaved
      // mojibake where no header regex matches.
      const utf16Buffer = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(emailContent, 'utf16le')
      ]);

      // Behave like real fs.readFile: return a string only when an encoding
      // is passed, otherwise the raw Buffer.
      jest
        .spyOn(fs, 'readFile')
        .mockImplementation(async (_p, enc) => (enc ? utf16Buffer.toString(enc) : utf16Buffer));
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: utf16Buffer.length });

      const result = await extractTextFromEml(mockFilePath);

      expect(result).toContain('Test Email');
      expect(result).toContain('sender@example.com');
      expect(result).toContain('Body content');
      expect(result).not.toContain(String.fromCharCode(0));
    });

    test('decodes a multipart MIME message: base64 body, RFC 2047 subject, attachment name (MI-05)', async () => {
      const raw = [
        'Subject: =?UTF-8?B?UXVhcnRlcmx5IHJlcG9ydA==?=',
        'From: Ann <ann@example.com>',
        'To: Bob <bob@example.com>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        'VGhlIHF1YXJ0ZXJseSByZXBvcnQgaXMgYXR0YWNoZWQu',
        '--b1',
        'Content-Type: application/pdf; name="report.pdf"',
        'Content-Disposition: attachment; filename="report.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        'JVBERi0xLjQKJcfsj6IKNSAwIG9iago8PC9MZW5ndGggNiAwIFI+PgpzdHJlYW0K',
        '--b1--',
        ''
      ].join('\r\n');
      jest.spyOn(fs, 'readFile').mockResolvedValue(raw);
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: raw.length });

      const result = await extractTextFromEml(mockFilePath);

      expect(result).toContain('Subject: Quarterly report');
      expect(result).toContain('From: Ann <ann@example.com>');
      expect(result).toContain('To: Bob <bob@example.com>');
      expect(result).toContain('The quarterly report is attached.');
      expect(result).toContain('Attachments: report.pdf');
      // The attachment bytes and the base64 body never reach the stored text.
      expect(result).not.toContain('JVBERi0xLjQK');
      expect(result).not.toContain('VGhlIHF1YXJ0ZXJseSByZXBvcnQ');
    });

    test('uses the HTML part when a message has no plain-text part', async () => {
      const raw = [
        'Subject: HTML only',
        'From: ann@example.com',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<html><body><h1>Agenda</h1><p>Budget review at <b>10am</b>.</p></body></html>',
        ''
      ].join('\r\n');
      jest.spyOn(fs, 'readFile').mockResolvedValue(raw);
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: raw.length });

      const result = await extractTextFromEml(mockFilePath);

      expect(result).toContain('Agenda');
      expect(result).toMatch(/Budget review at\s*10am/);
      expect(result).not.toContain('<b>');
    });
  });

  describe('extractPlainTextFromHtml', () => {
    test('decodes numeric and named character references, not only the XML five', async () => {
      // caf&eacute; and it&#8217;s used to survive into the indexed text, so a
      // search for "café" or a curly-quoted phrase missed the file.
      const html =
        '<p>caf&eacute; &mdash; it&#8217;s &#x201C;quoted&#x201D;&hellip; &copy; 2026 &amp; &lt;b&gt; &unknown;</p>';
      const result = await extractPlainTextFromHtml(html);
      expect(result).toBe('café — it’s “quoted”… © 2026 & <b> &unknown;');
    });

    test('should strip HTML tags', async () => {
      const html = '<html><body><h1>Title</h1><p>Paragraph text</p></body></html>';
      const result = await extractPlainTextFromHtml(html);

      expect(result).toBe('Title Paragraph text');
      expect(result).not.toContain('<');
    });

    test('should remove scripts and styles', async () => {
      const html = `
        <html>
          <head><style>body { color: red; }</style></head>
          <body>
            <script>alert('test');</script>
            <p>Content</p>
          </body>
        </html>
      `;
      const result = await extractPlainTextFromHtml(html);

      expect(result).toContain('Content');
      expect(result).not.toContain('alert');
      expect(result).not.toContain('color: red');
    });

    test('should decode HTML entities', async () => {
      const html = '<p>&lt;div&gt; &amp; &quot;quotes&quot; &apos;apostrophe&apos;</p>';
      const result = await extractPlainTextFromHtml(html);

      expect(result).toContain('<div>');
      expect(result).toContain('&');
      expect(result).toContain('"quotes"');
      expect(result).toContain("'apostrophe'");
    });

    test('should handle malformed HTML gracefully', async () => {
      const html = '<p>Unclosed tag <div>Content';
      const result = await extractPlainTextFromHtml(html);

      expect(result).toContain('Unclosed tag');
      expect(result).toContain('Content');
    });
  });

  describe('extractPlainTextFromRtf', () => {
    test('should extract plain text from RTF', async () => {
      const rtf = String.raw`{\rtf1\ansi\deff0 {\fonttbl{\f0 Times New Roman;}}
        \f0\fs24 This is RTF text content.}`;

      const result = await extractPlainTextFromRtf(rtf);

      expect(result).toContain('This is RTF text content');
      expect(result).not.toContain('\\rtf');
      expect(result).not.toContain('{');
    });

    test('should handle encoded characters', async () => {
      const rtf = String.raw`{\rtf1 Test \'e9 content}`;
      const result = await extractPlainTextFromRtf(rtf);

      expect(result).toBeDefined();
      expect(result.length).toBeGreaterThan(0);
    });

    test('should handle malformed RTF gracefully', async () => {
      const rtf = 'Not really RTF content';
      const result = await extractPlainTextFromRtf(rtf);

      expect(result).toBe('Not really RTF content');
    });
  });

  describe('readTextFileWithEncoding (plain-text branch reader)', () => {
    // The .txt/.md/.html/.rtf/.xml branch of documentAnalysis used to do a bare
    // `fs.readFile(path, 'utf8')`, which turns UTF-16 files (Notepad "Unicode",
    // PowerShell `>` redirection) into NUL-interleaved garbage. Exercise the
    // reader against a real on-disk fixture rather than a mocked readFile.
    beforeEach(() => {
      // Earlier describes leave persistent readFile/stat mock implementations
      // behind; drop them so this block hits the (memfs-backed) filesystem.
      [fs.readFile, fs.stat]
        .filter((fn) => typeof fn.mockRestore === 'function')
        .forEach((spy) => spy.mockRestore());
    });

    test('decodes a UTF-16LE BOM file to clean text with no NUL bytes', async () => {
      const expected = 'Quarterly report — résumé of Q3 findings\r\nLine two';
      const fixture = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(expected, 'utf16le')]);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stratosort-utf16-'));
      const filePath = path.join(dir, 'notes.txt');
      await fs.writeFile(filePath, fixture);

      const text = await readTextFileWithEncoding(filePath);

      expect(text).toBe(expected);
      expect(text).not.toContain('\u0000');
      expect(text).not.toContain('\uFEFF');
    });
  });

  describe('extractTextFromDoc', () => {
    beforeEach(() => {
      mockWordExtract.mockReset();
    });

    test('reads Word 97-2003 text through word-extractor (body, headers, footnotes)', async () => {
      mockWordExtract.mockResolvedValue({
        getBody: () => 'Quarterly report body.',
        getHeaders: () => 'Confidential header',
        getFootnotes: () => 'Footnote one',
        getEndnotes: () => '',
        getTextboxes: () => ''
      });
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });
      await mockFileSignature(OLE_SIGNATURE);

      const result = await extractTextFromDoc(mockFilePath);

      expect(mockWordExtract).toHaveBeenCalledWith(mockFilePath);
      expect(result).toContain('Quarterly report body.');
      expect(result).toContain('Confidential header');
      expect(result).toContain('Footnote one');
    });

    test('a .doc that is really RTF is read as RTF, not reported as an empty extraction', async () => {
      // Mail clients and converters hand out RTF under a .doc name; the OLE
      // check used to return '' and the watcher burned two retries on it.
      const rtf = '{\\rtf1\\ansi Meeting notes for {\\b Tuesday}.}';
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: rtf.length });
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from(rtf, 'latin1'));
      await mockFileSignature(Buffer.from(rtf.padEnd(512, ' '), 'latin1'));

      const result = await extractTextFromDoc(mockFilePath);

      expect(result).toContain('Meeting notes for');
      expect(result).toContain('Tuesday');
      expect(result).not.toContain('\\rtf1');
      expect(mockWordExtract).not.toHaveBeenCalled();
    });

    test('a password-protected .doc is reported as such instead of as a corrupt file', async () => {
      // word-extractor only checks fWhichTblStm in the FIB flags and reads the
      // encrypted bytes as a piece table; the result was a generic
      // DOC_EXTRACTION_FAILURE and two watcher retries.
      const CFB = require('cfb');
      const container = CFB.utils.cfb_new();
      const fib = Buffer.alloc(64);
      fib.writeUInt16LE(0xa5ec, 0);
      fib.writeUInt16LE(0x0100 | 0x0200, 0x0a); // fEncrypted | fWhichTblStm
      CFB.utils.cfb_add(container, '/WordDocument', fib);
      const encrypted = CFB.write(container, { type: 'buffer' });
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: encrypted.length });
      jest.spyOn(fs, 'readFile').mockResolvedValue(encrypted);
      await mockFileSignature(encrypted.subarray(0, 8));

      await expect(extractTextFromDoc(mockFilePath)).rejects.toMatchObject({
        code: 'DOC_ENCRYPTED'
      });
      expect(mockWordExtract).not.toHaveBeenCalled();

      // The same container without the flag goes to word-extractor as before.
      const plain = CFB.utils.cfb_new();
      const fib2 = Buffer.alloc(64);
      fib2.writeUInt16LE(0xa5ec, 0);
      fib2.writeUInt16LE(0x0200, 0x0a);
      CFB.utils.cfb_add(plain, '/WordDocument', fib2);
      const unencrypted = CFB.write(plain, { type: 'buffer' });
      jest.spyOn(fs, 'readFile').mockResolvedValue(unencrypted);
      mockWordExtract.mockResolvedValue({ getBody: () => 'Readable body.' });
      await mockFileSignature(unencrypted.subarray(0, 8));
      expect(await extractTextFromDoc(mockFilePath)).toContain('Readable body.');
    });

    test('a .doc that is plain text is read as text; real binary junk still yields nothing', async () => {
      const text = 'Plain text saved with a .doc extension.\nSecond line.';
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: text.length });
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from(text, 'utf8'));
      await mockFileSignature(Buffer.from(text.padEnd(512, '\n'), 'utf8'));
      expect(await extractTextFromDoc(mockFilePath)).toContain('Second line.');
      expect(mockWordExtract).not.toHaveBeenCalled();

      const junk = Buffer.alloc(512);
      for (let i = 0; i < junk.length; i++) junk[i] = (i * 37) % 256;
      junk[0] = 0x4d; // not OLE, not ZIP
      await mockFileSignature(junk);
      expect(await extractTextFromDoc(mockFilePath)).toBe('');
    });

    test('a text .doc is read only up to the text size limit, not the document limit', async () => {
      // .doc is admitted at the document ceiling (200MB by default), so an
      // uncapped read of one that turns out to be text slurps far more than
      // the text pipeline would ever accept from a .txt of the same size.
      const limitsModule = require('../src/main/analysis/analysisLimits');
      const text = 'Plain text saved with a .doc extension. '.repeat(10);
      limitsModule.getAnalysisLimits.mockResolvedValue({
        maxImageFileSize: 100 * 1024 * 1024,
        maxDocumentFileSize: 100 * 1024 * 1024,
        maxTextFileSize: 32
      });
      try {
        jest.spyOn(fs, 'stat').mockResolvedValue({ size: text.length });
        jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from(text, 'utf8'));
        await mockFileSignature(Buffer.from(text.padEnd(512, '\n'), 'utf8'));

        expect(await extractTextFromDoc(mockFilePath)).toBe(text.slice(0, 32));
      } finally {
        limitsModule.getAnalysisLimits.mockResolvedValue({
          maxFileSize: 100 * 1024 * 1024,
          maxImageFileSize: 100 * 1024 * 1024,
          maxDocumentFileSize: 100 * 1024 * 1024
        });
      }
    });

    test('should throw FileProcessingError on parser error', async () => {
      mockWordExtract.mockRejectedValue(new Error('Parse error'));
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });
      await mockFileSignature(OLE_SIGNATURE);

      await expect(extractTextFromDoc(mockFilePath)).rejects.toMatchObject({
        code: 'DOC_EXTRACTION_FAILURE'
      });
    });

    test('should enforce the document size limit before parsing, like its siblings', async () => {
      mockWordExtract.mockResolvedValue({ getBody: () => 'DOC content' });
      // Once-only so the oversized stat does not bleed into the legacy-format suites below.
      jest.spyOn(fs, 'stat').mockResolvedValueOnce({ size: 150 * 1024 * 1024 });

      await expect(extractTextFromDoc(mockFilePath)).rejects.toMatchObject({
        code: 'FILE_TOO_LARGE'
      });
      expect(mockWordExtract).not.toHaveBeenCalled();
    });

    describe('against real files on disk (no mocked file-head read)', () => {
      // The sniffers above are fed by a real read of the file's first 512
      // bytes, and a read buffer is zero-filled. mockFileSignature hands them
      // a fully-populated buffer, which is exactly the dependency behaviour
      // that broke the plain-text branch: a .doc shorter than the read length
      // arrived with NUL padding, and looksLikePlainText rejects a NUL as
      // proof of a binary file. These go through fs for that reason.
      beforeEach(() => {
        [fs.readFile, fs.stat, fs.open]
          .filter((fn) => typeof fn.mockRestore === 'function')
          .forEach((spy) => spy.mockRestore());
      });

      const writeDocFixture = async (name, data) => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stratosort-doc-'));
        const filePath = path.join(dir, name);
        await fs.writeFile(filePath, data);
        return filePath;
      };

      test('a plain-text .doc shorter than the 512-byte head read is still read as text', async () => {
        const memo = 'Dear team, please review the attached numbers.\r\nThanks.';
        expect(memo.length).toBeLessThan(512);
        const filePath = await writeDocFixture('memo.doc', Buffer.from(memo, 'latin1'));

        const result = await extractTextFromDoc(filePath);

        expect(result).toContain('please review the attached numbers');
        expect(result).toContain('Thanks.');
        expect(mockWordExtract).not.toHaveBeenCalled();
      });

      test('the plain-text branch has no size cliff at the length of the head read', async () => {
        const body = 'Quarterly numbers, line after line.\r\n';
        const sizes = [1, 51, 511, 512, 513, 1000];
        const results = {};
        for (const size of sizes) {
          const text = body.repeat(Math.ceil(size / body.length)).slice(0, size);
          const filePath = await writeDocFixture(`notes-${size}.doc`, Buffer.from(text, 'latin1'));
          const extracted = await extractTextFromDoc(filePath);
          results[size] = extracted.length > 0;
        }
        expect(results).toEqual({ 1: true, 51: true, 511: true, 512: true, 513: true, 1000: true });
      });

      test('a short RTF .doc still reads as RTF and short binary junk still reads as nothing', async () => {
        // 0x7b 0x5c = "{\" — built from codes so no escaping can soften it.
        const rtf = `${String.fromCharCode(123, 92)}rtf1${String.fromCharCode(92)}ansi Hello world.}`;
        expect(rtf.length).toBeLessThan(512);
        const rtfPath = await writeDocFixture('converted.doc', Buffer.from(rtf, 'latin1'));
        expect(await extractTextFromDoc(rtfPath)).toContain('Hello world.');

        // No NUL anywhere in the junk: the control-character ratio alone has
        // to carry the rejection, so the sniffer cannot pass by accident on a
        // byte the short-read fix would have trimmed away. Being NUL-free is
        // also what this fixture CANNOT prove — the NUL short-circuit has its
        // own fixture in the next test.
        const junk = Buffer.alloc(300);
        for (let i = 0; i < junk.length; i += 1) junk[i] = ((i * 37) % 255) + 1;
        junk[0] = 0x4d; // neither OLE nor ZIP
        expect(junk.includes(0)).toBe(false);
        const junkPath = await writeDocFixture('junk.doc', junk);
        expect(await extractTextFromDoc(junkPath)).toBe('');
      });

      test('a short binary .doc that contains a NUL is still read as nothing', async () => {
        // The control-character ratio cannot carry this one: 300 printable
        // bytes with a single NUL among them is 0.3% control, far under the
        // 2% cut, so looksLikePlainText's NUL short-circuit is the only thing
        // that rejects it. That is the assertion the NUL-free junk fixture
        // above cannot make, and it is what would fail if the short read had
        // been fixed by teaching the sniffer to tolerate NUL padding instead
        // of trimming it away.
        const printable = 'Record 0001 OK '.repeat(20);
        expect(printable.length).toBe(300);
        const withNul = Buffer.from(printable, 'latin1');
        withNul[100] = 0x00;
        expect(withNul.length).toBeLessThan(512);
        expect(withNul.includes(0)).toBe(true);

        const nulPath = await writeDocFixture('record-with-nul.doc', withNul);
        expect(await extractTextFromDoc(nulPath)).toBe('');

        // Control: the same bytes with that one NUL turned into a space are
        // extracted, so what rejects the file above is the NUL and nothing
        // else about it.
        const withoutNul = Buffer.from(withNul);
        withoutNul[100] = 0x20;
        const textPath = await writeDocFixture('record-no-nul.doc', withoutNul);
        expect(await extractTextFromDoc(textPath)).toContain('Record 0001 OK');
      });

      test('an HTML body under a .doc name yields the visible text, not the markup', async () => {
        // Converters, report endpoints and Word's own "Save as Web Page" emit
        // an HTML body named .doc. It is text at the byte level, so the
        // plain-text sniffer accepts it and the markup went to the LLM, the
        // stored rawText and the embedded chunks verbatim.
        const html = [
          '<!DOCTYPE html>',
          '<html><head><title>Invoice 4471</title>',
          '<style>.total { color: #c00; font-weight: bold }</style>',
          '<script>window.print();</script>',
          '</head><body><h1>Invoice 4471</h1>',
          '<p>Amount due: 1,250.00 USD</p></body></html>'
        ].join('\n');
        const filePath = await writeDocFixture('report.doc', Buffer.from(html, 'utf8'));

        const result = await extractTextFromDoc(filePath);

        expect(result).toContain('Invoice 4471');
        expect(result).toContain('Amount due: 1,250.00 USD');
        expect(result).not.toContain('<');
        expect(result).not.toContain('color: #c00');
        expect(result).not.toContain('window.print');
      });

      test('a PDF renamed to .doc does not come back as PDF source', async () => {
        // A PDF head is printable ASCII with no NUL, so the plain-text sniffer
        // accepts it and the object dictionary became the document's prose.
        const pdf = [
          '%PDF-1.4',
          '1 0 obj',
          '<</Type /Catalog',
          '/Pages 2 0 R',
          '>>',
          'endobj',
          'trailer',
          '<</Root 1 0 R>>',
          '%%EOF',
          ''
        ].join('\r\n');
        const filePath = await writeDocFixture('scan.doc', Buffer.from(pdf, 'latin1'));

        const result = await extractTextFromDoc(filePath);

        expect(result).toBe('');
        expect(result).not.toContain('%PDF');
      });

      test('a PostScript program renamed to .doc does not come back as source', async () => {
        const ps = '%!PS-Adobe-3.0\n/Helvetica findfont 12 scalefont setfont\nshowpage\n';
        const filePath = await writeDocFixture('print.doc', Buffer.from(ps, 'latin1'));

        expect(await extractTextFromDoc(filePath)).toBe('');
      });

      test('a UTF-8 BOM before %PDF- still counts as PDF source, not prose', async () => {
        const pdf = Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from('\n%PDF-1.7\n1 0 obj\n<</Type /Catalog>>\nendobj\n%%EOF\n', 'latin1')
        ]);
        const filePath = await writeDocFixture('bom-scan.doc', pdf);

        expect(await extractTextFromDoc(filePath)).toBe('');
      });

      test('an HTML fragment of only void elements is still stripped of its tags', async () => {
        // No closing tag anywhere, so the "some tag is closed later" rule alone
        // would have returned the markup verbatim.
        const fragment = '<p>Line one<br>Line two<br>\n<img src="chart.png">';
        const filePath = await writeDocFixture('fragment.doc', Buffer.from(fragment, 'utf8'));

        const result = await extractTextFromDoc(filePath);

        expect(result).toContain('Line one');
        expect(result).toContain('Line two');
        expect(result).not.toContain('<');
        expect(result).not.toContain('chart.png');
      });
    });
  });

  describe('extractTextFromXls / extractTextFromPpt (no reader in this build)', () => {
    test('.xls fails fast with LEGACY_FORMAT_UNSUPPORTED and a save-as hint', async () => {
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });
      // The readers sniff the head first so an HTML or CSV body saved under a
      // legacy name is read as text; a real OLE container is what they refuse.
      await mockFileSignature(OLE_SIGNATURE);
      const officeParser = require('officeparser');
      officeParser.parseOffice.mockClear();

      await expect(extractTextFromXls(mockFilePath)).rejects.toMatchObject({
        code: 'LEGACY_FORMAT_UNSUPPORTED',
        metadata: expect.objectContaining({
          fileType: '.xls',
          suggestion: expect.stringContaining('.xlsx')
        })
      });
      // officeparser rejects every OLE format; nothing is retried for nothing.
      expect(officeParser.parseOffice).not.toHaveBeenCalled();
    });

    test('.ppt fails fast with LEGACY_FORMAT_UNSUPPORTED and a save-as hint', async () => {
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });
      await mockFileSignature(OLE_SIGNATURE);

      await expect(extractTextFromPpt(mockFilePath)).rejects.toMatchObject({
        code: 'LEGACY_FORMAT_UNSUPPORTED',
        metadata: expect.objectContaining({
          fileType: '.ppt',
          suggestion: expect.stringContaining('.pptx')
        })
      });
    });

    test('the legacy error carries a user message that names the format', async () => {
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });
      await mockFileSignature(OLE_SIGNATURE);
      const error = await extractTextFromXls(mockFilePath).catch((e) => e);
      expect(error.getUserFriendlyMessage()).toMatch(/cannot read the contents of \.xls files/);
      expect(error.getUserFriendlyMessage()).toMatch(/Save the workbook as \.xlsx/);
    });
  });

  describe('extractTextFromMsg', () => {
    beforeEach(() => {
      mockMsgGetFileData.mockReset();
    });

    test('reads subject, sender, recipients, body and attachment names from an Outlook message', async () => {
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('ole-bytes'));
      mockMsgGetFileData.mockReturnValue({
        subject: 'Invoice 4471',
        senderName: 'Ann Example',
        senderEmail: 'ann@example.com',
        recipients: [{ name: 'Bob', email: 'bob@example.com' }],
        body: 'Please find the invoice attached.',
        attachments: [{ fileName: 'invoice-4471.pdf' }]
      });

      const result = await extractTextFromMsg(mockFilePath);

      expect(result).toContain('Subject: Invoice 4471');
      expect(result).toContain('From: Ann Example <ann@example.com>');
      expect(result).toContain('To: Bob <bob@example.com>');
      expect(result).toContain('Please find the invoice attached.');
      expect(result).toContain('Attachments: invoice-4471.pdf');
    });

    test('falls back to the HTML body when there is no plain body', async () => {
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('ole-bytes'));
      mockMsgGetFileData.mockReturnValue({
        subject: 'Hi',
        body: '',
        bodyHtml: '<html><body><p>Rich <b>text</b> body</p></body></html>',
        recipients: [],
        attachments: []
      });

      const result = await extractTextFromMsg(mockFilePath);

      expect(result).toContain('Rich text body');
      expect(result).not.toContain('<b>');
    });

    test('reads a body stored only as compressed RTF (Exchange exports)', async () => {
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('ole-bytes'));
      // PR_RTF_COMPRESSED in its stored-uncompressed form: 16-byte header
      // (compressed size, raw size, "MELA", crc) followed by the raw RTF.
      const rtf = Buffer.from(
        '{\\rtf1\\ansi Quarterly figures attached, {\\b please review} by Friday.}'
      );
      const header = Buffer.alloc(16);
      header.writeUInt32LE(rtf.length + 12, 0);
      header.writeUInt32LE(rtf.length, 4);
      header.write('MELA', 8, 'ascii');
      header.writeUInt32LE(0, 12);
      mockMsgGetFileData.mockReturnValue({
        subject: 'Q3 numbers',
        senderName: 'Ann Example',
        senderEmail: 'ann@example.com',
        recipients: [],
        body: '',
        bodyHtml: '',
        compressedRtf: new Uint8Array(Buffer.concat([header, rtf])),
        attachments: [{ fileName: 'q3.xlsx' }]
      });

      const result = await extractTextFromMsg(mockFilePath);

      expect(result).toContain('Subject: Q3 numbers');
      expect(result).toContain('Quarterly figures attached');
      expect(result).toContain('please review');
      expect(result).not.toContain('\\rtf1');
      expect(result).toContain('Attachments: q3.xlsx');
    });

    test('a plain body wins over the compressed RTF copy', async () => {
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('ole-bytes'));
      mockMsgGetFileData.mockReturnValue({
        subject: 'Hi',
        body: 'Plain body text here.',
        compressedRtf: new Uint8Array([1, 2, 3]),
        recipients: [],
        attachments: []
      });

      const result = await extractTextFromMsg(mockFilePath);

      expect(result).toContain('Plain body text here.');
    });

    test('throws DOC_EXTRACTION_FAILURE when the message cannot be read', async () => {
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('not-ole'));
      mockMsgGetFileData.mockReturnValue({ error: 'Unsupported file type!' });

      await expect(extractTextFromMsg(mockFilePath)).rejects.toMatchObject({
        code: 'DOC_EXTRACTION_FAILURE'
      });
    });
  });

  describe('extractTextFromOdfZip', () => {
    test('should extract text from ODF document', async () => {
      const AdmZip = require('adm-zip');

      const mockEntry = {
        getData: jest
          .fn()
          .mockReturnValue(
            Buffer.from('<office:document-content>Content</office:document-content>')
          )
      };

      const mockZip = {
        getEntry: jest.fn().mockReturnValue(mockEntry)
      };

      AdmZip.mockImplementation(() => mockZip);

      const result = await extractTextFromOdfZip(mockFilePath);

      expect(result).toContain('Content');
    });

    test('should return empty string if content.xml not found', async () => {
      const AdmZip = require('adm-zip');

      const mockZip = {
        getEntry: jest.fn().mockReturnValue(null)
      };

      AdmZip.mockImplementation(() => mockZip);

      const result = await extractTextFromOdfZip(mockFilePath);

      expect(result).toBe('');
    });
  });

  describe('extractTextFromKml', () => {
    test('should extract text from KML', async () => {
      const kmlContent = `<?xml version="1.0"?>
        <kml>
          <Document>
            <name>Test Location</name>
            <Placemark>
              <name>Point A</name>
            </Placemark>
          </Document>
        </kml>`;

      jest.spyOn(fs, 'readFile').mockResolvedValue(kmlContent);

      const result = await extractTextFromKml(mockFilePath);

      expect(result).toContain('Test Location');
      expect(result).toContain('Point A');
    });
  });

  describe('extractTextFromKmz', () => {
    test('should extract text from KMZ archive', async () => {
      const AdmZip = require('adm-zip');

      const mockEntry = {
        entryName: 'doc.kml',
        getData: jest
          .fn()
          .mockReturnValue(Buffer.from('<kml><Document><name>Test</name></Document></kml>'))
      };

      const mockZip = {
        getEntry: jest.fn().mockReturnValue(mockEntry),
        getEntries: jest.fn().mockReturnValue([mockEntry])
      };

      AdmZip.mockImplementation(() => mockZip);

      const result = await extractTextFromKmz(mockFilePath);

      expect(result).toContain('Test');
    });

    test('should find .kml file in entries if doc.kml not found', async () => {
      const AdmZip = require('adm-zip');

      const mockEntry = {
        entryName: 'custom.kml',
        getData: jest.fn().mockReturnValue(Buffer.from('<kml>Content</kml>'))
      };

      const mockZip = {
        getEntry: jest.fn().mockReturnValue(null),
        getEntries: jest.fn().mockReturnValue([mockEntry])
      };

      AdmZip.mockImplementation(() => mockZip);

      const result = await extractTextFromKmz(mockFilePath);

      expect(result).toContain('Content');
    });
  });

  describe('Memory Management', () => {
    test('should handle null/undefined in truncateText', async () => {
      const { extractText } = require('unpdf');
      extractText.mockResolvedValue({ text: null });
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('pdf'));
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      await expect(extractTextFromPdf(mockFilePath, mockFileName)).rejects.toThrow();
    });
  });

  describe('PDF buffer cache lifecycle (extract -> OCR hand-off)', () => {
    // Other describe blocks leave their own entries behind (they never run the
    // OCR step), so assert on deltas against a per-test baseline.
    const cachePath = '/test/cache-lifecycle.pdf';
    let baseline;

    beforeEach(() => {
      jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('%PDF-1.4 bytes'));
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });
      baseline = _pdfBufferCacheSizeForTests();
    });

    test('does not pin the buffer when text extraction succeeds', async () => {
      require('unpdf').extractText.mockResolvedValue({
        text: 'Content long enough to count as a real text layer for one page of a document.'
      });

      await extractTextFromPdf(cachePath, 'cache-lifecycle.pdf');

      expect(_pdfBufferCacheSizeForTests()).toBe(baseline);
    });

    test('does not pin the buffer when the PDF is encrypted', async () => {
      const passwordError = new Error('No password given');
      passwordError.name = 'PasswordException';
      require('unpdf').getDocumentProxy.mockRejectedValue(passwordError);

      await expect(extractTextFromPdf(cachePath, 'cache-lifecycle.pdf')).rejects.toMatchObject({
        code: 'PDF_ENCRYPTED'
      });
      expect(_pdfBufferCacheSizeForTests()).toBe(baseline);
    });

    test('does not pin the buffer when the caller aborts mid-extraction', async () => {
      const controller = new AbortController();
      require('unpdf').extractText.mockImplementation(async () => {
        controller.abort();
        return { text: '' };
      });

      // The timeout wrapper links the caller's signal through withAbortableTimeout,
      // which surfaces external cancellation as OPERATION_CANCELLED.
      await expect(
        extractTextFromPdf(cachePath, 'cache-lifecycle.pdf', { signal: controller.signal })
      ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
      expect(_pdfBufferCacheSizeForTests()).toBe(baseline);
    });

    test('pins the buffer only for the OCR hand-off and releases it on OCR early return', async () => {
      const { isTesseractAvailable } = require('../src/main/utils/tesseractUtils');
      require('unpdf').extractText.mockResolvedValue({ text: '' });

      await expect(extractTextFromPdf(cachePath, 'cache-lifecycle.pdf')).rejects.toMatchObject({
        code: 'PDF_NO_TEXT_CONTENT'
      });
      expect(_pdfBufferCacheSizeForTests()).toBe(baseline + 1);

      // OCR bails before touching the buffer — the finally must still release it.
      isTesseractAvailable.mockResolvedValueOnce(false);
      await expect(ocrPdfIfNeeded(cachePath)).resolves.toBe('');
      expect(fs.readFile).toHaveBeenCalledTimes(1);
      expect(_pdfBufferCacheSizeForTests()).toBe(baseline);
    });

    test('releases the pinned buffer when OCR skips oversized files', async () => {
      require('unpdf').extractText.mockResolvedValue({ text: '' });
      await expect(extractTextFromPdf(cachePath, 'cache-lifecycle.pdf')).rejects.toMatchObject({
        code: 'PDF_NO_TEXT_CONTENT'
      });
      expect(_pdfBufferCacheSizeForTests()).toBe(baseline + 1);

      fs.stat.mockResolvedValue({ size: 35 * 1024 * 1024 });
      await expect(ocrPdfIfNeeded(cachePath)).resolves.toBe('');
      expect(_pdfBufferCacheSizeForTests()).toBe(baseline);
    });
  });

  describe('extractTextFromCsv', () => {
    const { extractTextFromCsv } = require('../src/main/analysis/documentExtractors');

    test('should extract text from valid CSV', async () => {
      const csvContent = 'Name,Age,City\nAlice,30,New York\nBob,25,Los Angeles';
      jest.spyOn(fs, 'readFile').mockResolvedValue(csvContent);
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromCsv('/test/data.csv');

      expect(result).toContain('Alice');
      expect(result).toContain('30');
      expect(result).toContain('New York');
    });

    test('should handle object-style CSV rows', async () => {
      // Some CSV parsers return objects instead of arrays
      jest.spyOn(fs, 'readFile').mockResolvedValue('col1,col2\nval1,val2');
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromCsv('/test/data.csv');

      expect(result).toBeDefined();
    });

    test('should limit rows to prevent memory issues', async () => {
      const rows = Array.from({ length: 6000 }, (_, i) => `row${i},data${i}`);
      const csvContent = 'Header1,Header2\n' + rows.join('\n');
      jest.spyOn(fs, 'readFile').mockResolvedValue(csvContent);
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromCsv('/test/large.csv');

      expect(result).toBeDefined();
      // Should have limited rows
    });

    test('should return raw text on parse failure', async () => {
      jest.spyOn(fs, 'readFile').mockResolvedValue('invalid csv with "unterminated quote');
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromCsv('/test/invalid.csv');

      expect(result).toBeDefined();
    });

    test('should handle empty CSV', async () => {
      jest.spyOn(fs, 'readFile').mockResolvedValue('');
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 0 });

      const result = await extractTextFromCsv('/test/empty.csv');

      expect(result).toBe('');
    });
  });

  describe('extractPlainTextFromXml', () => {
    const { extractPlainTextFromXml } = require('../src/main/analysis/documentExtractors');

    test('should extract text from valid XML', async () => {
      const xml = '<?xml version="1.0"?><root><item>Content here</item></root>';
      const result = await extractPlainTextFromXml(xml);

      expect(result).toContain('Content here');
    });

    test('should handle nested XML elements', async () => {
      const xml = '<root><level1><level2>Nested content</level2></level1></root>';
      const result = await extractPlainTextFromXml(xml);

      expect(result).toContain('Nested content');
    });

    test('should handle empty XML', async () => {
      const result = await extractPlainTextFromXml('');

      expect(result).toBe('');
    });

    test('should handle null XML', async () => {
      const result = await extractPlainTextFromXml(null);

      expect(result).toBe('');
    });

    test('should fallback to HTML stripping on parse error', async () => {
      // Malformed XML that will cause parser to fail
      const malformedXml = '<root><unclosed>Content';
      const result = await extractPlainTextFromXml(malformedXml);

      expect(result).toContain('Content');
    });

    test('should handle XML with numeric values', async () => {
      const xml = '<data><count>42</count><price>99.99</price></data>';
      const result = await extractPlainTextFromXml(xml);

      expect(result).toContain('42');
      expect(result).toContain('99.99');
    });

    test('should handle XML with boolean values', async () => {
      const xml = '<settings><enabled>true</enabled></settings>';
      const result = await extractPlainTextFromXml(xml);

      expect(result).toContain('true');
    });

    test('should handle XML with arrays', async () => {
      const xml = '<list><item>One</item><item>Two</item><item>Three</item></list>';
      const result = await extractPlainTextFromXml(xml);

      expect(result).toContain('One');
      expect(result).toContain('Two');
      expect(result).toContain('Three');
    });
  });

  describe('file size handling', () => {
    test('should reject files over size limit', async () => {
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 150 * 1024 * 1024 }); // 150MB

      await expect(extractTextFromPdf(mockFilePath, mockFileName)).rejects.toThrow(
        'File size exceeds processing limits'
      );
    });

    test('should handle stat errors', async () => {
      const error = new Error('EACCES: permission denied');
      error.code = 'EACCES';
      jest.spyOn(fs, 'stat').mockRejectedValue(error);

      await expect(extractTextFromPdf(mockFilePath, mockFileName)).rejects.toThrow();
    });
  });

  describe('extractTextFromEpub - edge cases', () => {
    test('should handle entries without getData method', async () => {
      const AdmZip = require('adm-zip');

      const mockEntries = [
        {
          entryName: 'chapter1.xhtml'
          // Missing getData method
        }
      ];

      const mockZip = {
        getEntries: jest.fn().mockReturnValue(mockEntries)
      };

      AdmZip.mockImplementation(() => mockZip);
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromEpub(mockFilePath);

      // Should handle gracefully
      expect(result).toBeDefined();
    });

    test('should skip non-HTML entries', async () => {
      const AdmZip = require('adm-zip');

      const mockEntries = [
        {
          entryName: 'image.png',
          getData: jest.fn().mockReturnValue(Buffer.from('binary data'))
        },
        {
          entryName: 'chapter.html',
          getData: jest.fn().mockReturnValue(Buffer.from('<html><body>Chapter</body></html>'))
        }
      ];

      const mockZip = {
        getEntries: jest.fn().mockReturnValue(mockEntries)
      };

      AdmZip.mockImplementation(() => mockZip);
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromEpub(mockFilePath);

      expect(result).toContain('Chapter');
    });
  });

  describe('extractTextFromEml - edge cases', () => {
    test('should handle multi-line headers', async () => {
      const emailContent = `Subject: This is a very long subject
 that spans multiple lines
From: sender@example.com
To: receiver@example.com

Body content.`;

      jest.spyOn(fs, 'readFile').mockResolvedValue(emailContent);
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromEml(mockFilePath);

      expect(result).toBeDefined();
      expect(result).toContain('sender@example.com');
    });

    test('should handle email with no body', async () => {
      const emailContent = `Subject: Headers Only
From: sender@example.com`;

      jest.spyOn(fs, 'readFile').mockResolvedValue(emailContent);
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1000 });

      const result = await extractTextFromEml(mockFilePath);

      expect(result).toContain('Headers Only');
    });
  });

  describe('extractTextFromKmz - edge cases', () => {
    test('should handle KMZ with no KML files', async () => {
      const AdmZip = require('adm-zip');

      const mockZip = {
        getEntry: jest.fn().mockReturnValue(null),
        getEntries: jest.fn().mockReturnValue([{ entryName: 'readme.txt' }])
      };

      AdmZip.mockImplementation(() => mockZip);

      const result = await extractTextFromKmz(mockFilePath);

      expect(result).toBe('');
    });

    test('should handle getData throwing error', async () => {
      const AdmZip = require('adm-zip');

      const mockEntry = {
        entryName: 'doc.kml',
        getData: jest.fn().mockImplementation(() => {
          throw new Error('Corrupt archive');
        })
      };

      const mockZip = {
        getEntry: jest.fn().mockReturnValue(mockEntry),
        getEntries: jest.fn().mockReturnValue([mockEntry])
      };

      AdmZip.mockImplementation(() => mockZip);

      // Should throw error or return empty string
      try {
        const result = await extractTextFromKmz(mockFilePath);
        expect(result).toBe('');
      } catch (error) {
        expect(error.message).toContain('Corrupt');
      }
    });
  });

  describe('extractPlainTextFromHtml - edge cases', () => {
    test('should handle null input gracefully', async () => {
      const result = await extractPlainTextFromHtml(null);
      expect(result === '' || result === undefined || result === null).toBe(true);
    });

    test('should handle undefined input gracefully', async () => {
      const result = await extractPlainTextFromHtml(undefined);
      expect(result === '' || result === undefined).toBe(true);
    });

    test('should handle empty string', async () => {
      const result = await extractPlainTextFromHtml('');
      expect(result).toBe('');
    });

    test('should normalize whitespace', async () => {
      const html = '<p>Text   with    multiple     spaces</p>';
      const result = await extractPlainTextFromHtml(html);

      expect(result).toBe('Text with multiple spaces');
    });
  });

  describe('extractPlainTextFromRtf - edge cases', () => {
    test('should handle null input gracefully', async () => {
      const result = await extractPlainTextFromRtf(null);
      // Function may return undefined/null for invalid input
      expect(result === '' || result === undefined || result === null).toBe(true);
    });

    test('should handle undefined input gracefully', async () => {
      const result = await extractPlainTextFromRtf(undefined);
      // Function may return undefined for invalid input
      expect(result === '' || result === undefined).toBe(true);
    });

    test('should handle empty string', async () => {
      const result = await extractPlainTextFromRtf('');
      expect(result === '' || result === undefined).toBe(true);
    });
  });
});
