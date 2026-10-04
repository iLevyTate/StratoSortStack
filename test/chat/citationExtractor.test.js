/**
 * Direct unit oracles for chat/CitationExtractor — LLM answer parsing,
 * output clamping, inline-citation reconciliation, and memory formatting
 * extracted from ChatService.
 */

jest.mock('../../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const {
  parseResponse,
  clampAnswerText,
  reconcileInlineCitations,
  formatForMemory,
  MAX_ANSWER_ITEM_CHARS
} = require('../../src/main/services/chat/CitationExtractor');

describe('chat/CitationExtractor', () => {
  describe('parseResponse', () => {
    test('parses structured JSON and intersects citations with real sources', () => {
      const raw = JSON.stringify({
        documentAnswer: [
          { text: 'From the report [doc-1] and beyond [doc-9].', citations: ['doc-1', 'doc-9'] }
        ],
        modelAnswer: [{ text: 'General knowledge.' }],
        followUps: ['What changed in Q2?']
      });
      const sources = [{ id: 'doc-1' }, { id: 'doc-2' }];

      const parsed = parseResponse(raw, sources);

      expect(parsed.documentAnswer).toHaveLength(1);
      // Hallucinated doc-9 stripped from citations AND from inline text
      expect(parsed.documentAnswer[0].citations).toEqual(['doc-1']);
      expect(parsed.documentAnswer[0].text).toContain('[doc-1]');
      expect(parsed.documentAnswer[0].text).not.toContain('[doc-9]');
      expect(parsed.followUps).toEqual(['What changed in Q2?']);
    });

    test('falls back to modelAnswer with raw text for non-JSON responses', () => {
      const parsed = parseResponse('plain text answer', []);
      expect(parsed.documentAnswer).toEqual([]);
      expect(parsed.modelAnswer[0].text).toBe('plain text answer');
    });
  });

  describe('clampAnswerText', () => {
    test('caps at MAX_ANSWER_ITEM_CHARS with ellipsis', () => {
      const out = clampAnswerText('y'.repeat(MAX_ANSWER_ITEM_CHARS + 50));
      expect(out.length).toBe(MAX_ANSWER_ITEM_CHARS + 1);
      expect(out.endsWith('…')).toBe(true);
    });

    test('strips invisible characters from model output', () => {
      const zw = String.fromCharCode(0x200b);
      expect(clampAnswerText(`a${zw}b`)).toBe('ab');
    });
  });

  describe('reconcileInlineCitations', () => {
    test('keeps resolvable tokens, strips unresolvable ones, tidies spacing', () => {
      const out = reconcileInlineCitations(
        'Fact one [doc-1] . Fact two [doc-7].',
        new Set(['doc-1'])
      );
      expect(out).toBe('Fact one [doc-1]. Fact two.');
    });

    test('passes through text without citation tokens', () => {
      expect(reconcileInlineCitations('no citations here', new Set())).toBe('no citations here');
    });
  });

  describe('formatForMemory', () => {
    test('joins answers and appends referenced source names', () => {
      const out = formatForMemory(
        { documentAnswer: [{ text: 'A.' }], modelAnswer: [{ text: 'B.' }], followUps: [] },
        [{ name: 'report.pdf' }, { name: 'notes.txt' }]
      );
      expect(out).toBe('A.\nB.\n[Referenced: report.pdf, notes.txt]');
    });

    test('returns placeholder when nothing was produced', () => {
      expect(formatForMemory({ documentAnswer: [], modelAnswer: [], followUps: [] })).toBe(
        'No answer produced.'
      );
    });
  });
});
