/**
 * Tests for the Phase 3 FastTriageClassifier Tier 0 cascade.
 *
 * The cascade is tested in priority order because higher-priority signals
 * short-circuit later checks — e.g. a file inside a Smart Folder must never
 * be trash-flagged even if its hash collides with another organized copy.
 */

jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

const {
  FastTriageClassifier,
  BUCKET,
  SIGNAL,
  _tokenizeFileName,
  _isInsideAny,
  _matchesAnyGlob
} = require('../src/main/services/triage/FastTriageClassifier');

describe('FastTriageClassifier helpers', () => {
  test('tokenizeFileName splits on non-alphanum and includes extension', () => {
    const tokens = _tokenizeFileName('acme-invoice-q3_2026.pdf');
    expect(tokens).toEqual(expect.arrayContaining(['acme', 'invoice', 'q3', '2026', 'pdf']));
  });

  test('tokenizeFileName enriches with semantic concepts for known extensions', () => {
    const tokens = _tokenizeFileName('foo.pdf');
    expect(tokens).toEqual(expect.arrayContaining(['pdf']));
    // Semantic extension map should add at least one document-related concept
    expect(tokens.length).toBeGreaterThan(1);
  });

  test('isInsideAny handles trailing slashes and case', () => {
    expect(_isInsideAny('/Users/me/Smart/Invoices/a.pdf', ['/Users/me/Smart/Invoices/'])).toBe(
      '/Users/me/Smart/Invoices/'
    );
    expect(_isInsideAny('/Users/me/Downloads/a.pdf', ['/Users/me/Smart'])).toBeNull();
  });

  test('matchesAnyGlob honors basename patterns', () => {
    expect(_matchesAnyGlob('foo.iso', ['*.iso'])).toBe('*.iso');
    expect(_matchesAnyGlob('setup-0.9.exe', ['setup-*.exe'])).toBe('setup-*.exe');
    expect(_matchesAnyGlob('doc.pdf', ['*.iso'])).toBeNull();
  });

  test('matchesAnyGlob still accepts a full path for a `**/` rule (control; the sweep fix is at the classifyFile call site, see 2b)', () => {
    // minimatch always matched a full path against `**/archived/**`; the old
    // defect was the caller handing it the basename, which 2b pins through
    // classifyFile. This only guards that the helper keeps reading full paths.
    expect(_matchesAnyGlob('/home/u/Downloads/archived/a.pdf', ['**/archived/**'])).toBe(
      '**/archived/**'
    );
    expect(_matchesAnyGlob('/home/u/Downloads/current/a.pdf', ['**/archived/**'])).toBeNull();
  });

  test('matchesAnyGlob reads a relative folder rule beneath the scan root only', () => {
    const root = '/home/u/Downloads';
    expect(_matchesAnyGlob('/home/u/Downloads/archived/a.pdf', ['archived/**'], root)).toBe(
      'archived/**'
    );
    // The root itself sits under an `archive` folder: not a match.
    expect(
      _matchesAnyGlob(
        '/home/u/archive/Downloads/a.pdf',
        ['archive/**'],
        '/home/u/archive/Downloads'
      )
    ).toBeNull();
    // Without a root the rule has nothing to anchor to and stays inert.
    expect(_matchesAnyGlob('/home/u/Downloads/archived/a.pdf', ['archived/**'])).toBeNull();
  });
});

describe('FastTriageClassifier.classifyFile cascade', () => {
  const baseContext = (overrides = {}) => ({
    smartFolders: [],
    smartFolderPaths: [],
    exclusionGlobs: [],
    minAgeMs: 24 * 60 * 60 * 1000,
    nowMs: 1_700_000_000_000,
    ...overrides
  });

  test('1. inside-smart-folder short-circuits the cascade', async () => {
    const classifier = new FastTriageClassifier({});
    const result = await classifier.classifyFile(
      {
        filePath: '/home/user/SmartFolders/Invoices/acme.pdf',
        fileName: 'acme.pdf',
        size: 100,
        mtimeMs: 0
      },
      baseContext({
        smartFolderPaths: ['/home/user/SmartFolders/Invoices'],
        exclusionGlobs: ['*.pdf'] // should NOT win — earlier rule fires first
      })
    );
    expect(result.bucket).toBe(BUCKET.EXCLUDED);
    expect(result.signal).toBe(SIGNAL.INSIDE_SMART_FOLDER);
  });

  test('2. pattern-exclusion fires before too-recent', async () => {
    const classifier = new FastTriageClassifier({});
    const now = 1_700_000_000_000;
    const result = await classifier.classifyFile(
      {
        filePath: '/tmp/setup-1.2.exe',
        fileName: 'setup-1.2.exe',
        size: 100,
        mtimeMs: now // would also trigger too-recent
      },
      baseContext({
        exclusionGlobs: ['setup-*.exe'],
        nowMs: now
      })
    );
    expect(result.bucket).toBe(BUCKET.EXCLUDED);
    expect(result.signal).toBe(SIGNAL.PATTERN_EXCLUSION);
    expect(result.why).toMatch(/setup-\*\.exe/);
  });

  test('2b. the Settings card example `**/archived/**` excludes files under that folder', async () => {
    const classifier = new FastTriageClassifier({});
    const result = await classifier.classifyFile(
      {
        filePath: '/home/user/Downloads/archived/report.pdf',
        fileName: 'report.pdf',
        size: 100,
        mtimeMs: 0
      },
      baseContext({ exclusionGlobs: ['**/archived/**'] })
    );
    expect(result.bucket).toBe(BUCKET.EXCLUDED);
    expect(result.signal).toBe(SIGNAL.PATTERN_EXCLUSION);
    expect(result.why).toContain('**/archived/**');
  });

  test('2c. a relative folder rule reads beneath the scanned folder, never above it', async () => {
    const classifier = new FastTriageClassifier({});
    const folderPath = 'D:\\Archive\\Photos';
    // Root D:\Archive\Photos with rule `Archive/**`: the file is not under
    // an Archive subfolder, so the sweep classifies it like any other.
    const above = await classifier.classifyFile(
      { filePath: 'D:\\Archive\\Photos\\x.pdf', fileName: 'x.pdf', size: 100, mtimeMs: 0 },
      baseContext({ exclusionGlobs: ['Archive/**'], folderPath })
    );
    expect(above.signal).not.toBe(SIGNAL.PATTERN_EXCLUSION);
    expect(above.bucket).toBe(BUCKET.AMBIGUOUS);
    // The sweep's always-on `node_modules/**` default must not swallow a
    // chosen folder whose ancestor happens to be named that.
    const defaultAbove = await classifier.classifyFile(
      {
        filePath: 'C:\\dev\\node_modules\\pkg\\Downloads\\x.pdf',
        fileName: 'x.pdf',
        size: 100,
        mtimeMs: 0
      },
      baseContext({
        exclusionGlobs: ['node_modules/**'],
        folderPath: 'C:\\dev\\node_modules\\pkg\\Downloads'
      })
    );
    expect(defaultAbove.signal).not.toBe(SIGNAL.PATTERN_EXCLUSION);
    // A descendant named Archive is what the rule means.
    const below = await classifier.classifyFile(
      {
        filePath: 'D:\\Archive\\Photos\\2019\\Archive\\x.pdf',
        fileName: 'x.pdf',
        size: 100,
        mtimeMs: 0
      },
      baseContext({ exclusionGlobs: ['Archive/**'], folderPath })
    );
    expect(below.bucket).toBe(BUCKET.EXCLUDED);
    expect(below.signal).toBe(SIGNAL.PATTERN_EXCLUSION);
    expect(below.why).toContain('Archive/**');
  });

  test('3. too-recent when no exclusion matches', async () => {
    const classifier = new FastTriageClassifier({});
    const now = 1_700_000_000_000;
    const result = await classifier.classifyFile(
      {
        filePath: '/tmp/doc.txt',
        fileName: 'doc.txt',
        size: 100,
        mtimeMs: now - 5 * 60 * 60 * 1000 // 5 hours old
      },
      baseContext({ nowMs: now })
    );
    expect(result.bucket).toBe(BUCKET.EXCLUDED);
    expect(result.signal).toBe(SIGNAL.TOO_RECENT);
    expect(result.why).toMatch(/5h old/);
  });

  test('4. hash-collision with organized file -> TRASH candidate', async () => {
    const classifier = new FastTriageClassifier({
      computeFileChecksum: async () => 'abc123',
      oramaService: {
        findByHash: jest.fn().mockResolvedValue([
          {
            id: 'f-organized',
            filePath: '/home/user/SmartFolders/Archive/old-invoice.pdf',
            fileHash: 'abc123'
          }
        ])
      }
    });
    const result = await classifier.classifyFile(
      {
        filePath: '/home/user/Downloads/old-invoice.pdf',
        fileName: 'old-invoice.pdf',
        size: 100,
        mtimeMs: 0 // old enough to pass too-recent
      },
      baseContext({
        smartFolderPaths: ['/home/user/SmartFolders/Archive']
      })
    );
    expect(result.bucket).toBe(BUCKET.TRASH);
    expect(result.signal).toBe(SIGNAL.HASH_COLLISION);
    expect(result.organizedPath).toBe('/home/user/SmartFolders/Archive/old-invoice.pdf');
    expect(result.hash).toBe('abc123');
  });

  test('4b. hash match with NO organized copy does not pre-select trash', async () => {
    const classifier = new FastTriageClassifier({
      computeFileChecksum: async () => 'abc123',
      oramaService: {
        findByHash: jest.fn().mockResolvedValue([
          {
            id: 'f-elsewhere',
            filePath: '/home/user/OtherSpot/copy.pdf', // NOT inside a smart folder
            fileHash: 'abc123'
          }
        ])
      }
    });
    const result = await classifier.classifyFile(
      {
        filePath: '/home/user/Downloads/copy.pdf',
        fileName: 'copy.pdf',
        size: 100,
        mtimeMs: 0
      },
      baseContext({
        smartFolderPaths: ['/home/user/SmartFolders/Archive']
      })
    );
    expect(result.bucket).not.toBe(BUCKET.TRASH);
  });

  test('5. cached-embedding -> KEEP when top folder match passes threshold', async () => {
    const classifier = new FastTriageClassifier({
      analysisHistory: {
        getAnalysisByPath: jest.fn().mockResolvedValue({
          embedding: { vector: [0.1, 0.2], model: 'test-model' }
        })
      },
      folderMatchingService: {
        matchVectorToFolders: jest
          .fn()
          .mockResolvedValue([
            { id: 'folder-1', name: 'Invoices', path: '/smart/invoices', confidence: 0.72 }
          ])
      }
    });
    const result = await classifier.classifyFile(
      {
        filePath: '/home/user/Downloads/unknown.pdf',
        fileName: 'unknown.pdf',
        size: 100,
        mtimeMs: 0
      },
      baseContext()
    );
    expect(result.bucket).toBe(BUCKET.KEEP);
    expect(result.signal).toBe(SIGNAL.CACHED_EMBEDDING);
    expect(result.suggestedFolder?.name).toBe('Invoices');
  });

  test('6. lexical match -> KEEP when multiple keywords overlap', async () => {
    const smartFolders = [
      {
        id: 'folder-inv',
        name: 'Invoices',
        path: '/smart/invoices',
        keywords: ['invoice', 'receipt', 'bill']
      }
    ];
    const FolderMatchingService = require('../src/main/services/FolderMatchingService');
    const folderMatching = Object.create(FolderMatchingService.prototype);
    const classifier = new FastTriageClassifier({ folderMatchingService: folderMatching });
    // Filename includes three folder keywords -> strong enough for KEEP.
    const result = await classifier.classifyFile(
      {
        filePath: '/home/user/Downloads/invoice-receipt-bill-2026.pdf',
        fileName: 'invoice-receipt-bill-2026.pdf',
        size: 100,
        mtimeMs: 0
      },
      baseContext({ smartFolders })
    );
    expect(result.bucket).toBe(BUCKET.KEEP);
    expect(result.signal).toBe(SIGNAL.LEXICAL_MATCH);
    expect(result.suggestedFolder?.name).toBe('Invoices');
    expect(result.why).toMatch(/invoice|receipt|bill/);
  });

  test('6b. weak lexical match (single keyword) -> AMBIGUOUS with suggestion', async () => {
    const smartFolders = [
      {
        id: 'folder-inv',
        name: 'Invoices',
        path: '/smart/invoices',
        keywords: ['invoice', 'receipt', 'bill']
      }
    ];
    const FolderMatchingService = require('../src/main/services/FolderMatchingService');
    const folderMatching = Object.create(FolderMatchingService.prototype);
    const classifier = new FastTriageClassifier({ folderMatchingService: folderMatching });
    const result = await classifier.classifyFile(
      {
        filePath: '/home/user/Downloads/random-invoice.pdf',
        fileName: 'random-invoice.pdf',
        size: 100,
        mtimeMs: 0
      },
      baseContext({ smartFolders })
    );
    // Single keyword overlap stays ambiguous — user confirms with deep scan.
    expect(result.bucket).toBe(BUCKET.AMBIGUOUS);
    expect(result.suggestedFolder?.name).toBe('Invoices');
    expect(result.why).toMatch(/Weak|needs deeper scan/);
  });

  test('fallback: AMBIGUOUS when nothing matches', async () => {
    const classifier = new FastTriageClassifier({});
    const result = await classifier.classifyFile(
      {
        filePath: '/home/user/Downloads/mystery.dat',
        fileName: 'mystery.dat',
        size: 100,
        mtimeMs: 0
      },
      baseContext()
    );
    expect(result.bucket).toBe(BUCKET.AMBIGUOUS);
    expect(result.signal).toBe(SIGNAL.NO_MATCH);
  });

  test('missing filePath returns ambiguous with clear reason', async () => {
    const classifier = new FastTriageClassifier({});
    const result = await classifier.classifyFile({}, baseContext());
    expect(result.bucket).toBe(BUCKET.AMBIGUOUS);
    expect(result.why).toMatch(/No file path/);
  });
});
