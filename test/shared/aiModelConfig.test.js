'use strict';

const {
  INSTALL_MODEL_PROFILES,
  DEFAULT_AI_MODELS,
  AI_DEFAULTS
} = require('../../src/shared/aiModelConfig');

describe('aiModelConfig', () => {
  test('exposes both first-run install profiles with the expected shape', () => {
    expect(INSTALL_MODEL_PROFILES.BASE_SMALL.id).toBe('base-small');
    expect(INSTALL_MODEL_PROFILES.BETTER_QUALITY.id).toBe('better-quality');
    for (const profile of Object.values(INSTALL_MODEL_PROFILES)) {
      expect(profile.models).toEqual(
        expect.objectContaining({
          TEXT_ANALYSIS: expect.stringMatching(/\.gguf$/),
          IMAGE_ANALYSIS: expect.stringMatching(/\.gguf$/),
          EMBEDDING: expect.stringMatching(/\.gguf$/)
        })
      );
    }
  });

  test('default models fall back to the BASE_SMALL profile when env is unset', () => {
    // CI runs without STRATOSORT_*_MODEL set; guard so a polluted env doesn't fail the suite.
    if (!process.env.STRATOSORT_TEXT_MODEL) {
      expect(DEFAULT_AI_MODELS.TEXT_ANALYSIS).toBe(
        INSTALL_MODEL_PROFILES.BASE_SMALL.models.TEXT_ANALYSIS
      );
    }
    if (!process.env.STRATOSORT_EMBEDDING_MODEL) {
      expect(DEFAULT_AI_MODELS.EMBEDDING).toBe(INSTALL_MODEL_PROFILES.BASE_SMALL.models.EMBEDDING);
    }
    expect(Array.isArray(DEFAULT_AI_MODELS.FALLBACK_MODELS)).toBe(true);
  });

  test('env override is honoured when the module is loaded with the var set', () => {
    jest.isolateModules(() => {
      const prev = process.env.STRATOSORT_TEXT_MODEL;
      process.env.STRATOSORT_TEXT_MODEL = 'Custom-Model-Q4.gguf';
      try {
        const fresh = require('../../src/shared/aiModelConfig');
        expect(fresh.DEFAULT_AI_MODELS.TEXT_ANALYSIS).toBe('Custom-Model-Q4.gguf');
        expect(fresh.AI_DEFAULTS.TEXT.MODEL).toBe('Custom-Model-Q4.gguf');
      } finally {
        if (prev === undefined) delete process.env.STRATOSORT_TEXT_MODEL;
        else process.env.STRATOSORT_TEXT_MODEL = prev;
      }
    });
  });

  test('embedding fallback dimension matches the default all-MiniLM model (384)', () => {
    expect(AI_DEFAULTS.EMBEDDING.DIMENSIONS).toBe(384);
  });

  test('AI defaults carry sane generation parameters', () => {
    expect(AI_DEFAULTS.TEXT.CONTEXT_SIZE).toBeGreaterThan(0);
    expect(AI_DEFAULTS.TEXT.TEMPERATURE).toBeGreaterThanOrEqual(0);
    expect(AI_DEFAULTS.IMAGE.MAX_TOKENS).toBeGreaterThan(0);
    expect(AI_DEFAULTS.TEXT.GPU_LAYERS).toBe(-1);
  });

  // F-209 (CP-16): the constant fallback must agree with the settings default;
  // a settings-less code path used to read `false` while the app default is on.
  test('AUTO_CHUNK_ON_ANALYSIS fallback matches the settings default (on)', () => {
    const { DEFAULT_SETTINGS } = require('../../src/shared/defaultSettings');
    expect(AI_DEFAULTS.EMBEDDING.AUTO_CHUNK_ON_ANALYSIS).toBe(true);
    expect(AI_DEFAULTS.EMBEDDING.AUTO_CHUNK_ON_ANALYSIS).toBe(DEFAULT_SETTINGS.autoChunkOnAnalysis);
  });
});
