// @ts-check
/**
 * SettingsBackupService
 * Handles backup, restore, and cleanup operations for settings files.
 * Extracted from SettingsService for better separation of concerns.
 */

const { app } = require('electron');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { atomicFileOps } = require('../../shared/atomicFileOperations');
const { assertBackupPathContained } = require('../../shared/backupPathGuard');
const { validateSettings, sanitizeSettings } = require('../../shared/settingsValidation');
const { EXPERIENCE_MODES, applyExperienceModeSettings } = require('../../shared/experienceMode');
const { logger: baseLogger, createLogger } = require('../../shared/logger');
const { LIMITS } = require('../../shared/performanceConstants');
const { SETTINGS_SCHEMA_VERSION } = require('../../shared/constants');
const { stableStringify } = require('../../shared/safeJsonOps');

const logger =
  typeof createLogger === 'function' ? createLogger('SettingsBackupService') : baseLogger;
if (typeof createLogger !== 'function' && logger?.setContext) {
  logger.setContext('SettingsBackupService');
}

class SettingsBackupService {
  /**
   * Create a new SettingsBackupService
   * @param {object} options - Configuration options
   * @param {string} options.backupDir - Directory for backup files
   * @param {number} [options.maxBackups] - Maximum number of backups to retain
   * @param {object} options.defaults - Default settings object
   * @param {(...args: any[]) => any} options.loadSettings - Function to load current settings
   */
  constructor({ backupDir, maxBackups, defaults, loadSettings }) {
    this.backupDir = backupDir || path.join(app.getPath('userData'), 'settings-backups');
    this.maxBackups = maxBackups || LIMITS.MAX_SETTINGS_BACKUPS;
    this.defaults = defaults;
    this._loadSettings = loadSettings;
  }

  /**
   * Validate that a path is within the backup directory (path traversal protection)
   * @param {string} backupPath - Path to validate
   * @throws {Error} If path is outside backup directory
   */
  _validateBackupPath(backupPath) {
    assertBackupPathContained(backupPath, this.backupDir);
  }

  /**
   * Create a backup of current settings.
   *
   * Two pools share the directory. An `automatic` backup is the pre-save
   * snapshot every settings change takes; only the newest `maxBackups` of
   * those are kept. A `manual` backup is one the user asked for; it is named
   * `settings-manual-<ts>.json`, never rotated, and goes only when the user
   * deletes it. Before the pools were separate, ten routine saves (a file
   * dialog counts as one) silently removed a backup the user had made.
   * @param {{ kind?: 'automatic' | 'manual' }} [options]
   * @returns {Promise<{success: boolean, path?: string, timestamp?: string, kind?: string, error?: string}>}
   */
  async createBackup(options = {}) {
    const kind = options?.kind === 'manual' ? 'manual' : 'automatic';
    try {
      // Ensure backup directory exists
      if (typeof fs.mkdir === 'function') {
        await fs.mkdir(this.backupDir, { recursive: true });
      }

      const settings = await this._loadSettings();

      // Create backup filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(
        this.backupDir,
        `settings-${kind === 'manual' ? 'manual-' : ''}${timestamp}.json`
      );

      // Write backup with metadata and SHA256 hash for integrity verification
      const backupData = {
        timestamp: new Date().toISOString(),
        appVersion: app.getVersion(),
        kind,
        settings
      };

      const backupJson = stableStringify(backupData, 2);

      // Calculate SHA256 hash of the backup data for integrity verification
      const hash = crypto.createHash('sha256').update(backupJson, 'utf8').digest('hex');

      // Store hash in a separate metadata object
      const backupWithHash = {
        ...backupData,
        hash
      };

      const writeContent = stableStringify(backupWithHash, 2);

      // Write using atomicFileOps when available, otherwise fall back to fs.writeFile
      if (atomicFileOps?.safeWriteFile) {
        try {
          await atomicFileOps.safeWriteFile(backupPath, writeContent);
        } catch {
          // Fall back to direct write for test environments
          await fs.writeFile(backupPath, writeContent);
        }
      } else {
        await fs.writeFile(backupPath, writeContent);
      }

      // Clean up old backups
      await this.cleanupOldBackups();

      return {
        success: true,
        path: backupPath,
        timestamp: backupData.timestamp,
        kind
      };
    } catch (error) {
      logger.error('[SettingsBackupService] Failed to create backup', {
        error: error.message
      });
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * List all available backups
   * @returns {Promise<Array<Record<string, any>>>}
   */
  /** @param {{ includeParsedTime?: boolean }} [options] */
  async listBackups(options = {}) {
    const { includeParsedTime = false } = options;
    try {
      // Ensure backup directory exists
      await fs.mkdir(this.backupDir, { recursive: true });

      // Read backup directory
      const files = await fs.readdir(this.backupDir);

      // Filter and parse backup files
      const backups = [];
      for (const file of files) {
        if (file.startsWith('settings-') && file.endsWith('.json')) {
          const filePath = path.join(this.backupDir, file);

          try {
            const content = await fs.readFile(filePath, 'utf8');
            const data = JSON.parse(content);

            const stats = await fs.stat(filePath);

            const timestamp = data.timestamp || stats.mtime.toISOString();

            backups.push({
              filename: file,
              path: filePath,
              timestamp,
              appVersion: data.appVersion || 'unknown',
              // Older manual backups predate the `kind` field; the filename
              // prefix is the durable marker.
              kind:
                data.kind === 'manual' || file.startsWith('settings-manual-')
                  ? 'manual'
                  : 'automatic',
              size: stats.size,
              _parsedTime: new Date(timestamp).getTime()
            });
          } catch (error) {
            // Skip invalid backup files
            logger.warn(`[SettingsBackupService] Invalid backup file: ${file}`, {
              error: error.message
            });
          }
        }
      }

      // Sort by timestamp (newest first)
      backups.sort((a, b) => b._parsedTime - a._parsedTime);

      if (!includeParsedTime) {
        // Remove internal _parsedTime property
        backups.forEach((backup) => {
          delete backup._parsedTime;
        });
      }

      return backups;
    } catch (error) {
      logger.error('[SettingsBackupService] Failed to list backups', {
        error: error.message
      });
      return [];
    }
  }

  /**
   * Restore settings from a backup file
   * @param {string} backupPath - Path to backup file
   * @param {(...args: any[]) => any} saveSettings - Function to save restored settings
   * @returns {Promise<Record<string, any>>}
   */
  async restoreFromBackup(backupPath, saveSettings) {
    try {
      // Validate backup path (path traversal protection)
      this._validateBackupPath(backupPath);

      // Read backup file. Use `let` so the version-strip branch below can
      // rebind to a copy without mutating the parsed input.
      const content = await fs.readFile(backupPath, 'utf8');
      let backupData = JSON.parse(content);

      // Verify JSON structure
      if (!backupData || typeof backupData !== 'object') {
        throw new Error('Invalid backup file: corrupted or invalid JSON structure');
      }

      if (!backupData.settings) {
        throw new Error('Invalid backup file: missing settings object');
      }

      // Verify SHA256 hash if present
      if (backupData.hash) {
        const { hash: storedHash, ...originalData } = backupData;
        // This ensures key order doesn't affect the hash
        const originalJson = stableStringify(originalData, 2);
        const calculatedHash = crypto
          .createHash('sha256')
          .update(originalJson, 'utf8')
          .digest('hex');

        if (calculatedHash !== storedHash) {
          throw new Error(
            'Backup integrity check failed: SHA256 hash mismatch. ' +
              'The backup file may have been tampered with or corrupted.'
          );
        }

        logger.info('[SettingsBackupService] Backup integrity verified (SHA256 hash match)');
      } else {
        // All backups created by this app include a hash. A missing hash indicates
        // the file was manually created or tampered with. Reject for safety.
        throw new Error(
          'Backup integrity check failed: missing SHA256 hash. ' +
            'The backup file may have been tampered with or was not created by this application.'
        );
      }

      // Fail-closed on future schema versions. A backup produced by a newer
      // build of the app may contain keys or value shapes this build cannot
      // safely interpret; merging them with defaults would silently drop or
      // mis-type those keys. Reject the restore up front rather than allow
      // a destructive downgrade.
      const importedVersion = Number(backupData.settings?.settingsSchemaVersion);
      if (Number.isFinite(importedVersion) && importedVersion > SETTINGS_SCHEMA_VERSION) {
        throw new Error(
          `Backup is from a newer app version (settingsSchemaVersion=${importedVersion}, ` +
            `current=${SETTINGS_SCHEMA_VERSION}). Upgrade the app before restoring this backup.`
        );
      }

      // If the backup is from an older schema version, strip the stamp so
      // SettingsMigrator re-runs the full chain on next load. Without the
      // strip, downstream code that reads the version before the migrator
      // executes will see the old value and may take the wrong branch.
      // Previously this branch only logged the intent — fix the gap.
      if (Number.isFinite(importedVersion) && importedVersion < SETTINGS_SCHEMA_VERSION) {
        logger.info(
          '[SettingsBackupService] Importing older settings; stripping schema stamp so migration re-runs on next load',
          { importedVersion, currentVersion: SETTINGS_SCHEMA_VERSION }
        );
        // Mutate a copy, not the input — backupData may be reused by caller.
        backupData = {
          ...backupData,
          settings: { ...(backupData.settings || {}) }
        };
        delete backupData.settings.settingsSchemaVersion;
      }

      // Create a backup of current settings before restoring
      await this.createBackup();

      // Validate backup settings
      const validation = validateSettings(backupData.settings);
      if (!validation.valid) {
        const error = /** @type {Error & { validationErrors?: any, validationWarnings?: any }} */ (
          new Error('Backup contains invalid settings')
        );
        error.validationErrors = validation.errors;
        error.validationWarnings = validation.warnings;
        throw error;
      }

      // Sanitize and merge with defaults
      const sanitized = sanitizeSettings(backupData.settings);
      const merged = { ...this.defaults, ...sanitized };
      // The defaults merge re-stamps the CURRENT schema version, which would
      // make SettingsMigrator skip the re-run this restore relies on (the
      // strip above only removed the key from the sanitized copy). Preserve
      // the backup's own stamp — absent means pre-versioning, i.e. v1 — so
      // the migration chain (including the one-time v3 legacy Simple-mode
      // value flip) actually executes on the next launch.
      if (!Number.isFinite(importedVersion) || importedVersion < SETTINGS_SCHEMA_VERSION) {
        merged.settingsSchemaVersion = Number.isFinite(importedVersion) ? importedVersion : 1;
      }
      const hasPersistedExperienceMode = Object.prototype.hasOwnProperty.call(
        backupData.settings || {},
        'experienceMode'
      );
      if (!hasPersistedExperienceMode) {
        merged.experienceMode = EXPERIENCE_MODES.ADVANCED;
      }
      const normalized = applyExperienceModeSettings(merged);

      // Save restored settings
      await saveSettings(normalized);

      return {
        success: true,
        settings: normalized,
        validationWarnings: validation.warnings,
        restoredFrom: backupData.timestamp
      };
    } catch (error) {
      logger.error('[SettingsBackupService] Failed to restore from backup', {
        error: error.message
      });
      return {
        success: false,
        error: error.message,
        validationErrors: error.validationErrors,
        validationWarnings: error.validationWarnings
      };
    }
  }

  /**
   * Rotate the automatic backups, keeping only the most recent ones. Manual
   * backups are never touched here.
   */
  async cleanupOldBackups() {
    try {
      const cleanupStart = Date.now();
      const backups = await this.listBackups({ includeParsedTime: true });

      // Filter out backups with unsafe timestamps
      const safeBackups = backups.filter((backup) => {
        if (backup.kind === 'manual') return false;
        if (!Number.isFinite(backup._parsedTime)) {
          logger.warn(
            `[SettingsBackupService] Backup ${backup.filename} has unsafe timestamp. Skipping.`
          );
          return false;
        }
        if (backup._parsedTime > cleanupStart) {
          // Skip backups created after cleanup started to avoid race deletion
          return false;
        }
        return true;
      });

      // Keep only the most recent backups
      if (safeBackups.length > this.maxBackups) {
        const backupsToDelete = safeBackups.slice(this.maxBackups);

        for (const backup of backupsToDelete) {
          try {
            await fs.unlink(backup.path);
            logger.debug(`[SettingsBackupService] Deleted old backup: ${backup.filename}`);
          } catch (error) {
            logger.warn(`[SettingsBackupService] Failed to delete old backup: ${backup.filename}`, {
              error: error.message
            });
          }
        }
      }
    } catch (error) {
      logger.error('[SettingsBackupService] Failed to cleanup old backups', {
        error: error.message
      });
    }
  }

  /**
   * Delete a specific backup
   * @param {string} backupPath - Path to backup file to delete
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async deleteBackup(backupPath) {
    try {
      // Validate backup path (path traversal protection)
      this._validateBackupPath(backupPath);

      await fs.unlink(backupPath);
      return { success: true };
    } catch (error) {
      logger.error('[SettingsBackupService] Failed to delete backup', {
        error: error.message
      });
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = { SettingsBackupService };
