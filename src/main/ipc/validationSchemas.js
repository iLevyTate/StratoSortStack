// @ts-check
/**
 * Common Validation Schemas for IPC Handlers
 *
 * Centralized Zod schemas for validating IPC input data.
 * These schemas ensure type safety and provide clear error messages.
 */

const { URL_PATTERN } = require('../../shared/settingsValidation');
const {
  CHAT_PERSONAS,
  CUSTOM_PERSONA_LIMITS,
  CUSTOM_PERSONA_ID_PATTERN,
  CUSTOM_PERSONA_ID_PREFIX
} = require('../../shared/chatPersonas');
const {
  LOGGING_LEVELS,
  NUMERIC_LIMITS,
  NOTIFICATION_MODES,
  NAMING_CONVENTIONS,
  CASE_CONVENTIONS,
  SMART_FOLDER_ROUTING_MODES,
  SEPARATOR_PATTERN,
  MODEL_NAME_PATTERN,
  MAX_MODEL_NAME_LENGTH
} = require('../../shared/validationConstants');
const { EXPERIENCE_MODE_VALUES } = require('../../shared/experienceMode');
const { collapseDuplicateProtocols } = require('../../shared/urlUtils');
const { logger } = require('../../shared/logger');
const { getEffectiveMaxPathLength } = require('../../shared/securityConfig');
const {
  PROVIDER_BASE_URL_RULE,
  isAllowedProviderBaseUrl
} = require('../services/ai/providerBaseUrl');

/**
 * Minimal `safeParse`-bearing validator contract shared by Zod schemas and
 * the non-Zod fallback validators below (consumed duck-typed by
 * ipcWrappers.withValidation). Both export branches satisfy this shape.
 * @typedef {import('./ipcWrappers').SafeParseSchema} SafeParseSchema
 */

/**
 * Result of a fallback validator body: `{ error }` rejects, otherwise
 * `{ data }` accepts (`data: undefined` means "pass the raw input through").
 * @typedef {{ error?: string, data?: any }} FallbackValidationResult
 */

/**
 * Non-Zod fallback validator: presents the same `safeParse`-bearing
 * interface as a Zod schema so handler validation gates treat both
 * branches identically.
 * @typedef {SafeParseSchema & { parse: (data: any) => any, _isFallback: true, _name: string }} FallbackValidator
 */

// Try to load zod
let z;
let zodLoadError = null;
try {
  z = require('zod');
} catch (error) {
  if (process.env.NODE_ENV === 'test') {
    logger.warn('zod import failed in validationSchemas', { error: error.message });
  }
  zodLoadError = error;
  z = null;
}

// In production, Zod is required; fallback validators are not security-equivalent
if (!z && process.env.NODE_ENV === 'production') {
  throw new Error('Zod required in production; validation cannot use fallback');
}

// This ensures basic type checking even without Zod, preventing security bypasses
if (!z) {
  // Create simple fallback validators that provide basic type safety
  /**
   * @param {string} name
   * @param {(data: any) => FallbackValidationResult} validator
   * @returns {FallbackValidator}
   */
  const createFallbackValidator = (name, validator) => ({
    parse: (data) => {
      const result = validator(data);
      if (result.error) {
        const error = new Error(result.error);
        error.name = 'ValidationError';
        throw error;
      }
      return result.data !== undefined ? result.data : data;
    },
    safeParse: (data) => {
      try {
        const result = validator(data);
        if (result.error) {
          return { success: false, error: { message: result.error } };
        }
        return { success: true, data: result.data !== undefined ? result.data : data };
      } catch (e) {
        return { success: false, error: { message: e.message } };
      }
    },
    _isFallback: true,
    _name: name
  });

  // Basic fallback validators for critical schemas
  const fallbackFilePathSchema = createFallbackValidator('filePath', (data) => {
    if (typeof data !== 'string' || data.length === 0) {
      return { error: 'File path must be a non-empty string' };
    }
    // Path traversal protection
    const normalized = data.replace(/\\/g, '/');
    if (normalized.includes('../')) {
      return { error: 'File path must not contain directory traversal sequences' };
    }
    if (data.length > 32767) {
      return { error: 'File path exceeds maximum length' };
    }
    return { data };
  });

  const fallbackSettingsSchema = createFallbackValidator('settings', (data) => {
    if (typeof data !== 'object' || data === null) {
      return { error: 'Settings must be an object' };
    }
    // Basic sanitization - remove dangerous keys
    const sanitized = {};
    for (const [key, value] of Object.entries(data)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      // Use defineProperty to avoid triggering special setters (e.g. __proto__) on assignment
      Object.defineProperty(sanitized, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return { data: sanitized };
  });

  const fallbackSmartFolderSchema = createFallbackValidator('smartFolder', (data) => {
    if (typeof data !== 'object' || data === null) {
      return { error: 'Smart folder must be an object' };
    }
    if (typeof data.name !== 'string' || data.name.length === 0) {
      return { error: 'Smart folder name is required' };
    }
    if (typeof data.path !== 'string' || data.path.length === 0) {
      return { error: 'Smart folder path is required' };
    }
    // Path traversal protection
    const normalizedPath = data.path.replace(/\\/g, '/');
    if (normalizedPath.includes('../')) {
      return { error: 'Smart folder path must not contain directory traversal sequences' };
    }
    return { data };
  });

  const fallbackSearchQuerySchema = createFallbackValidator('searchQuery', (data) => {
    if (typeof data !== 'object' || data === null) {
      return { error: 'Search query must be an object' };
    }
    if (data.query !== undefined && typeof data.query !== 'string') {
      return { error: 'Search query.query must be a string' };
    }
    if (
      data.limit !== undefined &&
      (typeof data.limit !== 'number' || data.limit < 1 || data.limit > 1000)
    ) {
      return { error: 'Search query limit must be a number between 1 and 1000' };
    }
    if (data.offset !== undefined && (typeof data.offset !== 'number' || data.offset < 0)) {
      return { error: 'Search query offset must be a non-negative number' };
    }
    return { data };
  });

  const fallbackPaginationSchema = createFallbackValidator('pagination', (data) => {
    if (typeof data !== 'object' || data === null) {
      return { error: 'Pagination must be an object' };
    }
    if (
      data.limit !== undefined &&
      (typeof data.limit !== 'number' || data.limit < 1 || data.limit > 1000)
    ) {
      return { error: 'Limit must be a number between 1 and 1000' };
    }
    if (data.offset !== undefined && (typeof data.offset !== 'number' || data.offset < 0)) {
      return { error: 'Offset must be a non-negative number' };
    }
    return { data };
  });

  const fallbackBatchOperationSchema = createFallbackValidator('batchOperation', (data) => {
    if (typeof data !== 'object' || data === null) {
      return { error: 'Batch operation must be an object' };
    }
    if (!Array.isArray(data.operations) || data.operations.length === 0) {
      return { error: 'Batch operation requires a non-empty operations array' };
    }
    if (data.operations.length > 1000) {
      return { error: 'Batch size exceeds maximum of 1000' };
    }
    for (let i = 0; i < data.operations.length; i++) {
      const op = data.operations[i];
      if (!op || typeof op !== 'object') {
        return { error: `Operation at index ${i} must be an object` };
      }
      if (typeof op.source !== 'string' || op.source.length === 0) {
        return { error: `Operation at index ${i} requires a non-empty source string` };
      }
      if (typeof op.destination !== 'string' || op.destination.length === 0) {
        return { error: `Operation at index ${i} requires a non-empty destination string` };
      }
    }
    if (data.strict !== undefined && typeof data.strict !== 'boolean') {
      return { error: 'strict must be a boolean if provided' };
    }
    if (
      data.resumeBatchId !== undefined &&
      !(
        typeof data.resumeBatchId === 'string' && /^batch_\d+_[a-f0-9]{8}$/.test(data.resumeBatchId)
      )
    ) {
      return { error: 'resumeBatchId must match the organize batch id format' };
    }
    return { data };
  });

  logger.warn('[validationSchemas] Zod not available, using fallback validation', {
    error: zodLoadError?.message
  });

  // Fix 2B: Replace z.any() with typed schema (fallback branch)
  const schemaFolderMatch = z
    ? z.object({
        text: z.string(),
        smartFolders: z.array(z.record(z.string(), z.unknown())).optional()
      })
    : createFallbackValidator('folderMatch', (data) => {
        if (typeof data !== 'object' || data === null) {
          return { error: 'Folder match request must be an object' };
        }
        if (typeof data.text !== 'string') {
          return { error: 'text is required and must be a string' };
        }
        return { data };
      });

  const fallbackOptionalPayload = createFallbackValidator('ipcOptionalPayload', () => ({
    data: undefined
  }));

  const fallbackVoidPayload = createFallbackValidator('ipcVoidPayload', (data) => {
    if (data === undefined || data === null) return { data: undefined };
    return { error: 'Expected no IPC payload' };
  });

  const fallbackAnalysisHistorySearch = createFallbackValidator('analysisHistorySearch', (data) => {
    if (data == null || typeof data === 'string') return { data };
    if (Array.isArray(data) && data.length >= 1 && typeof data[0] === 'string') return { data };
    return { error: 'Search expects a string or [query, options?] tuple' };
  });

  const fallbackBackupPathSchema = createFallbackValidator('backupPath', (data) => {
    if (typeof data !== 'string' || data.length === 0) {
      return { error: 'Backup path is required' };
    }
    const normalized = data.replace(/\\/g, '/');
    if (normalized.includes('../')) {
      return { error: 'Backup path must not contain directory traversal sequences' };
    }
    if (data.length > 32767) {
      return { error: 'Backup path exceeds maximum length' };
    }
    return { data };
  });

  // Generic catch-all fallback validator used for every Zod-only schema name
  // we haven't explicitly mapped. The Zod branch exports ~80 schemas; without a
  // catch-all, accessing an unmapped key on this fallback bag returns
  // `undefined`, which causes createHandler to skip validation entirely (the
  // `schema && typeof schema.safeParse === 'function'` gate is false). That
  // silently disables IPC validation in any environment where Zod fails to
  // load (notably tests and any dev path that mocks the module). The catch-all
  // accepts anything but exposes a working safeParse so the handler stays in
  // the validate-and-pass branch. In production, line 40 throws before we ever
  // reach this fallback bag, so this is non-prod-only behavior.
  const fallbackAcceptAny = createFallbackValidator('acceptAny', (data) => ({ data }));
  const baseFallbackSchemas = {
    filePath: fallbackFilePathSchema,
    settings: fallbackSettingsSchema,
    smartFolder: fallbackSmartFolderSchema,
    searchQuery: fallbackSearchQuerySchema,
    pagination: fallbackPaginationSchema,
    batchOrganize: fallbackBatchOperationSchema,
    backupPath: fallbackBackupPathSchema,
    ipcOptionalPayload: fallbackOptionalPayload,
    ipcVoidPayload: fallbackVoidPayload,
    analysisHistorySearch: fallbackAnalysisHistorySearch,
    historyLimit: createFallbackValidator('historyLimit', (data) => {
      if (data === undefined || data === null) return { data };
      const n = typeof data === 'number' ? data : Number(data);
      if (!Number.isFinite(n) || n < 1 || n > 500) {
        return { error: 'history limit must be a number 1–500' };
      }
      return { data: n };
    }),
    undoRedoHistoryLimit: createFallbackValidator('undoRedoHistoryLimit', (data) => {
      if (data === undefined || data === null) return { data: 50 };
      const n = typeof data === 'number' ? data : Number(data);
      if (!Number.isFinite(n) || n < 1 || n > 200) {
        return { error: 'undo history limit must be a number 1–200' };
      }
      return { data: Math.floor(n) };
    }),
    dismissDegradedFlagPayload: createFallbackValidator('dismissDegradedFlagPayload', (data) => {
      if (!data || typeof data !== 'object') return { error: 'Expected object payload' };
      if (typeof data.code !== 'string' || !data.code) {
        return { error: 'code is required and must be a string' };
      }
      if (data.code.length > 120) {
        return { error: 'code exceeds 120 chars' };
      }
      return { data };
    }),
    themeName: createFallbackValidator('themeName', (data) => {
      if (data === 'primary' || data === 'dark' || data === 'light') return { data };
      return { error: "theme must be one of 'primary' | 'dark' | 'light'" };
    }),
    licenseActivate: createFallbackValidator('licenseActivate', (data) => {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { error: 'payload must be an object' };
      }
      if (typeof data.key !== 'string' || data.key.length < 20) {
        return { error: 'key is required and must be a string of at least 20 chars' };
      }
      if (data.key.length > 4096) {
        return { error: 'key exceeds 4096 chars' };
      }
      return { data };
    }),
    llamaModelFilename: createFallbackValidator('llamaModelFilename', (data) => {
      if (typeof data !== 'string' || data.trim().length === 0) {
        return { error: 'Model name is required' };
      }
      if (data.includes('..') || data.includes('/') || data.includes('\\')) {
        return { error: 'Invalid model name' };
      }
      return { data };
    })
  };

  const schemasProxy = new Proxy(baseFallbackSchemas, {
    get(target, prop) {
      if (prop in target) return target[/** @type {keyof typeof baseFallbackSchemas} */ (prop)];
      // Mirror Object/Symbol meta-access so the bag still behaves like a plain
      // object for Object.keys / typeof / etc. (Zod schemas don't carry these
      // either, but this keeps the fallback indistinguishable from a real bag.)
      if (typeof prop === 'symbol') return undefined;
      return fallbackAcceptAny;
    }
  });

  module.exports = {
    schemaFolderMatch,
    z: null,
    schemas: schemasProxy,
    zodLoadError,
    filePathSchema: fallbackFilePathSchema,
    settingsSchema: fallbackSettingsSchema,
    smartFolderSchema: fallbackSmartFolderSchema,
    batchOperationSchema: fallbackBatchOperationSchema,
    searchQuerySchema: fallbackSearchQuerySchema,
    paginationSchema: fallbackPaginationSchema,
    backupPathSchema: fallbackBackupPathSchema,
    _usingFallback: true
  };
} else {
  // ===== Primitive Schemas =====

  /** @param {string} val */
  const hasPathTraversal = (val) => val.replace(/\\/g, '/').includes('../');
  // Use platform-specific limit from securityConfig (single source of truth).
  // Previously hardcoded to 32767, which let paths pass Zod but get silently
  // truncated by sanitizePath downstream.
  // Honour the runtime long-path probe on Windows so we don't accept paths
  // longer than the OS will actually handle (see securityConfig.js).
  const MAX_PATH_LENGTH = getEffectiveMaxPathLength();

  // Strict guard for filesystem-action paths (triage, trash, organize).
  // Rejects: relative paths, UNC (\\server\share), URL-style (file://, http://),
  // and parent-segment traversal. Belt-and-braces — main side also calls
  // validateFileOperationPath, but failing fast at the IPC boundary keeps the
  // attack surface tiny and produces a much better error message.
  /**
   * @param {unknown} val
   * @returns {boolean}
   */
  const isSafeAbsoluteFsPath = (val) => {
    if (typeof val !== 'string' || val.length === 0) return false;
    if (hasPathTraversal(val)) return false;
    // Reject URL-like protocols anywhere up to the first colon (case-insensitive).
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(val)) return false;
    // Reject UNC paths (Windows network shares) and forward-slash UNC.
    if (val.startsWith('\\\\') || val.startsWith('//')) return false;
    // Require absolute. Cross-platform: Windows drive (C:\), POSIX root (/),
    // or any drive followed by a separator. We can't import 'path' at top of
    // file because schema construction predates Electron init in some test
    // contexts, so do platform-aware checks inline.
    const isWindowsAbsolute = /^[a-zA-Z]:[\\/]/.test(val);
    const isPosixAbsolute = val.startsWith('/');
    if (!isWindowsAbsolute && !isPosixAbsolute) return false;
    return true;
  };
  const SAFE_ABSOLUTE_PATH_MESSAGE =
    'Path must be absolute and must not be a UNC, URL, or contain ../ traversal segments';

  /**
   * File path validation - non-empty string with traversal protection
   */
  const filePathSchema = z
    .string()
    .min(1, 'File path is required')
    .max(MAX_PATH_LENGTH, 'File path exceeds maximum length')
    .refine(
      (val) => !hasPathTraversal(val),
      'File path must not contain directory traversal sequences'
    );

  /**
   * Directory path validation - non-empty string
   */
  const directoryPathSchema = z.string().min(1, 'Directory path is required');

  /**
   * Optional URL validation (relaxed: protocol optional, trims whitespace)
   *
   * Also supports extracting a URL from common pasted commands (e.g. `curl http://127.0.0.1:8080/api/endpoint`).
   * Uses optional+nullable to allow both undefined and null values.
   * Uses shared URL_PATTERN from settingsValidation.js
   */
  /** @param {unknown} raw */
  const extractUrlLikeToken = (raw) => {
    if (typeof raw !== 'string') return raw;
    let s = raw.trim();
    if (!s) return '';

    // Strip surrounding quotes commonly added when copying values
    if (
      (s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'")) ||
      (s.startsWith('`') && s.endsWith('`'))
    ) {
      s = s.slice(1, -1).trim();
    }

    // If the user pasted a full command (e.g. "curl ..."), try to extract a URL-like token.
    if (/\s/.test(s)) {
      // Prefer explicit http(s) URLs first.
      const httpMatch = s.match(/https?:\/\/[^\s"'`]+/i);
      if (httpMatch?.[0]) {
        s = httpMatch[0];
      } else {
        // Otherwise, scan tokens for host[:port][/path] and skip command words like "curl".
        const tokens = s.split(/\s+/).map((t) => t.replace(/^[("'`]+|[)"'`,;]+$/g, '').trim());
        /** @param {string} t */
        const isLikelyHost = (t) => {
          if (!t) return false;
          const lower = t.toLowerCase();
          if (['curl', 'wget', 'powershell', 'pwsh', 'invoke-restmethod', 'irm'].includes(lower)) {
            return false;
          }
          // Heuristics: "localhost", IPv4, or something containing "." or ":".
          if (lower.startsWith('localhost')) return true;
          if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/.*)?$/.test(t)) return true;
          if (t.includes('.') || t.includes(':')) return true;
          return false;
        };

        const candidate = tokens.find((t) => isLikelyHost(t) && URL_PATTERN.test(t));
        if (candidate) s = candidate;
      }
    }

    // Trim trailing punctuation that often comes from prose/snippets
    s = s.replace(/[),;]+$/, '').trim();

    // Collapse duplicate protocols (e.g. "http://http://127.0.0.1:8080")
    // so validation and downstream normalization don't reject common paste mistakes.
    s = collapseDuplicateProtocols(s);
    return s;
  };

  const optionalUrlSchema = z
    .preprocess(extractUrlLikeToken, z.string())
    .refine(
      (val) => val === undefined || val === null || val === '' || URL_PATTERN.test(val),
      'Invalid URL format (expected host[:port] with optional http/https)'
    )
    .optional()
    .nullable();

  /**
   * Model name validation - alphanumeric with common separators
   * Uses .nullish() to allow both null and undefined values
   * Regex allows forward slashes for registry-style names (e.g., library/model)
   */
  const modelNameSchema = z
    .string()
    .regex(MODEL_NAME_PATTERN, 'Model name contains invalid characters')
    .max(MAX_MODEL_NAME_LENGTH, `Model name too long (max ${MAX_MODEL_NAME_LENGTH} chars)`)
    .nullish();

  /**
   * Required GGUF filename for llama download/cancel/delete (no path separators).
   */
  const llamaModelFilenameSchema = z
    .string()
    .min(1, 'Model name is required')
    .max(MAX_MODEL_NAME_LENGTH, `Model name too long (max ${MAX_MODEL_NAME_LENGTH} chars)`)
    .refine((name) => !name.includes('..') && !name.includes('/') && !name.includes('\\'), {
      message: 'Invalid model name'
    });

  // Match settingsValidation.js: built-ins plus sanitized custom ids (`custom:…`).
  // A strict enum here rejected custom personas at the IPC gate ("Invalid input").
  const builtInChatPersonaIds = new Set(CHAT_PERSONAS.map((persona) => persona.id));
  const chatPersonaSchema = z
    .string()
    .max(128)
    .refine((id) => {
      if (builtInChatPersonaIds.has(id)) return true;
      if (!id.startsWith(CUSTOM_PERSONA_ID_PREFIX)) return false;
      const bareId = id.slice(CUSTOM_PERSONA_ID_PREFIX.length);
      return bareId.length > 0 && CUSTOM_PERSONA_ID_PATTERN.test(bareId);
    }, 'Invalid chat persona id')
    .nullish();

  // ===== Settings Schemas =====

  /**
   * Settings object validation
   * Uses shared constants from validationConstants.js
   */
  const settingsSchema = z
    .object({
      // AI Models & Config
      textModel: modelNameSchema,
      visionModel: modelNameSchema,
      embeddingModel: modelNameSchema,
      // First-run consent: suppress background model auto-download when true
      modelAutoDownloadSkipped: z.boolean().nullish(),
      // Embedding workflow controls
      embeddingTiming: z.enum(['during_analysis', 'after_organize', 'manual']).nullish(),
      defaultEmbeddingPolicy: z.enum(['embed', 'skip', 'web_only']).nullish(),
      embeddingScope: z.enum(['all_analyzed', 'smart_folders_only']).nullish(),
      chatPersona: chatPersonaSchema,
      chatResponseMode: z.enum(['fast', 'deep']).nullish(),
      // Chat persona customization. These existed in VALIDATION_RULES and the
      // allowlist but were missing here, so the SAVE IPC Zod gate stripped them
      // before they reached SettingsService — custom personas/guidance never
      // persisted. sanitizeCustomPersonas (in settingsValidation) does the deep
      // per-row cleaning; this schema only enforces the coarse shape/bounds.
      chatPersonaCustomGuidance: z
        .string()
        .max(CUSTOM_PERSONA_LIMITS.MAX_GUIDANCE_LENGTH)
        .nullish(),
      // Global organization instructions; 2 KB cap mirrors settingsValidation.
      organizationCustomGuidance: z.string().max(2048).nullish(),
      customChatPersonas: z
        .array(z.record(z.string(), z.unknown()))
        .max(CUSTOM_PERSONA_LIMITS.MAX_COUNT)
        .nullish(),
      // Application Behavior
      launchOnStartup: z.boolean().nullish(),
      autoOrganize: z.boolean().nullish(),
      backgroundMode: z.boolean().nullish(),
      autoChunkOnAnalysis: z.boolean().nullish(),
      autoUpdateCheck: z.boolean().nullish(),

      // UI Preferences
      experienceMode: z.enum(EXPERIENCE_MODE_VALUES).nullish(),
      loggingLevel: z.enum(LOGGING_LEVELS).nullish(),

      // Notification settings
      notifications: z.boolean().nullish(),
      notificationMode: z.enum(NOTIFICATION_MODES).nullish(),
      notifyOnAutoAnalysis: z.boolean().nullish(),
      notifyOnLowConfidence: z.boolean().nullish(),

      // Organization settings
      confidenceThreshold: z.number().min(0).max(1).nullish(),
      defaultSmartFolderLocation: z.string().max(500).nullish(),
      smartFolderRoutingMode: z.enum(SMART_FOLDER_ROUTING_MODES).nullish(),
      autoConcurrency: z.boolean().nullish(),
      maxConcurrentAnalysis: z.number().int().min(1).max(10).nullish(),
      lastBrowsedPath: z.string().max(1000).nullish(),

      // Naming convention settings
      namingConvention: z.enum(NAMING_CONVENTIONS).nullish(),
      dateFormat: z.string().nullish(),
      caseConvention: z.enum(CASE_CONVENTIONS).nullish(),
      separator: z.string().regex(SEPARATOR_PATTERN).nullish(),

      // File size limits (must match settingsValidation.js VALIDATION_RULES).
      // Type-specific only — there is no general maxFileSize.
      maxImageFileSize: z
        .number()
        .int()
        .min(1024 * 1024)
        .max(500 * 1024 * 1024)
        .nullish(),
      maxDocumentFileSize: z
        .number()
        .int()
        .min(1024 * 1024)
        .max(500 * 1024 * 1024)
        .nullish(),
      maxTextFileSize: z
        .number()
        .int()
        .min(1024 * 1024)
        .max(200 * 1024 * 1024)
        .nullish(),

      // UI limits
      workflowRestoreMaxAge: z
        .number()
        .int()
        .min(NUMERIC_LIMITS.workflowRestoreMaxAge.min)
        .max(NUMERIC_LIMITS.workflowRestoreMaxAge.max)
        .nullish(),
      saveDebounceMs: z
        .number()
        .int()
        .min(NUMERIC_LIMITS.saveDebounceMs.min)
        .max(NUMERIC_LIMITS.saveDebounceMs.max)
        .nullish(),

      // Developer-only UI toggles
      developerGraphEnabled: z.boolean().nullish(),

      // Graph-aware retrieval (GraphRAG-lite)
      graphExpansionEnabled: z.boolean().nullish(),
      graphExpansionWeight: z.number().min(0).max(1).nullish(),
      graphExpansionMaxNeighbors: z.number().int().min(10).max(500).nullish(),
      chunkContextEnabled: z.boolean().nullish(),
      chunkContextMaxNeighbors: z.number().int().min(0).max(3).nullish(),

      // Downloads Triage user exclusion globs (Phase 3)
      downloadsTriageExclusions: z.array(z.string().min(1).max(256)).max(200).nullish(),

      // Llama engine tuning (bounds shared with VALIDATION_RULES)
      llamaGpuLayers: z
        .number()
        .int()
        .min(NUMERIC_LIMITS.llamaGpuLayers.min)
        .max(NUMERIC_LIMITS.llamaGpuLayers.max)
        .nullish(),
      llamaContextSize: z
        .number()
        .int()
        .min(NUMERIC_LIMITS.llamaContextSize.min)
        .max(NUMERIC_LIMITS.llamaContextSize.max)
        .nullish(),

      // Vector DB persistence (relative to userData)
      vectorDbPersistPath: z.string().min(1).max(200).nullish(),

      // AI provider configuration blob (providers/routing/consent). Kept
      // opaque at this gate because the renderer's whole-object saves echo a
      // possibly partial blob; the settings save/import paths deep-validate
      // the merged result (defaults ← stored ← incoming) against
      // services/ai/schemas.aiSettingsSchema and apply the cloud-consent gate
      // via services/ai/aiSettings.validateAiSettingsForSave.
      ai: z.record(z.string(), z.unknown()).nullish(),

      // Internal schema version for settings migrations
      settingsSchemaVersion: z.number().int().min(1).max(10000).nullish(),

      // Live opt-out for smart-folder watching (Settings → Auto-organize)
      smartFolderWatchEnabled: z.boolean().nullish(),
      // Vision captions for video keyframes (off by default; per-video cost)
      captionVideoKeyframes: z.boolean().nullish(),
      // Advanced-mode values parked while Simple mode is on; keys limited to
      // the Simple-mode enforced set (bounds mirror the top-level fields).
      advancedModeValues: z
        .object({
          defaultEmbeddingPolicy: z.enum(['embed', 'skip', 'web_only']).optional(),
          embeddingTiming: z.enum(['during_analysis', 'after_organize', 'manual']).optional(),
          autoChunkOnAnalysis: z.boolean().optional(),
          graphExpansionEnabled: z.boolean().optional(),
          chunkContextEnabled: z.boolean().optional()
        })
        .strict()
        .nullish()
    })
    .partial();

  // ===== Smart Folder Schemas =====

  /**
   * Smart folder object validation
   */
  const smartFolderSchema = z.object({
    id: z.string().optional(),
    name: z.string().min(1, 'Folder name is required').max(255, 'Folder name too long'),
    path: z
      .string()
      .min(1, 'Folder path is required')
      .max(MAX_PATH_LENGTH, 'Folder path exceeds maximum length')
      .refine(
        (val) => !hasPathTraversal(val),
        'Folder path must not contain directory traversal sequences'
      ),
    description: z.string().max(1000).optional(),
    keywords: z.array(z.string().max(200)).max(200).optional(),
    category: z.string().max(255).optional(),
    isDefault: z.boolean().optional()
  });

  /**
   * Array of smart folders (bounded so a hostile renderer can't post an
   * unbounded payload through the IPC gate)
   */
  const smartFoldersArraySchema = z.array(smartFolderSchema).max(1000);

  /**
   * Smart folder edit input (folderId + updated data)
   */
  const smartFolderEditSchema = z.tuple([
    z.string().min(1, 'Folder ID is required'),
    smartFolderSchema.partial()
  ]);

  // ===== File Operation Schemas =====

  /**
   * Single file operation
   */
  // IPC-gate path hardening (audit item #1): apply the same safe-absolute-path
  // refine used by every other path-bearing schema in this file so a 100KB
  // string, URL, UNC, or traversal payload fails at the boundary instead of
  // riding all the way to validateFileOperationPath in batchOrganizeHandler.js.
  // Top-level source/destination remain .optional() because move/copy use them
  // but batch_organize routes through operations[] instead.
  const fileOpPathSchema = z
    .string()
    .min(1)
    .max(2048)
    .refine(isSafeAbsoluteFsPath, SAFE_ABSOLUTE_PATH_MESSAGE);

  // What the app suggested for this file before the user confirmed. When the
  // file lands in a different smart folder, batch organize records a
  // correction against the suggested one. Listed explicitly: Zod strips
  // unknown keys, so without it the learning signal would never arrive.
  const organizeSuggestionSchema = z
    .object({
      folder: z.string().min(1).max(255),
      path: fileOpPathSchema.optional(),
      source: z.string().max(64).optional()
    })
    .optional();

  const batchOrganizeOpSchema = z.object({
    source: fileOpPathSchema,
    destination: fileOpPathSchema,
    type: z.string().optional(),
    suggestion: organizeSuggestionSchema
  });

  const fileOperationSchema = z
    .object({
      // batch_move: several user-chosen moves recorded as ONE undo entry
      // (MOVE_BATCH). "Move selection to folder" from Search, Atlas and the
      // graph used one `move` per file, so a 60-file move produced 60 undo
      // steps and evicted everything before it (audit row UR-04).
      type: z.enum(['move', 'copy', 'delete', 'batch_organize', 'batch_move']),
      source: fileOpPathSchema.optional(),
      destination: fileOpPathSchema.optional(),
      operations: z.array(batchOrganizeOpSchema).max(10000).optional(),
      // batch_move's undo entry is named after this ("Move 12 files to
      // Taxes"). Zod strips unlisted keys, so without it every batch move
      // was recorded as plain "Move files".
      label: z.string().max(120).optional(),
      // Dry-run plan only — no disk mutation, no batch lock, no journal write.
      // The handler routes on this BEFORE acquiring the batch lock so previewing
      // is concurrency-safe. Without listing it here Zod's default object mode
      // strips the field, so the renderer's Preview button silently executes
      // a real batch (post-2.0.9 regression — see the
      // `if (operation?.dryRun === true)` branch in batchOrganizeHandler.js).
      dryRun: z.boolean().optional(),
      // Roll back any completed moves on the first individual failure rather
      // than only on the narrowly classified "critical" codes. Off by default
      // for backward compatibility. Same Zod-stripping risk as `dryRun`.
      strict: z.boolean().optional(),
      // Resume a previously paused batch: reuse its journal id so done ops
      // are skipped. Same Zod-stripping risk as `dryRun` — omitting it here
      // would silently start a NEW batch that re-moves already-moved files.
      resumeBatchId: z
        .string()
        .regex(/^batch_\d+_[a-f0-9]{8}$/)
        .optional(),
      correlationId: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[\w.:-]+$/)
        .optional(),
      __stratosortCorrelationId: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[\w.:-]+$/)
        .optional()
    })
    .superRefine((value, ctx) => {
      if (value.type === 'batch_organize' || value.type === 'batch_move') {
        if (!Array.isArray(value.operations) || value.operations.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['operations'],
            message: `${value.type === 'batch_move' ? 'Batch move' : 'Batch organize'} requires at least one operation`
          });
        }
      }
    });

  /**
   * Batch organize operation
   */
  const batchOrganizeSchema = z.object({
    operations: z
      .array(batchOrganizeOpSchema)
      .min(1, 'At least one operation is required')
      .max(1000, 'Batch size exceeds maximum of 1000'),
    // dryRun: belt-and-suspenders. The active batch-organize path validates
    // through `fileOperationSchema` (above), but if a future caller routes
    // through this schema we don't want the same Zod-strips-unknown-keys
    // bug to silently re-execute real moves on a Preview click. Listing
    // it here keeps both validation surfaces honest.
    dryRun: z.boolean().optional(),
    // strict: roll back any completed moves on the first individual failure
    // (not just the narrowly classified "critical" ones). Default is the
    // legacy lenient behavior for backward compatibility.
    strict: z.boolean().optional(),
    // resumeBatchId: same stripping risk as dryRun — see fileOperationSchema.
    resumeBatchId: z
      .string()
      .regex(/^batch_\d+_[a-f0-9]{8}$/)
      .optional()
  });

  // ===== Analysis Schemas =====

  /**
   * File object for analysis
   */
  const analysisFileSchema = z.object({
    path: filePathSchema,
    name: z.string().optional(),
    extension: z.string().optional(),
    size: z.number().optional(),
    type: z.string().optional(),
    analysis: z.record(z.string(), z.any()).optional()
  });

  /**
   * Batch analysis input
   */
  const batchAnalysisSchema = z.object({
    files: z.array(analysisFileSchema).min(1).max(10000),
    options: z.record(z.string(), z.any()).optional()
  });

  // ===== Search/Query Schemas =====

  /**
   * Pagination options
   */
  const paginationSchema = z.object({
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().min(0).optional()
  });

  /**
   * Search query with pagination
   */
  const searchQuerySchema = z.object({
    query: z.string().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().min(0).optional(),
    all: z.boolean().optional()
  });

  /**
   * History options
   */
  const historyOptionsSchema = z.object({
    limit: z.union([z.number().int().positive(), z.literal('all')]).optional(),
    offset: z.number().int().min(0).optional(),
    all: z.boolean().optional()
  });

  // ===== Organization Schemas =====

  /**
   * Auto-organize input
   */
  const autoOrganizeSchema = z.object({
    files: z.array(analysisFileSchema).max(10000),
    smartFolders: z.array(smartFolderSchema).max(1000).optional(),
    options: z.record(z.string(), z.any()).optional()
  });

  // ===== Suggestion Schemas =====

  /**
   * Single file suggestion input
   */
  const fileSuggestionSchema = z.object({
    file: analysisFileSchema,
    options: z.record(z.string(), z.any()).optional()
  });

  /**
   * Batch suggestion input
   */
  const batchSuggestionSchema = z.object({
    files: z.array(analysisFileSchema).max(500),
    options: z.record(z.string(), z.any()).optional()
  });

  /**
   * Feedback recording input
   */
  const feedbackSchema = z.object({
    file: analysisFileSchema,
    suggestion: z.object({
      folder: z.string().optional(),
      confidence: z.number().optional()
    }),
    accepted: z.boolean(),
    note: z.string().max(500).optional()
  });

  /**
   * Feedback memory add input
   */
  const feedbackMemoryAddSchema = z.object({
    text: z.string().min(2).max(500),
    metadata: z.record(z.string(), z.any()).optional()
  });

  /**
   * Feedback memory delete input
   */
  const feedbackMemoryDeleteSchema = z.object({
    id: z.string().min(1)
  });

  /**
   * Feedback memory update input
   */
  const feedbackMemoryUpdateSchema = z.object({
    id: z.string().min(1),
    text: z.string().min(2).max(500),
    metadata: z.record(z.string(), z.any()).optional()
  });

  /**
   * Strategy application input
   */
  const strategyApplicationSchema = z.object({
    files: z.array(analysisFileSchema),
    strategyId: z.string().min(1)
  });

  // ===== Embeddings Schemas =====

  /**
   * Find similar files input
   */
  const findSimilarSchema = z.object({
    fileId: z.string().min(1, 'File ID is required'),
    topK: z.number().int().min(1).max(100).optional().default(10)
  });

  /**
   * Semantic search parameters
   * FIX P1-5: Add Zod schema for SEARCH handler validation
   */
  const semanticSearchSchema = z.object({
    query: z
      .string()
      .min(2, 'Query must be at least 2 characters')
      .max(2000, 'Query too long (max 2000)'),
    topK: z.number().int().min(1).max(100).optional().default(20),
    mode: z.enum(['hybrid', 'vector', 'bm25']).optional().default('hybrid'),
    minScore: z.number().min(0).max(1).optional(),
    chunkWeight: z.number().min(0).max(1).optional(),
    chunkTopK: z.number().int().min(1).max(2000).optional(),
    // Query processing options
    expandSynonyms: z.boolean().optional(),
    correctSpelling: z.boolean().optional(),
    // Re-ranking options
    rerank: z.boolean().optional(),
    rerankTopN: z.number().int().min(1).max(50).optional(),
    // Graph expansion options
    graphExpansion: z.boolean().optional(),
    graphExpansionWeight: z.number().min(0).max(1).optional(),
    graphExpansionMaxNeighbors: z.number().int().min(1).max(500).optional(),
    chunkContext: z.boolean().optional(),
    chunkContextMaxNeighbors: z.number().int().min(0).max(3).optional()
  });

  /**
   * Score files against query
   * FIX P1-5: Add Zod schema for SCORE_FILES handler validation
   */
  const scoreFilesSchema = z.object({
    query: z
      .string()
      .min(2, 'Query must be at least 2 characters')
      .max(2000, 'Query too long (max 2000)'),
    fileIds: z
      .array(z.string().min(1).max(2048))
      .min(1, 'At least one file ID is required')
      .max(1000, 'Maximum 1000 file IDs allowed')
  });

  /**
   * Cluster computation parameters
   * FIX P1-5: Add Zod schema for COMPUTE_CLUSTERS handler validation
   */
  const computeClustersSchema = z.object({
    k: z
      .union([z.literal('auto'), z.number().int().min(1).max(100)])
      .optional()
      .default('auto'),
    // Prefer off by default — optional cluster LLM can load heavy text models / OOM tight VRAM.
    generateLabels: z.boolean().optional().default(false)
  });

  /**
   * Get cluster members parameters
   */
  const getClusterMembersSchema = z.object({
    clusterId: z.number().int().min(0, 'Cluster ID must be a non-negative integer')
  });

  /**
   * Similarity edges parameters
   * FIX P1-5: Add Zod schema for GET_SIMILARITY_EDGES handler validation
   */
  const similarityEdgesSchema = z.object({
    fileIds: z
      .array(z.string().min(1).max(2048))
      .min(2, 'At least 2 file IDs required for similarity edges')
      .max(500, 'Maximum 500 file IDs for performance'),
    threshold: z.number().min(0).max(1).optional().default(0.5),
    maxEdgesPerNode: z.number().int().min(1).max(20).optional().default(5)
  });

  /**
   * File metadata parameters
   */
  const getFileMetadataSchema = z.object({
    fileIds: z.array(z.string().min(1).max(2048)).max(100, 'Maximum 100 file IDs per request')
  });

  /**
   * Knowledge relationship edges parameters
   */
  const relationshipEdgesSchema = z.object({
    fileIds: z
      .array(z.string().min(1).max(2048))
      .min(2, 'At least 2 file IDs required')
      .max(500, 'Maximum 500 file IDs for performance'),
    minWeight: z.number().int().min(1).max(20).optional().default(2),
    maxEdges: z.number().int().min(1).max(2000).optional().default(500)
  });

  /**
   * Knowledge relationship index stats parameters
   */
  const relationshipStatsSchema = z.object({}).optional().default({});

  /**
   * Related-documents lookup: file-centric unified edges for a single seed file.
   */
  const relatedDocumentsSchema = z.object({
    fileId: z.string().min(1).max(2048),
    limit: z.number().int().min(1).max(100).optional().default(20),
    minWeight: z.number().int().min(1).max(20).optional().default(2),
    similarityThreshold: z.number().min(0).max(1).optional().default(0.5)
  });

  /**
   * Rebuild relationships: user-triggered rebuild that bypasses the 10-minute
   * throttle in RelationshipIndexService. Accepts an optional empty payload.
   */
  const rebuildRelationshipsSchema = z.object({}).optional().default({});

  /**
   * Downloads Triage — Phase 3.
   * Starts a stateful triage session against a chosen folder (defaults to the
   * OS Downloads directory). Tier 0 is metadata-only; a separate deep-scan
   * call runs Tier 1 embedding work on the ambiguous subset.
   */
  const downloadsTriageStartSchema = z.object({
    folderPath: z
      .string()
      .min(1)
      .max(2048)
      .refine(isSafeAbsoluteFsPath, SAFE_ABSOLUTE_PATH_MESSAGE)
      .optional(),
    maxFiles: z.number().int().min(1).max(10000).optional().default(2000),
    maxDepth: z.number().int().min(0).max(8).optional().default(1),
    minAgeHours: z.number().min(0).max(720).optional().default(24),
    exclusionGlobs: z.array(z.string().min(1).max(256)).max(200).optional()
  });

  const downloadsTriageDeepScanSchema = z.object({
    triageId: z.string().min(1).max(128),
    // Empty array is a valid request shape: it means "deep-scan everything in the
    // session, no targeted subset." Previously `.min(1)` forced callers to omit
    // the key entirely to express the same intent, which made the contract
    // confusing — present-but-empty and absent should mean the same thing.
    fileIds: z.array(z.string().min(1).max(2048)).max(5000).optional()
  });

  /**
   * Triage report export input (downloads:triage:export-report)
   */
  const downloadsTriageExportReportSchema = z.object({
    triageId: z.string().min(1).max(128)
  });

  const downloadsTriageActSchema = z.object({
    triageId: z.string().min(1).max(128),
    action: z.enum(['trash', 'organize', 'ignore']),
    files: z
      .array(
        z.object({
          path: z
            .string()
            .min(1)
            .max(2048)
            .refine(isSafeAbsoluteFsPath, SAFE_ABSOLUTE_PATH_MESSAGE),
          suggestedFolderPath: z
            .string()
            .min(1)
            .max(2048)
            .refine(isSafeAbsoluteFsPath, SAFE_ABSOLUTE_PATH_MESSAGE)
            .optional(),
          size: z.number().min(0).optional()
        })
      )
      .min(1)
      .max(1000),
    summary: z
      .object({
        label: z.string().max(200).optional()
      })
      .optional()
  });

  /**
   * Chat query parameters
   */
  const chatQuerySchema = z.object({
    sessionId: z.string().min(1).max(128).optional(),
    requestId: z.union([z.string().min(1).max(128), z.number().int().nonnegative()]).optional(),
    query: z
      .string()
      .min(2, 'Query must be at least 2 characters')
      .max(2000, 'Query too long (max 2000)'),
    topK: z.number().int().min(1).max(20).optional().default(6),
    mode: z.enum(['hybrid', 'vector', 'bm25']).optional().default('hybrid'),
    chunkTopK: z.number().int().min(1).max(2000).optional(),
    chunkWeight: z.number().min(0).max(1).optional(),
    contextFileIds: z.array(z.string().min(1).max(2048)).max(1000).optional(),
    documentScopeItems: z
      .array(
        z.object({
          id: z.string().min(1).max(2048),
          path: z.string().min(1).max(8192),
          name: z.string().min(1).max(2048).optional(),
          type: z.string().min(1).max(128).optional()
        })
      )
      .max(1000)
      .optional(),
    strictScope: z.boolean().optional().default(false),
    responseMode: z.enum(['fast', 'deep']).optional().default('fast'),
    // Regenerate re-sends a query whose user row is already persisted;
    // without this declared here Zod strips it and ChatService re-inserts
    // a duplicate user turn on every regenerate.
    skipSaveUserTurn: z.boolean().optional().default(false)
  });

  /**
   * Chat session reset parameters
   */
  const chatResetSchema = z.object({
    sessionId: z.string().min(1).max(128).optional()
  });

  /**
   * Chat stream cancel parameters
   */
  const chatCancelSchema = z.object({
    requestId: z.union([z.string().min(1).max(128), z.number().int().nonnegative()]).optional(),
    sessionId: z.string().min(1).max(128).optional()
  });

  /**
   * Find duplicates parameters
   * FIX P1-5: Add Zod schema for FIND_DUPLICATES handler validation
   */
  const findDuplicatesSchema = z.object({
    threshold: z.number().min(0.7).max(1).optional().default(0.9),
    maxResults: z.number().int().min(1).max(200).optional().default(50),
    tierThresholds: z
      .object({
        nearIdenticalMin: z.number().min(0.7).max(1).optional(),
        relatedMin: z.number().min(0.7).max(1).optional()
      })
      .optional()
  });

  /**
   * Trash duplicates: user-initiated bulk delete via shell.trashItem, recorded
   * as a single TRASH_BATCH undo entry.
   */
  const trashDuplicatesSchema = z.object({
    paths: z
      .array(z.string().min(1).max(2048).refine(isSafeAbsoluteFsPath, SAFE_ABSOLUTE_PATH_MESSAGE))
      .min(1)
      .max(1000),
    summary: z
      .object({
        label: z.string().max(200).optional(),
        tier: z.enum(['exact', 'nearIdentical', 'related', 'mixed']).optional()
      })
      .optional()
  });

  /**
   * Reindex file hashes: backfill SHA-256 for Orama files missing fileHash.
   */
  const reindexFileHashesSchema = z.object({
    force: z.boolean().optional().default(false),
    maxFiles: z.number().int().min(1).max(100000).optional().default(10000)
  });

  /**
   * Smart folder matching input
   */
  const smartFolderMatchSchema = z.object({
    text: z.string().min(1, 'Text is required for matching').max(100000),
    smartFolders: z.array(smartFolderSchema).min(1).max(1000)
  });

  // ===== Chat History Schemas =====

  /**
   * Chat conversation list parameters
   */
  const chatListConversationsSchema = z.object({
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional()
  });

  /**
   * Chat conversation ID parameter
   */
  const chatConversationIdSchema = z.object({
    id: z.string().min(1, 'Conversation ID is required').max(256)
  });

  /**
   * Chat conversation search parameter
   */
  const chatSearchConversationsSchema = z.object({
    query: z.string().min(1, 'Search query is required').max(500)
  });

  // ===== System Schemas =====

  /**
   * System log input validation
   */
  const systemLogSchema = z.object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
    message: z.string().min(1).max(8192),
    data: z.record(z.string(), z.any()).optional()
  });

  /**
   * Config path validation (dot-separated, alphanumeric + underscores)
   */
  const configPathSchema = z
    .string()
    .min(1, 'Config path is required')
    .max(120)
    .regex(/^[A-Za-z0-9_.-]+$/, 'Config path contains invalid characters');

  // ===== Undo/Redo Schemas =====

  /**
   * History limit parameter
   */
  const historyLimitSchema = z.number().int().min(1).max(500).optional();

  /** Undo stack history listing (default limit when invoke omits payload) */
  const undoRedoHistoryLimitSchema = z.number().int().min(1).max(200).optional().default(50);

  // ===== Organization Extended Schemas =====

  /**
   * Process new file input
   */
  const processNewSchema = z.object({
    filePath: z.string().min(1),
    options: z.record(z.string(), z.any()).optional()
  });

  /**
   * Cluster batch input
   */
  const clusterBatchSchema = z.object({
    files: z.array(analysisFileSchema).min(1).max(10000),
    smartFolders: z.array(smartFolderSchema).max(1000).optional()
  });

  /**
   * Identify outliers input
   */
  const identifyOutliersSchema = z.object({
    files: z.array(analysisFileSchema).min(1).max(10000)
  });

  /**
   * Cluster suggestions input
   */
  const clusterSuggestionsSchema = z.object({
    file: analysisFileSchema,
    smartFolders: z.array(smartFolderSchema).max(1000).optional()
  });

  // ===== Suggestion Extended Schemas =====

  /**
   * Folder structure analysis input
   */
  const analyzeFolderStructureSchema = z.object({
    files: z.array(analysisFileSchema).min(1)
  });

  /**
   * Suggest new folder input
   */
  const suggestNewFolderSchema = z.object({
    file: analysisFileSchema
  });

  // ===== Analysis History Extended Schemas =====

  /**
   * Analysis history search input (tuple form from renderer)
   */
  const analysisHistorySearchTupleSchema = z.tuple([
    z.string().min(1, 'Search query is required').max(500),
    z.record(z.string(), z.any()).optional()
  ]);

  /**
   * Analysis history search: string query or [query, options] tuple
   */
  const analysisHistorySearchSchema = z.union([
    z.string().max(2000),
    analysisHistorySearchTupleSchema
  ]);

  /** Settings export/import: path from renderer is ignored; accept any optional payload */
  const ipcOptionalPayloadSchema = z.unknown().optional();

  /** Invoke with no payload (undefined / null from older clients, or {} from
   * the preload bridge which always passes an object literal). Accepting all
   * three forms lets handlers use a single schema regardless of how the
   * caller signals "no args." */
  const ipcVoidPayloadSchema = z.union([z.undefined(), z.null(), z.object({}).strict()]);

  const dismissDegradedFlagPayloadSchema = z.object({
    code: z.string().min(1).max(120)
  });

  const openLegalDocumentPayloadSchema = z
    .object({
      kind: z.enum(['license', 'privacy', 'security'])
    })
    .strict();

  /** App theme name (window:set-theme-background) */
  const themeNameSchema = z.enum(['primary', 'dark', 'light']);

  /** License activation (license:activate) — the SSORT1-… key string. */
  const licenseActivateSchema = z
    .object({
      key: z.string().min(20).max(4096)
    })
    .strict();

  /**
   * Embedding policy input
   */
  const embeddingPolicySchema = z.object({
    filePath: z.string().min(1),
    policy: z.enum(['embed', 'skip', 'web_only'])
  });

  /**
   * Analysis history export format
   */
  const analysisExportFormatSchema = z.enum(['json', 'csv']).optional().default('json');

  /**
   * Transcript export input (analysis-history:export-transcript)
   */
  const transcriptExportSchema = z.object({
    filePath: z.string().min(1),
    format: z.enum(['vtt', 'srt', 'json'])
  });

  /**
   * Timeline page request (analysis-history:get-timeline)
   */
  const timelineOptionsSchema = z.object({
    limit: z.number().int().min(1).max(10000).optional(),
    offset: z.number().int().min(0).optional()
  });

  const embeddingsFullRebuildSchema = z
    .object({
      modelOverride: z.string().min(1).max(500).optional()
    })
    .optional();

  const embeddingsReanalyzeAllSchema = z
    .object({
      applyNaming: z.boolean().optional(),
      dryRun: z.boolean().optional()
    })
    .optional();

  /**
   * embeddings:rebuild-files options. Both fields are opt-in narrowing:
   * `onlyMissing` backfills files that lack a usable vector, and
   * `excludePathPrefixes` leaves watcher-owned folders alone.
   */
  const rebuildFilesOptionsSchema = z
    .object({
      onlyMissing: z.boolean().optional(),
      excludePathPrefixes: z.array(z.string().max(4096)).max(1000).optional()
    })
    .optional();

  const embeddingsReanalyzeFileSchema = z.union([
    z.string().min(1),
    z.object({
      filePath: z.string().min(1),
      applyNaming: z.boolean().optional()
    })
  ]);

  const embeddingsEmptyPayloadSchema = z.object({}).optional();

  const embeddingsDiagnoseSearchSchema = z
    .object({
      testQuery: z.string().min(1).max(2000).optional()
    })
    .optional();

  const embeddingsFindMultiHopSchema = z
    .object({
      // Hard cap on seeds (multi-hop cost grows with every seed). This is the
      // single source of truth: the handler does not re-slice.
      seedIds: z.array(z.string().min(1)).min(1).max(10),
      options: z
        .object({
          hops: z.number().int().min(1).max(5).optional(),
          maxHops: z.number().int().min(1).max(5).optional(),
          topKPerHop: z.number().int().min(1).max(100).optional(),
          decay: z.number().min(0).max(1).optional(),
          decayFactor: z.number().min(0).max(1).optional()
        })
        .optional()
    })
    .optional();

  const embeddingsFindFilesByPathsSchema = z
    .object({
      paths: z.array(z.string().min(1).max(4096)).max(1000).optional()
    })
    .optional();

  const atlasGetProjectionSchema = z
    .object({
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(10000).optional(),
      force: z.boolean().optional()
    })
    .optional();

  // ===== Backup Schemas =====

  /**
   * Backup path input
   */
  const backupPathSchema = z.string().min(1, 'Backup path is required');

  // ===== Export all schemas =====
  const schemas = {
    // Primitives
    filePath: filePathSchema,
    directoryPath: directoryPathSchema,
    optionalUrl: optionalUrlSchema,
    llamaModelFilename: llamaModelFilenameSchema,
    modelName: modelNameSchema,

    // Settings
    settings: settingsSchema,

    // Smart Folders
    smartFolder: smartFolderSchema,
    smartFoldersArray: smartFoldersArraySchema,
    smartFolderEdit: smartFolderEditSchema,
    smartFolderMatch: smartFolderMatchSchema,

    // File Operations
    fileOperation: fileOperationSchema,
    batchOrganize: batchOrganizeSchema,

    // Analysis
    analysisFile: analysisFileSchema,
    batchAnalysis: batchAnalysisSchema,

    // Search/Query
    pagination: paginationSchema,
    searchQuery: searchQuerySchema,
    historyOptions: historyOptionsSchema,

    // Organization
    autoOrganize: autoOrganizeSchema,

    // Suggestions
    fileSuggestion: fileSuggestionSchema,
    batchSuggestion: batchSuggestionSchema,
    feedback: feedbackSchema,
    feedbackMemoryAdd: feedbackMemoryAddSchema,
    feedbackMemoryDelete: feedbackMemoryDeleteSchema,
    feedbackMemoryUpdate: feedbackMemoryUpdateSchema,
    strategyApplication: strategyApplicationSchema,

    // Embeddings
    findSimilar: findSimilarSchema,
    semanticSearch: semanticSearchSchema,
    scoreFiles: scoreFilesSchema,
    computeClusters: computeClustersSchema,
    getClusterMembers: getClusterMembersSchema,
    similarityEdges: similarityEdgesSchema,
    getFileMetadata: getFileMetadataSchema,
    findDuplicates: findDuplicatesSchema,
    trashDuplicates: trashDuplicatesSchema,
    reindexFileHashes: reindexFileHashesSchema,
    embeddingsFullRebuild: embeddingsFullRebuildSchema,
    embeddingsReanalyzeAll: embeddingsReanalyzeAllSchema,
    rebuildFilesOptions: rebuildFilesOptionsSchema,
    embeddingsReanalyzeFile: embeddingsReanalyzeFileSchema,
    embeddingsEmptyPayload: embeddingsEmptyPayloadSchema,
    embeddingsDiagnoseSearch: embeddingsDiagnoseSearchSchema,
    embeddingsFindMultiHop: embeddingsFindMultiHopSchema,
    embeddingsFindFilesByPaths: embeddingsFindFilesByPathsSchema,
    atlasGetProjection: atlasGetProjectionSchema,
    relationshipEdges: relationshipEdgesSchema,
    relationshipStats: relationshipStatsSchema,
    relatedDocuments: relatedDocumentsSchema,
    rebuildRelationships: rebuildRelationshipsSchema,
    downloadsTriageStart: downloadsTriageStartSchema,
    downloadsTriageDeepScan: downloadsTriageDeepScanSchema,
    downloadsTriageExportReport: downloadsTriageExportReportSchema,
    downloadsTriageAct: downloadsTriageActSchema,

    // Chat
    chatQuery: chatQuerySchema,
    chatReset: chatResetSchema,
    chatCancel: chatCancelSchema,
    chatListConversations: chatListConversationsSchema,
    chatConversationId: chatConversationIdSchema,
    chatSearchConversations: chatSearchConversationsSchema,

    // System
    systemLog: systemLogSchema,
    configPath: configPathSchema,

    // Undo/Redo
    historyLimit: historyLimitSchema,
    undoRedoHistoryLimit: undoRedoHistoryLimitSchema,

    // Organization (extended)
    processNew: processNewSchema,
    clusterBatch: clusterBatchSchema,
    identifyOutliers: identifyOutliersSchema,
    clusterSuggestions: clusterSuggestionsSchema,

    // Suggestions (extended)
    analyzeFolderStructure: analyzeFolderStructureSchema,
    suggestNewFolder: suggestNewFolderSchema,

    // Analysis History (extended)
    analysisHistorySearch: analysisHistorySearchSchema,
    analysisHistorySearchTuple: analysisHistorySearchTupleSchema,
    embeddingPolicy: embeddingPolicySchema,
    analysisExportFormat: analysisExportFormatSchema,
    transcriptExport: transcriptExportSchema,
    timelineOptions: timelineOptionsSchema,

    // Backup
    backupPath: backupPathSchema,

    ipcOptionalPayload: ipcOptionalPayloadSchema,
    ipcVoidPayload: ipcVoidPayloadSchema,

    dismissDegradedFlagPayload: dismissDegradedFlagPayloadSchema,
    openLegalDocumentPayload: openLegalDocumentPayloadSchema,
    themeName: themeNameSchema,

    // License / entitlement
    licenseActivate: licenseActivateSchema,
    licenseStatus: ipcVoidPayloadSchema,
    licenseDeactivate: ipcVoidPayloadSchema,

    // MCP — zero-arg handlers accept undefined/null/{} from preload bridges
    // that may pass any of the three when no payload is required.
    mcpEnable: ipcVoidPayloadSchema,
    mcpDisable: ipcVoidPayloadSchema,
    mcpStatus: ipcVoidPayloadSchema,
    mcpRotateToken: ipcVoidPayloadSchema,
    mcpGetConfigSnippet: z.object({ client: z.enum(['claudeDesktop', 'cursor', 'zed']) }).strict(),
    mcpTestConnection: ipcVoidPayloadSchema,

    // AI Provider IPC schemas (T7-T8 multi-provider AI work)
    aiProviderGetConfig: ipcVoidPayloadSchema,
    aiProviderSetProviderConfig: z
      .object({
        provider: z.enum(['local', 'anthropic', 'openaiCompatible']),
        config: z
          .object({
            enabled: z.boolean().optional(),
            displayName: z.string().min(1).max(100).optional(),
            model: z.string().min(1).max(100).optional(),
            // Same rule as the persisted ai schema (services/ai/providerBaseUrl):
            // a renderer must not be able to redirect requests + the bearer key
            // to an attacker-controlled host.
            baseUrl: z
              .string()
              .url()
              .refine(isAllowedProviderBaseUrl, { message: PROVIDER_BASE_URL_RULE })
              .optional(),
            // null clears the cap (the handler removes the key).
            spendCapMonthlyUsd: z.number().nonnegative().max(10000).nullable().optional()
          })
          .strict()
      })
      .strict(),
    aiProviderSetKey: z
      .object({
        provider: z.enum(['anthropic', 'openaiCompatible']),
        key: z.string().min(1).max(500),
        allowPlaintext: z.boolean().optional()
      })
      .strict(),
    aiProviderGetKeyStatus: z
      .object({
        provider: z.enum(['anthropic', 'openaiCompatible'])
      })
      .strict(),
    aiProviderRemoveKey: z
      .object({
        provider: z.enum(['anthropic', 'openaiCompatible'])
      })
      .strict(),
    aiProviderTestProvider: z
      .object({
        provider: z.enum(['local', 'anthropic', 'openaiCompatible'])
      })
      .strict(),
    aiProviderGetUsage: ipcVoidPayloadSchema,
    aiProviderSetRouting: z
      .object({
        default: z.enum(['local', 'anthropic', 'openaiCompatible']).optional(),
        // Per-operation choice; null clears it so the operation follows `default`.
        perOperation: z
          .object({
            analyze: z.enum(['local', 'anthropic', 'openaiCompatible']).nullable().optional(),
            chat: z.enum(['local', 'anthropic', 'openaiCompatible']).nullable().optional(),
            suggest: z.enum(['local', 'anthropic', 'openaiCompatible']).nullable().optional()
          })
          .strict()
          .optional(),
        // null value means "clear this folder's override"; non-null sets it.
        perFolder: z
          .record(z.string(), z.enum(['local', 'anthropic', 'openaiCompatible']).nullable())
          .optional()
      })
      .strict(),
    aiProviderAcknowledgeCloud: ipcVoidPayloadSchema
  };

  // Fix 2B: Replace z.any() with typed schema.
  // Uses record() instead of full smartFolderSchema because the match endpoint
  // receives partial folder objects (id + name + description, no path required).
  const schemaFolderMatch = z.object({
    text: z.string(),
    smartFolders: z.array(z.record(z.string(), z.unknown())).optional()
  });

  module.exports = {
    schemaFolderMatch,
    z,
    schemas,
    settingsSchema,
    backupPathSchema,
    zodLoadError
  };
}
