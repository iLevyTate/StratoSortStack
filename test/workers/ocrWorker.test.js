/**
 * Unit tests for `ocrWorker`.
 *
 * The worker's default export (`runOcrTask`) is an async function that
 * always resolves to a `{ text, error? }` shape — it never throws across
 * the worker boundary. We drive the REAL module with `tesseract.js` and
 * the tesseract asset resolver mocked, so every branch is covered without
 * the native OCR engine:
 *   1. The exported function actually loaded (no swallowed require).
 *   2. Missing input returns a structured error.
 *   3. Missing tesseract assets fall back to a structured error.
 *   4. The init retry cap (MAX_WORKER_INIT_RETRIES) gives up after 3 fails.
 *   5. A successful recognize switches language and applies the PSM param.
 *   6. A recognize failure is surfaced as `{ error }`, not a throw.
 *
 * The OCR worker keeps module-level state (workerPromise / workerFailCount),
 * so `loadWorker` does a `jest.resetModules()` per call to keep tests
 * isolated; the retry-cap test deliberately reuses one instance.
 */

jest.mock('../../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

function loadWorker({
  resolveOptions = () => ({}),
  resolveLanguageOptions = () => ({ cachePath: '/fallback/tessdata-cache' }),
  createWorker = jest.fn()
} = {}) {
  jest.resetModules();
  jest.doMock('../../src/main/utils/tesseractJsPaths', () => ({
    resolveTesseractJsOptions: resolveOptions,
    resolveTesseractLanguageOptions: resolveLanguageOptions
  }));
  jest.doMock('tesseract.js', () => ({ createWorker }));
  return require('../../src/main/workers/ocrWorker');
}

afterEach(() => {
  jest.resetModules();
});

describe('main/workers/ocrWorker', () => {
  test('exports the runOcrTask function (require did not silently fail)', () => {
    const runOcrTask = loadWorker();
    expect(typeof runOcrTask).toBe('function');
  });

  test('returns a structured error when input is missing (never throws)', async () => {
    const runOcrTask = loadWorker();
    await expect(runOcrTask({})).resolves.toEqual({ text: '', error: 'OCR input is required' });
    await expect(runOcrTask({ input: '' })).resolves.toEqual({
      text: '',
      error: 'OCR input is required'
    });
  });

  test('falls back to a structured error when tesseract assets are unavailable', async () => {
    const createWorker = jest.fn();
    const runOcrTask = loadWorker({ resolveOptions: () => null, createWorker });
    const result = await runOcrTask({ input: 'base64image' });
    expect(result).toEqual({ text: '', error: 'tesseract.js assets unavailable' });
    // worker creation must not be attempted once assets are missing
    expect(createWorker).not.toHaveBeenCalled();
  });

  test('synchronous init failures honor the retry cap and eventually give up', async () => {
    // resolveTesseractJsOptions returning null throws BEFORE any await, so the
    // init fails synchronously. Regression guard for F-009: the rejected promise
    // must not be pinned in the module cache (which previously froze workerFailCount
    // at 1), so repeated calls advance the counter and trip MAX_WORKER_INIT_RETRIES.
    const createWorker = jest.fn();
    const runOcrTask = loadWorker({ resolveOptions: () => null, createWorker });
    const first = await runOcrTask({ input: 'x' });
    expect(first).toEqual({ text: '', error: 'tesseract.js assets unavailable' });
    await runOcrTask({ input: 'x' });
    await runOcrTask({ input: 'x' });
    const capped = await runOcrTask({ input: 'x' });
    expect(capped.text).toBe('');
    expect(capped.error).toMatch(/giving up/i);
    expect(createWorker).not.toHaveBeenCalled();
  });

  test('stops retrying worker init after the retry cap and reports giving up', async () => {
    // createWorker rejects AFTER an await, so each failure clears the cached
    // workerPromise and increments workerFailCount. The first 3 calls retry;
    // the 4th short-circuits on the cap (MAX_WORKER_INIT_RETRIES = 3).
    const createWorker = jest.fn().mockRejectedValue(new Error('worker boot failed'));
    const runOcrTask = loadWorker({ resolveOptions: () => ({}), createWorker });
    await runOcrTask({ input: 'x' });
    await runOcrTask({ input: 'x' });
    await runOcrTask({ input: 'x' });
    const result = await runOcrTask({ input: 'x' });
    expect(result.text).toBe('');
    expect(result.error).toMatch(/giving up/i);
    // init attempted exactly MAX_WORKER_INIT_RETRIES times before giving up
    expect(createWorker).toHaveBeenCalledTimes(3);
  });

  test('runs a successful recognize, switching language and applying PSM', async () => {
    const recognize = jest.fn().mockResolvedValue({ data: { text: 'extracted text' } });
    const reinitialize = jest.fn().mockResolvedValue();
    const setParameters = jest.fn().mockResolvedValue();
    const createWorker = jest.fn().mockResolvedValue({ recognize, reinitialize, setParameters });

    const runOcrTask = loadWorker({ resolveOptions: () => ({ langPath: '/x' }), createWorker });
    const result = await runOcrTask({ input: 'base64image', options: { lang: 'fra', psm: 6 } });

    expect(result).toEqual({ text: 'extracted text' });
    // getWorker initializes on 'eng'; ensureLanguage then switches to 'fra'.
    expect(reinitialize).toHaveBeenCalledWith('fra');
    expect(setParameters).toHaveBeenCalledWith({ tessedit_pageseg_mode: '6' });
    expect(recognize).toHaveBeenCalledWith('base64image');
  });

  test('passes parent-supplied tessdata (langPath/cachePath) through to createWorker', async () => {
    // Worker threads cannot call electron's app.getPath('userData'), so the
    // parent (tesseractUtils) resolves langPath/cachePath and ships them in the
    // task payload. Without them tesseract.js v7 would download eng.traineddata
    // from cdn.jsdelivr.net and cache it to process cwd.
    const recognize = jest.fn().mockResolvedValue({ data: { text: 'hi' } });
    const createWorker = jest.fn().mockResolvedValue({ recognize });
    const resolveLanguageOptions = jest.fn(() => ({ cachePath: '/should-not-be-used' }));

    const runOcrTask = loadWorker({
      resolveOptions: () => ({ workerPath: '/w', corePath: '/c' }),
      resolveLanguageOptions,
      createWorker
    });
    const tessdata = {
      cachePath: '/mock/userData/tessdata-cache',
      langPath: '/resources/assets/runtime/tessdata',
      gzip: true
    };
    const result = await runOcrTask({ input: 'base64image', tessdata });

    expect(result).toEqual({ text: 'hi' });
    expect(createWorker).toHaveBeenCalledWith(
      'eng',
      1,
      expect.objectContaining({
        workerPath: '/w',
        corePath: '/c',
        cachePath: '/mock/userData/tessdata-cache',
        langPath: '/resources/assets/runtime/tessdata',
        gzip: true
      })
    );
    // Parent-supplied paths win; local (worker-side) resolution must not run.
    expect(resolveLanguageOptions).not.toHaveBeenCalled();
  });

  test('falls back to local tessdata resolution when the payload has no tessdata', async () => {
    const recognize = jest.fn().mockResolvedValue({ data: { text: 'hi' } });
    const createWorker = jest.fn().mockResolvedValue({ recognize });
    const resolveLanguageOptions = jest.fn(() => ({ cachePath: '/tmp/stratosort-tessdata-cache' }));

    const runOcrTask = loadWorker({
      resolveOptions: () => ({}),
      resolveLanguageOptions,
      createWorker
    });
    await runOcrTask({ input: 'base64image' });

    expect(resolveLanguageOptions).toHaveBeenCalled();
    expect(createWorker).toHaveBeenCalledWith(
      'eng',
      1,
      expect.objectContaining({ cachePath: '/tmp/stratosort-tessdata-cache' })
    );
  });

  test('recognition failure is surfaced as a structured error, not a throw', async () => {
    const recognize = jest.fn().mockRejectedValue(new Error('tesseract crashed'));
    const createWorker = jest
      .fn()
      .mockResolvedValue({ recognize, reinitialize: jest.fn().mockResolvedValue() });

    const runOcrTask = loadWorker({ resolveOptions: () => ({}), createWorker });
    const result = await runOcrTask({ input: 'base64image' });
    expect(result).toEqual({ text: '', error: 'tesseract crashed' });
  });
});
