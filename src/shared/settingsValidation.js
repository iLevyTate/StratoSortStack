// @ts-check
/**
 * Settings Validation
 * Validates user settings to prevent invalid configurations
 */

const path = require('path');
const { createLogger } = require('./logger');
const { DEFAULT_SETTINGS } = require('./defaultSettings');

const logger = createLogger('SettingsValidation');
const { CUSTOM_PERSONA_LIMITS, sanitizeCustomPersonas } = require('./chatPersonas');
const { PROTOTYPE_POLLUTION_KEYS } = require('./securityConfig');
const {
  LENIENT_URL_PATTERN,
  LOGGING_LEVELS,
  NUMERIC_LIMITS,
  MODEL_NAME_PATTERN,
  MAX_MODEL_NAME_LENGTH,
  NOTIFICATION_MODES,
  NAMING_CONVENTIONS,
  CASE_CONVENTIONS,
  SMART_FOLDER_ROUTING_MODES,
  SEPARATOR_PATTERN
} = require('./validationConstants');
const { validateFileOperationPathSync } = require('./pathSanitization');
// URL utilities available via require('./urlUtils') when needed
const { isValidEmbeddingModel } = require('./modelCategorization');
const { EXPERIENCE_MODE_VALUES, SIMPLE_MODE_ENFORCED_VALUES } = require('./experienceMode');
const { sanitizeExclusionGlobs } = require('./config/exclusionRulesSchema');

/**
 * Shared URL validation regex (from validationConstants)
 * Matches URLs with optional protocol (http/https), hostname/IP, optional port, optional path
 * Examples: "localhost:3000", "http://127.0.0.1:3000", "https://example.com/api"
 */
const URL_PATTERN = LENIENT_URL_PATTERN;

const WINDOWS_DRIVE_ABSOLUTE_PATTERN = /^[a-zA-Z]:[\\/]/;
const WINDOWS_DRIVE_ONLY_PATTERN = /^[A-Za-z]:$/;
const UNC_PATH_PATTERN = /^\\\\/;
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const TRAVERSAL_SEGMENT_PATTERN = /(^|[\\/])\.\.([\\/]|$)/;

const hasPathAbsolute = Boolean(path && typeof path.isAbsolute === 'function');
const hasWin32Absolute = Boolean(path && path.win32 && typeof path.win32.isAbsolute === 'function');

const isWindowsAbsolutePathLike = (/** @type {string} */ value) =>
  WINDOWS_DRIVE_ABSOLUTE_PATTERN.test(value) || UNC_PATH_PATTERN.test(value);

const isAbsolutePathLike = (/** @type {any} */ value) => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (hasPathAbsolute && path.isAbsolute(trimmed)) return true;
  if (hasWin32Absolute && path.win32.isAbsolute(trimmed)) return true;
  return isWindowsAbsolutePathLike(trimmed) || trimmed.startsWith('/');
};

const isSafeWindowsAbsoluteFallback = (/** @type {string} */ value) => {
  if (!isWindowsAbsolutePathLike(value)) return false;
  if (URL_SCHEME_PATTERN.test(value)) return false;
  if (WINDOWS_DRIVE_ONLY_PATTERN.test(value)) return false;
  if (TRAVERSAL_SEGMENT_PATTERN.test(value)) return false;
  // The colon in "C:" was matching the invalid-char regex, rejecting all Windows paths.
  const pathAfterDrive = value.replace(/^[a-zA-Z]:/, '');
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\x00-\x1f]/.test(pathAfterDrive)) return false;
  return true;
};

const isSafeAbsolutePath = (/** @type {any} */ value) => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;

  const isWindowsLike = isWindowsAbsolutePathLike(trimmed);
  if (hasPathAbsolute && (!isWindowsLike || hasWin32Absolute)) {
    const validation = validateFileOperationPathSync(trimmed, null, {
      requireAbsolute: true,
      disallowUNC: false,
      disallowUrlSchemes: true,
      allowFileUrl: false
    });
    return validation.valid;
  }

  if (isWindowsLike && !hasWin32Absolute) {
    return isSafeWindowsAbsoluteFallback(trimmed);
  }

  if (!hasPathAbsolute && trimmed.startsWith('/')) {
    if (URL_SCHEME_PATTERN.test(trimmed)) return false;
    if (TRAVERSAL_SEGMENT_PATTERN.test(trimmed)) return false;
    return true;
  }

  return false;
};

// A single folder name: no separators, no traversal, no drive letter, not
// absolute and not a network path. Used where the value is resolved under
// userData and must never point anywhere else.
const isSafeRelativeFolderName = (/** @type {any} */ value) => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (isAbsolutePathLike(trimmed)) return false;
  if (WINDOWS_DRIVE_ONLY_PATTERN.test(trimmed)) return false;
  if (trimmed.includes('..')) return false;
  if (/[\\/]/.test(trimmed)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\x00-\x1f]/.test(trimmed)) return false;
  return true;
};

const isSafeDefaultLocation = (/** @type {any} */ value) => {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (isAbsolutePathLike(trimmed)) {
    return isSafeAbsolutePath(trimmed);
  }
  return isSafeRelativeFolderName(trimmed);
};

const DEPRECATED_SETTINGS_KEYS = new Set([
  'dependencyWizardShown',
  'dependencyWizardLastPromptAt',
  'dependencyWizardPromptIntervalDays',
  // Legacy Ollama/ChromaDB keys (replaced by in-process node-llama-cpp + Orama)
  'ollamaHost',
  'autoUpdateOllama',
  'autoUpdateChromaDb',
  'enableChromaLearningSync',
  'enableChromaLearningDryRun',
  // Removed in the settings-wiring audit: no consumer / superseded by
  // type-specific limits. Listed here so stale on-disk values are dropped
  // silently (without an "unknown key" warning) on the next save.
  'language', // no i18n system
  'cacheSize', // no cache consumer
  'maxFileSize', // superseded by maxImage/Document/TextFileSize gates
  'analysisTimeout', // analysis timeout is governed by the batch orchestrator
  'fileOperationTimeout', // file-op timeouts are governed internally
  'maxBatchSize', // batch sizing is governed by the batch orchestrator
  'retryAttempts' // retry policy is governed internally
]);

/**
 * @typedef {{
 *   type?: string,
 *   required?: boolean,
 *   min?: number,
 *   max?: number,
 *   integer?: boolean,
 *   minLength?: number,
 *   maxLength?: number,
 *   enum?: readonly string[],
 *   pattern?: RegExp,
 *   validator?: (value: any) => boolean,
 *   validatorMessage?: string,
 *   sanitizer?: (value: any) => any
 * }} ValidationRule
 */

/**
 * Validation rules for settings
 * @type {Record<string, ValidationRule>}
 */
const VALIDATION_RULES = {
  notifications: {
    type: 'boolean',
    required: false
  },
  experienceMode: {
    type: 'string',
    enum: EXPERIENCE_MODE_VALUES,
    required: false
  },
  defaultSmartFolderLocation: {
    type: 'string',
    minLength: 1,
    maxLength: 500,
    validator: isSafeDefaultLocation,
    validatorMessage: 'defaultSmartFolderLocation must be an absolute path or a simple folder name',
    required: false
  },
  lastBrowsedPath: {
    type: 'string',
    maxLength: 1000,
    validator: isSafeAbsolutePath,
    validatorMessage: 'lastBrowsedPath must be an absolute, safe local path',
    required: false
  },
  autoConcurrency: {
    type: 'boolean',
    required: false
  },
  maxConcurrentAnalysis: {
    type: 'number',
    min: 1,
    max: 10,
    integer: true,
    required: false
  },
  autoOrganize: {
    type: 'boolean',
    required: false
  },
  developerGraphEnabled: {
    type: 'boolean',
    required: false
  },
  autoChunkOnAnalysis: {
    type: 'boolean',
    required: false
  },
  graphExpansionEnabled: {
    type: 'boolean',
    required: false
  },
  graphExpansionWeight: {
    type: 'number',
    min: 0,
    max: 1,
    required: false
  },
  graphExpansionMaxNeighbors: {
    type: 'number',
    min: 10,
    max: 500,
    integer: true,
    required: false
  },
  chunkContextEnabled: {
    type: 'boolean',
    required: false
  },
  chunkContextMaxNeighbors: {
    type: 'number',
    min: 0,
    max: 3,
    integer: true,
    required: false
  },
  backgroundMode: {
    type: 'boolean',
    required: false
  },
  launchOnStartup: {
    type: 'boolean',
    required: false
  },
  confidenceThreshold: {
    type: 'number',
    min: 0,
    max: 1,
    required: false
  },
  smartFolderRoutingMode: {
    type: 'string',
    enum: SMART_FOLDER_ROUTING_MODES,
    required: false
  },
  namingConvention: {
    type: 'string',
    enum: NAMING_CONVENTIONS,
    required: false
  },
  dateFormat: {
    type: 'string',
    maxLength: 20,
    required: false
  },
  caseConvention: {
    type: 'string',
    enum: CASE_CONVENTIONS,
    required: false
  },
  separator: {
    type: 'string',
    maxLength: 1,
    required: false,
    // Allow only common filename separators
    pattern: SEPARATOR_PATTERN
  },
  textModel: {
    type: 'string',
    minLength: 1,
    maxLength: MAX_MODEL_NAME_LENGTH,
    pattern: MODEL_NAME_PATTERN,
    required: false
  },
  visionModel: {
    type: 'string',
    minLength: 1,
    maxLength: MAX_MODEL_NAME_LENGTH,
    pattern: MODEL_NAME_PATTERN,
    required: false
  },
  embeddingModel: {
    type: 'string',
    minLength: 1,
    maxLength: MAX_MODEL_NAME_LENGTH,
    pattern: MODEL_NAME_PATTERN,
    required: false,
    // Pattern-based validation using modelCategorization.js
    // NOTE: changing models requires re-embedding (dimension mismatch)
    // Common models: embeddinggemma (768), mxbai-embed-large (1024), nomic-embed-text (768)
    validator: isValidEmbeddingModel,
    validatorMessage:
      'embeddingModel must be a valid embedding model (e.g., embeddinggemma, mxbai-embed-large, nomic-embed-text)'
  },
  // First-run consent flag: suppresses background model auto-download when true
  modelAutoDownloadSkipped: {
    type: 'boolean',
    required: false
  },
  llamaGpuLayers: {
    type: 'number',
    min: NUMERIC_LIMITS.llamaGpuLayers.min,
    max: NUMERIC_LIMITS.llamaGpuLayers.max,
    integer: true,
    required: false
  },
  llamaContextSize: {
    type: 'number',
    min: NUMERIC_LIMITS.llamaContextSize.min,
    max: NUMERIC_LIMITS.llamaContextSize.max,
    integer: true,
    required: false
  },
  // Resolved under userData by OramaVectorService; an absolute or network
  // value would move the index off the app data directory, so only a folder
  // name is accepted.
  vectorDbPersistPath: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    validator: isSafeRelativeFolderName,
    validatorMessage:
      'vectorDbPersistPath must be a folder name under the app data directory (no absolute or network paths)',
    required: false
  },
  embeddingTiming: {
    type: 'string',
    enum: ['during_analysis', 'after_organize', 'manual'],
    required: false
  },
  defaultEmbeddingPolicy: {
    type: 'string',
    enum: ['embed', 'skip', 'web_only'],
    required: false
  },
  embeddingScope: {
    type: 'string',
    enum: ['all_analyzed', 'smart_folders_only'],
    required: false
  },
  chatPersona: {
    type: 'string',
    // No `enum`: user-defined personas can introduce new ids dynamically
    // (e.g. `custom:my-persona`), and the validator can't see the
    // sibling `customChatPersonas` field reliably. Resolution-time
    // fallback in chatPersonas.getChatPersonaOrDefault handles unknown
    // ids gracefully by reverting to the default persona.
    maxLength: 128,
    required: false
  },
  // Free-text override that's appended to the selected persona's guidance
  // when ChatService builds a prompt. Capped at 2 KB so it can't be used
  // to balloon the prompt-budget envelope unintentionally; the chat
  // pipeline already enforces stricter per-section caps downstream.
  chatPersonaCustomGuidance: {
    type: 'string',
    maxLength: 2048,
    required: false
  },
  // Global free-text organization instructions injected into the analysis and
  // suggestion prompts. Same 2 KB cap as chat guidance to keep prompt budget
  // bounded.
  organizationCustomGuidance: {
    type: 'string',
    maxLength: 2048,
    required: false
  },
  // User-defined chat personas. Each entry is sanitized by
  // chatPersonas.sanitizeCustomPersona — malformed rows drop silently
  // so one bad row can't lock the user out of the rest. Hard-cap of
  // 20 personas / 2 KB guidance each to keep settings.json bounded.
  customChatPersonas: {
    type: 'object', // arrays are typeof 'object'
    validator: (value) => {
      if (value === undefined || value === null) return true;
      if (!Array.isArray(value)) return false;
      return value.length <= CUSTOM_PERSONA_LIMITS.MAX_COUNT;
    },
    validatorMessage:
      'customChatPersonas must be an array of {id, label, guidance, description?} entries (max 20)',
    sanitizer: (value) => sanitizeCustomPersonas(value),
    required: false
  },
  chatResponseMode: {
    type: 'string',
    enum: ['fast', 'deep'],
    required: false
  },
  maxImageFileSize: {
    type: 'number',
    min: 1024 * 1024, // 1MB minimum
    max: 500 * 1024 * 1024, // 500MB maximum
    integer: true,
    required: false
  },
  maxDocumentFileSize: {
    type: 'number',
    min: 1024 * 1024, // 1MB minimum
    max: 500 * 1024 * 1024, // 500MB maximum
    integer: true,
    required: false
  },
  maxTextFileSize: {
    type: 'number',
    min: 1024 * 1024, // 1MB minimum
    max: 200 * 1024 * 1024, // 200MB maximum
    integer: true,
    required: false
  },
  workflowRestoreMaxAge: {
    type: 'number',
    min: NUMERIC_LIMITS.workflowRestoreMaxAge.min,
    max: NUMERIC_LIMITS.workflowRestoreMaxAge.max,
    integer: true,
    required: false
  },
  saveDebounceMs: {
    type: 'number',
    min: NUMERIC_LIMITS.saveDebounceMs.min,
    max: NUMERIC_LIMITS.saveDebounceMs.max,
    integer: true,
    required: false
  },
  // Additional settings from securityConfig.allowedKeys
  loggingLevel: {
    type: 'string',
    enum: LOGGING_LEVELS,
    required: false
  },
  autoUpdateCheck: {
    type: 'boolean',
    required: false
  },
  // Notification settings
  notificationMode: {
    type: 'string',
    enum: NOTIFICATION_MODES,
    required: false
  },
  notifyOnAutoAnalysis: {
    type: 'boolean',
    required: false
  },
  notifyOnLowConfidence: {
    type: 'boolean',
    required: false
  },
  // Live opt-out for smart-folder watching (read by simple-main.js on every
  // settings save; Settings → Auto-organize exposes it).
  smartFolderWatchEnabled: {
    type: 'boolean',
    required: false
  },
  // Vision captions for video keyframes during media analysis (Settings →
  // Processing limits). Off by default because of the per-video cost.
  captionVideoKeyframes: {
    type: 'boolean',
    required: false
  },
  // Advanced-mode values parked while Simple mode is on (see
  // experienceMode.carryAdvancedValuesAcrossModeSwitch). A plain object whose
  // keys are a subset of SIMPLE_MODE_ENFORCED_VALUES, each value valid under
  // that key's own rule. Internal-only; no Settings UI.
  advancedModeValues: {
    type: 'object',
    validator: (value) => {
      if (value === null || value === undefined) return true;
      if (typeof value !== 'object' || Array.isArray(value)) return false;
      return Object.entries(value).every(([key, entry]) => {
        if (!Object.prototype.hasOwnProperty.call(SIMPLE_MODE_ENFORCED_VALUES, key)) return false;
        const rule = VALIDATION_RULES[key];
        return Boolean(rule) && validateSetting(key, entry, rule).length === 0;
      });
    },
    validatorMessage:
      'advancedModeValues must be an object holding valid values for the Simple-mode enforced keys only',
    sanitizer: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      /** @type {Record<string, any>} */
      const out = {};
      for (const key of Object.keys(SIMPLE_MODE_ENFORCED_VALUES)) {
        if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = value[key];
      }
      return Object.keys(out).length > 0 ? out : null;
    },
    required: false
  },
  // Downloads Triage user exclusion globs. Previously this key was absent from
  // VALIDATION_RULES, so sanitizeSettings() dropped it on every load/save and
  // the user's globs never reached disk. The sanitizer trims/dedupes/caps the
  // list (shared with the live DownloadWatcher path) so the stored value is
  // always normalized.
  downloadsTriageExclusions: {
    type: 'object', // arrays are typeof 'object'
    // Lenient validator (array + DoS-bounded length) paired with a sanitizer
    // that trims/dedupes/drops bad entries — mirrors customChatPersonas. A
    // strict per-entry validator here would reject the whole list when a single
    // blank glob slips in, defeating the point of having a sanitizer.
    validator: (value) => {
      if (value === undefined || value === null) return true;
      return Array.isArray(value) && value.length <= 1000;
    },
    validatorMessage: 'downloadsTriageExclusions must be an array of glob strings',
    sanitizer: (value) => sanitizeExclusionGlobs(value) || [],
    required: false
  },
  // AI provider configuration blob (providers/routing/consent). Deep
  // validation lives in the main process: AI_PROVIDER.* handlers validate
  // their own payloads, and the settings save/import paths validate the merged
  // blob via main/services/ai/aiSettings.validateAiSettingsForSave. This
  // shared module only guards the top-level shape so sanitizeSettings()
  // preserves the blob instead of dropping it as an unknown key — without it,
  // every provider/routing/consent choice was silently reset on restart.
  ai: {
    type: 'object',
    validator: (value) => {
      if (value === undefined || value === null) return true;
      if (typeof value !== 'object' || Array.isArray(value)) return false;
      const isOptionalObject = (/** @type {any} */ section) =>
        section === undefined ||
        (typeof section === 'object' && section !== null && !Array.isArray(section));
      return (
        isOptionalObject(value.providers) &&
        isOptionalObject(value.routing) &&
        isOptionalObject(value.consent)
      );
    },
    validatorMessage: 'ai must be an object with optional providers/routing/consent objects',
    required: false
  },
  // Internal schema version for settings migrations
  settingsSchemaVersion: {
    type: 'number',
    min: 1,
    integer: true,
    required: false
  }

  // Learning/Feedback dual-write settings removed with legacy stack
};

/**
 * Validate a single setting value
 * @param {string} key
 * @param {any} value
 * @param {ValidationRule} rule
 * @returns {string[]}
 */
function validateSetting(key, value, rule) {
  const errors = [];

  // Type validation
  if (rule.type && typeof value !== rule.type) {
    errors.push(`${key} must be of type ${rule.type}, got ${typeof value}`);
    return errors;
  }

  // Custom validator function (takes precedence over enum)
  if (rule.validator && typeof rule.validator === 'function') {
    if (!rule.validator(value)) {
      const message = rule.validatorMessage || `${key} failed custom validation`;
      errors.push(message);
    }
  }
  // Enum validation (only if no custom validator)
  else if (rule.enum && !rule.enum.includes(value)) {
    errors.push(`${key} must be one of [${rule.enum.join(', ')}], got "${value}"`);
  }

  // Number validations
  if (rule.type === 'number') {
    if (rule.min !== undefined && value < rule.min) {
      errors.push(`${key} must be at least ${rule.min}, got ${value}`);
    }
    if (rule.max !== undefined && value > rule.max) {
      errors.push(`${key} must be at most ${rule.max}, got ${value}`);
    }
    if (rule.integer && !Number.isInteger(value)) {
      errors.push(`${key} must be an integer, got ${value}`);
    }
  }

  // String validations
  if (rule.type === 'string') {
    if (rule.minLength !== undefined && value.length < rule.minLength) {
      errors.push(`${key} must be at least ${rule.minLength} characters, got ${value.length}`);
    }
    if (rule.maxLength !== undefined && value.length > rule.maxLength) {
      errors.push(`${key} must be at most ${rule.maxLength} characters, got ${value.length}`);
    }
    if (rule.pattern && !rule.pattern.test(value)) {
      errors.push(`${key} does not match the required pattern: ${rule.pattern}`);
    }
  }

  return errors;
}

/**
 * Validate settings object
 * @param {Record<string, any>} settings
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateSettings(settings) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  if (!settings || typeof settings !== 'object') {
    errors.push('Settings must be an object');
    return { valid: false, errors, warnings };
  }

  // Explicitly detect prototype-pollution keys even if they are not enumerable
  // The 'in' operator returns true for '__proto__' on ANY object since it's inherited
  const hasUnsafeProto = Object.prototype.hasOwnProperty.call(settings, '__proto__');
  const hasUnsafeCtor =
    Object.prototype.hasOwnProperty.call(settings, 'constructor') &&
    settings.constructor !== Object;
  const hasUnsafePrototype = Object.prototype.hasOwnProperty.call(settings, 'prototype');
  if (hasUnsafeProto) warnings.push('Rejected unsafe key: __proto__');
  if (hasUnsafeCtor) warnings.push('Rejected unsafe key: constructor');
  if (hasUnsafePrototype) warnings.push('Rejected unsafe key: prototype');

  // Validate each setting against its rule
  for (const [key, value] of Object.entries(settings)) {
    if (PROTOTYPE_POLLUTION_KEYS.includes(key)) {
      continue;
    }
    // Theme switching is no longer supported. Ignore this legacy key silently
    // to avoid breaking older settings files.
    if (key === 'theme') {
      continue;
    }
    if (DEPRECATED_SETTINGS_KEYS.has(key)) {
      continue;
    }
    const rule = VALIDATION_RULES[key];

    if (!rule) {
      warnings.push(`Unknown setting: ${key}`);
      continue;
    }

    if (value === undefined || value === null) {
      if (rule.required) {
        errors.push(`${key} is required but not provided`);
      }
      continue;
    }

    const fieldErrors = validateSetting(key, value, rule);
    errors.push(...fieldErrors);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Sanitize settings by removing invalid values
 * @param {Record<string, any>} settings
 * @returns {Record<string, any>}
 */
function sanitizeSettings(settings) {
  if (!settings || typeof settings !== 'object') {
    return {};
  }

  const sanitized = Object.create(null);

  for (const [key, value] of Object.entries(settings)) {
    // Prevent prototype pollution
    if (PROTOTYPE_POLLUTION_KEYS.includes(key)) {
      continue;
    }
    // Theme switching is no longer supported. Drop this legacy key so we don't
    // keep persisting dead configuration.
    if (key === 'theme') {
      continue;
    }
    if (DEPRECATED_SETTINGS_KEYS.has(key)) {
      continue;
    }

    const rule = VALIDATION_RULES[key];

    // Drop unknown settings to prevent untrusted keys from persisting
    if (!rule) {
      logger.warn(`[settingsValidation] Dropping unknown settings key: "${key}"`);
      continue;
    }

    // Skip null/undefined unless required
    if (value === undefined || value === null) {
      if (rule.required) {
        continue; // Will use default
      }
      sanitized[key] = value;
      continue;
    }

    // Normalize special fields before validation
    let normalizedValue = value;
    // Normalize confidence threshold to a finite number in [0, 1]
    if (key === 'confidenceThreshold') {
      const num = Number(normalizedValue);
      if (Number.isFinite(num)) {
        normalizedValue = Math.min(1, Math.max(0, num));
      } else {
        normalizedValue = DEFAULT_SETTINGS.confidenceThreshold;
      }
    }

    // Validate and sanitize
    const fieldErrors = validateSetting(key, normalizedValue, rule);
    if (fieldErrors.length === 0) {
      // Apply a per-rule sanitizer when one is declared (e.g.
      // customChatPersonas, downloadsTriageExclusions) so the normalized,
      // deduped, length-capped value is what gets persisted rather than the
      // raw user input. Without this the declared sanitizers were dead code.
      sanitized[key] =
        typeof rule.sanitizer === 'function' ? rule.sanitizer(normalizedValue) : normalizedValue;
    }
    // Invalid values are dropped (will use defaults)
  }

  // Ensure polluted keys are absent/undefined on the sanitized object
  const finalSanitized = Object.assign(Object.create(null), sanitized);
  return finalSanitized;
}

/**
 * Get default value for a setting
 * @param {string} key
 * @returns {any}
 */
function getDefaultValue(key) {
  // Use DEFAULT_SETTINGS directly to avoid duplication
  return DEFAULT_SETTINGS[key];
}

/**
 * Get all configurable limits with current values
 * Fixed: Use shared DEFAULT_SETTINGS to avoid duplication
 * @param {Record<string, any>} settings
 */
function getConfigurableLimits(settings) {
  // Handle null/undefined settings
  const safeSettings = settings || {};

  return {
    fileSizeLimits: {
      maxImageFileSize: safeSettings.maxImageFileSize ?? DEFAULT_SETTINGS.maxImageFileSize,
      maxDocumentFileSize: safeSettings.maxDocumentFileSize ?? DEFAULT_SETTINGS.maxDocumentFileSize,
      maxTextFileSize: safeSettings.maxTextFileSize ?? DEFAULT_SETTINGS.maxTextFileSize
    },
    processingLimits: {
      autoConcurrency: safeSettings.autoConcurrency ?? DEFAULT_SETTINGS.autoConcurrency,
      maxConcurrentAnalysis:
        safeSettings.maxConcurrentAnalysis ?? DEFAULT_SETTINGS.maxConcurrentAnalysis
    },
    uiLimits: {
      workflowRestoreMaxAge:
        safeSettings.workflowRestoreMaxAge ?? DEFAULT_SETTINGS.workflowRestoreMaxAge,
      saveDebounceMs: safeSettings.saveDebounceMs ?? DEFAULT_SETTINGS.saveDebounceMs
    }
  };
}

module.exports = {
  isSafeRelativeFolderName,
  URL_PATTERN,
  VALIDATION_RULES,
  validateSettings,
  validateSetting,
  sanitizeSettings,
  getDefaultValue,
  getConfigurableLimits
};
