/**
 * @jest-environment node
 *
 * OCR of a scanned (image-only) PDF covers more than the first page, stays
 * under a fixed page cap, and reports how many pages it actually read so the
 * analysis can be flagged as partial when the cap cut the document short.
 *
 * sharp/libvips renders only page 0 of a multi-page input unless `page` is
 * given; the @napi-rs/canvas fallback caps at a few pages. Neither used to
 * say that the rest of the document was skipped.
 */

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

// The OCR result echoes the rendered image so each test can see which page
// was recognized.
const mockRecognizeIfAvailable = jest.fn(async (_path, buffer) => ({
  success: true,
  text: `text of ${Buffer.from(buffer).toString('utf8')}`
}));
jest.mock('../src/main/utils/tesseractUtils', () => ({
  isTesseractAvailable: jest.fn().mockResolvedValue(true),
  recognizeIfAvailable: (...args) => mockRecognizeIfAvailable(...args)
}));

let mockImagePool = null;
jest.mock('../src/main/utils/workerPools', () => ({
  getImagePreprocessPool: () => mockImagePool
}));

jest.mock('unpdf', () => ({
  extractText: jest.fn(),
  definePDFJSModule: jest.fn().mockResolvedValue(),
  renderPageAsImage: jest.fn(),
  getDocumentProxy: jest.fn()
}));
jest.mock('@napi-rs/canvas', () => ({}));
jest.mock('sharp');

const fs = require('fs').promises;
const sharp = require('sharp');
const unpdf = require('unpdf');
const { ocrPdfIfNeededRaw, PDF_OCR_MAX_PAGES } = require('../src/main/analysis/documentExtractors');

/**
 * A sharp double that renders `page-<n>` for the requested page and reports
 * `pages` in its metadata like libvips does for a PDF.
 */
function mockSharpPdf(totalPages) {
  sharp.mockImplementation((_input, options = {}) => {
    const page = Number.isInteger(options.page) ? options.page : 0;
    const pipeline = {
      metadata: jest.fn().mockResolvedValue({ width: 1240, height: 1754, pages: totalPages }),
      resize: jest.fn(() => pipeline),
      png: jest.fn(() => pipeline),
      toBuffer: jest.fn().mockResolvedValue(Buffer.from(`page-${page}`))
    };
    return pipeline;
  });
}

// Pages handed to sharp; a call without `page` renders page 0.
const renderedSharpPages = () =>
  sharp.mock.calls.map(([, options]) => (Number.isInteger(options?.page) ? options.page : 0));

describe('scanned-PDF OCR page coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockImagePool = null;
    jest.spyOn(fs, 'stat').mockResolvedValue({ size: 4096 });
    jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('%PDF-1.7 synthetic'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('the page cap allows more than the first page', () => {
    expect(PDF_OCR_MAX_PAGES).toBeGreaterThan(1);
  });

  test('a long scan is read up to the page cap and reported as partial', async () => {
    mockSharpPdf(40);
    const coverage = {};

    const text = await ocrPdfIfNeededRaw('/scans/contract.pdf', { coverage });

    const expectedPages = Array.from({ length: PDF_OCR_MAX_PAGES }, (_, i) => i);
    expect(renderedSharpPages()).toEqual(expectedPages);
    expect(mockRecognizeIfAvailable).toHaveBeenCalledTimes(PDF_OCR_MAX_PAGES);
    for (const page of expectedPages) expect(text).toContain(`text of page-${page}`);
    expect(coverage).toEqual({ pagesOcred: PDF_OCR_MAX_PAGES, totalPages: 40 });
  });

  test('a short scan is read in full', async () => {
    mockSharpPdf(2);
    const coverage = {};

    const text = await ocrPdfIfNeededRaw('/scans/letter.pdf', { coverage });

    expect(renderedSharpPages()).toEqual([0, 1]);
    expect(text).toContain('text of page-0');
    expect(text).toContain('text of page-1');
    expect(coverage).toEqual({ pagesOcred: 2, totalPages: 2 });
  });

  test('the worker renders the first page and later pages are still read', async () => {
    mockSharpPdf(4);
    mockImagePool = {
      run: jest.fn().mockResolvedValue({ buffer: Buffer.from('page-0'), width: 1240, height: 1754 })
    };
    const coverage = {};

    const text = await ocrPdfIfNeededRaw('/scans/form.pdf', { coverage, pageCount: 4 });

    expect(mockImagePool.run).toHaveBeenCalledTimes(1);
    expect(renderedSharpPages()).toEqual(
      Array.from({ length: PDF_OCR_MAX_PAGES - 1 }, (_, i) => i + 1)
    );
    expect(text).toContain('text of page-0');
    expect(text).toContain(`text of page-${PDF_OCR_MAX_PAGES - 1}`);
    expect(coverage).toEqual({ pagesOcred: PDF_OCR_MAX_PAGES, totalPages: 4 });
  });

  describe('canvas renderer fallback (sharp without PDF support)', () => {
    beforeEach(() => {
      sharp.mockImplementation(() => ({
        metadata: jest
          .fn()
          .mockRejectedValue(new Error('Input buffer contains unsupported image format'))
      }));
      unpdf.renderPageAsImage.mockImplementation(async (_doc, pageNumber) =>
        Buffer.from(`page-${pageNumber - 1}`)
      );
    });

    test('reports the cap against the real page count', async () => {
      unpdf.getDocumentProxy.mockResolvedValue({ numPages: 12, destroy: jest.fn() });
      const coverage = {};

      const text = await ocrPdfIfNeededRaw('/scans/manual.pdf', { coverage });

      expect(unpdf.renderPageAsImage).toHaveBeenCalledTimes(PDF_OCR_MAX_PAGES);
      expect(text).toContain('text of page-0');
      expect(coverage).toEqual({ pagesOcred: PDF_OCR_MAX_PAGES, totalPages: 12 });
    });

    test('does not try to render pages a one-page scan does not have', async () => {
      unpdf.getDocumentProxy.mockResolvedValue({ numPages: 1, destroy: jest.fn() });
      const coverage = {};

      await ocrPdfIfNeededRaw('/scans/receipt.pdf', { coverage });

      expect(unpdf.renderPageAsImage).toHaveBeenCalledTimes(1);
      expect(coverage).toEqual({ pagesOcred: 1, totalPages: 1 });
    });
  });
});
