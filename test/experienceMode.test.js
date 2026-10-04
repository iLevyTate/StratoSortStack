const {
  EXPERIENCE_MODES,
  applyExperienceModeSettings,
  carryAdvancedValuesAcrossModeSwitch,
  upgradeLegacySimpleModeValues,
  SIMPLE_MODE_ENFORCED_VALUES,
  LEGACY_SIMPLE_MODE_VALUES
} = require('../src/shared/experienceMode');

describe('experienceMode.applyExperienceModeSettings', () => {
  test('Simple mode keeps embedding/graph features enabled (no longer downgrades)', () => {
    // Post-2026-04: Simple is a UI simplification, not a feature downgrade.
    // Embedding and graph flags stay ON so users who later switch to
    // Advanced don't have to reprocess every file.
    const out = applyExperienceModeSettings({
      experienceMode: EXPERIENCE_MODES.SIMPLE,
      defaultEmbeddingPolicy: 'embed',
      embeddingTiming: 'during_analysis'
    });
    expect(out).toMatchObject(SIMPLE_MODE_ENFORCED_VALUES);
    expect(out.experienceMode).toBe('simple');
    expect(out.defaultEmbeddingPolicy).toBe('embed');
    expect(out.autoChunkOnAnalysis).toBe(true);
    expect(out.graphExpansionEnabled).toBe(true);
  });

  test('Simple mode re-applies recommended values over non-default choices', () => {
    // The affected controls are hidden in Simple mode; an invisible
    // non-default state would be undiagnosable, so selecting Simple
    // re-applies the recommended values.
    const out = applyExperienceModeSettings({
      experienceMode: EXPERIENCE_MODES.SIMPLE,
      ...LEGACY_SIMPLE_MODE_VALUES
    });
    expect(out).toMatchObject(SIMPLE_MODE_ENFORCED_VALUES);
  });

  test('Switching to Advanced from Simple leaves recommended values as-is', () => {
    // Both modes share the same recommended defaults; switching mode is a
    // no-op for the enforced keys. The user keeps everything they had.
    const out = applyExperienceModeSettings({
      experienceMode: EXPERIENCE_MODES.ADVANCED,
      ...SIMPLE_MODE_ENFORCED_VALUES
    });
    expect(out.experienceMode).toBe('advanced');
    expect(out.defaultEmbeddingPolicy).toBe('embed');
    expect(out.embeddingTiming).toBe('during_analysis');
    expect(out.autoChunkOnAnalysis).toBe(true);
    expect(out.graphExpansionEnabled).toBe(true);
    expect(out.chunkContextEnabled).toBe(true);
  });

  test('Advanced does not clobber custom non-recommended values', () => {
    const out = applyExperienceModeSettings({
      experienceMode: EXPERIENCE_MODES.ADVANCED,
      defaultEmbeddingPolicy: 'web_only',
      embeddingTiming: 'after_organize',
      autoChunkOnAnalysis: true,
      graphExpansionEnabled: true,
      chunkContextEnabled: true
    });
    expect(out.defaultEmbeddingPolicy).toBe('web_only');
    expect(out.embeddingTiming).toBe('after_organize');
  });

  test('Advanced mode preserves deliberate skip/manual/false choices', () => {
    // Regression guard for the "five settings impossible to turn off" bug:
    // the legacy migration used to run inside this function on every
    // save/load, silently reverting deliberate Advanced-mode choices of
    // 'skip' / 'manual' / false. The migration is now a one-time
    // SettingsMigrator step, so these values must survive untouched here.
    const out = applyExperienceModeSettings({
      experienceMode: EXPERIENCE_MODES.ADVANCED,
      ...LEGACY_SIMPLE_MODE_VALUES
    });
    expect(out.defaultEmbeddingPolicy).toBe('skip');
    expect(out.embeddingTiming).toBe('manual');
    expect(out.autoChunkOnAnalysis).toBe(false);
    expect(out.graphExpansionEnabled).toBe(false);
    expect(out.chunkContextEnabled).toBe(false);
  });

  // Invariant: LEGACY_SIMPLE_MODE_VALUES must cover the same keys so the
  // one-time migration covers every enforced field.
  test('LEGACY_SIMPLE_MODE_VALUES covers all SIMPLE_MODE_ENFORCED_VALUES keys', () => {
    const enforcedKeys = Object.keys(SIMPLE_MODE_ENFORCED_VALUES).sort();
    const legacyKeys = Object.keys(LEGACY_SIMPLE_MODE_VALUES).sort();
    expect(legacyKeys).toEqual(enforcedKeys);
  });
});

describe('experienceMode.upgradeLegacySimpleModeValues', () => {
  test('flips exact legacy matches to recommended values and reports keys', () => {
    const settings = { experienceMode: 'advanced', ...LEGACY_SIMPLE_MODE_VALUES };
    const upgraded = upgradeLegacySimpleModeValues(settings);
    expect(upgraded.sort()).toEqual(Object.keys(LEGACY_SIMPLE_MODE_VALUES).sort());
    expect(settings).toMatchObject(SIMPLE_MODE_ENFORCED_VALUES);
  });

  test('leaves non-legacy custom values untouched', () => {
    // 'web_only' is a legitimate non-legacy choice — only exact legacy
    // matches are flipped.
    const settings = {
      defaultEmbeddingPolicy: 'web_only',
      embeddingTiming: 'after_organize',
      autoChunkOnAnalysis: true,
      graphExpansionEnabled: true,
      chunkContextEnabled: true
    };
    const upgraded = upgradeLegacySimpleModeValues(settings);
    expect(upgraded).toEqual([]);
    expect(settings.defaultEmbeddingPolicy).toBe('web_only');
    expect(settings.embeddingTiming).toBe('after_organize');
  });

  test('handles non-object input safely', () => {
    expect(upgradeLegacySimpleModeValues(null)).toEqual([]);
    expect(upgradeLegacySimpleModeValues(undefined)).toEqual([]);
  });
});

// F-192 (CP-12): the rebuild path decided "build chunk vectors?" from the mode
// NAME (Simple → no) although Simple mode now enforces autoChunkOnAnalysis:
// true. The effective flag is the only truth; every default install lost its
// deep-recall vectors on each rebuild.
describe('experienceMode.isAutoChunkEnabled (effective, post-enforcement)', () => {
  const { isAutoChunkEnabled } = require('../src/shared/experienceMode');

  test.each([
    ['simple mode, flag unset', { experienceMode: 'simple' }, true],
    [
      'simple mode, stale false is overridden by enforcement',
      { experienceMode: 'simple', autoChunkOnAnalysis: false },
      true
    ],
    ['advanced mode, flag on', { experienceMode: 'advanced', autoChunkOnAnalysis: true }, true],
    [
      'advanced mode, deliberate opt-out is honored',
      { experienceMode: 'advanced', autoChunkOnAnalysis: false },
      false
    ],
    ['advanced mode, flag unset defaults on', { experienceMode: 'advanced' }, true],
    ['no settings at all defaults on', null, true],
    [
      'unknown mode normalizes to simple',
      { experienceMode: 'bogus', autoChunkOnAnalysis: false },
      true
    ]
  ])('%s', (_label, settings, expected) => {
    expect(isAutoChunkEnabled(settings)).toBe(expected);
  });
});

describe('experienceMode.carryAdvancedValuesAcrossModeSwitch (ST-08)', () => {
  const advanced = {
    experienceMode: EXPERIENCE_MODES.ADVANCED,
    defaultEmbeddingPolicy: 'skip',
    embeddingTiming: 'manual',
    autoChunkOnAnalysis: false,
    graphExpansionEnabled: true,
    chunkContextEnabled: true,
    confidenceThreshold: 0.6
  };

  test('Advanced → Simple parks the non-recommended choices; enforcement still applies', () => {
    const next = { ...advanced, experienceMode: EXPERIENCE_MODES.SIMPLE };
    const carried = carryAdvancedValuesAcrossModeSwitch(advanced, next);
    expect(carried.advancedModeValues).toEqual({
      defaultEmbeddingPolicy: 'skip',
      embeddingTiming: 'manual',
      autoChunkOnAnalysis: false
    });
    const out = applyExperienceModeSettings(carried);
    expect(out).toMatchObject(SIMPLE_MODE_ENFORCED_VALUES);
    expect(out.advancedModeValues).toEqual(carried.advancedModeValues);
    expect(out.confidenceThreshold).toBe(0.6);
  });

  test('Simple → Advanced restores the parked choices over the enforced values and clears the stash', () => {
    const simple = applyExperienceModeSettings(
      carryAdvancedValuesAcrossModeSwitch(advanced, {
        ...advanced,
        experienceMode: EXPERIENCE_MODES.SIMPLE
      })
    );
    // What the renderer sends back: the enforced values with the mode flipped.
    const next = { ...simple, experienceMode: EXPERIENCE_MODES.ADVANCED };
    const out = applyExperienceModeSettings(carryAdvancedValuesAcrossModeSwitch(simple, next));
    expect(out.defaultEmbeddingPolicy).toBe('skip');
    expect(out.embeddingTiming).toBe('manual');
    expect(out.autoChunkOnAnalysis).toBe(false);
    expect(out.graphExpansionEnabled).toBe(true);
    expect(out.advancedModeValues).toBeNull();
  });

  test('an imported Advanced export keeps its explicit choices; the stash fills only enforced values', () => {
    // Machine B is Simple with a parked 'skip'. The export from machine A is
    // Advanced with 'web_only'. The import used to come out as 'skip'.
    const simpleWithStash = {
      experienceMode: EXPERIENCE_MODES.SIMPLE,
      ...SIMPLE_MODE_ENFORCED_VALUES,
      advancedModeValues: { defaultEmbeddingPolicy: 'skip', embeddingTiming: 'manual' }
    };
    const imported = {
      ...advanced,
      defaultEmbeddingPolicy: 'web_only',
      embeddingTiming: SIMPLE_MODE_ENFORCED_VALUES.embeddingTiming,
      advancedModeValues: null
    };

    const out = carryAdvancedValuesAcrossModeSwitch(simpleWithStash, imported);

    expect(out.defaultEmbeddingPolicy).toBe('web_only');
    // Still at the enforced value in the import, so the parked choice applies.
    expect(out.embeddingTiming).toBe('manual');
    expect(out.advancedModeValues).toBeNull();
  });

  test('a stash the caller already carries wins over recomputing from previous', () => {
    const next = {
      ...advanced,
      experienceMode: EXPERIENCE_MODES.SIMPLE,
      advancedModeValues: { defaultEmbeddingPolicy: 'web_only' }
    };
    expect(carryAdvancedValuesAcrossModeSwitch(advanced, next).advancedModeValues).toEqual({
      defaultEmbeddingPolicy: 'web_only'
    });
  });

  test('no mode change returns next untouched; nothing to park leaves no stash', () => {
    const next = { ...advanced, confidenceThreshold: 0.7 };
    expect(carryAdvancedValuesAcrossModeSwitch(advanced, next)).toBe(next);

    const recommended = {
      experienceMode: EXPERIENCE_MODES.ADVANCED,
      ...SIMPLE_MODE_ENFORCED_VALUES
    };
    const out = carryAdvancedValuesAcrossModeSwitch(recommended, {
      ...recommended,
      experienceMode: EXPERIENCE_MODES.SIMPLE
    });
    expect(out.advancedModeValues).toBeNull();
  });

  test('Simple → Advanced with no stash keeps the recommended values', () => {
    const simple = { experienceMode: EXPERIENCE_MODES.SIMPLE, ...SIMPLE_MODE_ENFORCED_VALUES };
    const out = carryAdvancedValuesAcrossModeSwitch(simple, {
      ...simple,
      experienceMode: EXPERIENCE_MODES.ADVANCED
    });
    expect(out).toMatchObject(SIMPLE_MODE_ENFORCED_VALUES);
    expect(out.advancedModeValues).toBeNull();
  });

  test('tolerates missing previous and non-object input', () => {
    const next = { experienceMode: EXPERIENCE_MODES.SIMPLE };
    expect(carryAdvancedValuesAcrossModeSwitch(null, next)).toBe(next);
    expect(carryAdvancedValuesAcrossModeSwitch(advanced, null)).toBeNull();
  });
});
