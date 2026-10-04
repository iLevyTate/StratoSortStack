/**
 * Tests for tesseractJsPaths utility
 * Validates Tesseract.js asset path resolution for main/renderer processes
 */

const path = require('path');

describe('resolveTesseractJsOptions', () => {
  const originalProcessType = process.type;
  let mockLogger;

  beforeEach(() => {
    jest.resetModules();
    jest.dontMock('fs');
    jest.dontMock('path');
    mockLogger = {
      warn: jest.fn(),
      debug: jest.fn(),
      info: jest.fn(),
      error: jest.fn()
    };
    // Default to main process
    Object.defineProperty(process, 'type', { value: 'browser', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'type', {
      value: originalProcessType,
      configurable: true
    });
    jest.restoreAllMocks();
  });

  test('returns workerPath, corePath, and workerBlobURL:false for main process', () => {
    const { resolveTesseractJsOptions } = require('../src/main/utils/tesseractJsPaths');
    const result = resolveTesseractJsOptions(mockLogger);

    // If tesseract.js is installed, should return valid paths
    if (result === null) {
      // tesseract.js not installed in test environment - that's fine
      expect(mockLogger.warn).toHaveBeenCalled();
      return;
    }

    expect(result).toHaveProperty('workerPath');
    expect(result).toHaveProperty('corePath');
    expect(result.workerBlobURL).toBe(false);
    expect(typeof result.workerPath).toBe('string');
    expect(typeof result.corePath).toBe('string');
  });

  test('returns workerPath and corePath (no workerBlobURL) for renderer process', () => {
    Object.defineProperty(process, 'type', { value: 'renderer', configurable: true });

    const { resolveTesseractJsOptions } = require('../src/main/utils/tesseractJsPaths');
    const result = resolveTesseractJsOptions(mockLogger);

    if (result === null) {
      expect(mockLogger.warn).toHaveBeenCalled();
      return;
    }

    expect(result).toHaveProperty('workerPath');
    expect(result).toHaveProperty('corePath');
    // Renderer should NOT have workerBlobURL: false
    expect(result.workerBlobURL).toBeUndefined();
  });

  test('returns null and logs warning when assets cannot be resolved', () => {
    jest.resetModules();

    // Create a version of the module that will fail require.resolve internally
    // by mocking the path module to return an invalid path for dirname
    jest.doMock('path', () => {
      const realPath = jest.requireActual('path');
      return {
        ...realPath,
        dirname: jest.fn(() => {
          throw new Error('Simulated resolution failure');
        })
      };
    });

    const { resolveTesseractJsOptions } = require('../src/main/utils/tesseractJsPaths');
    const result = resolveTesseractJsOptions(mockLogger);

    expect(result).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[OCR] Failed to resolve tesseract.js assets',
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  test('handles null logger gracefully when resolution fails', () => {
    jest.resetModules();

    jest.doMock('path', () => {
      const realPath = jest.requireActual('path');
      return {
        ...realPath,
        dirname: jest.fn(() => {
          throw new Error('Simulated failure');
        })
      };
    });

    const { resolveTesseractJsOptions } = require('../src/main/utils/tesseractJsPaths');
    // Should not throw even with null logger
    expect(() => resolveTesseractJsOptions(null)).not.toThrow();
    expect(resolveTesseractJsOptions(null)).toBeNull();
  });

  test('handles undefined logger gracefully when resolution fails', () => {
    jest.resetModules();

    jest.doMock('path', () => {
      const realPath = jest.requireActual('path');
      return {
        ...realPath,
        dirname: jest.fn(() => {
          throw new Error('Simulated failure');
        })
      };
    });

    const { resolveTesseractJsOptions } = require('../src/main/utils/tesseractJsPaths');
    expect(() => resolveTesseractJsOptions(undefined)).not.toThrow();
    expect(resolveTesseractJsOptions(undefined)).toBeNull();
  });

  test('main-process worker path matches tesseract.js v7 layout (worker-script/node)', () => {
    const { resolveTesseractJsOptions } = require('../src/main/utils/tesseractJsPaths');
    const result = resolveTesseractJsOptions(mockLogger);
    if (result === null) {
      expect(mockLogger.warn).toHaveBeenCalled();
      return;
    }
    expect(result.workerPath).toMatch(/worker-script[/\\]node[/\\]index\.js$/);
    expect(result.corePath).toMatch(/tesseract\.js-core/);
  });
});

describe('resolveTesseractLanguageOptions', () => {
  // The global test setup replaces fs with memfs and stubs os.tmpdir; the
  // module under test must see the same filesystem as these helpers, so both
  // sides are pinned to the REAL fs/os via dontMock + requireActual.
  const realFs = jest.requireActual('fs');
  const realOs = jest.requireActual('os');
  const ORIGINAL_RUNTIME_DIR = process.env.STRATOSORT_RUNTIME_DIR;
  /** Directories created during a test, removed in afterEach. */
  let tmpDirs = [];
  let mockLogger;

  function makeTmpDir(prefix) {
    const dir = realFs.mkdtempSync(path.join(realOs.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    jest.resetModules();
    jest.dontMock('fs');
    jest.dontMock('os');
    tmpDirs = [];
    mockLogger = { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() };
    delete process.env.STRATOSORT_RUNTIME_DIR;
  });

  afterEach(() => {
    if (ORIGINAL_RUNTIME_DIR === undefined) {
      delete process.env.STRATOSORT_RUNTIME_DIR;
    } else {
      process.env.STRATOSORT_RUNTIME_DIR = ORIGINAL_RUNTIME_DIR;
    }
    for (const dir of tmpDirs) {
      try {
        realFs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    jest.restoreAllMocks();
  });

  test('cachePath defaults to a tessdata-cache dir under electron userData (never process cwd)', () => {
    const { resolveTesseractLanguageOptions } = require('../src/main/utils/tesseractJsPaths');
    const result = resolveTesseractLanguageOptions(mockLogger);

    // The shared electron mock maps userData -> /mock/userData
    expect(result.cachePath).toBe(path.join('/mock/userData', 'tessdata-cache'));
    expect(result.cachePath).not.toBe('.');
  });

  test('honors an explicit cachePath (worker threads receive it from the parent process)', () => {
    const { resolveTesseractLanguageOptions } = require('../src/main/utils/tesseractJsPaths');
    const result = resolveTesseractLanguageOptions(mockLogger, {
      cachePath: '/parent/supplied/tessdata-cache'
    });
    expect(result.cachePath).toBe('/parent/supplied/tessdata-cache');
  });

  test('uses bundled eng.traineddata.gz as langPath with gzip:true when present', () => {
    const runtimeDir = makeTmpDir('stratosort-runtime-');
    const tessdataDir = path.join(runtimeDir, 'tessdata');
    realFs.mkdirSync(tessdataDir, { recursive: true });
    realFs.writeFileSync(path.join(tessdataDir, 'eng.traineddata.gz'), 'dummy');
    process.env.STRATOSORT_RUNTIME_DIR = runtimeDir;

    const { resolveTesseractLanguageOptions } = require('../src/main/utils/tesseractJsPaths');
    const result = resolveTesseractLanguageOptions(mockLogger, { lang: 'eng' });

    expect(result.langPath).toBe(tessdataDir);
    expect(result.gzip).toBe(true);
    expect(result.cachePath).toBe(path.join('/mock/userData', 'tessdata-cache'));
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  test('uses bundled plain eng.traineddata with gzip:false when only the ungzipped file exists', () => {
    const runtimeDir = makeTmpDir('stratosort-runtime-');
    const tessdataDir = path.join(runtimeDir, 'tessdata');
    realFs.mkdirSync(tessdataDir, { recursive: true });
    realFs.writeFileSync(path.join(tessdataDir, 'eng.traineddata'), 'dummy');
    process.env.STRATOSORT_RUNTIME_DIR = runtimeDir;

    const { resolveTesseractLanguageOptions } = require('../src/main/utils/tesseractJsPaths');
    const result = resolveTesseractLanguageOptions(mockLogger, { lang: 'eng' });

    expect(result.langPath).toBe(tessdataDir);
    expect(result.gzip).toBe(false);
  });

  test('points langPath at the cache dir when no bundle exists but a cached traineddata does', () => {
    const cachePath = makeTmpDir('stratosort-tessdata-cache-');
    realFs.writeFileSync(path.join(cachePath, 'eng.traineddata'), 'dummy');
    // Bundled lookup must miss: point the runtime dir at an empty tmp dir
    process.env.STRATOSORT_RUNTIME_DIR = makeTmpDir('stratosort-runtime-empty-');

    const { resolveTesseractLanguageOptions } = require('../src/main/utils/tesseractJsPaths');
    const result = resolveTesseractLanguageOptions(mockLogger, { cachePath });

    expect(result.langPath).toBe(cachePath);
    expect(result.gzip).toBe(false);
    expect(result.cachePath).toBe(cachePath);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  test('warns exactly once about the CDN fetch when neither bundled nor cached traineddata exists', () => {
    process.env.STRATOSORT_RUNTIME_DIR = makeTmpDir('stratosort-runtime-empty-');

    const { resolveTesseractLanguageOptions } = require('../src/main/utils/tesseractJsPaths');

    const first = resolveTesseractLanguageOptions(mockLogger, {
      cachePath: makeTmpDir('stratosort-tessdata-cache-')
    });

    // langPath deliberately left unset: tesseract.js falls back to its CDN
    // default, and the fetch result is cached to cachePath for offline reuse.
    expect(first.langPath).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn.mock.calls[0][0]).toMatch(/cdn\.jsdelivr\.net/);
    expect(mockLogger.warn.mock.calls[0][0]).toMatch(/assets\/runtime\/tessdata/);

    // Single-fire: a second resolution does not warn again
    resolveTesseractLanguageOptions(mockLogger, {
      cachePath: makeTmpDir('stratosort-tessdata-cache-')
    });
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });

  test('creates the cache dir before use (outside the jest env gate)', () => {
    const parent = makeTmpDir('stratosort-cache-parent-');
    const cachePath = path.join(parent, 'nested', 'tessdata-cache');
    process.env.STRATOSORT_RUNTIME_DIR = makeTmpDir('stratosort-runtime-empty-');

    const originalJestWorkerId = process.env.JEST_WORKER_ID;
    const originalNodeEnv = process.env.NODE_ENV;
    try {
      // _ensureDirExists skips filesystem writes under jest (the shared electron
      // mock points userData at a fake absolute path); lift the gate to verify
      // the production mkdir actually runs.
      delete process.env.JEST_WORKER_ID;
      delete process.env.NODE_ENV;

      const { resolveTesseractLanguageOptions } = require('../src/main/utils/tesseractJsPaths');
      const result = resolveTesseractLanguageOptions(mockLogger, { cachePath });

      expect(result.cachePath).toBe(cachePath);
      expect(realFs.existsSync(cachePath)).toBe(true);
    } finally {
      if (originalJestWorkerId !== undefined) process.env.JEST_WORKER_ID = originalJestWorkerId;
      if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test('falls back to an os.tmpdir cache dir when electron userData is unavailable', () => {
    jest.doMock('electron', () => {
      throw new Error('electron unavailable in worker thread');
    });
    const { resolveTessdataCacheDir } = require('../src/main/utils/tesseractJsPaths');
    const cacheDir = resolveTessdataCacheDir();
    expect(cacheDir).toBe(path.join(realOs.tmpdir(), 'stratosort-tessdata-cache'));
  });
});
