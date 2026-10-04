// @ts-check
/**
 * Default Settings Configuration
 * Single source of truth for all default settings
 */

const { CONCURRENCY } = require('./performanceConstants');
const { AI_DEFAULTS, DEFAULT_AI_MODELS, SETTINGS_SCHEMA_VERSION } = require('./constants');
const { DEFAULT_CHAT_PERSONA_ID } = require('./chatPersonas');
const { EXPERIENCE_MODES } = require('./experienceMode');

/** @type {Record<string, any>} */
const DEFAULT_SETTINGS = {
  // UI
  notifications: true,
  experienceMode: EXPERIENCE_MODES.SIMPLE,
  developerGraphEnabled: true,
  // Application log verbosity. Applied to the structured logger at startup and
  // whenever settings change (shared/logger.setGlobalLogLevel). 'info' matches
  // the packaged-build default; dev builds still honor NODE_ENV-based debug
  // when this is left at the default.
  loggingLevel: 'info',
  // Notification display options - where to show notifications
  // 'both' = UI toast + system tray, 'ui' = UI only, 'tray' = tray only, 'none' = disabled
  notificationMode: 'both',
  // Notify when files are analyzed by watchers (smart folder/download)
  notifyOnAutoAnalysis: true,
  // Notify when files don't meet confidence threshold for auto-organization
  notifyOnLowConfidence: true,
  // Behavior
  defaultSmartFolderLocation: 'Documents',
  // Last browsed path - remembers the last folder opened in file dialogs
  lastBrowsedPath: null,
  // Hardware-aware concurrency. When true (default), the effective analysis
  // concurrency is driven by the live hardware probe (getRecommendedConcurrency)
  // and `maxConcurrentAnalysis` is ignored. Turning this off lets power users
  // pin an explicit `maxConcurrentAnalysis` value. Existing installs that lack
  // this key resolve to `true` (via `?? true`), so they automatically adopt the
  // hardware-aware behavior on upgrade and any stale numeric override is ignored.
  autoConcurrency: true,
  maxConcurrentAnalysis: CONCURRENCY.DEFAULT_WORKERS,
  autoOrganize: false,
  backgroundMode: false,
  launchOnStartup: false,
  // Organization Confidence Threshold (files must meet this confidence to be auto-organized to suggested folder)
  // Files below this threshold stay where they are and are flagged for review
  // (decision D2); they are never moved into Uncategorized.
  confidenceThreshold: 0.75,
  // Smart folder routing: Auto uses folder-description vectors when they exist
  // (or can be built), hybrid lets the language model propose first, llm skips
  // vectors for destination choice, embedding always prefers meaning.
  smartFolderRoutingMode: 'auto',
  // Naming convention defaults (used by auto-organize / download watcher)
  namingConvention: 'subject-date',
  dateFormat: 'YYYY-MM-DD',
  caseConvention: 'kebab-case',
  separator: '-',
  // AI - model defaults imported from constants.js for single source of truth
  textModel: DEFAULT_AI_MODELS.TEXT_ANALYSIS,
  visionModel: DEFAULT_AI_MODELS.IMAGE_ANALYSIS,
  embeddingModel: DEFAULT_AI_MODELS.EMBEDDING,
  // First-run download consent. False by default so core models (embedding +
  // text) auto-download in the background on fresh installs. Set to true when
  // the user picks "Continue with limited AI" on the welcome screen; while
  // true, core/backgroundSetup.downloadMissingModels() is a no-op. Cleared
  // when the user explicitly starts a download in the ModelSetupWizard.
  modelAutoDownloadSkipped: false,
  // Llama-specific tuning (in-process)
  llamaGpuLayers: AI_DEFAULTS?.TEXT?.GPU_LAYERS ?? -1,
  llamaContextSize: AI_DEFAULTS?.TEXT?.CONTEXT_SIZE ?? 8192,
  // Vector DB persistence (relative to userData) — internal-only; no Settings UI.
  vectorDbPersistPath: 'vector-db',
  // Settings schema version for migrations — internal-only; no Settings UI.
  settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
  // Embedding workflow controls
  // - during_analysis: embed while analyzing (current/default)
  // - after_organize: defer file embeddings until after moves/renames
  // - manual: never auto-embed; user can rebuild manually
  embeddingTiming: 'during_analysis',
  // Default policy for newly analyzed files (per-file overrides can be set later)
  // - embed: normal local embeddings
  // - web_only: do not embed locally (intended for web-search-only workflows)
  // - skip: do not embed
  defaultEmbeddingPolicy: 'embed',
  // Embedding scope: which files should be embedded
  // - all_analyzed: embed every file that passes analysis (broadest search coverage)
  // - smart_folders_only: only embed files residing in a configured smart folder
  embeddingScope: 'all_analyzed',
  chatPersona: DEFAULT_CHAT_PERSONA_ID,
  // Free-text override appended to the selected persona's guidance during
  // ChatService prompt construction. Empty by default; capped at 2 KB by
  // settings validation. Functions as a per-user "system prompt" knob.
  chatPersonaCustomGuidance: '',
  // Global "how to organize" instructions injected into every organization
  // prompt (document + image analysis and alternative suggestions). Workspace-
  // wide guidance, distinct from per-folder descriptions. Empty by default;
  // capped at 2 KB by settings validation.
  organizationCustomGuidance: '',
  // User-defined chat personas. Each entry has the same shape as a
  // built-in ({ id, label, description, guidance }) but with id prefixed
  // `custom:` so it cannot collide with built-ins. Capped at 20
  // entries, guidance capped at 2 KB — enforced in
  // shared/settingsValidation.js. Empty default; Settings UI manages
  // the list.
  customChatPersonas: [],
  chatResponseMode: 'fast', // Settings → Chat Persona → Response Detail; mirrored in Knowledge OS chat
  // File Size Limits (in bytes). Type-specific limits gate the analysis
  // pipeline (image/document/text extractors). There is intentionally no
  // single "general" maxFileSize — it had no consumer and conflicted with the
  // type-specific gates, so it was removed.
  maxImageFileSize: 100 * 1024 * 1024, // 100MB
  maxDocumentFileSize: 200 * 1024 * 1024, // 200MB
  maxTextFileSize: 50 * 1024 * 1024, // 50MB
  // UI Limits
  // 24 hours: matches the implicit v2.0.9 hard-coded `STATE_TTL_MS` so users
  // who close the app overnight still find their phase + selection state on
  // next launch. Earlier post-2.0.9 builds shipped a 1-hour default which
  // made overnight reloads silently lose session state — flagged as
  // regression in the post-2.0.9 audit. Power users can shorten it via
  // Settings if they prefer fast cleanup.
  // How long workflow phase/selection state survives across app restarts — internal-only;
  // read by store/index.js; no Settings UI (fixed 24h default matches legacy STATE_TTL_MS).
  workflowRestoreMaxAge: 24 * 60 * 60 * 1000, // 24 hours - how long to keep workflow state
  saveDebounceMs: 1000, // Internal-only: Redux persistence debounce; no Settings UI.

  // Chunking: auto-generate chunk embeddings during file analysis.
  // Settings → Embedding behavior → "Auto-generate Chunk Embeddings" toggle.
  autoChunkOnAnalysis: true,
  // Graph-aware retrieval (GraphRAG-lite)
  graphExpansionEnabled: true,
  graphExpansionWeight: 0.2,
  graphExpansionMaxNeighbors: 120,
  chunkContextEnabled: true,
  chunkContextMaxNeighbors: 1,
  // Exclusion globs (Settings → Exclusion rules). Empty by default. The
  // Downloads watcher, the Smart Folder watchers and the triage sweep all
  // skip what is listed here; the sweep and the Downloads watcher also apply
  // DEFAULT_EXCLUSION_GLOBS (shared/config/exclusionRulesSchema.js) on top,
  // whether or not this list is empty. Stamping an explicit [] keeps the key
  // present so the Settings editor round-trips reliably and the
  // validation/allowlist/Zod keysets stay in parity.
  downloadsTriageExclusions: [],
  // Auto-update and watcher toggles — both appear in the allowedKeys list and
  // the validation schema, but were missing from DEFAULT_SETTINGS. That made
  // `settings.autoUpdateCheck` and `settings.smartFolderWatchEnabled`
  // `undefined` on fresh installs, forcing every downstream reader to use
  // falsy/default-OR patterns and making migrations surprising. Stamping
  // explicit defaults closes that gap.
  //
  // We default autoUpdateCheck=true because the app ships with code-signed
  // auto-update infrastructure and users overwhelmingly benefit from timely
  // security fixes; power users can still disable it via Settings.
  autoUpdateCheck: true,
  // smartFolderWatchEnabled defaults to true so that files dropped into an
  // existing smart folder are picked up out of the box — the feature has
  // been opt-out for a while, we just never encoded the default.
  smartFolderWatchEnabled: true,
  // Describe video keyframes with the vision model during media analysis.
  // Off by default: each video adds ffmpeg scene detection plus up to six
  // vision-model calls (tens of seconds on CPU). Settings → Processing limits.
  captionVideoKeyframes: false,
  // Advanced-mode values parked while Simple mode is on. Simple mode
  // enforces SIMPLE_MODE_ENFORCED_VALUES over five hidden controls; the
  // user's own choices for those controls are kept here and put back when
  // they switch to Advanced (shared/experienceMode.carryAdvancedValuesAcrossModeSwitch).
  // Internal-only; no Settings UI. Null when nothing is parked.
  advancedModeValues: null
};

/**
 * Defaults this app wrote into settings.json in earlier builds and has since
 * changed. Every save used to persist the whole merged settings object, so a
 * stored value equal to one of these was written by the app, never chosen by
 * the user; on load it is treated as unset so the current default applies.
 * Add an entry whenever a default changes, with the value it replaces.
 *
 * - workflowRestoreMaxAge: builds after v2.0.9 and before 2026-06-01 shipped
 *   a 1-hour default; 24 hours restored the v2.0.9 behaviour.
 *
 * @type {Record<string, any[]>}
 */
const SUPERSEDED_DEFAULTS = {
  workflowRestoreMaxAge: [60 * 60 * 1000]
};

/**
 * Keys whose presence in settings.json carries meaning even when the value
 * equals the default, so they are never stripped from the persisted file:
 *
 * - settingsSchemaVersion: SettingsMigrator reads the raw file and treats a
 *   missing stamp as v1.
 * - experienceMode: a file without it predates experience modes and is
 *   hydrated as Advanced (SettingsService._hydrateLoadedSettings).
 * - autoConcurrency: a file with maxConcurrentAnalysis and no autoConcurrency
 *   is a v2 file whose manual cap must keep working, so the key must stay
 *   once it has been written.
 */
const PERSISTED_WHEN_DEFAULT = Object.freeze([
  'settingsSchemaVersion',
  'experienceMode',
  'autoConcurrency'
]);

/**
 * Structural equality for setting values: primitives by value, arrays and
 * plain objects by JSON shape (order-sensitive, which is what settings need).
 * @param {any} a
 * @param {any} b
 */
function settingValuesEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * True when `value` is the current default for `key` or a default this app
 * shipped earlier (SUPERSEDED_DEFAULTS). Unknown keys are never defaults.
 * @param {string} key
 * @param {any} value
 */
function isDefaultSettingValue(key, value) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) return false;
  if (settingValuesEqual(value, DEFAULT_SETTINGS[key])) return true;
  const superseded = SUPERSEDED_DEFAULTS[key];
  return Array.isArray(superseded) && superseded.some((prior) => settingValuesEqual(value, prior));
}

/**
 * Drop every key whose value is a current or superseded default, except the
 * keys in PERSISTED_WHEN_DEFAULT. The result is what settings.json should
 * hold: the user's own choices, so a later default change reaches every
 * install that never touched that setting. Also applied when reading the
 * file, so a default stamped by an earlier build is treated as unset.
 *
 * @param {Record<string, any>|null|undefined} settings
 * @returns {Record<string, any>}
 */
function stripDefaultValues(settings) {
  if (!settings || typeof settings !== 'object') return {};
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of Object.entries(settings)) {
    if (PERSISTED_WHEN_DEFAULT.includes(key)) {
      out[key] = value;
      continue;
    }
    if (isDefaultSettingValue(key, value)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * FIX Bug 23: Merge user settings with defaults, applying type validation.
 *
 * When a user override has the wrong type (e.g., a string where a number is expected),
 * that key is dropped and the default value is used instead. This prevents invalid
 * configurations from propagating through the application.
 *
 * @param {Object} overrides - User-provided settings overrides
 * @returns {Record<string, any>} Merged settings with type-safe values
 */
function mergeWithDefaults(overrides) {
  if (!overrides || typeof overrides !== 'object') {
    return { ...DEFAULT_SETTINGS };
  }

  const merged = { ...DEFAULT_SETTINGS };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) {
      // Preserve explicit null (e.g., lastBrowsedPath: null)
      if (value === null && key in DEFAULT_SETTINGS) {
        merged[key] = value;
      }
      continue;
    }

    const defaultValue = DEFAULT_SETTINGS[key];

    // If no default exists, this is an unknown key -- pass it through
    if (defaultValue === undefined || defaultValue === null) {
      merged[key] = value;
      continue;
    }

    // Type-check: ensure the override matches the default's type
    if (typeof value !== typeof defaultValue) {
      // Type mismatch -- discard the override, keeping the default
      try {
        const { createLogger } = require('./logger');
        createLogger('DefaultSettings').warn(
          '[DefaultSettings] Type mismatch for setting, using default',
          {
            key,
            expected: typeof defaultValue,
            got: typeof value
          }
        );
      } catch {
        // Logger may not be available in all contexts
      }
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

module.exports = {
  DEFAULT_SETTINGS,
  SUPERSEDED_DEFAULTS,
  PERSISTED_WHEN_DEFAULT,
  mergeWithDefaults,
  isDefaultSettingValue,
  stripDefaultValues
};
