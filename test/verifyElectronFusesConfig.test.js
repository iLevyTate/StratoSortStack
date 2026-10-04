const path = require('path');

const { validateConfig } = require('../scripts/verify-electron-fuses-config');

// test-setup.js swaps `fs` for memfs; the committed config lives on the real disk.
const realFs = jest.requireActual('fs');
const REPO_CONFIG = JSON.parse(
  realFs.readFileSync(path.join(__dirname, '..', 'electron-builder.json'), 'utf8')
);

describe('verify-electron-fuses-config', () => {
  test('accepts the committed electron-builder.json', () => {
    expect(validateConfig(REPO_CONFIG)).toEqual([]);
  });

  test('rejects asarUnpack patterns that pull app code out of the asar', () => {
    for (const pattern of ['dist/**/*', 'dist/**', 'dist/*', '**/*.js', 'dist/*.js']) {
      const errors = validateConfig({ ...REPO_CONFIG, asarUnpack: [pattern] });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/asarUnpack pattern/);
      expect(errors[0]).toContain('dist/main.js');
    }
  });

  test('allows unpacking only the worker entry bundles', () => {
    const workersOnly = [
      '**/*.{node,dll,so,dylib,gguf,bin}',
      'dist/{ocrWorker,embeddingWorker,logExportWorker,textExtractionWorker,imagePreprocessWorker,umapProjectionWorker,settingsImportParserWorker}.js'
    ];
    expect(validateConfig({ ...REPO_CONFIG, asarUnpack: workersOnly })).toEqual([]);
  });

  test('reports missing and wrong fuse values', () => {
    const fuses = { ...REPO_CONFIG.electronFuses, runAsNode: true };
    delete fuses.enableEmbeddedAsarIntegrityValidation;
    expect(validateConfig({ ...REPO_CONFIG, electronFuses: fuses })).toEqual([
      'electronFuses.runAsNode must be false',
      'electronFuses.enableEmbeddedAsarIntegrityValidation is required'
    ]);
    expect(validateConfig({})).toEqual(['missing top-level "electronFuses" object']);
  });
});
