// @ts-check
const { IpcServiceContext, createFromLegacyParams } = require('./IpcServiceContext');
const { app, dialog, shell } = require('electron');
const {
  createHandler,
  successResponse,
  errorResponse,
  canceledResponse,
  safeHandle
} = require('./ipcWrappers');
const {
  getConfigurableLimits,
  sanitizeSettings,
  validateSettings,
  validateSetting,
  VALIDATION_RULES
} = require('../../shared/settingsValidation');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('node:crypto');
const {
  settingsSchema,
  backupPathSchema,
  z,
  schemas: validationSchemas
} = /** @type {{ settingsSchema: import('./ipcWrappers').SafeParseSchema, backupPathSchema: import('./ipcWrappers').SafeParseSchema, z: typeof import('zod')|null, schemas: Record<string, any> }} */ (
  require('./validationSchemas')
);
// Import centralized security configuration
const { SETTINGS_VALIDATION, PROTOTYPE_POLLUTION_KEYS } = require('../../shared/securityConfig');
const { validateFileOperationPathSync } = require('../../shared/pathSanitization');
const { assertBackupPathContained } = require('../../shared/backupPathGuard');
const { parseSettingsImportJson } = require('../services/settingsImportParser');
const {
  LOGGING_LEVELS,
  MODEL_NAME_PATTERN,
  MAX_MODEL_NAME_LENGTH,
  NOTIFICATION_MODES,
  NAMING_CONVENTIONS,
  CASE_CONVENTIONS,
  SMART_FOLDER_ROUTING_MODES,
  SEPARATOR_PATTERN
} = require('../../shared/validationConstants');
const {
  EXPERIENCE_MODES,
  EXPERIENCE_MODE_VALUES,
  applyExperienceModeSettings
} = require('../../shared/experienceMode');
const { SETTINGS_SCHEMA_VERSION } = require('../../shared/constants');
const { validateAiSettingsForSave } = require('../services/ai/aiSettings');

/**
 * The `ai` blob rides along with whole-settings saves and imports, bypassing
 * the AI_PROVIDER.* handlers that normally enforce the baseUrl allow-list and
 * the cloud-consent gate. Re-apply both here against the merged result so a
 * renderer or import file cannot point a bearer key at an arbitrary host or
 * route documents to the cloud without acknowledgement. Returns the settings
 * to persist, or a failure envelope.
 * @param {Record<string, any>} settings
 * @param {Record<string, any>} settingsService
 * @returns {Promise<{ ok: true, settings: Record<string, any> } | { ok: false, response: Record<string, any> }>}
 */
async function applyAiSettingsGate(settings, settingsService) {
  if (!Object.hasOwn(settings, 'ai') || settings.ai === null || settings.ai === undefined) {
    return { ok: true, settings };
  }
  const stored =
    typeof settingsService.get === 'function'
      ? settingsService.get('ai')
      : (await settingsService.load())?.ai;
  const result = validateAiSettingsForSave(settings.ai, stored);
  if (result.ok === false) {
    /** @type {Record<string, any>} */
    const response = { success: false, error: result.error, errorCode: result.errorCode };
    if (result.errorCode === 'CONSENT_REQUIRED') response.code = result.errorCode;
    if (result.validationErrors) response.validationErrors = result.validationErrors;
    return { ok: false, response };
  }
  return { ok: true, settings: { ...settings, ai: result.ai } };
}

/**
 * Apply settings to AI services and system configuration
 * Extracted to avoid code duplication across save/import/restore handlers
 * @param {Record<string, any>} merged - The merged settings object
 * @param {{ logger: import('./ipcWrappers').LoggerLike }} context - Context containing service setters and logger
 * @returns {Promise<Record<string, any>|null>} Model-update summary (null when no model keys changed)
 */
async function applySettingsToServices(merged, { logger }) {
  // Use LlamaService.updateConfig() to ensure model change events fire properly
  // This is critical for embedding model changes - FolderMatchingService needs to be notified
  // to clear its cache and reset the vector DB when the embedding model changes
  const { container, ServiceIds } = require('../services/ServiceContainer');

  // Ensure LlamaService is registered (it should be by now, but safe guard)
  if (!container.has(ServiceIds.LLAMA_SERVICE)) {
    const { registerWithContainer } = require('../services/LlamaService');
    registerWithContainer(container, ServiceIds.LLAMA_SERVICE);
  }

  const llamaService = /** @type {any} */ (container.tryResolve(ServiceIds.LLAMA_SERVICE));

  // Build config object with all model settings
  /** @type {Record<string, any>} */
  const llamaConfig = {};
  const textModel = merged.textModel;
  const visionModel = merged.visionModel;
  const embeddingModel = merged.embeddingModel;
  if (textModel) llamaConfig.textModel = textModel;
  if (visionModel) llamaConfig.visionModel = visionModel;
  if (embeddingModel) llamaConfig.embeddingModel = embeddingModel;
  // Engine tuning rides along with the model names. Without this the saved
  // llamaGpuLayers / llamaContextSize sat on disk until restart while
  // LlamaService kept its stale copy, and its next own updateConfig() wrote
  // that stale copy back over the user's choice (audit row ST-04).
  if (typeof merged.llamaGpuLayers === 'number') llamaConfig.gpuLayers = merged.llamaGpuLayers;
  if (typeof merged.llamaContextSize === 'number') {
    llamaConfig.contextSize = merged.llamaContextSize;
  }

  // Apply all Llama config changes through LlamaService to trigger proper notifications
  // skipSave: true because we're already in a save operation (settings are saved by the caller)
  /** @type {Record<string, any>|null} */
  let modelUpdate = null;
  if (llamaService && Object.keys(llamaConfig).length > 0) {
    const beforeConfig =
      typeof llamaService.getConfig === 'function'
        ? await llamaService.getConfig().catch(
            /** @type {(err: any) => any} */ (
              (err) => {
                logger.debug('[settings] getConfig failed', { error: err?.message });
                return null;
              }
            )
          )
        : null;
    const updateResult = await llamaService.updateConfig(llamaConfig, { skipSave: true });
    const afterConfig =
      typeof llamaService.getConfig === 'function'
        ? await llamaService.getConfig().catch(
            /** @type {(err: any) => any} */ (
              (err) => {
                logger.debug('[settings] getConfig failed', { error: err?.message });
                return null;
              }
            )
          )
        : null;

    /** @type {Record<string, any>} */
    const changed = {};
    for (const key of ['textModel', 'visionModel', 'embeddingModel']) {
      if (beforeConfig?.[key] && afterConfig?.[key] && beforeConfig[key] !== afterConfig[key]) {
        changed[key] = {
          from: beforeConfig[key],
          to: afterConfig[key]
        };
      }
    }

    modelUpdate = {
      requested: {
        textModel: llamaConfig.textModel,
        visionModel: llamaConfig.visionModel,
        embeddingModel: llamaConfig.embeddingModel
      },
      changed,
      selected: updateResult?.selected || null,
      modelDowngraded: Boolean(updateResult?.modelDowngraded)
    };

    logger.info('[SETTINGS] Applied Llama config update', {
      changedModelKeys: Object.keys(changed),
      modelDowngraded: modelUpdate.modelDowngraded,
      requestedEmbeddingModel: llamaConfig.embeddingModel,
      selectedEmbeddingModel: modelUpdate.selected?.embedding || afterConfig?.embeddingModel || null
    });

    if (modelUpdate.modelDowngraded) {
      logger.warn('[SETTINGS] Some requested model selections were adjusted', {
        requested: modelUpdate.requested,
        selected: modelUpdate.selected
      });
    }
  }

  if (typeof merged.launchOnStartup === 'boolean') {
    try {
      app.setLoginItemSettings({
        openAtLogin: merged.launchOnStartup
      });
    } catch (error) {
      logger.warn('[SETTINGS] Failed to set login item settings:', error.message);
    }
  }

  // Apply log verbosity immediately so a Settings change takes effect without a
  // restart. Driven by the persisted `loggingLevel` value.
  if (typeof merged.loggingLevel === 'string' && merged.loggingLevel.trim() !== '') {
    try {
      const { setGlobalLogLevel } = require('../../shared/logger');
      setGlobalLogLevel(merged.loggingLevel);
    } catch (error) {
      logger.warn('[SETTINGS] Failed to apply logging level:', error.message);
    }
  }

  // Mirror the auto-update preference so toggling it takes effect live: the
  // next periodic tick (and any future re-init) honors the new value. Manual
  // update checks are intentionally unaffected.
  if (typeof merged.autoUpdateCheck === 'boolean') {
    try {
      const { setAutoUpdateCheckEnabled } = require('../core/autoUpdater');
      setAutoUpdateCheckEnabled(merged.autoUpdateCheck);
    } catch (error) {
      logger.warn('[SETTINGS] Failed to apply autoUpdateCheck preference:', error.message);
    }
  }

  return modelUpdate;
}

/**
 * @param {Record<string, any>} merged
 * @param {{ logger: import('./ipcWrappers').LoggerLike, operation: string }} context
 * @returns {Promise<{ modelUpdate: Record<string, any>|null, warnings: string[], applySuccess: boolean, applyError: string|null }>}
 */
async function applySettingsToServicesSafely(merged, { logger, operation }) {
  try {
    const modelUpdate = await applySettingsToServices(merged, { logger });
    return {
      modelUpdate,
      warnings: [],
      applySuccess: true,
      applyError: null
    };
  } catch (error) {
    const warning = `Settings were saved, but some runtime updates could not be applied (${operation}): ${error.message}`;
    logger.error(`[SETTINGS] Runtime settings apply failed after persistence (${operation})`, {
      error: error?.message,
      stack: error?.stack
    });
    return {
      modelUpdate: null,
      warnings: [warning],
      applySuccess: false,
      applyError: error.message
    };
  }
}

/**
 * HIGH PRIORITY FIX (HIGH-14): Security validation for imported settings
 * Prevents prototype pollution, command injection, and data exfiltration
 * @param {Record<string, any>} settings - Imported settings object to validate
 * @param {import('./ipcWrappers').LoggerLike} logger - Logger instance
 * @returns {Record<string, any>} - Sanitized settings object
 * @throws {Error} - If validation fails
 */
/**
 * Settings whose values are filesystem paths. An export carries the paths of
 * the machine it came from; on another OS they fail validation, which used
 * to fail the whole import (audit row ST-06). They are dropped with a
 * warning instead, so the rest of the file imports and the current values
 * for these keys stay. vectorDbPersistPath joined the list when its
 * validator began accepting only a folder name under the app data
 * directory: exports from older builds (and from OramaVectorService, which
 * tolerated absolute values) carry an absolute path that failed the whole
 * import with "must be a folder name".
 */
const MACHINE_PATH_SETTINGS = [
  'defaultSmartFolderLocation',
  'lastBrowsedPath',
  'vectorDbPersistPath'
];

/**
 * @param {Record<string, any>} settings
 * @param {{ warn: Function, info: Function }} logger
 * @param {string[]} [warnings] collects user-facing warnings about dropped keys
 */
function validateImportedSettings(settings, logger, warnings = []) {
  if (!settings || typeof settings !== 'object') {
    throw new Error('Invalid settings: must be an object');
  }

  // Use centralized settings validation config
  const ALLOWED_SETTINGS_KEYS = SETTINGS_VALIDATION.allowedKeys;

  // Check for prototype pollution attempts using centralized config
  // Use Object.hasOwn to check own properties only, not prototype chain
  for (const key of PROTOTYPE_POLLUTION_KEYS) {
    if (Object.hasOwn(settings, key)) {
      throw new Error(`Security: Prototype pollution attempt detected (${key})`);
    }
  }

  // Recursive prototype-pollution scrub. The top-level key check above
  // covers `{__proto__: ...}` at the root, but values that are themselves
  // objects (e.g. `customCategoryRules`, smart-folder configs, downloads
  // exclusions) can still smuggle `__proto__` / `constructor` keys into
  // nested levels. Strip them at every depth so the final blob handed to
  // settingsService.save is safe to merge into runtime state.
  const MAX_SCRUB_DEPTH = 32;
  const MAX_NESTED_KEYS = 5000;
  const MAX_ARRAY_ITEMS = 10000;
  /**
   * @param {any} value
   * @param {number} [depth]
   * @returns {any}
   */
  const scrub = (value, depth = 0) => {
    if (depth > MAX_SCRUB_DEPTH) {
      throw new Error('Settings import nesting exceeds maximum depth');
    }
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ITEMS) {
        throw new Error(
          `Settings import array exceeds maximum length (${value.length} > ${MAX_ARRAY_ITEMS})`
        );
      }
      return value.map((item) => scrub(item, depth + 1));
    }
    /** @type {Record<string, any>} */
    const out = {};
    let keyCount = 0;
    for (const k of Object.keys(value)) {
      if (PROTOTYPE_POLLUTION_KEYS.includes(k)) {
        // Reject loudly rather than silently strip — this is an explicit
        // injection attempt; pretending it succeeded would mask the issue.
        throw new Error(`Security: Nested prototype pollution attempt detected (${k})`);
      }
      keyCount++;
      if (keyCount > MAX_NESTED_KEYS) {
        throw new Error('Settings import object exceeds maximum key count');
      }
      out[k] = scrub(value[k], depth + 1);
    }
    return out;
  };

  // Sanitize settings using whitelist approach
  /** @type {Record<string, any>} */
  const filtered = {};
  let ignoredCount = 0;

  for (const [key, value] of Object.entries(settings)) {
    // Skip unknown keys
    if (!ALLOWED_SETTINGS_KEYS.has(key)) {
      logger.warn(`[SETTINGS-IMPORT] Ignoring unknown key: ${key}`);
      ignoredCount++;
      continue;
    }
    filtered[key] = scrub(value);
  }

  if (ignoredCount > 0) {
    logger.info(`[SETTINGS-IMPORT] Ignored ${ignoredCount} unknown setting(s)`);
  }

  const normalized = { ...filtered };
  for (const key of MACHINE_PATH_SETTINGS) {
    if (normalized[key] === undefined || normalized[key] === null) continue;
    const rule = VALIDATION_RULES?.[key];
    if (
      rule &&
      typeof validateSetting === 'function' &&
      validateSetting(key, normalized[key], rule).length > 0
    ) {
      logger.warn(`[SETTINGS-IMPORT] Dropping ${key}: not valid on this computer`, {
        value: String(normalized[key]).slice(0, 200)
      });
      warnings.push(
        `${key} was not imported: "${String(normalized[key]).slice(0, 120)}" is not valid on this computer, so the current value was kept.`
      );
      delete normalized[key];
    }
  }
  // Validate without dropping invalid values so imports fail fast.
  const validation = validateSettings(normalized);

  if (!validation.valid) {
    const error = /** @type {Error & { validationErrors?: any, validationWarnings?: any }} */ (
      new Error(`Invalid settings: ${validation.errors.join('; ')}`)
    );
    error.validationErrors = validation.errors;
    error.validationWarnings = validation.warnings;
    throw error;
  }

  // Enforce schema validation for imported settings before sanitization.
  let validated = normalized;
  if (z && settingsSchema) {
    const parsed = settingsSchema.safeParse(normalized);
    if (!parsed.success) {
      const first = parsed.error?.issues?.[0];
      throw new Error(
        `Invalid settings file: ${first?.path?.join('.') || 'settings'} ${first?.message || 'failed validation'}`
      );
    }
    validated = parsed.data;
  }

  const enumChecks = {
    experienceMode: EXPERIENCE_MODE_VALUES,
    notificationMode: NOTIFICATION_MODES,
    namingConvention: NAMING_CONVENTIONS,
    caseConvention: CASE_CONVENTIONS,
    smartFolderRoutingMode: SMART_FOLDER_ROUTING_MODES
  };

  Object.entries(enumChecks).forEach(([key, allowed]) => {
    const value = validated?.[key];
    if (value === undefined || value === null) return;
    if (!Array.isArray(allowed) || allowed.length === 0) return;
    if (!allowed.includes(value)) {
      throw new Error(`Invalid settings: ${key} must be one of [${allowed.join(', ')}]`);
    }
  });

  const booleanKeys = [
    'launchOnStartup',
    'autoOrganize',
    'autoChunkOnAnalysis',
    'backgroundMode',
    'notifications',
    'notifyOnAutoAnalysis',
    'notifyOnLowConfidence',
    'autoUpdateCheck'
  ];
  booleanKeys.forEach((key) => {
    const value = validated?.[key];
    if (value === undefined || value === null) return;
    if (typeof value !== 'boolean') {
      throw new Error(`Invalid settings: ${key} must be a boolean`);
    }
  });

  if (validated?.loggingLevel !== undefined && validated?.loggingLevel !== null) {
    if (!LOGGING_LEVELS.includes(validated.loggingLevel)) {
      throw new Error(
        `Invalid settings: loggingLevel must be one of [${LOGGING_LEVELS.join(', ')}]`
      );
    }
  }

  const modelKeys = ['textModel', 'visionModel', 'embeddingModel'];
  modelKeys.forEach((key) => {
    const value = validated?.[key];
    if (value === undefined || value === null) return;
    if (typeof value !== 'string') {
      throw new Error(`Invalid settings: ${key} must be a string`);
    }
    if (value.length > MAX_MODEL_NAME_LENGTH || !MODEL_NAME_PATTERN.test(value)) {
      throw new Error(`Invalid settings: ${key} contains invalid characters`);
    }
  });

  if (validated?.separator !== undefined && validated?.separator !== null) {
    if (typeof validated.separator !== 'string' || !SEPARATOR_PATTERN.test(validated.separator)) {
      throw new Error('Invalid settings: separator contains invalid characters');
    }
  }

  if (validated?.confidenceThreshold !== undefined && validated?.confidenceThreshold !== null) {
    const value = validated.confidenceThreshold;
    if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || value > 1) {
      throw new Error('Invalid settings: confidenceThreshold must be between 0 and 1');
    }
  }

  if (validated?.maxConcurrentAnalysis !== undefined && validated?.maxConcurrentAnalysis !== null) {
    const value = validated.maxConcurrentAnalysis;
    if (!Number.isInteger(value) || value < 1 || value > 10) {
      throw new Error(
        'Invalid settings: maxConcurrentAnalysis must be an integer between 1 and 10'
      );
    }
  }

  const pathKeys = ['defaultSmartFolderLocation', 'lastBrowsedPath'];
  /** @type {Record<string, number>} */
  const pathLengthLimits = {
    defaultSmartFolderLocation: VALIDATION_RULES?.defaultSmartFolderLocation?.maxLength ?? 500,
    lastBrowsedPath: VALIDATION_RULES?.lastBrowsedPath?.maxLength ?? 1000
  };
  pathKeys.forEach((key) => {
    const value = validated?.[key];
    if (typeof value !== 'string' || value.trim().length === 0) return;
    const trimmed = value.trim();
    const maxLength = pathLengthLimits[key];
    if (Number.isInteger(maxLength) && trimmed.length > maxLength) {
      throw new Error(`Invalid settings: ${key} must be at most ${maxLength} characters`);
    }

    // Allow simple folder names for defaultSmartFolderLocation (validated earlier).
    if (key === 'defaultSmartFolderLocation' && !path.isAbsolute(trimmed)) {
      return;
    }

    const pathValidation = validateFileOperationPathSync(trimmed, null, {
      disallowUNC: false,
      ...(key === 'lastBrowsedPath' ? { requireAbsolute: true } : {})
    });
    if (!pathValidation.valid) {
      throw new Error(`Invalid settings: ${key} ${pathValidation.error}`);
    }
  });

  if (validation.warnings.length > 0) {
    logger.warn('[SETTINGS-IMPORT] Validation warnings', {
      warnings: validation.warnings
    });
  }

  return sanitizeSettings(validated);
}

/**
 * Internal helper to handle settings save logic
 * Extracted to avoid duplication between Zod and non-Zod code paths
 * @param {Record<string, any>} settings - Settings to save
 * @param {{ settingsService: Record<string, any>, onSettingsChanged: ((...args: any[]) => any)|null|undefined, logger: import('./ipcWrappers').LoggerLike }} deps - Dependencies
 * @returns {Promise<Record<string, any>>} IPC response
 */
async function handleSettingsSaveCore(settings, deps) {
  const { settingsService, onSettingsChanged, logger } = deps;

  try {
    const normalizedInput =
      settings && typeof settings === 'object' ? sanitizeSettings(settings) : {};
    const gated = await applyAiSettingsGate(normalizedInput, settingsService);
    if (gated.ok === false) {
      logger.warn('[SETTINGS] Rejected save: AI provider settings failed validation', {
        errorCode: gated.response.errorCode,
        error: gated.response.error
      });
      return gated.response;
    }
    const saveResult = await settingsService.save(gated.settings);
    const merged = saveResult.settings || saveResult; // Backward compatibility
    const validationWarnings = saveResult.validationWarnings || [];
    const runtimeApplyResult = await applySettingsToServicesSafely(merged, {
      logger,
      operation: 'save'
    });
    const combinedWarnings = [...validationWarnings, ...runtimeApplyResult.warnings];
    logger.info('[SETTINGS] Saved settings');

    // Invalidate notification service cache to ensure new settings take effect immediately
    // This prevents the 5-second TTL cache from causing stale notification behavior
    try {
      const { container, ServiceIds } = require('../services/ServiceContainer');
      if (container.has(ServiceIds.NOTIFICATION_SERVICE)) {
        const notificationService = container.resolve(ServiceIds.NOTIFICATION_SERVICE);
        if (notificationService?.invalidateCache) {
          notificationService.invalidateCache();
          logger.debug('[SETTINGS] Notification service cache invalidated');
        }
      }
    } catch (notifyErr) {
      // Non-fatal - notification service may not be initialized yet
      logger.debug('[SETTINGS] Could not invalidate notification cache:', notifyErr.message);
    }

    // Invalidate analysis limits cache so file size limits take effect immediately
    try {
      const { invalidateCache } = require('../analysis/analysisLimits');
      if (typeof invalidateCache === 'function') {
        invalidateCache();
        logger.debug('[SETTINGS] Analysis limits cache invalidated');
      }
    } catch (limitErr) {
      logger.debug('[SETTINGS] Could not invalidate analysis limits cache:', limitErr?.message);
    }

    // Enhanced settings propagation with error logging
    let propagationSuccess = true;
    try {
      if (typeof onSettingsChanged === 'function') {
        await onSettingsChanged(merged, {
          source: 'ipc-save',
          timestamp: Date.now()
        });
        logger.info('[SETTINGS] Settings change notification sent successfully');
      } else if (onSettingsChanged !== undefined && onSettingsChanged !== null) {
        logger.warn('[SETTINGS] onSettingsChanged is not a function:', typeof onSettingsChanged);
      }
    } catch (error) {
      propagationSuccess = false;
      logger.error('[SETTINGS] Settings change notification failed:', error);
    }

    return {
      success: true,
      settings: merged,
      modelUpdate: runtimeApplyResult.modelUpdate,
      propagationSuccess,
      runtimeApplySuccess: runtimeApplyResult.applySuccess,
      runtimeApplyError: runtimeApplyResult.applyError,
      validationWarnings: combinedWarnings
    };
  } catch (error) {
    // SettingsService now hard-rejects save() during shutdown. Treat that as
    // a benign "the user is leaving" no-op rather than a loud error: log at
    // debug, return success=false but with a typed code so the renderer can
    // suppress the "save failed" toast on the last save attempt at quit.
    if (error && error.code === 'SETTINGS_SHUTDOWN') {
      logger.debug('[SETTINGS] Save skipped: service shutting down');
      return {
        success: false,
        error: error.message,
        errorCode: 'SETTINGS_SHUTDOWN'
      };
    }
    logger.error('Failed to save settings:', error);

    /** @type {Record<string, any>} */
    const response = {
      success: false,
      error: error.message
    };

    if (error.validationErrors) {
      response.validationErrors = error.validationErrors;
    }
    if (error.validationWarnings) {
      response.validationWarnings = error.validationWarnings;
    }

    return response;
  }
}

/**
 * @param {IpcServiceContext|Record<string, any>} servicesOrParams - Service context or legacy parameters
 */
function registerSettingsIpc(servicesOrParams) {
  let container;
  if (servicesOrParams instanceof IpcServiceContext) {
    container = servicesOrParams;
  } else {
    container = createFromLegacyParams(servicesOrParams);
  }

  const { ipcMain, IPC_CHANNELS, logger } = container.core;
  const { settingsService, onSettingsChanged } = container.settings;

  const context = 'Settings';
  // Fail closed: when Zod fails to load, validationSchemas exports fallback
  // validators that implement `safeParse` — the ipcWrappers createHandler
  // only rejects when a schema is supplied but lacks safeParse. Using the
  // exports unconditionally means settings IPC keeps validating (via the
  // fallback path) instead of silently skipping validation with `null`.
  const schemaVoid = z ? z.void() : validationSchemas.ipcVoidPayload;
  const schemaSettings = settingsSchema;
  const schemaBackupPath = backupPathSchema;

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SETTINGS.GET,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: async () => {
        try {
          const loaded = await settingsService.load();
          return loaded;
        } catch (error) {
          logger.error('Failed to get settings:', error);
          return { success: false, error: error.message, settings: {} };
        }
      }
    })
  );

  // Fixed: Add endpoint to get configurable limits
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SETTINGS.GET_CONFIGURABLE_LIMITS,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: async () => {
        try {
          const settings = await settingsService.load();
          return getConfigurableLimits(settings);
        } catch (error) {
          logger.error('Failed to get configurable limits:', error);
          return getConfigurableLimits({});
        }
      }
    })
  );

  // Dependencies for save handler (captured in closure)
  const saveDeps = {
    settingsService,
    onSettingsChanged,
    logger
  };

  /**
   * SECURITY: IPC-layer defense-in-depth validation for backup paths.
   * Ensures the resolved path is within the settings backup directory before
   * any service method is called.  The service layer also validates, but
   * checking at the IPC boundary prevents a compromised renderer from even
   * reaching service code with an out-of-bounds path.
   * @param {string} backupPath - The path supplied by the renderer
   * @returns {string|null} null when valid; an error message otherwise
   */
  function validateBackupPathWithinDir(backupPath) {
    if (!backupPath || typeof backupPath !== 'string') {
      return 'Invalid backup path: must be a non-empty string';
    }
    const backupDir = settingsService.backupDir;
    if (!backupDir) {
      return 'Cannot determine backup directory';
    }
    try {
      assertBackupPathContained(backupPath, backupDir);
    } catch {
      logger.warn(
        '[SETTINGS] Blocked backup path outside backup directory (potential path traversal)',
        {
          backupPath,
          backupDir
        }
      );
      return 'Invalid backup path: path is outside the backup directory';
    }
    return null;
  }

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SETTINGS.SAVE,
    createHandler({
      logger,
      context,
      schema: schemaSettings,
      handler: async (event, settings) => {
        void event;
        return handleSettingsSaveCore(settings, saveDeps);
      }
    })
  );

  // Fixed: Add config export handler
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SETTINGS.EXPORT,
    createHandler({
      logger,
      context,
      schema: validationSchemas?.ipcOptionalPayload,
      handler: async (event, exportPath) => {
        void event;
        try {
          // SECURITY: Ignore exportPath from renderer - always use dialog
          // This prevents path traversal attacks from compromised renderer
          if (exportPath) {
            logger.warn(
              '[SETTINGS] Export path provided via IPC is ignored for security. Using dialog instead.'
            );
          }

          const settings = await settingsService.load();

          // Create export data with metadata
          const exportData = {
            version: '1.0.0',
            exportDate: new Date().toISOString(),
            appVersion: app.getVersion(),
            settings
          };

          // Always show save dialog for security
          const result = await dialog.showSaveDialog({
            title: 'Export Settings',
            defaultPath: `stratosort-config-${new Date().toISOString().split('T')[0]}.json`,
            filters: [
              { name: 'JSON Files', extensions: ['json'] },
              { name: 'All Files', extensions: ['*'] }
            ]
          });

          if (result.canceled) {
            return canceledResponse();
          }

          const filePath = result.filePath;

          // Serialize export data with proper error handling
          let jsonContent;
          try {
            await new Promise((resolve) => setImmediate(resolve));
            jsonContent = JSON.stringify(exportData, null, 2);
          } catch (serializeError) {
            logger.error('[SETTINGS] Failed to serialize export data:', serializeError);
            throw new Error('Failed to serialize settings data for export', {
              cause: serializeError
            });
          }

          // Write export file. Random suffix prevents collision when two
          // writers fire in the same millisecond.
          const tempPath = `${filePath}.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
          try {
            await fs.writeFile(tempPath, jsonContent, 'utf8');
            await fs.rename(tempPath, filePath);
          } catch (writeError) {
            // Clean up temp file on failure
            try {
              await fs.unlink(tempPath);
            } catch {
              // Ignore cleanup errors
            }
            throw writeError;
          }

          logger.info('[SETTINGS] Exported settings to:', filePath);

          return successResponse({ path: filePath });
        } catch (error) {
          logger.error('[SETTINGS] Failed to export settings:', error);
          return errorResponse(error.message);
        }
      }
    })
  );

  // Fixed: Add config import handler
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SETTINGS.IMPORT,
    createHandler({
      logger,
      context,
      schema: validationSchemas?.ipcOptionalPayload,
      handler: async (event, importPath) => {
        void event;
        try {
          // SECURITY: Ignore importPath from renderer - always use dialog
          // This prevents path traversal attacks from compromised renderer
          // (matches the pattern used by the EXPORT handler)
          if (importPath) {
            logger.warn(
              '[SETTINGS] Import path provided via IPC is ignored for security. Using dialog instead.'
            );
          }

          const result = await dialog.showOpenDialog({
            title: 'Import Settings',
            filters: [
              { name: 'JSON Files', extensions: ['json'] },
              { name: 'All Files', extensions: ['*'] }
            ],
            properties: ['openFile']
          });

          if (result.canceled) {
            return canceledResponse();
          }

          if (!result.filePaths || result.filePaths.length === 0) {
            return canceledResponse();
          }
          const filePath = result.filePaths[0];

          const MAX_IMPORT_SIZE = 1 * 1024 * 1024; // 1MB limit for settings files
          const fileHandle = await fs.open(filePath, 'r');
          let fileContent;
          try {
            const stats = await fileHandle.stat();
            if (stats.size > MAX_IMPORT_SIZE) {
              throw new Error(
                `Import file too large (${Math.round(stats.size / 1024)}KB). Maximum size is 1MB.`
              );
            }

            const buffer = Buffer.alloc(stats.size);
            const { bytesRead } = await fileHandle.read(buffer, 0, stats.size, 0);
            const statsAfter = await fileHandle.stat();
            if (statsAfter.size > MAX_IMPORT_SIZE || bytesRead > MAX_IMPORT_SIZE) {
              throw new Error('Import file size changed during read. Please try again.');
            }

            // Read and parse import file
            fileContent = buffer.slice(0, bytesRead).toString('utf8');
          } finally {
            try {
              await fileHandle.close();
            } catch {
              /* ignore */
            }
          }

          // DoS-hardening: run the JSON parse inside a short-lived worker
          // thread with a hard timeout. The file size is already capped at
          // 1 MB upstream, but a pathological payload (deep nesting, huge
          // string leaves) can still push V8's parser into >10ms
          // territory on low-end hardware — which translates to a stalled
          // Electron main thread, frozen window, and missed splash
          // heartbeat. The worker isolates that cost and hard-fails on
          // timeout instead of hanging the app.
          const parseResult = /** @type {{ ok: boolean, value?: any, error?: string }} */ (
            await parseSettingsImportJson(fileContent)
          );
          if (!parseResult.ok) {
            throw new Error(`Invalid JSON in settings file: ${parseResult.error}`);
          }
          const importData = parseResult.value;

          // Validate import data structure
          if (!importData.settings || typeof importData.settings !== 'object') {
            throw new Error('Invalid settings file: missing or invalid settings object');
          }

          // Same schema-version policy as SettingsBackupService.restoreFromBackup:
          // fail-closed on files from a newer app build (this build can't
          // safely interpret them), and preserve an older/absent stamp so
          // SettingsMigrator re-runs the migration chain (including the
          // one-time v3 legacy Simple-mode value flip) on the next launch.
          // Without this, importing a pre-v3 export saved legacy values
          // stamped as current and permanently skipped their migration.
          const importedSchemaVersion = Number(importData.settings?.settingsSchemaVersion);
          if (
            Number.isFinite(importedSchemaVersion) &&
            importedSchemaVersion > SETTINGS_SCHEMA_VERSION
          ) {
            throw new Error(
              `Settings file is from a newer app version (settingsSchemaVersion=${importedSchemaVersion}, ` +
                `current=${SETTINGS_SCHEMA_VERSION}). Upgrade the app before importing it.`
            );
          }

          // Sanitize and validate imported settings
          // Prevents prototype pollution, command injection, and data exfiltration
          /** @type {string[]} */
          const importWarnings = [];
          let sanitizedSettings = validateImportedSettings(
            importData.settings,
            logger,
            importWarnings
          );
          if (!Object.prototype.hasOwnProperty.call(importData.settings || {}, 'experienceMode')) {
            sanitizedSettings = {
              ...sanitizedSettings,
              experienceMode: EXPERIENCE_MODES.ADVANCED
            };
          }
          sanitizedSettings = applyExperienceModeSettings(sanitizedSettings);
          if (
            !Number.isFinite(importedSchemaVersion) ||
            importedSchemaVersion < SETTINGS_SCHEMA_VERSION
          ) {
            sanitizedSettings = {
              ...sanitizedSettings,
              // Absent stamp means the export predates versioning — v1.
              settingsSchemaVersion: Number.isFinite(importedSchemaVersion)
                ? importedSchemaVersion
                : 1
            };
          }

          const gated = await applyAiSettingsGate(sanitizedSettings, settingsService);
          if (gated.ok === false) {
            logger.warn(
              '[SETTINGS-IMPORT] Rejected import: AI provider settings failed validation',
              {
                errorCode: gated.response.errorCode,
                error: gated.response.error
              }
            );
            return gated.response;
          }

          const saveResult = await settingsService.save(gated.settings);
          const merged = saveResult.settings || saveResult;
          const validationWarnings = saveResult.validationWarnings || [];

          // Apply settings using shared helper
          const runtimeApplyResult = await applySettingsToServicesSafely(merged, {
            logger,
            operation: 'import'
          });

          // Notify settings changed
          if (typeof onSettingsChanged === 'function') {
            await onSettingsChanged(merged, {
              source: 'ipc-import',
              timestamp: Date.now()
            });
          }

          logger.info('[SETTINGS] Imported settings from:', filePath);

          return successResponse(
            {
              settings: merged,
              runtimeApplySuccess: runtimeApplyResult.applySuccess,
              runtimeApplyError: runtimeApplyResult.applyError,
              importInfo: {
                version: importData.version,
                exportDate: importData.exportDate,
                appVersion: importData.appVersion
              }
            },
            [...importWarnings, ...validationWarnings, ...runtimeApplyResult.warnings]
          );
        } catch (error) {
          logger.error('[SETTINGS] Failed to import settings:', error);
          return errorResponse(error.message);
        }
      }
    })
  );

  // Fixed: Add backup management handlers
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SETTINGS.CREATE_BACKUP,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: async () => {
        try {
          // User-initiated: a manual backup, outside the automatic rotation.
          const result = await settingsService.createBackup({ kind: 'manual' });
          if (result.success) {
            logger.info('[SETTINGS] Backup created:', result.path);
            return successResponse({ path: result.path, timestamp: result.timestamp });
          }
          return errorResponse(result.error || 'Unknown backup error');
        } catch (error) {
          logger.error('[SETTINGS] Failed to create backup:', error);
          return errorResponse(error.message);
        }
      }
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SETTINGS.LIST_BACKUPS,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: async () => {
        try {
          const backups = await settingsService.listBackups();
          return successResponse({ backups });
        } catch (error) {
          logger.error('[SETTINGS] Failed to list backups:', error);
          return errorResponse(error.message, { backups: [] });
        }
      }
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SETTINGS.RESTORE_BACKUP,
    createHandler({
      logger,
      context,
      schema: schemaBackupPath,
      handler: async (event, backupPath) => {
        void event;
        try {
          // SECURITY: Validate backup path is within backup directory (defense-in-depth)
          const pathError = validateBackupPathWithinDir(backupPath);
          if (pathError) {
            return errorResponse(pathError);
          }

          // The `ai` blob in a backup is held to the same gate as a save or
          // an import, before the file is written: a backup edited by hand
          // cannot point a bearer key at an arbitrary host or route documents
          // to the cloud without the consent the user gave this install.
          /** @type {Record<string, any>|null} */
          let gateRefusal = null;
          /** @type {Record<string, any>|null} */
          let gatedSettings = null;
          const result = await settingsService.restoreFromBackup(backupPath, {
            beforeWrite: async (/** @type {Record<string, any>} */ restored) => {
              const gated = await applyAiSettingsGate(restored, settingsService);
              if (gated.ok === false) {
                gateRefusal = gated.response;
                throw new Error(gated.response.error || 'Restored AI settings were refused');
              }
              gatedSettings = gated.settings;
              return gated.settings;
            }
          });
          if (gateRefusal) {
            logger.warn('[SETTINGS] Backup restore refused by the AI settings gate', {
              backupPath,
              errorCode: gateRefusal.errorCode
            });
            return gateRefusal;
          }

          if (result.success) {
            // Apply restored settings using shared helper
            const merged = gatedSettings || result.settings;

            const runtimeApplyResult = await applySettingsToServicesSafely(merged, {
              logger,
              operation: 'restore'
            });

            // Notify settings changed
            if (typeof onSettingsChanged === 'function') {
              await onSettingsChanged(merged, {
                source: 'ipc-restore',
                timestamp: Date.now()
              });
            }

            logger.info('[SETTINGS] Restored from backup:', backupPath);
            return successResponse(
              {
                settings: merged,
                restoredFrom: result.restoredFrom,
                runtimeApplySuccess: runtimeApplyResult.applySuccess,
                runtimeApplyError: runtimeApplyResult.applyError
              },
              [...(result.validationWarnings || []), ...runtimeApplyResult.warnings]
            );
          }

          return errorResponse(result.error || 'Unknown restore error', {
            validationErrors: result.validationErrors
          });
        } catch (error) {
          logger.error('[SETTINGS] Failed to restore backup:', error);
          return errorResponse(error.message);
        }
      }
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SETTINGS.DELETE_BACKUP,
    createHandler({
      logger,
      context,
      schema: schemaBackupPath,
      handler: async (event, backupPath) => {
        void event;
        try {
          // SECURITY: Validate backup path is within backup directory (defense-in-depth)
          const pathError = validateBackupPathWithinDir(backupPath);
          if (pathError) {
            return errorResponse(pathError);
          }

          const result = await settingsService.deleteBackup(backupPath);
          if (result.success) {
            logger.info('[SETTINGS] Deleted backup:', backupPath);
            return successResponse();
          }
          return errorResponse(result.error || 'Unknown delete error');
        } catch (error) {
          logger.error('[SETTINGS] Failed to delete backup:', error);
          return errorResponse(error.message);
        }
      }
    })
  );

  // ---- Troubleshooting helpers ----
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SETTINGS.GET_LOGS_INFO,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: async () => {
        const logsDir = path.join(app.getPath('userData'), 'logs');
        return successResponse({
          logsDir,
          appVersion: app.getVersion(),
          platform: process.platform,
          arch: process.arch
        });
      }
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SETTINGS.OPEN_LOGS_FOLDER,
    createHandler({
      logger,
      context,
      schema: schemaVoid,
      handler: async () => {
        const logsDir = path.join(app.getPath('userData'), 'logs');
        try {
          await fs.mkdir(logsDir, { recursive: true });
        } catch (mkdirErr) {
          logger.warn('[SETTINGS] Failed to ensure logs directory exists:', mkdirErr?.message);
        }

        const result = await shell.openPath(logsDir);
        if (typeof result === 'string' && result.length > 0) {
          logger.warn('[SETTINGS] Failed to open logs folder:', { logsDir, error: result });
          return errorResponse(`Failed to open logs folder: ${result}`);
        }

        logger.info('[SETTINGS] Opened logs folder:', logsDir);
        return successResponse({ logsDir });
      }
    })
  );
}

module.exports = registerSettingsIpc;
