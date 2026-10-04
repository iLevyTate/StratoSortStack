/**
 * Unit tests for `imagePreprocessWorker`.
 *
 * We mock `sharp` rather than loading the native binary because:
 *   1. CI runners (and many dev machines) don't have libvips installed
 *      with PDF support, which would cause `rasterize_pdf` tests to be
 *      non-deterministic.
 *   2. The worker's contract is primarily about *orchestration* —
 *      choosing when to resize, threading the options through, returning
 *      structured `{ error }` objects instead of throwing — not about
 *      pixel correctness (libvips' own suite handles that).
 *
 * The mock exposes a small builder so each test can script what
 * `metadata()` returns and assert which sharp calls happened in which
 * order.
 */

function buildSharpMock({
  metadata,
  toBuffer,
  failMetadata = false,
  failRasterizeMeta = false
} = {}) {
  const resizeCalls = [];
  const pngCalls = [];

  function makePipeline(overrideMeta = metadata) {
    const pipeline = {
      metadata: jest.fn(() => {
        if (failMetadata) return Promise.reject(new Error('metadata blew up'));
        if (failRasterizeMeta) return Promise.reject(new Error('libvips lacks pdf'));
        return Promise.resolve(overrideMeta || {});
      }),
      resize: jest.fn((...args) => {
        resizeCalls.push(args);
        return pipeline;
      }),
      rotate: jest.fn(() => pipeline),
      png: jest.fn((opts) => {
        pngCalls.push(opts);
        return pipeline;
      }),
      toBuffer: jest.fn(() => {
        return Promise.resolve(typeof toBuffer === 'function' ? toBuffer() : toBuffer);
      })
    };
    return pipeline;
  }

  const lastPipelines = [];
  const sharpFn = jest.fn((buf, opts) => {
    const p = makePipeline();
    p.__constructedWith = { buf, opts };
    lastPipelines.push(p);
    return p;
  });
  sharpFn.concurrency = jest.fn();

  return {
    sharp: sharpFn,
    resizeCalls,
    pngCalls,
    lastPipelines
  };
}

describe('main/workers/imagePreprocessWorker', () => {
  let runImagePreprocess;
  let mock;

  beforeEach(() => {
    jest.resetModules();
    mock = buildSharpMock({
      metadata: {
        width: 2048,
        height: 1024,
        format: 'jpeg',
        channels: 3,
        space: 'srgb',
        hasAlpha: false,
        density: 72,
        orientation: 1,
        exif: Buffer.from('stub')
      },
      toBuffer: () => Buffer.from([1, 2, 3])
    });

    jest.doMock('sharp', () => mock.sharp);
    // `exif-reader` is a runtime dep of the worker but only for the
    // EXIF-date branch. We virtual-mock it so the mocked Buffer payload
    // decodes to a deterministic DateTimeOriginal. exif-reader 2.x groups
    // tags by IFD (`Photo`, `Image`) and returns Date objects.
    jest.doMock(
      'exif-reader',
      () => () => ({ Photo: { DateTimeOriginal: new Date(Date.UTC(2024, 4, 1, 12, 0, 0)) } }),
      { virtual: true }
    );

    runImagePreprocess = require('../../src/main/workers/imagePreprocessWorker');
  });

  afterEach(() => {
    jest.resetModules();
  });

  test('metadata task returns normalized fields and EXIF date', async () => {
    const result = await runImagePreprocess({
      type: 'metadata',
      buffer: Buffer.from([0]),
      options: {}
    });
    expect(result.metadata).toEqual({
      width: 2048,
      height: 1024,
      format: 'jpeg',
      channels: 3,
      space: 'srgb',
      hasAlpha: false,
      density: 72,
      orientation: 1
    });
    expect(result.exifDate).toBe('2024-05-01');
  });

  test('metadata task still reads the exif-reader 1.x shape and the Image DateTime fallback', async () => {
    jest.resetModules();
    jest.doMock('sharp', () => mock.sharp);
    jest.doMock(
      'exif-reader',
      () => () => ({ exif: { DateTimeOriginal: '2021:12:24 08:30:00' } }),
      { virtual: true }
    );
    let worker = require('../../src/main/workers/imagePreprocessWorker');
    let result = await worker({ type: 'metadata', buffer: Buffer.from([0]), options: {} });
    expect(result.exifDate).toBe('2021-12-24');

    jest.resetModules();
    jest.doMock('sharp', () => mock.sharp);
    jest.doMock(
      'exif-reader',
      () => () => ({ Image: { DateTime: new Date(Date.UTC(2020, 0, 2, 0, 0, 0)) } }),
      { virtual: true }
    );
    worker = require('../../src/main/workers/imagePreprocessWorker');
    result = await worker({ type: 'metadata', buffer: Buffer.from([0]), options: {} });
    expect(result.exifDate).toBe('2020-01-02');
  });

  test('metadata task skips a placeholder capture date and falls through to the next candidate', async () => {
    jest.resetModules();
    jest.doMock('sharp', () => mock.sharp);
    jest.doMock(
      'exif-reader',
      () => () => ({
        Photo: { DateTimeOriginal: new Date(Date.UTC(1899, 10, 30)) },
        Image: { DateTime: new Date(Date.UTC(2022, 2, 3, 0, 0, 0)) }
      }),
      { virtual: true }
    );
    let worker = require('../../src/main/workers/imagePreprocessWorker');
    let result = await worker({ type: 'metadata', buffer: Buffer.from([0]), options: {} });
    expect(result.exifDate).toBe('2022-03-03');

    jest.resetModules();
    jest.doMock('sharp', () => mock.sharp);
    jest.doMock(
      'exif-reader',
      () => () => ({ exif: { DateTimeOriginal: '0000:00:00 00:00:00' } }),
      { virtual: true }
    );
    worker = require('../../src/main/workers/imagePreprocessWorker');
    result = await worker({ type: 'metadata', buffer: Buffer.from([0]), options: {} });
    expect(result.exifDate).toBeNull();
  });

  test('preprocess skips work when image is already small and format is native', async () => {
    mock.sharp.mockImplementation(() => {
      const p = {
        metadata: () => Promise.resolve({ width: 500, height: 500, format: 'png' }),
        resize: jest.fn(),
        png: jest.fn(() => p),
        toBuffer: jest.fn(() => Promise.resolve(Buffer.from([9])))
      };
      return p;
    });

    const inputBuf = Buffer.from([42]);
    const result = await runImagePreprocess({
      type: 'preprocess',
      buffer: inputBuf,
      options: { maxDimension: 1024, needsFormatConversion: false }
    });

    expect(result.changed).toBe(false);
    expect(result.buffer).toBe(inputBuf);
  });

  test('preprocess resizes when a dimension exceeds maxDimension', async () => {
    // Default mock has 2048x1024 input with maxDimension=1024 -> needs resize on width.
    const result = await runImagePreprocess({
      type: 'preprocess',
      buffer: Buffer.from([0]),
      options: { maxDimension: 1024, needsFormatConversion: false, compressionLevel: 7 }
    });
    expect(result.changed).toBe(true);
    expect(Buffer.isBuffer(result.buffer)).toBe(true);

    // One resize call constrained to width=1024 (width >= height branch).
    const resizeArgs = mock.resizeCalls.at(-1);
    expect(resizeArgs[0]).toMatchObject({
      fit: 'inside',
      withoutEnlargement: true,
      width: 1024
    });
    expect(mock.pngCalls.at(-1)).toEqual({ compressionLevel: 7 });
  });

  test('resize_for_ocr returns original dimensions and flags whether a resize occurred', async () => {
    const result = await runImagePreprocess({
      type: 'resize_for_ocr',
      buffer: Buffer.from([0]),
      options: { maxWidth: 1024, maxHeight: 1024 }
    });
    expect(result.resized).toBe(true);
    expect(result.width).toBe(2048);
    expect(result.height).toBe(1024);
  });

  test('rasterize_pdf surfaces libvips unsupported error as structured result', async () => {
    jest.resetModules();
    mock = buildSharpMock({ metadata: {}, failRasterizeMeta: true });
    jest.doMock('sharp', () => mock.sharp);
    runImagePreprocess = require('../../src/main/workers/imagePreprocessWorker');

    const result = await runImagePreprocess({
      type: 'rasterize_pdf',
      buffer: Buffer.from([0]),
      options: { density: 200, maxWidth: 2000, maxHeight: 2000 }
    });
    expect(result.unsupported).toBe(true);
    expect(result.error).toMatch(/pdf/i);
  });

  test('unknown task type returns an error object rather than throwing', async () => {
    const result = await runImagePreprocess({ type: 'nope', buffer: Buffer.alloc(0) });
    expect(result.error).toMatch(/Unknown image preprocess task type/);
  });

  test('catches synchronous failures and surfaces them as `error` (never throws across worker boundary)', async () => {
    jest.resetModules();
    jest.doMock('sharp', () => {
      throw new Error('sharp not loadable');
    });
    const worker = require('../../src/main/workers/imagePreprocessWorker');
    const result = await worker({ type: 'metadata', buffer: Buffer.from([0]) });
    expect(result.error).toMatch(/sharp unavailable/);
  });
});
