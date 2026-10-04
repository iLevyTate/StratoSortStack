/**
 * @jest-environment node
 *
 * Behavioural coverage for the zip uncompressed-size pre-scan that guards the
 * eager office inflaters (mammoth / xlsx-populate / officeparser). Fixtures are
 * real zip byte streams written to the (memfs-backed) tmp dir: some produced by
 * adm-zip, some hand-built so the central directory can lie about sizes the
 * way a zip bomb does.
 */

const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const AdmZip = require('adm-zip');

jest.mock('mammoth', () => ({ extractRawText: jest.fn() }));
jest.mock('officeparser', () => ({ parseOffice: jest.fn() }));
jest.mock('../src/main/analysis/analysisLimits', () => ({
  getAnalysisLimits: jest.fn().mockResolvedValue({ maxDocumentFileSize: 200 * 1024 * 1024 }),
  getDefaultLimits: jest.fn().mockReturnValue({ maxDocumentFileSize: 200 * 1024 * 1024 }),
  invalidateCache: jest.fn()
}));

const {
  assertZipUncompressedCap,
  extractTextFromDocxRaw,
  extractTextFromPptxRaw,
  MAX_ZIP_UNCOMPRESSED_TOTAL
} = require('../src/main/analysis/documentExtractors');
const { logger } = require('../src/shared/logger');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const ZIP64_EXTRA_ID = 0x0001;
const UINT32_MAX = 0xffffffff;

/**
 * Build a stored (method 0) zip whose central directory declares
 * `declaredSize` for each entry regardless of the bytes actually present.
 * Sizes above 0xFFFFFFFF are written via the zip64 extended-information field.
 * @param {Array<{ name: string, data?: Buffer, declaredSize?: number }>} entries
 * @param {string} [comment]
 */
function buildZip(entries, comment = '') {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data ?? Buffer.alloc(0);
    const declared = entry.declaredSize ?? data.length;
    const needsZip64 = declared > UINT32_MAX;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    let extra = Buffer.alloc(0);
    if (needsZip64) {
      extra = Buffer.alloc(12);
      extra.writeUInt16LE(ZIP64_EXTRA_ID, 0);
      extra.writeUInt16LE(8, 2);
      extra.writeBigUInt64LE(BigInt(declared), 4);
    }

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(needsZip64 ? UINT32_MAX : declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name, extra);

    offset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const commentBytes = Buffer.from(comment, 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(commentBytes.length, 20);

  return Buffer.concat([...localParts, centralDirectory, eocd, commentBytes]);
}

describe('assertZipUncompressedCap', () => {
  let fixtureDir;
  let counter = 0;

  const writeFixture = async (bytes, ext = '.zip') => {
    counter += 1;
    const filePath = path.join(fixtureDir, `fixture-${counter}${ext}`);
    await fs.writeFile(filePath, bytes);
    return filePath;
  };

  beforeAll(async () => {
    fixtureDir = path.join(os.tmpdir(), `zip-cap-${Date.now()}`);
    await fs.mkdir(fixtureDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(fixtureDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('exposes the production cap', () => {
    expect(MAX_ZIP_UNCOMPRESSED_TOTAL).toBe(256 * 1024 * 1024);
  });

  test('accepts a real deflated archive whose inflated total is under the cap', async () => {
    const zip = new AdmZip();
    zip.addFile('word/document.xml', Buffer.from('<w:t>hello</w:t>'.repeat(300)));
    zip.addFile('word/styles.xml', Buffer.from('<style/>'.repeat(100)));
    const filePath = await writeFixture(zip.toBuffer());

    await expect(
      assertZipUncompressedCap(filePath, 'DOCX', { maxUncompressedBytes: 10 * 1024 })
    ).resolves.toBeUndefined();
  });

  test('rejects a real deflated archive whose inflated total exceeds the cap', async () => {
    const zip = new AdmZip();
    zip.addFile('word/document.xml', Buffer.alloc(6000, 0x41));
    zip.addFile('word/media/image1.png', Buffer.alloc(6000, 0x42));
    zip.addZipComment('trailing comment exercises the EOCD backward scan');
    const filePath = await writeFixture(zip.toBuffer());

    await expect(
      assertZipUncompressedCap(filePath, 'DOCX', { maxUncompressedBytes: 10000 })
    ).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
      metadata: { fileSize: 12000, maxSize: 10000 }
    });
  });

  test('rejects on declared size alone, without needing the payload on disk', async () => {
    // 300 MB declared across two entries; the file itself is a few hundred bytes.
    const bytes = buildZip([
      { name: 'ppt/slides/slide1.xml', data: Buffer.from('<p/>'), declaredSize: 150 * 1024 * 1024 },
      { name: 'ppt/slides/slide2.xml', data: Buffer.from('<p/>'), declaredSize: 150 * 1024 * 1024 }
    ]);
    const filePath = await writeFixture(bytes);

    await expect(assertZipUncompressedCap(filePath, 'PPTX')).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
      metadata: { fileSize: 300 * 1024 * 1024, maxSize: MAX_ZIP_UNCOMPRESSED_TOTAL }
    });
  });

  test('reads zip64 extended sizes when the header size is the 0xFFFFFFFF marker', async () => {
    const fiveGiB = 5 * 1024 * 1024 * 1024;
    const bytes = buildZip([
      { name: 'word/document.xml', data: Buffer.from('<w:t/>'), declaredSize: fiveGiB }
    ]);
    const filePath = await writeFixture(bytes);

    await expect(assertZipUncompressedCap(filePath, 'DOCX')).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
      metadata: { fileSize: fiveGiB }
    });
  });

  test('defers to the extractor (resolves, debug log) when the container is malformed', async () => {
    const garbage = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('this is not a central directory'.repeat(4))
    ]);
    const filePath = await writeFixture(garbage);

    await expect(assertZipUncompressedCap(filePath, 'DOCX')).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('[DOCX] Zip pre-scan skipped'),
      expect.objectContaining({ filePath })
    );
  });

  test('defers to the extractor when the central directory is truncated', async () => {
    const zip = new AdmZip();
    zip.addFile('word/document.xml', Buffer.from('<w:t>hi</w:t>'));
    const whole = zip.toBuffer();
    // Keep the EOCD but chop bytes out of the directory it points at.
    const eocd = whole.subarray(whole.length - 22);
    const truncated = Buffer.concat([whole.subarray(0, whole.length - 40), eocd]);
    const filePath = await writeFixture(truncated);

    await expect(assertZipUncompressedCap(filePath, 'DOCX')).resolves.toBeUndefined();
  });

  test('resolves for a missing file and leaves the read error to the extractor', async () => {
    await expect(
      assertZipUncompressedCap(path.join(fixtureDir, 'does-not-exist.docx'), 'DOCX')
    ).resolves.toBeUndefined();
  });

  describe('extractor integration', () => {
    test('PPTX: over-cap declared size fails before officeparser runs', async () => {
      const officeParser = require('officeparser');
      const bytes = buildZip([
        {
          name: 'ppt/slides/slide1.xml',
          data: Buffer.from('<p/>'),
          declaredSize: 300 * 1024 * 1024
        }
      ]);
      const filePath = await writeFixture(bytes, '.pptx');

      await expect(extractTextFromPptxRaw(filePath)).rejects.toMatchObject({
        code: 'FILE_TOO_LARGE'
      });
      expect(officeParser.parseOffice).not.toHaveBeenCalled();
    });

    test('DOCX: over-cap declared size fails before mammoth runs', async () => {
      const mammoth = require('mammoth');
      const bytes = buildZip([
        { name: 'word/document.xml', data: Buffer.from('<w:t/>'), declaredSize: 300 * 1024 * 1024 }
      ]);
      const filePath = await writeFixture(bytes, '.docx');

      await expect(extractTextFromDocxRaw(filePath)).rejects.toMatchObject({
        code: 'FILE_TOO_LARGE'
      });
      expect(mammoth.extractRawText).not.toHaveBeenCalled();
    });

    test('DOCX: a container the pre-scan cannot parse still reaches mammoth', async () => {
      const mammoth = require('mammoth');
      mammoth.extractRawText.mockResolvedValue({ value: 'Recovered by mammoth' });
      const garbage = Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        Buffer.from('tolerated-by-a-lenient-parser'.repeat(3))
      ]);
      const filePath = await writeFixture(garbage, '.docx');

      await expect(extractTextFromDocxRaw(filePath)).resolves.toBe('Recovered by mammoth');
      expect(mammoth.extractRawText).toHaveBeenCalledWith({ path: filePath });
    });
  });
});
