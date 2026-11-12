/**
 * Auto-organize learns a placement once, and only from a move that happened.
 *
 * The planners (organizeFiles / batchOrganize) used to record accepted
 * feedback as they chose a destination. The batch organize handler records the
 * same placement again once the file has moved, so a planned and executed file
 * counted twice, a plan nobody executed still taught the matcher, and undo
 * (which retracts one record per reverted move) left the other behind.
 *
 * These run the real planners, PatternMatcher and LearningFeedbackService; the
 * move itself is stood in for by the call the handler makes after it.
 */

jest.mock('../src/shared/logger', () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger: { ...l, setContext: jest.fn() }, createLogger: () => l };
});

jest.mock('electron', () => ({
  app: { getPath: jest.fn().mockReturnValue('/mock/documents') }
}));

const path = require('path');
const { PatternMatcher } = require('../src/main/services/organization/patternMatcher');
const {
  LearningFeedbackService,
  FEEDBACK_SOURCES
} = require('../src/main/services/organization/learningFeedback');
const AutoOrganizeServiceCore = require('../src/main/services/autoOrganize/AutoOrganizeServiceCore');

const finance = { id: 'f1', name: 'Finance', path: path.resolve('/library/Finance') };
const smartFolders = [finance];
const invoice = {
  name: 'invoice.pdf',
  path: path.resolve('/inbox/invoice.pdf'),
  extension: '.pdf',
  analysis: { category: 'Finance' }
};
const financeSuggestion = { folder: 'Finance', path: finance.path };

/**
 * @param {{ batch?: boolean }} [options] - batch: false makes the batch
 *   suggestion call come back empty, which sends files down the per-file path
 */
function setup({ batch = true } = {}) {
  const matcher = new PatternMatcher();
  const suggestionService = {
    patternMatcher: matcher,
    getBatchSuggestions: jest.fn(async (files) =>
      batch
        ? {
            success: true,
            groups: [
              {
                folder: 'Finance',
                path: finance.path,
                confidence: 0.9,
                files: files.map((/** @type {any} */ f) => ({
                  ...f,
                  suggestion: financeSuggestion,
                  confidence: 0.9
                }))
              }
            ]
          }
        : { success: false, groups: [] }
    ),
    getSuggestionsForFile: jest.fn(async () => ({
      success: true,
      primary: financeSuggestion,
      confidence: 0.9
    })),
    recordFeedback: jest.fn(async (file, suggestion, accepted) =>
      matcher.recordFeedback(file, suggestion, accepted)
    ),
    retractFeedback: jest.fn(async (file, suggestion) => matcher.retractFeedback(file, suggestion))
  };
  const service = new AutoOrganizeServiceCore({
    suggestionService,
    undoRedoService: { recordAction: jest.fn() }
  });
  const learning = new LearningFeedbackService({
    suggestionService,
    getSmartFolders: () => smartFolders
  });
  return { matcher, service, learning };
}

/** What the matcher has learned, in the terms the bug showed up in. */
function learned(/** @type {PatternMatcher} */ matcher) {
  return {
    patterns: [...matcher.userPatterns.values()].map((p) => p.count),
    history: matcher.feedbackHistory.length,
    folderUsage: matcher.getFolderUsage(finance.id)
  };
}

const NOTHING = { patterns: [], history: 0, folderUsage: 0 };

/** The handler's record for a completed move (batchOrganizeHandler). */
function recordCompletedMove(
  /** @type {LearningFeedbackService} */ learning,
  /** @type {{ source: string, destination: string }} */ op
) {
  return learning.recordFileMove(
    op.source,
    op.destination,
    { category: 'Finance' },
    FEEDBACK_SOURCES.AUTO_ORGANIZE_CONFIRMED
  );
}

describe('auto-organize learning happens once, after the move', () => {
  describe.each([
    ['organizeFiles (batch suggestions)', { batch: true }],
    ['organizeFiles (per-file fallback)', { batch: false }]
  ])('%s', (_label, options) => {
    test('a plan that is never executed, or whose move fails, teaches nothing', async () => {
      const { matcher, service } = setup(options);

      const plan = await service.organizeFiles([invoice], smartFolders, {
        confidenceThreshold: 0.75
      });

      expect(plan.operations).toHaveLength(1);
      expect(learned(matcher)).toEqual(NOTHING);
    });

    test('a planned file that is then moved counts once', async () => {
      const { matcher, service, learning } = setup(options);
      const plan = await service.organizeFiles([invoice], smartFolders, {
        confidenceThreshold: 0.75
      });

      expect(await recordCompletedMove(learning, plan.operations[0])).toBe(true);

      expect(learned(matcher)).toEqual({ patterns: [1], history: 1, folderUsage: 1 });
    });

    test('undo returns learning to where it was before the move', async () => {
      const { matcher, service, learning } = setup(options);
      const plan = await service.organizeFiles([invoice], smartFolders, {
        confidenceThreshold: 0.75
      });
      await recordCompletedMove(learning, plan.operations[0]);

      await learning.retractFileFeedback(plan.operations[0].destination);

      expect(learned(matcher)).toEqual(NOTHING);
    });
  });

  test('batchOrganize plans without teaching; the move counts once and undo clears it', async () => {
    const { matcher, service, learning } = setup();

    const plan = await service.batchOrganize([invoice], smartFolders, {
      confidenceThreshold: 0.75
    });
    expect(plan.operations).toHaveLength(1);
    expect(learned(matcher)).toEqual(NOTHING);

    await recordCompletedMove(learning, plan.operations[0]);
    expect(learned(matcher)).toEqual({ patterns: [1], history: 1, folderUsage: 1 });

    await learning.retractFileFeedback(plan.operations[0].destination);
    expect(learned(matcher)).toEqual(NOTHING);
  });
});
