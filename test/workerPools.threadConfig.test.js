const originalEnv = { ...process.env };

describe('workerPools thread sizing', () => {
  let createdPools;

  beforeEach(() => {
    jest.resetModules();
    createdPools = [];

    process.env = { ...originalEnv };
    process.env.NODE_ENV = 'development';
    delete process.env.JEST_WORKER_ID;
    process.env.STRATOSORT_DISABLE_PISCINA = 'false';

    jest.doMock('fs', () => ({
      existsSync: jest.fn(() => true)
    }));

    jest.doMock('os', () => ({
      cpus: jest.fn(() => new Array(12).fill({}))
    }));

    jest.doMock('piscina', () =>
      jest.fn().mockImplementation((options) => {
        const pool = {
          ...options,
          drain: jest.fn().mockResolvedValue(undefined),
          destroy: jest.fn().mockResolvedValue(undefined),
          on: jest.fn(),
          pending: 0,
          queueSize: 0
        };
        createdPools.push(pool);
        return pool;
      })
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.dontMock('fs');
    jest.dontMock('os');
    jest.dontMock('piscina');
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('hands the embedding worker the userData folder and app version', () => {
    process.env.STRATOSORT_ENABLE_EMBEDDING_WORKER = 'true';
    const { app } = require('electron');
    const workerPools = require('../src/main/utils/workerPools');

    const pool = workerPools.getEmbeddingPool();

    expect(pool.workerData).toEqual({
      userDataPath: app.getPath('userData'),
      appVersion: app.getVersion()
    });
  });

  test('scales OCR pool above two threads on capable CPUs', () => {
    const workerPools = require('../src/main/utils/workerPools');

    const pool = workerPools.getOcrPool();

    expect(pool.maxThreads).toBe(4);
    expect(pool.stratosortMaxThreads).toBe(4);
  });

  test('honors text extraction thread override within safe bounds', () => {
    process.env.STRATOSORT_TEXT_EXTRACTION_WORKER_THREADS = '6';
    const workerPools = require('../src/main/utils/workerPools');

    const pool = workerPools.getTextExtractionPool();

    expect(pool.maxThreads).toBe(6);
    expect(pool.stratosortMaxThreads).toBe(6);
  });

  test('falls back to default OCR pool size when override is invalid', () => {
    process.env.STRATOSORT_OCR_WORKER_THREADS = 'nope';
    const workerPools = require('../src/main/utils/workerPools');

    const pool = workerPools.getOcrPool();

    expect(pool.maxThreads).toBe(4);
  });

  test('ignores zero text extraction override and uses default sizing', () => {
    process.env.STRATOSORT_TEXT_EXTRACTION_WORKER_THREADS = '0';
    const workerPools = require('../src/main/utils/workerPools');

    const pool = workerPools.getTextExtractionPool();

    expect(pool.maxThreads).toBe(4);
  });

  test('clamps oversized OCR override to the hard cap', () => {
    process.env.STRATOSORT_OCR_WORKER_THREADS = '999';
    const workerPools = require('../src/main/utils/workerPools');

    const pool = workerPools.getOcrPool();

    expect(pool.maxThreads).toBe(8);
    expect(pool.stratosortMaxThreads).toBe(8);
  });

  test('image preprocess pool defaults to the shared CPU sizing heuristic', () => {
    const workerPools = require('../src/main/utils/workerPools');

    const pool = workerPools.getImagePreprocessPool();

    expect(pool.maxThreads).toBe(4);
    expect(pool.stratosortMaxThreads).toBe(4);
  });

  test('image preprocess pool respects STRATOSORT_IMAGE_WORKER_THREADS override', () => {
    process.env.STRATOSORT_IMAGE_WORKER_THREADS = '6';
    const workerPools = require('../src/main/utils/workerPools');

    const pool = workerPools.getImagePreprocessPool();

    expect(pool.maxThreads).toBe(6);
    expect(pool.stratosortMaxThreads).toBe(6);
  });
});
