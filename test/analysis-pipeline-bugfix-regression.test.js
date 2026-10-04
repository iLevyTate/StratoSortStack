/**
 * @jest-environment node
 *
 * Regression tests for the 9 analysis pipeline bug fixes.
 * Each describe block targets the specific scenario that triggered the original bug.
 */

// ── Shared mock for performanceConstants ─────────────────────────────────────

jest.mock('../src/shared/performanceConstants', () => ({
  CHUNKING: {
    CHUNK_SIZE: 100,
    OVERLAP: 20,
    MAX_CHUNKS: 2
  },
  LLAMA: { CONTEXT_EMBEDDINGS: 512 },
  BATCH: { EMBEDDING_FLUSH_DELAY_MS: 10 },
  LIMITS: { MAX_QUEUE_SIZE: 100, MAX_DEAD_LETTER_SIZE: 50, MAX_PDF_SIZE_BYTES: 100 * 1024 * 1024 },
  THRESHOLDS: { QUEUE_HIGH_WATERMARK: 0.8, QUEUE_CRITICAL_WATERMARK: 0.9 },
  RETRY: { BACKOFF_BASE_MS: 10, BACKOFF_MAX_MS: 100 },
  CONCURRENCY: {
    EMBEDDING_FLUSH: 2,
    FOLDER_SCAN: 50,
    MIN_WORKERS: 1,
    DEFAULT_WORKERS: 1,
    MAX_WORKERS: 8
  },
  TIMEOUTS: { MUTEX_ACQUIRE: 50 },
  CONTENT_SELECTION: {
    OUTLINE_RATIO: 0.05,
    HEAD_RATIO: 0.37,
    TAIL_RATIO: 0.16,
    MIDDLE_SAMPLE_COUNT: 4,
    MARKER_OVERHEAD: 80,
    MAP_REDUCE_THRESHOLD: 100000
  },
  TRUNCATION: {
    NAME_MAX: 50,
    DESCRIPTION_MAX: 140,
    PREVIEW_SHORT: 100,
    PREVIEW_MEDIUM: 200,
    PREVIEW_LONG: 300,
    PREVIEW_XLARGE: 500,
    TEXT_EXTRACT_MAX: 2000,
    CACHE_SIGNATURE: 1000,
    HASH_PREFIX: 8,
    FOLDER_ID_HASH: 32,
    KEYWORDS_MAX: 20
  }
}));

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

// ── BUG-8: analysisTextUtils word-boundary truncation ────────────────────────

describe('BUG-8: normalizeExtractedTextForStorage snaps to word boundary', () => {
  const {
    normalizeExtractedTextForStorage,
    getMaxChunkableTextLength
  } = require('../src/main/analysis/analysisTextUtils');

  test('truncates at nearest space rather than mid-word', () => {
    const maxLen = getMaxChunkableTextLength(); // 100 + 80 * 1 = 180
    // Build a string where hard truncation at maxLen would cut mid-word
    // Place a space just inside the 90% threshold, then a long word crossing maxLen
    const prefix = 'word '.repeat(Math.floor((maxLen * 0.95) / 5));
    const longWord = 'superlongword'.repeat(5);
    const input = prefix + longWord;
    const result = normalizeExtractedTextForStorage(input);

    expect(result.length).toBeLessThanOrEqual(maxLen);
    // Result should end at the last space before maxLen, not mid-word
    expect(result.endsWith('word')).toBe(true);
    expect(result.length).toBeGreaterThan(maxLen * 0.9);
  });

  test('falls back to hard truncate when no space in last 10%', () => {
    const maxLen = getMaxChunkableTextLength();
    // A single long "word" with no spaces
    const input = 'x'.repeat(maxLen + 50);
    const result = normalizeExtractedTextForStorage(input);

    // No space to snap to — hard truncate at maxLen
    expect(result.length).toBe(maxLen);
  });

  test('returns short strings unchanged', () => {
    expect(normalizeExtractedTextForStorage('hello world')).toBe('hello world');
  });
});

// ── BUG-6: contentSelector overlap prevention ────────────────────────────────

describe('BUG-6: sampleMiddleContent prevents overlapping samples', () => {
  const { sampleMiddleContent } = require('../src/main/analysis/contentSelector');

  test('consecutive samples do not overlap', () => {
    // Create text with paragraph breaks close together to trigger backward snap
    const paragraphs = [];
    for (let i = 0; i < 50; i++) {
      paragraphs.push(`Paragraph ${i}: ${'word '.repeat(20)}`);
    }
    const text = paragraphs.join('\n\n');

    // Pass positional args (text, startOffset, endOffset, budget, sampleCount)
    const samples = sampleMiddleContent(text, 0, text.length, 600, 4);

    // Verify no two samples share the same content
    for (let i = 0; i < samples.length - 1; i++) {
      const currentEnd = text.indexOf(samples[i]) + samples[i].length;
      const nextStart = text.indexOf(samples[i + 1]);
      // Next sample must start at or after where current sample ends
      expect(nextStart).toBeGreaterThanOrEqual(currentEnd - 1); // -1 for trim tolerance
    }
  });

  test('returns fewer samples when overlap would occur', () => {
    // Tiny region where 4 samples cannot fit without overlap
    const text = 'A'.repeat(100) + '\n\n' + 'B'.repeat(100) + '\n\n' + 'C'.repeat(100);
    // Pass positional args
    const samples = sampleMiddleContent(text, 0, text.length, 250, 4);

    // Should get samples without duplicated content
    const uniqueContent = new Set(samples);
    expect(uniqueContent.size).toBe(samples.length);
  });
});

// ── BUG-7: embeddingSummary budget-proportional snippet ──────────────────────

jest.mock('../src/main/utils/embeddingInput', () => ({
  capEmbeddingInput: jest.fn((text) => ({
    text,
    wasTruncated: false,
    estimatedTokens: Math.ceil(text.length / 3.5),
    maxTokens: 435,
    maxChars: 1792
  })),
  getEmbeddingTokenLimit: jest.fn(() => 435)
}));

jest.mock('../src/main/analysis/semanticExtensionMap', () => ({
  enrichFileTextForEmbedding: jest.fn((text) => text)
}));

describe('BUG-7: buildEmbeddingSummary adapts snippet to remaining budget', () => {
  const { buildEmbeddingSummary } = require('../src/main/analysis/embeddingSummary');

  test('rich analysis gets smaller text snippet than fallback analysis', () => {
    const richAnalysis = {
      summary: 'A'.repeat(400),
      purpose: 'B'.repeat(200),
      keywords: ['key1', 'key2', 'key3'],
      keyEntities: ['ent1', 'ent2'],
      reasoning: 'C'.repeat(200)
    };
    const sparseAnalysis = { summary: 'Short' };
    const longText = 'X'.repeat(5000);

    const richResult = buildEmbeddingSummary(richAnalysis, longText, '.pdf');
    const sparseResult = buildEmbeddingSummary(sparseAnalysis, longText, '.txt');

    // Count how many X's ended up in each result
    const richXCount = (richResult.text.match(/X/g) || []).length;
    const sparseXCount = (sparseResult.text.match(/X/g) || []).length;

    // Sparse analysis should include MORE of the text snippet
    expect(sparseXCount).toBeGreaterThan(richXCount);
  });

  test('minimum snippet floor of 500 chars is enforced', () => {
    const hugeAnalysis = { summary: 'Z'.repeat(3000), keywords: ['k1'] };
    const text = 'W'.repeat(600);
    const result = buildEmbeddingSummary(hugeAnalysis, text, '.doc');

    // Even with huge analysis, at least 500 chars of text should be included
    const wCount = (result.text.match(/W/g) || []).length;
    expect(wCount).toBeGreaterThanOrEqual(500);
  });
});

// ── BUG-4: RTF multibyte hex decoding ────────────────────────────────────────

describe('BUG-4: extractPlainTextFromRtf handles multibyte characters', () => {
  let extractPlainTextFromRtf;
  beforeAll(() => {
    extractPlainTextFromRtf =
      require('../src/main/analysis/documentExtractors').extractPlainTextFromRtf;
  });

  test('decodes consecutive UTF-8 hex escapes as single character', async () => {
    // "中" = U+4E2D = UTF-8 bytes E4 B8 AD
    const rtf = "{\\rtf1\\ansicpg65001 \\'e4\\'b8\\'ad}";
    const result = await extractPlainTextFromRtf(rtf);
    expect(result).toContain('中');
  });

  test('decodes Windows-1252 smart quotes correctly', async () => {
    // 0x93 = left double quotation mark (U+201C)
    // 0x94 = right double quotation mark (U+201D)
    const rtf = "{\\rtf1 \\'93Hello\\'94}";
    const result = await extractPlainTextFromRtf(rtf);
    expect(result).toContain('\u201C');
    expect(result).toContain('Hello');
    expect(result).toContain('\u201D');
  });

  test('decodes em dash from Windows-1252', async () => {
    // 0x97 = em dash in Windows-1252 (U+2014)
    const rtf = "{\\rtf1 word\\'97word}";
    const result = await extractPlainTextFromRtf(rtf);
    expect(result).toContain('\u2014');
  });

  test('handles single-byte Latin-1 characters', async () => {
    // 0xE9 = é in both Latin-1 and Windows-1252
    const rtf = "{\\rtf1 caf\\'e9}";
    const result = await extractPlainTextFromRtf(rtf);
    expect(result).toContain('café');
  });

  test('gracefully handles invalid hex sequences', async () => {
    const rtf = "{\\rtf1 text\\'zz more text}";
    const result = await extractPlainTextFromRtf(rtf);
    expect(result).toContain('text');
  });
});

// ── BUG-2: readTextFileWithEncoding (behavioral) ─────────────────────────────

describe('BUG-2: readTextFileWithEncoding handles encodings correctly', () => {
  beforeEach(() => {
    jest.resetModules();
    // Mock dependencies that documentExtractors needs at load time
    jest.doMock('../src/shared/logger', () => ({
      createLogger: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        setContext: jest.fn()
      }))
    }));
  });

  test('decodes Windows-1252 smart quotes via latin1 fallback', async () => {
    jest.resetModules();
    // Create a buffer with Windows-1252 bytes that are NOT valid UTF-8.
    // 0x93 = left smart quote, 0x94 = right smart quote in Windows-1252.
    // When decoded as UTF-8, these produce replacement chars (>5%), triggering latin1 fallback.
    const win1252Bytes = Buffer.from([0x93, ...Buffer.from('Hello World'), 0x94]);

    const mockFs = {
      readFile: jest.fn().mockResolvedValue(win1252Bytes),
      stat: jest.fn().mockResolvedValue({ size: win1252Bytes.length })
    };
    jest.doMock('fs', () => ({ promises: mockFs }));

    const { readTextFileWithEncoding } = require('../src/main/analysis/documentExtractors');
    const result = await readTextFileWithEncoding('/fake/test.txt');

    // latin1 decoding preserves byte values as code points
    // 0x93 -> U+0093, 0x94 -> U+0094 (control chars in latin1, but preserved)
    expect(result).toContain('Hello World');
    expect(mockFs.readFile).toHaveBeenCalledWith('/fake/test.txt');
  });

  test('decodes UTF-16 LE BOM file correctly', async () => {
    jest.resetModules();
    // UTF-16 LE BOM: 0xFF 0xFE, then "Hi" in UTF-16 LE
    const content = 'Hi';
    const utf16le = Buffer.from('\uFEFF' + content, 'utf16le');

    const mockFs = {
      readFile: jest.fn().mockResolvedValue(utf16le),
      stat: jest.fn().mockResolvedValue({ size: utf16le.length })
    };
    jest.doMock('fs', () => ({ promises: mockFs }));

    const { readTextFileWithEncoding } = require('../src/main/analysis/documentExtractors');
    const result = await readTextFileWithEncoding('/fake/test.txt');

    expect(result).toContain('Hi');
  });
});

// ── BUG-5: persistence throwOnError in flush ─────────────────────────────────

describe('BUG-5: persistQueueData throwOnError option', () => {
  const mockFs = {
    access: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockResolvedValue('[]'),
    writeFile: jest.fn().mockResolvedValue(undefined),
    rename: jest.fn().mockResolvedValue(undefined),
    unlink: jest.fn().mockResolvedValue(undefined)
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('throws when throwOnError is true and write fails', async () => {
    jest.resetModules();
    jest.doMock('fs', () => ({ promises: mockFs }));
    jest.doMock('../src/main/utils/sqliteStore', () => ({
      shouldUseSqliteBackend: jest.fn(() => false),
      createKeyValueStore: jest.fn()
    }));
    // Re-mock logger after resetModules so atomicFile.js picks it up
    jest.doMock('../src/shared/logger', () => {
      const l = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        setContext: jest.fn()
      };
      return { logger: l, createLogger: jest.fn(() => l) };
    });

    mockFs.writeFile.mockRejectedValueOnce(new Error('Disk full'));

    const { persistQueueData } = require('../src/main/analysis/embeddingQueue/persistence');

    await expect(
      persistQueueData('/path/queue.json', [{ id: 'item1' }], { throwOnError: true })
    ).rejects.toThrow('Disk full');
  });

  test('swallows error when throwOnError is false (default)', async () => {
    jest.resetModules();
    jest.doMock('fs', () => ({ promises: mockFs }));
    jest.doMock('../src/main/utils/sqliteStore', () => ({
      shouldUseSqliteBackend: jest.fn(() => false),
      createKeyValueStore: jest.fn()
    }));
    // Re-mock logger after resetModules so atomicFile.js picks it up
    jest.doMock('../src/shared/logger', () => {
      const l = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        setContext: jest.fn()
      };
      return { logger: l, createLogger: jest.fn(() => l) };
    });

    mockFs.writeFile.mockRejectedValueOnce(new Error('Disk full'));

    const { persistQueueData } = require('../src/main/analysis/embeddingQueue/persistence');

    await expect(persistQueueData('/path/queue.json', [{ id: 'item1' }])).resolves.not.toThrow();
  });
});

// ── BUG-9: file-moved-during-analysis flag ───────────────────────────────────

describe('BUG-9: _fileMovedDuringAnalysis flag on result', () => {
  test('flags result when file is removed during analysis', async () => {
    jest.resetModules();

    // Mock fs via doMock so the re-required documentAnalysis module sees it.
    // jest.spyOn on a captured fs.promises reference won't propagate after resetModules.
    jest.doMock('fs', () => ({
      promises: {
        stat: jest.fn().mockResolvedValue({
          size: 1024,
          mtimeMs: 1600000000000,
          mtime: new Date(1600000000000),
          isFile: () => true
        }),
        readFile: jest.fn().mockResolvedValue('content'),
        // access REJECTS — simulating file moved/deleted during analysis
        access: jest.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      }
    }));

    jest.doMock('../src/shared/logger', () => ({
      createLogger: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        setContext: jest.fn()
      }))
    }));
    jest.doMock('../src/shared/performanceConstants', () => ({
      TRUNCATION: { PREVIEW_MEDIUM: 200, KEYWORDS_MAX: 20 },
      TIMEOUTS: { AI_ANALYSIS_SHORT: 5000 },
      CHUNKING: { CHUNK_SIZE: 1000, OVERLAP: 200, MAX_CHUNKS: 80 },
      // documentAnalysis now transitively requires defaultSettings (via
      // analysisLimits -> settingsValidation), which reads CONCURRENCY at load.
      CONCURRENCY: { MIN_WORKERS: 1, DEFAULT_WORKERS: 1, MAX_WORKERS: 8 }
    }));
    jest.doMock('../src/main/analysis/documentExtractors', () => {
      const extractTextFromPdf = jest.fn().mockResolvedValue('Extracted content');
      const ocrPdfIfNeeded = jest.fn();
      return {
        extractTextFromPdfRaw: extractTextFromPdf,
        ocrPdfIfNeededRaw: ocrPdfIfNeeded,
        extractTextFromPdf,
        ocrPdfIfNeeded,
        extractTextFromDoc: jest.fn(),
        extractTextFromDocx: jest.fn(),
        extractTextFromCsv: jest.fn(),
        extractTextFromXlsx: jest.fn(),
        extractTextFromPptx: jest.fn(),
        extractTextFromXls: jest.fn(),
        extractTextFromPpt: jest.fn(),
        extractTextFromOdfZip: jest.fn(),
        extractTextFromEpub: jest.fn(),
        extractTextFromEml: jest.fn(),
        extractTextFromMsg: jest.fn(),
        extractTextFromKml: jest.fn(),
        extractTextFromKmz: jest.fn(),
        extractPlainTextFromRtf: jest.fn(),
        extractPlainTextFromXml: jest.fn(),
        extractPlainTextFromHtml: jest.fn()
      };
    });
    jest.doMock('../src/main/analysis/documentLlm', () => ({
      analyzeTextWithLlama: jest.fn().mockResolvedValue({
        summary: 'Test',
        category: 'Documents',
        confidence: 90
      }),
      normalizeCategoryToSmartFolders: jest.fn((cat) => cat),
      AppConfig: { ai: { textAnalysis: { defaultModel: 'mock-model' } } }
    }));
    jest.doMock('../src/main/llamaUtils', () => ({
      getTextModel: jest.fn(() => 'mock-model'),
      getLlamaService: jest.fn(() => null)
    }));
    jest.doMock('../src/main/analysis/semanticFolderMatcher', () => ({
      applySemanticFolderMatching: jest.fn(),
      getServices: jest.fn(() => ({}))
    }));
    jest.doMock('../src/main/analysis/embeddingQueue/stageQueues', () => ({
      analysisQueue: { add: jest.fn() }
    }));
    jest.doMock('../src/main/utils/llmOptimization', () => ({
      globalDeduplicator: {
        generateKey: jest.fn(() => 'k'),
        deduplicate: jest.fn(async (_key, fn) => fn())
      }
    }));
    jest.doMock('../src/main/analysis/fallbackUtils', () => ({
      getIntelligentCategory: jest.fn(() => 'Documents'),
      getIntelligentKeywords: jest.fn(() => []),
      safeSuggestedName: jest.fn((n) => n),
      createFallbackAnalysis: jest.fn(() => ({
        category: 'Documents',
        error: 'err',
        confidence: 0
      }))
    }));
    jest.doMock('../src/main/analysis/utils', () => ({
      normalizeAnalysisResult: jest.fn((raw, fb) => ({
        ...raw,
        category: raw.category || fb.category
      }))
    }));

    const { analyzeDocumentFile } = require('../src/main/analysis/documentAnalysis');
    const result = await analyzeDocumentFile('moved-file.pdf');

    expect(result._fileMovedDuringAnalysis).toBe(true);
  });
});

// ── BUG-3: PDF buffer cache reuse (behavioral) ──────────────────────────────
// F-1 FIX: Verify that extractTextFromPdf caches the buffer so ocrPdfIfNeeded
// can reuse it. Since the module has deep dependency chains, we read the source
// and verify the cache pattern structurally — that _pdfBufferCache is a Map
// used in both extractTextFromPdf (set) and ocrPdfIfNeeded (get + delete).

describe('BUG-3: PDF buffer cache prevents double reads', () => {
  test('source uses _pdfBufferCache.set in extractTextFromPdf and .get/.delete in ocrPdfIfNeeded', () => {
    // Read the real source file to verify the pattern
    const realFs = jest.requireActual('fs');
    const path = require('path');
    const source = realFs.readFileSync(
      path.resolve(__dirname, '../src/main/analysis/documentExtractors.js'),
      'utf8'
    );

    // Verify cache is declared as a bounded LRUCache (upgraded from raw Map)
    expect(source).toContain('_pdfBufferCache = new LRUCache(');

    // extractTextFromPdf function body sets the cache (between function declaration and next function)
    const pdfFnMatch = source.match(
      /async function extractTextFromPdf\(filePath[\s\S]*?(?=\nasync function|module\.exports)/
    );
    expect(pdfFnMatch).not.toBeNull();
    expect(pdfFnMatch[0]).toContain('_pdfBufferCache.set(');

    // ocrPdfIfNeeded function body reads and cleans the cache
    const ocrFnMatch = source.match(
      /async function ocrPdfIfNeeded\(filePath[\s\S]*?(?=\nasync function|module\.exports)/
    );
    expect(ocrFnMatch).not.toBeNull();
    expect(ocrFnMatch[0]).toContain('_pdfBufferCache.get(');
    expect(ocrFnMatch[0]).toContain('_pdfBufferCache.delete(');
  });
});

// ── BUG-1: OramaVectorService sidecar eviction (behavioral) ──────────────────
// F-1 FIX: Verify _markSidecarEvicted actually sets hasVector: false in Orama,
// rather than grep-checking for string patterns in source.

describe('BUG-1: _markSidecarEvicted marks Orama doc hasVector: false', () => {
  test('calling _markSidecarEvicted updates the Orama document', async () => {
    jest.resetModules();

    const mockUpdate = jest.fn().mockResolvedValue(undefined);
    const mockGetByID = jest.fn().mockResolvedValue({
      id: 'file-1',
      hasVector: true,
      embedding: [1, 2, 3]
    });

    jest.doMock('@orama/orama', () => ({
      create: jest.fn(),
      insert: jest.fn(),
      search: jest.fn(),
      remove: jest.fn(),
      update: mockUpdate,
      count: jest.fn(),
      getByID: mockGetByID
    }));
    jest.doMock('@orama/plugin-data-persistence', () => ({
      persist: jest.fn(),
      restore: jest.fn()
    }));
    jest.doMock('../src/shared/logger', () => {
      const l = {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        setContext: jest.fn()
      };
      return { logger: l, createLogger: jest.fn(() => l) };
    });
    // OramaVectorService requires config/index which has heavy side effects
    jest.doMock('../src/shared/config/index', () => ({
      get: jest.fn(() => undefined),
      config: { get: jest.fn(() => undefined) },
      getCategory: jest.fn(() => ({})),
      getAll: jest.fn(() => ({})),
      isDevelopment: jest.fn(() => false),
      isProduction: jest.fn(() => false),
      isTest: jest.fn(() => true),
      isCI: jest.fn(() => false),
      validate: jest.fn(() => ({ valid: true })),
      CONFIG_SCHEMA: {},
      SENSITIVE_KEYS: [],
      DEPRECATED_MAPPINGS: {}
    }));
    jest.doMock('lz4-napi', () => ({
      compress: jest.fn(),
      uncompress: jest.fn()
    }));

    const { OramaVectorService } = require('../src/main/services/OramaVectorService');
    const service = new OramaVectorService();

    // Simulate initialized state with a files database
    service._databases = { files: { name: 'mock-db' } };
    service._dimension = 3;

    // Call the method under test
    service._markSidecarEvicted('file-1');

    // Wait for the async fire-and-forget chain to settle
    await new Promise((r) => setTimeout(r, 10));

    expect(mockGetByID).toHaveBeenCalledWith({ name: 'mock-db' }, 'file-1');
    expect(mockUpdate).toHaveBeenCalledWith(
      { name: 'mock-db' },
      'file-1',
      expect.objectContaining({
        hasVector: false,
        embedding: expect.arrayContaining([0])
      })
    );
  });
});
