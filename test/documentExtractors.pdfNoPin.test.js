/**
 * @jest-environment node
 *
 * extractTextFromPdf pins the file buffer for ocrPdfIfNeeded when the text
 * layer is empty or thin. The .ai reader never runs OCR, so it passes
 * pinForOcr: false; without it a batch of outlined-type Illustrator files
 * stayed resident until the cache's TTL sweep. The thin text still rides on
 * the rejection either way.
 */

const path = require('path');
const fs = require('fs').promises;

let mockNextText = '';

jest.mock('unpdf', () => ({
  getDocumentProxy: jest.fn(async () => ({ destroy: jest.fn(async () => undefined) })),
  extractText: jest.fn(async () => ({ text: mockNextText, totalPages: 1 }))
}));

const {
  extractTextFromPdf,
  extractTextFromPdfRaw,
  shutdownPdfBufferCache,
  _pdfBufferCacheSizeForTests
} = require('../src/main/analysis/documentExtractors');

const TEST_DIR = '/tmp/pdf-no-pin-test';
const AI_PATH = path.join(TEST_DIR, 'logo.ai');

describe('extractTextFromPdf pinForOcr option', () => {
  beforeEach(async () => {
    mockNextText = '';
    await fs.mkdir(TEST_DIR, { recursive: true });
    await fs.writeFile(AI_PATH, Buffer.from('%PDF-1.5 fake illustrator content'));
  });

  afterEach(async () => {
    await shutdownPdfBufferCache();
  });

  test('control: by default a text-less file is pinned for OCR', async () => {
    await expect(extractTextFromPdfRaw(AI_PATH, 'logo.ai')).rejects.toMatchObject({
      code: 'PDF_NO_TEXT_CONTENT'
    });
    expect(_pdfBufferCacheSizeForTests()).toBe(1);
  });

  test('pinForOcr: false leaves the cache empty', async () => {
    await expect(
      extractTextFromPdfRaw(AI_PATH, 'logo.ai', { pinForOcr: false })
    ).rejects.toMatchObject({ code: 'PDF_NO_TEXT_CONTENT' });
    expect(_pdfBufferCacheSizeForTests()).toBe(0);
  });

  test('the timeout wrapper passes pinForOcr through and the thin text survives', async () => {
    mockNextText = 'ACME Corp';
    await expect(
      extractTextFromPdf(AI_PATH, 'logo.ai', { pinForOcr: false })
    ).rejects.toMatchObject({
      code: 'PDF_NO_TEXT_CONTENT',
      metadata: expect.objectContaining({ textLayer: 'ACME Corp' })
    });
    expect(_pdfBufferCacheSizeForTests()).toBe(0);
  });
});
