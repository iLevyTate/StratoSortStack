/**
 * What the saved session costs per file, and how many files it keeps.
 *
 * A tester queued 275 Search Console and SEO-tool exports. Each analysis result in
 * the renderer carries the file's full extracted text (up to ~64,000
 * characters, see analysisTextUtils.getMaxChunkableTextLength), so 200 of
 * them were far over the 4 MB save budget: the save fell back to 100, then
 * 50, then to no files at all, and the queue came back short (or empty) after
 * a restart. The snapshot now keeps a short preview of each text field, which
 * is all the renderer shows, and keeps 400 queued files and 1,000 organized.
 */

jest.mock('../src/shared/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, createLogger: jest.fn(() => logger) };
});

// The renderer's per-file text cap: CHUNK_SIZE + (CHUNK_SIZE - OVERLAP) * (MAX_CHUNKS - 1).
const MAX_EXTRACTED_TEXT = 1000 + 800 * 79;
// The save budget in persistenceMiddleware (estimated as 2 bytes per char).
const BUDGET_BYTES = 4 * 1024 * 1024;

const words = (count, seed) =>
  Array.from({ length: count }, (_, i) => `${seed}${i % 97}`)
    .join(' ')
    .slice(0, count);

/** A result as useAnalysis records it for a Search Console XLSX export. */
function realisticResult(i) {
  const name = `https___www.example-shop.com_-Performance-on-Search-2026-10-${i}.xlsx`;
  return {
    name,
    path: `/Users/alex/Downloads/GSC exports/${name}`,
    extension: '.xlsx',
    size: 48213 + i,
    isDirectory: false,
    type: 'file',
    created: '2026-10-01T09:12:44.000Z',
    modified: '2026-10-01T09:12:44.000Z',
    source: 'dialog',
    status: 'categorized',
    analyzedAt: '2026-11-12T14:03:22.512Z',
    analysis: {
      category: 'SEO Reports',
      subject: 'Search Console performance export',
      summary: words(600, 'summary'),
      purpose: words(300, 'purpose'),
      reasoning: words(400, 'reason'),
      keywords: ['search console', 'clicks', 'impressions', 'ctr', 'queries', 'pages', 'seo'],
      keyEntities: ['example-shop.com', 'Google', 'October 2026'],
      documentType: 'spreadsheet',
      entity: 'example-shop.com',
      project: 'SEO',
      documentDate: '2026-10-31',
      confidence: 82,
      smartFolder: 'SEO Reports',
      extractionMethod: 'content',
      contentLength: MAX_EXTRACTED_TEXT,
      rawText: words(500, 'row'),
      extractedText: words(MAX_EXTRACTED_TEXT, 'query'),
      llmSuggestedName: 'search-console-performance-2026-10.xlsx',
      originalSuggestedName: 'search-console-performance-2026-10.xlsx',
      suggestedName: `search-console-performance-2026-10-${i}.xlsx`,
      namingConvention: {
        convention: 'subject-date',
        dateFormat: 'YYYY-MM-DD',
        caseConvention: 'kebab-case',
        separator: '-'
      },
      embeddingPolicy: 'embed',
      embeddingStatus: 'done'
    }
  };
}

function selectedFile(i) {
  const { analysis: _analysis, status: _status, analyzedAt: _at, ...file } = realisticResult(i);
  return file;
}

function organizedEntry(i) {
  return {
    originalPath: `/Users/alex/Downloads/GSC exports/file-${i}.xlsx`,
    path: `/Users/alex/Documents/SEO Reports/search-console-performance-2026-10-${i}.xlsx`,
    originalName: `file-${i}.xlsx`,
    newName: `search-console-performance-2026-10-${i}.xlsx`,
    smartFolder: 'SEO Reports',
    organizedAt: '2026-11-12T15:00:00.000Z'
  };
}

function stateWith({ files = 0, organized = 0 } = {}) {
  return {
    ui: {
      currentPhase: 'organize',
      previousPhase: 'discover',
      sidebarOpen: true,
      settings: null,
      viewMode: 'phased',
      selectedTheme: 'primary'
    },
    files: {
      selectedFiles: Array.from({ length: files }, (_, i) => selectedFile(i)),
      organizedFiles: Array.from({ length: organized }, (_, i) => organizedEntry(i)),
      organizedPathIndex: [],
      smartFolders: [{ id: '1', name: 'SEO Reports', path: '/Users/alex/Documents/SEO Reports' }],
      namingConvention: null,
      lastOrganizeRun: null,
      fileStates: {}
    },
    analysis: {
      results: Array.from({ length: files }, (_, i) => realisticResult(i)),
      isAnalyzing: false,
      analysisProgress: { current: 0, total: 0, lastActivity: 0 },
      currentAnalysisFile: ''
    }
  };
}

const estimatedBytes = (value) => JSON.stringify(value).length * 2;

describe('persisted session size', () => {
  let buildStateSnapshot;

  beforeEach(() => {
    jest.resetModules();
    ({ buildStateSnapshot } = require('../src/renderer/store/middleware/persistenceMiddleware'));
  });

  test('measures one realistic analysis result before and after slimming', () => {
    const full = realisticResult(0);
    const fullBytes = estimatedBytes(full);
    const [slim] = buildStateSnapshot(stateWith({ files: 1 })).analysis.results;
    const slimBytes = estimatedBytes(slim);

    // The jest setup silences console; stderr keeps the measurement visible.
    process.stderr.write(
      `analysis result: ${fullBytes} bytes in memory, ${slimBytes} bytes saved; ` +
        `200 full results = ${((fullBytes * 200) / 1024 / 1024).toFixed(1)} MB ` +
        `against a ${BUDGET_BYTES / 1024 / 1024} MB budget\n`
    );
    expect(fullBytes * 200).toBeGreaterThan(BUDGET_BYTES);
    expect(slimBytes).toBeLessThan(fullBytes / 10);
  });

  test('keeps a short preview of each long text field and drops bulky arrays', () => {
    const result = realisticResult(0);
    result.analysis.ocrText = 'o'.repeat(5000);
    result.analysis.transcriptSegments = [{ start: 0, end: 1, text: 'hi' }];
    result.analysis.embedding = [0.1, 0.2];
    result.analysis._embeddingForPersistence = { vector: [0.1, 0.2] };
    const state = stateWith();
    state.analysis.results = [result];

    const [saved] = buildStateSnapshot(state).analysis.results;

    expect(saved.analysis.extractedText).toBe(result.analysis.extractedText.slice(0, 500));
    expect(saved.analysis.ocrText).toHaveLength(500);
    // The details panel still reports how much text the file really had.
    expect(saved.analysis.savedTextFullLength).toBe(MAX_EXTRACTED_TEXT + 5000);
    expect(saved.analysis).not.toHaveProperty('rawText');
    expect(saved.analysis).not.toHaveProperty('transcriptSegments');
    expect(saved.analysis).not.toHaveProperty('embedding');
    expect(saved.analysis).not.toHaveProperty('_embeddingForPersistence');
    // Everything the review list, the details panel and the move plan read is kept.
    for (const key of ['summary', 'keywords', 'suggestedName', 'category', 'contentLength']) {
      expect(saved.analysis[key]).toEqual(result.analysis[key]);
    }
    expect(saved.path).toBe(result.path);
    // The live state is not touched.
    expect(result.analysis.extractedText).toHaveLength(MAX_EXTRACTED_TEXT);
    expect(result.analysis.transcriptSegments).toHaveLength(1);
  });

  // The details panel shows a media file's keyframe captions and segment
  // count; they must survive a restart.
  test('keeps keyframe captions and the transcript segment count for media files', () => {
    const result = realisticResult(0);
    result.analysis.mediaKind = 'video';
    result.analysis.transcriptSegments = Array.from({ length: 120 }, (_, i) => ({
      start: i,
      end: i + 1,
      text: 'words '.repeat(20)
    }));
    result.analysis.keyframes = Array.from({ length: 60 }, (_, i) => ({
      timestamp: i * 5,
      caption: i % 2 ? `A chart on slide ${i}` : null,
      framePath: `/tmp/frame-${i}.jpg`
    }));
    const state = stateWith();
    state.analysis.results = [result];

    const [saved] = buildStateSnapshot(state).analysis.results;

    expect(saved.analysis).not.toHaveProperty('transcriptSegments');
    expect(saved.analysis.transcriptSegmentCount).toBe(120);
    expect(saved.analysis.keyframes).toHaveLength(50);
    expect(saved.analysis.keyframes[1]).toEqual({ timestamp: 5, caption: 'A chart on slide 1' });
    // Live state untouched.
    expect(result.analysis.keyframes).toHaveLength(60);
    expect(result.analysis.keyframes[1].framePath).toBe('/tmp/frame-1.jpg');
  });

  test('a result with no analysis (a failed file) is saved as it is', () => {
    const state = stateWith();
    state.analysis.results = [{ path: '/a.pdf', name: 'a.pdf', analysis: null, error: 'boom' }];
    expect(buildStateSnapshot(state).analysis.results).toEqual(state.analysis.results);
  });

  test('a 275-file batch is saved whole, within the budget', () => {
    const snapshot = buildStateSnapshot(stateWith({ files: 275, organized: 275 }));

    expect(snapshot.files.selectedFiles).toHaveLength(275);
    expect(snapshot.analysis.results).toHaveLength(275);
    expect(snapshot.files.organizedFiles).toHaveLength(275);
    expect(estimatedBytes(snapshot)).toBeLessThan(BUDGET_BYTES);
  });

  test('a full 400-file queue with 1,000 organized files still fits the budget', () => {
    const snapshot = buildStateSnapshot(stateWith({ files: 700, organized: 1200 }));

    expect(snapshot.files.selectedFiles).toHaveLength(400);
    expect(snapshot.analysis.results).toHaveLength(400);
    expect(snapshot.files.organizedFiles).toHaveLength(1000);
    // Newest kept.
    expect(snapshot.analysis.results[399].path).toContain('2026-10-699.xlsx');
    const bytes = estimatedBytes(snapshot);
    process.stderr.write(
      `400 files + 1,000 organized: ${(bytes / 1024 / 1024).toFixed(2)} MB saved\n`
    );
    expect(bytes).toBeLessThan(BUDGET_BYTES);
  });

  test('organized history keeps its own fields and drops nested objects', () => {
    const state = stateWith();
    state.files.organizedFiles = Array.from({ length: 300 }, (_, i) => ({
      ...organizedEntry(i),
      duplicateRemoval: i === 0 ? 'trashed' : undefined,
      analysis: { extractedText: 'x'.repeat(10000) }
    }));

    const saved = buildStateSnapshot(state).files.organizedFiles;

    expect(saved).toHaveLength(300);
    expect(saved[0]).toEqual({ ...organizedEntry(0), duplicateRemoval: 'trashed' });
    expect(saved.every((entry) => !('analysis' in entry))).toBe(true);
  });

  test('organized history keeps the newest 1,000 entries', () => {
    const state = stateWith({ organized: 1200 });
    const saved = buildStateSnapshot(state).files.organizedFiles;
    expect(saved).toHaveLength(1000);
    expect(saved[0]).toEqual(organizedEntry(200));
  });
});
