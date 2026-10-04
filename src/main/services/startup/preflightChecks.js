// @ts-check
/**
 * Preflight Checks
 *
 * Pre-startup validation for system requirements.
 * Extracted from StartupManager for better maintainability.
 *
 * @module services/startup/preflightChecks
 */

const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const { createLogger } = require('../../../shared/logger');
const { withTimeout } = require('../../../shared/promiseUtils');
const { getInstance: getLlamaService } = require('../LlamaService');
// Vector DB is in-process (Orama) - no external health endpoints needed

const logger = createLogger('StartupManager:Preflight');

/**
 * FIX Issue 3.7: Validate environment variables before startup
 * Returns array of error messages for invalid env vars
 * @returns {string[]} Array of validation error messages
 */
function validateEnvironmentVariables() {
  const errors = [];

  // Validate SERVICE_CHECK_TIMEOUT is a positive number
  if (process.env.SERVICE_CHECK_TIMEOUT) {
    const timeout = parseInt(process.env.SERVICE_CHECK_TIMEOUT, 10);
    if (isNaN(timeout) || timeout < 100 || timeout > 60000) {
      errors.push(
        `SERVICE_CHECK_TIMEOUT must be 100-60000ms, got: "${process.env.SERVICE_CHECK_TIMEOUT}"`
      );
    }
  }

  return errors;
}

/**
 * Run all pre-flight checks
 * FIX: Parallelized checks 2-5 to reduce startup time by 6-12 seconds
 * @param {object} options - Options object
 * @param {(...args: any[]) => any} options.reportProgress - Progress reporter function
 * @param {Array<any>} options.errors - Errors array to populate
 * @returns {Promise<Array<any>>} Check results
 */
async function runPreflightChecks({ reportProgress, errors }) {
  reportProgress('preflight', 'Running pre-flight checks...', 5);
  const checks = [];
  logger.debug('[PREFLIGHT] Starting pre-flight checks...');

  const envErrors = validateEnvironmentVariables();
  if (envErrors.length > 0) {
    logger.warn('[PREFLIGHT] Environment variable validation failed:', envErrors);
    errors.push({
      service: 'environment',
      error: `Invalid environment variables: ${envErrors.join('; ')}`,
      critical: false // Non-critical - app can still function with defaults
    });
    checks.push({ name: 'Environment Variables', status: 'warning', errors: envErrors });
  } else {
    logger.debug('[PREFLIGHT] Environment variables validated successfully');
    checks.push({ name: 'Environment Variables', status: 'ok' });
  }

  // Check 1: Verify data directory exists and is writable (MUST run first - critical)
  try {
    logger.debug('[PREFLIGHT] Checking data directory...');
    const userDataPath = app.getPath('userData');
    logger.debug(`[PREFLIGHT] Data directory path: ${userDataPath}`);

    try {
      await withTimeout(fs.access(userDataPath), 5000, 'Directory access check');
      logger.debug('[PREFLIGHT] Data directory exists');
    } catch {
      logger.debug('[PREFLIGHT] Data directory does not exist, creating...');
      await withTimeout(fs.mkdir(userDataPath, { recursive: true }), 5000, 'Directory creation');
      logger.debug('[PREFLIGHT] Data directory created');
    }

    const testFile = path.join(userDataPath, '.write-test');
    logger.debug(`[PREFLIGHT] Testing write access with file: ${testFile}`);
    await withTimeout(
      fs.writeFile(testFile, 'test').then(() => fs.unlink(testFile)),
      5000,
      'Write access test'
    );
    logger.debug('[PREFLIGHT] Data directory write test passed');
    checks.push({ name: 'Data Directory', status: 'ok' });
  } catch (error) {
    logger.error('[PREFLIGHT] Data directory check failed:', error);
    checks.push({
      name: 'Data Directory',
      status: 'fail',
      error: error.message
    });
    errors.push({
      check: 'data-directory',
      error: error.message,
      critical: true
    });
  }

  // Run AI engine, model availability, and disk checks in parallel
  logger.debug('[PREFLIGHT] Running AI engine, model, and disk checks in parallel...');

  const [aiResult, modelsResult, diskResult] = await Promise.allSettled([
    (async () => {
      const service = getLlamaService();
      return await service.testConnection();
    })(),
    (async () => {
      const service = getLlamaService();
      const cfg = await service.getConfig();
      const models = await service.listModels();
      const available = new Set(
        models
          .map((/** @type {any} */ m) => m?.name || m?.filename || '')
          .filter((/** @type {any} */ name) => Boolean(name))
      );
      const required = [cfg.textModel, cfg.embeddingModel].filter(Boolean);
      const missingRequired = required.filter((m) => !available.has(m));
      const visionModel = cfg.visionModel || null;
      const visionMissing = Boolean(visionModel) && !available.has(visionModel);
      // Vision projector (mmproj) is a SEPARATE asset from the base vision
      // model. The recent fix b58527d9 made vision fail-fast when the
      // projector is missing, but a user with a present base model and a
      // missing projector still got "Models: ok" at startup and only
      // discovered the problem at first image-analysis attempt. Surface it
      // here so the warning lands during the splash-screen window.
      const projectorStatus = cfg.visionProjector || null;
      const projectorMissing = Boolean(projectorStatus?.required && !projectorStatus.available);
      return {
        required,
        missingRequired,
        visionModel,
        visionMissing,
        projectorStatus,
        projectorMissing,
        availableCount: models.length
      };
    })(),
    (async () => {
      logger.debug('[PREFLIGHT] Starting disk space check...');
      const userDataPath = app.getPath('userData');
      logger.debug(`[PREFLIGHT] User data path resolved to: ${userDataPath}`);

      try {
        const { statfs } = require('fs/promises');
        if (statfs) {
          const stats = await statfs(userDataPath);
          const freeBytes = stats.bavail * stats.bsize;
          const freeGB = freeBytes / 1024 / 1024 / 1024;

          // Warn if less than 10GB available (models + index overhead)
          if (freeGB < 10) {
            return {
              ok: true, // Don't fail, just warn
              status: 'warn',
              message: `Low disk space: ${freeGB.toFixed(1)}GB available (10GB recommended)`
            };
          }
          return { ok: true, freeGB };
        }
        return { ok: true, message: 'Disk check skipped (statfs not available)' };
      } catch (error) {
        logger.warn('[PREFLIGHT] Disk space check failed:', error);
        return { ok: true, error: error.message }; // Non-fatal
      }
    })()
  ]);

  if (aiResult.status === 'fulfilled') {
    const ai = aiResult.value || {};
    checks.push({
      name: 'AI Engine',
      status: ai.success ? 'ok' : 'warn',
      details: {
        status: ai.status,
        gpuBackend: ai.gpuBackend,
        modelCount: ai.modelCount
      }
    });
    if (!ai.success) {
      errors.push({
        check: 'ai-engine',
        error: ai.error || 'AI engine unavailable',
        critical: false
      });
    }
  } else {
    checks.push({
      name: 'AI Engine',
      status: 'warn',
      error: aiResult.reason?.message || 'Unknown error'
    });
  }

  if (modelsResult.status === 'fulfilled') {
    const {
      required,
      missingRequired,
      visionModel,
      visionMissing,
      projectorStatus,
      projectorMissing,
      availableCount
    } = modelsResult.value || {};
    const hasRequiredMissing = Array.isArray(missingRequired) && missingRequired.length > 0;
    const hasVisionWarning = Boolean(visionModel) && visionMissing === true;
    const hasProjectorWarning = projectorMissing === true;
    const missing = [
      ...(Array.isArray(missingRequired) ? missingRequired : []),
      ...(hasVisionWarning ? [visionModel] : []),
      ...(hasProjectorWarning && projectorStatus?.projectorName
        ? [projectorStatus.projectorName]
        : [])
    ];
    checks.push({
      name: 'Models',
      status: hasRequiredMissing || hasVisionWarning || hasProjectorWarning ? 'warn' : 'ok',
      details: {
        required,
        missing,
        missingRequired,
        availableCount,
        visionModel,
        visionMissing,
        // Surface the projector status so the splash UI / diagnostics can
        // distinguish "vision model missing" from "vision model present but
        // its projector is missing". Different remediations.
        visionProjector: projectorStatus,
        projectorMissing: hasProjectorWarning
      }
    });
    if (hasRequiredMissing) {
      errors.push({
        check: 'models',
        error: `Missing required models: ${missingRequired.join(', ')}`,
        critical: false
      });
    }
    if (hasVisionWarning) {
      errors.push({
        check: 'models',
        error: `Vision model not available: ${visionModel}`,
        critical: false
      });
    }
    if (hasProjectorWarning && projectorStatus?.projectorName) {
      errors.push({
        check: 'models',
        error: `Vision multimodal projector missing: ${projectorStatus.projectorName} (image analysis will fail until this file is downloaded)`,
        critical: false
      });
    }
  } else {
    checks.push({
      name: 'Models',
      status: 'warn',
      error: modelsResult.reason?.message || 'Unknown error'
    });
  }

  // Process disk result
  if (diskResult.status === 'fulfilled') {
    const disk = /** @type {Record<string, any>} */ (diskResult.value || {});
    // When free space < 10 GB the disk check returns { status: 'warn', message }.
    const diskStatus = disk.status || 'ok';
    /** @type {Record<string, any>} */
    const diskEntry = { name: 'Disk Space', status: diskStatus };
    if (disk.message) diskEntry.message = disk.message;
    if (disk.freeGB !== undefined) diskEntry.freeGB = disk.freeGB;
    checks.push(diskEntry);
    if (diskStatus === 'warn') {
      errors.push({ check: 'disk-space', error: disk.message, critical: false });
    }
    logger.debug('[PREFLIGHT] Disk space check completed', { status: diskStatus });
  } else {
    logger.error('[PREFLIGHT] Disk space check failed:', diskResult.reason);
    checks.push({
      name: 'Disk Space',
      status: 'warn',
      error: diskResult.reason?.message || 'Unknown error'
    });
  }

  logger.debug('[PREFLIGHT] All pre-flight checks completed');
  reportProgress('preflight', 'Pre-flight checks completed', 10);
  return checks;
}

module.exports = {
  runPreflightChecks,
  validateEnvironmentVariables
};
