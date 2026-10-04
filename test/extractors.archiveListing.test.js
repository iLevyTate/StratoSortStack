/**
 * Tests for the archive listing extractor (tar / tar.gz / gzip).
 *
 * `fs` here is the memfs mock installed by test-setup.js; `tar` and `zlib`
 * are real, so fixtures are genuine archives written into the in-memory
 * volume before each test.
 */

const fs = require('fs');
const zlib = require('zlib');
const tar = require('tar');

const { logger } = require('./mocks/logger');
const {
  describeArchive,
  readGzipOriginalName,
  classifyArchiveExtension
} = require('../src/main/analysis/extractors/archiveListing');

const FIXTURES = '/fixtures';
let sourceDirCounter = 0;

/**
 * Write plain files (and any parent directories) under a fresh source dir.
 * @param {string[]} names
 * @returns {string} the source dir
 */
function writeSourceFiles(names) {
  sourceDirCounter += 1;
  const cwd = `${FIXTURES}/src-${sourceDirCounter}`;
  fs.mkdirSync(cwd, { recursive: true });
  for (const name of names) {
    const full = `${cwd}/${name}`;
    const dir = full.slice(0, full.lastIndexOf('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(full, `content of ${name}\n`);
  }
  return cwd;
}

/**
 * Build a real tar (or tgz) in memfs.
 * @param {string} file destination path
 * @param {string[]} entries names passed to tar.c (relative to cwd)
 * @param {{ gzip?: boolean, files?: string[] }} [opts] files defaults to entries
 */
function buildTar(file, entries, opts = {}) {
  const cwd = writeSourceFiles(opts.files || entries);
  tar.c({ sync: true, file, cwd, gzip: opts.gzip === true }, entries);
  return file;
}

/** CRC-32 for the gzip trailer (falls back to a table when zlib.crc32 is absent). */
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Hand-assemble a single-member gzip per RFC 1952.
 * @param {string} body
 * @param {{ name?: string, extra?: Buffer }} [opts]
 */
function buildGzip(body, opts = {}) {
  let flg = 0;
  if (opts.extra) flg |= 0x04;
  if (opts.name) flg |= 0x08;
  const parts = [Buffer.from([0x1f, 0x8b, 0x08, flg, 0, 0, 0, 0, 0x00, 0xff])];
  if (opts.extra) {
    const xlen = Buffer.alloc(2);
    xlen.writeUInt16LE(opts.extra.length, 0);
    parts.push(xlen, opts.extra);
  }
  if (opts.name) parts.push(Buffer.from(opts.name, 'latin1'), Buffer.from([0]));
  const data = Buffer.from(body, 'utf8');
  parts.push(zlib.deflateRawSync(data));
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(data), 0);
  trailer.writeUInt32LE(data.length >>> 0, 4);
  parts.push(trailer);
  return Buffer.concat(parts);
}

/** Deterministic junk that is neither a tar header nor a gzip stream. */
function junkBytes(length) {
  return Buffer.from(Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff));
}

/**
 * Hand-build a single POSIX ustar header block so tests can forge fields that
 * tar.c would never write (control characters, impossible sizes).
 * @param {string} name entry path (Latin-1, < 100 bytes)
 * @param {number} size declared body size in bytes
 * @param {'0' | '5'} [type] '0' = regular file, '5' = directory
 */
function tarHeader(name, size, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name, 0, 'latin1');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

/** A complete hand-built tar: zero-length entries plus the two EOF blocks. */
function buildEmptyEntriesTar(names) {
  return Buffer.concat([...names.map((n) => tarHeader(n, 0)), Buffer.alloc(1024)]);
}

/** Wall-clock an async call. */
async function timed(fn) {
  const start = Date.now();
  const value = await fn();
  return { value, elapsedMs: Date.now() - start };
}

function writeFixture(name, buffer) {
  const file = `${FIXTURES}/${name}`;
  fs.writeFileSync(file, buffer);
  return file;
}

beforeEach(() => {
  fs.mkdirSync(FIXTURES, { recursive: true });
});

describe('classifyArchiveExtension', () => {
  test('maps the documented extensions', () => {
    expect(classifyArchiveExtension('a.tar')).toBe('tar');
    expect(classifyArchiveExtension('a.tgz')).toBe('tgz');
    expect(classifyArchiveExtension('a.tar.gz')).toBe('tgz');
    expect(classifyArchiveExtension('a.gz')).toBe('gzip');
    expect(classifyArchiveExtension('a.zip')).toBeNull();
  });

  test('is case-insensitive and accepts full paths', () => {
    expect(classifyArchiveExtension('/data/Backups/Site.TAR.GZ')).toBe('tgz');
    expect(classifyArchiveExtension('C:\\Users\\me\\logs.GZ')).toBe('gzip');
    expect(classifyArchiveExtension('/data/archive.Tar')).toBe('tar');
  });

  test('rejects non-strings, empty names and bare extensions', () => {
    expect(classifyArchiveExtension('')).toBeNull();
    expect(classifyArchiveExtension(null)).toBeNull();
    expect(classifyArchiveExtension(undefined)).toBeNull();
    expect(classifyArchiveExtension(42)).toBeNull();
    expect(classifyArchiveExtension('.tar')).toBeNull();
    expect(classifyArchiveExtension('tar')).toBeNull();
  });
});

describe('describeArchive - tar', () => {
  test('lists entries in archive order with an exact count', async () => {
    const file = buildTar(`${FIXTURES}/docs.tar`, ['a.txt', 'b.txt', 'c.txt']);

    const result = await describeArchive(file);

    expect(result).toEqual({
      format: 'tar',
      summary: 'TAR archive with 3 entries',
      entryNames: ['a.txt', 'b.txt', 'c.txt'],
      totalEntries: 3,
      truncated: false
    });
  });

  test('includes directory entries with a trailing slash and nested files', async () => {
    const file = buildTar(`${FIXTURES}/tree.tar`, ['readme.md', 'docs'], {
      files: ['readme.md', 'docs/guide.md', 'docs/notes.txt']
    });

    const result = await describeArchive(file);

    expect(result.format).toBe('tar');
    expect(result.totalEntries).toBe(4);
    expect(result.truncated).toBe(false);
    expect(result.entryNames[0]).toBe('readme.md');
    expect(result.entryNames).toEqual(
      expect.arrayContaining(['docs/', 'docs/guide.md', 'docs/notes.txt'])
    );
    expect(result.summary).toBe('TAR archive with 4 entries');
  });

  test('uses singular wording for a single entry', async () => {
    const file = buildTar(`${FIXTURES}/one.tar`, ['only.txt']);

    const result = await describeArchive(file);

    expect(result.summary).toBe('TAR archive with 1 entry');
    expect(result.entryNames).toEqual(['only.txt']);
  });

  test('caps entry names at maxEntries but still counts every entry when cheap', async () => {
    const names = Array.from({ length: 60 }, (_, i) => `file-${String(i).padStart(2, '0')}.txt`);
    const file = buildTar(`${FIXTURES}/many.tar`, names);

    const result = await describeArchive(file, { maxEntries: 50 });

    expect(result.entryNames).toHaveLength(50);
    expect(result.entryNames).toEqual(names.slice(0, 50));
    expect(result.totalEntries).toBe(60);
    expect(result.truncated).toBe(true);
    expect(result.summary).toBe('TAR archive with 60 entries (first 50 listed)');
  });

  test('stops reading after maxEntries when a full count would not be cheap', async () => {
    // 1000 headers = 500 KiB, so the name cap is hit with unread bytes remaining.
    const names = Array.from({ length: 1000 }, (_, i) => `f-${String(i).padStart(4, '0')}.txt`);
    const file = writeFixture('many-stop.tar', buildEmptyEntriesTar(names));

    const result = await describeArchive(file, { maxEntries: 50, fullCountMaxBytes: 0 });

    expect(result.entryNames).toHaveLength(50);
    expect(result.entryNames).toEqual(names.slice(0, 50));
    expect(result.totalEntries).toBeNull();
    expect(result.truncated).toBe(true);
    const match = result.summary.match(/^TAR archive with (\d+)\+ entries \(first 50 listed\)$/);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBeGreaterThanOrEqual(50);
    expect(Number(match[1])).toBeLessThan(1000);
  });

  test('does not report an archive with exactly maxEntries entries as truncated', async () => {
    const names = Array.from({ length: 50 }, (_, i) => `f${i}.txt`);
    const file = writeFixture('exact.tar', buildEmptyEntriesTar(names));

    const result = await describeArchive(file, { maxEntries: 50, fullCountMaxBytes: 0 });

    expect(result.entryNames).toEqual(names);
    expect(result.totalEntries).toBe(50);
    expect(result.truncated).toBe(false);
    expect(result.summary).toBe('TAR archive with 50 entries');
  });

  test('strips control characters from entry names and marks directories', async () => {
    const tarBytes = Buffer.concat([
      tarHeader('bad\u0001name\u001b[31m.txt', 0),
      tarHeader('docs', 0, '5'),
      Buffer.alloc(1024)
    ]);
    const file = writeFixture('ctrl.tar', tarBytes);

    const result = await describeArchive(file);

    expect(result.entryNames).toEqual(['badname[31m.txt', 'docs/']);
    expect(result.totalEntries).toBe(2);
  });

  test('skips archives above maxBytes with a size-capped summary', async () => {
    const file = buildTar(`${FIXTURES}/big.tar`, ['a.txt', 'b.txt']);
    expect(fs.statSync(file).size).toBeGreaterThan(100);

    const result = await describeArchive(file, { maxBytes: 100 });

    expect(result).toEqual({
      format: 'tar',
      summary: 'TAR archive (too large for content listing)',
      entryNames: [],
      totalEntries: null,
      truncated: true
    });
    expect(logger.debug).toHaveBeenCalled();
  });

  test('returns null for junk bytes named .tar and logs at debug', async () => {
    const file = writeFixture('junk.tar', junkBytes(2048));

    await expect(describeArchive(file)).resolves.toBeNull();
    expect(logger.debug).toHaveBeenCalled();
  });

  test('returns null for an empty file', async () => {
    const file = writeFixture('empty.tar', Buffer.alloc(0));

    await expect(describeArchive(file)).resolves.toBeNull();
  });

  test('returns null for a short run of zeros that is not a complete archive', async () => {
    const file = writeFixture('zeros.tar', Buffer.alloc(100));

    await expect(describeArchive(file)).resolves.toBeNull();
  });

  test('reports a truncated archive as damaged but keeps the readable entries', async () => {
    const full = buildTar(`${FIXTURES}/full.tar`, ['a.txt', 'b.txt']);
    // First header block plus part of the first body: the second entry is lost.
    const cut = fs.readFileSync(full).subarray(0, 600);
    const file = writeFixture('cut.tar', cut);

    const result = await describeArchive(file);

    expect(result.format).toBe('tar');
    expect(result.entryNames).toEqual(['a.txt']);
    expect(result.totalEntries).toBeNull();
    expect(result.truncated).toBe(true);
    expect(result.summary).toMatch(/^TAR archive, damaged after 1 entry/);
  });

  test('propagates ENOENT instead of swallowing it', async () => {
    await expect(describeArchive(`${FIXTURES}/missing.tar`)).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  test('returns null for a directory path', async () => {
    fs.mkdirSync(`${FIXTURES}/folder.tar`, { recursive: true });

    await expect(describeArchive(`${FIXTURES}/folder.tar`)).resolves.toBeNull();
  });

  test('returns null for non-string paths', async () => {
    await expect(describeArchive(null)).resolves.toBeNull();
    await expect(describeArchive('')).resolves.toBeNull();
  });
});

describe('describeArchive - tar.gz', () => {
  test('lists a gzip-compressed tar saved as .tgz', async () => {
    const file = buildTar(`${FIXTURES}/bundle.tgz`, ['x.txt', 'y.txt'], { gzip: true });
    expect(fs.readFileSync(file).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));

    const result = await describeArchive(file);

    expect(result).toEqual({
      format: 'tgz',
      summary: 'tar.gz archive with 2 entries',
      entryNames: ['x.txt', 'y.txt'],
      totalEntries: 2,
      truncated: false
    });
  });

  test('lists a gzip-compressed tar saved as .tar.gz', async () => {
    const file = buildTar(`${FIXTURES}/site.tar.gz`, ['index.html', 'style.css', 'app.js'], {
      gzip: true
    });

    const result = await describeArchive(file);

    expect(result.format).toBe('tgz');
    expect(result.summary).toBe('tar.gz archive with 3 entries');
    expect(result.entryNames).toEqual(['index.html', 'style.css', 'app.js']);
  });

  test('uses the tar.gz label for the size cap', async () => {
    const file = buildTar(`${FIXTURES}/big.tgz`, ['a.txt'], { gzip: true });

    const result = await describeArchive(file, { maxBytes: 10 });

    expect(result).toEqual({
      format: 'tgz',
      summary: 'tar.gz archive (too large for content listing)',
      entryNames: [],
      totalEntries: null,
      truncated: true
    });
  });

  test('returns null for junk bytes named .tgz', async () => {
    const file = writeFixture('junk.tgz', junkBytes(4096));

    await expect(describeArchive(file)).resolves.toBeNull();
    expect(logger.debug).toHaveBeenCalled();
  });

  test('returns null when the gzip header is valid but the stream is garbage', async () => {
    const header = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff]);
    const file = writeFixture('garbage.tgz', Buffer.concat([header, junkBytes(4096)]));

    await expect(describeArchive(file)).resolves.toBeNull();
  });

  test('returns null when the gzip member is not a tar', async () => {
    const file = writeFixture('text.tar.gz', buildGzip('just some text, not a tar stream'));

    await expect(describeArchive(file)).resolves.toBeNull();
  });
});

describe('describeArchive - gzip member', () => {
  test('hand-built fixture is a valid gzip stream', () => {
    const gz = buildGzip('hello gzip', { name: 'notes.txt' });
    expect(zlib.gunzipSync(gz).toString('utf8')).toBe('hello gzip');
  });

  test('describes a member by its FNAME', async () => {
    const file = writeFixture('notes.txt.gz', buildGzip('hello gzip', { name: 'notes.txt' }));

    const result = await describeArchive(file);

    expect(result).toEqual({
      format: 'gzip',
      summary: 'gzip-compressed notes.txt',
      entryNames: ['notes.txt'],
      totalEntries: 1,
      truncated: false
    });
  });

  test('skips an FEXTRA block before reading FNAME', async () => {
    const extra = Buffer.from([0x41, 0x50, 0x04, 0x00, 1, 2, 3, 4]);
    const gz = buildGzip('payload', { name: 'report.csv', extra });
    expect(zlib.gunzipSync(gz).toString('utf8')).toBe('payload');
    const file = writeFixture('report.csv.gz', gz);

    const result = await describeArchive(file);

    expect(result.summary).toBe('gzip-compressed report.csv');
    expect(result.entryNames).toEqual(['report.csv']);
  });

  test('falls back to a generic summary when FNAME is absent', async () => {
    const file = writeFixture('anon.gz', buildGzip('no name here'));

    const result = await describeArchive(file);

    expect(result).toEqual({
      format: 'gzip',
      summary: 'gzip archive',
      entryNames: [],
      totalEntries: 1,
      truncated: false
    });
  });

  test('returns null for a .gz with a bad magic number', async () => {
    const file = writeFixture('bad.gz', junkBytes(64));

    await expect(describeArchive(file)).resolves.toBeNull();
    expect(logger.debug).toHaveBeenCalled();
  });

  test('ignores the size cap because only the header is read', async () => {
    const file = writeFixture('capped.gz', buildGzip('x'.repeat(2000), { name: 'x.log' }));

    const result = await describeArchive(file, { maxBytes: 10 });

    expect(result.summary).toBe('gzip-compressed x.log');
  });
});

describe('describeArchive - unknown extension', () => {
  test('sniffs a tar by its ustar magic', async () => {
    const built = buildTar(`${FIXTURES}/tmp.tar`, ['a.txt']);
    const file = writeFixture('blob-without-extension', fs.readFileSync(built));

    const result = await describeArchive(file);

    expect(result.format).toBe('tar');
    expect(result.entryNames).toEqual(['a.txt']);
  });

  test('sniffs a gzip member by its magic bytes', async () => {
    const file = writeFixture('blob.bin', buildGzip('data', { name: 'data.json' }));

    const result = await describeArchive(file);

    expect(result.format).toBe('gzip');
    expect(result.summary).toBe('gzip-compressed data.json');
  });

  test('returns null for an ordinary text file', async () => {
    const file = writeFixture('readme.txt', Buffer.from('plain text, nothing archived'));

    await expect(describeArchive(file)).resolves.toBeNull();
    expect(logger.debug).toHaveBeenCalled();
  });
});

describe('readGzipOriginalName', () => {
  test('returns the FNAME as Latin-1', async () => {
    const file = writeFixture('named.gz', buildGzip('body', { name: 'r\u00e9sum\u00e9.txt' }));

    await expect(readGzipOriginalName(file)).resolves.toBe('r\u00e9sum\u00e9.txt');
  });

  test('returns null when FNAME is absent', async () => {
    const file = writeFixture('unnamed.gz', buildGzip('body'));

    await expect(readGzipOriginalName(file)).resolves.toBeNull();
  });

  test('returns null for non-gzip content and empty files', async () => {
    const junk = writeFixture('not-gzip.gz', Buffer.from('definitely not gzip'));
    const empty = writeFixture('empty.gz', Buffer.alloc(0));

    await expect(readGzipOriginalName(junk)).resolves.toBeNull();
    await expect(readGzipOriginalName(empty)).resolves.toBeNull();
    expect(logger.debug).toHaveBeenCalled();
  });

  test('returns null when FNAME is flagged but never terminated', async () => {
    const header = Buffer.from([0x1f, 0x8b, 0x08, 0x08, 0, 0, 0, 0, 0x00, 0xff]);
    const file = writeFixture('unterminated.gz', Buffer.concat([header, Buffer.from('abc')]));

    await expect(readGzipOriginalName(file)).resolves.toBeNull();
  });

  test('returns null when a reserved FLG bit is set', async () => {
    const header = Buffer.from([0x1f, 0x8b, 0x08, 0x20, 0, 0, 0, 0, 0x00, 0xff]);
    const file = writeFixture('reserved.gz', Buffer.concat([header, Buffer.from([0])]));

    await expect(readGzipOriginalName(file)).resolves.toBeNull();
  });

  test('propagates ENOENT', async () => {
    await expect(readGzipOriginalName(`${FIXTURES}/nope.gz`)).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  test('returns null for non-string paths', async () => {
    await expect(readGzipOriginalName(undefined)).resolves.toBeNull();
  });

  test('returns null for a directory instead of throwing EISDIR', async () => {
    fs.mkdirSync(`${FIXTURES}/dir.gz`, { recursive: true });

    await expect(readGzipOriginalName(`${FIXTURES}/dir.gz`)).resolves.toBeNull();
  });

  test('reads FNAME when FCOMMENT and FHCRC are also set', async () => {
    const header = Buffer.from([0x1f, 0x8b, 0x08, 0x1a, 0, 0, 0, 0, 0x00, 0xff]);
    const gz = Buffer.concat([
      header,
      Buffer.from('n.txt\0', 'latin1'),
      Buffer.from('a comment\0', 'latin1'),
      Buffer.from([0, 0]),
      zlib.deflateRawSync(Buffer.from('x')),
      Buffer.alloc(8)
    ]);
    const file = writeFixture('flags.gz', gz);

    await expect(readGzipOriginalName(file)).resolves.toBe('n.txt');
  });
});

describe('describeArchive - adversarial inputs', () => {
  test('returns null for empty files regardless of extension', async () => {
    const empty = Buffer.alloc(0);
    await expect(describeArchive(writeFixture('e.gz', empty))).resolves.toBeNull();
    await expect(describeArchive(writeFixture('e.tgz', empty))).resolves.toBeNull();
    await expect(describeArchive(writeFixture('e.tar.gz', empty))).resolves.toBeNull();
    await expect(describeArchive(writeFixture('e-no-ext', empty))).resolves.toBeNull();
  });

  test('returns null for one-byte files of every extension', async () => {
    await expect(describeArchive(writeFixture('b.tar', Buffer.from([0x41])))).resolves.toBeNull();
    await expect(describeArchive(writeFixture('b.tgz', Buffer.from([0x1f])))).resolves.toBeNull();
    await expect(describeArchive(writeFixture('b.gz', Buffer.from([0x1f])))).resolves.toBeNull();
    await expect(describeArchive(writeFixture('b-no-ext', Buffer.from([0])))).resolves.toBeNull();
    await expect(
      readGzipOriginalName(writeFixture('c.gz', Buffer.from([0x1f])))
    ).resolves.toBeNull();
  });

  test('does not allocate or hang when a header claims an 8 GiB body', async () => {
    const bytes = Buffer.concat([
      tarHeader('big.bin', 8 * 1024 * 1024 * 1024),
      tarHeader('hidden.txt', 0),
      Buffer.alloc(1024)
    ]);
    const file = writeFixture('huge-claim.tar', bytes);

    const { value, elapsedMs } = await timed(() => describeArchive(file));

    expect(elapsedMs).toBeLessThan(1000);
    expect(value.format).toBe('tar');
    expect(value.entryNames).toEqual(['big.bin']);
    expect(value.totalEntries).toBeNull();
    expect(value.truncated).toBe(true);
    expect(value.summary).toMatch(/^TAR archive, damaged after 1 entry/);
  });

  test('rejects a gzip header whose XLEN overruns the file', async () => {
    const bytes = Buffer.from([0x1f, 0x8b, 0x08, 0x04, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 1, 2, 3]);
    const file = writeFixture('xlen.gz', bytes);

    await expect(describeArchive(file)).resolves.toBeNull();
    await expect(readGzipOriginalName(file)).resolves.toBeNull();
  });

  test('handles a 120 KiB control-character FNAME within a time bound', async () => {
    const name = Buffer.alloc(120 * 1024, 0x01);
    const gz = Buffer.concat([
      Buffer.from([0x1f, 0x8b, 0x08, 0x08, 0, 0, 0, 0, 0, 0xff]),
      name,
      Buffer.from([0]),
      zlib.deflateRawSync(Buffer.from('x')),
      Buffer.alloc(8)
    ]);
    const file = writeFixture('ctrl-name.gz', gz);

    const { value, elapsedMs } = await timed(() => describeArchive(file));

    expect(elapsedMs).toBeLessThan(1000);
    // Every character was a control character, so no usable name survives.
    expect(value).toEqual({
      format: 'gzip',
      summary: 'gzip archive',
      entryNames: [],
      totalEntries: 1,
      truncated: false
    });
  });

  test('gives up quickly on an FNAME that never terminates within the header window', async () => {
    const name = Buffer.alloc(200 * 1024, 0x61);
    const gz = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x08, 0, 0, 0, 0, 0, 0xff]), name]);
    const file = writeFixture('endless-name.gz', gz);

    const { value, elapsedMs } = await timed(() => describeArchive(file));

    expect(elapsedMs).toBeLessThan(1000);
    expect(value).toBeNull();
  });

  test('counts 10,000 entries within a time bound', async () => {
    const names = Array.from({ length: 10000 }, (_, i) => `dir/file-${i}.txt`);
    const file = writeFixture('ten-k.tar', buildEmptyEntriesTar(names));

    const { value, elapsedMs } = await timed(() => describeArchive(file));

    expect(elapsedMs).toBeLessThan(3000);
    expect(value.totalEntries).toBe(10000);
    expect(value.entryNames).toHaveLength(50);
    expect(value.entryNames[49]).toBe('dir/file-49.txt');
    expect(value.summary).toBe('TAR archive with 10000 entries (first 50 listed)');
  });

  test('reports a decompression-ratio abort as a truncated listing, not damage', async () => {
    const body = Buffer.alloc(1024 * 1024);
    const raw = Buffer.concat([tarHeader('zeros.bin', body.length), body, Buffer.alloc(1024)]);
    const file = writeFixture('bomb.tgz', zlib.gzipSync(raw, { level: 9 }));

    const { value, elapsedMs } = await timed(() =>
      describeArchive(file, { maxDecompressionRatio: 100 })
    );

    expect(elapsedMs).toBeLessThan(2000);
    expect(value.format).toBe('tgz');
    expect(value.entryNames).toEqual(['zeros.bin']);
    expect(value.totalEntries).toBeNull();
    expect(value.truncated).toBe(true);
    expect(value.summary).toBe('tar.gz archive with 1+ entries (first 1 listed)');
    expect(logger.debug).toHaveBeenCalled();
  });

  test('settles promptly on a gzip stream cut mid-archive', async () => {
    const full = buildTar(`${FIXTURES}/whole.tgz`, ['a.txt', 'b.txt', 'c.txt'], { gzip: true });
    const bytes = fs.readFileSync(full);
    const file = writeFixture('cut.tgz', bytes.subarray(0, Math.floor(bytes.length / 2)));

    const { value, elapsedMs } = await timed(() => describeArchive(file));

    // Well under the 5 s parser settle guard: the abort path must resolve directly.
    expect(elapsedMs).toBeLessThan(2000);
    if (value !== null) {
      expect(value.truncated).toBe(true);
      expect(value.totalEntries).toBeNull();
    }
  });
});
