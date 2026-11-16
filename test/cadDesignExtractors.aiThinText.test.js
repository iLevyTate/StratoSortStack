/**
 * @jest-environment node
 *
 * A PDF-compatible .ai file whose type is outlined (a logo) has no or a thin
 * text layer, and the PDF reader rejects it with PDF_NO_TEXT_CONTENT so OCR
 * can run. Nothing runs OCR on the .ai route, so extractTextFromAi used to
 * let the rejection escape and the file got a filename-only result. It now
 * keeps the thin text the rejection carries, or falls back to the
 * PostScript view. Fixtures live on the memfs-backed filesystem.
 */

const fs = require('fs');

const { extractTextFromAi } = require('../src/main/analysis/extractors/cadDesignExtractors');

const FIXTURE_DIR = '/fixtures-ai-thin';

function writeFixture(name, data) {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const filePath = `${FIXTURE_DIR}/${name}`;
  fs.writeFileSync(filePath, data);
  return filePath;
}

function noTextError(textLayer) {
  const err = new Error('PDF has no text');
  Object.assign(err, { code: 'PDF_NO_TEXT_CONTENT', metadata: { textLayer } });
  return err;
}

const PDF_COMPATIBLE_AI = [
  '%PDF-1.5',
  '%%Creator: Adobe Illustrator(R) 24.0',
  '%%Title: (acme-logo.ai)',
  '%%BoundingBox: 0 0 200 100',
  '1 0 obj << /Type /Catalog >> endobj',
  ''
].join('\n');

describe('extractTextFromAi with a text-less PDF layer', () => {
  test('returns the thin text layer the PDF reader rejected', async () => {
    const filePath = writeFixture('thin.ai', PDF_COMPATIBLE_AI);
    const extractTextFromPdf = jest.fn().mockRejectedValue(noTextError('ACME Corp'));
    await expect(extractTextFromAi(filePath, { extractTextFromPdf })).resolves.toBe('ACME Corp');
  });

  test('falls back to the PostScript view when the PDF layer is empty', async () => {
    const filePath = writeFixture('outlined.ai', PDF_COMPATIBLE_AI);
    const extractTextFromPdf = jest.fn().mockRejectedValue(noTextError(''));
    const text = await extractTextFromAi(filePath, { extractTextFromPdf });
    expect(text.split('\n')[0]).toBe(
      'Adobe Illustrator document (PDF-compatible, PostScript view)'
    );
    expect(text).toContain('Title: acme-logo.ai');
  });

  test('falls back to the PostScript view when the PDF reader resolves blank', async () => {
    const filePath = writeFixture('blank.ai', PDF_COMPATIBLE_AI);
    const extractTextFromPdf = jest.fn().mockResolvedValue('   ');
    const text = await extractTextFromAi(filePath, { extractTextFromPdf });
    expect(text).toContain('Title: acme-logo.ai');
  });

  test('rethrows every other PDF error unchanged', async () => {
    const filePath = writeFixture('locked.ai', PDF_COMPATIBLE_AI);
    const encrypted = Object.assign(new Error('encrypted'), { code: 'PDF_ENCRYPTED' });
    await expect(
      extractTextFromAi(filePath, { extractTextFromPdf: jest.fn().mockRejectedValue(encrypted) })
    ).rejects.toBe(encrypted);

    const cancelled = Object.assign(new Error('cancelled'), { code: 'OPERATION_CANCELLED' });
    await expect(
      extractTextFromAi(filePath, { extractTextFromPdf: jest.fn().mockRejectedValue(cancelled) })
    ).rejects.toBe(cancelled);
  });
});
