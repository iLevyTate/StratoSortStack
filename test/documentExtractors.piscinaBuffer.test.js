/**
 * @jest-environment node
 *
 * Regression guard for the Piscina worker-result buffer wrap in
 * `documentExtractors.js` (PDF rasterize + Office image OCR paths).
 *
 * Why this test exists
 * --------------------
 * Piscina deserializes worker results across the structured-clone
 * boundary as `Uint8Array`, NOT Node `Buffer`. Node Buffer is a Uint8Array
 * subclass at the binary level, but downstream consumers — sharp,
 * tesseract.js — type-check via `Buffer.isBuffer(value)` (or attempt a
 * URL coercion that throws "Invalid url value" on a plain Uint8Array).
 *
 * Pre-fix: when the worker pool was active, `rasterPng` was the raw
 * Uint8Array from the worker, and tesseract failed silently with
 * "Invalid url value" — OCR returned ''. The fix wraps with
 * `Buffer.from(workerResult.buffer)` only when the result isn't already
 * a Buffer (so the worker-fallback paths that use sync sharp aren't
 * round-tripped unnecessarily).
 *
 * Behavioral contract guarded here:
 *   1. Worker-pool result with `buffer` as a Uint8Array -> the value
 *      passed downstream to tesseract is a real Node `Buffer`
 *      (`Buffer.isBuffer === true`) AND its bytes are preserved verbatim.
 *   2. Worker-pool result with `buffer` already as a `Buffer` is
 *      forwarded as-is — no needless re-allocation.
 */

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

// Tesseract is the downstream consumer of `rasterPng`. We capture what
// the production code passes us so the test can assert on its type.
// Names are `mock*` so jest.mock's factory-hoisting guard accepts them.
const mockRecognizeIfAvailable = jest.fn().mockResolvedValue({ success: true, text: 'ocr text' });
const mockIsTesseractAvailable = jest.fn().mockResolvedValue(true);
jest.mock('../src/main/utils/tesseractUtils', () => ({
  isTesseractAvailable: (...args) => mockIsTesseractAvailable(...args),
  recognizeIfAvailable: (...args) => mockRecognizeIfAvailable(...args)
}));

// Worker pool returns `{ buffer: Uint8Array, width, height }`. The test
// configures the buffer per-case to drive the Buffer-wrap branch.
const mockWorkerRun = jest.fn();
jest.mock('../src/main/utils/workerPools', () => ({
  getImagePreprocessPool: () => ({ run: (...args) => mockWorkerRun(...args) })
}));

// `getSharp` returns a non-null callable; we never reach the sharp path
// because the worker-pool branch fires first.
jest.mock('sharp', () => jest.fn(() => ({})));

// fs.stat / fs.readFile drive the OCR entry guards (size limit, buffer
// load). The actual bytes don't matter — the worker mock supplies the
// buffer that downstream consumes.
const fs = require('fs').promises;
jest.spyOn(fs, 'stat').mockResolvedValue({ size: 1024 });
jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('fake-pdf-bytes'));

// Use the *Raw* (no-timeout) export so the test runs synchronously
// against the real ocrPdfIfNeeded function under test.
const { ocrPdfIfNeededRaw } = require('../src/main/analysis/documentExtractors');

describe('ocrPdfIfNeeded — Piscina Uint8Array -> Buffer wrap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('a Uint8Array worker result is wrapped in a real Node Buffer before reaching tesseract', async () => {
    // Construct a Uint8Array that is NOT a Buffer instance. Buffers are
    // Uint8Array subclasses, so we use the parent constructor explicitly.
    const expectedBytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]; // PNG magic
    const u8 = new Uint8Array(expectedBytes);
    expect(Buffer.isBuffer(u8)).toBe(false); // sanity: pre-condition for the regression

    mockWorkerRun.mockResolvedValueOnce({
      buffer: u8,
      width: 1024,
      height: 768
    });

    await ocrPdfIfNeededRaw('C:\\fake.pdf');

    expect(mockRecognizeIfAvailable).toHaveBeenCalledTimes(1);
    const [, passedToTesseract] = mockRecognizeIfAvailable.mock.calls[0];

    // The actual contract: tesseract receives a real Node Buffer.
    expect(Buffer.isBuffer(passedToTesseract)).toBe(true);
    // Bytes preserved verbatim — Buffer.from(Uint8Array) shares memory but
    // exposes Buffer methods; the byte sequence MUST match.
    expect(Array.from(passedToTesseract)).toEqual(expectedBytes);
  });

  test('a Buffer worker result is forwarded as-is (no needless re-wrap)', async () => {
    const original = Buffer.from([1, 2, 3, 4]);

    mockWorkerRun.mockResolvedValueOnce({
      buffer: original,
      width: 100,
      height: 100
    });

    await ocrPdfIfNeededRaw('C:\\fake.pdf');

    expect(mockRecognizeIfAvailable).toHaveBeenCalledTimes(1);
    const [, passedToTesseract] = mockRecognizeIfAvailable.mock.calls[0];

    // Same Buffer instance — the production guard short-circuits when
    // `Buffer.isBuffer(workerResult.buffer)` is already true.
    expect(passedToTesseract).toBe(original);
    expect(Buffer.isBuffer(passedToTesseract)).toBe(true);
  });
});
