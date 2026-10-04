/**
 * @jest-environment node
 *
 * RTF tokenizer shared by documentExtractors and the text extraction worker.
 * Inputs are written with escaped backslashes on purpose: Node cooks
 * `\uNNNN` inside String.raw templates, which would hide the escapes under test.
 */

const { rtfToText, looksLikeRtf } = require('../src/main/analysis/extractors/rtfText');

describe('rtfToText', () => {
  test('drops font, color and generator groups and decodes byte and unicode escapes', () => {
    const rtf =
      '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Helvetica;}}{\\*\\generator Riched20}' +
      "{\\colortbl;\\red0\\green0\\blue0;}\\f0\\fs24 Hello \\u8217? caf\\'e9 \\b world\\b0\\par " +
      'Second line {\\pict\\wmetafile8 0102030405}end\\par}';
    expect(rtfToText(rtf)).toBe('Hello ’ café world\nSecond line end');
  });

  test('honours \\ucN fallback counts and negative unicode values', () => {
    const rtf = '{\\rtf1\\ansi\\uc2 a\\u8217?? b\\uc1 \\u8364?c \\u-1000?d}';
    expect(rtfToText(rtf)).toBe('a’ b€c ﰘd');
  });

  test('decodes UTF-8 byte runs when the document declares code page 65001', () => {
    expect(rtfToText("{\\rtf1\\ansicpg65001 caf\\'c3\\'a9 {\\info{\\title Secret}} body}")).toBe(
      'café body'
    );
  });

  test('keeps text inside unknown groups and renders paragraph and tab controls', () => {
    expect(rtfToText('{\\rtf1 {\\upr{\\ud x}} one\\tab two\\line three\\par four}')).toBe(
      'x one\ttwo\nthree\nfour'
    );
  });

  test('passes non-RTF input through unchanged', () => {
    expect(rtfToText('Not really RTF content')).toBe('Not really RTF content');
    expect(looksLikeRtf('Not really RTF content')).toBe(false);
    expect(looksLikeRtf('  {\\rtf1 hi}')).toBe(true);
  });

  test('returns an empty string for null, undefined and empty input', () => {
    expect(rtfToText(null)).toBe('');
    expect(rtfToText(undefined)).toBe('');
    expect(rtfToText('')).toBe('');
  });

  test('survives unbalanced braces and a trailing backslash', () => {
    expect(rtfToText('{\\rtf1 open {group text')).toBe('open group text');
    expect(rtfToText('{\\rtf1 tail\\')).toBe('tail');
  });

  test('handles a 2 MB document in bounded time', () => {
    const body = '{\\rtf1\\ansi ' + 'word \\b bold\\b0 \\u8217? '.repeat(60000) + '}';
    const started = Date.now();
    const text = rtfToText(body);
    expect(Date.now() - started).toBeLessThan(1500);
    // The space after a control word is its delimiter, not text, so the
    // sequence bold \\b0 \\u8217? renders as bold followed directly by the quote.
    expect(text.startsWith('word bold\u2019 word bold\u2019')).toBe(true);
  });
});
