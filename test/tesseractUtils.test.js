/**
 * Tests for tesseract utils availability behavior.
 */

describe('tesseractUtils availability', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2020-01-01T00:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('retries availability after cache expiry when worker recovers', async () => {
    const mockExecFile = jest.fn((...args) => {
      const callback = args[args.length - 1];
      callback(new Error('native tesseract missing'));
    });

    const createWorker = jest
      .fn()
      .mockRejectedValueOnce(new Error('worker start failed'))
      .mockResolvedValueOnce({});

    jest.doMock('child_process', () => ({ execFile: mockExecFile }));
    jest.doMock('tesseract.js', () => ({ createWorker }));

    const { isTesseractAvailable } = require('../src/main/utils/tesseractUtils');

    const firstCheck = await isTesseractAvailable();
    expect(firstCheck).toBe(false);
    expect(createWorker).toHaveBeenCalledTimes(1);

    jest.setSystemTime(new Date('2020-01-01T00:01:00Z'));

    const secondCheck = await isTesseractAvailable();
    expect(secondCheck).toBe(true);
    expect(createWorker).toHaveBeenCalledTimes(2);
  });

  it('reports unavailable when the native binary works but tesseract.js assets are missing', async () => {
    // Native `tesseract --version` succeeds...
    const mockExecFile = jest.fn((...args) => {
      const callback = args[args.length - 1];
      callback(null, { stdout: 'tesseract 5.0.0', stderr: '' });
    });
    jest.doMock('child_process', () => ({ execFile: mockExecFile }));
    // ...but the tesseract.js fallback assets cannot be resolved, so the only
    // recognition path real callers use (recognizeIfAvailable with no native
    // module) can never actually run. Availability must report false.
    jest.doMock('../src/main/utils/tesseractJsPaths', () => ({
      resolveTesseractJsOptions: jest.fn(() => null),
      resolveTesseractLanguageOptions: jest.fn(() => ({ cachePath: '/mock/tessdata-cache' }))
    }));
    jest.doMock('../src/main/utils/runtimePaths', () => ({
      resolveRuntimePath: jest.fn().mockReturnValue(null)
    }));

    const { isTesseractAvailable } = require('../src/main/utils/tesseractUtils');

    await expect(isTesseractAvailable()).resolves.toBe(false);
  });

  it('accepts package-root OCR asset resolution when direct worker module resolution is unavailable', async () => {
    const mockExecFile = jest.fn((...args) => {
      const callback = args[args.length - 1];
      callback(new Error('native tesseract missing'));
    });

    const mockWorker = { terminate: jest.fn() };

    jest.doMock('child_process', () => ({ execFile: mockExecFile }));
    jest.doMock('tesseract.js', () => ({
      createWorker: jest.fn().mockResolvedValue(mockWorker)
    }));
    jest.doMock('../src/main/utils/tesseractJsPaths', () => ({
      resolveTesseractJsOptions: jest.fn(() => ({
        workerPath: '/app.asar.unpacked/node_modules/tesseract.js/src/worker-script/node/index.js',
        corePath: '/app.asar.unpacked/node_modules/tesseract.js-core',
        workerBlobURL: false
      })),
      resolveTesseractLanguageOptions: jest.fn(() => ({ cachePath: '/mock/tessdata-cache' }))
    }));
    jest.doMock('../src/main/utils/runtimePaths', () => ({
      resolveRuntimePath: jest.fn().mockReturnValue(null)
    }));
    jest.doMock('../src/main/utils/workerPools', () => ({
      getOcrPool: jest.fn(),
      destroyOcrPool: jest.fn().mockResolvedValue(),
      shouldUsePiscina: jest.fn().mockReturnValue(false)
    }));
    jest.doMock('../src/shared/logger', () => ({
      logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
      createLogger: jest.fn(() => ({
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        error: jest.fn()
      }))
    }));

    const { isTesseractAvailable } = require('../src/main/utils/tesseractUtils');

    await expect(isTesseractAvailable()).resolves.toBe(true);
  });

  it('passes langPath/cachePath to createWorker for local JS worker slots (no cwd cache, no CDN when local data exists)', async () => {
    const mockExecFile = jest.fn((...args) => {
      const callback = args[args.length - 1];
      callback(new Error('native tesseract missing'));
    });
    const mockWorker = {
      recognize: jest.fn().mockResolvedValue({ data: { text: 'ok' } }),
      setParameters: jest.fn(),
      terminate: jest.fn()
    };
    const createWorker = jest.fn().mockResolvedValue(mockWorker);

    jest.doMock('child_process', () => ({ execFile: mockExecFile }));
    jest.doMock('tesseract.js', () => ({ createWorker }));
    const resolveTesseractLanguageOptions = jest.fn(() => ({
      cachePath: '/mock/userData/tessdata-cache',
      langPath: '/bundled/assets/runtime/tessdata',
      gzip: true
    }));
    jest.doMock('../src/main/utils/tesseractJsPaths', () => ({
      resolveTesseractJsOptions: jest.fn(() => ({
        workerPath: '/fake/worker.js',
        corePath: '/fake/core',
        workerBlobURL: false
      })),
      resolveTesseractLanguageOptions
    }));
    jest.doMock('../src/main/utils/runtimePaths', () => ({
      resolveRuntimePath: jest.fn().mockReturnValue(null)
    }));
    jest.doMock('../src/main/utils/workerPools', () => ({
      getOcrPool: jest.fn().mockReturnValue(null),
      destroyOcrPool: jest.fn().mockResolvedValue(),
      shouldUsePiscina: jest.fn().mockReturnValue(false)
    }));

    const { recognizeIfAvailable } = require('../src/main/utils/tesseractUtils');
    const result = await recognizeIfAvailable(null, Buffer.from('image-data'));

    expect(result.success).toBe(true);
    expect(resolveTesseractLanguageOptions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lang: 'eng' })
    );
    expect(createWorker).toHaveBeenCalledWith(
      'eng',
      1,
      expect.objectContaining({
        cachePath: '/mock/userData/tessdata-cache',
        langPath: '/bundled/assets/runtime/tessdata',
        gzip: true
      })
    );
  });
});
