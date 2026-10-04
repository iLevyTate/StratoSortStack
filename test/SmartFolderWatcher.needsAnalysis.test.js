/**
 * @jest-environment node
 *
 * _needsAnalysis must agree with what the history writer stored.
 *
 * The startup delta scan (K-04) asks _needsAnalysis for every file in every
 * watched folder. It used to say "yes" for every file already analyzed:
 *
 *   1. the writer hashes `path:size:<numeric mtimeMs>`; the watcher hashed
 *      `path:size:<ISO string>`, so the stored fileHash never matched;
 *   2. history stores the fractional mtimeMs (…670.4954); `new Date()` of it
 *      truncates to …670, and the fresh stat stayed fractional, so
 *      "current > stored" held for an untouched file;
 *   3. the hash embeds the path and an organize move does not recompute it.
 *
 * Every watcher suite mocks generateFileHash to a constant, which hid all
 * three. This one uses the real hash and the real recordAnalysisResult.
 */

// chokidar is ESM-only; _needsAnalysis never touches it.
jest.mock('chokidar', () => ({ watch: jest.fn() }));

jest.mock('../src/shared/logger', () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger: { ...l, setContext: jest.fn() }, createLogger: () => l };
});

const { generateFileHash } = require('../src/main/services/analysisHistory/indexManager');
const { recordAnalysisResult } = require('../src/main/ipc/analysisUtils');
const SmartFolderWatcher = require('../src/main/services/SmartFolderWatcher');

const FILE = '/library/Finance/q1-report.pdf';
// A real ext4/APFS/NTFS mtimeMs carries a fractional part.
const MTIME_MS = 1790639260670.4954;
const SIZE = 48213;

function statsFor({ size = SIZE, mtimeMs = MTIME_MS } = {}) {
  return {
    size,
    mtimeMs,
    mtime: new Date(mtimeMs),
    isFile: () => true,
    isDirectory: () => false
  };
}

/**
 * Run the real writer and build the stored row exactly as
 * AnalysisHistoryServiceCore._flushWrites does from the fileInfo it receives
 * (fileHash from path/size/lastModified; lastModified and fileSize copied).
 */
async function storedEntryFor(filePath, stats) {
  let captured = null;
  const analysisHistory = {
    getAnalysisByPath: jest.fn().mockResolvedValue(null),
    recordAnalysis: jest.fn(async (fileInfo) => {
      captured = fileInfo;
      return 'entry-1';
    })
  };
  await recordAnalysisResult({
    filePath,
    result: { category: 'Finance', summary: 'Q1 revenue', confidence: 90 },
    processingTime: 10,
    modelType: 'llm',
    analysisHistory,
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    fileStats: stats
  });
  expect(captured).not.toBeNull();
  return {
    id: 'entry-1',
    originalPath: captured.path,
    fileHash: generateFileHash(captured.path, captured.size, captured.lastModified),
    fileSize: captured.size,
    lastModified: captured.lastModified,
    timestamp: new Date(Math.floor(MTIME_MS) + 60_000).toISOString(),
    analysis: { category: 'Finance' },
    embedding: { status: 'done' }
  };
}

function makeWatcher(history) {
  return new SmartFolderWatcher({
    getSmartFolders: () => [],
    analysisHistoryService: history,
    analyzeDocumentFile: jest.fn(),
    analyzeImageFile: jest.fn(),
    settingsService: { load: jest.fn().mockResolvedValue({}) },
    vectorDbService: null,
    folderMatcher: null,
    notificationService: null
  });
}

describe('SmartFolderWatcher._needsAnalysis agrees with the history writer', () => {
  test('an untouched, already-analyzed file is not re-analyzed', async () => {
    const entry = await storedEntryFor(FILE, statsFor());
    const history = {
      getAnalysisByPath: jest.fn().mockResolvedValue(entry),
      getAnalysisByHash: jest.fn().mockResolvedValue(null)
    };
    const watcher = makeWatcher(history);

    await expect(watcher._needsAnalysis(FILE, MTIME_MS, statsFor())).resolves.toBe(false);
  });

  test('an organized file whose stored hash still names its old path is not re-analyzed', async () => {
    // Analyzed at the inbox path, then moved by organize: updateEntryPaths
    // re-keys originalPath but keeps the fileHash computed for the old path.
    const entry = await storedEntryFor('/library/Inbox/q1-report.pdf', statsFor());
    entry.originalPath = FILE;
    const history = {
      getAnalysisByPath: jest.fn().mockResolvedValue(entry),
      getAnalysisByHash: jest.fn().mockResolvedValue(null)
    };
    const watcher = makeWatcher(history);

    await expect(watcher._needsAnalysis(FILE, MTIME_MS, statsFor())).resolves.toBe(false);
  });

  test('the hash fallback lookup uses the writer hash, so it can actually hit', async () => {
    const entry = await storedEntryFor(FILE, statsFor());
    const history = {
      getAnalysisByPath: jest.fn().mockResolvedValue(null),
      getAnalysisByHash: jest.fn(async (hash) => (hash === entry.fileHash ? entry : null))
    };
    const watcher = makeWatcher(history);

    await expect(watcher._needsAnalysis(FILE, MTIME_MS, statsFor())).resolves.toBe(false);
    expect(history.getAnalysisByHash).toHaveBeenCalledWith(entry.fileHash);
  });

  test('a file edited after analysis is re-analyzed', async () => {
    const entry = await storedEntryFor(FILE, statsFor());
    const history = {
      getAnalysisByPath: jest.fn().mockResolvedValue(entry),
      getAnalysisByHash: jest.fn().mockResolvedValue(null)
    };
    const watcher = makeWatcher(history);

    const edited = statsFor({ mtimeMs: MTIME_MS + 1500 });
    await expect(watcher._needsAnalysis(FILE, edited.mtimeMs, edited)).resolves.toBe(true);
  });

  test('a file whose size changed is re-analyzed even with the same mtime', async () => {
    const entry = await storedEntryFor(FILE, statsFor());
    const history = {
      getAnalysisByPath: jest.fn().mockResolvedValue(entry),
      getAnalysisByHash: jest.fn().mockResolvedValue(null)
    };
    const watcher = makeWatcher(history);

    const grown = statsFor({ size: SIZE + 10 });
    await expect(watcher._needsAnalysis(FILE, MTIME_MS, grown)).resolves.toBe(true);
  });

  test('a file with no history is analyzed', async () => {
    const history = {
      getAnalysisByPath: jest.fn().mockResolvedValue(null),
      getAnalysisByHash: jest.fn().mockResolvedValue(null)
    };
    const watcher = makeWatcher(history);

    await expect(watcher._needsAnalysis(FILE, MTIME_MS, statsFor())).resolves.toBe(true);
  });
});

// A provisional (fallback) entry is retried only once the capability it
// lacked exists. For audio/video that capability is Whisper, not the text
// model: probing the text model retried every skipped video while Whisper was
// still missing, spent the retry budget, and never retried once it arrived.
describe('SmartFolderWatcher._capabilityNowAvailable', () => {
  function watcherWithModels({ whisper }) {
    const watcher = makeWatcher({
      getAnalysisByPath: jest.fn(),
      getAnalysisByHash: jest.fn()
    });
    watcher._getLlamaService = () => ({
      getConfig: async () => ({ textModel: 'qwen.gguf', visionModel: 'llava.gguf' }),
      listModels: async () => [{ name: 'qwen.gguf' }]
    });
    watcher._whisperAvailable = jest.fn().mockResolvedValue(whisper);
    return watcher;
  }

  test('media waits for Whisper even though the text model is installed', async () => {
    const watcher = watcherWithModels({ whisper: false });
    await expect(watcher._capabilityNowAvailable('/media/review.mp4')).resolves.toBe(false);
    await expect(watcher._capabilityNowAvailable('/docs/report.pdf')).resolves.toBe(true);
  });

  test('media is retried once Whisper is available', async () => {
    const watcher = watcherWithModels({ whisper: true });
    await expect(watcher._capabilityNowAvailable('/media/memo.m4a')).resolves.toBe(true);
  });

  test('images still wait for the vision model', async () => {
    const watcher = watcherWithModels({ whisper: true });
    await expect(watcher._capabilityNowAvailable('/photos/receipt.jpg')).resolves.toBe(false);
  });
});
