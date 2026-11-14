/**
 * @jest-environment node
 */
/**
 * "If I correct it, does it learn?" in LLM-only and Hybrid routing (retest
 * item 16).
 *
 * In those modes the analysis label that names a folder is lifted to at least
 * 0.95 and weighted x1.5, and the correction penalty needs embeddings, so no
 * number of corrections used to move it. Once two different files with the
 * same type and label were moved from the folder StratoSort picked into the
 * same other folder, the next such file is suggested for that other folder.
 *
 * Runs the real learning path against a temp userData dir, like
 * learning.correctionSurvivesRestart.test.js. Embeddings are unavailable
 * (embedText and queryFeedbackMemory reject), so only the stored correction
 * can drive the override.
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
jest.mock('../src/main/services/organization/llmSuggester', () => ({
  ...jest.requireActual('../src/main/services/organization/llmSuggester'),
  getLLMAlternativeSuggestions: jest.fn().mockResolvedValue([])
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
const { calculateConfidence } = require('../src/main/services/organization/suggestionRanker');
const { getLLMAlternativeSuggestions } = require('../src/main/services/organization/llmSuggester');

jest.setTimeout(30000);

let tmp;
let folders;

const folder = (name) => folders.find((f) => f.name === name);

/**
 * @param {{ mode?: string, queryFolders?: any[] }} [opts]
 */
function makeService({ mode = 'llm', queryFolders = [] } = {}) {
  const vectorDb = {
    initialize: jest.fn().mockResolvedValue(true),
    isServerAvailable: jest.fn().mockResolvedValue(true),
    getStats: jest.fn().mockResolvedValue({ files: 0, fileChunks: 0, folders: 0 }),
    upsertFolder: jest.fn().mockResolvedValue({ success: true }),
    upsertFile: jest.fn().mockResolvedValue({ success: true }),
    upsertFeedbackMemory: jest.fn().mockResolvedValue({ success: true }),
    queryFeedbackMemory: jest.fn().mockRejectedValue(new Error('embeddings unavailable')),
    deleteFeedbackMemory: jest.fn().mockResolvedValue({ success: true }),
    resetFeedbackMemory: jest.fn().mockResolvedValue({ success: true }),
    queryFolders: jest.fn().mockResolvedValue(queryFolders),
    queryFiles: jest.fn().mockResolvedValue([])
  };
  const folderMatching = {
    upsertFolderEmbedding: jest.fn().mockResolvedValue({ success: true }),
    upsertFileEmbedding: jest.fn().mockResolvedValue({ success: true }),
    matchVectorToFolders: jest.fn().mockResolvedValue([]),
    matchFileToFolders: jest.fn().mockResolvedValue([]),
    embedText: jest.fn().mockRejectedValue(new Error('embeddings unavailable'))
  };
  const settings = {
    get: jest.fn(() => null),
    load: jest.fn().mockResolvedValue({ smartFolderRoutingMode: mode }),
    save: jest.fn().mockResolvedValue({ success: true })
  };
  return new OrganizationSuggestionService({
    vectorDbService: vectorDb,
    folderMatchingService: folderMatching,
    settingsService: settings
  });
}

function makeLearning(service) {
  return new LearningFeedbackService({
    suggestionService: service,
    getSmartFolders: () => folders
  });
}

/**
 * What batch Organize does when the grid suggested `from` and the user sent
 * the file to `to`: learn the placement, then record the correction.
 * @returns {Promise<string>} where the file landed
 */
async function correct(
  learning,
  name,
  { from = 'Invoices', to = 'Receipts', category = 'invoices', ext = 'pdf' } = {}
) {
  const dest = path.join(folder(to).path, `${name}.${ext}`);
  await learning.recordFileMove(
    path.join(tmp, 'in', `${name}.${ext}`),
    dest,
    { category },
    FEEDBACK_SOURCES.AUTO_ORGANIZE_CONFIRMED
  );
  const recorded = await learning.recordCorrection({
    filePath: dest,
    wrongFolder: from,
    correctFolder: to,
    oldCategory: category
  });
  expect(recorded).toBe(true);
  return dest;
}

/** Rank the next file the way the Organize grid does. */
function suggest(
  service,
  { category = 'invoices', ext = 'pdf', smartFolders = folders, ...options } = {}
) {
  return service.getSuggestionsForFile(
    {
      name: `next.${ext}`,
      extension: ext,
      path: path.join(tmp, 'in', `next.${ext}`),
      analysis: { category, confidence: 0.85 }
    },
    smartFolders,
    {
      skipSmartFolderEmbeddings: true,
      skipGeneration: true,
      skipImprovementCandidates: true,
      includeStructureAnalysis: false,
      ...options
    }
  );
}

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(realOs.tmpdir(), 'ss-llm-learn-'));
  app.getPath.mockImplementation((name) => (name === 'userData' ? tmp : `/mock/${name}`));
  folders = ['Invoices', 'Receipts', 'Taxes', 'Contracts'].map((name) => ({
    id: name.toLowerCase(),
    name,
    path: path.join(tmp, name),
    description: `${name} folder`
  }));
  getLLMAlternativeSuggestions.mockResolvedValue([]);
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('LLM-only mode: corrections override the label folder', () => {
  test('(a) one correction does not override the label folder', async () => {
    const service = makeService();
    await correct(makeLearning(service), 'a1');
    const r = await suggest(service);
    expect(r.success).toBe(true);
    expect(r.routing.mode).toBe('llm');
    expect(r.primary.folder).toBe('Invoices');
    expect(r.primary.learnedOverride).toBeUndefined();
    await service.shutdown();
  });

  test('(b) two different files corrected the same way make the corrected folder primary', async () => {
    const service = makeService();
    const learning = makeLearning(service);
    await correct(learning, 'b1');
    await correct(learning, 'b2');
    const r = await suggest(service);
    expect(r.primary.folder).toBe('Receipts');
    expect(r.primary.method).toBe('learned_correction');
    // The learned pattern from the same moves is promoted, with its own evidence.
    expect(r.primary.source).toBe('user_pattern');
    expect(r.primary.learnedOverride).toEqual({ from: 'Invoices', files: 2 });
    expect(r.alternatives.map((s) => s.folder)).toContain('Invoices');
    expect(r.explanation).toBe('You moved 2 similar files from "Invoices" to "Receipts"');
    await service.shutdown();
  });

  test('(c) the same file corrected twice does not override', async () => {
    const service = makeService();
    const learning = makeLearning(service);
    await correct(learning, 'c1');
    await correct(learning, 'c1');
    const r = await suggest(service);
    expect(r.primary.folder).toBe('Invoices');
    await service.shutdown();
  });

  test('(d) corrections split between two folders do not override', async () => {
    const service = makeService();
    const learning = makeLearning(service);
    await correct(learning, 'd1', { to: 'Receipts' });
    await correct(learning, 'd2', { to: 'Taxes' });
    const r = await suggest(service);
    expect(r.primary.folder).toBe('Invoices');
    await service.shutdown();
  });

  test('(e) the override is scoped to the same file type and label', async () => {
    const service = makeService();
    const learning = makeLearning(service);
    await correct(learning, 'e1');
    await correct(learning, 'e2');

    const png = await suggest(service, { ext: 'png' });
    expect(png.primary.folder).toBe('Invoices');
    expect(png.primary.learnedOverride).toBeUndefined();

    const contracts = await suggest(service, { category: 'contracts' });
    expect(contracts.primary.folder).toBe('Contracts');
    expect(contracts.primary.learnedOverride).toBeUndefined();
    await service.shutdown();
  });

  test('(f) the override survives a restart', async () => {
    const s1 = makeService();
    const learning = makeLearning(s1);
    await correct(learning, 'f1');
    await correct(learning, 'f2');
    await s1.shutdown();

    const s2 = makeService();
    const r = await suggest(s2);
    expect(r.primary.folder).toBe('Receipts');
    expect(r.primary.learnedOverride).toEqual({ from: 'Invoices', files: 2 });
    await s2.shutdown();
  });

  test('(g) undoing one corrected file brings the label folder back', async () => {
    const service = makeService();
    const learning = makeLearning(service);
    const first = await correct(learning, 'g1');
    await correct(learning, 'g2');
    expect((await suggest(service)).primary.folder).toBe('Receipts');

    const retracted = await learning.retractFileFeedback(first);
    expect(retracted.memoriesRemoved).toBe(1);
    const r = await suggest(service);
    expect(r.primary.folder).toBe('Invoices');
    expect(r.primary.learnedOverride).toBeUndefined();
    await service.shutdown();
  });

  test('(h) after two corrections the override stays below the auto-move threshold', async () => {
    const service = makeService();
    const learning = makeLearning(service);
    await correct(learning, 'h1');
    await correct(learning, 'h2');
    const r = await suggest(service);
    expect(r.primary.folder).toBe('Receipts');
    expect(calculateConfidence(r.primary)).toBeLessThan(0.75);
    // 2/3 similarity x 0.7 pattern confidence x 1.3 user_pattern boost.
    expect(r.confidence).toBeCloseTo(0.61, 2);
    const invoices = r.alternatives.find((s) => s.folder === 'Invoices');
    expect(invoices).toBeDefined();
    expect(invoices.confidence).toBeLessThanOrEqual(0.7);
    expect(invoices.score).toBeLessThanOrEqual(0.7);
    expect(calculateConfidence(invoices)).toBeLessThanOrEqual(0.7);
    await service.shutdown();
  });

  test('(i) the override also wins over generated LLM suggestions', async () => {
    getLLMAlternativeSuggestions.mockResolvedValue([
      {
        folder: 'Invoices',
        path: path.join(tmp, 'Invoices'),
        score: 0.9,
        confidence: 0.9,
        method: 'llm_creative',
        isSmartFolder: true
      }
    ]);
    const service = makeService();
    const learning = makeLearning(service);
    await correct(learning, 'i1');
    await correct(learning, 'i2');
    const r = await suggest(service, { skipGeneration: false });
    expect(getLLMAlternativeSuggestions).toHaveBeenCalled();
    expect(r.primary.folder).toBe('Receipts');
    expect(r.primary.learnedOverride).toEqual({ from: 'Invoices', files: 2 });
    await service.shutdown();
  });

  test('(j) no override when the corrected-to folder is no longer a smart folder', async () => {
    const service = makeService();
    const learning = makeLearning(service);
    await correct(learning, 'j1');
    await correct(learning, 'j2');
    const r = await suggest(service, {
      smartFolders: folders.filter((f) => f.name !== 'Receipts')
    });
    expect(r.primary.folder).toBe('Invoices');
    expect(r.primary.learnedOverride).toBeUndefined();
    await service.shutdown();
  });
});

describe('other routing modes', () => {
  const invoicesMatch = (score) => ({
    id: 'invoices',
    score,
    metadata: { folderName: 'Invoices', path: folder('Invoices').path }
  });
  const receiptsMatch = (score) => ({
    id: 'receipts',
    score,
    metadata: { folderName: 'Receipts', path: folder('Receipts').path }
  });

  test('(k) Hybrid with a weak semantic match: the override applies', async () => {
    const service = makeService({ mode: 'hybrid', queryFolders: [invoicesMatch(0.5)] });
    const learning = makeLearning(service);
    await correct(learning, 'k1');
    await correct(learning, 'k2');
    const r = await suggest(service);
    expect(r.routing.mode).toBe('hybrid');
    expect(r.primary.folder).toBe('Receipts');
    expect(r.primary.learnedOverride).toEqual({ from: 'Invoices', files: 2 });
    await service.shutdown();
  });

  test('(l) Embedding mode with no corrections ranks as before', async () => {
    const service = makeService({
      mode: 'embedding',
      queryFolders: [invoicesMatch(0.62), receiptsMatch(0.6)]
    });
    const r = await suggest(service);
    expect(r.routing.mode).toBe('embedding');
    expect(r.primary.folder).toBe('Invoices');
    expect(r.primary.method).toBe('semantic_vector_db');
    expect(r.primary.score).toBeCloseTo(0.62);
    expect(r.alternatives[0].folder).toBe('Receipts');
    expect(r.alternatives[0].score).toBeCloseTo(0.6);
    expect([r.primary, ...r.alternatives].some((s) => s.learnedOverride)).toBe(false);
    expect(r.explanation).toBe('This file\'s meaning matches "Invoices"');
    await service.shutdown();
  });

  test('Embedding mode: two corrections override too (the step runs in every mode)', async () => {
    const service = makeService({
      mode: 'embedding',
      queryFolders: [invoicesMatch(0.9), receiptsMatch(0.45)]
    });
    const learning = makeLearning(service);
    await correct(learning, 'm1');
    await correct(learning, 'm2');
    const r = await suggest(service);
    expect(r.primary.folder).toBe('Receipts');
    expect(r.primary.learnedOverride).toEqual({ from: 'Invoices', files: 2 });
    // The overridden folder is capped below the auto-move threshold.
    const invoices = r.alternatives.find((s) => s.folder === 'Invoices');
    expect(invoices.confidence).toBeLessThanOrEqual(0.7);
    await service.shutdown();
  });

  test('a legacy correction memory without a structured correction is ignored', async () => {
    const service = makeService();
    for (const name of ['old1', 'old2']) {
      await service.recordFeedbackNote(
        { name: `${name}.pdf`, extension: 'pdf' },
        { folder: 'Invoices' },
        false,
        `Files like "${name}.pdf" do not belong in "Invoices"; they belong in "Receipts".`,
        { filePath: path.join(folder('Receipts').path, `${name}.pdf`) }
      );
    }
    const r = await suggest(service);
    expect(r.primary.folder).toBe('Invoices');
    await service.shutdown();
  });
});

describe('review follow-ups', () => {
  test('later corrections the other way cancel the override', async () => {
    const service = makeService();
    const learning = makeLearning(service);
    await correct(learning, 'r1');
    await correct(learning, 'r2');
    expect((await suggest(service)).primary.folder).toBe('Receipts');

    await correct(learning, 'r3', { from: 'Receipts', to: 'Invoices' });
    await correct(learning, 'r4', { from: 'Receipts', to: 'Invoices' });
    const r = await suggest(service);
    expect(r.primary.folder).toBe('Invoices');
    expect(r.primary.learnedOverride).toBeUndefined();
    await service.shutdown();
  });

  test('corrections away from the override into a third folder cancel it too', async () => {
    const service = makeService();
    const learning = makeLearning(service);
    await correct(learning, 't1');
    await correct(learning, 't2');
    await correct(learning, 't3', { from: 'Receipts', to: 'Taxes' });
    await correct(learning, 't4', { from: 'Receipts', to: 'Taxes' });
    const r = await suggest(service);
    expect(r.primary.folder).not.toBe('Receipts');
    expect(r.primary.learnedOverride).toBeUndefined();
    await service.shutdown();
  });

  test('editing a correction memory stops it driving the override', async () => {
    const service = makeService();
    const learning = makeLearning(service);
    await correct(learning, 'u1');
    await correct(learning, 'u2');
    expect((await suggest(service)).primary.folder).toBe('Receipts');

    const memories = await service.feedbackMemoryStore.list();
    const note = memories.find((m) => m.source === 'feedback_reject');
    const edited = await service.updateFeedbackMemory(note.id, 'invoice pdfs go to Taxes');
    expect(edited.correction).toBeUndefined();
    const r = await suggest(service);
    expect(r.primary.folder).toBe('Invoices');
    expect(r.primary.learnedOverride).toBeUndefined();
    await service.shutdown();
  });

  test('re-saving a correction memory with the same text keeps it', async () => {
    const service = makeService();
    const learning = makeLearning(service);
    await correct(learning, 'v1');
    await correct(learning, 'v2');
    const memories = await service.feedbackMemoryStore.list();
    const note = memories.find((m) => m.source === 'feedback_reject');
    const saved = await service.updateFeedbackMemory(note.id, note.text);
    expect(saved.correction).toEqual(note.correction);
    expect((await suggest(service)).primary.folder).toBe('Receipts');
    await service.shutdown();
  });

  test('a fresh override is held for review even when its folder has strong evidence of its own', async () => {
    getLLMAlternativeSuggestions.mockResolvedValue([
      {
        folder: 'Receipts',
        path: path.join(tmp, 'Receipts'),
        score: 0.8,
        confidence: 0.8,
        isSmartFolder: true
      }
    ]);
    const service = makeService();
    const learning = makeLearning(service);
    await correct(learning, 'w1');
    await correct(learning, 'w2');
    const r = await suggest(service, { skipGeneration: false });
    expect(r.primary.folder).toBe('Receipts');
    expect(r.primary.learnedOverride).toEqual({ from: 'Invoices', files: 2 });
    expect(r.confidence).toBeLessThanOrEqual(0.7);
    expect(calculateConfidence(r.primary)).toBeLessThanOrEqual(0.7);
    await service.shutdown();
  });

  test('once the learned pattern itself matures, the override may pass the auto-move threshold', async () => {
    getLLMAlternativeSuggestions.mockResolvedValue([
      {
        folder: 'Receipts',
        path: path.join(tmp, 'Receipts'),
        score: 0.9,
        confidence: 0.9,
        isSmartFolder: true
      }
    ]);
    const service = makeService();
    const learning = makeLearning(service);
    await correct(learning, 'y1');
    await correct(learning, 'y2');
    for (const name of ['y3', 'y4', 'y5', 'y6']) {
      await learning.recordFileMove(
        path.join(tmp, 'in', `${name}.pdf`),
        path.join(folder('Receipts').path, `${name}.pdf`),
        { category: 'invoices' },
        FEEDBACK_SOURCES.AUTO_ORGANIZE_CONFIRMED
      );
    }
    const pattern = service.patternMatcher
      .getPatternBasedSuggestions({
        name: 'next.pdf',
        extension: 'pdf',
        analysis: { category: 'invoices' }
      })
      .find((s) => s.method === 'user_pattern' && s.folder === 'Receipts');
    const patternConfidence = calculateConfidence({ ...pattern, source: 'user_pattern' });
    expect(patternConfidence).toBeGreaterThan(0.75);

    const r = await suggest(service, { skipGeneration: false });
    expect(r.primary.folder).toBe('Receipts');
    expect(r.primary.learnedOverride).toEqual({ from: 'Invoices', files: 2 });
    // Up to the pattern's own confidence, not the merged LLM alternative's.
    expect(r.confidence).toBeGreaterThan(0.75);
    expect(r.confidence).toBeLessThanOrEqual(patternConfidence);
    await service.shutdown();
  });

  test('a correction into one of two same-named folders targets that folder', async () => {
    folders = [
      { id: 'invoices', name: 'Invoices', path: path.join(tmp, 'Invoices') },
      { id: 'personal-receipts', name: 'Receipts', path: path.join(tmp, 'Personal', 'Receipts') },
      { id: 'business-receipts', name: 'Receipts', path: path.join(tmp, 'Business', 'Receipts') }
    ];
    const business = folders[2];
    const service = makeService();
    const learning = makeLearning(service);
    for (const name of ['x1', 'x2']) {
      const dest = path.join(business.path, `${name}.pdf`);
      await learning.recordFileMove(
        path.join(tmp, 'in', `${name}.pdf`),
        dest,
        { category: 'invoices' },
        FEEDBACK_SOURCES.AUTO_ORGANIZE_CONFIRMED
      );
      expect(
        await learning.recordCorrection({
          filePath: dest,
          wrongFolder: 'Invoices',
          correctFolder: 'Receipts',
          oldCategory: 'invoices'
        })
      ).toBe(true);
    }
    const stored = (await service.feedbackMemoryStore.list()).filter(
      (m) => m.source === 'feedback_reject'
    );
    expect(stored.every((m) => m.correction.correctFolderId === 'business-receipts')).toBe(true);

    // A label differing only in case misses the learned pattern, so the
    // override builds its suggestion from the smart folder.
    const r = await suggest(service, { category: 'Invoices' });
    expect(r.primary.folder).toBe('Receipts');
    expect(r.primary.path).toBe(business.path);
    expect(r.primary.folderId).toBe('business-receipts');
    await service.shutdown();
  });
});
