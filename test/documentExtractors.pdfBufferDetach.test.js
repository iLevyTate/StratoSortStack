/**
 * @jest-environment node
 *
 * Regression: pdf.js (via unpdf) can TRANSFER the ArrayBuffer backing the
 * input typed array to its worker, detaching it. extractTextFromPdf caches the
 * raw Buffer for OCR reuse and hands extractText a VIEW over the same
 * ArrayBuffer — so after detachment the cache holds a zero-length (but truthy)
 * Buffer. ocrPdfIfNeeded's `cache.get(path) || fs.readFile(path)` then never
 * falls back to disk, the OCR pipeline receives 0 bytes, and a scanned PDF is
 * silently indexed with no content.
 *
 * Oracle: after a detaching extractText, the OCR rasterizer (sharp) must
 * receive the real PDF bytes, not an empty buffer.
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const path = require('path');
const os = require('os');
const fs = require('fs').promises;

const capturedSharpInputs = [];

jest.mock('sharp', () =>
  jest.fn((buffer) => {
    capturedSharpInputs.push(buffer);
    return {
      metadata: jest.fn().mockRejectedValue(new Error('stub: no libvips pdf support')),
      resize: jest.fn().mockReturnThis(),
      png: jest.fn().mockReturnThis(),
      toBuffer: jest.fn().mockRejectedValue(new Error('stub'))
    };
  })
);

jest.mock('../src/main/utils/tesseractUtils', () => ({
  isTesseractAvailable: jest.fn().mockResolvedValue(true),
  recognizeIfAvailable: jest.fn().mockResolvedValue({ text: '' })
}));

jest.mock('../src/main/utils/workerPools', () => ({
  getImagePreprocessPool: jest.fn(() => null)
}));

// unpdf mock simulates pdf.js transferring the input's ArrayBuffer to a
// worker when the document is opened (structuredClone with transfer detaches
// the source), then reporting no text layer — the scanned-PDF case that
// triggers the OCR fallback.
jest.mock('unpdf', () => ({
  getDocumentProxy: jest.fn(async (input) => {
    structuredClone(input.buffer, { transfer: [input.buffer] });
    return { destroy: jest.fn() };
  }),
  extractText: jest.fn(async () => ({ text: '' }))
}));

describe('scanned-PDF OCR fallback survives pdf.js buffer detachment', () => {
  let testDir;
  let pdfPath;
  const PDF_BYTES = Buffer.from('%PDF-1.4 fake scanned pdf content for detach test');

  beforeAll(async () => {
    testDir = path.join(os.tmpdir(), `pdf-detach-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    pdfPath = path.join(testDir, 'scanned.pdf');
    await fs.writeFile(pdfPath, PDF_BYTES);
  });

  afterAll(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('OCR path receives real PDF bytes when extraction detached the cached buffer', async () => {
    const {
      extractTextFromPdfRaw,
      ocrPdfIfNeededRaw
    } = require('../src/main/analysis/documentExtractors');

    // 1. Extraction: unpdf detaches the buffer and reports no text layer.
    await expect(extractTextFromPdfRaw(pdfPath, 'scanned.pdf')).rejects.toMatchObject({
      code: 'PDF_NO_TEXT_CONTENT'
    });

    // 2. OCR fallback: must not trust the (now detached, zero-length) cache
    //    entry — sharp must be handed the actual on-disk bytes.
    const text = await ocrPdfIfNeededRaw(pdfPath, {});
    expect(typeof text).toBe('string'); // pipeline degrades gracefully in stub env

    expect(capturedSharpInputs).toHaveLength(1);
    expect(capturedSharpInputs[0].length).toBe(PDF_BYTES.length);
  });
});
