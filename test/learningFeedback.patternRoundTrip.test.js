/**
 * A placement the app learned from must come back as a suggestion.
 *
 * Learning stored every pattern as `<ext>:unknown:<folder>`: the feedback
 * metadata carried the category at the top level, the pattern key read
 * `analysis.category`, and batch organize passed no category at all. A lookup
 * for an analyzed file builds `<ext>:<category>:unknown`, which matched a
 * learned pattern on one part of three (0.33), under the 0.5 cut. The
 * learning loop recorded and never answered.
 */

jest.mock('../src/shared/logger', () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger: { ...l, setContext: jest.fn() }, createLogger: () => l };
});

const { PatternMatcher } = require('../src/main/services/organization/patternMatcher');
const {
  buildFileMetadata,
  buildFolderSuggestion
} = require('../src/main/services/organization/learningFeedback');

describe('learned placements round-trip into pattern suggestions', () => {
  const finance = { id: 'f1', name: 'Finance', path: '/library/Finance' };

  test('a PDF the analysis called Finance, filed to Finance, suggests Finance for the next one', () => {
    const matcher = new PatternMatcher();
    matcher.recordFeedback(
      buildFileMetadata('/library/Finance/q1-report.pdf', { category: 'Finance' }),
      buildFolderSuggestion(finance, 0.9),
      true
    );

    const suggestions = matcher.getPatternBasedSuggestions({
      name: 'q2-report.pdf',
      extension: 'pdf',
      analysis: { category: 'Finance' }
    });

    expect(suggestions.map((s) => s.folder)).toContain('Finance');
    expect(suggestions[0].method).toBe('user_pattern');
  });

  test('a different category does not borrow the learned folder', () => {
    const matcher = new PatternMatcher();
    matcher.recordFeedback(
      buildFileMetadata('/library/Finance/q1-report.pdf', { category: 'Finance' }),
      buildFolderSuggestion(finance, 0.9),
      true
    );

    const suggestions = matcher.getPatternBasedSuggestions({
      name: 'lease.pdf',
      extension: 'pdf',
      analysis: { category: 'Housing' }
    });

    expect(suggestions).toEqual([]);
  });

  // Suggestion lookups carry the extension as path.extname returns it.
  test('a manual move of an analyzed file suggests that folder for a `.pdf` lookup', () => {
    const matcher = new PatternMatcher();
    matcher.recordFeedback(
      buildFileMetadata('/library/Finance/q1-report.pdf', { category: 'Finance' }),
      buildFolderSuggestion(finance, 1),
      true
    );

    const suggestions = matcher.getPatternBasedSuggestions({
      name: 'q2-report.pdf',
      extension: '.pdf',
      analysis: { category: 'Finance' }
    });

    expect(suggestions.map((s) => s.folder)).toEqual(['Finance']);
  });

  // Batch organize records with the file's category; undo retracts knowing
  // only the path the file landed at.
  test('undo takes back the pattern a batch organize recorded with a category', () => {
    const matcher = new PatternMatcher();
    const landed = '/library/Finance/q1-report.pdf';
    matcher.recordFeedback(
      buildFileMetadata(landed, { category: 'Invoices' }),
      buildFolderSuggestion(finance, 0.9),
      true
    );
    expect(matcher.userPatterns.size).toBe(1);

    const result = matcher.retractFeedback(
      buildFileMetadata(landed, null),
      buildFolderSuggestion(finance, 1)
    );

    expect(result).toEqual({ retracted: true });
    expect(matcher.userPatterns.size).toBe(0);
    expect(matcher.feedbackHistory).toHaveLength(0);
  });

  test('flat feedback metadata and analysis-bearing files produce the same key', () => {
    const matcher = new PatternMatcher();
    expect(matcher.extractPattern({ extension: 'pdf', category: 'Finance' })).toBe(
      matcher.extractPattern({ extension: 'pdf', analysis: { category: 'Finance' } })
    );
  });
});
