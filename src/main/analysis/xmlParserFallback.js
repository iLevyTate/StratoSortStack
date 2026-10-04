// @ts-check
// Minimal XML parser fallback used when fast-xml-parser is unavailable at runtime.
// This is not a full XML parser; it provides enough structure to keep text extraction functional.
class XMLParser {
  constructor() {
    // no-op; options ignored in the fallback
  }

  // Very lightweight parse: strip tags and return text in an object shape.
  parse(xmlString = '') {
    const text = String(xmlString)
      .replace(/<[^>]*>/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      // Decode decimal numeric entities (&#60; -> <)
      .replace(/&#(\d+);/g, (_, code) => {
        const cp = parseInt(code, 10);
        // Skip control characters except common whitespace
        if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) return '';
        // Skip Bidi override characters that could cause display attacks
        if (cp >= 0x202a && cp <= 0x202e) return '';
        if (cp >= 0x2066 && cp <= 0x2069) return '';
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
      })
      // Decode hex numeric entities (&#x3c; -> <)
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
        const cp = parseInt(hex, 16);
        if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) return '';
        if (cp >= 0x202a && cp <= 0x202e) return '';
        if (cp >= 0x2066 && cp <= 0x2069) return '';
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
      })
      // &amp; must be decoded last to avoid double-decoding
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();

    return { text };
  }
}

module.exports = { XMLParser };
