'use strict';

const { XMLParser } = require('../../src/main/analysis/xmlParserFallback');

describe('xmlParserFallback XMLParser', () => {
  const parse = (xml) => new XMLParser().parse(xml).text;

  test('strips tags and returns collapsed text', () => {
    expect(parse('<a><b>Hello</b> <c>World</c></a>')).toBe('Hello World');
  });

  test('decodes the common named entities', () => {
    expect(parse('a &lt;b&gt; &quot;c&quot; &apos;d&apos; e&nbsp;f')).toBe('a <b> "c" \'d\' e f');
  });

  test('decodes decimal and hex numeric entities', () => {
    expect(parse('&#60;&#x3e;')).toBe('<>');
  });

  test('decodes &amp; last to avoid double-decoding', () => {
    // &amp;lt; should become &lt; (literal), not <
    expect(parse('&amp;lt;')).toBe('&lt;');
  });

  test('drops disallowed control characters but keeps whitespace', () => {
    // \x07 (BEL) is stripped; \x09 (tab) survives as whitespace and collapses.
    expect(parse('x&#7;y&#9;z')).toBe('xy z');
  });

  test('drops bidi override characters (display-attack hardening)', () => {
    expect(parse('left&#8235;right')).toBe('leftright');
  });

  test('drops bidi isolate format characters (decimal and hex)', () => {
    // U+2066 LEFT-TO-RIGHT ISOLATE: 8294 decimal, 0x2066 hex.
    expect(parse('a&#8294;b')).toBe('ab');
    expect(parse('a&#x2066;b')).toBe('ab');
  });

  test('applies the same control/bidi guards to hex entities', () => {
    // \x07 BEL (control) and U+202E (bidi override) via hex must both be dropped.
    expect(parse('x&#x7;y')).toBe('xy');
    expect(parse('left&#x202e;right')).toBe('leftright');
  });

  test('drops out-of-range and zero code points', () => {
    // cp === 0 fails the `cp > 0` guard; > 0x10FFFF fails the upper bound.
    expect(parse('a&#0;b')).toBe('ab');
    expect(parse('a&#x0;b')).toBe('ab');
    expect(parse('a&#1114112;b')).toBe('ab');
  });

  test('coerces non-string input without throwing', () => {
    expect(parse(undefined)).toBe('');
    expect(new XMLParser().parse(12345).text).toBe('12345');
  });

  test('constructor ignores options', () => {
    expect(() => new XMLParser({ ignoreAttributes: false })).not.toThrow();
  });
});
