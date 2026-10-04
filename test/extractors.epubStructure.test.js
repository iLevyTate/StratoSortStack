/**
 * Tests for the EPUB structure reader (container.xml -> OPF -> spine).
 *
 * `adm-zip` is real here (test-setup.js only mocks `fs`), so every fixture is a
 * genuine zip built in memory with `addFile`; see `buildEpub` for why the
 * archive is not serialised and re-parsed under jest.
 */

const zlib = require('zlib');
const AdmZip = require('adm-zip');

const { logger } = require('./mocks/logger');
const {
  readEpubStructure,
  pickEpubEntriesForText,
  describeEpubHeader
} = require('../src/main/analysis/extractors/epubStructure');

const MIMETYPE = 'application/epub+zip';

/**
 * Build a real EPUB zip from a name -> content map. Entries are added in
 * insertion order, which is the "zip order" the fallback path relies on.
 * @param {Record<string, string | Buffer>} files
 * @returns {import('adm-zip')}
 */
function buildEpub(files) {
  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from(MIMETYPE));
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
  }
  // The zip is handed over as built (no `toBuffer()` round trip): adm-zip 0.6
  // guards parsed entry data with `input instanceof Uint8Array`, which is
  // false across jest's vm realm, so a re-parsed archive would read back
  // empty entries. In-memory entries still report DEFLATED headers and
  // compress on demand, so the module's bounded-inflate path is exercised.
  return zip;
}

/** @param {string} opfPath */
function containerXml(opfPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
}

/** @param {string} body */
function xhtml(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><p>${body}</p></body></html>`;
}

/**
 * @param {{ metadata?: string, manifest: string, spine: string, prefix?: string }} parts
 */
function opfXml({ metadata = '', manifest, spine, prefix = '' }) {
  const p = prefix;
  return `<?xml version="1.0" encoding="UTF-8"?>
<${p}package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0" unique-identifier="uid">
  <${p}metadata>${metadata}</${p}metadata>
  <${p}manifest>${manifest}</${p}manifest>
  <${p}spine toc="ncx">${spine}</${p}spine>
</${p}package>`;
}

const STANDARD_OPF = opfXml({
  metadata: `
    <dc:identifier id="uid">urn:uuid:1</dc:identifier>
    <dc:title>The Test Book</dc:title>
    <dc:creator id="c1">Ada Lovelace</dc:creator>
    <dc:creator>Charles &amp; Babbage</dc:creator>
    <dc:language>en</dc:language>`,
  manifest: `
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="ch1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="text/chapter3.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`,
  spine: `
    <itemref idref="cover"/>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>`
});

/** Standard layout whose zip order deliberately differs from the spine order. */
function buildStandardEpub() {
  return buildEpub({
    'META-INF/container.xml': containerXml('OEBPS/content.opf'),
    'OEBPS/text/chapter3.xhtml': xhtml('three'),
    'OEBPS/text/chapter1.xhtml': xhtml('one'),
    'OEBPS/style.css': 'p { margin: 0 }',
    'OEBPS/cover.xhtml': xhtml('cover'),
    'OEBPS/content.opf': STANDARD_OPF,
    'OEBPS/text/chapter2.xhtml': xhtml('two'),
    'OEBPS/toc.ncx': '<ncx/>'
  });
}

describe('epubStructure', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('readEpubStructure', () => {
    test('standard layout: spine order wins over zip order and metadata is read', () => {
      const zip = buildStandardEpub();
      const structure = readEpubStructure(zip);

      expect(structure).not.toBeNull();
      expect(structure.title).toBe('The Test Book');
      expect(structure.creators).toEqual(['Ada Lovelace', 'Charles & Babbage']);
      expect(structure.language).toBe('en');
      expect(structure.opfPath).toBe('OEBPS/content.opf');
      expect(structure.manifestCount).toBe(6);
      expect(structure.spineEntryNames).toEqual([
        'OEBPS/cover.xhtml',
        'OEBPS/text/chapter1.xhtml',
        'OEBPS/text/chapter2.xhtml',
        'OEBPS/text/chapter3.xhtml'
      ]);
      // Every returned name resolves to a real entry the caller can read.
      for (const name of structure.spineEntryNames) {
        expect(zip.getEntry(name)).toBeTruthy();
      }
    });

    test('namespaced OPF (opf:item, opf:spine, dc:title) and single-quoted attributes in any order', () => {
      const opf = opfXml({
        prefix: 'opf:',
        metadata: `
          <dc:title id='t'>Namespaced <i>Title</i></dc:title>
          <dc:creator opf:role='aut'>Grace Hopper</dc:creator>
          <dc:language>fr</dc:language>`,
        manifest: `
          <opf:item media-type='application/xhtml+xml' href='b.xhtml' id='b' />
          <opf:item media-type='application/xhtml+xml' href='a.xhtml' id='a' />`,
        spine: `
          <opf:itemref linear='yes' idref='b' />
          <opf:itemref idref='a' />`
      });
      const zip = buildEpub({
        'META-INF/container.xml': `<container><rootfiles><rootfile media-type='application/oebps-package+xml' full-path='book.opf' /></rootfiles></container>`,
        'a.xhtml': xhtml('a'),
        'b.xhtml': xhtml('b'),
        'book.opf': opf
      });

      const structure = readEpubStructure(zip);
      expect(structure).not.toBeNull();
      expect(structure.title).toBe('Namespaced Title');
      expect(structure.creators).toEqual(['Grace Hopper']);
      expect(structure.language).toBe('fr');
      expect(structure.opfPath).toBe('book.opf');
      expect(structure.manifestCount).toBe(2);
      expect(structure.spineEntryNames).toEqual(['b.xhtml', 'a.xhtml']);
    });

    test('URL-encoded hrefs and OPF path are decoded and resolved relative to the OPF directory', () => {
      const opf = opfXml({
        metadata: '<dc:title>Encoded</dc:title>',
        manifest: `
          <item id="c1" href="chapter%201.xhtml" media-type="application/xhtml+xml"/>
          <item id="c2" href="../shared/chapter%202.xhtml#frag" media-type="application/xhtml+xml"/>`,
        spine: `<itemref idref="c1"/><itemref idref="c2"/>`
      });
      const zip = buildEpub({
        'META-INF/container.xml': containerXml('My%20Book/content.opf'),
        'My Book/content.opf': opf,
        'My Book/chapter 1.xhtml': xhtml('one'),
        'shared/chapter 2.xhtml': xhtml('two')
      });

      const structure = readEpubStructure(zip);
      expect(structure).not.toBeNull();
      expect(structure.opfPath).toBe('My Book/content.opf');
      expect(structure.spineEntryNames).toEqual([
        'My Book/chapter 1.xhtml',
        'shared/chapter 2.xhtml'
      ]);
    });

    test('missing container.xml returns null', () => {
      const zip = buildEpub({
        'OEBPS/content.opf': STANDARD_OPF,
        'OEBPS/text/chapter1.xhtml': xhtml('one')
      });
      expect(readEpubStructure(zip)).toBeNull();
      expect(logger.debug).toHaveBeenCalled();
    });

    test('container.xml pointing at a missing OPF returns null', () => {
      const zip = buildEpub({
        'META-INF/container.xml': containerXml('OEBPS/missing.opf'),
        'OEBPS/text/chapter1.xhtml': xhtml('one')
      });
      expect(readEpubStructure(zip)).toBeNull();
    });

    test('OPF without a spine returns null', () => {
      const opf = `<package><metadata><dc:title>No Spine</dc:title></metadata>
        <manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></manifest></package>`;
      const zip = buildEpub({
        'META-INF/container.xml': containerXml('content.opf'),
        'content.opf': opf,
        'a.xhtml': xhtml('a')
      });
      expect(readEpubStructure(zip)).toBeNull();
    });

    test('spine itemref pointing at a file absent from the archive is skipped', () => {
      const opf = opfXml({
        metadata: '<dc:title>Gaps</dc:title>',
        manifest: `
          <item id="a" href="a.xhtml" media-type="application/xhtml+xml"/>
          <item id="ghost" href="ghost.xhtml" media-type="application/xhtml+xml"/>
          <item id="b" href="b.xhtml" media-type="application/xhtml+xml"/>`,
        spine: `
          <itemref idref="a"/>
          <itemref idref="ghost"/>
          <itemref idref="not-in-manifest"/>
          <itemref idref="b"/>`
      });
      const zip = buildEpub({
        'META-INF/container.xml': containerXml('content.opf'),
        'content.opf': opf,
        'a.xhtml': xhtml('a'),
        'b.xhtml': xhtml('b')
      });

      const structure = readEpubStructure(zip);
      expect(structure.spineEntryNames).toEqual(['a.xhtml', 'b.xhtml']);
      expect(structure.manifestCount).toBe(3);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('skipped'),
        expect.objectContaining({ skipped: 2 })
      );
    });

    test('hrefs are matched case-insensitively when no exact entry exists', () => {
      const opf = opfXml({
        manifest: `<item id="a" href="Text/Chapter.XHTML" media-type="application/xhtml+xml"/>`,
        spine: `<itemref idref="a"/>`
      });
      const zip = buildEpub({
        'META-INF/container.xml': containerXml('content.opf'),
        'content.opf': opf,
        'text/chapter.xhtml': xhtml('a')
      });
      const structure = readEpubStructure(zip);
      expect(structure.spineEntryNames).toEqual(['text/chapter.xhtml']);
    });

    test('linear="no" items are dropped when at least one linear item exists', () => {
      const opf = opfXml({
        manifest: `
          <item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/>
          <item id="a" href="a.xhtml" media-type="application/xhtml+xml"/>
          <item id="b" href="b.xhtml" media-type="application/xhtml+xml"/>`,
        spine: `
          <itemref idref="notes" linear="no"/>
          <itemref idref="a"/>
          <itemref idref="b" linear="yes"/>`
      });
      const zip = buildEpub({
        'META-INF/container.xml': containerXml('content.opf'),
        'content.opf': opf,
        'notes.xhtml': xhtml('n'),
        'a.xhtml': xhtml('a'),
        'b.xhtml': xhtml('b')
      });
      expect(readEpubStructure(zip).spineEntryNames).toEqual(['a.xhtml', 'b.xhtml']);
    });

    test('linear="no" items are kept when every item is non-linear', () => {
      const opf = opfXml({
        manifest: `
          <item id="a" href="a.xhtml" media-type="application/xhtml+xml"/>
          <item id="b" href="b.xhtml" media-type="application/xhtml+xml"/>`,
        spine: `<itemref idref="a" linear="no"/><itemref idref="b" linear="no"/>`
      });
      const zip = buildEpub({
        'META-INF/container.xml': containerXml('content.opf'),
        'content.opf': opf,
        'a.xhtml': xhtml('a'),
        'b.xhtml': xhtml('b')
      });
      expect(readEpubStructure(zip).spineEntryNames).toEqual(['a.xhtml', 'b.xhtml']);
    });

    test('duplicate itemrefs collapse to one entry and the spine survives a missing metadata block', () => {
      const opf = `<package><manifest>
          <item id="a" href="a.xhtml" media-type="application/xhtml+xml"/>
        </manifest><spine><itemref idref="a"/><itemref idref="a"/></spine></package>`;
      const zip = buildEpub({
        'META-INF/container.xml': containerXml('content.opf'),
        'content.opf': opf,
        'a.xhtml': xhtml('a')
      });
      const structure = readEpubStructure(zip);
      expect(structure.title).toBeNull();
      expect(structure.creators).toEqual([]);
      expect(structure.language).toBeNull();
      expect(structure.spineEntryNames).toEqual(['a.xhtml']);
    });

    test('malformed XML and garbage entries never throw', () => {
      const broken = buildEpub({
        'META-INF/container.xml': '<rootfile full-path=',
        'content.opf': Buffer.from([0x00, 0xff, 0xfe, 0x01])
      });
      expect(() => readEpubStructure(broken)).not.toThrow();
      expect(readEpubStructure(broken)).toBeNull();

      const garbageOpf = buildEpub({
        'META-INF/container.xml': containerXml('content.opf'),
        'content.opf': Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04])
      });
      expect(readEpubStructure(garbageOpf)).toBeNull();

      expect(readEpubStructure(null)).toBeNull();
      expect(readEpubStructure({})).toBeNull();
    });

    test('an oversized package document is refused rather than inflated whole', () => {
      const hugeOpf = `${opfXml({
        manifest: `<item id="a" href="a.xhtml" media-type="application/xhtml+xml"/>`,
        spine: `<itemref idref="a"/>`
      })}<!-- ${'x'.repeat(9 * 1024 * 1024)} -->`;
      const zip = buildEpub({
        'META-INF/container.xml': containerXml('content.opf'),
        'content.opf': hugeOpf,
        'a.xhtml': xhtml('a')
      });
      expect(readEpubStructure(zip)).toBeNull();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('oversized'),
        expect.objectContaining({ entry: 'content.opf' })
      );
    });
  });

  describe('pickEpubEntriesForText', () => {
    test('returns the spine when the structure has one', () => {
      const zip = buildStandardEpub();
      const structure = readEpubStructure(zip);
      expect(pickEpubEntriesForText(zip, structure)).toEqual(structure.spineEntryNames);
    });

    test('falls back to every .xhtml/.html/.htm entry in zip order when the structure is null', () => {
      const zip = buildEpub({
        'OEBPS/text/chapter3.xhtml': xhtml('three'),
        'OEBPS/text/chapter1.xhtml': xhtml('one'),
        'OEBPS/style.css': 'p {}',
        'OEBPS/legacy.HTML': '<html/>',
        'OEBPS/old.htm': '<html/>',
        'OEBPS/content.opf': STANDARD_OPF
      });
      expect(readEpubStructure(zip)).toBeNull();
      expect(pickEpubEntriesForText(zip, null)).toEqual([
        'OEBPS/text/chapter3.xhtml',
        'OEBPS/text/chapter1.xhtml',
        'OEBPS/legacy.HTML',
        'OEBPS/old.htm'
      ]);
    });

    test('falls back to zip order when the spine resolved to nothing', () => {
      const zip = buildEpub({
        'META-INF/container.xml': containerXml('content.opf'),
        'content.opf': opfXml({
          manifest: `<item id="a" href="ghost.xhtml" media-type="application/xhtml+xml"/>`,
          spine: `<itemref idref="a"/>`
        }),
        'real.xhtml': xhtml('r')
      });
      const structure = readEpubStructure(zip);
      expect(structure.spineEntryNames).toEqual([]);
      expect(pickEpubEntriesForText(zip, structure)).toEqual(['real.xhtml']);
    });

    test('dedupes names and tolerates a broken zip handle', () => {
      expect(
        pickEpubEntriesForText(null, { spineEntryNames: ['a.xhtml', 'a.xhtml', 'b.xhtml'] })
      ).toEqual(['a.xhtml', 'b.xhtml']);
      expect(pickEpubEntriesForText(null, null)).toEqual([]);
      expect(
        pickEpubEntriesForText(
          {
            getEntries() {
              throw new Error('corrupt');
            }
          },
          null
        )
      ).toEqual([]);
    });
  });

  describe('describeEpubHeader', () => {
    test('emits Title / Author / Language lines', async () => {
      const structure = readEpubStructure(buildStandardEpub());
      await expect(describeEpubHeader(structure)).resolves.toBe(
        'Title: The Test Book\nAuthor: Ada Lovelace, Charles & Babbage\nLanguage: en'
      );
    });

    test('omits unknown fields and returns an empty string when nothing is known', async () => {
      await expect(
        describeEpubHeader({ title: null, creators: ['Solo'], language: null })
      ).resolves.toBe('Author: Solo');
      await expect(describeEpubHeader({ title: '  ', creators: [], language: null })).resolves.toBe(
        ''
      );
      await expect(describeEpubHeader(null)).resolves.toBe('');
    });

    test('collapses whitespace and caps absurdly long values', async () => {
      const header = await describeEpubHeader({
        title: `A\n\n  very ${'long '.repeat(400)}title`,
        creators: [],
        language: 'en-US'
      });
      const [titleLine, languageLine] = header.split('\n');
      expect(titleLine.startsWith('Title: A very long')).toBe(true);
      expect(titleLine).not.toMatch(/\n/);
      expect(titleLine.length).toBeLessThanOrEqual('Title: '.length + 500);
      expect(languageLine).toBe('Language: en-US');
    });
  });
  describe('adversarial inputs', () => {
    /**
     * Structural stand-in for an adm-zip handle whose entry headers can lie,
     * which `addFile` never lets a real one do. It mirrors adm-zip's lookup:
     * `getEntry` reads a plain-object table, so prototype names leak through.
     * @param {Array<{ entryName: string, data?: Buffer, compressed?: Buffer, size?: number, method?: number, getData?: () => Buffer }>} specs
     */
    function fakeZip(specs) {
      /** @type {Record<string, any>} */
      const table = {};
      const entries = specs.map((spec) => {
        const data = spec.data || Buffer.alloc(0);
        const entry = {
          entryName: spec.entryName,
          isDirectory: false,
          header: { size: spec.size ?? data.length, method: spec.method ?? 0 },
          getData: spec.getData || (() => data),
          getCompressedData: () => spec.compressed || Buffer.alloc(0)
        };
        table[spec.entryName] = entry;
        return entry;
      });
      return {
        getEntry: (/** @type {string} */ name) => table[name] || null,
        getEntries: () => entries
      };
    }

    const CONTAINER = Buffer.from(containerXml('content.opf'));
    const ONE_ITEM = '<item id="a" href="a.xhtml" media-type="application/xhtml+xml"/>';
    const ONE_REF = '<itemref idref="a"/>';
    /** @param {string} opf */
    const fakeBook = (opf) =>
      fakeZip([
        { entryName: 'META-INF/container.xml', data: CONTAINER },
        { entryName: 'content.opf', data: Buffer.from(opf) },
        { entryName: 'a.xhtml', data: Buffer.from(xhtml('a')) }
      ]);

    test('empty file: an entry-less archive, a zero-byte container.xml and a zero-byte OPF return null', () => {
      expect(readEpubStructure(new AdmZip())).toBeNull();
      expect(pickEpubEntriesForText(new AdmZip(), null)).toEqual([]);

      const emptyContainer = buildEpub({
        'META-INF/container.xml': Buffer.alloc(0),
        'content.opf': STANDARD_OPF
      });
      expect(readEpubStructure(emptyContainer)).toBeNull();

      const emptyOpf = buildEpub({
        'META-INF/container.xml': containerXml('content.opf'),
        'content.opf': Buffer.alloc(0),
        'a.xhtml': xhtml('a')
      });
      expect(readEpubStructure(emptyOpf)).toBeNull();
      expect(pickEpubEntriesForText(emptyOpf, null)).toEqual(['a.xhtml']);
    });

    test('one-byte file: a lone byte in container.xml or the OPF is rejected without throwing', () => {
      for (const byte of [0x3c, 0x00, 0xff]) {
        const oneByteContainer = buildEpub({
          'META-INF/container.xml': Buffer.from([byte]),
          'content.opf': STANDARD_OPF
        });
        expect(readEpubStructure(oneByteContainer)).toBeNull();
        const oneByteOpf = buildEpub({
          'META-INF/container.xml': containerXml('content.opf'),
          'content.opf': Buffer.from([byte]),
          'a.xhtml': xhtml('a')
        });
        expect(readEpubStructure(oneByteOpf)).toBeNull();
      }
    });

    test('a header claiming a huge length is refused before any bytes are read', () => {
      const getData = jest.fn(() => Buffer.from(opfXml({ manifest: ONE_ITEM, spine: ONE_REF })));
      const zip = fakeZip([
        { entryName: 'META-INF/container.xml', data: CONTAINER },
        { entryName: 'content.opf', size: 2 ** 40, getData },
        { entryName: 'a.xhtml', data: Buffer.from(xhtml('a')) }
      ]);
      expect(readEpubStructure(zip)).toBeNull();
      expect(getData).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('oversized'),
        expect.objectContaining({ entry: 'content.opf', declaredSize: 2 ** 40 })
      );
    });

    test('a header claiming a tiny length over a deflate stream that inflates past the cap is stopped by the inflate bound', () => {
      // ~12 KB on the wire, 12 MiB inflated: the declared size is a lie.
      const bomb = zlib.deflateRawSync(Buffer.alloc(12 * 1024 * 1024, 0x20));
      expect(bomb.length).toBeLessThan(64 * 1024);
      const getData = jest.fn(() => Buffer.alloc(12 * 1024 * 1024, 0x20));
      const zip = fakeZip([
        { entryName: 'META-INF/container.xml', data: CONTAINER },
        { entryName: 'content.opf', compressed: bomb, size: 64, method: 8, getData }
      ]);
      expect(readEpubStructure(zip)).toBeNull();
      expect(getData).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('inflate'),
        expect.objectContaining({ entry: 'content.opf' })
      );
    });

    test('a manifest and spine claiming far more items than the caps are truncated in bounded time', () => {
      const items = Array.from(
        { length: 120000 },
        (_, i) => `<item id="i${i}" href="a.xhtml"/>`
      ).join('');
      const refs = '<itemref idref="i0"/>'.repeat(25000);
      const zip = fakeBook(
        opfXml({ metadata: '<dc:title>Big</dc:title>', manifest: items, spine: refs })
      );
      const started = Date.now();
      const structure = readEpubStructure(zip);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(structure).not.toBeNull();
      expect(structure.title).toBe('Big');
      expect(structure.manifestCount).toBe(50000);
      expect(structure.spineEntryNames).toEqual(['a.xhtml']);
    });

    test('markup crafted to stall the regex scanner finishes in bounded time', () => {
      // Each of these took 7-27 s before the scanner was made linear.
      const cases = {
        'unclosed openers': `<package><manifest>${'<item '.repeat(60000)}</manifest><spine>${ONE_REF}</spine></package>`,
        'openers without closers': `<package><manifest>${'<item id="a" href="a.xhtml">'.repeat(40000)}</manifest><spine>${ONE_REF}</spine></package>`,
        'angle-bracket run in the title': opfXml({
          metadata: `<dc:title>${'<'.repeat(200000)}</dc:title>`,
          manifest: ONE_ITEM,
          spine: ONE_REF
        }),
        'CDATA openers without closers': opfXml({
          metadata: `<dc:title>${'<![CDATA['.repeat(30000)}</dc:title><dc:creator><![CDATA[Real <b>Name</b>]]></dc:creator>`,
          manifest: ONE_ITEM,
          spine: ONE_REF
        }),
        'attribute without a closing quote': `<package><manifest><item id="a" href="${'x'.repeat(2000000)}</manifest><spine>${ONE_REF}</spine></package>`,
        'unclosed itemrefs': `<package><manifest>${ONE_ITEM}</manifest><spine>${'<itemref idref="a">'.repeat(10000)}</spine></package>`
      };
      /** @type {Record<string, any>} */
      const results = {};
      for (const [label, opf] of Object.entries(cases)) {
        const started = Date.now();
        results[label] = readEpubStructure(fakeBook(opf));
        const elapsed = Date.now() - started;
        expect([label, elapsed < 2000]).toEqual([label, true]);
      }
      // The scanner still reads what is actually there.
      expect(results['openers without closers'].manifestCount).toBe(40000);
      expect(results['openers without closers'].spineEntryNames).toEqual(['a.xhtml']);
      expect(results['CDATA openers without closers'].creators).toEqual(['Real Name']);
      expect(results['unclosed itemrefs'].spineEntryNames).toEqual(['a.xhtml']);
      expect(results['attribute without a closing quote'].spineEntryNames).toEqual([]);
    });

    test('hrefs naming Object.prototype members never resolve to an archive entry', () => {
      const names = ['constructor', '__proto__', 'hasOwnProperty', 'toString'];
      const manifest =
        names.map((name, i) => `<item id="p${i}" href="${name}"/>`).join('') + ONE_ITEM;
      const spine = names.map((_, i) => `<itemref idref="p${i}"/>`).join('') + ONE_REF;
      const real = buildEpub({
        'META-INF/container.xml': containerXml('content.opf'),
        'content.opf': opfXml({ manifest, spine }),
        'a.xhtml': xhtml('a')
      });
      // adm-zip 0.6 keeps a null-prototype table, so these are plain misses.
      expect(real.getEntry('constructor')).toBeNull();
      expect(readEpubStructure(real).spineEntryNames).toEqual(['a.xhtml']);
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('skipped'),
        expect.objectContaining({ skipped: 4 })
      );

      // A handle with a plain-object table (older adm-zip, other zip libraries)
      // answers them out of Object.prototype; the reader must not treat that
      // as an entry.
      const plainTable = fakeZip([
        { entryName: 'META-INF/container.xml', data: CONTAINER },
        { entryName: 'content.opf', data: Buffer.from(opfXml({ manifest, spine })) },
        { entryName: 'a.xhtml', data: Buffer.from(xhtml('a')) }
      ]);
      expect(typeof plainTable.getEntry('constructor')).toBe('function');
      expect(plainTable.getEntry('__proto__')).toBe(Object.prototype);
      expect(readEpubStructure(plainTable).spineEntryNames).toEqual(['a.xhtml']);

      const rootfileIsPrototype = fakeZip([
        { entryName: 'META-INF/container.xml', data: Buffer.from(containerXml('constructor')) }
      ]);
      expect(readEpubStructure(rootfileIsPrototype)).toBeNull();
    });

    test('UTF-16 BE container.xml with a trailing odd byte still decodes', () => {
      const be = Buffer.from(containerXml('content.opf'), 'utf16le').swap16();
      const container = Buffer.concat([Buffer.from([0xfe, 0xff]), be, Buffer.from([0x0a])]);
      const zip = buildEpub({
        'META-INF/container.xml': container,
        'content.opf': opfXml({ manifest: ONE_ITEM, spine: ONE_REF }),
        'a.xhtml': xhtml('a')
      });
      expect(readEpubStructure(zip).spineEntryNames).toEqual(['a.xhtml']);
    });

    test('a metadata field whose raw markup is enormous is cleaned without leaking a truncated tag', () => {
      const title = `<dc:title>Clean ${'<span class="x">'.repeat(5000)}tail</dc:title>`;
      const structure = readEpubStructure(
        fakeBook(opfXml({ metadata: title, manifest: ONE_ITEM, spine: ONE_REF }))
      );
      expect(structure.title).toBe('Clean');
      expect(structure.title).not.toMatch(/</);
    });
  });
});
