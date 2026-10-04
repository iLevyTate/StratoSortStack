const {
  validateSettings,
  validateSetting,
  sanitizeSettings,
  getDefaultValue,
  getConfigurableLimits,
  VALIDATION_RULES
} = require('../src/shared/settingsValidation');
const { DEFAULT_SETTINGS } = require('../src/shared/defaultSettings');

describe('settingsValidation', () => {
  test('validateSettings flags invalid path-like values and unknown keys', () => {
    const result = validateSettings({
      defaultSmartFolderLocation: '../unsafe',
      unknownFutureFlag: true
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('defaultSmartFolderLocation must be an absolute path')
      ])
    );
    expect(result.warnings).toContain('Unknown setting: unknownFutureFlag');
  });

  test('vectorDbPersistPath accepts a folder name only: the index stays under userData', () => {
    expect(
      validateSetting('vectorDbPersistPath', 'vector-db', VALIDATION_RULES.vectorDbPersistPath)
    ).toEqual([]);
    for (const value of [
      '/var/tmp/stratosort-index',
      'C:\\Index\\stratosort',
      '\\\\fileserver\\share\\index',
      '../index',
      'nested/dir'
    ]) {
      const errors = validateSetting(
        'vectorDbPersistPath',
        value,
        VALIDATION_RULES.vectorDbPersistPath
      );
      expect(errors).toEqual([
        expect.stringContaining(
          'vectorDbPersistPath must be a folder name under the app data directory'
        )
      ]);
    }
  });

  test('validateSettings detects prototype pollution keys as warnings', () => {
    const polluted = Object.create(null);
    polluted.__proto__ = 'polluted';

    const result = validateSettings(polluted);
    expect(result.warnings).toContain('Rejected unsafe key: __proto__');
  });

  test('sanitizeSettings clamps threshold and drops unsafe/deprecated keys', () => {
    const settings = Object.create(null);
    settings.confidenceThreshold = 9;
    settings.developerGraphEnabled = false;
    settings.defaultSmartFolderLocation = '../unsafe';
    settings.theme = 'dark';
    settings.dependencyWizardShown = true;
    settings.__proto__ = 'polluted';
    settings.customFutureSetting = 'keep-me';

    const sanitized = sanitizeSettings(settings);

    expect(sanitized.confidenceThreshold).toBe(1);
    expect(sanitized.developerGraphEnabled).toBe(false);
    expect(sanitized.defaultSmartFolderLocation).toBeUndefined();
    expect(sanitized.theme).toBeUndefined();
    expect(sanitized.dependencyWizardShown).toBeUndefined();
    expect(sanitized.customFutureSetting).toBeUndefined();
    expect(Object.getPrototypeOf(sanitized)).toBe(null);
  });

  test('getDefaultValue and getConfigurableLimits use shared defaults', () => {
    expect(getDefaultValue('maxConcurrentAnalysis')).toBe(DEFAULT_SETTINGS.maxConcurrentAnalysis);

    const limits = getConfigurableLimits({
      maxConcurrentAnalysis: 4,
      saveDebounceMs: 1500
    });

    expect(limits.processingLimits.maxConcurrentAnalysis).toBe(4);
    expect(limits.uiLimits.saveDebounceMs).toBe(1500);
    expect(limits.fileSizeLimits.maxTextFileSize).toBe(DEFAULT_SETTINGS.maxTextFileSize);
  });
});

describe('settingsValidation — advancedModeValues (ST-08)', () => {
  test('accepts a stash of valid Simple-mode enforced keys', () => {
    const result = validateSettings({
      advancedModeValues: { defaultEmbeddingPolicy: 'skip', autoChunkOnAnalysis: false }
    });
    expect(result.valid).toBe(true);
    expect(
      sanitizeSettings({
        advancedModeValues: { defaultEmbeddingPolicy: 'skip', autoChunkOnAnalysis: false }
      }).advancedModeValues
    ).toEqual({ defaultEmbeddingPolicy: 'skip', autoChunkOnAnalysis: false });
  });

  test('rejects keys outside the enforced set and values the key rule rejects', () => {
    expect(validateSettings({ advancedModeValues: { confidenceThreshold: 0.2 } }).valid).toBe(
      false
    );
    expect(validateSettings({ advancedModeValues: { embeddingTiming: 'never' } }).valid).toBe(
      false
    );
    expect(validateSettings({ advancedModeValues: ['skip'] }).valid).toBe(false);
    expect(
      sanitizeSettings({ advancedModeValues: { embeddingTiming: 'never' } })
    ).not.toHaveProperty('advancedModeValues');
  });

  test('null means nothing parked and passes through', () => {
    expect(validateSettings({ advancedModeValues: null }).valid).toBe(true);
    expect(sanitizeSettings({ advancedModeValues: null }).advancedModeValues).toBeNull();
  });
});

describe('settingsValidation — machine paths are platform-specific (ST-06)', () => {
  const onPosix = process.platform === 'win32' ? test.skip : test;

  onPosix('a Windows absolute path fails both path rules on POSIX', () => {
    const winPath = 'C:\\Users\\other\\Documents';
    expect(
      validateSetting(
        'defaultSmartFolderLocation',
        winPath,
        VALIDATION_RULES.defaultSmartFolderLocation
      ).length
    ).toBeGreaterThan(0);
    expect(
      validateSetting('lastBrowsedPath', winPath, VALIDATION_RULES.lastBrowsedPath).length
    ).toBeGreaterThan(0);
  });
});
