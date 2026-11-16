/**
 * @jest-environment node
 *
 * RTF fields: {\field{\*\fldinst ...}{\fldrslt visible text}}. The result
 * group is the text a reader sees (link text, page numbers, merge values)
 * and must reach the analysis; the instruction group must not. Unknown
 * control words named after Object.prototype members must emit nothing.
 */

const { rtfToText } = require('../src/main/analysis/extractors/rtfText');

describe('rtfToText field results', () => {
  test('keeps HYPERLINK result text and drops the instruction', () => {
    const text = rtfToText(
      '{\\rtf1 See {\\field{\\*\\fldinst HYPERLINK "http://example.test"}{\\fldrslt Click here}} end}'
    );
    expect(text).toContain('Click here');
    expect(text).not.toContain('HYPERLINK');
    expect(text).not.toContain('example.test');
  });

  test('keeps a PAGE field result', () => {
    expect(rtfToText('{\\rtf1 Page {\\field{\\*\\fldinst PAGE}{\\fldrslt 3}} of report}')).toMatch(
      /Page\s*3\s*of report/
    );
  });

  test('keeps nested formatting inside the result', () => {
    const text = rtfToText(
      '{\\rtf1 Go {\\field{\\*\\fldinst HYPERLINK "http://x.test"}{\\fldrslt {\\ul\\cf2 the docs}}} now}'
    );
    expect(text).toContain('the docs');
    expect(text).not.toContain('x.test');
  });

  test('skips an unmarked fldinst group with nested groups', () => {
    const text = rtfToText(
      '{\\rtf1 A {\\field{\\fldinst {HYPERLINK }{"http://y.test"}}{\\fldrslt Link}} B}'
    );
    expect(text).toContain('Link');
    expect(text).not.toContain('HYPERLINK');
    expect(text).not.toContain('y.test');
  });
});

describe('rtfToText unknown control words', () => {
  test('Object.prototype names emit nothing', () => {
    const text = rtfToText('{\\rtf1 Hello \\constructor world \\toString x \\valueOf y}');
    expect(text).not.toContain('function');
    expect(text).not.toContain('native code');
    expect(text).toContain('Hello');
    expect(text).toContain('world');
  });
});
