// @ts-check
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { isCaseInsensitiveFileSystem } = require('../../shared/crossPlatformUtils');

const DEFAULTS = {
  maxCandidates: 200,
  maxDirEntries: 2000
};

/**
 * Compute SHA-256 checksum of a file using streaming.
 *
 * Accepts an optional `{ cache, stat }` options bag. When a cache adapter is
 * supplied, a hit for the same (path, size, mtimeMs) returns the cached hash
 * without touching the file; misses populate the cache after hashing. Callers
 * that don't pass a cache get the original stream-and-hash behavior.
 *
 * @param {string} filePath
 * @param {Object} [options]
 * @param {{ get: Function, set: Function }} [options.cache] - HashCache-compatible adapter
 * @param {{ size: number, mtimeMs: number }} [options.stat] - Pre-read stat info (avoids extra fs.stat)
 * @returns {Promise<string>}
 */
async function computeFileChecksum(filePath, options = {}) {
  const cache = options.cache || null;
  let statInfo = options.stat || null;

  if (cache) {
    if (!statInfo) {
      try {
        const s = await fs.stat(filePath);
        statInfo = { size: s.size, mtimeMs: s.mtimeMs };
      } catch {
        statInfo = null;
      }
    }
    if (statInfo) {
      const cached = await cache.get(filePath, statInfo);
      if (cached) return cached;
    }
  }

  const fsModule = require('fs');
  let digest;
  if (typeof fsModule.createReadStream === 'function') {
    digest = await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fsModule.createReadStream(filePath);

      const cleanup = () => {
        if (typeof stream.removeAllListeners === 'function') {
          stream.removeAllListeners();
        }
        if (typeof stream.destroy === 'function') {
          stream.destroy();
        }
      };

      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => {
        cleanup();
        resolve(hash.digest('hex'));
      });
      stream.on('error', (err) => {
        cleanup();
        reject(err);
      });
    });
  } else if (typeof fs?.readFile === 'function') {
    const data = await fs.readFile(filePath);
    digest = crypto.createHash('sha256').update(data).digest('hex');
  } else {
    throw new Error('Checksum not supported: no readable file API available');
  }

  if (cache && statInfo) {
    try {
      await cache.set(filePath, {
        size: statInfo.size,
        mtimeMs: statInfo.mtimeMs,
        sha256: digest
      });
    } catch {
      // Cache failures are non-fatal.
    }
  }

  return digest;
}

async function statSafe(/** @type {any} */ filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

/**
 * Case-insensitive filesystems (win32, default darwin APFS/HFS+) surface the
 * same file under different casings; avoid treating source and candidate as
 * different files when they refer to the same path. The risk is asymmetric:
 * wrongly calling two paths "same" on a case-sensitive fs merely skips dedup
 * (the no-replace move guard still prevents overwrites), while wrongly
 * calling them "different" on a case-insensitive fs makes dedup checksum the
 * file against itself and unlink the only copy (F-082).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function pathsAreSameFilePath(a, b) {
  if (a === b) return true;
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const na = path.normalize(a);
  const nb = path.normalize(b);
  if (isCaseInsensitiveFileSystem()) {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
}

/**
 * Inode-level "same file" identity check — catches aliases the path compare
 * cannot (e.g. case variants on unusual filesystems, hardlinks). Requires
 * both inode numbers to be nonzero (some filesystems report 0).
 * @param {any} a - fs.Stats-like
 * @param {any} b - fs.Stats-like
 * @returns {boolean}
 */
function isSameFileByStat(a, b) {
  return Boolean(a && b && a.ino && b.ino && a.ino === b.ino && a.dev === b.dev);
}

function statForChecksum(/** @type {any} */ st) {
  if (!st || typeof st.size !== 'number') return undefined;
  const mtimeMs = Number.isFinite(st.mtimeMs) ? st.mtimeMs : 0;
  return { stat: { size: st.size, mtimeMs } };
}

function isFileStat(/** @type {any} */ stat) {
  if (!stat) return false;
  if (typeof stat.isFile === 'function') return stat.isFile();
  if (typeof stat.isFile === 'boolean') return stat.isFile;
  return false;
}

function isDirectoryStat(/** @type {any} */ stat) {
  if (!stat) return false;
  if (typeof stat.isDirectory === 'function') return stat.isDirectory();
  if (typeof stat.isDirectory === 'boolean') return stat.isDirectory;
  return false;
}

/**
 * Search a destination directory for an identical file by size+checksum.
 * @param {Object} params
 * @param {string} params.sourcePath
 * @param {string} params.destinationDir
 * @param {Function} [params.checksumFn]
 * @param {number} [params.maxCandidates]
 * @param {number} [params.maxDirEntries]
 * @param {any} [params.logger]
 * @returns {Promise<string|null>} Path to duplicate if found.
 */
/** @param {any} params */
async function findDuplicateInDirectory({
  sourcePath,
  destinationDir,
  checksumFn = computeFileChecksum,
  maxCandidates = DEFAULTS.maxCandidates,
  maxDirEntries = DEFAULTS.maxDirEntries,
  logger,
  returnSourceHash = false
}) {
  if (!sourcePath || !destinationDir) return null;
  const sourceStat = await statSafe(sourcePath);
  if (!isFileStat(sourceStat)) return null;
  if (typeof sourceStat.size !== 'number') return null;

  let entries;
  try {
    entries = await fs.readdir(destinationDir, { withFileTypes: true });
  } catch {
    return null;
  }

  if (entries.length > maxDirEntries && logger?.debug) {
    logger.debug('[DEDUP] Large directory, limiting duplicate scan', {
      destinationDir,
      entries: entries.length,
      maxDirEntries
    });
  }

  const candidates = [];
  for (const entry of entries) {
    if (candidates.length >= maxCandidates) break;
    if (!entry.isFile()) continue;
    const fullPath = path.join(destinationDir, entry.name);
    if (pathsAreSameFilePath(fullPath, sourcePath)) continue;

    const stat = await statSafe(fullPath);
    if (!isFileStat(stat)) continue;
    // Same-inode alias of the source (case variant the path compare missed,
    // hardlink, ...) — never a dedup candidate (F-082).
    if (isSameFileByStat(stat, sourceStat)) continue;
    if (typeof stat.size !== 'number' || stat.size !== sourceStat.size) continue;
    candidates.push({ path: fullPath, stat });

    if (candidates.length >= maxCandidates) break;
  }

  if (candidates.length === 0) return null;

  let sourceHash;
  try {
    sourceHash = await checksumFn(sourcePath, statForChecksum(sourceStat));
  } catch (error) {
    if (logger?.debug) {
      logger.debug('[DEDUP] Failed to compute source checksum', {
        sourcePath,
        error: error?.message
      });
    }
    return null;
  }
  for (const { path: candidatePath, stat: cstat } of candidates) {
    let candidateHash;
    try {
      candidateHash = await checksumFn(candidatePath, statForChecksum(cstat));
    } catch (error) {
      if (logger?.debug) {
        logger.debug('[DEDUP] Failed to compute candidate checksum', {
          candidate: candidatePath,
          error: error?.message
        });
      }
      continue;
    }
    if (candidateHash === sourceHash) {
      return returnSourceHash ? { path: candidatePath, sourceHash } : candidatePath;
    }
  }

  return null;
}

/**
 * Find a duplicate at the exact destination or within its directory.
 * @param {Object} params
 * @param {string} params.sourcePath
 * @param {string} params.destinationPath
 * @param {Function} [params.checksumFn]
 * @param {any} [params.logger]
 * @param {number} [params.maxCandidates]
 * @param {number} [params.maxDirEntries]
 * @returns {Promise<string|null>}
 */
/** @param {any} params */
async function findDuplicateForDestination({
  sourcePath,
  destinationPath,
  checksumFn = computeFileChecksum,
  logger,
  maxCandidates,
  maxDirEntries,
  returnSourceHash = false
}) {
  if (!sourcePath || !destinationPath) return null;

  // F-082 guard: a case-only (or otherwise aliased) destination IS the
  // source on case-insensitive filesystems. Without this check the exact-
  // destination branch below checksums the file against itself, reports a
  // "duplicate", and the caller unlinks the only copy.
  if (pathsAreSameFilePath(destinationPath, sourcePath)) return null;

  const sourceStat = await statSafe(sourcePath);
  if (!isFileStat(sourceStat)) return null;

  const destStat = await statSafe(destinationPath);
  if (isFileStat(destStat) && !isSameFileByStat(destStat, sourceStat)) {
    try {
      const [sourceHash, destHash] = await Promise.all([
        checksumFn(sourcePath, statForChecksum(sourceStat)),
        checksumFn(destinationPath, statForChecksum(destStat))
      ]);
      if (sourceHash === destHash) {
        return returnSourceHash ? { path: destinationPath, sourceHash } : destinationPath;
      }
    } catch (error) {
      if (logger?.debug) {
        logger.debug('[DEDUP] Failed to compute destination checksum', {
          destinationPath,
          error: error?.message
        });
      }
      return null;
    }
  }

  const destinationDir = path.dirname(destinationPath);
  const dirStat = await statSafe(destinationDir);
  if (!isDirectoryStat(dirStat)) return null;

  return findDuplicateInDirectory({
    sourcePath,
    destinationDir,
    checksumFn,
    maxCandidates,
    maxDirEntries,
    logger,
    returnSourceHash
  });
}

/** @param {any} params */
async function handleDuplicateMove({
  sourcePath,
  destinationPath,
  checksumFn = computeFileChecksum,
  logger,
  logPrefix = '[DEDUP]',
  dedupContext = 'unknown',
  removeEmbeddings,
  unlinkFn
}) {
  const duplicateMatch = await findDuplicateForDestination({
    sourcePath,
    destinationPath,
    checksumFn,
    logger,
    returnSourceHash: true
  });
  const duplicatePath = duplicateMatch?.path;
  if (!duplicatePath) return null;

  const sourceHash = duplicateMatch?.sourceHash;
  logger?.info?.(`${logPrefix} Skipping move - duplicate already exists`, {
    source: sourcePath,
    destination: duplicatePath,
    checksum: sourceHash ? `${sourceHash.substring(0, 16)}...` : 'unknown'
  });
  logger?.info?.('[DEDUP] Move skipped', {
    source: sourcePath,
    destination: duplicatePath,
    context: dedupContext,
    reason: 'duplicate'
  });

  // Re-verify destination still exists before deleting source (TOCTOU guard)
  try {
    await fs.access(duplicatePath);
  } catch {
    logger?.warn?.('[DEDUP] Destination disappeared before source unlink, aborting', {
      source: sourcePath,
      destination: duplicatePath
    });
    return null;
  }

  // The source is a duplicate the user never asked to delete. Put it in the
  // OS trash, where it can be recovered; a plain unlink is the fallback when
  // the platform has no trash (Linux without gio) or the caller insists.
  let sourceRemoval = 'deleted';
  if (typeof unlinkFn === 'function') {
    await unlinkFn(sourcePath);
  } else {
    sourceRemoval = await removeDuplicateSource(sourcePath, logger);
  }

  // Only after the source is gone: if the unlink (or the access check above)
  // had failed with the embeddings already removed, the file would still be
  // on disk but invisible to search.
  if (typeof removeEmbeddings === 'function') {
    try {
      await removeEmbeddings(sourcePath, logger);
    } catch {
      // Non-fatal
    }
  }

  return { skipped: true, destination: duplicatePath, reason: 'duplicate', sourceRemoval };
}

/**
 * Move a duplicate source to the OS trash, or delete it when the trash is
 * unavailable. Throws only when both fail, so the caller's "remove
 * embeddings after the source is gone" ordering holds.
 * @param {string} sourcePath
 * @param {any} logger
 * @returns {Promise<'trashed'|'deleted'>}
 */
async function removeDuplicateSource(sourcePath, logger) {
  try {
    const { TrashService } = require('../services/TrashService');
    const result = await new TrashService().trashOne(sourcePath);
    if (result?.success) return 'trashed';
    logger?.debug?.('[DEDUP] Trash refused the duplicate source; deleting it instead', {
      source: sourcePath,
      code: result?.code,
      error: result?.error
    });
  } catch (err) {
    logger?.debug?.('[DEDUP] Trash unavailable for the duplicate source; deleting it instead', {
      source: sourcePath,
      error: /** @type {any} */ (err)?.message
    });
  }
  await fs.unlink(sourcePath);
  return 'deleted';
}

/**
 * Check if a file has semantic (embedding-based) duplicates at a destination directory.
 * Uses the vector DB to find files with similar content, complementing the checksum-based
 * exact-match detection. Requires the OramaVectorService to be available and the source
 * file to have been analyzed/embedded.
 *
 * @param {Object} params
 * @param {string} params.sourceFileId - Semantic file ID (e.g., "file:/path/to/source")
 * @param {string} params.destinationDir - Directory to check for similar files
 * @param {number} [params.threshold=0.9] - Cosine similarity threshold (0..1). Default 0.9.
 * @param {number} [params.topK=5] - Max similar files to return
 * @param {Object} [params.vectorDbService] - OramaVectorService instance (resolved lazily if omitted)
 * @param {any} [params.logger] - Logger instance
 * @returns {Promise<{hasDuplicates: boolean, matches: Array<{id: string, score: number, metadata: Object}>}>}
 */
/** @param {any} params */
async function findSemanticDuplicates({
  sourceFileId,
  destinationDir,
  threshold = 0.9,
  topK = 5,
  vectorDbService,
  logger
}) {
  /** @type {{ hasDuplicates: boolean, matches: any[] }} */
  const emptyResult = { hasDuplicates: false, matches: [] };

  if (!sourceFileId || !destinationDir) return emptyResult;

  // Resolve vector DB service lazily if not provided
  let vdb = vectorDbService;
  if (!vdb) {
    try {
      const { container, ServiceIds } = require('../services/ServiceContainer');
      vdb =
        typeof container.tryResolve === 'function'
          ? container.tryResolve(ServiceIds.ORAMA_VECTOR)
          : container.resolve(ServiceIds.ORAMA_VECTOR);
    } catch {
      if (logger?.debug) {
        logger.debug('[DEDUP] Vector DB service unavailable for semantic duplicate check');
      }
      return emptyResult;
    }
  }

  if (!vdb || typeof vdb.findSimilarInDirectory !== 'function') {
    return emptyResult;
  }

  try {
    const matches = await vdb.findSimilarInDirectory(sourceFileId, destinationDir, {
      threshold,
      topK
    });

    return {
      hasDuplicates: matches.length > 0,
      matches
    };
  } catch (error) {
    if (logger?.debug) {
      logger.debug('[DEDUP] Semantic duplicate check failed (non-fatal)', {
        sourceFileId,
        destinationDir,
        error: error?.message
      });
    }
    return emptyResult;
  }
}

module.exports = {
  computeFileChecksum,
  findDuplicateForDestination,
  handleDuplicateMove,
  findSemanticDuplicates
};
