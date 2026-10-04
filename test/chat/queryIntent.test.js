/**
 * Direct unit oracles for chat/queryIntent — pure query-classification
 * detectors extracted from ChatService. The facade delegations are covered
 * by ChatService.extended.test.js; these pin the module surface itself.
 */

const {
  isConversational,
  isComparisonQuery,
  isGapAnalysisQuery,
  isHolisticSynthesisQuery,
  isCorrectionFeedback,
  detectContradictions
} = require('../../src/main/services/chat/queryIntent');

describe('chat/queryIntent', () => {
  test('isConversational: greetings and capability questions yes, document queries no', () => {
    expect(isConversational('hello')).toBe(true);
    expect(isConversational('what can you do?')).toBe(true);
    expect(isConversational('are you there')).toBe(true);
    expect(isConversational('find my tax returns')).toBe(false);
    expect(isConversational('x'.repeat(101))).toBe(false);
  });

  test('isComparisonQuery: compare/vs/differences trigger, plain queries do not', () => {
    expect(isComparisonQuery('compare the two contracts')).toBe(true);
    expect(isComparisonQuery('invoice A vs invoice B')).toBe(true);
    expect(isComparisonQuery('differences between Q1 and Q2')).toBe(true);
    expect(isComparisonQuery('summarize my invoices')).toBe(false);
  });

  test('isGapAnalysisQuery: missing/coverage phrasing triggers', () => {
    expect(isGapAnalysisQuery("what's missing from my records")).toBe(true);
    expect(isGapAnalysisQuery('coverage of the audit topics')).toBe(true);
    expect(isGapAnalysisQuery('list my receipts')).toBe(false);
  });

  test('isHolisticSynthesisQuery and isCorrectionFeedback', () => {
    expect(isHolisticSynthesisQuery('big picture across all docs')).toBe(true);
    expect(isHolisticSynthesisQuery('open the readme')).toBe(false);
    expect(isCorrectionFeedback('that is wrong, regenerate')).toBe(true);
    expect(isCorrectionFeedback('list files')).toBe(false);
  });

  test('detectContradictions: flags topical overlap with divergent dates, capped at 5', () => {
    const mk = (id, date, tags) => ({
      id,
      name: id,
      documentDate: date,
      tags,
      snippet: `snippet ${id}`
    });
    const out = detectContradictions([
      mk('doc-1', '2024-01-01', ['policy']),
      mk('doc-2', '2025-06-01', ['policy'])
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].sharedTopics).toContain('policy');
    expect(out[0].reason).toBe('different_dates');

    expect(detectContradictions([mk('a', '2024-01-01', ['x'])])).toEqual([]);
    expect(detectContradictions(null)).toEqual([]);
  });
});

describe('chat/queryIntent isConversational: document questions that start like capability questions', () => {
  test('questions about the user documents are not conversational', () => {
    expect(isConversational('What can you tell me about the Q3 report?')).toBe(false);
    expect(isConversational('What do you know about the Acme contract?')).toBe(false);
    expect(isConversational('Can you help me find my W-2 from 2024?')).toBe(false);
    expect(isConversational('How do I use the template in my Contracts folder?')).toBe(false);
    expect(isConversational('What is your take on the lease renewal clause?')).toBe(false);
    expect(isConversational('What kind of warranty does the Acme contract have?')).toBe(false);
  });

  test('plain capability questions still are', () => {
    expect(isConversational('What can you do?')).toBe(true);
    expect(isConversational('what can you help me with')).toBe(true);
    expect(isConversational('Can you help me?')).toBe(true);
    expect(isConversational('How does this work?')).toBe(true);
    expect(isConversational('What is your name?')).toBe(true);
    expect(isConversational('How do I use this?')).toBe(true);
    expect(isConversational('Tell me about yourself')).toBe(true);
  });
});
