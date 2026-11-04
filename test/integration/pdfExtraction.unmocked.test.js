/**
 * PDF extraction through the real unpdf / PDF.js, not a mock.
 *
 * Every other PDF test mocks unpdf: it ships only ESM, which Jest's CommonJS
 * runtime cannot import. That let unpdf 2.x (which needs Node >= 22 for the
 * global Iterator) pass the whole suite while it could not load PDF.js on the
 * Node 20 toolchain. This runs extractTextFromPdf in a child Node process,
 * where the extractor's `import('unpdf')` fallback works, on the same Node
 * that runs Jest (.nvmrc pins the Node inside Electron).
 */

const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'test-files');

// The logger shares stdout, so the child puts its result on its own marked line.
const MARK = '@@pdf-result@@';

const CHILD = [
  "const path = require('path');",
  "const { extractTextFromPdf } = require(path.join(process.cwd(), 'src/main/analysis/documentExtractors.js'));",
  `const report = (result) => process.stdout.write('\\n${MARK}' + JSON.stringify(result) + '\\n');`,
  'extractTextFromPdf(process.argv[1], path.basename(process.argv[1])).then(',
  '  (text) => report({ ok: true, text }),',
  '  (error) => report({ ok: false, message: error.message })',
  ');'
].join('\n');

function extract(fileName) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ['-e', CHILD, path.join(FIXTURES, fileName)],
      { cwd: ROOT, timeout: 60000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`child failed: ${error.message}\n${stderr}`));
          return;
        }
        const line = stdout.split(/\r?\n/).find((l) => l.startsWith(MARK));
        if (!line) {
          reject(new Error(`no result from child:\n${stdout}\n${stderr}`));
          return;
        }
        resolve(JSON.parse(line.slice(MARK.length)));
      }
    );
  });
}

describe('PDF extraction with the real unpdf', () => {
  test('reads the text layer of a multi-page PDF', async () => {
    const result = await extract('Annual_Financial_Statement_2024.pdf');
    expect(result).toEqual({ ok: true, text: expect.any(String) });
    expect(result.text).toContain('Fiscal Year 2024 Financial Results');
    expect(result.text).toContain('Net Cash Flow 455000');
  }, 90000);

  test('a PDF with too little text is refused so it goes to OCR', async () => {
    const result = await extract('sample.pdf');
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/no extractable text/i) });
  }, 90000);
});
