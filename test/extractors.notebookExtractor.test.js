/**
 * Tests for the Jupyter notebook (.ipynb) extractor.
 *
 * `fs` here is the memfs mock installed by test-setup.js, so fixtures are
 * written into the in-memory volume before each test. The logger is the
 * global mock.
 */

const fs = require('fs');

const { logger } = require('./mocks/logger');
const { extractTextFromIpynb } = require('../src/main/analysis/extractors/notebookExtractor');

const FIXTURES = '/fixtures';
let counter = 0;

/**
 * Write a notebook fixture. Objects are serialized; strings/Buffers are raw.
 * @param {object | string | Buffer} content
 * @returns {string} the path
 */
function writeNotebook(content) {
  counter += 1;
  fs.mkdirSync(FIXTURES, { recursive: true });
  const file = `${FIXTURES}/nb-${counter}.ipynb`;
  const data =
    typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content);
  fs.writeFileSync(file, data);
  return file;
}

/** Minimal nbformat 4 shell around the given cells. */
function notebook(cells, metadata = {}) {
  return { nbformat: 4, nbformat_minor: 5, metadata, cells };
}

describe('extractTextFromIpynb', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('renders header, markdown, code, raw and text outputs in order', async () => {
    const file = writeNotebook(
      notebook(
        [
          {
            cell_type: 'markdown',
            metadata: {},
            source: ['# Analysis\n', '\n', 'Some **prose** here.']
          },
          {
            cell_type: 'code',
            metadata: {},
            execution_count: 1,
            source: ['import math\n', 'print(math.pi)\n'],
            outputs: [{ output_type: 'stream', name: 'stdout', text: ['3.141592653589793\n'] }]
          },
          {
            cell_type: 'code',
            metadata: {},
            execution_count: 2,
            source: 'x = 42\nx',
            outputs: [
              {
                output_type: 'execute_result',
                execution_count: 2,
                data: { 'text/plain': '42' },
                metadata: {}
              }
            ]
          },
          { cell_type: 'raw', metadata: {}, source: 'raw cell body' }
        ],
        {
          kernelspec: { display_name: 'Python 3 (ipykernel)', name: 'python3' },
          language_info: { name: 'python' }
        }
      )
    );

    const out = await extractTextFromIpynb(file);
    expect(out).toBe(
      [
        'Jupyter notebook (Python 3 (ipykernel))',
        '# Analysis\n\nSome **prose** here.',
        '[code]\nimport math\nprint(math.pi)',
        '[output] 3.141592653589793',
        '[code]\nx = 42\nx',
        '[output] 42',
        'raw cell body'
      ].join('\n\n')
    );
  });

  test('falls back to language_info.name for the header, then plain "Jupyter notebook"', async () => {
    const withLang = writeNotebook(
      notebook([{ cell_type: 'markdown', source: 'hi' }], { language_info: { name: 'julia' } })
    );
    expect(await extractTextFromIpynb(withLang)).toBe('Jupyter notebook (julia)\n\nhi');

    const noMeta = writeNotebook(notebook([{ cell_type: 'markdown', source: 'hi' }]));
    expect(await extractTextFromIpynb(noMeta)).toBe('Jupyter notebook\n\nhi');
  });

  test('accepts outputs and sources as arrays or strings, and multi-line outputs', async () => {
    const file = writeNotebook(
      notebook([
        {
          cell_type: 'code',
          source: 'print("a")',
          outputs: [
            { output_type: 'stream', name: 'stdout', text: 'line one\nline two\n' },
            { output_type: 'display_data', data: { 'text/plain': ['<Figure size 640x480>'] } },
            { output_type: 'execute_result', data: { 'text/plain': ['row 1\n', 'row 2'] } },
            { output_type: 'stream', name: 'stderr', text: ['warn 1\n', 'warn 2\n'] }
          ]
        }
      ])
    );
    const out = await extractTextFromIpynb(file);
    expect(out).toContain('[code] print("a")');
    expect(out).toContain('[output]\nline one\nline two');
    expect(out).toContain('[output] <Figure size 640x480>');
    expect(out).toContain('[output]\nrow 1\nrow 2');
    expect(out).toContain('[output]\nwarn 1\nwarn 2');
  });

  test('skips image, HTML and error outputs but keeps text/plain alongside them', async () => {
    const file = writeNotebook(
      notebook([
        {
          cell_type: 'code',
          source: 'plot()',
          outputs: [
            {
              output_type: 'display_data',
              data: {
                'image/png': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk',
                'text/html': '<div>should not appear</div>',
                'text/plain': '<matplotlib.figure.Figure at 0x7f>'
              }
            },
            {
              output_type: 'display_data',
              data: { 'image/svg+xml': '<svg><text>nope</text></svg>' }
            },
            {
              output_type: 'error',
              ename: 'ValueError',
              evalue: 'bad',
              traceback: ['Traceback (most recent call last)']
            }
          ]
        }
      ])
    );
    const out = await extractTextFromIpynb(file);
    expect(out).toContain('[output] <matplotlib.figure.Figure at 0x7f>');
    expect(out).not.toMatch(/iVBORw0|should not appear|nope|Traceback|ValueError/);
    expect((out.match(/\[output\]/g) || []).length).toBe(1);
  });

  test('caps output text per cell across all of its outputs', async () => {
    const file = writeNotebook(
      notebook([
        {
          cell_type: 'code',
          source: 'spam()',
          outputs: [
            { output_type: 'stream', name: 'stdout', text: 'a'.repeat(60) },
            { output_type: 'stream', name: 'stdout', text: 'b'.repeat(60) },
            { output_type: 'stream', name: 'stdout', text: 'c'.repeat(60) }
          ]
        },
        {
          cell_type: 'code',
          source: 'next()',
          outputs: [{ output_type: 'stream', name: 'stdout', text: 'fresh budget' }]
        }
      ])
    );
    const out = await extractTextFromIpynb(file, { maxOutputCharsPerCell: 100 });
    const outputs = out.split('\n\n').filter((seg) => seg.startsWith('[output]'));
    expect(outputs).toHaveLength(3);
    expect(outputs[0]).toBe('[output] ' + 'a'.repeat(60));
    expect(outputs[1]).toBe('[output] ' + 'b'.repeat(40) + '…');
    expect(out).not.toContain('c'.repeat(5));
    expect(outputs[2]).toBe('[output] fresh budget');
  });

  test('maxOutputCharsPerCell of 0 drops outputs entirely', async () => {
    const file = writeNotebook(
      notebook([
        { cell_type: 'code', source: 'x', outputs: [{ output_type: 'stream', text: 'gone' }] }
      ])
    );
    const out = await extractTextFromIpynb(file, { maxOutputCharsPerCell: 0 });
    expect(out).toBe('Jupyter notebook\n\n[code] x');
  });

  test('strips ANSI colour codes and CRLF from outputs', async () => {
    const file = writeNotebook(
      notebook([
        {
          cell_type: 'code',
          source: 'x',
          outputs: [{ output_type: 'stream', text: '\u001b[31mred\u001b[0m\r\nplain\r\n' }]
        }
      ])
    );
    const out = await extractTextFromIpynb(file);
    expect(out).toContain('[output]\nred\nplain');
    expect(out).not.toContain('\u001b');
  });

  test('returns empty string and logs on invalid JSON', async () => {
    const file = writeNotebook('{"cells": [ this is not json');
    expect(await extractTextFromIpynb(file)).toBe('');
    expect(logger.debug).toHaveBeenCalled();
  });

  test('returns empty string for JSON that is not a notebook object', async () => {
    expect(await extractTextFromIpynb(writeNotebook('[1, 2, 3]'))).toBe('');
    expect(await extractTextFromIpynb(writeNotebook('"just a string"'))).toBe('');
    expect(await extractTextFromIpynb(writeNotebook('null'))).toBe('');
  });

  test('returns empty string when cells are missing or empty', async () => {
    expect(await extractTextFromIpynb(writeNotebook({ nbformat: 4, metadata: {} }))).toBe('');
    expect(await extractTextFromIpynb(writeNotebook(notebook([])))).toBe('');
    expect(await extractTextFromIpynb(writeNotebook(notebook('not an array')))).toBe('');
    expect(await extractTextFromIpynb(writeNotebook(''))).toBe('');
    expect(await extractTextFromIpynb(writeNotebook(notebook([null, 5, 'x'])))).toBe('');
  });

  test('skips cells with empty or non-string sources but keeps the rest', async () => {
    const file = writeNotebook(
      notebook([
        { cell_type: 'markdown', source: '' },
        { cell_type: 'markdown', source: [] },
        { cell_type: 'code', source: 42, outputs: [] },
        { cell_type: 'markdown', source: ['   \n'] },
        { cell_type: 'markdown', source: 'kept' },
        { cell_type: 'mystery', source: 'unknown type kept as text' },
        { cell_type: 'markdown' }
      ])
    );
    expect(await extractTextFromIpynb(file)).toBe(
      'Jupyter notebook\n\nkept\n\nunknown type kept as text'
    );
  });

  test('joins array sources whose lines lack trailing newlines', async () => {
    const file = writeNotebook(
      notebook([{ cell_type: 'code', source: ['a = 1', 'b = 2\n', 'c = 3'], outputs: [] }])
    );
    expect(await extractTextFromIpynb(file)).toContain('[code]\na = 1\nb = 2\nc = 3');
  });

  test('strips a UTF-8 BOM before parsing', async () => {
    const body = Buffer.from(
      JSON.stringify(notebook([{ cell_type: 'markdown', source: 'bom ok' }]))
    );
    const file = writeNotebook(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]));
    expect(await extractTextFromIpynb(file)).toBe('Jupyter notebook\n\nbom ok');
  });

  test('reads nbformat 3 worksheets with input/pyout fields', async () => {
    const file = writeNotebook({
      nbformat: 3,
      metadata: { kernelspec: { display_name: 'Py2' } },
      worksheets: [
        {
          cells: [
            { cell_type: 'markdown', source: ['Old style'] },
            {
              cell_type: 'code',
              input: ['1 + 1'],
              outputs: [{ output_type: 'pyout', text: ['2'] }]
            }
          ]
        }
      ]
    });
    expect(await extractTextFromIpynb(file)).toBe(
      'Jupyter notebook (Py2)\n\nOld style\n\n[code] 1 + 1\n\n[output] 2'
    );
  });

  test('truncates to maxChars and stops iterating once the cap is reached', async () => {
    const cells = [];
    for (let i = 0; i < 500; i += 1)
      cells.push({ cell_type: 'markdown', source: `cell ${i} ` + 'x'.repeat(50) });
    const file = writeNotebook(notebook(cells));
    const out = await extractTextFromIpynb(file, { maxChars: 300 });
    expect(out.length).toBe(300);
    expect(out.startsWith('Jupyter notebook\n\ncell 0 ')).toBe(true);
    expect(await extractTextFromIpynb(file, { maxChars: 0 })).toBe('');
  });

  test('returns empty string for files above the byte cap without reading them', async () => {
    const file = writeNotebook(notebook([{ cell_type: 'markdown', source: 'too big' }]));
    expect(await extractTextFromIpynb(file, { maxBytes: 10 })).toBe('');
    expect(logger.debug).toHaveBeenCalled();
    expect(await extractTextFromIpynb(file)).toContain('too big');
  });

  test('propagates real filesystem errors', async () => {
    await expect(extractTextFromIpynb(`${FIXTURES}/does-not-exist.ipynb`)).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  test('returns empty string for an invalid path argument', async () => {
    expect(await extractTextFromIpynb('')).toBe('');
    expect(await extractTextFromIpynb(null)).toBe('');
    expect(await extractTextFromIpynb(undefined)).toBe('');
  });
});

describe('extractTextFromIpynb adversarial inputs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('an empty file yields empty string', async () => {
    const file = writeNotebook(Buffer.alloc(0));
    expect(fs.statSync(file).size).toBe(0);
    expect(await extractTextFromIpynb(file)).toBe('');
  });

  test('one-byte files yield empty string without throwing', async () => {
    for (const byte of ['{', '[', '"', ' ', '\n', '0', '\0', 'x']) {
      expect(await extractTextFromIpynb(writeNotebook(Buffer.from(byte)))).toBe('');
    }
    expect(await extractTextFromIpynb(writeNotebook(Buffer.from([0xff])))).toBe('');
    expect(await extractTextFromIpynb(writeNotebook(Buffer.from([0xef, 0xbb, 0xbf])))).toBe('');
  });

  test('a header claiming absurd counts or lengths cannot inflate the output', async () => {
    const bogusCount = writeNotebook({
      nbformat: 999999999,
      nbformat_minor: -1,
      metadata: { kernelspec: { display_name: 'k'.repeat(1024 * 1024) } },
      cells: { length: 1e9, 0: { cell_type: 'markdown', source: 'not an array' } }
    });
    expect(await extractTextFromIpynb(bogusCount)).toBe('');

    const hugeName = writeNotebook(
      notebook([{ cell_type: 'code', execution_count: 1e308, source: 'x', outputs: [] }], {
        kernelspec: { display_name: 'K'.repeat(1024 * 1024) }
      })
    );
    const out = await extractTextFromIpynb(hugeName);
    expect(out).toBe(`Jupyter notebook (${'K'.repeat(200)})\n\n[code] x`);

    const nestedCells = writeNotebook('{"cells":'.repeat(50000) + '[]' + '}'.repeat(50000));
    expect(await extractTextFromIpynb(nestedCells)).toBe('');

    const protoKeys = writeNotebook(
      '{"__proto__":{"cells":[{"cell_type":"markdown","source":"polluted"}]},"constructor":{"prototype":{}},' +
        '"cells":[{"cell_type":"markdown","source":"clean","__proto__":{"cell_type":"code"}}]}'
    );
    expect(await extractTextFromIpynb(protoKeys)).toBe('Jupyter notebook\n\nclean');
  });

  test('whitespace-heavy cells and outputs finish quickly (no quadratic trim)', async () => {
    const MB = 1024 * 1024;
    const run = ' \t'.repeat(MB);
    const file = writeNotebook(
      notebook([
        { cell_type: 'markdown', source: `prose${run}` },
        { cell_type: 'markdown', source: [`${run}`, `${run}x`, `${run}`] },
        {
          cell_type: 'code',
          source: `code${'\n'.repeat(MB)}`,
          outputs: [
            { output_type: 'stream', text: `${run}` },
            { output_type: 'stream', text: `${run}z` },
            { output_type: 'execute_result', data: { 'text/plain': [`${run}`, `${run}`] } }
          ]
        },
        { cell_type: 'markdown', source: 'end' }
      ])
    );
    const started = Date.now();
    const out = await extractTextFromIpynb(file, { maxChars: 50 * MB });
    // The quadratic trim this guards against took tens of seconds on this
    // input; the bound leaves room for a slow CI runner (Windows measured
    // 1512 ms against the old 1500 ms ceiling) without losing the signal.
    expect(Date.now() - started).toBeLessThan(6000);
    expect(out.startsWith('Jupyter notebook\n\nprose\n\n')).toBe(true);
    expect(out).toContain('x');
    expect(out).toContain('[code] code');
    expect(out).toContain('…');
    expect(out.endsWith('\n\nend')).toBe(true);
  });

  test('a cell source made of millions of tiny array parts stays fast', async () => {
    const parts = new Array(300000).fill('a\n');
    const file = writeNotebook(
      notebook([
        { cell_type: 'code', source: parts, outputs: [{ output_type: 'stream', text: parts }] }
      ])
    );
    const started = Date.now();
    const out = await extractTextFromIpynb(file, { maxChars: 2 * 1024 * 1024 });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(out).toContain('[code]\na\na\n');
    expect(out).toContain('[output]\na\na\n');
    // The 600 KB output is capped per cell; the 600 KB source is not.
    expect(out.length).toBeGreaterThan(600000);
    expect(out.length).toBeLessThan(610000);
    expect(out.endsWith('…')).toBe(true);
    // With the default cap the whole text is cut at maxChars instead.
    expect((await extractTextFromIpynb(file)).length).toBe(500000);
  });
});
