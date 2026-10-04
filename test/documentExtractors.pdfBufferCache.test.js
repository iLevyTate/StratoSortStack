/**
 * @jest-environment node
 *
 * Regression: extractTextFromPdf pins the raw file buffer in a module-level
 * cache once it learns OCR will follow, relying on ocrPdfIfNeeded to release
 * it. When the timeout wrapper won the race, the orphaned extraction kept
 * running and pinned the buffer AFTER the caller had already run (and
 * finished) its OCR fallback — nobody was left to delete it, and the cache
 * had no periodic sweep. Up to 50 x maxDocumentFileSize could stay resident
 * for the process lifetime.
 *
 * Oracle: after a timed-out extraction finally settles, the buffer cache is
 * empty and the pdf.js proxy was torn down by the abort.
 */

const path = require('path');
const fs = require('fs').promises;

const pdfProxies = [];
let resolveExtractText = null;

jest.mock('unpdf', () => ({
  getDocumentProxy: jest.fn(async () => {
    const proxy = { destroy: jest.fn(async () => undefined) };
    pdfProxies.push(proxy);
    return proxy;
  }),
  extractText: jest.fn(
    () =>
      new Promise((resolve) => {
        resolveExtractText = resolve;
      })
  )
}));

const {
  extractTextFromPdf,
  extractTextFromPdfRaw,
  shutdownPdfBufferCache,
  EXTRACTION_TIMEOUTS,
  _pdfBufferCacheSizeForTests
} = require('../src/main/analysis/documentExtractors');

const PDF_BYTES = Buffer.from('%PDF-1.4 fake scanned pdf content for buffer-cache test');
const TEST_DIR = '/tmp/pdf-buffer-cache-test';
const PDF_PATH = path.join(TEST_DIR, 'scanned.pdf');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const waitForExtractTextCall = async () => {
  for (let i = 0; i < 5000 && !resolveExtractText; i += 1) await tick();
  if (!resolveExtractText) throw new Error('unpdf.extractText was never reached');
};
const settleOrphan = async () => {
  resolveExtractText({ text: '' });
  for (let i = 0; i < 3; i += 1) await tick();
};

describe('PDF extraction timeout does not strand the OCR buffer pin', () => {
  const originalPdfTimeout = EXTRACTION_TIMEOUTS.PDF;

  beforeEach(async () => {
    pdfProxies.length = 0;
    resolveExtractText = null;
    await fs.mkdir(TEST_DIR, { recursive: true });
    await fs.writeFile(PDF_PATH, PDF_BYTES);
  });

  afterEach(async () => {
    EXTRACTION_TIMEOUTS.PDF = originalPdfTimeout;
    await shutdownPdfBufferCache();
  });

  test('control: an in-time no-text result pins the buffer for the OCR consumer', async () => {
    const pending = extractTextFromPdfRaw(PDF_PATH, 'scanned.pdf');
    await waitForExtractTextCall();
    resolveExtractText({ text: '' });

    await expect(pending).rejects.toMatchObject({ code: 'PDF_NO_TEXT_CONTENT' });
    expect(_pdfBufferCacheSizeForTests()).toBe(1);

    await shutdownPdfBufferCache();
    expect(_pdfBufferCacheSizeForTests()).toBe(0);
  });

  test('a timed-out extraction aborts pdf.js and never pins the buffer', async () => {
    EXTRACTION_TIMEOUTS.PDF = 150;

    const timedOut = extractTextFromPdf(PDF_PATH, 'scanned.pdf');
    await waitForExtractTextCall();
    await expect(timedOut).rejects.toThrow(/timed out/);

    // The orphaned pdf.js call now settles with "no text" — the path that
    // used to pin the buffer with nobody left to release it.
    await settleOrphan();

    expect(_pdfBufferCacheSizeForTests()).toBe(0);
    expect(pdfProxies).toHaveLength(1);
    expect(pdfProxies[0].destroy).toHaveBeenCalled();
  });

  test("the caller's own abort signal cancels the extraction without pinning", async () => {
    const controller = new AbortController();
    const cancelled = extractTextFromPdf(PDF_PATH, 'scanned.pdf', { signal: controller.signal });
    await waitForExtractTextCall();
    controller.abort();

    await expect(cancelled).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });

    await settleOrphan();

    expect(_pdfBufferCacheSizeForTests()).toBe(0);
    expect(pdfProxies[0].destroy).toHaveBeenCalled();
  });
});
