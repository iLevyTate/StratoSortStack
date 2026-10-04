/**
 * Issue 2 regression — small quantized text models (nomic-embed default,
 * Llama-3.2-3B on iGPU) cheerfully self-report 95% confidence on routes
 * driven by surface-token overlap. The reporter session that motivated this
 * fix: a resume was routed to AVA (an unrelated schoolwork folder) at 95%
 * because both contained "Liberty University."
 *
 * `calibrateConfidence` is the sanity check: it caps the displayed
 * confidence based on the embedding-side discrimination signal (spread
 * between top-1 and top-2 folder cosines, absolute top score, and whether
 * the LLM's chosen category even maps to a real folder). These tests guard
 * the contract; production constants are the source of truth (no mocks).
 */

const { calibrateConfidence } = require('../src/main/analysis/semanticFolderMatcher');

const baseRequest = {
  rawConfidence: 95,
  topScore: 0.85,
  runnerUpScore: 0.5, // spread = 0.35 — wide and decisive
  llmCategoryUnmatchable: false
};

describe('calibrateConfidence — caps that prevent false-precision routing', () => {
  test('decisive embedding spread leaves a high LLM confidence intact', () => {
    const result = calibrateConfidence(baseRequest);
    expect(result.confidence).toBe(95);
    expect(result.reason).toBeNull();
    expect(result.cap).toBe(100);
    expect(result.original).toBe(95);
    expect(result.spread).toBeCloseTo(0.35, 5);
  });

  test('virtually-tied folders (spread < 0.03) drop confidence to NO_SPREAD_CAP (60)', () => {
    // The Issue-2 motivating case: LLM said 95%, but the embedding model
    // thinks two folders are essentially tied. We have no business
    // displaying near-certainty.
    const result = calibrateConfidence({
      ...baseRequest,
      topScore: 0.62,
      runnerUpScore: 0.61 // spread = 0.01
    });
    expect(result.confidence).toBe(60);
    expect(result.cap).toBe(60);
    expect(result.reason).toBe('no_spread');
    expect(result.original).toBe(95);
  });

  test('narrow spread (0.03 ≤ spread < 0.07) caps at NARROW_SPREAD_CAP (75)', () => {
    const result = calibrateConfidence({
      ...baseRequest,
      topScore: 0.66,
      runnerUpScore: 0.61 // spread = 0.05
    });
    expect(result.confidence).toBe(75);
    expect(result.reason).toBe('narrow_spread');
  });

  test('moderate spread (0.07 ≤ spread < 0.12) caps at MODERATE_SPREAD_CAP (85)', () => {
    const result = calibrateConfidence({
      ...baseRequest,
      topScore: 0.7,
      runnerUpScore: 0.61 // spread = 0.09
    });
    expect(result.confidence).toBe(85);
    expect(result.reason).toBe('moderate_spread');
  });

  test('top score below FOLDER_MATCH_CONFIDENCE caps at LOW_TOP_SCORE_CAP (70)', () => {
    // Even with no runner-up, if the top folder match itself isn't strong
    // enough to clear our match threshold, we shouldn't claim certainty.
    const result = calibrateConfidence({
      rawConfidence: 95,
      topScore: 0.5,
      runnerUpScore: null,
      llmCategoryUnmatchable: false
    });
    // Spread = 0.50 - 0 = 0.50 (no spread penalty), but top is sub-threshold.
    expect(result.confidence).toBe(70);
    expect(result.reason).toBe('low_top_embedding');
  });

  test('no embedding signal at all caps at NO_EMBEDDING_CAP (80)', () => {
    const result = calibrateConfidence({
      rawConfidence: 95,
      topScore: null,
      runnerUpScore: null,
      llmCategoryUnmatchable: false
    });
    expect(result.confidence).toBe(80);
    expect(result.reason).toBe('no_embedding_signal');
    expect(result.spread).toBeNull();
  });

  test('unmatchable LLM category caps at UNMATCHABLE_CATEGORY_CAP (75)', () => {
    // LLM said "Liberty University Resume", which doesn't map to any actual
    // smart folder — its self-confidence is moot.
    const result = calibrateConfidence({
      ...baseRequest,
      llmCategoryUnmatchable: true
    });
    expect(result.confidence).toBe(75);
    expect(result.reason).toBe('unmatchable_category');
  });

  test('multiple caps stack — tightest wins', () => {
    // Tied folders AND unmatchable category. The most aggressive cap (60,
    // for no_spread) should bind, not the 75 from unmatchable_category.
    const result = calibrateConfidence({
      rawConfidence: 95,
      topScore: 0.61,
      runnerUpScore: 0.6, // spread = 0.01
      llmCategoryUnmatchable: true
    });
    expect(result.confidence).toBe(60);
    expect(result.reason).toBe('no_spread');
  });

  test('low LLM confidence is never raised — caps only', () => {
    // Even with a decisive embedding spread, we don't INFLATE a low LLM
    // self-report. The system is asymmetric for a reason: we trust low
    // confidence (it's a useful warning signal) but distrust high
    // confidence (small models overstate).
    const result = calibrateConfidence({
      rawConfidence: 35,
      topScore: 0.85,
      runnerUpScore: 0.5,
      llmCategoryUnmatchable: false
    });
    expect(result.confidence).toBe(35);
    expect(result.reason).toBeNull();
  });

  test('reason is null when calibration would have capped but original was already below cap', () => {
    // No-spread case would cap at 60, but the LLM only claimed 50%.
    // No cap actually bound, so reason must be null — distinguishes
    // "we accepted the low number" from "we capped a high one."
    const result = calibrateConfidence({
      rawConfidence: 50,
      topScore: 0.61,
      runnerUpScore: 0.6,
      llmCategoryUnmatchable: false
    });
    expect(result.confidence).toBe(50);
    // `cap` still reflects the binding rule (60) for audit, but `reason`
    // is null because the cap didn't actually change the value.
    expect(result.cap).toBe(60);
    expect(result.reason).toBeNull();
  });

  test('bad inputs normalize gracefully — non-finite confidence becomes 0', () => {
    expect(calibrateConfidence({ rawConfidence: NaN }).original).toBe(0);
    expect(calibrateConfidence({ rawConfidence: undefined }).original).toBe(0);
    expect(calibrateConfidence({ rawConfidence: 'high' }).original).toBe(0);
    expect(calibrateConfidence({ rawConfidence: 150 }).original).toBe(100); // clamped
    expect(calibrateConfidence({ rawConfidence: -10 }).original).toBe(0); // clamped
  });
});
