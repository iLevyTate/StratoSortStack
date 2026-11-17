/**
 * @jest-environment node
 *
 * A workbook whose spreadsheet XML binds the main namespace to a prefix
 * ("<x:worksheet>", "<x:row>"), as Visio and .NET (Open XML SDK) exports
 * write it, used to read as empty: the readers matched unprefixed tags only.
 * Real files in a temp dir; synthetic content only.
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const fsSync = require('fs');
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

const AdmZip = require('adm-zip');
const { extractTextFromXlsx } = require('../src/main/analysis/documentExtractors');

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A minimal workbook with every spreadsheet element written as "x:<name>". */
function prefixedWorkbook(file) {
  const zip = new AdmZip();
  const add = (name, xml) => zip.addFile(name, Buffer.from(xml, 'utf8'));
  add(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
      '</Types>'
  );
  add(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>'
  );
  add(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
      '</Relationships>'
  );
  add(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8"?><x:workbook xmlns:x="${MAIN_NS}" xmlns:r="${REL_NS}">` +
      '<x:sheets><x:sheet name="Shapes" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>'
  );
  add(
    'xl/sharedStrings.xml',
    `<?xml version="1.0" encoding="UTF-8"?><x:sst xmlns:x="${MAIN_NS}" count="4" uniqueCount="4">` +
      '<x:si><x:t>Shape name</x:t></x:si><x:si><x:t>Owner</x:t></x:si>' +
      '<x:si><x:t>Loading dock</x:t></x:si><x:si><x:t>Facilities team</x:t></x:si></x:sst>'
  );
  add(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0" encoding="UTF-8"?><x:worksheet xmlns:x="${MAIN_NS}"><x:sheetData>` +
      '<x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1" t="s"><x:v>1</x:v></x:c>' +
      '<x:c r="C1" t="inlineStr"><x:is><x:t>Area m2</x:t></x:is></x:c></x:row>' +
      '<x:row r="2"><x:c r="A2" t="s"><x:v>2</x:v></x:c><x:c r="B2" t="s"><x:v>3</x:v></x:c>' +
      '<x:c r="C2"><x:v>412</x:v></x:c></x:row>' +
      '</x:sheetData></x:worksheet>'
  );
  zip.writeZip(file);
}

describe('XLSX with a prefixed spreadsheet namespace', () => {
  let tmpDir;
  let xlsxPath;

  beforeAll(() => {
    tmpDir = fsSync.mkdtempSync(
      path.join(jest.requireActual('os').tmpdir(), 'stratosort-xlsx-prefix-')
    );
    xlsxPath = path.join(tmpDir, 'floor-plan-shapes.xlsx');
    prefixedWorkbook(xlsxPath);
  });

  afterAll(() => {
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('reads its shared strings, inline strings and numbers', async () => {
    const text = await extractTextFromXlsx(xlsxPath);
    expect(text).toContain('Shape name');
    expect(text).toContain('Owner');
    expect(text).toContain('Area m2');
    expect(text).toContain('Loading dock');
    expect(text).toContain('Facilities team');
    expect(text).toContain('412');
  });
});
