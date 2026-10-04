// @ts-check
/**
 * Analysis limits from user settings
 * Single source of truth for file size and processing limits used by the analysis pipeline
 * @module analysis/analysisLimits
 */

const { createLogger } = require('../../shared/logger');
const { getConfigurableLimits } = require('../../shared/settingsValidation');
const { DEFAULT_SETTINGS } = require('../../shared/defaultSettings');

const logger = createLogger('AnalysisLimits');

const CACHE_TTL_MS = 5000; // 5 seconds - avoid loading settings on every file
/** @type {ReturnType<typeof getDefaultLimits> | null} */
let cachedLimits = null;
let cacheTimestamp = 0;

/**
 * Get analysis limits from settings (with caching)
 * @returns {Promise<{maxImageFileSize: number, maxDocumentFileSize: number, maxTextFileSize: number}>}
 */
async function getAnalysisLimits() {
  const now = Date.now();
  if (cachedLimits && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedLimits;
  }
  try {
    const SettingsService = require('../services/SettingsService');
    const service = SettingsService.getInstance();
    if (!service?.load) {
      return getDefaultLimits();
    }
    const settings = await service.load();
    const { fileSizeLimits } = getConfigurableLimits(settings);
    /**
     * @param {unknown} raw
     * @param {number} fallback
     */
    const resolve = (raw, fallback) => {
      const num = Number(raw);
      return Number.isFinite(num) && num > 0 ? num : fallback;
    };
    cachedLimits = {
      maxImageFileSize: resolve(
        fileSizeLimits?.maxImageFileSize,
        DEFAULT_SETTINGS.maxImageFileSize
      ),
      maxDocumentFileSize: resolve(
        fileSizeLimits?.maxDocumentFileSize,
        DEFAULT_SETTINGS.maxDocumentFileSize
      ),
      maxTextFileSize: resolve(fileSizeLimits?.maxTextFileSize, DEFAULT_SETTINGS.maxTextFileSize)
    };
    cacheTimestamp = now;
    return cachedLimits;
  } catch (error) {
    logger.debug('[AnalysisLimits] Failed to load from settings, using defaults:', error?.message);
    return getDefaultLimits();
  }
}

/**
 * Default limits when settings unavailable
 * @returns {{maxImageFileSize: number, maxDocumentFileSize: number, maxTextFileSize: number}}
 */
function getDefaultLimits() {
  return {
    maxImageFileSize: DEFAULT_SETTINGS.maxImageFileSize,
    maxDocumentFileSize: DEFAULT_SETTINGS.maxDocumentFileSize,
    maxTextFileSize: DEFAULT_SETTINGS.maxTextFileSize
  };
}

/**
 * Invalidate cache (call when settings are saved externally)
 */
function invalidateCache() {
  cachedLimits = null;
  cacheTimestamp = 0;
}

module.exports = {
  getAnalysisLimits,
  getDefaultLimits,
  invalidateCache
};
