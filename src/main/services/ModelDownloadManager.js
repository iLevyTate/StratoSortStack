// @ts-check
/**
 * ModelDownloadManager — resumable HTTPS download of GGUF model files
 * with strict integrity verification.
 *
 * Only downloads from an explicit allowlist of hosts (huggingface.co,
 * hf.co). Every model in the registry must declare a SHA-256; downloads
 * verify the hash before swap-renaming the temp file into place, so a
 * partial or corrupted download can never leave a poisoned model on
 * disk. Progress callbacks fan out to every registered subscriber so
 * the renderer can show per-model progress.
 */
const path = require('path');
const fs = require('fs').promises;
const { createWriteStream } = require('fs');
const https = require('https');
const crypto = require('crypto');
const { createLogger } = require('../../shared/logger');
const { MODEL_CATALOG, getModel } = require('../../shared/modelRegistry');
const { ensureResolvedModelsPath } = require('./modelPathResolver');
const { delay } = require('../../shared/promiseUtils');

const logger = createLogger('ModelDownloadManager');
const DEFAULT_DOWNLOAD_MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;
const REQUIRED_SHA256_REGEX = /^[a-f0-9]{64}$/i;
const ALLOWED_MODEL_DOWNLOAD_HOSTS = Object.freeze(['huggingface.co', 'hf.co']);

class ModelDownloadManager {
  constructor() {
    this._modelPath = null;
    this._modelPathInitPromise = null;
    this._downloads = new Map(); // filename -> download state
    this._progressCallbacks = new Set();
  }

  async _ensureModelPath() {
    if (this._modelPath) return this._modelPath;
    if (!this._modelPathInitPromise) {
      this._modelPathInitPromise = (async () => {
        const resolved = await ensureResolvedModelsPath();
        this._modelPath = resolved.modelsPath;
        if (resolved.source === 'legacy') {
          logger.warn('[Download] Using legacy models directory', {
            modelsPath: resolved.modelsPath,
            currentModelsPath: /** @type {any} */ (resolved).currentModelsPath
          });
        }
        return this._modelPath;
      })();
    }
    try {
      return await this._modelPathInitPromise;
    } finally {
      this._modelPathInitPromise = null;
    }
  }

  async initialize() {
    await this._ensureModelPath();
  }

  /**
   * Get list of downloaded models
   */
  async getDownloadedModels() {
    try {
      const modelPath = await this._ensureModelPath();
      const files = await fs.readdir(modelPath);
      const ggufFiles = files.filter((f) => /\.gguf$/i.test(f));

      // allSettled (not Promise.all): a single per-file stat rejection — e.g. a
      // .partial → final rename (ENOENT) racing the readdir, or a per-file
      // EACCES — must not collapse the whole installed list to [] (which would
      // make DegradationManager report every present model as "missing" and
      // prompt a needless re-download). Keep the healthy entries; drop only the
      // file that faulted.
      const settled = await Promise.allSettled(
        ggufFiles.map(async (filename) => {
          const filePath = path.join(modelPath, filename);
          const stats = await fs.stat(filePath);
          const registryInfo = /** @type {Record<string, any>} */ (getModel(filename) || {});

          return {
            filename,
            path: filePath,
            sizeBytes: stats.size,
            sizeMB: Math.round(stats.size / 1024 / 1024),
            type: registryInfo.type || 'unknown',
            displayName: registryInfo.displayName || filename,
            isComplete: !filename.endsWith('.partial')
          };
        })
      );

      /** @type {any[]} */
      const models = [];
      settled.forEach((outcome, i) => {
        if (outcome.status === 'fulfilled') {
          models.push(outcome.value);
          return;
        }
        // ENOENT here is expected churn (the file was renamed/removed between
        // readdir and stat); stay quiet. Any other code is a real per-file read
        // fault worth a trace so a partially-missing list isn't silent.
        const reason = outcome.reason;
        if (reason?.code !== 'ENOENT') {
          logger.warn('[Download] Failed to stat a model file; skipping it', {
            filename: ggufFiles[i],
            code: reason?.code,
            error: reason?.message
          });
        }
      });
      return models;
    } catch (error) {
      // ENOENT means the models dir doesn't exist yet (fresh install) — [] is the
      // correct answer and logging would be startup noise. Any other code
      // (EACCES/EBUSY) from the directory read or path resolution is a real read
      // fault; without a trace DegradationManager reports present models as
      // "missing" and prompts a needless re-download while the IO fault stays
      // invisible. (Per-file stat faults no longer reach here — allSettled keeps
      // the healthy entries and warns per file above.)
      if (error?.code !== 'ENOENT') {
        logger.warn('[Download] Failed to read models directory; reporting none installed', {
          modelsPath: this._modelPath,
          code: error?.code,
          error: error?.message
        });
      }
      return [];
    }
  }

  /**
   * Check available disk space
   */
  async checkDiskSpace(/** @type {any} */ requiredBytes) {
    try {
      const modelPath = await this._ensureModelPath();
      // and support modern Windows environments where wmic is deprecated.
      // fs.statfs is available since Node 18.15.0.
      if (fs.statfs) {
        const stats = await fs.statfs(modelPath);
        // bavail = blocks available to unprivileged users; bfree also counts
        // root-reserved blocks and overestimates usable space (~5% of volume).
        const freeSpace = stats.bavail * stats.bsize;
        return { available: freeSpace, sufficient: freeSpace > requiredBytes * 1.1 };
      }

      // fs.statfs is available since Node 18.15+; Electron 40 ships Node 20+.
      // If somehow unavailable, assume sufficient space and warn.
      logger.warn('[Download] fs.statfs not available, skipping disk space check');
      return { available: Infinity, sufficient: true };
    } catch (error) {
      // Fail closed: an errored check means we genuinely don't know whether a
      // multi-GB download fits. Proceeding used to fill the disk and fail
      // hundreds of MB in — worse than refusing up front with a clear reason.
      logger.warn('[Download] Could not check disk space; refusing download', {
        error: error?.message
      });
      return /** @type {any} */ ({
        available: null,
        sufficient: false,
        checkFailed: true,
        error: error?.message
      });
    }
  }

  /**
   * Resolve model info from the catalog.
   * Checks top-level entries first, then scans clipModel companions
   * so projector files like mmproj-model-f16.gguf are downloadable by name.
   * @private
   */
  _resolveModelInfo(/** @type {any} */ filename) {
    const direct = getModel(filename);
    if (direct) return direct;

    // Check if filename matches a clipModel companion of any vision model
    const lowerFilename = filename?.toLowerCase();
    for (const info of Object.values(MODEL_CATALOG)) {
      if (info.clipModel && info.clipModel.name?.toLowerCase() === lowerFilename) {
        return {
          type: 'vision-helper',
          displayName: `Vision Projector (${filename})`,
          description: `Required companion for vision model`,
          size: info.clipModel.size,
          url: info.clipModel.url,
          checksum: info.clipModel.checksum
        };
      }
    }

    return null;
  }

  /**
   * Download a model with progress tracking and resume support.
   * For vision models with a clipModel companion (mmproj), the companion
   * is automatically downloaded after the main model completes.
   */
  async downloadModel(
    /** @type {any} */ filename,
    /** @type {Record<string, any>} */ options = {}
  ) {
    const modelPath = await this._ensureModelPath();
    const modelInfo = /** @type {Record<string, any>} */ (this._resolveModelInfo(filename));
    if (!modelInfo) {
      throw new Error(`Unknown model: ${filename}`);
    }
    const expectedChecksum = modelInfo.checksum || modelInfo.sha256;
    if (!this._isValidSha256(expectedChecksum)) {
      throw new Error(`Model checksum missing or invalid for ${filename}`);
    }
    this._validateDownloadUrl(modelInfo.url, filename);

    const { onProgress, signal } = options;
    const isRedirectContinuation = Boolean(options._redirectUrl);

    // Guard: prevent concurrent downloads of the same file (corrupts .partial).
    // A redirect transitions the state from 'downloading' -> 'redirecting'
    // before recursing into this method. Previously the guard only rejected
    // 'downloading', so during the redirect window a *second* external caller
    // would pass the guard and start a parallel HTTPS stream into the same
    // `.partial` file — silent corruption. Treat 'redirecting' and 'retrying'
    // as in-progress too, and explicitly allow our own recursive redirect /
    // retry continuations through.
    const isRetryContinuation = Boolean(options._retryContinuation);
    const existing = this._downloads.get(filename);
    if (
      existing &&
      (existing.status === 'downloading' ||
        existing.status === 'redirecting' ||
        existing.status === 'retrying') &&
      !isRedirectContinuation &&
      !isRetryContinuation
    ) {
      throw new Error(`Download already in progress: ${filename}`);
    }
    const retryAttempt = Number.isInteger(options._attempt) ? options._attempt : 0;
    const maxRetries = Number.isInteger(options._maxRetries)
      ? Math.max(0, options._maxRetries)
      : DEFAULT_DOWNLOAD_MAX_RETRIES;
    const filePath = path.join(modelPath, filename);
    const partialPath = filePath + '.partial';

    // Check disk space — aggregated across every other in-flight download.
    // Without the aggregate, N concurrent downloads each pass an individual
    // check while jointly exceeding free space and failing mid-stream.
    let pendingBytes = 0;
    for (const [name, state] of this._downloads) {
      if (name === filename) continue;
      if (
        state.status === 'downloading' ||
        state.status === 'redirecting' ||
        state.status === 'retrying'
      ) {
        pendingBytes += Math.max(0, (state.totalBytes || 0) - (state.downloadedBytes || 0));
      }
    }
    const spaceCheck = await this.checkDiskSpace(modelInfo.size + pendingBytes);
    if (!spaceCheck.sufficient) {
      if (spaceCheck.checkFailed) {
        throw new Error(
          `Cannot verify free disk space (${spaceCheck.error || 'unknown error'}); ` +
            `refusing to start a ${Math.round(modelInfo.size / 1024 / 1024 / 1024)}GB download`
        );
      }
      const neededGb = Math.round((modelInfo.size + pendingBytes) / 1024 / 1024 / 1024);
      throw new Error(
        `Insufficient disk space. Need ${neededGb}GB` +
          (pendingBytes > 0 ? ' (including in-progress downloads)' : '') +
          `, have ${Math.round(spaceCheck.available / 1024 / 1024 / 1024)}GB`
      );
    }

    // Check for existing partial download
    let startByte = 0;
    try {
      const partialStats = await fs.stat(partialPath);
      if (partialStats.size >= modelInfo.size) {
        // Stale/invalid partial (equal or larger than target size) can cause
        // bad range requests and unrecoverable retry loops. Restart cleanly.
        await this._cleanupPartialFile(partialPath);
        logger.warn(
          `[Download] Discarded stale partial for ${filename} (${partialStats.size} bytes), restarting`
        );
      } else {
        startByte = partialStats.size;
        logger.info(`[Download] Resuming from byte ${startByte}`);
      }
    } catch {
      // No partial file, start fresh
    }

    // Use redirect URL if provided (for following HTTP redirects), with a max redirect limit
    const downloadUrl = options._redirectUrl || modelInfo.url;
    const redirectCount = options._redirectCount || 0;
    const MAX_REDIRECTS = 5;
    const validatedDownloadUrl = this._validateDownloadUrl(downloadUrl, filename).toString();

    // Create an internal AbortController so cancelDownload() can work
    const internalAbortController = new AbortController();

    // Track download state
    const downloadState = {
      filename,
      url: validatedDownloadUrl,
      totalBytes: modelInfo.size,
      downloadedBytes: startByte,
      startByte, // Track initial byte offset for accurate speed calculation
      startTime: Date.now(),
      status: 'downloading',
      abortController: internalAbortController
    };
    this._downloads.set(filename, downloadState);

    return new Promise((resolve, reject) => {
      const url = new URL(validatedDownloadUrl);
      let settled = false;
      // Separate from `settled`: a retryable failure claims this immediately so
      // concurrent timeout+error events cannot double-schedule retries, while
      // the outer promise stays pending until the retry chain settles.
      let failureClaimed = false;
      // Hoisted abort-listener references so cleanup runs regardless of which
      // settle path fires (writeStream finish/error, request.on('error'),
      // request.setTimeout, etc.). The previous design only cleaned up on
      // writeStream events — listeners leaked on early-failure paths that
      // never attached writeStream listeners.
      /** @type {((ev?: any) => void)|null} */
      let onAbort = null;
      /** @type {import('fs').WriteStream|null} */
      let writeStream = null;
      /** @type {import('http').ClientRequest|null} */
      let request = null;
      const cleanupAbortListeners = () => {
        if (!onAbort) return;
        try {
          internalAbortController.signal.removeEventListener('abort', onAbort);
        } catch {
          /* defensive */
        }
        if (signal) {
          try {
            signal.removeEventListener('abort', onAbort);
          } catch {
            /* defensive */
          }
        }
        onAbort = null;
      };

      const finalizeSuccess = (/** @type {any} */ result) => {
        if (settled) return;
        settled = true;
        cleanupAbortListeners();
        resolve(result);
      };

      const finalizeFailure = (
        /** @type {any} */ error,
        status = 'error',
        cleanupPartial = false
      ) => {
        if (settled || failureClaimed) return;
        failureClaimed = true;
        cleanupAbortListeners();
        downloadState.status = status;

        const canRetry =
          status !== 'cancelled' &&
          retryAttempt < maxRetries &&
          this._isRetryableDownloadError(error, status, {
            externalSignal: signal,
            internalSignal: internalAbortController.signal
          });

        if (canRetry) {
          // Keep the map slot occupied during the retry delay so a second
          // caller (or a second failure event) cannot start a parallel stream.
          downloadState.status = 'retrying';
        } else if (this._downloads.has(filename)) {
          this._downloads.delete(filename);
        }

        const cleanup = cleanupPartial ? this._cleanupPartialFile(partialPath) : Promise.resolve();
        /** @type {Promise<any>} */ (cleanup)
          .then(
            /** @returns {Promise<void>} */ async () => {
              if (!canRetry) {
                if (settled) return;
                settled = true;
                reject(error);
                return;
              }

              const nextAttempt = retryAttempt + 1;
              const retryDelayMs = Math.min(3000, RETRY_BASE_DELAY_MS * nextAttempt);
              logger.warn(
                `[Download] Attempt ${nextAttempt}/${maxRetries} retrying ${filename} after failure`,
                {
                  status,
                  error: error?.message || String(error),
                  retryDelayMs
                }
              );
              if (retryDelayMs > 0) {
                await delay(retryDelayMs);
              }
              if (
                internalAbortController.signal.aborted ||
                signal?.aborted ||
                downloadState.status === 'cancelled'
              ) {
                if (this._downloads.get(filename) === downloadState) {
                  this._downloads.delete(filename);
                }
                if (settled) return;
                settled = true;
                reject(new Error('Download cancelled'));
                return;
              }
              this.downloadModel(filename, {
                ...options,
                _attempt: nextAttempt,
                _retryContinuation: true
              })
                .then(finalizeSuccess)
                .catch(reject);
              return undefined;
            }
          )
          .catch(() => {
            if (settled) return;
            settled = true;
            if (this._downloads.get(filename) === downloadState) {
              this._downloads.delete(filename);
            }
            reject(error);
          });
      };

      // Honor already-aborted signals before opening sockets/streams.
      if (signal?.aborted || internalAbortController.signal.aborted) {
        finalizeFailure(new Error('Download cancelled'), 'cancelled');
        return;
      }

      /** @type {{ hostname: string, path: string, headers: Record<string, string> }} */
      const requestOptions = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: {
          'User-Agent': 'StratoSort/2.0'
        }
      };
      if (startByte > 0) {
        requestOptions.headers.Range = `bytes=${startByte}-`;
      } else {
        delete requestOptions.headers.Range;
      }

      request = https.get(requestOptions, (response) => {
        // Handle redirects with loop protection
        if (response.statusCode === 301 || response.statusCode === 302) {
          if (redirectCount >= MAX_REDIRECTS) {
            finalizeFailure(new Error(`Too many redirects (${MAX_REDIRECTS})`));
            return;
          }

          const redirectLocation = response.headers.location;
          if (!redirectLocation) {
            finalizeFailure(new Error('Redirect response missing Location header'));
            return;
          }
          let validatedRedirectUrl;
          try {
            const resolvedRedirectUrl = new URL(redirectLocation, url).toString();
            validatedRedirectUrl = this._validateDownloadUrl(
              resolvedRedirectUrl,
              filename
            ).toString();
          } catch (validationErr) {
            // Validation must happen BEFORE mutating downloadState.status to
            // 'redirecting' — otherwise a rejected redirect (e.g. file://
            // location) leaves the entry stuck in this._downloads with status
            // 'redirecting' and the concurrent-download guard blocks future
            // legitimate retries of the same filename until process restart.
            response.resume();
            finalizeFailure(validationErr);
            return;
          }

          downloadState.status = 'redirecting';
          downloadState.url = validatedRedirectUrl;

          // The recursive call creates a new internalAbortController, so the
          // listener on the old one would be a leak.
          request.removeAllListeners('error');
          request.removeAllListeners('timeout');

          response.resume(); // Drain response to free socket
          this.downloadModel(filename, {
            ...options,
            _redirectUrl: validatedRedirectUrl,
            _redirectCount: redirectCount + 1
          })
            .then(finalizeSuccess)
            .catch((err) => finalizeFailure(err));
          return;
        }

        if (response.statusCode !== 200 && response.statusCode !== 206) {
          finalizeFailure(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
          return;
        }

        let isResume = startByte > 0 && response.statusCode === 206;
        if (startByte > 0 && response.statusCode === 200) {
          logger.info('[Download] Server ignored range request, restarting from beginning');
          startByte = 0;
          downloadState.downloadedBytes = 0;
          downloadState.startByte = 0;
          isResume = false;
        }

        // Prefer the server's Content-Length for size validation.
        // Catalog sizes are informational estimates (e.g. "~21MB") and may
        // not match the real file byte-for-byte, causing spurious mismatches.
        const contentLength = parseInt(response.headers['content-length'], 10);
        const serverExpectedBytes =
          Number.isFinite(contentLength) && contentLength > 0
            ? isResume
              ? contentLength + startByte
              : contentLength
            : null;
        const expectedBytes = serverExpectedBytes || modelInfo.size;

        writeStream = createWriteStream(partialPath, {
          flags: isResume ? 'a' : 'w'
        });

        let downloaded = startByte;
        const total = expectedBytes;

        response.on('data', (chunk) => {
          downloaded += chunk.length;
          downloadState.downloadedBytes = downloaded;

          const progress = {
            filename,
            downloadedBytes: downloaded,
            totalBytes: total,
            percent: Math.round((downloaded / total) * 100),
            speedBps: this._calculateSpeed(downloadState),
            etaSeconds: this._calculateETA(downloadState)
          };

          if (onProgress) onProgress(progress);
          this._notifyProgress(progress);
        });

        response.pipe(writeStream);

        writeStream.on('finish', async () => {
          if (typeof writeStream.close === 'function') {
            writeStream.close();
          }
          try {
            // Verify file size against server-reported Content-Length (or catalog fallback).
            const stats = await fs.stat(partialPath);
            if (stats.size !== expectedBytes) {
              finalizeFailure(
                new Error(
                  `Download incomplete - file size mismatch (got ${stats.size}, expected ${expectedBytes})`
                ),
                'incomplete',
                true
              );
              return;
            }

            // Verify checksum (required for all remote model artifacts).
            const isValid = await this._verifyChecksum(partialPath, expectedChecksum);
            if (!isValid) {
              finalizeFailure(
                new Error('Download corrupted - checksum mismatch'),
                'corrupted',
                true
              );
              return;
            }

            // Rename to final filename
            await fs.rename(partialPath, filePath);
            downloadState.status = 'complete';
            if (this._downloads.has(filename)) this._downloads.delete(filename);

            const finalProgress = {
              filename,
              downloadedBytes: expectedBytes,
              totalBytes: expectedBytes,
              percent: 100,
              speedBps: 0,
              etaSeconds: 0
            };
            if (onProgress) onProgress(finalProgress);
            this._notifyProgress(finalProgress);

            logger.info(`[Download] Completed: ${filename}`);

            let companionDownload = null;
            // Auto-download clipModel companion (mmproj) for vision models
            if (modelInfo.clipModel && modelInfo.clipModel.name && modelInfo.clipModel.url) {
              const companionPath = path.join(modelPath, modelInfo.clipModel.name);
              const companionTotalBytes = Number(modelInfo.clipModel.size) || 0;
              try {
                await fs.access(companionPath);
                logger.info(`[Download] Companion already exists: ${modelInfo.clipModel.name}`);
                companionDownload = {
                  name: modelInfo.clipModel.name,
                  success: true,
                  alreadyPresent: true,
                  downloadedBytes: companionTotalBytes,
                  totalBytes: companionTotalBytes
                };
              } catch {
                logger.info(`[Download] Downloading companion: ${modelInfo.clipModel.name}`);
                try {
                  const companionResult = await this.downloadModel(modelInfo.clipModel.name, {
                    onProgress,
                    signal
                  });
                  companionDownload = {
                    name: modelInfo.clipModel.name,
                    success: true,
                    alreadyPresent: false,
                    downloadedBytes:
                      Number(companionResult?.downloadedBytes) || companionTotalBytes,
                    totalBytes: Number(companionResult?.totalBytes) || companionTotalBytes
                  };
                } catch (companionError) {
                  logger.warn(
                    `[Download] Companion download failed (vision may not work): ${companionError.message}`
                  );
                  companionDownload = {
                    name: modelInfo.clipModel.name,
                    success: false,
                    alreadyPresent: false,
                    error: companionError.message,
                    downloadedBytes: 0,
                    totalBytes: companionTotalBytes
                  };
                }
              }
            }

            const companionDownloadedBytes = Number(companionDownload?.downloadedBytes) || 0;
            const companionTotalBytes = Number(companionDownload?.totalBytes) || 0;
            const degraded = Boolean(companionDownload) && companionDownload.success === false;
            finalizeSuccess({
              success: true,
              degraded,
              path: filePath,
              downloadedBytes: expectedBytes + companionDownloadedBytes,
              totalBytes: expectedBytes + companionTotalBytes,
              companionDownload
            });
          } catch (finishError) {
            finalizeFailure(finishError);
          }
        });

        writeStream.on('error', (error) => {
          if (typeof writeStream.close === 'function') {
            writeStream.close();
          }
          // Write-stream errors (ENOSPC, EIO, EACCES, EBADF, …) indicate the
          // bytes on disk can't be trusted — either the write didn't land or
          // the filesystem itself is failing. Always wipe the `.partial` so
          // the next attempt starts clean; without cleanupPartial the next
          // resume would reuse a bad startByte and silently corrupt the
          // final file after rename. Size / checksum mismatch paths above
          // already pass cleanupPartial: true for the same reason.
          // Translate the raw OS error code into a user-readable message so
          // the renderer can show "Disk full" instead of the cryptic
          // "Download incomplete - file size mismatch" the size-check path
          // would otherwise produce after a failed write.
          finalizeFailure(this._wrapWriteStreamError(error, filename), 'error', true);
        });

        // Abort listeners are attached immediately after https.get (below) so
        // cancel during connect/redirect is honored. Keep stream-event cleanup
        // here as a belt-and-suspenders release if a settle path skips finalize*.
        writeStream.on('finish', cleanupAbortListeners);
        writeStream.on('error', cleanupAbortListeners);
      });

      // Wire abort as soon as the request exists — previously listeners were
      // only attached after the response + writeStream, so cancel during the
      // connection/redirect phase was silently ignored.
      onAbort = () => {
        cleanupAbortListeners();
        try {
          request?.destroy();
        } catch {
          /* defensive */
        }
        try {
          writeStream?.destroy();
        } catch {
          /* defensive */
        }
        finalizeFailure(new Error('Download cancelled'), 'cancelled');
      };
      internalAbortController.signal.addEventListener('abort', onAbort);
      if (signal) {
        signal.addEventListener('abort', onAbort);
      }
      if (signal?.aborted || internalAbortController.signal.aborted) {
        onAbort();
        return;
      }

      request.on('error', (error) => {
        finalizeFailure(error);
      });

      request.setTimeout(30000, () => {
        request.destroy();
        finalizeFailure(new Error('Download timeout'));
      });
    });
  }

  /**
   * Get current download status for all active downloads
   * @returns {{ active: number, downloads: Object[] }}
   */
  getStatus() {
    const downloads = [];
    for (const [filename, state] of this._downloads) {
      downloads.push({
        filename,
        status: state.status,
        progress: state.totalBytes
          ? Math.round((state.downloadedBytes / state.totalBytes) * 100)
          : 0,
        totalBytes: state.totalBytes || 0,
        downloadedBytes: state.downloadedBytes || 0
      });
    }
    return { active: downloads.length, downloads };
  }

  /**
   * Check if a model is currently being downloaded.
   * @param {string} filename - Model filename
   * @returns {boolean}
   */
  isDownloading(filename) {
    const state = this._downloads.get(filename);
    return (
      !!state &&
      (state.status === 'downloading' ||
        state.status === 'redirecting' ||
        state.status === 'retrying')
    );
  }

  /**
   * Cancel an in-progress download
   */
  cancelDownload(/** @type {any} */ filename) {
    const download = this._downloads.get(filename);
    if (download && download.abortController) {
      download.status = 'cancelled';
      download.abortController.abort();
      return true;
    }
    return false;
  }

  /**
   * Delete a downloaded model
   */
  async deleteModel(/** @type {any} */ filename) {
    const modelPath = await this._ensureModelPath();
    const filePath = path.join(modelPath, filename);
    const partialPath = filePath + '.partial';

    // ENOENT is fine (file already gone), but any other unlink failure —
    // EBUSY/EPERM when the model is currently memory-mapped by the engine on
    // Windows is the common one — must be reported. Swallowing it produced a
    // "deleted" toast while the file was still on disk.
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn(`[Download] Failed to delete model ${filename}: ${error.message}`);
        const inUse = error?.code === 'EBUSY' || error?.code === 'EPERM';
        return {
          success: false,
          error: inUse
            ? 'Model file is in use — it may be loaded by the AI engine. Switch the active model or restart the app, then try again.'
            : `Could not delete model file: ${error.message}`,
          errorCode: error?.code || 'DELETE_FAILED'
        };
      }
    }

    // Best-effort cleanup of a stale partial download; never blocks success.
    try {
      await fs.unlink(partialPath);
    } catch {
      /* ignore */
    }

    logger.info(`[Download] Deleted model: ${filename}`);
    return { success: true };
  }

  /**
   * Register progress callback
   */
  onProgress(/** @type {any} */ callback) {
    this._progressCallbacks.add(callback);
    return () => this._progressCallbacks.delete(callback);
  }

  _notifyProgress(/** @type {any} */ progress) {
    this._progressCallbacks.forEach((cb) => {
      try {
        cb(progress);
      } catch {
        /* ignore */
      }
    });
  }

  /**
   * Translate a raw write-stream error into a user-facing message based on
   * the OS error code. The returned Error preserves `.code` so retry-decision
   * code (_isRetryableDownloadError) can still inspect it. We do this at the
   * boundary rather than letting the size-check path downstream report the
   * confusing "file size mismatch" after a failed write.
   *
   * @param {Error & { code?: string }} error
   * @param {string} filename
   * @returns {Error & { code?: string }}
   */
  _wrapWriteStreamError(error, filename) {
    const code = error?.code;
    /** @type {Record<string, string>} */
    const messageMap = {
      ENOSPC: `Disk full — not enough free space to download ${filename}`,
      EACCES: `Permission denied writing ${filename} (check models directory permissions)`,
      EPERM: `Permission denied writing ${filename} (check models directory permissions)`,
      ENOENT: `Models directory missing while writing ${filename}`,
      EROFS: `Models directory is read-only; cannot write ${filename}`,
      EIO: `Disk I/O error while writing ${filename} (filesystem may be failing)`,
      ENAMETOOLONG: `Model filename is too long for this filesystem: ${filename}`,
      EMFILE: 'Too many open files; close some apps and retry the download',
      ENFILE: 'System file-descriptor limit reached; close some apps and retry'
    };
    const friendly = messageMap[code];
    if (!friendly) return error;
    const wrapped = /** @type {Error & { code?: string, cause?: any }} */ (new Error(friendly));
    wrapped.code = code;
    wrapped.cause = error;
    return wrapped;
  }

  _calculateSpeed(/** @type {any} */ state) {
    const elapsed = (Date.now() - state.startTime) / 1000;
    if (elapsed < 1) return 0;
    // Subtract startByte to only measure bytes downloaded in THIS session
    const sessionBytes = state.downloadedBytes - (state.startByte || 0);
    return Math.round(sessionBytes / elapsed);
  }

  _calculateETA(/** @type {any} */ state) {
    const speed = this._calculateSpeed(state);
    if (speed === 0) return Infinity;
    const remaining = state.totalBytes - state.downloadedBytes;
    return Math.round(remaining / speed);
  }

  /**
   * Cancel all active downloads and clean up resources.
   * Called during app shutdown by ServiceContainer.
   */
  shutdown() {
    for (const [filename, download] of this._downloads) {
      try {
        if (download.abortController) {
          download.abortController.abort();
        }
      } catch {
        /* ignore — already aborted */
      }
      logger.debug(`[Download] Cancelled active download on shutdown: ${filename}`);
    }
    this._downloads.clear();
    this._progressCallbacks.clear();
  }

  _isValidSha256(/** @type {any} */ value) {
    return typeof value === 'string' && REQUIRED_SHA256_REGEX.test(value.trim());
  }

  _isAllowedDownloadHost(/** @type {any} */ hostname) {
    if (!hostname || typeof hostname !== 'string') return false;
    const host = hostname.toLowerCase();
    return ALLOWED_MODEL_DOWNLOAD_HOSTS.some(
      (allowedHost) => host === allowedHost || host.endsWith(`.${allowedHost}`)
    );
  }

  _validateDownloadUrl(/** @type {any} */ rawUrl, /** @type {any} */ filename) {
    let parsedUrl;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      throw new Error(`Invalid download URL for ${filename}`);
    }
    if (parsedUrl.protocol !== 'https:') {
      throw new Error(`Blocked non-HTTPS model download for ${filename}`);
    }
    if (parsedUrl.username || parsedUrl.password) {
      throw new Error(`Blocked credentialed download URL for ${filename}`);
    }
    if (!this._isAllowedDownloadHost(parsedUrl.hostname)) {
      throw new Error(`Blocked download from untrusted host: ${parsedUrl.hostname}`);
    }
    return parsedUrl;
  }

  async _verifyChecksum(/** @type {any} */ filePath, /** @type {any} */ expectedHash) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = require('fs').createReadStream(filePath);

      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => {
        const actualHash = hash.digest('hex').toLowerCase();
        const normalizedExpected = String(expectedHash || '')
          .trim()
          .toLowerCase();
        resolve(actualHash === normalizedExpected);
      });
      stream.on('error', reject);
    });
  }

  async _cleanupPartialFile(/** @type {any} */ partialPath) {
    try {
      await fs.unlink(partialPath);
    } catch {
      // Best-effort cleanup: file may not exist if write failed before creation.
    }
  }

  _isRetryableDownloadError(
    /** @type {any} */ error,
    /** @type {any} */ status,
    /** @type {{ externalSignal?: AbortSignal, internalSignal?: AbortSignal }} */ signals = {}
  ) {
    if (status === 'cancelled') return false;
    if (signals?.externalSignal?.aborted || signals?.internalSignal?.aborted) return false;
    if (status === 'incomplete' || status === 'corrupted') return true;
    const message = String(error?.message || '').toLowerCase();
    const code = String(error?.code || '').toUpperCase();
    if (message.includes('timeout') || message.includes('file size mismatch')) return true;
    if (/^http 5\d{2}/i.test(String(error?.message || ''))) return true;
    return ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN'].includes(
      code
    );
  }
}

// Singleton via shared factory: getInstance() prefers the DI container and
// registerWithContainer() migrates any early local instance into it, so the
// module path and the container path can never fork into two live managers.
const { createSingletonHelpers } = require('../../shared/singletonFactory');

const { getInstance, createInstance, registerWithContainer, resetInstance } =
  createSingletonHelpers({
    ServiceClass: ModelDownloadManager,
    serviceId: 'MODEL_DOWNLOAD_MANAGER',
    serviceName: 'ModelDownloadManager',
    getContainer: () => require('./ServiceContainer'),
    shutdownMethod: 'shutdown'
  });

module.exports = {
  ModelDownloadManager,
  getInstance,
  createInstance,
  registerWithContainer,
  resetInstance
};
