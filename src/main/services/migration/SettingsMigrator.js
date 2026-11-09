// @ts-check
/**
 * SettingsMigrator - Migrates settings schema versions
 *
 * This service normalizes settings keys and fills defaults when schema changes.
 *
 * @module services/migration/SettingsMigrator
 */

const fs = require('fs').promises;
const { createLogger } = require('../../../shared/logger');
const {
  AI_DEFAULTS,
  DEFAULT_AI_MODELS,
  SETTINGS_SCHEMA_VERSION
} = require('../../../shared/constants');
const { upgradeLegacySimpleModeValues } = require('../../../shared/experienceMode');
const { isNotFoundError } = require('../../../shared/errorClassifier');
const { stripBom } = require('../../../shared/safeJsonOps');

const logger = createLogger('SettingsMigrator');

// Current settings schema version
const CURRENT_SCHEMA_VERSION = SETTINGS_SCHEMA_VERSION;

// Setting key migrations: old key -> new key (null = remove)
/** @type {Record<string, string|null>} */
const KEY_MIGRATIONS = {
  llamaTextModel: 'textModel',
  llamaVisionModel: 'visionModel',
  llamaEmbeddingModel: 'embeddingModel',
  // Legacy Ollama/ChromaDB keys (replaced by in-process node-llama-cpp + Orama)
  ollamaHost: null,
  autoUpdateOllama: null,
  autoUpdateChromaDb: null,
  enableChromaLearningSync: null,
  enableChromaLearningDryRun: null
};

// Default values for new settings (from aiModelConfig)
const NEW_DEFAULTS = {
  textModel: AI_DEFAULTS.TEXT?.MODEL ?? DEFAULT_AI_MODELS.TEXT_ANALYSIS,
  visionModel: AI_DEFAULTS.IMAGE?.MODEL ?? DEFAULT_AI_MODELS.IMAGE_ANALYSIS,
  embeddingModel: AI_DEFAULTS.EMBEDDING?.MODEL ?? DEFAULT_AI_MODELS.EMBEDDING,
  llamaGpuLayers: -1, // Auto-detect
  llamaContextSize: 8192,
  vectorDbPersistPath: 'vector-db', // Relative to userData
  settingsSchemaVersion: CURRENT_SCHEMA_VERSION
};

/**
 * Repair values an older build accepted but today's validation rules reject
 * (e.g. a maxConcurrentAnalysis above the current cap, a string-typed
 * confidenceThreshold). The migrator reads the raw file and hands it to the
 * strict save(), so one such value would otherwise fail the whole migration
 * on every launch. Each rejected value is coerced the way a normal load
 * coerces it (sanitizeSettings) or, when that yields nothing valid, dropped
 * so the default applies. Mutates `settings`; returns the repaired keys.
 * @param {Record<string, any>} settings
 * @returns {{ coerced: string[], dropped: string[] }}
 */
function repairInvalidValues(settings) {
  // Loaded on use: the validation rules pull in the full defaults module.
  const { validateSettings, sanitizeSettings } = require('../../../shared/settingsValidation');
  /** @type {string[]} */
  const coerced = [];
  /** @type {string[]} */
  const dropped = [];
  for (const [key, value] of Object.entries(settings)) {
    if (validateSettings({ [key]: value }).valid) continue;
    const repaired = sanitizeSettings({ [key]: value })[key];
    if (repaired !== undefined && validateSettings({ [key]: repaired }).valid) {
      settings[key] = repaired;
      coerced.push(key);
    } else {
      delete settings[key];
      dropped.push(key);
    }
  }
  return { coerced, dropped };
}

class SettingsMigrator {
  constructor(/** @type {any} */ settingsService) {
    this._settingsService = settingsService;
    /** @type {string[]} */
    this._migrationLog = [];
  }

  /**
   * Read the settings file exactly as it exists on disk.
   *
   * This MUST NOT go through SettingsService._loadRaw()/load():
   * - mergeWithDefaults() injects the CURRENT settingsSchemaVersion into
   *   files that predate version stamping, so needsMigration() would see
   *   the latest version and every version-gated migration (e.g. the v3
   *   legacy Simple-mode flip) would silently never run — and the next
   *   ordinary save would stamp the un-migrated file permanently.
   * - sanitizeSettings() strips the deprecated llama-/ollama-prefixed keys
   *   that KEY_MIGRATIONS exists to read, silently discarding users' old
   *   model selections instead of migrating them.
   *
   * @returns {Promise<Record<string, any>|null>} parsed on-disk settings,
   *   or null when the file does not exist (first launch — nothing to
   *   migrate). Parse/read errors propagate so callers can decide
   *   (needsMigration treats them as "migration may be required" and the
   *   normal load path's corruption recovery handles the file itself).
   */
  async _loadSettings() {
    const settingsPath = this._settingsService?.settingsPath;
    if (typeof settingsPath !== 'string' || !settingsPath) {
      // No file path available (unusual test double) — fall back to the
      // service's loader even though it may hide legacy keys.
      return this._settingsService.load();
    }
    try {
      const raw = await fs.readFile(settingsPath, 'utf-8');
      // User-editable: tolerate the BOM Notepad / PowerShell 5.1 write.
      return JSON.parse(stripBom(raw));
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Check if migration is needed
   * @returns {Promise<boolean>}
   */
  async needsMigration() {
    try {
      const settings = await this._loadSettings();
      if (settings === null) {
        // No settings file yet (first launch) — nothing to migrate; the
        // first save will stamp the current schema version.
        return false;
      }
      const version = settings?.settingsSchemaVersion || 1;

      // Check for old keys that need migration
      const hasOldKeys = Object.keys(KEY_MIGRATIONS).some((key) => {
        return (
          settings?.[key] !== undefined &&
          /** @type {Record<string, any>} */ (KEY_MIGRATIONS)[key] !== null
        );
      });

      // Check for Ollama-era model names (contain ':' tag separator)
      const modelKeys = ['textModel', 'visionModel', 'embeddingModel'];
      const hasOllamaNames = modelKeys.some((key) => {
        const val = settings?.[key];
        return typeof val === 'string' && val.includes(':') && !val.endsWith('.gguf');
      });

      return version < CURRENT_SCHEMA_VERSION || hasOldKeys || hasOllamaNames;
    } catch (error) {
      logger.warn('[SettingsMigrator] Error checking migration status:', error.message);
      logger.warn(
        '[SettingsMigrator] Assuming migration may be required because status could not be determined'
      );
      return true;
    }
  }

  /**
   * Perform settings migration
   * @returns {Promise<{success: boolean, migrated: string[], errors: string[]}>}
   */
  async migrate() {
    this._migrationLog = [];
    /** @type {string[]} */
    const errors = [];
    /** @type {string[]} */
    const migrated = [];

    try {
      logger.info('[SettingsMigrator] Starting settings migration...');

      const settings = await this._loadSettings();
      if (settings === null) {
        logger.info('[SettingsMigrator] No settings file on disk - nothing to migrate');
        return { success: true, migrated: [], errors: [] };
      }
      const currentVersion = settings?.settingsSchemaVersion || 1;

      // Check if Ollama-era model names need cleanup (even at current version)
      const modelKeys = ['textModel', 'visionModel', 'embeddingModel'];
      const hasOllamaNames = modelKeys.some((key) => {
        const val = settings?.[key];
        return typeof val === 'string' && val.includes(':') && !val.endsWith('.gguf');
      });

      if (currentVersion >= CURRENT_SCHEMA_VERSION && !hasOllamaNames) {
        logger.info('[SettingsMigrator] Settings already at current version');
        return { success: true, migrated: [], errors: [] };
      }

      const newSettings = { ...settings };

      // Migrate keys
      for (const [oldKey, newKey] of Object.entries(KEY_MIGRATIONS)) {
        if (settings?.[oldKey] !== undefined) {
          if (newKey === null) {
            // Remove deprecated key
            delete newSettings[oldKey];
            migrated.push(`Removed deprecated setting: ${oldKey}`);
            this._log(`Removed: ${oldKey}`);
          } else if (newSettings[newKey] === undefined) {
            // Migrate to new key
            newSettings[newKey] = settings[oldKey];
            delete newSettings[oldKey];
            migrated.push(`Migrated: ${oldKey} -> ${newKey}`);
            this._log(`Migrated: ${oldKey} -> ${newKey} = ${settings[oldKey]}`);
          }
        }
      }

      // Replace Ollama-era model names (contain ':' tag separator) with GGUF defaults.
      // e.g. 'llama3.2:latest' → 'Mistral-7B-Instruct-v0.3-Q4_K_M.gguf'
      const modelDefaults = {
        textModel: NEW_DEFAULTS.textModel,
        visionModel: NEW_DEFAULTS.visionModel,
        embeddingModel: NEW_DEFAULTS.embeddingModel
      };
      for (const [key, defaultValue] of Object.entries(modelDefaults)) {
        const current = newSettings[key];
        if (typeof current === 'string' && current.includes(':') && !current.endsWith('.gguf')) {
          newSettings[key] = defaultValue;
          migrated.push(`Replaced Ollama-era model name: ${key} (${current} → ${defaultValue})`);
          this._log(`Ollama cleanup: ${key} = ${current} → ${defaultValue}`);
        }
      }

      // Add new defaults for missing settings
      for (const [key, value] of Object.entries(NEW_DEFAULTS)) {
        if (newSettings[key] === undefined) {
          newSettings[key] = value;
          migrated.push(`Added default: ${key}`);
          this._log(`Added default: ${key} = ${value}`);
        }
      }

      // v3: one-time flip of pre-2026-04 legacy Simple-mode embedding values
      // ('skip'/'manual'/false) to the recommended defaults. Runs only when
      // upgrading past v3 so that post-migration user choices of these same
      // values stick (previously applyExperienceModeSettings reverted them on
      // every save).
      if (currentVersion < 3) {
        for (const key of upgradeLegacySimpleModeValues(newSettings)) {
          migrated.push(`Upgraded legacy Simple-mode value: ${key}`);
          this._log(`Legacy Simple-mode upgrade: ${key} = ${newSettings[key]}`);
        }
      }

      // Update schema version
      newSettings.settingsSchemaVersion = CURRENT_SCHEMA_VERSION;

      const repaired = repairInvalidValues(newSettings);
      for (const key of repaired.coerced) {
        migrated.push(`Coerced invalid legacy value: ${key}`);
        this._log(`Coerced invalid value: ${key} = ${newSettings[key]}`);
      }
      for (const key of repaired.dropped) {
        migrated.push(`Dropped invalid legacy value: ${key}`);
        this._log(`Dropped invalid value: ${key}`);
      }
      if (repaired.coerced.length > 0 || repaired.dropped.length > 0) {
        logger.warn('[SettingsMigrator] Repaired settings values rejected by current rules', {
          coerced: repaired.coerced,
          dropped: repaired.dropped
        });
      }

      // Save migrated settings
      await this._settingsService.save(newSettings);

      logger.info('[SettingsMigrator] Migration completed', {
        migratedCount: migrated.length,
        fromVersion: currentVersion,
        toVersion: CURRENT_SCHEMA_VERSION
      });

      return { success: true, migrated, errors };
    } catch (error) {
      logger.error('[SettingsMigrator] Migration failed:', error);
      errors.push(error.message);
      return { success: false, migrated, errors };
    }
  }

  /**
   * Get migration log
   * @returns {string[]}
   */
  getMigrationLog() {
    return [...this._migrationLog];
  }

  /**
   * Validate current settings
   * @returns {Promise<{valid: boolean, issues: string[]}>}
   */
  async validateSettings() {
    const issues = [];

    try {
      const settings = await this._loadSettings();
      if (settings === null) {
        // No file yet — defaults apply, nothing to validate.
        return { valid: true, issues: [] };
      }

      // Check for deprecated settings that shouldn't exist
      /** @type {string[]} */
      const deprecatedKeys = [];
      for (const key of deprecatedKeys) {
        if (settings?.[key] !== undefined) {
          issues.push(`Deprecated setting still present: ${key}`);
        }
      }

      // Check for required new settings
      const requiredKeys = ['textModel', 'embeddingModel'];
      for (const key of requiredKeys) {
        if (!settings?.[key]) {
          issues.push(`Missing required setting: ${key}`);
        }
      }

      // Validate schema version
      if ((settings?.settingsSchemaVersion || 0) < CURRENT_SCHEMA_VERSION) {
        issues.push(`Settings schema out of date (v${settings?.settingsSchemaVersion || 1})`);
      }

      return {
        valid: issues.length === 0,
        issues
      };
    } catch (error) {
      return {
        valid: false,
        issues: [`Validation error: ${error.message}`]
      };
    }
  }

  _log(/** @type {any} */ message) {
    this._migrationLog.push(`[${new Date().toISOString()}] ${message}`);
  }
}

// Singleton
/** @type {SettingsMigrator|null} */
let instance = null;

function getInstance(/** @type {any} */ settingsService) {
  if (!instance) {
    if (!settingsService) {
      const { getInstance: getSettingsService } = require('../SettingsService');
      settingsService = getSettingsService();
    }
    instance = new SettingsMigrator(settingsService);
  }
  return instance;
}

function createInstance(/** @type {any} */ settingsService) {
  return new SettingsMigrator(settingsService);
}

module.exports = {
  SettingsMigrator,
  getInstance,
  createInstance,
  CURRENT_SCHEMA_VERSION
};
