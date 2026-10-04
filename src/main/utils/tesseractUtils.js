// @ts-check
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { logger: baseLogger, createLogger } = require('../../shared/logger');
const { resolveRuntimePath } = require('./runtimePaths');
const { getOcrPool, destroyOcrPool, shouldUsePiscina } = require('./workerPools');
const {
  resolveTesseractJsOptions,
  resolveTesseractLanguageOptions
} = require('./tesseractJsPaths');
const { swallow } = require('../../shared/promiseUtils');

const execFileAsync = promisify(execFile);

const logger = typeof createLogger === 'function' ? createLogger('TesseractUtils') : baseLogger;
if (typeof createLogger !== 'function' && logger?.setContext) {
  logger.setContext('TesseractUtils');
}

const CHECK_TIMEOUT_MS = 2000;
const AVAILABILITY_CACHE_TTL_MS = 30000;
/** @type {any} */
let availabilityCache = null;
/** @type {any} */
let availabilityCheck = null;
let warnedUnavailable = false;
let warnedJsMissing = false;
let ocrPoolDisabled = false;

/** @type {Promise<any[]> | null} */
let jsWorkerSlotsPromise = null;
/** @type {string | null} */
let jsWorkerSlotsLang = null;
let jsWorkerRoundRobin = 0;

function getLocalJsWorkerCount() {
  if (process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'test') {
    return 1;
  }
  const parsed = Number.parseInt(process.env.STRATOSORT_LOCAL_OCR_WORKERS || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 2;
  }
  return Math.max(1, Math.min(parsed, 4));
}

function canUseTesseractJs() {
  try {
    require.resolve('tesseract.js');
  } catch {
    if (!warnedJsMissing) {
      warnedJsMissing = true;
      logger?.warn?.('[OCR] tesseract.js not installed, OCR JS fallback disabled');
    }
    return false;
  }

  if (!resolveTesseractJsOptions(logger)) {
    if (!warnedJsMissing) {
      warnedJsMissing = true;
      logger?.warn?.('[OCR] tesseract.js assets missing, OCR JS fallback disabled');
    }
    return false;
  }

  return true;
}

function getEmbeddedTesseractPath() {
  const exe = process.platform === 'win32' ? 'tesseract.exe' : 'tesseract';
  return resolveRuntimePath('tesseract', exe);
}

function ensureTessdataPrefix(/** @type {any} */ binaryPath) {
  if (process.env.TESSDATA_PREFIX) return;
  if (!binaryPath) return;
  const tessdata = path.join(path.dirname(binaryPath), 'tessdata');
  if (fs.existsSync(tessdata)) {
    process.env.TESSDATA_PREFIX = tessdata;
  }
}

function getTesseractBinaryPath() {
  const override = process.env.TESSERACT_PATH;
  if (override && override.trim()) return override.trim();
  const embedded = getEmbeddedTesseractPath();
  if (embedded && fs.existsSync(embedded)) {
    ensureTessdataPrefix(embedded);
    return embedded;
  }
  return 'tesseract';
}

function getTesseractOptions(baseOptions = {}) {
  const tesseractPath = getTesseractBinaryPath();
  if (!tesseractPath || tesseractPath === 'tesseract') return baseOptions;
  return { ...baseOptions, binary: tesseractPath };
}

function getAvailabilityFromCache() {
  if (!availabilityCache) return null;
  if (availabilityCache.value === true) return true;
  if (Date.now() - availabilityCache.checkedAt < AVAILABILITY_CACHE_TTL_MS) {
    return false;
  }
  availabilityCache = null;
  return null;
}

async function isTesseractAvailable() {
  const cached = getAvailabilityFromCache();
  if (cached !== null) {
    return cached;
  }
  if (availabilityCheck) {
    return availabilityCheck;
  }

  availabilityCheck = (async () => {
    const binaryPath = getTesseractBinaryPath();
    try {
      await execFileAsync(binaryPath, ['--version'], {
        windowsHide: true,
        timeout: CHECK_TIMEOUT_MS
      });
      // Recognition always falls through to the tesseract.js path (no caller passes a native
      // module), so a working native binary alone never runs OCR — the JS assets must resolve too.
      if (canUseTesseractJs()) {
        availabilityCache = { value: true, checkedAt: Date.now() };
        return true;
      }
      logger?.debug?.(
        '[OCR] Native tesseract present but tesseract.js assets unavailable; OCR disabled',
        { binaryPath }
      );
      availabilityCache = { value: false, checkedAt: Date.now() };
      return false;
    } catch (error) {
      logger?.debug?.('[OCR] Native tesseract unavailable, will try tesseract.js', {
        binaryPath,
        error: error.message
      });
      if (!canUseTesseractJs()) {
        availabilityCache = { value: false, checkedAt: Date.now() };
        return false;
      }
      try {
        if (shouldUsePiscina() && !ocrPoolDisabled) {
          getOcrPool();
          availabilityCache = { value: true, checkedAt: Date.now() };
          return true;
        }
      } catch (poolError) {
        logger?.warn?.('[OCR] OCR worker pool unavailable, falling back', {
          error: poolError.message
        });
      }
      try {
        await getJsWorkerSlots();
        availabilityCache = { value: true, checkedAt: Date.now() };
        return true;
      } catch (jsError) {
        availabilityCache = { value: false, checkedAt: Date.now() };
        if (!warnedUnavailable) {
          warnedUnavailable = true;
          logger?.warn?.('[OCR] Tesseract not available, OCR disabled', {
            binaryPath,
            error: jsError.message
          });
        }
        return false;
      }
    } finally {
      availabilityCheck = null;
    }
  })();

  return availabilityCheck;
}

async function getTesseractBinaryInfo() {
  const override = process.env.TESSERACT_PATH;
  if (override && override.trim()) {
    const info = await verifyTesseractBinary(override.trim(), 'env');
    if (info.installed) return info;
  }

  const embedded = getEmbeddedTesseractPath();
  if (embedded && fs.existsSync(embedded)) {
    ensureTessdataPrefix(embedded);
    const info = await verifyTesseractBinary(embedded, 'embedded');
    if (info.installed) return info;
  }

  return verifyTesseractBinary('tesseract', 'system');
}

async function verifyTesseractBinary(/** @type {any} */ binaryPath, /** @type {any} */ source) {
  try {
    const res = await execFileAsync(binaryPath, ['--version'], {
      windowsHide: true,
      timeout: CHECK_TIMEOUT_MS
    });
    const raw = (res.stdout || res.stderr || '').toString().trim();
    const version = raw.split(/\r?\n/)[0] || null;
    return { installed: true, version, source, path: binaryPath };
  } catch {
    return { installed: false, version: null, source, path: binaryPath };
  }
}

async function createJsWorkerSlot(lang = 'eng') {
  if (!canUseTesseractJs()) {
    throw new Error('tesseract.js assets unavailable');
  }
  const { createWorker } = require('tesseract.js');
  const workerOptions = resolveTesseractJsOptions(logger);
  if (!workerOptions) {
    throw new Error('tesseract.js assets unavailable');
  }
  // langPath/cachePath keep traineddata on-device (bundled assets/runtime/tessdata
  // or userData/tessdata-cache) instead of tesseract.js's defaults of
  // cdn.jsdelivr.net + caching to process cwd. See tesseractJsPaths.js.
  const languageOptions = resolveTesseractLanguageOptions(logger, { lang });
  const worker = await createWorker(lang, 1, {
    ...workerOptions,
    ...languageOptions,
    errorHandler: (err) => {
      logger?.warn?.('[OCR] Worker error', { error: err?.message || String(err) });
    }
  });
  return {
    worker,
    lang,
    pending: 0,
    queue: Promise.resolve()
  };
}

async function getJsWorkerSlots(lang = 'eng') {
  if (jsWorkerSlotsPromise && jsWorkerSlotsLang === lang) {
    return jsWorkerSlotsPromise;
  }
  if (jsWorkerSlotsPromise && jsWorkerSlotsLang !== lang) {
    await terminateJsWorker();
  }

  const workerCount = getLocalJsWorkerCount();
  jsWorkerSlotsLang = lang;
  jsWorkerSlotsPromise = Promise.all(
    Array.from({ length: workerCount }, () => createJsWorkerSlot(lang))
  ).catch((error) => {
    jsWorkerSlotsPromise = null;
    jsWorkerSlotsLang = null;
    throw error;
  });

  return jsWorkerSlotsPromise;
}

function selectJsWorkerSlot(/** @type {any} */ slots) {
  if (!Array.isArray(slots) || slots.length === 0) {
    throw new Error('No OCR JS workers available');
  }
  const startIndex = jsWorkerRoundRobin % slots.length;
  jsWorkerRoundRobin += 1;
  let bestSlot = slots[startIndex];
  for (let index = 1; index < slots.length; index += 1) {
    const slot = slots[(startIndex + index) % slots.length];
    if (slot.pending < bestSlot.pending) {
      bestSlot = slot;
    }
  }
  return bestSlot;
}

function runOnJsWorkerSlot(/** @type {any} */ slot, /** @type {any} */ task) {
  slot.pending += 1;
  const current = slot.queue
    .catch((/** @type {any} */ err) => {
      logger?.debug?.('[OCR] Previous task error (swallowed):', { error: err?.message });
    })
    .then(() => task(slot.worker));
  slot.queue = current
    .catch((/** @type {any} */ err) => {
      logger?.debug?.('[OCR] Current task error (swallowed):', { error: err?.message });
    })
    .finally(() => {
      slot.pending = Math.max(0, slot.pending - 1);
    });
  return current;
}

/**
 * @param {any} input
 * @param {{ lang?: string, psm?: number }} [options]
 */
async function recognizeWithTesseractJs(input, options = {}) {
  const lang = options.lang || 'eng';
  if (!ocrPoolDisabled) {
    const pool = getOcrPool();
    try {
      if (pool) {
        // Piscina worker threads cannot use electron's app.getPath, so the
        // userData-backed langPath/cachePath must be resolved here in the
        // main process and passed in with the task payload (see ocrWorker.js).
        const tessdata = resolveTesseractLanguageOptions(logger, { lang });
        const result = await pool.run({ input, options, tessdata });
        // to prevent uncaught exceptions in the Piscina thread
        if (result?.error) {
          logger?.warn?.('[OCR] Worker pool failed, falling back to local worker', {
            error: result.error
          });
          if (String(result.error).includes('addEventListener')) {
            ocrPoolDisabled = true;
            try {
              await destroyOcrPool();
            } catch {
              // Ignore pool cleanup errors
            }
          }
          // The log says "falling back to local worker" but previously returned ''
          // and never actually tried the local worker.
        } else {
          return result?.text || '';
        }
      }
    } catch (error) {
      logger?.warn?.('[OCR] Worker pool failed, falling back to local worker', {
        error: error.message
      });
      if (String(error?.message || '').includes('addEventListener')) {
        ocrPoolDisabled = true;
        try {
          await destroyOcrPool();
        } catch {
          // Ignore pool cleanup errors
        }
      }
    }
  }

  const slots = await getJsWorkerSlots(lang);
  const slot = selectJsWorkerSlot(slots);
  return runOnJsWorkerSlot(slot, async (/** @type {any} */ worker) => {
    const params = {};
    if (typeof options.psm === 'number') {
      params.tessedit_pageseg_mode = String(options.psm);
    }
    if (Object.keys(params).length > 0) {
      await worker.setParameters(params);
    }

    const result = await worker.recognize(input);
    return result?.data?.text || '';
  });
}

async function recognizeIfAvailable(
  /** @type {any} */ tesseract,
  /** @type {any} */ input,
  options = {}
) {
  let nativeError = null;
  if (tesseract?.recognize) {
    try {
      const text = await tesseract.recognize(input, getTesseractOptions(options));
      return { success: true, text };
    } catch (error) {
      const message = error?.message || 'OCR failed';
      nativeError = error instanceof Error ? error : new Error(message);
      if (message.toLowerCase().includes('write eof')) {
        logger?.debug?.('[OCR] Native tesseract write EOF, falling back', { error: message });
      } else {
        logger?.warn?.('[OCR] Native tesseract failed, falling back', { error: message });
      }
    }
  }

  const available = await isTesseractAvailable();
  if (!available) {
    return {
      success: false,
      error: nativeError?.message || 'Tesseract not available',
      cause: nativeError || null
    };
  }

  try {
    const text = await recognizeWithTesseractJs(input, options);
    return { success: true, text };
  } catch (error) {
    const message = nativeError?.message || error?.message || 'OCR failed';
    logger?.warn?.('[OCR] Tesseract.js OCR failed', { error: message });
    return { success: false, error: message, cause: nativeError || error };
  }
}

/**
 * Terminate the tesseract.js worker if one is active.
 * Safe to call even if no worker was created.
 */
async function terminateJsWorker() {
  await destroyOcrPool();
  const slots = jsWorkerSlotsPromise
    ? await jsWorkerSlotsPromise.catch(() => /** @type {any[] | null} */ (null))
    : null;
  if (!slots || slots.length === 0) {
    jsWorkerSlotsPromise = null;
    jsWorkerSlotsLang = null;
    jsWorkerRoundRobin = 0;
    return;
  }
  try {
    await Promise.all(
      slots.map((/** @type {any} */ slot) => swallow(slot.queue, logger, 'tesseract.queueDrain'))
    );
  } catch {
    // Ignore errors during queue drain
  }
  try {
    await Promise.all(
      slots.map(async (/** @type {any} */ slot) => {
        if (slot.worker && typeof slot.worker.terminate === 'function') {
          await slot.worker.terminate();
        }
      })
    );
  } catch {
    // Ignore errors during termination
  }
  jsWorkerSlotsPromise = null;
  jsWorkerSlotsLang = null;
  jsWorkerRoundRobin = 0;
}

function resetTesseractAvailability() {
  // Use fire-and-forget since callers expect a sync function
  terminateJsWorker().catch((e) => {
    logger.debug('[TesseractUtils] Worker termination failed:', e?.message);
  });
  availabilityCache = null;
  availabilityCheck = null;
  warnedUnavailable = false;
}

module.exports = {
  getTesseractBinaryPath,
  getTesseractOptions,
  isTesseractAvailable,
  getTesseractBinaryInfo,
  recognizeIfAvailable,
  resetTesseractAvailability,
  terminateJsWorker
};
