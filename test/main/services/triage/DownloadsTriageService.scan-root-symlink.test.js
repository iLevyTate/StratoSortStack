/**
 * @jest-environment node
 *
 * Regression: the triage scan-root boundary check must compare PHYSICAL paths.
 * A junction/symlink inside Downloads pointing outside every allowed root used
 * to pass the lexical check, letting scan + act(trash/organize) operate on
 * files that physically live outside Downloads and all Smart Folders.
 */
jest.unmock('fs');
jest.unmock('fs/promises');

const path = require('path');
const fs = require('fs').promises;
// Real os, not the test-setup mock: the mock pins tmpdir() to the memfs
// '/tmp', but this suite runs against the REAL filesystem (unmocked above),
// where '/tmp' does not exist on Windows CI runners (mkdtemp ENOENT).
const os = jest.requireActual('os');

jest.mock('../../../../src/main/folderScanner', () => ({
  scanDirectory: jest.fn()
}));

jest.mock('electron', () => ({
  app: { getPath: jest.fn() }
}));

jest.mock('../../../../src/main/core/customFolders', () => ({
  loadCustomFolders: jest.fn().mockResolvedValue([])
}));

jest.mock('../../../../src/main/services/ServiceContainer', () => ({
  container: {
    tryResolve: jest.fn(() => null),
    has: jest.fn(() => true),
    resolve: jest.fn()
  },
  ServiceIds: {
    ORAMA_VECTOR: 'oramaVector',
    UNDO_REDO: 'undoRedo',
    ANALYSIS_HISTORY: 'analysisHistory',
    FOLDER_MATCHING: 'folderMatching',
    PARALLEL_EMBEDDING: 'parallelEmbedding',
    FILE_PATH_COORDINATOR: 'filePathCoordinator'
  }
}));

const { scanDirectory } = require('../../../../src/main/folderScanner');
const electron = require('electron');

const {
  DownloadsTriageService
} = require('../../../../src/main/services/triage/DownloadsTriageService');

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

async function tryCreateLink(target, linkPath) {
  try {
    await fs.symlink(target, linkPath, LINK_TYPE);
    return true;
  } catch {
    // Exotic filesystems (or non-NTFS temp on Windows) may not support links;
    // the boundary regression cannot be exercised there.
    return false;
  }
}

describe('DownloadsTriageService scan-root symlink/junction containment', () => {
  let testDir;
  let downloadsDir;
  let outsideDir;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-symlink-'));
    downloadsDir = path.join(testDir, 'downloads');
    outsideDir = path.join(testDir, 'outside');
    await fs.mkdir(downloadsDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    electron.app.getPath.mockReturnValue(downloadsDir);
    scanDirectory.mockResolvedValue([]);
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('rejects a link inside Downloads that points outside every allowed root', async () => {
    const linkPath = path.join(downloadsDir, 'esc');
    if (!(await tryCreateLink(outsideDir, linkPath))) {
      console.warn('symlink/junction unsupported on this filesystem; skipping');
      return;
    }

    const svc = new DownloadsTriageService();
    const result = await svc.start({ folderPath: linkPath, minAgeHours: 0 });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('FOLDER_NOT_ALLOWED');
    expect(scanDirectory).not.toHaveBeenCalled();
  });

  test('still allows a real subfolder of Downloads (roots are realpath-resolved too)', async () => {
    // os.tmpdir() may itself sit behind a symlink (macOS /tmp -> /private/tmp),
    // so this guards against over-tightening: realpath(target) must be compared
    // against realpath(root), not the lexical root.
    const subDir = path.join(downloadsDir, 'sub');
    await fs.mkdir(subDir, { recursive: true });

    const svc = new DownloadsTriageService();
    const result = await svc.start({ folderPath: subDir, minAgeHours: 0 });

    expect(result.success).toBe(true);
    expect(scanDirectory).toHaveBeenCalled();
  });

  test('allows a link whose physical target is inside Downloads', async () => {
    const realTarget = path.join(downloadsDir, 'real-target');
    await fs.mkdir(realTarget, { recursive: true });
    const linkPath = path.join(testDir, 'alias');
    if (!(await tryCreateLink(realTarget, linkPath))) {
      console.warn('symlink/junction unsupported on this filesystem; skipping');
      return;
    }

    const svc = new DownloadsTriageService();
    const result = await svc.start({ folderPath: linkPath, minAgeHours: 0 });

    expect(result.success).toBe(true);
  });
});
