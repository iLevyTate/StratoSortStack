// @ts-check
/**
 * DataMigrationService - Handles vector data migration between schema versions.
 *
 * In the fully in-process stack, migrations are handled by rebuilding embeddings
 * when needed. This service currently reports that no migration is required.
 *
 * @module services/migration/DataMigrationService
 */

const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('DataMigrationService');

// Legacy paths to check and clean up
const LEGACY_PATHS = [
  'chroma_db',
  'chromadb',
  'chroma-data',
  'vector_storage', // Potential old name
  'chroma.sqlite3' // Potential single file
];

// Migration status constants
const MIGRATION_STATUS = {
  NOT_STARTED: 'not_started',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  NOT_NEEDED: 'not_needed'
};

class DataMigrationService {
  constructor() {
    this._status = MIGRATION_STATUS.NOT_STARTED;
    this._progress = 0;
    this._totalItems = 0;
    /** @type {string[]} */
    this._errors = [];
    /** @type {string|null} */
    this._userDataPath = null;
  }

  async _getUserDataPath() {
    if (this._userDataPath) return this._userDataPath;
    // Handle both main process and renderer/test environments if needed
    try {
      this._userDataPath = app.getPath('userData');
    } catch {
      // Fallback for tests or if app is not available
      this._userDataPath = process.env.APPDATA || process.cwd();
    }
    return this._userDataPath;
  }

  /**
   * Check if migration (cleanup) is needed
   * @returns {Promise<boolean>}
   */
  async needsMigration() {
    try {
      const userData = await this._getUserDataPath();

      for (const legacyName of LEGACY_PATHS) {
        const legacyPath = path.join(userData, legacyName);
        try {
          await fs.access(legacyPath);
          logger.info(`[DataMigrationService] Found legacy data at: ${legacyPath}`);
          return true; // Found at least one legacy path
        } catch {
          // Path doesn't exist, continue checking
        }
      }

      return false;
    } catch (error) {
      // Fail-OPEN to match SettingsMigrator.needsMigration semantics: if we
      // can't tell whether legacy data exists, assume it might so the next
      // pass attempts the cleanup. Returning `false` (the previous behavior)
      // would silently skip cleanup forever on a transient FS error and
      // leave legacy directories in place indefinitely. Cleanup itself is
      // idempotent — re-running on already-clean state is a no-op.
      logger.warn(
        '[DataMigrationService] Error checking for legacy data; assuming migration may be required:',
        error
      );
      return true;
    }
  }

  /**
   * Get current migration status
   * @returns {{status: string, progress: number, totalItems: number, errors: string[]}}
   */
  getStatus() {
    return {
      status: this._status,
      progress: this._progress,
      totalItems: this._totalItems,
      errors: [...this._errors]
    };
  }

  /**
   * Start data migration (Full Reset / Cleanup)
   * @param {object} options - Migration options
   * @param {(...args: any[]) => any} [options.onProgress] - Progress callback
   * @returns {Promise<{success: boolean, migratedCount: number, errors: string[], message: string}>}
   */
  async migrate(options = {}) {
    const { onProgress } = options;
    this._status = MIGRATION_STATUS.IN_PROGRESS;
    this._errors = [];

    try {
      const userData = await this._getUserDataPath();
      let foundLegacy = false;
      const removedPaths = [];

      // Calculate total steps (rough estimate based on paths to check)
      const totalSteps = LEGACY_PATHS.length;
      let currentStep = 0;

      for (const legacyName of LEGACY_PATHS) {
        const legacyPath = path.join(userData, legacyName);
        currentStep++;
        const progressPercent = Math.round((currentStep / totalSteps) * 100);

        try {
          await fs.access(legacyPath);
          foundLegacy = true;

          logger.info(`[DataMigrationService] Removing legacy data: ${legacyPath}`);
          if (onProgress) {
            onProgress({
              progress: progressPercent,
              message: `Removing legacy data: ${legacyName}`
            });
          }

          // Recursive delete
          await fs.rm(legacyPath, { recursive: true, force: true });
          removedPaths.push(legacyPath);
        } catch (error) {
          if (error.code !== 'ENOENT') {
            logger.warn(`[DataMigrationService] Failed to remove ${legacyPath}:`, error.message);
            this._errors.push(`Failed to remove ${legacyName}: ${error.message}`);
          }
        }
      }

      if (!foundLegacy) {
        logger.info('[DataMigrationService] No legacy data found during migration execution');
        this._status = MIGRATION_STATUS.NOT_NEEDED;
        if (onProgress) onProgress({ progress: 100, message: 'No legacy data found' });
        return {
          success: true,
          migratedCount: 0,
          errors: [],
          message: 'No legacy data found'
        };
      }

      this._status =
        this._errors.length === 0 ? MIGRATION_STATUS.COMPLETED : MIGRATION_STATUS.FAILED;
      this._progress = 100;

      const successMessage = `Cleanup complete. Removed ${removedPaths.length} legacy data locations.`;
      logger.info(`[DataMigrationService] ${successMessage}`);

      if (onProgress) {
        onProgress({ progress: 100, message: 'Legacy data cleanup completed' });
      }

      return {
        success: this._errors.length === 0,
        migratedCount: removedPaths.length,
        errors: this._errors,
        message: successMessage
      };
    } catch (error) {
      logger.error('[DataMigrationService] Migration failed:', error);
      this._status = MIGRATION_STATUS.FAILED;
      this._errors.push(error.message);
      return {
        success: false,
        migratedCount: 0,
        errors: this._errors,
        message: `Migration failed: ${error.message}`
      };
    }
  }

  /**
   * Cleanup legacy data (no-op in the in-process stack)
   * @returns {Promise<boolean>}
   */
  async cleanupOldData() {
    return true;
  }

  /**
   * Reset migration state
   */
  reset() {
    this._status = MIGRATION_STATUS.NOT_STARTED;
    this._progress = 0;
    this._totalItems = 0;
    this._errors = [];
  }
}

// Singleton
/** @type {DataMigrationService|null} */
let instance = null;

function getInstance() {
  if (!instance) {
    instance = new DataMigrationService();
  }
  return instance;
}

function createInstance() {
  return new DataMigrationService();
}

module.exports = {
  DataMigrationService,
  getInstance,
  createInstance,
  MIGRATION_STATUS
};
