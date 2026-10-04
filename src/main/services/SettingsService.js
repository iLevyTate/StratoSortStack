// @ts-check
const { app } = require('electron');
const { AsyncLocalStorage } = require('async_hooks');
const fs = require('fs').promises;
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { backupAndReplace } = require('../../shared/atomicFileOperations');
const { atomicWriteFile } = require('../../shared/atomicFile');
const { validateSettings, sanitizeSettings } = require('../../shared/settingsValidation');
const {
  DEFAULT_SETTINGS,
  mergeWithDefaults,
  stripDefaultValues
} = require('../../shared/defaultSettings');
const {
  EXPERIENCE_MODES,
  applyExperienceModeSettings,
  carryAdvancedValuesAcrossModeSwitch
} = require('../../shared/experienceMode');
const { logger: baseLogger, createLogger } = require('../../shared/logger');
const { isNotFoundError } = require('../../shared/errorClassifier');
const { createSingletonHelpers } = require('../../shared/singletonFactory');
const { LIMITS, DEBOUNCE, TIMEOUTS, RETRY } = require('../../shared/performanceConstants');
const { delay, createBackgroundWorkTracker } = require('../../shared/promiseUtils');
const { SettingsBackupService } = require('./SettingsBackupService');
const {
  assertBackupPathContained,
  assertBackupPathNotSymlink
} = require('../../shared/backupPathGuard');
const { IPC_EVENTS } = require('../../shared/constants');
const { safeSend } = require('../ipc/ipcWrappers');

const logger = typeof createLogger === 'function' ? createLogger('SettingsService') : baseLogger;

// Settings keys whose save takes no pre-save backup: per-session UI
// bookkeeping, not configuration a user would want to restore.
const BACKUP_EXEMPT_KEYS = new Set(['lastBrowsedPath']);
if (typeof createLogger !== 'function' && logger?.setContext) {
  logger.setContext('SettingsService');
}

/**
 * Custom error class for mutex timeout/deadlock errors
 * Provides better error identification and context for debugging
 */
class MutexTimeoutError extends Error {
  constructor(/** @type {any} */ message, context = {}) {
    super(message);
    this.name = 'MutexTimeoutError';
    this.context = context;
    this.timestamp = Date.now();
  }
}

class SettingsService {
  constructor() {
    this.settingsPath = path.join(app.getPath('userData'), 'settings.json');
    this.backupDir = path.join(app.getPath('userData'), 'settings-backups');
    // Use centralized constants from performanceConstants.js
    this.maxBackups = LIMITS.MAX_SETTINGS_BACKUPS;
    this.defaults = this._buildRuntimeDefaults();
    this._cache = null;
    this._cacheTimestamp = 0;
    this._cacheTtlMs = 2_000; // short TTL to avoid repeated disk reads
    this._fileWatcher = null;
    this._debounceTimer = null;
    // PERFORMANCE FIX: Use centralized debounce constant
    this._debounceDelay = DEBOUNCE.SETTINGS_SAVE;
    this._isInternalChange = false; // Flag to ignore changes we made ourselves
    this._internalChangeTimer = null;
    this._isShuttingDown = false;
    // Blocks nested load() → recovery → createBackup → load() re-entry while
    // restoring from a corrupt settings.json.
    this._recoveryInProgress = false;

    // Fixed: Add mutex to prevent concurrent save operations
    this._saveMutex = Promise.resolve();
    // Tracks the async context that currently holds the mutex so nested
    // acquisitions from inside the critical section (save() → createBackup()
    // → load() → migration → save(), or _loadRaw() → auto-recovery on a
    // corrupt file) run inline instead of waiting on their own lock.
    /** @type {AsyncLocalStorage<{ cancellation: any }>} */
    this._mutexScope = new AsyncLocalStorage();
    this._saveQueue = [];
    this._mutexAcquiredAt = null; // Track when mutex was acquired for deadlock detection
    this._mutexTimeoutMs = TIMEOUTS.SERVICE_STARTUP; // Use centralized timeout

    this._watcherRestartCount = 0;
    this._maxWatcherRestarts = LIMITS.MAX_WATCHER_RESTARTS;
    this._watcherRestartWindow = LIMITS.WATCHER_RESTART_WINDOW;
    this._watcherRestartWindowStart = Date.now();
    this._restartTimer = null;
    this._externalSettingsChangedHandler = null;
    this._externalChangeSettleMs = 250;
    this._externalChangeMaxRetries = 3;

    // Track fire-and-forget promises
    /** @type {any} */
    this._bgWork = createBackgroundWorkTracker('SettingsService');

    // Initialize backup service (extracted for better separation of concerns)
    this._backupService = new SettingsBackupService({
      backupDir: this.backupDir,
      maxBackups: this.maxBackups,
      defaults: this.defaults,
      loadSettings: () => {
        // restoreFromBackup always createBackup()s first. During auto-recovery
        // settings.json is still corrupt, so calling load() here would re-enter
        // _attemptAutoRecovery unboundedly. Serve cache/defaults instead.
        if (this._recoveryInProgress) {
          return Promise.resolve(this._cache || { ...this.defaults });
        }
        return this.load();
      }
    });

    // Start file watching
    this._startFileWatcher();
    this._migrationChecked = false;
    this._migrationInProgress = false;
    this._migrationAttempts = 0;
    /** @type {Promise<void>|null} */
    this._migrationPromise = null;
    this._maxMigrationAttempts = RETRY.MAX_ATTEMPTS_MEDIUM;
  }

  _buildRuntimeDefaults() {
    const resolvedDefaultLocation = this._resolvePlatformDefaultSmartFolderLocation();
    return applyExperienceModeSettings({
      ...DEFAULT_SETTINGS,
      defaultSmartFolderLocation:
        resolvedDefaultLocation || DEFAULT_SETTINGS.defaultSmartFolderLocation
    });
  }

  /**
   * Whether a stored default Smart Folder location is this machine's own
   * Documents folder, which the runtime defaults resolve at every launch.
   * The shared stripDefaultValues knows only the literal 'Documents', so the
   * resolved path used to be persisted as if the user had typed it, and it
   * then outlived a OneDrive Known Folder Move or a profile move.
   * @param {any} value
   */
  _isRuntimeDefaultSmartFolderLocation(value) {
    if (typeof value !== 'string' || !value.trim()) return false;
    const runtimeDefault = this.defaults?.defaultSmartFolderLocation;
    if (typeof runtimeDefault !== 'string' || !runtimeDefault) return false;
    const normalize = (/** @type {string} */ p) => {
      const resolved = path.resolve(p.trim()).replace(/[\\/]+$/, '');
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    try {
      return normalize(value) === normalize(runtimeDefault);
    } catch {
      return false;
    }
  }

  /**
   * The user's own values: the shared default strip, plus this machine's
   * resolved Documents path, which is a default too.
   * @param {any} settings
   * @returns {Record<string, any>}
   */
  _stripRuntimeDefaults(settings) {
    const out = stripDefaultValues(settings);
    if (
      Object.prototype.hasOwnProperty.call(out, 'defaultSmartFolderLocation') &&
      this._isRuntimeDefaultSmartFolderLocation(out.defaultSmartFolderLocation)
    ) {
      delete out.defaultSmartFolderLocation;
    }
    return out;
  }

  /**
   * Turn the parsed contents of settings.json into effective settings.
   *
   * settings.json holds only what the user set (see save()); anything equal
   * to a current or superseded default is dropped first, so a default this
   * app stamped in an earlier build (every save used to write the whole
   * merged object) never outlives the build that wrote it. The remaining
   * user values are merged over the current defaults, hydrated and
   * sanitized. Every read path goes through here so load, auto-recovery and
   * the post-write reload agree.
   * @param {any} parsed
   * @returns {Record<string, any>}
   */
  _normalizeParsedSettings(parsed) {
    const userValues = this._stripRuntimeDefaults(parsed);
    /** @type {any} */
    const merged = mergeWithDefaults(userValues);
    // mergeWithDefaults knows the literal 'Documents'; a location the user
    // never set resolves to this machine's Documents folder, live.
    if (!Object.prototype.hasOwnProperty.call(userValues, 'defaultSmartFolderLocation')) {
      merged.defaultSmartFolderLocation = this.defaults.defaultSmartFolderLocation;
    }
    const hydrated = this._hydrateLoadedSettings(merged, userValues);
    return sanitizeSettings(hydrated);
  }

  _hydrateLoadedSettings(/** @type {any} */ settings, /** @type {any} */ sourceSettings = null) {
    const hydrated = {
      ...(settings && typeof settings === 'object' ? settings : {})
    };
    const hasPersistedExperienceMode =
      sourceSettings &&
      typeof sourceSettings === 'object' &&
      Object.prototype.hasOwnProperty.call(sourceSettings, 'experienceMode');

    if (!hasPersistedExperienceMode) {
      hydrated.experienceMode = EXPERIENCE_MODES.ADVANCED;
    }

    // v2.0.9 -> v3 migration: `autoConcurrency` was added in v3 and defaults
    // to `true` (driven by the live hardware probe). Users who previously
    // tuned `maxConcurrentAnalysis` in v2 expect that override to keep
    // working after upgrade — but if `autoConcurrency` is missing from the
    // persisted file we'd silently flip them onto auto, ignoring the manual
    // value. Detect the v2-shape (raw file has maxConcurrentAnalysis but no
    // autoConcurrency) and write `autoConcurrency: false` so the explicit
    // limit is preserved. We mutate the raw source so the migration sticks
    // on next save; the runtime `hydrated` copy gets the same key.
    const hasPersistedAutoConcurrency =
      sourceSettings &&
      typeof sourceSettings === 'object' &&
      Object.prototype.hasOwnProperty.call(sourceSettings, 'autoConcurrency');
    const hasPersistedMaxConcurrency =
      sourceSettings &&
      typeof sourceSettings === 'object' &&
      Object.prototype.hasOwnProperty.call(sourceSettings, 'maxConcurrentAnalysis');
    if (!hasPersistedAutoConcurrency && hasPersistedMaxConcurrency) {
      hydrated.autoConcurrency = false;
      try {
        sourceSettings.autoConcurrency = false;
      } catch {
        // sourceSettings may be frozen in tests; runtime hydration above is
        // what matters for behavior, the persistence-side write is opportunistic.
      }
    }

    return applyExperienceModeSettings(hydrated);
  }

  _resolvePlatformDefaultSmartFolderLocation() {
    // Primary source: Electron-provided platform folder location.
    try {
      const documentsPath = app.getPath('documents');
      if (typeof documentsPath === 'string' && documentsPath.trim()) {
        return documentsPath.trim();
      }
    } catch (error) {
      logger.warn('[SettingsService] Failed to resolve documents path via Electron', {
        error: error?.message
      });
    }

    // Fallback by platform when Electron cannot provide a documents path.
    const home = typeof os.homedir === 'function' ? os.homedir() : '';
    if (!home || typeof home !== 'string') {
      return DEFAULT_SETTINGS.defaultSmartFolderLocation;
    }

    if (process.platform === 'win32') {
      return path.join(home, 'Documents');
    }
    if (process.platform === 'darwin') {
      return path.join(home, 'Documents');
    }
    // Linux/other Unix-like platforms: use a conventional documents folder.
    return path.join(home, 'Documents');
  }

  async load() {
    if (this._isShuttingDown) {
      logger.debug('[SettingsService] Ignoring load() during shutdown');
      return this._cache || { ...this.defaults };
    }

    if (this._migrationInProgress) {
      logger.debug('[SettingsService] Migration in progress - loading raw settings');
      return this._loadRaw();
    }

    await this._ensureMigrated();
    return this._loadRaw();
  }

  /**
   * Run the one-time schema migration if it has not completed this session.
   *
   * Called from both load() and save(). save() must migrate BEFORE it reads
   * current settings: otherwise createBackup() → load() migrates mid-save and
   * the outer write (built from the pre-migration snapshot, stamped with the
   * current schema version by mergeWithDefaults) clobbers the migrated file
   * and permanently hides the legacy values from future migrations.
   *
   * Concurrent callers share one in-flight run. The migrator's own nested
   * save() sees _migrationInProgress and skips (see save()).
   * @private
   * @returns {Promise<void>}
   */
  async _ensureMigrated() {
    if (this._migrationChecked || this._migrationAttempts >= this._maxMigrationAttempts) {
      return;
    }
    if (this._migrationPromise) {
      await this._migrationPromise;
      return;
    }
    this._migrationInProgress = true;
    this._migrationPromise = (async () => {
      try {
        await this.migrateLegacyConfig();
        const { createInstance: createSettingsMigrator } = require('./migration/SettingsMigrator');
        const migrator = createSettingsMigrator(this);
        if (await migrator.needsMigration()) {
          const result = await migrator.migrate();
          if (!result?.success) {
            throw new Error(result?.errors?.[0] || 'Settings migration failed');
          }
        }
        this._migrationChecked = true; // Only mark checked after successful completion
      } catch (err) {
        this._migrationAttempts++;
        logger.error(
          `[SettingsService] Migration attempt ${this._migrationAttempts}/${this._maxMigrationAttempts} failed:`,
          err.message
        );
        if (this._migrationAttempts >= this._maxMigrationAttempts) {
          this._migrationChecked = true; // Give up after max attempts
          logger.error(
            '[SettingsService] Migration permanently failed after max attempts - continuing with current settings'
          );
        }
      } finally {
        this._migrationInProgress = false;
        this._migrationPromise = null;
      }
    })();
    await this._migrationPromise;
  }

  async _loadRaw() {
    try {
      const now = Date.now();
      if (this._cache && now - this._cacheTimestamp < this._cacheTtlMs) {
        return this._cache;
      }
      const raw = await fs.readFile(this.settingsPath, 'utf-8');

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (parseError) {
        // Specific handling for JSON syntax errors
        logger.error('[SettingsService] Settings file contains invalid JSON:', {
          error: parseError.message,
          position: parseError.message.match(/position (\d+)/)?.[1] || 'unknown'
        });
        // Mark error as JSON corruption for recovery logic
        const jsonError = /** @type {Error & { code?: string, originalError?: any }} */ (
          new Error(`Settings file corrupted (invalid JSON): ${parseError.message}`)
        );
        jsonError.code = 'JSON_PARSE_ERROR';
        jsonError.originalError = parseError;
        throw jsonError;
      }

      // If a user override has the wrong type (e.g., string where number expected),
      // the default value is preserved instead of the invalid override.
      const sanitized = this._normalizeParsedSettings(parsed);
      this._cache = sanitized;
      this._cacheTimestamp = now;
      return sanitized;
    } catch (err) {
      if (err && !isNotFoundError(err)) {
        const errorType = err.code === 'JSON_PARSE_ERROR' ? 'corrupted' : 'unreadable';
        logger.warn(
          `[SettingsService] Settings file ${errorType}: ${err.message}, attempting recovery from backup`
        );
        const recovered = await this._attemptAutoRecovery();
        if (recovered) {
          return recovered;
        }
      }

      const merged = { ...this.defaults };
      this._cache = merged;
      this._cacheTimestamp = Date.now();
      if (err && !isNotFoundError(err)) {
        logger.warn(`[SettingsService] Recovery failed, using defaults`);
      }
      return merged;
    }
  }

  /**
   * FIX: Attempt auto-recovery from the most recent valid backup
   * @private
   * @returns {Promise<Object|null>} Recovered settings or null if recovery failed
   */
  async _attemptAutoRecovery() {
    if (this._recoveryInProgress) {
      logger.warn('[SettingsService] Auto-recovery already in progress; skipping nested attempt');
      return null;
    }
    this._recoveryInProgress = true;
    try {
      const backups = await this._backupService.listBackups();
      if (!backups || backups.length === 0) {
        logger.warn('[SettingsService] No backups available for auto-recovery');
        return null;
      }

      const MAX_RECOVERY_ATTEMPTS = RETRY.MAX_ATTEMPTS_HIGH;
      const backupsToTry = backups.slice(0, MAX_RECOVERY_ATTEMPTS);

      if (backups.length > MAX_RECOVERY_ATTEMPTS) {
        logger.info(
          `[SettingsService] Limiting recovery to ${MAX_RECOVERY_ATTEMPTS} most recent backups (${backups.length} available)`
        );
      }

      // Try backups in order (most recent first)
      for (const backup of backupsToTry) {
        try {
          logger.info(`[SettingsService] Attempting recovery from backup: ${backup.filename}`);
          const backupPath =
            backup.path ||
            (this._backupService?.backupDir
              ? path.join(this._backupService.backupDir, backup.filename)
              : backup.filename);
          const result = await this._backupService.restoreFromBackup(backupPath, async (merged) => {
            // Same write path as public restore(): mutex + internal-change flag
            // so the watcher does not treat the recovery write as external and
            // re-enter load()/recovery.
            return this._withMutex(async (/** @type {any} */ cancellation) => {
              if (cancellation.timedOut) {
                throw new Error('Operation cancelled: mutex timed out, skipping disk write');
              }
              this._isInternalChange = true;
              try {
                const saveResult = await backupAndReplace(
                  this.settingsPath,
                  JSON.stringify(merged, null, 2)
                );
                if (!saveResult.success) {
                  throw new Error(saveResult.error || 'Failed to save restored settings');
                }
                return { success: true };
              } finally {
                if (this._internalChangeTimer) {
                  clearTimeout(this._internalChangeTimer);
                }
                const internalChangeResetDelayMs = this._debounceDelay + 200;
                this._internalChangeTimer = setTimeout(() => {
                  if (!this._isShuttingDown) {
                    this._isInternalChange = false;
                  }
                  this._internalChangeTimer = null;
                }, internalChangeResetDelayMs);
              }
            });
          });

          if (result.success) {
            logger.info(
              `[SettingsService] Successfully recovered settings from backup: ${backup.filename}`
            );
            // Reload the restored settings
            const raw = await fs.readFile(this.settingsPath, 'utf-8');
            const parsed = JSON.parse(raw);
            const sanitized = this._normalizeParsedSettings(parsed);
            this._cache = sanitized;
            this._cacheTimestamp = Date.now();
            return sanitized;
          }
        } catch (backupErr) {
          logger.warn(
            `[SettingsService] Failed to restore backup ${backup.filename}: ${backupErr.message}`
          );
          // Continue to next backup
        }
      }

      logger.error('[SettingsService] All backup recovery attempts failed');
      return null;
    } catch (err) {
      logger.error(`[SettingsService] Auto-recovery failed: ${err.message}`);
      return null;
    } finally {
      this._recoveryInProgress = false;
    }
  }

  /**
   * Legacy config migration removed in in-process stack.
   */
  async migrateLegacyConfig() {
    return;
  }

  // Fixed: Proper cache invalidation, settings merging, and validation
  async save(/** @type {any} */ settings) {
    if (this._isShuttingDown) {
      // Previously returned a fake-success shape with the cached settings and
      // no backupCreated flag — which made every caller believe the new values
      // were persisted while they were silently dropped. During shutdown it's
      // better to surface an explicit error so the renderer/menu can react
      // (retry after restart, warn the user, or at minimum not blink a green
      // "saved" toast). Callers that want best-effort fire-and-forget
      // behavior can still ignore the rejection.
      logger.debug('[SettingsService] Rejecting save() during shutdown');
      const error = /** @type {Error & { code?: string }} */ (
        new Error('SettingsService is shutting down; save rejected')
      );
      error.code = 'SETTINGS_SHUTDOWN';
      throw error;
    }

    // Migrate before reading current state so the write below cannot clobber
    // a migration triggered mid-save. The migrator's own save() arrives with
    // _migrationInProgress set and must not wait on itself.
    if (!this._migrationInProgress) {
      await this._ensureMigrated();
    }

    // Fixed: Use mutex to prevent race conditions from concurrent saves
    return this._withMutex(async (/** @type {any} */ cancellation) => {
      // Force confidenceThreshold to a sane number before validation/merge
      const coerceConfidence = (/** @type {any} */ val, /** @type {any} */ fallback) => {
        const num = Number(val);
        if (Number.isFinite(num)) {
          return Math.min(1, Math.max(0, num));
        }
        return fallback;
      };

      // Validate settings before saving
      const validation = validateSettings(settings);
      if (!validation.valid) {
        const error = /** @type {Error & { validationErrors?: any, validationWarnings?: any }} */ (
          new Error('Invalid settings provided')
        );
        error.validationErrors = validation.errors;
        error.validationWarnings = validation.warnings;
        throw error;
      }

      // Log warnings if any
      if (validation.warnings.length > 0) {
        logger.warn('[SettingsService] Validation warnings', {
          warnings: validation.warnings
        });
      }

      // Previously coerced twice (before and after merge) - now only after merge
      const sanitized = sanitizeSettings(settings);

      // This prevents stale cache from causing data loss when external changes occurred
      // IMPORTANT: capture cache state BEFORE clearing so we can rollback on failure.
      // Previously we captured "previousCache" after clearing, making rollback restore null.
      /** @type {any} */
      const cacheBeforeSave = this._cache;
      const cacheTimestampBeforeSave = this._cacheTimestamp;
      // Expire the TTL so _loadRaw reads the disk, but keep the snapshot:
      // getAll() callers (watcher exclusion checks, the keyframe toggle) must
      // not read defaults for the length of a file read.
      this._cacheTimestamp = 0;

      // Load current settings first to avoid data loss on partial updates
      // This is now safe because we're inside the mutex
      const current = await this._loadRaw();

      // A Simple/Advanced switch parks or restores the user's Advanced-only
      // choices before Simple-mode enforcement runs (audit row ST-08).
      const merged = applyExperienceModeSettings(
        carryAdvancedValuesAcrossModeSwitch(current, {
          ...current,
          ...sanitized,
          confidenceThreshold: coerceConfidence(
            sanitized?.confidenceThreshold ?? current.confidenceThreshold,
            DEFAULT_SETTINGS.confidenceThreshold
          )
        })
      );
      // The file holds the user's own choices only. Values equal to the
      // current defaults are dropped, so a default that changes in a later
      // build reaches every install that never touched that setting; the
      // in-memory `merged` stays complete for callers.
      const toPersist = this._stripRuntimeDefaults(merged);

      // CRITICAL: Create backup before saving - mandatory with retry logic
      // createBackup handles directory creation via atomicFileOps
      //
      // Keys that are UI bookkeeping rather than configuration do not earn a
      // snapshot: the file dialog saves lastBrowsedPath on every open, and
      // each of those snapshots would push a meaningful one out of the
      // automatic rotation.
      const needsBackup = Object.keys(sanitized).some((key) => !BACKUP_EXEMPT_KEYS.has(key));

      // Retry backup creation with exponential backoff
      /** @type {{ success: boolean, path?: string, skipped?: boolean, error?: string } | null} */
      let backupResult = needsBackup ? null : { success: true, skipped: true };
      const maxBackupRetries = RETRY.MAX_ATTEMPTS_MEDIUM;
      const initialBackupDelay = RETRY.SETTINGS_BACKUP.initialDelay;

      for (let attempt = 0; needsBackup && attempt < maxBackupRetries; attempt++) {
        try {
          backupResult = await this.createBackup();
          if (backupResult.success) {
            break; // Success, exit retry loop
          }
          logger.warn(
            `[SettingsService] Backup attempt ${attempt + 1} failed with result:`,
            backupResult
          );
        } catch (error) {
          logger.error(`[SettingsService] Backup attempt ${attempt + 1} failed with exception:`, {
            error: error.message,
            stack: error.stack,
            attempt: attempt + 1,
            maxRetries: maxBackupRetries
          });

          const isLastAttempt = attempt === maxBackupRetries - 1;
          if (isLastAttempt) {
            const errorMsg = `Failed to create backup after ${maxBackupRetries} attempts: ${error.message}`;
            logger.error(`[SettingsService] ${errorMsg}`);
            throw new Error(errorMsg, { cause: error });
          }
          // Wait before retry with exponential backoff
          const retryMs = initialBackupDelay * 2 ** attempt;
          logger.warn(
            `[SettingsService] Retrying backup in ${retryMs}ms (attempt ${attempt + 2}/${maxBackupRetries})`
          );
          await delay(retryMs);
        }
      }

      // Verify backup was successful
      if (!backupResult || !backupResult.success) {
        const errorMsg = `Backup creation failed: ${backupResult?.error || 'Unknown error'}`;
        logger.error(`[SettingsService] ${errorMsg}`);
        throw new Error(errorMsg);
      }
      const backupPath = backupResult.path;

      // Now safe to save settings
      // Set flag to ignore our own file change
      this._isInternalChange = true;

      const previousCache = cacheBeforeSave;
      const previousTimestamp = cacheTimestampBeforeSave;

      try {
        await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });

        // If disk write fails, we rollback to previous state
        this._cache = merged;
        this._cacheTimestamp = Date.now();

        // Bug #42: Retry logic for file lock handling with exponential backoff
        const maxSaveRetries = RETRY.MAX_ATTEMPTS_HIGH;
        const baseSaveDelay = RETRY.SETTINGS_SAVE.initialDelay;

        for (let attempt = 0; attempt < maxSaveRetries; attempt++) {
          try {
            // If the mutex timed out while we were working, skip disk write
            // to prevent concurrent writes with the next mutex holder.
            if (cancellation.timedOut) {
              this._cache = cacheBeforeSave;
              this._cacheTimestamp = cacheTimestampBeforeSave;
              throw new Error('Operation cancelled: mutex timed out, skipping disk write');
            }
            const result = await backupAndReplace(
              this.settingsPath,
              JSON.stringify(toPersist, null, 2)
            );
            if (!result || !result.success) {
              throw new Error((result && result.error) || 'Failed to save settings');
            }

            // Success - reload from disk to ensure cache reflects
            // what was actually persisted (prevents stale cache if
            // another process modified the file between our write and
            // the cache update).
            try {
              const rawAfterWrite = await fs.readFile(this.settingsPath, 'utf-8');
              const parsedAfterWrite = JSON.parse(rawAfterWrite);
              this._cache = this._normalizeParsedSettings(parsedAfterWrite);
              this._cacheTimestamp = Date.now();
            } catch (reloadErr) {
              // If reload fails, keep the in-memory merged value
              logger.warn('[SettingsService] Post-write reload failed, using in-memory value', {
                error: reloadErr.message
              });
              this._cache = merged;
              this._cacheTimestamp = Date.now();
            }
            break;
          } catch (saveError) {
            // Bug #42: Check for file lock errors (EBUSY, EPERM, EACCES)
            const isFileLockError =
              saveError.code === 'EBUSY' ||
              saveError.code === 'EPERM' ||
              saveError.code === 'EACCES';

            if (isFileLockError && attempt < maxSaveRetries - 1) {
              // Calculate exponential backoff delay
              const retryMs = baseSaveDelay * 2 ** attempt;
              logger.warn(
                `[SettingsService] File lock error on save attempt ${attempt + 1}/${maxSaveRetries}: ${saveError.code}. Retrying in ${retryMs}ms...`
              );
              await delay(retryMs);
            } else if (attempt === maxSaveRetries - 1) {
              this._cache = previousCache;
              this._cacheTimestamp = previousTimestamp;
              logger.error('[SettingsService] Save failed, rolled back cache to previous state');
              throw new Error(
                `Failed to save settings after ${maxSaveRetries} attempts due to file lock: ${saveError.message}`,
                { cause: saveError }
              );
            } else {
              this._cache = previousCache;
              this._cacheTimestamp = previousTimestamp;
              logger.error('[SettingsService] Save failed with non-lock error, rolled back cache');
              throw saveError;
            }
          }
        }
      } catch (err) {
        this._cache = previousCache;
        this._cacheTimestamp = previousTimestamp;
        logger.error(
          '[SettingsService] Save operation failed, rolled back cache to previous state'
        );
        if (backupPath) {
          try {
            await this._backupService.deleteBackup(backupPath);
            logger.warn('[SettingsService] Deleted orphan backup after failed save', {
              backupPath
            });
          } catch (cleanupError) {
            logger.warn('[SettingsService] Failed to delete orphan backup after save failure', {
              backupPath,
              error: cleanupError.message
            });
          }
        }
        throw err;
      } finally {
        // Reset flag after a short delay to allow file system to settle
        if (this._internalChangeTimer) {
          clearTimeout(this._internalChangeTimer);
        }
        // Keep internal-change suppression active slightly longer than watcher debounce.
        // This prevents our own atomic save from being misclassified as external change.
        const internalChangeResetDelayMs = this._debounceDelay + 200;
        this._internalChangeTimer = setTimeout(() => {
          if (!this._isShuttingDown) {
            this._isInternalChange = false;
          }
          this._internalChangeTimer = null;
        }, internalChangeResetDelayMs);
      }

      return {
        settings: merged,
        validationWarnings: validation.warnings,
        backupCreated: !backupResult.skipped,
        backupPath: backupResult.path
      };
    }); // End of mutex wrapper
  }

  /**
   * Execute a function with mutex lock to prevent concurrent operations
   * @private
   */
  async _withMutex(/** @type {any} */ fn, /** @type {{ signal?: AbortSignal }} */ options = {}) {
    const { signal } = options;
    const held = this._mutexScope.getStore();
    if (held) {
      // Re-entrant acquisition: the caller is already executing under this
      // mutex. Waiting on _saveMutex here would block until the 30 s timeout
      // (the outer holder cannot release until we return). Run inline under
      // the outer holder's cancellation token so timedOut still propagates.
      return fn(held.cancellation);
    }
    // Fast-fail if the caller's signal is already aborted: no need to even
    // enqueue on the mutex chain. This keeps cancellation cheap and avoids
    // leaking a queued fn() that would immediately observe `cancellation`
    // and bail out after paying the acquisition cost.
    if (signal?.aborted) {
      const err = /** @type {Error & { code?: string }} */ (
        new Error('SettingsService operation aborted before mutex acquisition')
      );
      err.code = 'ABORT_ERR';
      throw err;
    }
    // Fixed: Robust mutex implementation using promise chaining
    // CRITICAL: Mutex must ALWAYS resolve (never reject) to maintain the chain
    const previousMutex = this._saveMutex;

    /** @type {(v?: any) => void} */
    let resolveMutex = () => {};
    this._saveMutex = new Promise((resolve) => {
      resolveMutex = resolve;
    });

    // Previously captured inside try, out of scope for catch block.
    let localAcquiredAt = null;

    try {
      // Wait for previous operation with a timeout to prevent permanent deadlock
      const waitForPrevious = previousMutex.catch(() => {
        // Previous operation failed, but we continue with current operation
        // This prevents error propagation from breaking the mutex chain
      });

      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(
            new MutexTimeoutError(
              `Mutex deadlock detected: Previous operation did not complete within ${this._mutexTimeoutMs}ms. ` +
                `This may indicate a stuck operation or infinite loop.`,
              { phase: 'mutex_acquisition', timeoutMs: this._mutexTimeoutMs }
            )
          );
        }, this._mutexTimeoutMs);
      });

      // Race between waiting for previous mutex and timeout
      try {
        await Promise.race([waitForPrevious, timeoutPromise]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }

      this._mutexAcquiredAt = Date.now();
      // before the outer catch can read it, making timeElapsed always null.
      localAcquiredAt = this._mutexAcquiredAt;

      // Execute the function and ensure mutex is always released
      let operationTimeoutId = null;
      try {
        // Add timeout to the actual operation as well
        // Cancellation token: when the timeout wins the race, the still-running
        // fn() checks this flag and skips its disk write to prevent concurrent writes.
        // The caller-provided AbortSignal (if any) is surfaced on the same token
        // so fn() can cooperatively cancel without checking two different
        // APIs. `aborted` is a boolean mirror of signal.aborted so tests and
        // synchronous hot-paths don't need to call signal.aborted themselves.
        const cancellation = {
          timedOut: false,
          aborted: Boolean(signal?.aborted),
          signal: signal || null
        };
        let onAbort;
        if (signal && !signal.aborted) {
          onAbort = () => {
            cancellation.aborted = true;
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
        const operationPromise = this._mutexScope.run({ cancellation }, () => fn(cancellation));
        const operationTimeout = new Promise((_, reject) => {
          operationTimeoutId = setTimeout(() => {
            cancellation.timedOut = true;
            reject(
              new MutexTimeoutError(
                `Operation timeout: Function did not complete within ${this._mutexTimeoutMs}ms. ` +
                  `This may indicate a blocking operation or infinite loop in the save/restore logic.`,
                {
                  phase: 'operation_execution',
                  timeoutMs: this._mutexTimeoutMs,
                  mutexAcquiredAt: this._mutexAcquiredAt
                }
              )
            );
          }, this._mutexTimeoutMs);
        });

        // Race the operation against timeout AND abort. If the caller aborts
        // mid-operation, fn() should respect `cancellation.aborted` and return
        // early; the race guarantees we don't wait forever on a cooperative
        // fn that ignores the flag.
        const abortPromise = signal
          ? new Promise((_, reject) => {
              if (signal.aborted) {
                const err = /** @type {Error & { code?: string }} */ (
                  new Error('SettingsService operation aborted')
                );
                err.code = 'ABORT_ERR';
                reject(err);
                return;
              }
              signal.addEventListener(
                'abort',
                () => {
                  const err = /** @type {Error & { code?: string }} */ (
                    new Error('SettingsService operation aborted')
                  );
                  err.code = 'ABORT_ERR';
                  reject(err);
                },
                { once: true }
              );
            })
          : null;

        try {
          const result = await (abortPromise
            ? Promise.race([operationPromise, operationTimeout, abortPromise])
            : Promise.race([operationPromise, operationTimeout]));
          return result;
        } finally {
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        }
      } finally {
        // CRITICAL: Clear timeout to prevent memory leak
        if (operationTimeoutId) clearTimeout(operationTimeoutId);
        // CRITICAL: Always resolve mutex, even on error or timeout
        // This ensures the next operation can proceed even if this one fails
        this._mutexAcquiredAt = null;
        resolveMutex();
      }
    } catch (error) {
      // this._mutexAcquiredAt which was already cleared by the inner finally block
      const acquiredAt = localAcquiredAt;
      const timeElapsed = acquiredAt ? Date.now() - acquiredAt : null;

      this._mutexAcquiredAt = null;
      if (!resolveMutex) {
        logger.error('[SettingsService] Mutex resolver not initialized - this should never happen');
      } else {
        // Ensure mutex is released even on catastrophic failure
        resolveMutex();
      }

      // Log deadlock/timeout errors with extra context
      if (
        error instanceof MutexTimeoutError ||
        error.message?.includes('deadlock') ||
        error.message?.includes('timeout')
      ) {
        logger.error('[SettingsService] Mutex deadlock or timeout detected', {
          error: error.message,
          errorType: error.name,
          errorContext: error instanceof MutexTimeoutError ? error.context : undefined,
          mutexAcquiredAt: acquiredAt,
          timeElapsed: timeElapsed ?? 'N/A'
        });
      }

      // Catch and re-throw to maintain error propagation
      // The finally block above ensures mutex is released
      throw error;
    }
  }

  /**
   * Force the next load() to read the disk. The last snapshot stays readable
   * through getAll()/get() until that read completes, so synchronous readers
   * never see defaults in the gap.
   */
  invalidateCache() {
    this._cacheTimestamp = 0;
  }

  /**
   * Register a callback invoked when settings change externally on disk.
   * The callback should apply runtime side-effects (watchers, tray, services).
   * @param {Function|null} handler
   */
  setExternalSettingsChangedHandler(handler) {
    if (handler !== null && typeof handler !== 'function') {
      throw new TypeError('External settings changed handler must be a function or null');
    }
    this._externalSettingsChangedHandler = handler;
  }

  /**
   * Synchronously get a setting value from cache
   * Returns the cached value, or the default if cache is empty
   * @param {string} key - The setting key to retrieve
   * @returns {*} The setting value or default
   */
  get(key) {
    if (this._cache && key in this._cache) {
      return this._cache[key];
    }
    return this.defaults[key];
  }

  /**
   * Synchronously get all cached settings
   * Returns the last loaded snapshot, or the defaults before the first load
   * @returns {Record<string, any>} The current settings
   */
  getAll() {
    if (this._cache) {
      return { ...this._cache };
    }
    return { ...this.defaults };
  }

  // Force reload from disk, bypassing cache
  async reload() {
    this.invalidateCache();
    return await this.load();
  }

  // Backup operations delegated to SettingsBackupService for better separation of concerns

  /**
   * Create a backup of current settings. `{ kind: 'manual' }` keeps it out of
   * the automatic rotation (see SettingsBackupService.createBackup).
   * @param {{ kind?: 'automatic' | 'manual' }} [options]
   * @returns {Promise<{success: boolean, path?: string, timestamp?: string, kind?: string, error?: string}>}
   */
  async createBackup(options = {}) {
    return this._backupService.createBackup(options);
  }

  /**
   * List all available backups
   * @returns {Promise<Array<{filename: string, path: string, timestamp: string, appVersion: string, size: number}>>}
   */
  async listBackups() {
    return this._backupService.listBackups();
  }

  /**
   * Restore settings from a backup
   * @param {string} backupPath - Path to backup file
   * @param {{ beforeWrite?: (merged: Record<string, any>) => Promise<Record<string, any>> }} [options]
   *   `beforeWrite` sees the merged settings before the file is written and
   *   returns what to write; throwing leaves the current settings untouched.
   * @returns {Promise<{success: boolean, settings?: Object, error?: string}>}
   */
  async restoreFromBackup(backupPath, options = {}) {
    if (!backupPath || typeof backupPath !== 'string') {
      return { success: false, error: 'Invalid backup path provided' };
    }
    const beforeWrite = typeof options?.beforeWrite === 'function' ? options.beforeWrite : null;

    try {
      assertBackupPathContained(backupPath, this.backupDir);
    } catch (err) {
      throw new Error('Backup path is outside backup directory - potential path traversal attack', {
        cause: err
      });
    }

    // Symlink rejection: the prefix check above is fooled by a symlink
    // that itself lives under backupDir but points elsewhere
    // (`backupDir/evil.json` -> /etc/shadow). The downstream code reads
    // the target then writes its parsed contents back to settingsPath,
    // which would exfiltrate the linked file's contents into the
    // user-readable settings.json. Reject any symlink at the boundary.
    await assertBackupPathNotSymlink(backupPath, fs);

    // Use mutex to prevent race conditions during restore
    return this._withMutex(async (/** @type {any} */ cancellation) => {
      const result = await this._backupService.restoreFromBackup(backupPath, async (restored) => {
        if (cancellation.timedOut) {
          throw new Error('Operation cancelled: mutex timed out, skipping disk write');
        }
        // A caller's gate runs on the merged settings before anything is
        // written; throwing here leaves the current settings untouched.
        const merged = beforeWrite ? await beforeWrite(restored) : restored;
        // Ignore the watcher for our own restore write (same as save()).
        this._isInternalChange = true;
        try {
          // Same on-disk shape as save(): the user's values only.
          const saveResult = await backupAndReplace(
            this.settingsPath,
            JSON.stringify(stripDefaultValues(merged), null, 2)
          );
          if (!saveResult.success) {
            throw new Error(saveResult.error || 'Failed to save restored settings');
          }
          // Update cache
          this._cache = merged;
          this._cacheTimestamp = Date.now();
        } finally {
          if (this._internalChangeTimer) {
            clearTimeout(this._internalChangeTimer);
          }
          const internalChangeResetDelayMs = this._debounceDelay + 200;
          this._internalChangeTimer = setTimeout(() => {
            if (!this._isShuttingDown) {
              this._isInternalChange = false;
            }
            this._internalChangeTimer = null;
          }, internalChangeResetDelayMs);
        }
      });
      return result;
    });
  }

  /**
   * Clean up old backups, keeping only the most recent ones
   */
  async cleanupOldBackups() {
    return this._backupService.cleanupOldBackups();
  }

  /**
   * Delete a specific backup
   * @param {string} backupPath - Path to backup file
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async deleteBackup(backupPath) {
    return this._backupService.deleteBackup(backupPath);
  }

  /**
   * Start watching the settings file for external changes
   * @private
   */
  async _startFileWatcher() {
    try {
      // Ensure settings directory exists (async to avoid blocking main thread)
      const settingsDir = path.dirname(this.settingsPath);
      await fs.mkdir(settingsDir, { recursive: true });

      // Ensure settings file exists before watching (first launch creates defaults).
      // Use an atomic write-then-rename so that a power loss or app crash during
      // the very first save can never leave a half-written settings.json. The
      // raw `fs.writeFile` path is non-atomic; an interrupted run produced a
      // zero-byte settings file that then failed to parse on next launch.
      try {
        await fs.access(this.settingsPath);
      } catch {
        // The file holds the user's own choices only (save() strips the
        // defaults), so the seed carries just the presence-bearing keys; a
        // full copy froze this machine's Documents path as a user value.
        await atomicWriteFile(this.settingsPath, this._stripRuntimeDefaults(this.defaults), {
          pretty: true
        });
      }

      // Watch the settings *directory*, not the file inode. Atomic
      // backupAndReplace (temp + rename) replaces the inode; on Linux/macOS
      // fs.watch(file) stays glued to the unlinked inode and never sees later
      // edits. Directory watch + basename filter survives the replace.
      const settingsBasename = path.basename(this.settingsPath);
      this._fileWatcher = fsSync.watch(settingsDir, (eventType, filename) => {
        // Ignore our own changes
        if (this._isInternalChange) {
          return;
        }

        // Some platforms emit null filenames; treat those as potential hits.
        if (filename && filename !== settingsBasename) {
          return;
        }

        // Watch both "change" and "rename". Atomic replace saves often surface as
        // rename events, especially on Windows and editor-safe-write workflows.
        if (eventType === 'change' || eventType === 'rename') {
          // Clear existing debounce timer
          if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
          }

          // Set new debounce timer
          this._debounceTimer = setTimeout(() => {
            this._bgWork.track(
              this._handleExternalFileChange(eventType, filename || settingsBasename).catch(
                (error) => {
                  logger.error('[SettingsService] Debounced external change failed', {
                    error: error.message
                  });
                }
              )
            );
          }, this._debounceDelay);
          if (typeof this._debounceTimer.unref === 'function') {
            this._debounceTimer.unref();
          }
        }
      });

      // The watcher must not keep the process alive on its own: the Electron
      // app lifecycle owns process lifetime, and in Jest a ref'd FSWatcher
      // prevents the worker from exiting after the test run completes.
      if (typeof this._fileWatcher.unref === 'function') {
        this._fileWatcher.unref();
      }

      // Handle watcher errors
      this._fileWatcher.on('error', (error) => {
        logger.error('[SettingsService] File watcher error', {
          error: error.message
        });

        if (this._debounceTimer) {
          clearTimeout(this._debounceTimer);
          this._debounceTimer = null;
        }
        if (this._restartTimer) {
          clearTimeout(this._restartTimer);
          this._restartTimer = null;
        }

        // Attempt to restart watcher with exponential backoff
        // Uses restart count for backoff factor (5s, 10s, 20s, 40s, ...)
        const backoffDelay =
          DEBOUNCE.WATCHER_RESTART_BASE * Math.pow(2, this._watcherRestartCount || 0);
        const jitteredDelay = backoffDelay * (0.9 + Math.random() * 0.2);
        this._restartTimer = setTimeout(() => {
          this._restartTimer = null;
          this._restartFileWatcher();
        }, jitteredDelay);
      });

      logger.info(`[SettingsService] File watcher started for: ${this.settingsPath}`);
    } catch (error) {
      logger.warn(`[SettingsService] Failed to start file watcher: ${error.message}`);
      // Non-fatal - app can still function without file watching
    }
  }

  /**
   * Restart the file watcher
   * @private
   */
  _restartFileWatcher() {
    const now = Date.now();

    // Reset counter if window has passed
    if (now - this._watcherRestartWindowStart > this._watcherRestartWindow) {
      this._watcherRestartCount = 0;
      this._watcherRestartWindowStart = now;
    }

    // Check if restart limit exceeded
    if (this._watcherRestartCount >= this._maxWatcherRestarts) {
      logger.error(
        `[SettingsService] File watcher restart limit exceeded (${this._maxWatcherRestarts} restarts in ${this._watcherRestartWindow}ms). Disabling file watcher.`
      );
      this._stopFileWatcher();
      return;
    }

    // Increment counter and restart
    this._watcherRestartCount++;
    logger.info(
      `[SettingsService] Restarting file watcher (attempt ${this._watcherRestartCount}/${this._maxWatcherRestarts})`
    );

    this._stopFileWatcher();
    this._startFileWatcher();
  }

  /**
   * Stop watching the settings file
   * @private
   */
  _stopFileWatcher() {
    if (this._fileWatcher) {
      try {
        this._fileWatcher.close();
        this._fileWatcher = null;
        logger.info('[SettingsService] File watcher stopped');
      } catch (error) {
        logger.error('[SettingsService] Error stopping file watcher', {
          error: error.message
        });
      }
    }

    // Clear debounce timer
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
  }

  /**
   * Handle external file changes
   * @private
   */
  async _handleExternalFileChange(/** @type {any} */ eventType, /** @type {any} */ filename) {
    try {
      logger.debug(`[SettingsService] External file change detected: ${eventType}, ${filename}`);

      // Atomic replace writes can produce transient ENOENT windows.
      // Give the file a brief chance to reappear before treating it as deleted.
      const settingsFileReady = await this._waitForSettingsFile();
      if (!settingsFileReady) {
        logger.info(
          '[SettingsService] Settings file missing after external change, using defaults'
        );
        const fallbackSettings = { ...this.defaults };
        this._cache = fallbackSettings;
        this._cacheTimestamp = Date.now();
        await this._propagateExternalSettingsChange(fallbackSettings, {
          source: 'external-missing',
          eventType,
          filename
        });
        return;
      }

      // Invalidate cache to force reload
      this.invalidateCache();

      // Reload settings from disk
      const latestSettings = await this.load();
      logger.debug('[SettingsService] Settings reloaded from external change');

      await this._propagateExternalSettingsChange(latestSettings, {
        source: 'external-file',
        eventType,
        filename
      });
    } catch (error) {
      logger.error('[SettingsService] Failed to handle external file change', {
        error: error.message
      });
      // Invalidate cache anyway to prevent stale data
      this.invalidateCache();
    }
  }

  async _waitForSettingsFile() {
    for (let attempt = 0; attempt < this._externalChangeMaxRetries; attempt++) {
      try {
        await fs.access(this.settingsPath);
        return true;
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
        const isLastAttempt = attempt === this._externalChangeMaxRetries - 1;
        if (isLastAttempt) {
          return false;
        }
        const retryDelay = Math.ceil(this._externalChangeSettleMs / this._externalChangeMaxRetries);
        await delay(retryDelay);
      }
    }
    return false;
  }

  async _propagateExternalSettingsChange(
    /** @type {any} */ settings,
    /** @type {any} */ metadata = {}
  ) {
    const eventPayload = {
      settings,
      source: metadata.source || 'external',
      timestamp: metadata.timestamp || Date.now(),
      eventType: metadata.eventType,
      filename: metadata.filename
    };

    let handledByMainCallback = false;
    if (typeof this._externalSettingsChangedHandler === 'function') {
      try {
        await this._externalSettingsChangedHandler(settings, eventPayload);
        handledByMainCallback = true;
      } catch (error) {
        logger.error('[SettingsService] External settings callback failed', {
          error: error?.message
        });
      }
    }

    if (!handledByMainCallback) {
      await this._notifySettingsChanged(eventPayload);
    }
  }

  /**
   * Notify renderer process of settings changes via IPC
   * @private
   */
  async _notifySettingsChanged(/** @type {any} */ payload = null, /** @type {any} */ options = {}) {
    try {
      const isEnvelope =
        payload &&
        typeof payload === 'object' &&
        Object.prototype.hasOwnProperty.call(payload, 'settings');
      let settings = isEnvelope ? payload.settings : payload;
      if (!settings || typeof settings !== 'object') {
        settings = await this.load();
      }
      const source =
        (isEnvelope && typeof payload.source === 'string' && payload.source) ||
        options.source ||
        'external';
      const timestamp =
        (isEnvelope && typeof payload.timestamp === 'number' && payload.timestamp) || Date.now();
      const eventPayload = {
        settings,
        source,
        timestamp
      };

      // Get all BrowserWindows and send event
      const { BrowserWindow } = require('electron');
      const windows = BrowserWindow.getAllWindows();
      windows.forEach((win) => {
        if (win && !win.isDestroyed() && win.webContents) {
          try {
            safeSend(win.webContents, IPC_EVENTS.SETTINGS_CHANGED_EXTERNAL, eventPayload);
          } catch (error) {
            logger.warn(
              `[SettingsService] Failed to send settings-changed event: ${error.message}`
            );
          }
        }
      });
    } catch (error) {
      logger.warn(`[SettingsService] Failed to notify settings change: ${error.message}`);
    }
  }

  /**
   * Shutdown the service and cleanup resources
   * @returns {Promise<void>}
   */
  async shutdown() {
    this._isShuttingDown = true;
    // Drain tracked background work (external change handlers, etc.)
    await this._bgWork.drain();
    if (this._internalChangeTimer) {
      clearTimeout(this._internalChangeTimer);
      this._internalChangeTimer = null;
    }
    this._stopFileWatcher();
  }
}

// Use shared singleton factory for getInstance, registerWithContainer, resetInstance
const { getInstance, createInstance, registerWithContainer, resetInstance } =
  createSingletonHelpers({
    ServiceClass: SettingsService,
    serviceId: 'SETTINGS',
    serviceName: 'SettingsService',
    getContainer: () => require('./ServiceContainer'),
    shutdownMethod: 'shutdown'
  });

module.exports = SettingsService;
module.exports.getInstance = getInstance;
module.exports.createInstance = createInstance;
module.exports.registerWithContainer = registerWithContainer;
module.exports.resetInstance = resetInstance;
