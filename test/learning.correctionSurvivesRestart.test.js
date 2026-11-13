/**
 * @jest-environment node
 */
/**
 * "If I correct it, does it learn, or will it make the same mistakes next
 * time?" (Hans, retest item 16).
 *
 * Runs the real learning path against a temp userData dir: corrections are
 * recorded through LearningFeedbackService, the suggestion service shuts down
 * (as on quit), and a NEW service instance loads what was saved and ranks the
 * next file. Only the vector index and the text model are stubbed.
 */

jest.unmock('fs');
jest.unmock('fs/promises');

const mockLlamaService = {
  initialize: jest.fn().mockResolvedValue(undefined),
  getConfig: jest.fn().mockReturnValue({ textModel: 'test-model.gguf' }),
  generateText: jest.fn()
};

jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: () => mockLlamaService
}));
jest.mock('../src/main/services/PerformanceService', () => ({
  getRecommendedConcurrency: jest.fn().mockResolvedValue({
    maxConcurrent: 1,
    embeddingConcurrency: 3
  })
}));

const path = require('path');
const fsp = require('fs').promises;
const realOs = jest.requireActual('os');
const { app } = require('electron');
const OrganizationSuggestionService = require('../src/main/services/organization');
const {
  LearningFeedbackService,
  FEEDBACK_SOURCES
} = require('../src/main/services/organization/learningFeedback');

jest.setTimeout(30000);

let tmp;
let folders;

/** @param {any[]} queryFoldersResult - what the folder index returns for the next file */
function makeService(queryFoldersResult) {
  const vectorDb = {
    initialize: jest.fn().mockResolvedValue(true),
    isServerAvailable: jest.fn().mockResolvedValue(true),
    getStats: jest.fn().mockResolvedValue({ files: 120, fileChunks: 0, folders: 2 }),
    upsertFolder: jest.fn().mockResolvedValue({ success: true }),
    upsertFile: jest.fn().mockResolvedValue({ success: true }),
    upsertFeedbackMemory: jest.fn().mockResolvedValue({ success: true }),
    queryFeedbackMemory: jest.fn().mockResolvedValue([]),
    deleteFeedbackMemory: jest.fn().mockResolvedValue({ success: true }),
    resetFeedbackMemory: jest.fn().mockResolvedValue({ success: true }),
    queryFolders: jest.fn().mockResolvedValue(queryFoldersResult),
    queryFiles: jest.fn().mockResolvedValue([])
  };
  const folderMatching = {
    upsertFolderEmbedding: jest.fn().mockResolvedValue({ success: true }),
    upsertFileEmbedding: jest.fn().mockResolvedValue({ success: true }),
    matchVectorToFolders: jest.fn().mockResolvedValue([]),
    matchFileToFolders: jest.fn().mockResolvedValue([]),
    embedText: jest.fn().mockResolvedValue({ vector: new Array(1024).fill(0.1) })
  };
  const settings = {
    get: jest.fn(() => null),
    load: jest.fn().mockResolvedValue({ smartFolderRoutingMode: 'embedding' }),
    save: jest.fn().mockResolvedValue({ success: true })
  };
  return new OrganizationSuggestionService({
    vectorDbService: vectorDb,
    folderMatchingService: folderMatching,
    settingsService: settings
  });
}

const bingMatch = () => ({
  id: 'bing',
  score: 0.62,
  metadata: { folderName: 'Bing', path: folders[1].path }
});
const gscMatch = () => ({
  id: 'gsc',
  score: 0.61,
  metadata: { folderName: 'GSC', path: folders[0].path }
});

/** Move `count` xlsx files the analysis labeled "Bing" into GSC, then quit. */
async function correctIntoGsc(count) {
  const s1 = makeService([]);
  const learning = new LearningFeedbackService({
    suggestionService: s1,
    getSmartFolders: () => folders
  });
  for (let i = 0; i < count; i++) {
    const recorded = await learning.recordFileMove(
      path.join(tmp, 'in', `e${i}.xlsx`),
      path.join(folders[0].path, `e${i}.xlsx`),
      { category: 'Bing' },
      FEEDBACK_SOURCES.AUTO_ORGANIZE_CONFIRMED
    );
    expect(recorded).toBe(true);
  }
  // What the service container does on quit.
  await s1.shutdown();
}

/** A fresh instance (as after a restart) ranks the next file. */
async function suggestNext(queryFoldersResult, category = 'Bing') {
  const s2 = makeService(queryFoldersResult);
  const result = await s2.getSuggestionsForFile(
    {
      name: 'new.xlsx',
      extension: 'xlsx',
      path: path.join(tmp, 'in', 'new.xlsx'),
      analysis: { category, confidence: 0.7 }
    },
    folders,
    {
      routingModeOverride: 'embedding',
      skipSmartFolderEmbeddings: true,
      skipGeneration: true,
      skipImprovementCandidates: true,
      includeStructureAnalysis: false
    }
  );
  await s2.shutdown();
  return result;
}

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(realOs.tmpdir(), 'ss-learn-'));
  app.getPath.mockImplementation((name) => (name === 'userData' ? tmp : `/mock/${name}`));
  folders = [
    {
      id: 'gsc',
      name: 'GSC',
      path: path.join(tmp, 'GSC'),
      description: 'Google Search Console exports'
    },
    {
      id: 'bing',
      name: 'Bing',
      path: path.join(tmp, 'Bing'),
      description: 'Bing Webmaster exports'
    }
  ];
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('a correction survives a restart', () => {
  test('four corrections into GSC make GSC the next suggestion', async () => {
    await correctIntoGsc(4);
    await expect(fsp.access(path.join(tmp, 'user-patterns.json'))).resolves.toBeUndefined();

    const r = await suggestNext([bingMatch()]);
    expect(r.success).toBe(true);
    expect(r.primary.folder).toBe('GSC');
    expect(r.primary.source).toBe('user_pattern');
    expect(r.explanation).toBe("You've organized similar files this way before");
  });

  test('every correction is on disk once shutdown resolves', async () => {
    await correctIntoGsc(4);
    const saved = JSON.parse(await fsp.readFile(path.join(tmp, 'user-patterns.json'), 'utf8'));
    const patterns = new Map(saved.patterns);
    // The later moves land inside the 5 s save throttle; quit must flush them.
    expect(patterns.get('xlsx:bing:gsc')?.count).toBe(4);
  });

  test('one correction does not override the content match', async () => {
    await correctIntoGsc(1);
    const r = await suggestNext([bingMatch()]);
    expect(r.primary.folder).toBe('Bing');
  });

  test('the learning is scoped to the same type and label', async () => {
    await correctIntoGsc(4);
    const r = await suggestNext([bingMatch()], 'SEO');
    expect(r.primary.folder).toBe('Bing');
  });

  test('a content match that agrees with the learned folder keeps it', async () => {
    await correctIntoGsc(4);
    // The index also leans to GSC, a little below Bing. More evidence for
    // GSC must not hand the folder back to Bing.
    const r = await suggestNext([bingMatch(), gscMatch()]);
    expect(r.primary.folder).toBe('GSC');
    expect(r.primary.source).toBe('user_pattern');
  });
});
