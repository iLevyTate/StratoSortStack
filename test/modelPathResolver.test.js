const path = require('path');

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn()
  }
}));

jest.mock('fs', () => ({
  promises: {
    readdir: jest.fn(),
    mkdir: jest.fn(),
    copyFile: jest.fn(),
    // lstat is needed by the symlink-safety check in
    // migrateLegacyModelsToCurrent. Default to "regular file" so the
    // existing happy-path test still exercises the migration.
    lstat: jest.fn(),
    // stat/rename back the atomic staged-copy install (copy to
    // `<name>.migrating`, size-verify, rename into place); unlink cleans
    // up staging artifacts. Tests override per-case where relevant.
    stat: jest.fn(),
    rename: jest.fn(),
    unlink: jest.fn(),
    // access is used to detect "already in current" — default to ENOENT
    // so the migration proceeds; tests can override per-case.
    access: jest.fn()
  }
}));

jest.mock('../src/main/core/userDataMigration', () => ({
  getLegacyUserDataPaths: jest.fn()
}));

const { app } = require('electron');
const { promises: fs } = require('fs');
const { getLegacyUserDataPaths } = require('../src/main/core/userDataMigration');
const { ensureResolvedModelsPath } = require('../src/main/services/modelPathResolver');

describe('modelPathResolver', () => {
  const currentModelsPath = path.join('/current', 'StratoSort Stack', 'models');
  const legacyModelsPath = path.join('/legacy', 'stratosort-core', 'models');

  beforeEach(() => {
    jest.clearAllMocks();
    app.getPath.mockReturnValue(path.join('/current', 'StratoSort Stack'));
    getLegacyUserDataPaths.mockReturnValue([path.join('/legacy', 'stratosort-core')]);
    fs.mkdir.mockResolvedValue();
    fs.copyFile.mockResolvedValue();
    // Treat every legacy file as a regular file so the symlink-safety
    // guard added in the migration helper passes through. Give it a size
    // that the staged-copy stat matches by default (happy path).
    fs.lstat.mockResolvedValue({ isFile: () => true, size: 1024 });
    fs.stat.mockResolvedValue({ size: 1024 });
    fs.rename.mockResolvedValue();
    fs.unlink.mockResolvedValue();
    // Default: target file does NOT yet exist in current/; tests that need
    // to assert the "skip if already in current" branch override this.
    fs.access.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });

  test('migrates legacy gguf files into the current models directory before resolving', async () => {
    const currentFiles = [];

    fs.readdir.mockImplementation(async (targetPath) => {
      if (targetPath === currentModelsPath) return [...currentFiles];
      if (targetPath === legacyModelsPath) return ['legacy-text.gguf', 'readme.txt'];
      return [];
    });
    fs.copyFile.mockImplementation(async (_sourcePath, targetPath) => {
      currentFiles.push(path.basename(targetPath));
    });
    fs.rename.mockImplementation(async (stagingPath, targetPath) => {
      const idx = currentFiles.indexOf(path.basename(stagingPath));
      if (idx !== -1) currentFiles.splice(idx, 1);
      currentFiles.push(path.basename(targetPath));
    });

    const resolved = await ensureResolvedModelsPath();

    expect(resolved).toEqual(
      expect.objectContaining({
        modelsPath: currentModelsPath,
        currentModelsPath,
        source: 'current-migrated'
      })
    );
    // Atomic install: copy lands in a same-directory staging file, then
    // renames into place after the size verify.
    expect(fs.copyFile).toHaveBeenCalledWith(
      path.join(legacyModelsPath, 'legacy-text.gguf'),
      path.join(currentModelsPath, 'legacy-text.gguf.migrating')
    );
    expect(fs.rename).toHaveBeenCalledWith(
      path.join(currentModelsPath, 'legacy-text.gguf.migrating'),
      path.join(currentModelsPath, 'legacy-text.gguf')
    );
    expect(fs.mkdir).toHaveBeenCalledWith(currentModelsPath, { recursive: true });
  });

  // Regression: a user with one model freshly downloaded into current/
  // and a different model still in legacy/ used to see the legacy model
  // invisible — the resolver returned `current` as soon as ANY GGUF was
  // present there and never consulted legacy. Per-file resolution now
  // unions both directories and copies missing files on every resolve.
  test('migrates legacy GGUFs even when current already has unrelated GGUFs', async () => {
    const currentFiles = ['fresh-download.gguf'];

    fs.readdir.mockImplementation(async (targetPath) => {
      if (targetPath === currentModelsPath) return [...currentFiles];
      if (targetPath === legacyModelsPath) return ['legacy-embedder.gguf'];
      return [];
    });
    fs.copyFile.mockImplementation(async (_sourcePath, targetPath) => {
      currentFiles.push(path.basename(targetPath));
    });
    fs.rename.mockImplementation(async (stagingPath, targetPath) => {
      const idx = currentFiles.indexOf(path.basename(stagingPath));
      if (idx !== -1) currentFiles.splice(idx, 1);
      currentFiles.push(path.basename(targetPath));
    });
    // The fresh download exists at target — access() resolves for that
    // path; the legacy file does NOT exist there yet — access() rejects.
    fs.access.mockImplementation(async (targetPath) => {
      if (targetPath === path.join(currentModelsPath, 'fresh-download.gguf')) return undefined;
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    });

    const resolved = await ensureResolvedModelsPath();

    // Resolver should land on current AND have copied the legacy embedder.
    expect(resolved.modelsPath).toBe(currentModelsPath);
    expect(resolved.source).toBe('current-migrated');
    expect(fs.copyFile).toHaveBeenCalledWith(
      path.join(legacyModelsPath, 'legacy-embedder.gguf'),
      path.join(currentModelsPath, 'legacy-embedder.gguf.migrating')
    );
    // The fresh-download.gguf must NOT have been overwritten by a copy
    // from legacy (legacy didn't have it, and access() short-circuit
    // would skip it anyway).
    expect(fs.copyFile).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('fresh-download.gguf')
    );
    expect(resolved.migrationSummary).toEqual(
      expect.objectContaining({
        copied: ['legacy-embedder.gguf']
      })
    );
  });

  test('preserves freshly-downloaded models and does not clobber them with legacy copies', async () => {
    // Same filename in both — current is the new download, legacy is
    // older. Migration must skip; current copy is the source of truth.
    fs.readdir.mockImplementation(async (targetPath) => {
      if (targetPath === currentModelsPath) return ['shared.gguf'];
      if (targetPath === legacyModelsPath) return ['shared.gguf'];
      return [];
    });
    fs.access.mockResolvedValue(undefined); // every target file exists

    const resolved = await ensureResolvedModelsPath();

    expect(fs.copyFile).not.toHaveBeenCalled();
    expect(fs.rename).not.toHaveBeenCalled();
    expect(resolved.source).toBe('current'); // no copy happened
  });

  // Regression: migration used bare fs.copyFile straight to the final
  // name. An interrupted copy left a truncated GGUF in current/ that the
  // "already-in-current" skip treated as migrated forever — a permanent
  // "model corrupted" state. The staged-copy install must leave NOTHING
  // at the final name on failure, remove its staging file, and let the
  // legacy file stay authoritative so a later resolve retries.
  describe('interrupted migration', () => {
    test('copy failure leaves no file at the final name and falls back to legacy', async () => {
      fs.readdir.mockImplementation(async (targetPath) => {
        if (targetPath === currentModelsPath) return [];
        if (targetPath === legacyModelsPath) return ['big-model.gguf'];
        return [];
      });
      fs.copyFile.mockRejectedValue(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));

      const resolved = await ensureResolvedModelsPath();

      // Never renamed anything into place.
      expect(fs.rename).not.toHaveBeenCalled();
      // Staging artifact removed on failure.
      expect(fs.unlink).toHaveBeenCalledWith(
        path.join(currentModelsPath, 'big-model.gguf.migrating')
      );
      // Failure recorded; legacy stays authoritative.
      expect(resolved.migrationSummary.failed).toEqual([
        { fileName: 'big-model.gguf', error: 'ENOSPC' }
      ]);
      expect(resolved.source).toBe('legacy');
      expect(resolved.modelsPath).toBe(legacyModelsPath);
    });

    test('size mismatch after copy (truncated write) aborts the install and removes staging', async () => {
      fs.readdir.mockImplementation(async (targetPath) => {
        if (targetPath === currentModelsPath) return [];
        if (targetPath === legacyModelsPath) return ['big-model.gguf'];
        return [];
      });
      fs.lstat.mockResolvedValue({ isFile: () => true, size: 4096 });
      fs.stat.mockResolvedValue({ size: 100 }); // staged copy came up short

      const resolved = await ensureResolvedModelsPath();

      expect(fs.rename).not.toHaveBeenCalled();
      expect(fs.unlink).toHaveBeenCalledWith(
        path.join(currentModelsPath, 'big-model.gguf.migrating')
      );
      expect(resolved.migrationSummary.failed).toEqual([
        expect.objectContaining({
          fileName: 'big-model.gguf',
          error: expect.stringContaining('size mismatch')
        })
      ]);
      expect(resolved.source).toBe('legacy');
    });

    test('re-migration succeeds after a previously interrupted run', async () => {
      const currentFiles = ['big-model.gguf.migrating']; // leftover from a crash
      fs.readdir.mockImplementation(async (targetPath) => {
        if (targetPath === currentModelsPath) return [...currentFiles];
        if (targetPath === legacyModelsPath) return ['big-model.gguf'];
        return [];
      });
      fs.unlink.mockImplementation(async (targetPath) => {
        const idx = currentFiles.indexOf(path.basename(targetPath));
        if (idx !== -1) currentFiles.splice(idx, 1);
      });
      fs.copyFile.mockImplementation(async (_sourcePath, targetPath) => {
        currentFiles.push(path.basename(targetPath));
      });
      fs.rename.mockImplementation(async (stagingPath, targetPath) => {
        const idx = currentFiles.indexOf(path.basename(stagingPath));
        if (idx !== -1) currentFiles.splice(idx, 1);
        currentFiles.push(path.basename(targetPath));
      });

      const resolved = await ensureResolvedModelsPath();

      // The stale artifact was swept, then the copy+verify+rename ran.
      expect(fs.unlink).toHaveBeenCalledWith(
        path.join(currentModelsPath, 'big-model.gguf.migrating')
      );
      expect(fs.rename).toHaveBeenCalledWith(
        path.join(currentModelsPath, 'big-model.gguf.migrating'),
        path.join(currentModelsPath, 'big-model.gguf')
      );
      expect(resolved.source).toBe('current-migrated');
      expect(resolved.migrationSummary.copied).toEqual(['big-model.gguf']);
      expect(currentFiles).toEqual(['big-model.gguf']);
    });

    test('a leftover .migrating artifact is never treated as a model', async () => {
      // Only a stale staging file in current/, nothing in legacy — the
      // resolver must report current-empty, not "model present".
      getLegacyUserDataPaths.mockReturnValue([]);
      fs.readdir.mockImplementation(async (targetPath) => {
        if (targetPath === currentModelsPath) return ['big-model.gguf.migrating'];
        return [];
      });

      const resolved = await ensureResolvedModelsPath();

      expect(resolved.source).toBe('current-empty');
      // And the artifact gets swept as garbage.
      expect(fs.unlink).toHaveBeenCalledWith(
        path.join(currentModelsPath, 'big-model.gguf.migrating')
      );
    });
  });
});
