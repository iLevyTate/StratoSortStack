/**
 * The startup learning scan reads analysis-history ENTRIES, which nest the
 * category and tags under `entry.analysis`. Passing the entry straight through
 * learned every file as `<ext>:unknown:<folder>`, and because the scan runs on
 * every launch with an empty in-memory dedupe, the same files were learned
 * again each time, filling the capped feedback history that undo relies on.
 */

jest.mock('../src/shared/logger', () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger: { ...l, setContext: jest.fn() }, createLogger: () => l };
});

const os = require('os');
const fs = require('fs');
const path = require('path');
const { PatternMatcher } = require('../src/main/services/organization/patternMatcher');
const { LearningFeedbackService } = require('../src/main/services/organization/learningFeedback');

function historyEntry(analysis, organization = {}) {
  return {
    id: 'e1',
    originalPath: 'x',
    analysis: { tags: [], provisional: false, fallbackReason: null, ...analysis },
    organization: { smartFolder: null, ...organization }
  };
}

describe('LearningFeedbackService startup scan', () => {
  let root;
  let financeDir;
  let finance;
  let matcher;
  let suggestionService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-scan-'));
    financeDir = path.join(root, 'Finance');
    fs.mkdirSync(financeDir);
    finance = { id: 'f1', name: 'Finance', path: financeDir };
    matcher = new PatternMatcher();
    suggestionService = {
      patternMatcher: matcher,
      _ensurePatternsLoaded: jest.fn(async () => {}),
      recordFeedback: jest.fn(async (file, suggestion, accepted) => {
        matcher.recordFeedback(file, suggestion, accepted);
      }),
      // Stands in for OrganizationSuggestionServiceCore.recordScanFeedback,
      // reading suggestionService.patternMatcher at call time.
      recordScanFeedback: jest.fn(async (file, suggestion, learnKey) =>
        suggestionService.patternMatcher.recordScanLearning(file, suggestion, learnKey)
      ),
      retractFeedback: jest.fn(async (file, suggestion) =>
        suggestionService.patternMatcher.retractFeedback(file, suggestion)
      )
    };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeService() {
    return new LearningFeedbackService({ suggestionService, getSmartFolders: () => [finance] });
  }

  test('learns the category nested in the history entry, not unknown', async () => {
    fs.writeFileSync(path.join(financeDir, 'q1-report.pdf'), 'x');
    const history = {
      getAnalysisByPath: jest.fn(async () => historyEntry({ category: 'Finance', tags: ['tax'] }))
    };

    const result = await makeService().learnFromExistingFiles(history);

    expect(result.learned).toBe(1);
    const keys = Array.from(matcher.userPatterns.keys());
    expect(keys).toEqual(['pdf:finance:finance']);
    expect(suggestionService.recordScanFeedback.mock.calls[0][0].keywords).toEqual(['tax']);
    expect(suggestionService.recordFeedback).not.toHaveBeenCalled();
  });

  test('falls back to the organization smart folder when no category was stored', async () => {
    fs.writeFileSync(path.join(financeDir, 'statement.pdf'), 'x');
    const history = {
      getAnalysisByPath: jest.fn(async () =>
        historyEntry({ category: null }, { smartFolder: 'Finance' })
      )
    };

    await makeService().learnFromExistingFiles(history);

    expect(Array.from(matcher.userPatterns.keys())).toEqual(['pdf:finance:finance']);
  });

  test('skips provisional and fallback analyses', async () => {
    fs.writeFileSync(path.join(financeDir, 'a.pdf'), 'x');
    fs.writeFileSync(path.join(financeDir, 'b.pdf'), 'x');
    fs.writeFileSync(path.join(financeDir, 'c.pdf'), 'x');
    const byName = {
      'a.pdf': historyEntry({ category: 'Finance', provisional: true }),
      'b.pdf': historyEntry({ category: 'Finance', fallbackReason: 'model_unavailable' }),
      'c.pdf': historyEntry({ category: 'Finance', extractionMethod: 'pdf_no_text' })
    };
    const history = {
      getAnalysisByPath: jest.fn(async (p) => byName[path.basename(p)])
    };

    const result = await makeService().learnFromExistingFiles(history);

    expect(result.learned).toBe(0);
    expect(matcher.feedbackHistory).toHaveLength(0);
  });

  test('a second launch does not learn the same files again', async () => {
    fs.writeFileSync(path.join(financeDir, 'q1-report.pdf'), 'x');
    fs.writeFileSync(path.join(financeDir, 'q2-report.pdf'), 'x');
    const history = {
      getAnalysisByPath: jest.fn(async () => historyEntry({ category: 'Finance' }))
    };

    const first = await makeService().learnFromExistingFiles(history);
    // A new service instance stands in for a restart: its in-memory dedupe is
    // empty, only the (persisted) pattern matcher state carries over.
    const second = await makeService().learnFromExistingFiles(history);

    expect(first.learned).toBe(2);
    expect(second.learned).toBe(0);
    expect(matcher.userPatterns.get('pdf:finance:finance').count).toBe(2);
  });

  test('the learned-file keys survive a save and reload', async () => {
    fs.writeFileSync(path.join(financeDir, 'q1-report.pdf'), 'x');
    const history = {
      getAnalysisByPath: jest.fn(async () => historyEntry({ category: 'Finance' }))
    };
    await makeService().learnFromExistingFiles(history);

    // A restart: a fresh matcher loaded from what the first one exported.
    const saved = JSON.parse(JSON.stringify(matcher.exportPatterns()));
    matcher = new PatternMatcher();
    matcher.loadPatterns(saved);
    suggestionService.patternMatcher = matcher;
    const second = await makeService().learnFromExistingFiles(history);

    expect(second.learned).toBe(0);
    expect(matcher.userPatterns.get('pdf:finance:finance').count).toBe(1);
  });

  test('writes no feedback-history rows, so real organize feedback is never pushed out', async () => {
    matcher = new PatternMatcher({ maxFeedbackHistory: 3 });
    suggestionService.patternMatcher = matcher;
    const organizeRows = ['invoice-1.pdf', 'invoice-2.pdf', 'invoice-3.pdf'].map((name) => ({
      timestamp: Date.now(),
      file: { name, type: 'pdf' },
      suggestion: { folder: 'Finance' },
      accepted: true,
      pattern: 'pdf:finance:finance'
    }));
    matcher.feedbackHistory.push(...organizeRows);
    for (const name of ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf']) {
      fs.writeFileSync(path.join(financeDir, name), 'x');
    }
    const history = {
      getAnalysisByPath: jest.fn(async () => historyEntry({ category: 'Finance' }))
    };

    const result = await makeService().learnFromExistingFiles(history);

    // The history was already at its cap; the scan still learns every file.
    expect(result.learned).toBe(4);
    expect(matcher.feedbackHistory).toEqual(organizeRows);
    expect(matcher.scanLearnedKeys.size).toBe(4);
  });

  test('skips files an organize already taught, and undo still retracts that organize', async () => {
    fs.writeFileSync(path.join(financeDir, 'invoice.pdf'), 'x');
    matcher.recordFeedback(
      { name: 'invoice.pdf', extension: 'pdf', category: 'Finance' },
      { folder: 'Finance', path: financeDir },
      true
    );
    const history = {
      getAnalysisByPath: jest.fn(async () => historyEntry({ category: 'Finance' }))
    };
    const service = makeService();

    const result = await service.learnFromExistingFiles(history);
    expect(result.learned).toBe(0);

    const undone = await service.retractFileFeedback(path.join(financeDir, 'invoice.pdf'));
    expect(undone.patternRetracted).toBe(true);
    expect(matcher.feedbackHistory).toHaveLength(0);
    expect(matcher.userPatterns.has('pdf:finance:finance')).toBe(false);
  });

  test('keeps only the newest learned-file keys', () => {
    matcher = new PatternMatcher({ maxScanLearnedKeys: 2 });
    const suggestion = { folder: 'Finance', path: financeDir };
    for (const key of ['k1', 'k2', 'k3']) {
      expect(matcher.recordScanLearning({ extension: 'pdf' }, suggestion, key)).toBe(true);
    }
    expect(matcher.recordScanLearning({ extension: 'pdf' }, suggestion, 'k3')).toBe(false);
    expect(Array.from(matcher.scanLearnedKeys)).toEqual(['k2', 'k3']);
    expect(matcher.exportPatterns().scanLearnedKeys).toEqual(['k2', 'k3']);
  });
});
