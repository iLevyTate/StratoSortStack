/**
 * Tests for the SVG text extractor.
 *
 * Pure string processing: no filesystem involved. The logger is the global
 * mock installed by test-setup.js.
 */

const { logger } = require('./mocks/logger');
const { extractTextFromSvg, looksLikeSvg } = require('../src/main/analysis/extractors/svgText');

/** Wrap a body in a minimal SVG root. */
function svg(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;
}

describe('extractTextFromSvg', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('collects title, desc, text, tspan and textPath in document order', () => {
    const doc = svg(`
      <title>Diagram title</title>
      <desc>A short description</desc>
      <text x="1" y="2">Plain label</text>
      <text><tspan x="0" y="0">Span one</tspan><tspan x="0" y="12">Span two</tspan></text>
      <defs><path id="curve" d="M0 50 Q50 0 100 50"/></defs>
      <text><textPath href="#curve">Along the curve</textPath></text>
    `);
    expect(extractTextFromSvg(doc)).toBe(
      [
        'Diagram title',
        'A short description',
        'Plain label',
        'Span one Span two',
        'Along the curve'
      ].join('\n')
    );
  });

  test('decodes named, decimal and hex entities', () => {
    const doc = svg(
      '<text>Tom &amp; Jerry &lt;3 &gt; &quot;quoted&quot; &apos;single&apos; &#65;&#x42;&#x1F600;</text>'
    );
    expect(extractTextFromSvg(doc)).toBe('Tom & Jerry <3 > "quoted" \'single\' AB😀');
  });

  test('leaves unknown or malformed entities intact', () => {
    const doc = svg('<text>a &unknown; b &#xZZ; c &#; d</text>');
    expect(extractTextFromSvg(doc)).toBe('a &unknown; b &#xZZ; c &#; d');
  });

  test('never leaks style or script content, even when it mentions text tags', () => {
    const doc = svg(`
      <style type="text/css"><![CDATA[
        text { fill: red; font-family: "Helvetica>Neue"; }
        .hidden { display: none; }
      ]]></style>
      <script type="text/javascript">
        var el = document.createElement('text'); el.textContent = "<text>injected</text>";
      </script>
      <text>Visible</text>
    `);
    const out = extractTextFromSvg(doc);
    expect(out).toBe('Visible');
    expect(out).not.toMatch(/fill|Helvetica|hidden|injected|createElement/);
  });

  test('a <text> with nested tspans yields one line and nothing is duplicated', () => {
    const doc = svg(
      '<text x="0" y="0">Hello <tspan font-weight="bold">World</tspan> and <tspan>more<tspan>deep</tspan></tspan></text>'
    );
    const out = extractTextFromSvg(doc);
    expect(out).toBe('Hello World and more deep');
    expect(out.split('\n')).toHaveLength(1);
    expect((out.match(/World/g) || []).length).toBe(1);
  });

  test('handles nested same-name tspans without losing trailing text', () => {
    const doc = svg('<tspan>outer <tspan>inner</tspan> tail</tspan>');
    expect(extractTextFromSvg(doc)).toBe('outer inner tail');
  });

  test('honours attribute quotes containing ">" and self-closing tags', () => {
    const doc = svg(`
      <rect width="10" height="10" data-note="a > b"/>
      <text data-expr='x > y' data-other="p>q">Guarded</text>
      <text/>
      <text x="5" y="5" />
      <text>After self-closing</text>
    `);
    expect(extractTextFromSvg(doc)).toBe('Guarded\nAfter self-closing');
  });

  test('ignores comments and keeps CDATA literal inside text elements', () => {
    const doc = svg(`
      <!-- <text>commented out</text> -->
      <text><![CDATA[a < b && c > d]]></text>
      <text>before<!-- hidden -->after</text>
    `);
    expect(extractTextFromSvg(doc)).toBe('a < b && c > d\nbeforeafter');
  });

  test('collects dc:title and dc:description from metadata and nothing else', () => {
    const doc = svg(`
      <metadata>
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
          <cc:Work rdf:about="">
            <dc:format>image/svg+xml</dc:format>
            <dc:type rdf:resource="http://purl.org/dc/dcmitype/StillImage"/>
            <dc:title>Metadata Title</dc:title>
            <dc:description>Metadata description text</dc:description>
            <dc:date>2026-01-01</dc:date>
          </cc:Work>
        </rdf:RDF>
      </metadata>
      <text>Body</text>
    `);
    const out = extractTextFromSvg(doc);
    expect(out).toBe('Metadata Title\nMetadata description text\nBody');
    expect(out).not.toMatch(/image\/svg|StillImage|2026-01-01/);
  });

  test('matches element names case-insensitively', () => {
    const doc = '<SVG><TITLE>Upper</TITLE><Text>Mixed <TSPAN>case</TSPAN></Text></SVG>';
    expect(extractTextFromSvg(doc)).toBe('Upper\nMixed case');
  });

  test('collapses whitespace, drops empty lines and dedupes identical lines', () => {
    const doc = svg(`
      <text>   </text>
      <text>
        multi
        line   content
      </text>
      <text>repeat</text>
      <text>repeat</text>
      <desc></desc>
      <text>repeat</text>
    `);
    expect(extractTextFromSvg(doc)).toBe('multi line content\nrepeat');
  });

  test('accepts a Buffer and strips a UTF-8 BOM', () => {
    const buf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(svg('<text>From buffer é</text>'))
    ]);
    expect(extractTextFromSvg(buf)).toBe('From buffer é');
  });

  test('returns empty string for non-SVG input and for SVG without text', () => {
    expect(extractTextFromSvg('<html><body><p>Not svg</p></body></html>')).toBe('');
    expect(extractTextFromSvg('plain text with <text>tag</text> but no root')).toBe('');
    expect(extractTextFromSvg(svg('<rect width="1" height="1"/><path d="M0 0L1 1"/>'))).toBe('');
    expect(extractTextFromSvg('')).toBe('');
    expect(extractTextFromSvg(null)).toBe('');
    expect(extractTextFromSvg(undefined)).toBe('');
    expect(extractTextFromSvg(42)).toBe('');
    expect(extractTextFromSvg({})).toBe('');
    expect(extractTextFromSvg(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe('');
    expect(logger.debug).toHaveBeenCalled();
  });

  test('does not throw on unclosed or truncated markup', () => {
    expect(extractTextFromSvg('<svg><text>unclosed text')).toBe('unclosed text');
    expect(extractTextFromSvg('<svg><text x="1')).toBe('');
    expect(extractTextFromSvg('<svg><style>body{}')).toBe('');
    expect(extractTextFromSvg('<svg><text>a</text><!-- open comment <text>b</text>')).toBe('a');
    expect(extractTextFromSvg('<svg><metadata><dc:title>t')).toBe('t');
    expect(extractTextFromSvg('<svg><text>a</tex')).toBe('a');
    expect(extractTextFromSvg('<svg>< >odd</ >')).toBe('');
  });

  test('truncates to maxChars', () => {
    const doc = svg('<text>abcdefghij</text><text>klmnopqrst</text>');
    expect(extractTextFromSvg(doc, { maxChars: 15 })).toBe('abcdefghij\nklmn');
    expect(extractTextFromSvg(doc, { maxChars: 0 })).toBe('');
    expect(extractTextFromSvg(doc, { maxChars: 'nonsense' })).toBe('abcdefghij\nklmnopqrst');
  });

  test('stops collecting early once the cap is reached (default 20000)', () => {
    const parts = [];
    for (let i = 0; i < 5000; i += 1) parts.push(`<text>line number ${i}</text>`);
    const out = extractTextFromSvg(svg(parts.join('')));
    expect(out.length).toBeLessThanOrEqual(20000);
    expect(out.startsWith('line number 0\nline number 1\n')).toBe(true);
  });

  test('processes a ~4 MB document well under the time bound', () => {
    const chunks = [];
    const path = '<path d="' + 'M10 10 L20 20 C30 30 40 40 50 50 '.repeat(20) + '"/>';
    const gradient =
      '<linearGradient id="g"><stop offset="0%" stop-color="#fff"/><stop offset="100%" stop-color="#000"/></linearGradient>';
    const style = '<style>.c{fill:#123;stroke:none} .d{font-family:"Arial>Bold"}</style>';
    let i = 0;
    let size = 0;
    while (size < 4 * 1024 * 1024) {
      const chunk =
        path +
        gradient +
        style +
        `<g transform="translate(${i} ${i})"><text x="1" y="${i}">Label ${i} &amp; <tspan>span ${i}</tspan></text></g>` +
        `<!-- comment ${i} with <text>fake</text> -->`;
      chunks.push(chunk);
      size += chunk.length;
      i += 1;
    }
    const doc = svg(chunks.join('\n'));
    expect(doc.length).toBeGreaterThanOrEqual(4 * 1024 * 1024);

    const started = Date.now();
    const out = extractTextFromSvg(doc, { maxChars: 50 * 1024 * 1024 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1500);
    expect(out.startsWith('Label 0 & span 0\nLabel 1 & span 1\n')).toBe(true);
    expect(out).not.toMatch(/fake|fill:|stop-color/);
    expect(out.split('\n')).toHaveLength(i);
  });

  test('a document that is mostly one huge attribute is still fast', () => {
    const big = '<svg><path d="' + 'M0 0 '.repeat(800000) + '"/><text>tail</text></svg>';
    const started = Date.now();
    expect(extractTextFromSvg(big)).toBe('tail');
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('looksLikeSvg', () => {
  test('is true when <svg appears in the first 2 KB', () => {
    expect(looksLikeSvg(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="x"></svg>'))).toBe(true);
    expect(looksLikeSvg(Buffer.from('<SVG viewBox="0 0 1 1"/>'))).toBe(true);
    expect(looksLikeSvg(Buffer.from('<!-- ' + 'x'.repeat(1900) + ' --><svg>'))).toBe(true);
    expect(looksLikeSvg('<svg>')).toBe(true);
    expect(looksLikeSvg(new Uint8Array(Buffer.from('<svg/>')))).toBe(true);
  });

  test('is false for other formats, late roots and non-buffers', () => {
    expect(looksLikeSvg(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(false);
    expect(looksLikeSvg(Buffer.from('<html><body>svg</body></html>'))).toBe(false);
    expect(looksLikeSvg(Buffer.from('<svgfoo>'))).toBe(false);
    expect(looksLikeSvg(Buffer.from(' '.repeat(2048) + '<svg>'))).toBe(false);
    expect(looksLikeSvg(Buffer.alloc(0))).toBe(false);
    expect(looksLikeSvg(null)).toBe(false);
    expect(looksLikeSvg(undefined)).toBe(false);
    expect(looksLikeSvg(123)).toBe(false);
    expect(looksLikeSvg({})).toBe(false);
  });
});

describe('extractTextFromSvg adversarial inputs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('empty and one-byte inputs yield empty string without throwing', () => {
    expect(extractTextFromSvg('')).toBe('');
    expect(extractTextFromSvg(Buffer.alloc(0))).toBe('');
    expect(extractTextFromSvg(new Uint8Array(0))).toBe('');
    for (const one of ['<', '>', 's', ' ', '\0', '﻿']) {
      expect(extractTextFromSvg(one)).toBe('');
      expect(extractTextFromSvg(Buffer.from(one))).toBe('');
    }
    expect(extractTextFromSvg(Buffer.from([0xff]))).toBe('');
    expect(extractTextFromSvg(Buffer.from([0xff, 0xfe]))).toBe('');
    expect(extractTextFromSvg(Buffer.from([0xfe, 0xff, 0x3c]))).toBe('');
    expect(extractTextFromSvg('<svg')).toBe('');
    expect(extractTextFromSvg('<svg>')).toBe('');
  });

  test('a header claiming absurd sizes, a wrong encoding or a DTD subset is harmless', () => {
    const doc =
      '<?xml version="1.0" encoding="UTF-16" standalone="no"?>' +
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [' +
      '  <!ENTITY ns_svg "http://www.w3.org/2000/svg"> <!ENTITY fake "<text>entity text</text>">' +
      ']>' +
      '<svg width="1e308" height="99999999999999999999999999" viewBox="0 0 1e400 -1e400" ' +
      'data-length="4294967295" preserveAspectRatio="xMidYMid>meet">' +
      '<text textLength="999999999999" lengthAdjust="spacing">Real label</text></svg>';
    expect(extractTextFromSvg(doc)).toBe('Real label');
  });

  test('inputs built to stall a regex or loop finish quickly', () => {
    const MB = 1024 * 1024;
    const cases = {
      'whitespace run inside text': `<svg><text>${' \n\t'.repeat(MB)}tail</text><text>next</text></svg>`,
      'ampersand flood': `<svg><text>${'&'.repeat(2 * MB)}${'&aaaaaaaa'.repeat(100000)}</text></svg>`,
      'stray angle brackets': `<svg><text>${'< '.repeat(MB)}${'<<'.repeat(MB)}end</text></svg>`,
      'unclosed text openers': `<svg>${'<text>'.repeat(300000)}deep</svg>`,
      'nested tspans': `<svg><text>${'<tspan>'.repeat(100000)}x${'</tspan>'.repeat(100000)}</text></svg>`,
      'stray closers': `<svg>${'</text>'.repeat(500000)}<text>ok</text></svg>`,
      'unterminated comment': `<svg><text>a</text><!--${' x'.repeat(2 * MB)}`,
      'unterminated CDATA': `<svg><text><![CDATA[${'y'.repeat(4 * MB)}`,
      'one unclosed quote': `<svg><rect title="${'z'.repeat(4 * MB)}<text>after</text></svg>`,
      'empty elements flood': `<svg>${'<text></text><title> </title>'.repeat(200000)}</svg>`,
      'identical lines flood': `<svg>${'<text>same</text>'.repeat(400000)}</svg>`,
      'processing instructions': `<svg>${'<?pi x?>'.repeat(500000)}<text>pi</text></svg>`,
      'no root in a large file': `<html>${'<p>x</p>'.repeat(500000)}</html>`
    };
    for (const [name, doc] of Object.entries(cases)) {
      const started = Date.now();
      let out;
      expect(() => {
        out = extractTextFromSvg(doc, { maxChars: 10 * MB });
      }).not.toThrow();
      const elapsed = Date.now() - started;
      if (elapsed >= 1500) expect(`${name} took ${elapsed} ms`).toBe('under 1500 ms');
      expect(typeof out).toBe('string');
    }
    expect(extractTextFromSvg(cases['whitespace run inside text'])).toBe('tail\nnext');
    expect(extractTextFromSvg(cases['stray closers'])).toBe('ok');
    expect(extractTextFromSvg(cases['one unclosed quote'])).toBe('after');
    expect(extractTextFromSvg(cases['identical lines flood'])).toBe('same');
    expect(extractTextFromSvg(cases['processing instructions'])).toBe('pi');
    expect(extractTextFromSvg(cases['nested tspans'])).toBe('x');
    expect(extractTextFromSvg(cases['no root in a large file'])).toBe('');
  });

  test('a bare "<" in script or text content is literal and does not swallow what follows', () => {
    expect(
      extractTextFromSvg(
        '<svg><script>if (a < b && c > d) { el.innerHTML = "<text>no</text>"; }</script><text>after script</text></svg>'
      )
    ).toBe('after script');
    expect(extractTextFromSvg('<svg><text>a < b and c</text><text>next</text></svg>')).toBe(
      'a < b and c\nnext'
    );
    expect(extractTextFromSvg('<svg><text>1 << 2 <</text><text>3</text></svg>')).toBe(
      '1 << 2 <\n3'
    );
  });

  test('a tag that never closes ends where the next tag starts, so one bad quote costs one tag', () => {
    expect(extractTextFromSvg('<svg><rect title="unclosed><text>recovered</text></svg>')).toBe(
      'recovered'
    );
    expect(extractTextFromSvg('<svg><text x="1" <text>inner</text></svg>')).toBe('inner');
    expect(extractTextFromSvg('<svg><g id="a" <text>one</text><text>two</text></svg>')).toBe(
      'one\ntwo'
    );
  });

  test('reads namespace-prefixed documents like unprefixed ones', () => {
    const doc =
      '<svg:svg xmlns:svg="http://www.w3.org/2000/svg" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
      '<svg:title>Prefixed title</svg:title>' +
      '<svg:style>.a { fill: red }</svg:style>' +
      '<svg:metadata><dc:title>Meta</dc:title><dc:creator>hidden</dc:creator></svg:metadata>' +
      '<svg:text>t <svg:tspan>s</svg:tspan></svg:text><svg:text>u</svg:text>' +
      '</svg:svg>';
    expect(extractTextFromSvg(doc)).toBe('Prefixed title\nMeta\nt s\nu');
    expect(looksLikeSvg(Buffer.from(doc))).toBe(true);
  });

  test('strips control characters that arrive through numeric entities or raw bytes', () => {
    expect(extractTextFromSvg('<svg><text>nul&#0;char&#1;x&#x7f;&#9;tab</text></svg>')).toBe(
      'nulcharx tab'
    );
    expect(extractTextFromSvg('<svg><text>raw\u0000\u0001\u001f ok</text></svg>')).toBe('raw ok');
  });

  test('decodes UTF-16 documents that carry a byte-order mark', () => {
    const le = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('<svg><text>utf16 little</text></svg>', 'utf16le')
    ]);
    const be = Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      Buffer.from('<svg><text>utf16 big</text></svg>', 'utf16le').swap16()
    ]);
    expect(extractTextFromSvg(le)).toBe('utf16 little');
    expect(extractTextFromSvg(be)).toBe('utf16 big');
    expect(looksLikeSvg(le)).toBe(true);
    expect(looksLikeSvg(be)).toBe(true);
    // An odd trailing byte after a big-endian BOM must not throw.
    expect(extractTextFromSvg(Buffer.concat([be, Buffer.from([0x00])]))).toBe('utf16 big');
  });

  test('maxBytes caps how much of the input is decoded', () => {
    const doc = '<svg><text>head</text>' + '<rect/>'.repeat(1000) + '<text>tail</text></svg>';
    expect(extractTextFromSvg(doc, { maxBytes: 40 })).toBe('head');
    expect(extractTextFromSvg(Buffer.from(doc), { maxBytes: 40 })).toBe('head');
    expect(extractTextFromSvg(doc)).toBe('head\ntail');
    expect(extractTextFromSvg(doc, { maxBytes: 'bogus' })).toBe('head\ntail');
    expect(logger.debug).toHaveBeenCalled();
  });
});
