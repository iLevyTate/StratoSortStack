/**
 * @jest-environment node
 *
 * End-to-end harness for the post-2.0.9 regression set.
 *
 * Exercises the full path that no single existing test covered:
 *   analyze fixture file
 *     -> applyUserNamingFromSettings (convention/case)
 *       -> buildOperations equivalent (renderer-shape source -> destination)
 *         -> handleBatchOrganize (real handler, real fs)
 *           -> assert on-disk filename + folder match the naming setting
 *
 * The two regressions this is meant to catch directly:
 *   1. dryRun stripped by Zod (P0-1) — covered separately at IPC layer; here
 *      we validate the non-dry-run path mutates disk as expected.
 *   2. Destination collisions on the real filesystem (F-078) — fs.rename
 *      silently replaces an occupied destination on every platform, so the
 *      executor must preflight (renameNoReplace) and walk the shared
 *      formatNumberedCollisionCandidate suffix loop instead of clobbering.
 *      Covered below with a pre-existing different-content occupant AND an
 *      intra-batch collision (two ops, same destination).
 *
 * It also acts as a smoke test for naming convention application
 * (P1-5 year preservation) and the buildOperations sanitization layer
 * (joinPath, sanitizeDestinationFileName, extension preservation).
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

jest.mock('../../src/shared/logger', () => {
  const mock = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  };
  return { createLogger: () => mock, logger: mock };
});

// Lock manager and validators are mocked at unit-test-shape boundaries
// so the test can exercise the orchestrator and the rename loop without
// pulling in batch-state journaling / cross-process locks.
jest.mock('../../src/main/ipc/files/batchLockManager', () => ({
  acquireBatchLock: jest.fn().mockResolvedValue(true),
  renewBatchLock: jest.fn().mockReturnValue(true),
  releaseBatchLock: jest.fn()
}));

jest.mock('../../src/main/ipc/files/batchValidator', () => ({
  validateBatchOperation: jest.fn(() => null),
  MAX_BATCH_SIZE: 1000
}));

jest.mock('../../src/main/ipc/files/batchRollback', () => ({
  executeRollback: jest.fn()
}));

jest.mock('../../src/main/ipc/files/batchProgressReporter', () => ({
  sendFileOperationBatchComplete: jest.fn(),
  sendOperationProgress: jest.fn(),
  sendChunkedResults: jest.fn().mockResolvedValue({ sent: true, totalChunks: 0 })
}));

jest.mock('../../src/shared/fileOperationTracker', () => ({
  getInstance: jest.fn(() => ({ recordOperation: jest.fn() }))
}));

jest.mock('../../src/main/ipc/files/embeddingSync', () => ({
  removeEmbeddingsForPathBestEffort: jest.fn(),
  syncEmbeddingForMove: jest.fn(),
  verifyEmbeddingAfterMove: jest.fn().mockResolvedValue({ valid: true, issues: [] })
}));

jest.mock('../../src/main/utils/fileDedup', () => ({
  computeFileChecksum: jest.fn().mockResolvedValue('checksum'),
  handleDuplicateMove: jest.fn().mockResolvedValue(null),
  findSemanticDuplicates: jest.fn().mockResolvedValue({ hasDuplicates: false, matches: [] })
}));

jest.mock('../../src/shared/pathSanitization', () => ({
  // Tests run on real files inside an OS tmp dir; no extra sanitization.
  validateFileOperationPath: jest.fn(async (p) => ({ valid: true, normalizedPath: p }))
}));

const {
  generateSuggestedNameFromAnalysis,
  extractExtension
} = require('../../src/shared/namingConventions');
const { handleBatchOrganize } = require('../../src/main/ipc/files/batchOrganizeHandler');

// Mirrors useOrganization.processFileForOrganization's destination math
// closely enough that this test guards both the naming pipeline AND the
// renderer-shape destination assembly. Diverge only when the renderer
// does (path-separator handling / sanitization).
function buildDestinationFor({ file, analysis, namingSettings, smartFolderPath }) {
  const originalFileName = file.name;
  const suggested = generateSuggestedNameFromAnalysis({
    originalFileName,
    analysis,
    settings: namingSettings,
    fileTimestamps: { created: file.created, modified: file.modified }
  });
  // Preserve extension if generator omitted it.
  const ext = extractExtension(originalFileName);
  const finalName = suggested.toLowerCase().endsWith(ext.toLowerCase())
    ? suggested
    : `${suggested}${ext}`;
  return path.join(smartFolderPath, finalName);
}

describe('analyze -> apply naming -> organize end-to-end', () => {
  let tempRoot;
  let inboxDir;
  let smartFolderDir;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stratosort-e2e-'));
    inboxDir = path.join(tempRoot, 'inbox');
    smartFolderDir = path.join(tempRoot, 'Smart Folder');
    await fs.mkdir(inboxDir, { recursive: true });
    await fs.mkdir(smartFolderDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempRoot, { recursive: true, force: true });
    } catch {
      /* tmp cleanup is best-effort */
    }
  });

  test('subject-date convention lands the file with the convention-shaped name in the smart folder', async () => {
    const sourcePath = path.join(inboxDir, 'Annual Report 2024.pdf');
    await fs.writeFile(sourcePath, 'pdf bytes', 'utf8');

    // Mock analyzer output — what `analyzeDocumentFile` would have produced
    // for this file. Real analyzers go through the LLM; this fixture
    // captures the shape downstream code receives.
    const analysis = {
      suggestedName: 'Annual Report 2024',
      category: 'Reports',
      date: '2025-06-15', // appended date is 2025; the subject's 2024
      // must NOT be stripped (P1-5 regression guard).
      confidence: 0.9
    };

    const file = {
      path: sourcePath,
      name: 'Annual Report 2024.pdf',
      size: 9,
      created: new Date('2025-06-15T00:00:00Z'),
      modified: new Date('2025-06-15T00:00:00Z')
    };

    const namingSettings = {
      convention: 'subject-date',
      separator: '-',
      dateFormat: 'YYYY-MM-DD',
      caseConvention: 'kebab-case'
    };

    const destination = buildDestinationFor({
      file,
      analysis,
      namingSettings,
      smartFolderPath: smartFolderDir
    });

    // Confirm the convention preserves the legitimate trailing year.
    expect(path.basename(destination)).toBe('annual-report-2024-2025-06-15.pdf');

    const result = await handleBatchOrganize({
      operation: {
        operations: [{ source: sourcePath, destination }]
      },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      getServiceIntegration: () => null,
      getMainWindow: () => null
    });

    expect(result.success).toBe(true);
    expect(result.successCount).toBe(1);

    // On-disk verification: the file is at the new path and removed from
    // the source.
    await expect(fs.access(destination)).resolves.toBeUndefined();
    await expect(fs.access(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('multiple files batch through naming + organize and all land at their convention-shaped destinations', async () => {
    // Two source files with distinct analyses; both go through the full
    // naming pipeline and the batch organize handler. This guards the
    // multi-file batch path that no other test exercised end-to-end —
    // the post-2.0.9 audit found no test that drove batch organize all
    // the way to on-disk verification across multiple files.
    const sourceA = path.join(inboxDir, 'invoice-a.pdf');
    const sourceB = path.join(inboxDir, 'invoice-b.pdf');
    await fs.writeFile(sourceA, 'A', 'utf8');
    await fs.writeFile(sourceB, 'B', 'utf8');

    const namingSettings = {
      convention: 'subject-date',
      separator: '-',
      dateFormat: 'YYYY-MM-DD',
      caseConvention: 'kebab-case'
    };

    const fileA = {
      path: sourceA,
      name: 'invoice-a.pdf',
      size: 1,
      created: new Date('2025-03-10T00:00:00Z'),
      modified: new Date('2025-03-10T00:00:00Z')
    };
    const fileB = {
      path: sourceB,
      name: 'invoice-b.pdf',
      size: 1,
      created: new Date('2025-04-22T00:00:00Z'),
      modified: new Date('2025-04-22T00:00:00Z')
    };
    const analysisA = {
      suggestedName: 'Acme Inc Invoice',
      category: 'Finance',
      date: '2025-03-10'
    };
    const analysisB = {
      suggestedName: 'Globex Invoice',
      category: 'Finance',
      date: '2025-04-22'
    };

    const destA = buildDestinationFor({
      file: fileA,
      analysis: analysisA,
      namingSettings,
      smartFolderPath: smartFolderDir
    });
    const destB = buildDestinationFor({
      file: fileB,
      analysis: analysisB,
      namingSettings,
      smartFolderPath: smartFolderDir
    });

    expect(path.basename(destA)).toBe('acme-inc-invoice-2025-03-10.pdf');
    expect(path.basename(destB)).toBe('globex-invoice-2025-04-22.pdf');

    const result = await handleBatchOrganize({
      operation: {
        operations: [
          { source: sourceA, destination: destA },
          { source: sourceB, destination: destB }
        ]
      },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      getServiceIntegration: () => null,
      getMainWindow: () => null
    });

    expect(result.success).toBe(true);
    expect(result.successCount).toBe(2);

    const filesInSmartFolder = (await fs.readdir(smartFolderDir)).sort();
    expect(filesInSmartFolder).toEqual([
      'acme-inc-invoice-2025-03-10.pdf',
      'globex-invoice-2025-04-22.pdf'
    ]);
    // Both originals removed from inbox.
    expect((await fs.readdir(inboxDir)).length).toBe(0);
  });

  test('F-078: a different-content file already at the destination is never overwritten — incoming file walks to the _1 suffix', async () => {
    const sourcePath = path.join(inboxDir, 'report.pdf');
    await fs.writeFile(sourcePath, 'INCOMING-CONTENT', 'utf8');

    const destination = path.join(smartFolderDir, 'report.pdf');
    await fs.writeFile(destination, 'PRECIOUS-EXISTING-CONTENT', 'utf8');

    const result = await handleBatchOrganize({
      operation: {
        operations: [{ source: sourcePath, destination }]
      },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      getServiceIntegration: () => null,
      getMainWindow: () => null
    });

    expect(result.success).toBe(true);
    expect(result.successCount).toBe(1);

    // The occupant must be untouched.
    expect(await fs.readFile(destination, 'utf8')).toBe('PRECIOUS-EXISTING-CONTENT');
    // The incoming file landed at the shared collision-suffix candidate.
    const suffixed = path.join(smartFolderDir, 'report_1.pdf');
    expect(await fs.readFile(suffixed, 'utf8')).toBe('INCOMING-CONTENT');
    await expect(fs.access(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('F-078: two ops in one batch targeting the same destination both survive', async () => {
    const sourceX = path.join(inboxDir, 'scan-a.pdf');
    const sourceY = path.join(inboxDir, 'scan-b.pdf');
    await fs.writeFile(sourceX, 'CONTENT-X', 'utf8');
    await fs.writeFile(sourceY, 'CONTENT-Y', 'utf8');

    const destination = path.join(smartFolderDir, 'scan.pdf');

    const result = await handleBatchOrganize({
      operation: {
        operations: [
          { source: sourceX, destination },
          { source: sourceY, destination }
        ]
      },
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      getServiceIntegration: () => null,
      getMainWindow: () => null
    });

    expect(result.success).toBe(true);
    expect(result.successCount).toBe(2);

    const landed = (await fs.readdir(smartFolderDir)).sort();
    expect(landed).toEqual(['scan.pdf', 'scan_1.pdf']);
    const contents = await Promise.all(
      landed.map((name) => fs.readFile(path.join(smartFolderDir, name), 'utf8'))
    );
    expect(contents.sort()).toEqual(['CONTENT-X', 'CONTENT-Y']);
    expect((await fs.readdir(inboxDir)).length).toBe(0);
  });
});
