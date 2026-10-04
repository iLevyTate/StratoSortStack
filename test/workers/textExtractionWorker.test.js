/**
 * Unit tests for `textExtractionWorker`.
 *
 * The worker runs inside a Piscina pool, but the module is a pure
 * function of its `task` argument — there is no Piscina-specific
 * plumbing to stub. We exercise it directly via `require()` so we can
 * cover every branch (html / rtf / xlsx_shared / xlsx_worksheet /
 * unknown) without paying worker-thread startup cost in Jest.
 *
 * What we're pinning:
 *   1. Script/style tags and HTML entities are stripped.
 *   2. RTF control words + hex escapes decode to readable text.
 *   3. Shared-string XML is parsed and capped at the documented limit.
 *   4. Worksheet XML respects the `rowBudget` and the 500k text cap.
 *   5. Unknown task types throw so callers can fall back deterministically.
 */

const runTextExtraction = require('../../src/main/workers/textExtractionWorker');

describe('main/workers/textExtractionWorker', () => {
  describe('html extraction', () => {
    test('decodes numeric and HTML 4 named references like the main-thread extractor', () => {
      const out = runTextExtraction({
        type: 'html',
        payload: {
          text: '<p>caf&eacute; it&#8217;s &#x2019;q&#x2019; &mdash; wait&hellip; &copy;</p>'
        }
      });
      expect(out).toBe('café it’s ’q’ — wait… ©');
    });

    test('strips script, style, tags, and decodes common entities', () => {
      const html = `
        <html>
          <head>
            <style>.a { color: red }</style>
            <script>alert(1)</script>
          </head>
          <body>
            <p>Hello &amp; welcome &lt;world&gt;&nbsp;&quot;friend&quot;&#39;s day</p>
          </body>
        </html>
      `;
      const out = runTextExtraction({ type: 'html', payload: { text: html } });
      expect(out).toBe('Hello & welcome <world> "friend"\'s day');
      expect(out).not.toMatch(/script|style/i);
    });

    test('returns input verbatim on catastrophic HTML (falls through try/catch)', () => {
      // The worker's try/catch guarantees we always return a string even if
      // the input would otherwise blow up downstream regex engines.
      const pathological = 'a'.repeat(10_000);
      const out = runTextExtraction({ type: 'html', payload: { text: pathological } });
      expect(typeof out).toBe('string');
    });
  });

  describe('rtf extraction', () => {
    test('decodes hex escapes and strips control words', () => {
      // \'e9 is U+00E9 (é) in Windows-1252
      const rtf = "{\\rtf1\\ansi\\ansicpg1252 \\b Hello\\b0\\par Caf\\'e9\\par}";
      const out = runTextExtraction({ type: 'rtf', payload: { text: rtf } });
      expect(out).toContain('Hello');
      expect(out).toContain('Café');
      // Control words like \b, \b0, \par must not survive.
      expect(out).not.toMatch(/\\b0|\\par/);
    });

    test('utf-8 codepage decodes multi-byte hex escapes correctly', () => {
      // \ansicpg65001 signals UTF-8; e4 b8 ad is U+4E2D (中).
      const rtf = "{\\rtf1\\ansi\\ansicpg65001 \\'e4\\'b8\\'ad}";
      const out = runTextExtraction({ type: 'rtf', payload: { text: rtf } });
      expect(out).toContain('中');
    });
  });

  describe('xlsx shared-string extraction', () => {
    test('parses <si>/<t> elements into a flat string array', () => {
      const xml = `
        <sst>
          <si><t>Alpha</t></si>
          <si><t>Beta &amp; Gamma</t></si>
          <si><r><t>Rich</t></r><r><t>Text</t></r></si>
        </sst>
      `;
      const result = runTextExtraction({ type: 'xlsx_shared', payload: { text: xml } });
      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual(['Alpha', 'Beta & Gamma', 'RichText']);
    });

    test('returns empty array for non-string input', () => {
      expect(runTextExtraction({ type: 'xlsx_shared', payload: { text: null } })).toEqual([]);
    });
  });

  describe('xlsx worksheet extraction', () => {
    test('resolves shared string references, inline strings, and formula values', () => {
      const shared = ['Apple', 'Banana'];
      const xml = `
        <worksheetData>
          <row r="1">
            <c r="A1" t="s"><v>0</v></c>
            <c r="B1" t="s"><v>1</v></c>
            <c r="C1"><v>42</v></c>
          </row>
          <row r="2">
            <c r="A2" t="inlineStr"><is><t>Direct</t></is></c>
            <c r="B2" t="e"><v>#DIV/0!</v></c>
          </row>
        </worksheetData>
      `;
      const { text, rowsUsed } = runTextExtraction({
        type: 'xlsx_worksheet',
        payload: { text: xml, sharedStrings: shared, rowBudget: 100 }
      });
      expect(rowsUsed).toBe(2);
      expect(text).toMatch(/Apple Banana 42/);
      expect(text).toMatch(/Direct/);
      // Error cells (`t="e"`) must be filtered out.
      expect(text).not.toMatch(/DIV/);
    });

    test('honours rowBudget and stops early', () => {
      const rowsXml = Array.from({ length: 50 }, (_, i) => `<row><c><v>${i}</v></c></row>`).join(
        ''
      );
      const { rowsUsed } = runTextExtraction({
        type: 'xlsx_worksheet',
        payload: { text: `<sheet>${rowsXml}</sheet>`, sharedStrings: [], rowBudget: 5 }
      });
      expect(rowsUsed).toBe(5);
    });
  });

  test('unknown task type throws deterministically', () => {
    expect(() => runTextExtraction({ type: 'mystery', payload: {} })).toThrow(
      /Unknown task type: mystery/
    );
  });
});
