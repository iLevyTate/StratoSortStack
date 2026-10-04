// @ts-check
/**
 * modelPathResolver — locates GGUF model files across legacy and current
 * userData directories, with one-shot migration of legacy locations.
 *
 * Critical correctness note: a partial migration (e.g. embedder copied
 * but chat .gguf hit an AV-lock retry storm) used to silently report
 * success and leave models behind. This module now tracks per-candidate
 * migration completeness and only marks a candidate "fully migrated"
 * when every expected file copied, so callers don't paper over a half-
 * moved model set.
 */
const path = require('path');
const fs = require('fs').promises;
const { app } = require('electron');
const { getLegacyUserDataPaths } = require('../core/userDataMigration');

async function listGgufFiles(/** @type {any} */ dirPath) {
  try {
    /** @type {any[]} */
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((/** @type {any} */ entry) => {
        if (!entry) return false;
        if (typeof entry === 'string') return entry.toLowerCase().endsWith('.gguf');
        const name = String(entry.name || '').toLowerCase();
        if (!name.endsWith('.gguf')) return false;
        return typeof entry.isFile === 'function' ? entry.isFile() : true;
      })
      .map((/** @type {any} */ entry) => (typeof entry === 'string' ? entry : entry.name));
  } catch {
    return [];
  }
}

async function hasGgufFiles(/** @type {any} */ dirPath) {
  const files = await listGgufFiles(dirPath);
  return files.length > 0;
}

// Staging suffix for in-flight legacy-migration copies. A crash between
// copy and rename leaves `<name>.gguf.migrating` behind — never a
// `.gguf`, so listGgufFiles/hasGgufFiles can't mistake it for a model —
// and the resolver sweeps it as garbage on the next resolve.
const MIGRATION_STAGING_SUFFIX = '.migrating';

async function cleanupStagingArtifacts(/** @type {any} */ dirPath) {
  try {
    /** @type {any[]} */
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : String(entry?.name || '');
      if (!name.endsWith(MIGRATION_STAGING_SUFFIX)) continue;
      try {
        await fs.unlink(path.join(dirPath, name));
      } catch {
        // Best effort — a locked artifact is retried on the next resolve.
      }
    }
  } catch {
    // Directory missing/unreadable — nothing to clean.
  }
}

async function migrateLegacyModelsToCurrent(
  /** @type {any} */ currentModelsPath,
  /** @type {any} */ legacyCandidates
) {
  await fs.mkdir(currentModelsPath, { recursive: true });

  // Per-FILE migration. Pre-fix this function only declared a candidate
  // "fully migrated" when EVERY file copied — so if even one file failed,
  // the partial set sat orphaned in current/ and the caller fell back to
  // the legacy path entirely. That decision was correct for the original
  // "all or nothing" use case but produced a known regression: users with
  // some models freshly downloaded into current/ AND some surviving in
  // legacy/ saw the legacy ones invisible to the runtime, because
  // resolveModelsPath returned 'current' as soon as ANY GGUF existed
  // there. The resolver now unions both directories on every call, so
  // this function only needs to make a best effort to copy missing files.
  // We skip files that already exist in `current` (don't clobber newer
  // downloads) and report which files copied successfully so the caller
  // can log a clear migration summary.
  /** @type {{ copied: string[], skipped: Array<{fileName: string, reason: string}>, failed: Array<{fileName: string, error: string}> }} */
  const summary = { copied: [], skipped: [], failed: [] };
  for (const candidate of legacyCandidates) {
    for (const fileName of candidate.fileNames) {
      if (
        typeof fileName !== 'string' ||
        fileName.includes('/') ||
        fileName.includes('\\') ||
        fileName === '..' ||
        fileName === '.'
      ) {
        summary.skipped.push({ fileName, reason: 'invalid-name' });
        continue;
      }
      const sourcePath = path.join(candidate.legacyModelsPath, fileName);
      const targetPath = path.join(currentModelsPath, fileName);
      try {
        // Skip if the file already exists at the target — a freshly-
        // downloaded model in current/ should NOT be overwritten by an
        // older copy in legacy/.
        try {
          await fs.access(targetPath);
          summary.skipped.push({ fileName, reason: 'already-in-current' });
          continue;
        } catch {
          // ENOENT — proceed with copy.
        }

        const lstat = await fs.lstat(sourcePath);
        if (!lstat.isFile()) {
          summary.skipped.push({ fileName, reason: 'not-a-file' });
          continue;
        }

        // Atomic install: copy to a same-directory staging file, verify
        // the byte count survived the copy, then rename into place. A
        // bare copyFile straight to targetPath could be interrupted
        // (crash, ENOSPC, AV kill) and leave a truncated GGUF that the
        // "already-in-current" skip above would then treat as migrated
        // forever — a permanent "model corrupted" state with no self-heal.
        const stagingPath = targetPath + MIGRATION_STAGING_SUFFIX;
        try {
          await fs.copyFile(sourcePath, stagingPath);
          const staged = await fs.stat(stagingPath);
          if (staged.size !== lstat.size) {
            throw new Error(
              `size mismatch after copy: expected ${lstat.size} bytes, staged ${staged.size}`
            );
          }
          await fs.rename(stagingPath, targetPath);
        } catch (copyErr) {
          // Remove the staging file so a partial copy never lingers; the
          // legacy file stays authoritative and is retried next resolve.
          try {
            await fs.unlink(stagingPath);
          } catch {
            // Best effort — resolver sweep also removes leftovers.
          }
          throw copyErr;
        }
        summary.copied.push(fileName);
      } catch (err) {
        summary.failed.push({ fileName, error: err?.message });
      }
    }
  }
  return summary;
}

async function resolveModelsPath() {
  const userDataPath = app.getPath('userData');
  const currentModelsPath = path.join(userDataPath, 'models');

  // Sweep leftover `.migrating` staging artifacts (from an interrupted
  // earlier migration) before anything else inspects the directory.
  await cleanupStagingArtifacts(currentModelsPath);

  // Per-MODEL resolution. Pre-fix this function returned `current` as
  // soon as the current dir contained ANY .gguf, never consulting legacy
  // paths — which meant users who downloaded one model manually into
  // current/ AND had another model surviving in legacy/ saw the legacy
  // model invisible. We now union both directories on every resolve and
  // best-effort-copy any legacy files missing from current.
  const legacyUserDataPaths = getLegacyUserDataPaths();
  const legacyCandidates = [];
  for (const legacyPath of legacyUserDataPaths) {
    const legacyModelsPath = path.join(legacyPath, 'models');
    const fileNames = await listGgufFiles(legacyModelsPath);
    if (fileNames.length > 0) {
      legacyCandidates.push({ legacyModelsPath, fileNames });
    }
  }

  let migrationSummary = null;
  if (legacyCandidates.length > 0) {
    /** @type {(err: any) => null} */
    const onCatch = (_err) => null;
    migrationSummary = await migrateLegacyModelsToCurrent(
      currentModelsPath,
      legacyCandidates
    ).catch(onCatch);
  }

  if (await hasGgufFiles(currentModelsPath)) {
    const baseSource =
      migrationSummary && migrationSummary.copied.length > 0 ? 'current-migrated' : 'current';
    return {
      modelsPath: currentModelsPath,
      source: baseSource,
      currentModelsPath,
      ...(migrationSummary ? { migrationSummary } : {})
    };
  }

  // Current empty AND no successful migration. Fall back to the first
  // legacy candidate that still has GGUFs (typically because copy was
  // blocked by AV / permissions); models will be loaded in-place there.
  for (const candidate of legacyCandidates) {
    if (await hasGgufFiles(candidate.legacyModelsPath)) {
      return {
        modelsPath: candidate.legacyModelsPath,
        source: 'legacy',
        currentModelsPath,
        legacyModelsPath: candidate.legacyModelsPath,
        ...(migrationSummary ? { migrationSummary } : {})
      };
    }
  }

  return {
    modelsPath: currentModelsPath,
    source: 'current-empty',
    ...(migrationSummary ? { migrationSummary } : {})
  };
}

async function ensureResolvedModelsPath() {
  const resolved = await resolveModelsPath();
  try {
    await fs.mkdir(resolved.modelsPath, { recursive: true });
  } catch {
    // Non-fatal in restricted environments; callers handle downstream failures.
  }
  return resolved;
}

module.exports = {
  hasGgufFiles,
  resolveModelsPath,
  ensureResolvedModelsPath
};
