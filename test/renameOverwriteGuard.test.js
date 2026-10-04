/**
 * @jest-environment node
 */
/**
 * Class guard for the F-090..F-094 defect class: Node's fs.rename silently
 * REPLACES an occupied destination on every platform (POSIX rename(2);
 * MOVEFILE_REPLACE_EXISTING on Windows) — it never throws EEXIST. Any bare
 * `.rename(` on a user-file move path can therefore destroy data.
 *
 * This guard scans src/ for `.rename(` / `renameSync(` call sites (comments
 * stripped) and asserts every occurrence is accounted for by the allowlist
 * below with an exact per-file count and a stated reason. Adding a NEW bare
 * rename anywhere fails this test: use `renameNoReplace` from
 * src/shared/atomicFileOperations.js for anything that moves user files, or
 * add an allowlist entry with a reason explaining why silent replacement is
 * intended (e.g. write-to-temp-then-rename atomic swaps) or why the site has
 * its own occupancy preflight.
 */

jest.unmock('fs');

const fs = require('fs');
const path = require('path');

const SRC_ROOT = path.join(__dirname, '..', 'src');

// path (posix-style, relative to repo root) -> { count, reason }
const ALLOWED_BARE_RENAMES = {
  'src/shared/atomicFileOperations.js': {
    count: 2,
    reason:
      'home of the guarded primitives — renameWithTransientRetry (used behind atomicMove’s ' +
      'occupancy preflight) and renameNoReplace itself (rename after its own preflight)'
  },
  'src/shared/atomicFile.js': {
    count: 2,
    reason: 'temp->final atomic-write swap; corrupt-file quarantine to a Date.now()-unique name'
  },
  'src/main/analysis/embeddingQueue/persistence.js': {
    count: 1,
    reason: 'legacy-format quarantine to a Date.now()-unique name'
  },
  'src/main/core/customFolders.js': {
    count: 1,
    reason: 'temp->final atomic-write swap for settings persistence'
  },
  'src/main/core/backgroundSetup.js': {
    count: 1,
    reason: 'temp->final atomic-write swap for the setup marker'
  },
  'src/main/utils/hashCache.js': {
    count: 1,
    reason: 'temp->final atomic-write swap for the hash cache'
  },
  'src/main/services/McpServerLifecycleService.js': {
    count: 1,
    reason: 'temp->final atomic-write swap for MCP config'
  },
  'src/main/services/ChatHistoryStore.js': {
    count: 1,
    reason: 'history rotation to a suffixed archive name'
  },
  'src/main/services/UndoRedoService.js': {
    count: 3,
    reason:
      'temp->final swap persisting undo-actions.json (safeMove now routes through ' +
      'renameNoReplace instead of a bare rename behind its own preflight); two more ' +
      'move an unreadable undo-actions.json aside to a fresh timestamped ' +
      '.unreadable.<ms> name that nothing else writes, at load and again from ' +
      'saveActions while the live path is shielded'
  },
  'src/main/services/modelPathResolver.js': {
    count: 1,
    reason:
      'staged .migrating->final publish of a size-verified legacy model copy; the migration ' +
      'loop only runs for models absent from current/, and the userData single-instance lock ' +
      'rules out concurrent migrators'
  },
  'src/main/services/analysisHistory/persistence.js': {
    count: 1,
    reason: 'legacy-format quarantine to a Date.now()-unique name'
  },
  'src/main/services/ProcessingStateService.js': {
    count: 1,
    reason: 'temp->final atomic-write swap for processing state'
  },
  'src/main/services/ai/AIKeyStore.js': {
    count: 1,
    reason: 'temp->final atomic-write swap for the key store'
  },
  'src/main/services/ai/costTracker.js': {
    count: 1,
    reason: 'temp->final atomic-write swap for cost tracking'
  },
  'src/main/services/ModelDownloadManager.js': {
    count: 1,
    reason:
      'partial-download promotion to the final model path; replacing a prior model is intended'
  },
  'src/main/utils/asyncFileOps.js': {
    count: 2,
    reason:
      'temp->final atomic-write swap; moveFile() has its own exists() preflight with an ' +
      'explicit overwrite opt-in parameter'
  },
  'src/main/services/organization/persistence.js': {
    count: 1,
    reason: 'temp->final atomic-write swap for learned patterns'
  },
  'src/main/services/organization/feedbackMemoryStore.js': {
    count: 1,
    reason: 'temp->final atomic-write swap for feedback memory'
  },
  'src/main/services/RelationshipIndexService.js': {
    count: 1,
    reason: 'temp->final atomic-write swap for the relationship index'
  },
  'src/main/services/OramaVectorService.js': {
    count: 8,
    reason:
      'DB persistence internals: .bak rotation, quarantine/archive moves to unique or ' +
      'intentionally-replaced backup names, and the rolling .bak set aside under a unique ' +
      'stamp on a dimension change'
  },
  'src/main/ipc/files/batchRollback.js': {
    count: 1,
    reason:
      'temp->final atomic-write swap for the recovery manifest (rollback restores use renameNoReplace)'
  },
  'src/main/ipc/settings.js': {
    count: 1,
    reason:
      'settings-export temp->final swap onto a user-chosen save path (overwrite is the ' +
      'expected save-dialog semantics)'
  }
};

/** Strip // line comments and /* *\/ block comments (naive but sufficient). */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Count bare rename call sites in one source string. */
function countBareRenames(source) {
  const stripped = stripComments(source);
  // Matches fs.rename(, fs.promises.rename(, fsp.rename(, renameSync( — any
  // member call named rename/renameSync. renameNoReplace( does NOT match
  // (requires the preceding dot + exact name boundary).
  const matches = stripped.match(/\.rename(?:Sync)?\s*\(/g);
  return matches ? matches.length : 0;
}

function walkJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsFiles(full, out);
    else if (entry.isFile() && /\.(js|jsx|ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function scanTree() {
  const results = new Map();
  for (const file of walkJsFiles(SRC_ROOT)) {
    const count = countBareRenames(fs.readFileSync(file, 'utf8'));
    if (count > 0) {
      const rel = path.relative(path.join(__dirname, '..'), file).split(path.sep).join('/');
      results.set(rel, count);
    }
  }
  return results;
}

describe('bare fs.rename class guard [F-090..F-094]', () => {
  test('every bare rename call site in src/ is allowlisted with an exact count', () => {
    const found = scanTree();
    const problems = [];

    for (const [rel, count] of found) {
      const allowed = ALLOWED_BARE_RENAMES[rel];
      if (!allowed) {
        problems.push(
          `${rel}: ${count} bare rename call(s) with NO allowlist entry. fs.rename silently ` +
            `replaces an occupied destination — use renameNoReplace (atomicFileOperations.js) ` +
            `for user-file moves, or allowlist with a reason.`
        );
      } else if (count !== allowed.count) {
        problems.push(
          `${rel}: expected ${allowed.count} bare rename call(s), found ${count}. ` +
            `New call? Route it through renameNoReplace or update the allowlist with a reason.`
        );
      }
    }

    for (const rel of Object.keys(ALLOWED_BARE_RENAMES)) {
      if (!found.has(rel)) {
        problems.push(`${rel}: allowlisted but no bare rename found — remove the stale entry.`);
      }
    }

    expect(problems).toEqual([]);
  });

  test('every allowlist entry carries a non-empty reason', () => {
    for (const [rel, entry] of Object.entries(ALLOWED_BARE_RENAMES)) {
      expect(typeof entry.reason).toBe('string');
      expect(entry.reason.length).toBeGreaterThan(10);
      expect(entry.count).toBeGreaterThan(0);
      void rel;
    }
  });

  test('detectability: a synthetic bare rename is counted; comments and renameNoReplace are not', () => {
    const synthetic = `
      // await fs.rename(commentedOut, ignored);
      /* fs.rename(blockComment, ignored) */
      await renameNoReplace(source, destination);
      await fs.rename(source, destination);
      await fs.promises.rename(a, b);
      fsExtra.renameSync(c, d);
    `;
    expect(countBareRenames(synthetic)).toBe(3);
    expect(countBareRenames('await renameNoReplace(a, b);')).toBe(0);
  });
});
