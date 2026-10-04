/**
 * @jest-environment node
 *
 * Parity guard: dry-run preview and the real `performFileMove` must produce
 * BYTE-IDENTICAL collision-suffixed destinations. They drifted post-2.0.9 —
 * preview formatted as `${base} (${N})${ext}` while the executor formatted
 * as `${base}_${N}${ext}`, so the Preview button displayed a destination
 * the actual move would not produce.
 *
 * Both paths now go through `formatNumberedCollisionCandidate`. This file
 * tests both that the helper itself is shape-stable and that
 * `performFileMove` lands on the suffix the preview predicts when the
 * destination directory has the same collision shape.
 */

const path = require('path');

jest.mock('../src/shared/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  };
  return { createLogger: jest.fn(() => logger), logger };
});

// performFileMove pulls in the dedup utility; mock it to a no-op so the
// test focuses on the rename-and-EEXIST collision walk only.
jest.mock('../src/main/utils/fileDedup', () => ({
  computeFileChecksum: jest.fn().mockResolvedValue('checksum'),
  handleDuplicateMove: jest.fn().mockResolvedValue(null),
  findSemanticDuplicates: jest.fn().mockResolvedValue({ hasDuplicates: false, matches: [] })
}));

jest.mock('../src/main/ipc/files/embeddingSync', () => ({
  removeEmbeddingsForPathBestEffort: jest.fn(),
  syncEmbeddingForMove: jest.fn(),
  verifyEmbeddingAfterMove: jest.fn().mockResolvedValue({ valid: true, issues: [] })
}));

// Module factories cannot reference out-of-scope variables, but jest allows
// names prefixed with `mock`. We use `mockExistingPaths` (a Set) as the
// shared in-memory FS state between fs.access (preview / renameNoReplace
// preflight) and fs.rename (executor). Keys are path.normalize()d because
// renameNoReplace normalizes before probing (forward-slash fixture paths
// become backslash on win32). Each test resets the set in beforeEach.
const mockExistingPaths = new Set();
const mockNorm = (p) => require('path').normalize(String(p));
const mockAddExisting = (p) => mockExistingPaths.add(mockNorm(p));

jest.mock('fs', () => ({
  promises: {
    access: jest.fn(async (p) => {
      if (mockExistingPaths.has(mockNorm(p))) return undefined;
      const err = new Error(`ENOENT: ${p}`);
      err.code = 'ENOENT';
      throw err;
    }),
    rename: jest.fn(async (src, dest) => {
      if (mockExistingPaths.has(mockNorm(dest))) {
        const err = new Error(`EEXIST: ${dest}`);
        err.code = 'EEXIST';
        throw err;
      }
      mockExistingPaths.delete(mockNorm(src));
      mockAddExisting(dest);
    }),
    mkdir: jest.fn(),
    unlink: jest.fn(),
    stat: jest.fn(async () => ({ size: 1 }))
  }
}));

const {
  previewBatchOrganize,
  performFileMove,
  formatNumberedCollisionCandidate
} = require('../src/main/ipc/files/batchOrganizeHandler');

beforeEach(() => {
  mockExistingPaths.clear();
  jest.clearAllMocks();
});

describe('formatNumberedCollisionCandidate (helper invariant)', () => {
  test('produces underscore-delimited counter before the extension', () => {
    expect(formatNumberedCollisionCandidate('/out/a.pdf', 1)).toBe('/out/a_1.pdf');
    expect(formatNumberedCollisionCandidate('/out/a.pdf', 5)).toBe('/out/a_5.pdf');
  });

  test('preserves only the LAST extension on compound names (matches path.extname)', () => {
    // Same convention as performFileMove (path.extname -> last segment only).
    expect(formatNumberedCollisionCandidate('/out/report.tar.gz', 1)).toBe('/out/report.tar_1.gz');
  });

  test('handles destinations without an extension', () => {
    expect(formatNumberedCollisionCandidate('/out/Makefile', 3)).toBe('/out/Makefile_3');
  });

  test('preserves directory portion verbatim', () => {
    const winPath = 'C:\\Smart Folders\\Reports\\Q1 Summary.pdf';
    expect(formatNumberedCollisionCandidate(winPath, 2)).toBe(
      'C:\\Smart Folders\\Reports\\Q1 Summary_2.pdf'
    );
  });
});

describe('preview vs execute parity', () => {
  test('preview destination matches what performFileMove lands on', async () => {
    // Two existing files in /out/. Preview predicts the third lands on _2.
    mockAddExisting('/in/a.pdf');
    mockAddExisting('/out');
    mockAddExisting('/out/a.pdf');
    mockAddExisting('/out/a_1.pdf');

    const previewResult = await previewBatchOrganize({
      operation: {
        operations: [{ source: '/in/a.pdf', destination: '/out/a.pdf' }]
      }
    });
    const previewDestination = previewResult.wouldMove[0].destination;
    expect(previewDestination).toBe('/out/a_2.pdf');

    // Now execute the same move; the rename mock walks the EEXIST loop.
    const op = { source: '/in/a.pdf', destination: '/out/a.pdf' };
    const executeResult = await performFileMove(op, {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    });

    expect(executeResult.destination).toBe(previewDestination);
  });

  test('parity holds across deeper collision counts', async () => {
    mockAddExisting('/in/report.pdf');
    mockAddExisting('/out');
    mockAddExisting('/out/report.pdf');
    for (let i = 1; i <= 7; i += 1) {
      mockAddExisting(`/out/report_${i}.pdf`);
    }
    // Free slot is /out/report_8.pdf.

    const previewResult = await previewBatchOrganize({
      operation: {
        operations: [{ source: '/in/report.pdf', destination: '/out/report.pdf' }]
      }
    });
    const previewDestination = previewResult.wouldMove[0].destination;

    const executeResult = await performFileMove(
      { source: '/in/report.pdf', destination: '/out/report.pdf' },
      { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
    );

    expect(previewDestination).toBe('/out/report_8.pdf');
    expect(executeResult.destination).toBe(previewDestination);
  });
});
