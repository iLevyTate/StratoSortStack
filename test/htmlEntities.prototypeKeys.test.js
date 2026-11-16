/**
 * @jest-environment node
 *
 * The named-entity tables are plain objects keyed by names taken from the
 * document. '&constructor;' or '&toString;' used to resolve to the
 * Object.prototype function and put "function Object() { [native code] }"
 * into the analyzed text. Unknown names must stay as written.
 */

const AdmZip = require('adm-zip');

const { decodeHtmlEntities } = require('../src/main/analysis/extractors/htmlEntities');
const { readEpubStructure } = require('../src/main/analysis/extractors/epubStructure');

describe('decodeHtmlEntities with Object.prototype names', () => {
  test('leaves prototype-member names as written', () => {
    expect(decodeHtmlEntities('a &constructor; b &toString; c &hasOwnProperty; d')).toBe(
      'a &constructor; b &toString; c &hasOwnProperty; d'
    );
  });

  test('still decodes real entities, including the case-folded XML five', () => {
    expect(decodeHtmlEntities('&amp; &AMP; &Lt; &eacute;')).toBe('& & < é');
  });
});

describe('EPUB metadata entity decoding with Object.prototype names', () => {
  test('a title with &constructor; keeps it as written', () => {
    const zip = new AdmZip();
    zip.addFile('mimetype', Buffer.from('application/epub+zip'));
    zip.addFile(
      'META-INF/container.xml',
      Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'
      )
    );
    zip.addFile(
      'content.opf',
      Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0"><metadata><dc:title>The &constructor; &amp; Notes</dc:title></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>'
      )
    );
    zip.addFile('c1.xhtml', Buffer.from('<html><body><p>x</p></body></html>'));

    const structure = readEpubStructure(zip);
    expect(structure).not.toBeNull();
    expect(structure.title).toBe('The &constructor; & Notes');
  });
});
