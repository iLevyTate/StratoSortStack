// @ts-check
const { createLogger } = require('../../shared/logger');
const {
  resolveTesseractJsOptions,
  resolveTesseractLanguageOptions
} = require('../utils/tesseractJsPaths');

// In Node worker_threads, WorkerGlobalScope may exist and mislead tesseract.js
// into using browser worker code. Force node mode by clearing it.
const globalAny = /** @type {any} */ (global);
if (typeof globalAny.WorkerGlobalScope !== 'undefined' && typeof process !== 'undefined') {
  try {
    globalAny.WorkerGlobalScope = undefined;
  } catch {
    // Best-effort only
  }
}

const logger = createLogger('OcrWorker');

/** @type {Promise<any> | null} */
let workerPromise = null;
/** @type {string | null} */
let workerLang = null;
// Track init failure count (allow up to 3 retries before permanent failure)
let workerFailCount = 0;
const MAX_WORKER_INIT_RETRIES = 3;

/**
 * @param {{ cachePath?: string, langPath?: string, gzip?: boolean } | null} [tessdata]
 *   langPath/cachePath resolved by the PARENT process (tesseractUtils) and passed
 *   in with the task payload — worker threads cannot call electron's
 *   app.getPath('userData') themselves. Without these, tesseract.js v7 downloads
 *   eng.traineddata from cdn.jsdelivr.net and caches it to process cwd.
 */
async function getWorker(tessdata) {
  if (workerFailCount >= MAX_WORKER_INIT_RETRIES) {
    throw new Error(`OCR worker initialization failed ${workerFailCount} times, giving up`);
  }
  if (workerPromise) return workerPromise;
  const attempt = (async () => {
    try {
      const { createWorker } = require('tesseract.js');
      const workerOptions = resolveTesseractJsOptions(logger);
      if (!workerOptions) {
        throw new Error('tesseract.js assets unavailable');
      }
      // Fallback resolution (bundled tessdata / tmpdir cache) only covers direct
      // invocations without a parent-supplied payload; the normal path receives
      // userData-backed paths from tesseractUtils.recognizeWithTesseractJs.
      const languageOptions =
        tessdata && typeof tessdata === 'object'
          ? tessdata
          : resolveTesseractLanguageOptions(logger);
      const worker = await createWorker('eng', 1, {
        ...workerOptions,
        ...languageOptions,
        errorHandler: (err) => {
          logger.warn('[OCR] Worker error', { error: err?.message || String(err) });
        }
      });
      workerLang = 'eng';
      workerFailCount = 0;
      return worker;
    } catch (error) {
      workerFailCount++;
      workerLang = null;
      logger.error('[OcrWorker] Failed to initialize tesseract.js worker', {
        error: error.message,
        attempt: workerFailCount,
        maxRetries: MAX_WORKER_INIT_RETRIES
      });
      throw error;
    }
  })();
  workerPromise = attempt;
  // A *synchronous* init throw (missing tesseract.js / null asset options) settles
  // the IIFE before this assignment runs, so an inner-catch null would be overwritten
  // here and pin a rejected promise forever — freezing workerFailCount at 1 and killing
  // the retry cap for that path. Clear the cache on rejection instead, guarded on
  // identity so a newer init isn't clobbered.
  attempt.catch(() => {
    if (workerPromise === attempt) workerPromise = null;
  });
  return attempt;
}

/**
 * @param {any} worker
 * @param {string} lang
 */
async function ensureLanguage(worker, lang) {
  if (workerLang === lang) return;
  if (typeof worker.reinitialize === 'function') {
    await worker.reinitialize(lang);
  } else {
    await worker.loadLanguage(lang);
    await worker.initialize(lang);
  }
  workerLang = lang;
}

/**
 * @param {{ input?: any, options?: { lang?: string, psm?: number }, tessdata?: { cachePath?: string, langPath?: string, gzip?: boolean } }} [payload]
 */
module.exports = async function runOcrTask(payload = {}) {
  const { input, options = {}, tessdata = null } = payload || {};
  if (!input) {
    return { text: '', error: 'OCR input is required' };
  }

  let worker;
  try {
    worker = await getWorker(tessdata);
  } catch (initError) {
    // Return structured error so the caller (tesseractUtils) can fall back
    // instead of letting the error propagate as an uncaught exception
    return { text: '', error: initError.message };
  }

  const lang = options.lang || 'eng';

  try {
    logger.debug('[OcrWorker] Starting OCR task', {
      lang,
      hasOptions: Object.keys(options).length > 0
    });
    await ensureLanguage(worker, lang);

    /** @type {Record<string, string>} */
    const params = {};
    if (typeof options.psm === 'number') {
      params.tessedit_pageseg_mode = String(options.psm);
    }
    if (Object.keys(params).length > 0) {
      await worker.setParameters(params);
    }

    const result = await worker.recognize(input);
    const text = result?.data?.text || '';
    logger.debug('[OcrWorker] OCR complete', { length: text.length });
    return { text };
  } catch (error) {
    logger.warn('[OcrWorker] OCR recognition failed', { error: error.message });
    return { text: '', error: error.message };
  }
};
