/**
 * Regression: extractTextFromDocx used to wrap its fallback chain in a second,
 * redundant catch that re-ran document.xml extraction, OCR, officeparser and
 * OCR again — so a single failing DOCX could trigger three Tesseract sweeps
 * (x OFFICE_OCR_MAX_IMAGES) per attempt. The chain must now run each stage at
 * most once: mammoth -> officeparser -> document.xml -> OCR.
 */

const fs = require('fs').promises;

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

jest.mock('mammoth', () => ({
  extractRawText: jest.fn()
}));

jest.mock('officeparser', () => ({
  parseOfficeAsync: jest.fn()
}));

jest.mock('../src/main/utils/tesseractUtils', () => ({
  isTesseractAvailable: jest.fn().mockResolvedValue(true),
  recognizeIfAvailable: jest.fn().mockResolvedValue({ success: true, text: '' })
}));

jest.mock('sharp', () =>
  jest.fn(() => ({
    metadata: jest.fn().mockResolvedValue({ width: 100, height: 100 }),
    resize: jest.fn().mockReturnThis(),
    png: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.from('png'))
  }))
);

jest.mock('../src/main/utils/workerPools', () => ({
  getImagePreprocessPool: jest.fn(() => null),
  getTextExtractionPool: jest.fn(() => null)
}));

const zipEntries = [];
jest.mock('adm-zip', () =>
  jest.fn().mockImplementation(() => ({
    getEntries: () => zipEntries,
    getEntry: () => null
  }))
);

jest.mock('../src/main/analysis/analysisLimits', () => ({
  getAnalysisLimits: jest.fn().mockResolvedValue({ maxDocumentFileSize: 100 * 1024 * 1024 }),
  getDefaultLimits: jest.fn().mockReturnValue({ maxDocumentFileSize: 100 * 1024 * 1024 }),
  invalidateCache: jest.fn()
}));

jest.mock('../src/shared/logger', () => {
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    setContext: jest.fn()
  };
  return { createLogger: jest.fn(() => logger), logger };
});

const documentExtractors = require('../src/main/analysis/documentExtractors');
const mammoth = require('mammoth');
const officeParser = require('officeparser');
const { isTesseractAvailable, recognizeIfAvailable } = require('../src/main/utils/tesseractUtils');
const { createLogger } = require('../src/shared/logger');
const docxLogger = createLogger();

const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]);

function mockZipSignature() {
  fs.open.mockResolvedValue({
    read: jest.fn(async (buffer, offset, length) => {
      ZIP_SIGNATURE.copy(buffer, offset, 0, length);
      return { bytesRead: length, buffer };
    }),
    close: jest.fn().mockResolvedValue(undefined)
  });
}

function imageEntry(name) {
  const data = Buffer.from('image-bytes');
  return {
    entryName: name,
    header: { method: 0, size: data.length, compressedSize: data.length },
    getData: () => data,
    getCompressedData: () => data
  };
}

describe('extractTextFromDocx fallback chain runs each stage once', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    zipEntries.length = 0;
    fs.stat.mockResolvedValue({ size: 1000 });
    mockZipSignature();
    isTesseractAvailable.mockResolvedValue(true);
    recognizeIfAvailable.mockResolvedValue({ success: true, text: '' });
  });

  test('empty mammoth + empty officeparser + no xml + empty OCR -> one OCR sweep, original error', async () => {
    mammoth.extractRawText.mockResolvedValue({ value: '' });
    officeParser.parseOfficeAsync.mockResolvedValue('');
    zipEntries.push(imageEntry('word/media/image1.png'), imageEntry('word/media/image2.png'));

    await expect(documentExtractors.extractTextFromDocxRaw('doc.docx')).rejects.toThrow(
      'No text content in DOCX'
    );

    expect(isTesseractAvailable).toHaveBeenCalledTimes(1);
    expect(recognizeIfAvailable).toHaveBeenCalledTimes(2);
    expect(officeParser.parseOfficeAsync).toHaveBeenCalledTimes(1);
  });

  test('officeparser throwing still yields exactly one OCR sweep and rethrows the mammoth error', async () => {
    mammoth.extractRawText.mockRejectedValue(new Error('mammoth exploded'));
    officeParser.parseOfficeAsync.mockRejectedValue(new Error('officeparser exploded'));
    zipEntries.push(imageEntry('word/media/image1.png'));

    await expect(documentExtractors.extractTextFromDocxRaw('doc.docx')).rejects.toThrow(
      'mammoth exploded'
    );

    expect(isTesseractAvailable).toHaveBeenCalledTimes(1);
    expect(recognizeIfAvailable).toHaveBeenCalledTimes(1);
    expect(officeParser.parseOfficeAsync).toHaveBeenCalledTimes(1);
  });

  test('OCR text is returned when every text parser comes back empty', async () => {
    mammoth.extractRawText.mockResolvedValue({ value: '' });
    officeParser.parseOfficeAsync.mockResolvedValue('');
    recognizeIfAvailable.mockResolvedValue({ success: true, text: 'scanned words' });
    zipEntries.push(imageEntry('word/media/image1.png'));

    await expect(documentExtractors.extractTextFromDocxRaw('doc.docx')).resolves.toBe(
      'scanned words'
    );
    expect(isTesseractAvailable).toHaveBeenCalledTimes(1);
  });

  test('an aborted signal stops the chain before OCR and surfaces as AbortError', async () => {
    mammoth.extractRawText.mockResolvedValue({ value: '' });
    const controller = new AbortController();
    officeParser.parseOfficeAsync.mockImplementation(async () => {
      controller.abort();
      return '';
    });
    zipEntries.push(imageEntry('word/media/image1.png'));

    await expect(
      documentExtractors.extractTextFromDocxRaw('doc.docx', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(isTesseractAvailable).not.toHaveBeenCalled();
    expect(recognizeIfAvailable).not.toHaveBeenCalled();
  });

  test('abort during the OCR sweep propagates instead of degrading to empty text', async () => {
    mammoth.extractRawText.mockResolvedValue({ value: '' });
    officeParser.parseOfficeAsync.mockResolvedValue('');
    const controller = new AbortController();
    recognizeIfAvailable.mockImplementation(async () => {
      controller.abort();
      return { success: true, text: '' };
    });
    zipEntries.push(imageEntry('word/media/image1.png'), imageEntry('word/media/image2.png'));

    await expect(
      documentExtractors.extractTextFromDocxRaw('doc.docx', { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('Electron DOMParser mimeType failure is debug, not a mammoth extraction warning', async () => {
    mammoth.extractRawText.mockRejectedValue(
      new Error('DOMParser.parseFromString: the provided mimeType "undefined" is not valid')
    );
    officeParser.parseOfficeAsync.mockResolvedValue('officeparser text');

    await expect(documentExtractors.extractTextFromDocxRaw('doc.docx')).resolves.toBe(
      'officeparser text'
    );

    expect(docxLogger.warn).not.toHaveBeenCalledWith(
      '[DOCX] Mammoth extraction failed, trying officeparser fallback',
      expect.anything()
    );
    expect(docxLogger.debug).toHaveBeenCalledWith(
      '[DOCX] Mammoth skipped (Electron DOMParser mimeType); using officeparser',
      expect.objectContaining({ filePath: 'doc.docx' })
    );
  });
});
