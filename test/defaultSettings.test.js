/**
 * Tests for Default Settings
 * Tests the default settings configuration
 */

describe('defaultSettings', () => {
  let DEFAULT_SETTINGS;

  beforeEach(() => {
    jest.resetModules();
    const module = require('../src/shared/defaultSettings');
    DEFAULT_SETTINGS = module.DEFAULT_SETTINGS;
  });

  describe('DEFAULT_SETTINGS', () => {
    test('exports DEFAULT_SETTINGS object', () => {
      expect(DEFAULT_SETTINGS).toBeDefined();
      expect(typeof DEFAULT_SETTINGS).toBe('object');
    });
  });

  describe('UI settings', () => {
    test('has notifications setting', () => {
      expect(DEFAULT_SETTINGS.notifications).toBe(true);
    });

    test('defaults new installs to simple experience mode', () => {
      expect(DEFAULT_SETTINGS.experienceMode).toBe('simple');
    });

    test('enables developer graph view by default', () => {
      expect(DEFAULT_SETTINGS.developerGraphEnabled).toBe(true);
    });
  });

  describe('Graph retrieval settings', () => {
    test('has graph expansion defaults', () => {
      expect(DEFAULT_SETTINGS.graphExpansionEnabled).toBe(true);
      expect(DEFAULT_SETTINGS.graphExpansionWeight).toBeGreaterThanOrEqual(0);
      expect(DEFAULT_SETTINGS.graphExpansionWeight).toBeLessThanOrEqual(1);
      expect(DEFAULT_SETTINGS.graphExpansionMaxNeighbors).toBeGreaterThan(0);
    });

    test('has chunk context defaults', () => {
      expect(DEFAULT_SETTINGS.chunkContextEnabled).toBe(true);
      expect(DEFAULT_SETTINGS.chunkContextMaxNeighbors).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Behavior settings', () => {
    test('has defaultSmartFolderLocation', () => {
      expect(DEFAULT_SETTINGS.defaultSmartFolderLocation).toBe('Documents');
    });

    test('has maxConcurrentAnalysis', () => {
      // Default is 1 for sequential processing - better UX and prevents VRAM exhaustion
      expect(DEFAULT_SETTINGS.maxConcurrentAnalysis).toBe(1);
    });

    test('has autoOrganize disabled by default', () => {
      expect(DEFAULT_SETTINGS.autoOrganize).toBe(false);
    });

    test('has backgroundMode disabled by default', () => {
      expect(DEFAULT_SETTINGS.backgroundMode).toBe(false);
    });
  });

  describe('Organization Confidence Threshold', () => {
    test('has confidenceThreshold', () => {
      expect(DEFAULT_SETTINGS.confidenceThreshold).toBe(0.75);
    });

    test('confidenceThreshold is between 0 and 1', () => {
      expect(DEFAULT_SETTINGS.confidenceThreshold).toBeGreaterThanOrEqual(0);
      expect(DEFAULT_SETTINGS.confidenceThreshold).toBeLessThanOrEqual(1);
    });
  });

  describe('AI settings', () => {
    test('has textModel', () => {
      expect(DEFAULT_SETTINGS.textModel).toBe('Llama-3.2-3B-Instruct-Q4_K_M.gguf');
    });

    test('has visionModel', () => {
      expect(DEFAULT_SETTINGS.visionModel).toBe('llava-v1.6-mistral-7b-Q4_K_M.gguf');
    });

    test('has embeddingModel', () => {
      expect(DEFAULT_SETTINGS.embeddingModel).toBe('all-MiniLM-L6-v2-Q4_K_M.gguf');
    });
  });

  describe('File Size Limits', () => {
    test('has maxImageFileSize (100MB)', () => {
      expect(DEFAULT_SETTINGS.maxImageFileSize).toBe(100 * 1024 * 1024);
    });

    test('has maxDocumentFileSize (200MB)', () => {
      expect(DEFAULT_SETTINGS.maxDocumentFileSize).toBe(200 * 1024 * 1024);
    });

    test('has maxTextFileSize (50MB)', () => {
      expect(DEFAULT_SETTINGS.maxTextFileSize).toBe(50 * 1024 * 1024);
    });
  });

  describe('UI Limits', () => {
    test('has workflowRestoreMaxAge (24 hours, matches v2.0.9 parity)', () => {
      expect(DEFAULT_SETTINGS.workflowRestoreMaxAge).toBe(24 * 60 * 60 * 1000);
    });

    test('has saveDebounceMs (1 second)', () => {
      expect(DEFAULT_SETTINGS.saveDebounceMs).toBe(1000);
    });
  });

  describe('value validation', () => {
    test('all numeric values are positive', () => {
      const numericKeys = [
        'maxConcurrentAnalysis',
        'confidenceThreshold',
        'maxImageFileSize',
        'maxDocumentFileSize',
        'maxTextFileSize',
        'workflowRestoreMaxAge',
        'saveDebounceMs',
        'graphExpansionWeight',
        'graphExpansionMaxNeighbors',
        'chunkContextMaxNeighbors'
      ];

      numericKeys.forEach((key) => {
        expect(DEFAULT_SETTINGS[key]).toBeGreaterThan(0);
      });
    });

    test('confidenceThreshold is between 0 and 1', () => {
      expect(DEFAULT_SETTINGS.confidenceThreshold).toBeGreaterThanOrEqual(0);
      expect(DEFAULT_SETTINGS.confidenceThreshold).toBeLessThanOrEqual(1);
    });
  });
});

describe('defaultSettings — user values only (ST-02, ST-03)', () => {
  let mod;

  beforeEach(() => {
    jest.resetModules();
    mod = require('../src/shared/defaultSettings');
  });

  test('stripDefaultValues keeps only values that differ from the defaults', () => {
    const out = mod.stripDefaultValues({
      ...mod.DEFAULT_SETTINGS,
      confidenceThreshold: 0.9,
      downloadsTriageExclusions: ['*.iso']
    });
    expect(out).toEqual({
      settingsSchemaVersion: mod.DEFAULT_SETTINGS.settingsSchemaVersion,
      experienceMode: mod.DEFAULT_SETTINGS.experienceMode,
      autoConcurrency: mod.DEFAULT_SETTINGS.autoConcurrency,
      confidenceThreshold: 0.9,
      downloadsTriageExclusions: ['*.iso']
    });
  });

  test('keys whose presence carries meaning survive even at their default value', () => {
    expect(mod.PERSISTED_WHEN_DEFAULT).toEqual([
      'settingsSchemaVersion',
      'experienceMode',
      'autoConcurrency'
    ]);
    const out = mod.stripDefaultValues({ experienceMode: 'simple', autoConcurrency: true });
    expect(out).toEqual({ experienceMode: 'simple', autoConcurrency: true });
  });

  test('a superseded default is treated as unset', () => {
    expect(mod.SUPERSEDED_DEFAULTS.workflowRestoreMaxAge).toEqual([60 * 60 * 1000]);
    expect(mod.isDefaultSettingValue('workflowRestoreMaxAge', 60 * 60 * 1000)).toBe(true);
    expect(mod.isDefaultSettingValue('workflowRestoreMaxAge', 24 * 60 * 60 * 1000)).toBe(true);
    expect(mod.isDefaultSettingValue('workflowRestoreMaxAge', 2 * 60 * 60 * 1000)).toBe(false);
    expect(mod.stripDefaultValues({ workflowRestoreMaxAge: 60 * 60 * 1000 })).toEqual({});
    expect(
      mod.mergeWithDefaults(mod.stripDefaultValues({ workflowRestoreMaxAge: 3_600_000 }))
    ).toEqual(expect.objectContaining({ workflowRestoreMaxAge: 24 * 60 * 60 * 1000 }));
  });

  test('unknown keys and explicit nulls for non-null defaults pass through', () => {
    expect(mod.isDefaultSettingValue('notASetting', 1)).toBe(false);
    expect(mod.stripDefaultValues({ notASetting: 1, lastBrowsedPath: null })).toEqual({
      notASetting: 1
    });
    expect(mod.stripDefaultValues({ notifications: null })).toEqual({ notifications: null });
  });

  test('array defaults compare structurally', () => {
    expect(mod.isDefaultSettingValue('customChatPersonas', [])).toBe(true);
    expect(mod.isDefaultSettingValue('downloadsTriageExclusions', ['*.tmp'])).toBe(false);
    expect(mod.stripDefaultValues(null)).toEqual({});
  });
});
