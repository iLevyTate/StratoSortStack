/**
 * validateFileOperationPath must judge the path the filesystem will actually
 * touch, not only the spelling it was given. A directory link (junction or
 * symlink) part-way down the path, or a Windows 8.3 short name, can spell a
 * system directory under an innocent-looking name. These tests use the real
 * filesystem in a temp directory.
 */

jest.mock('fs', () => jest.requireActual('fs'));
jest.mock('fs/promises', () => jest.requireActual('fs/promises'));
jest.mock('os', () => jest.requireActual('os'));

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  validateFileOperationPath,
  isPathDangerous,
  resolveCanonicalPath
} = require('../src/shared/pathSanitization');

const isWindows = process.platform === 'win32';

/**
 * A real system directory the denylist covers, used as a link target.
 * @returns {string|null}
 */
function pickDeniedTarget() {
  const candidates = isWindows
    ? [
        path.join(process.env.SystemRoot || path.win32.join('C:/', 'Windows'), 'Temp'),
        process.env.SystemRoot
      ]
    : ['/etc', '/usr/sbin', '/sbin', '/bin'];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const real = fs.realpathSync.native(candidate);
      if (fs.statSync(real).isDirectory() && isPathDangerous(real)) return real;
    } catch {
      // try the next one
    }
  }
  return null;
}

describe('validateFileOperationPath canonical-path checks (real filesystem)', () => {
  /** @type {string} */
  let tmpRoot;
  /** @type {string|null} */
  let linkDir = null;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strato-canon-'));
    const target = pickDeniedTarget();
    if (!target) return;
    const candidate = path.join(tmpRoot, 'docs-link');
    try {
      fs.symlinkSync(target, candidate, isWindows ? 'junction' : 'dir');
      linkDir = candidate;
    } catch {
      linkDir = null;
    }
  });

  afterAll(() => {
    try {
      if (linkDir) fs.unlinkSync(linkDir);
    } catch {
      // ignore
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('rejects a file reached through a directory link into a system directory', async () => {
    if (!linkDir) {
      console.warn('directory link could not be created; skipping');
      return;
    }
    const logical = path.join(linkDir, 'probe.txt');
    const result = await validateFileOperationPath(logical, { checkSymlinks: true });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/system directories/);
  });

  test('rejects the linked directory itself', async () => {
    if (!linkDir) return;
    const result = await validateFileOperationPath(linkDir, { checkSymlinks: true });
    expect(result.valid).toBe(false);
  });

  test('allowedBasePaths is judged on the real location, not the spelling', async () => {
    if (!linkDir) return;
    const logical = path.join(linkDir, 'probe.txt');
    const result = await validateFileOperationPath(logical, {
      checkSymlinks: true,
      allowedBasePaths: [tmpRoot]
    });
    expect(result.valid).toBe(false);
  });

  test('a directory link to a safe folder inside the allowed base still passes', async () => {
    const realDir = path.join(tmpRoot, 'real-docs');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'note.txt'), 'hello');
    const safeLink = path.join(tmpRoot, 'safe-link');
    try {
      fs.symlinkSync(realDir, safeLink, isWindows ? 'junction' : 'dir');
    } catch {
      return;
    }
    try {
      const result = await validateFileOperationPath(path.join(safeLink, 'note.txt'), {
        checkSymlinks: true,
        allowedBasePaths: [tmpRoot]
      });
      expect(result.valid).toBe(true);
      // The fs operation keeps using the path the caller named.
      expect(result.normalizedPath).toBe(path.resolve(safeLink, 'note.txt'));
    } finally {
      fs.unlinkSync(safeLink);
    }
  });

  test('ordinary files in the temp directory still pass (no false positives)', async () => {
    const file = path.join(tmpRoot, 'plain.txt');
    fs.writeFileSync(file, 'x');
    const result = await validateFileOperationPath(file, {
      checkSymlinks: true,
      allowedBasePaths: [tmpRoot]
    });
    expect(result.valid).toBe(true);
    const missing = await validateFileOperationPath(path.join(tmpRoot, 'nope', 'new.txt'), {
      checkSymlinks: true,
      allowedBasePaths: [tmpRoot]
    });
    expect(missing.valid).toBe(true);
  });

  test('without checkSymlinks no filesystem lookups change the verdict', async () => {
    if (!linkDir) return;
    const result = await validateFileOperationPath(path.join(linkDir, 'probe.txt'));
    // Lexical-only mode is unchanged (callers that skip fs checks keep the old contract).
    expect(result.valid).toBe(true);
  });

  test('rejects a new file under a dangling link whose target is a system directory', async () => {
    const target = pickDeniedTarget();
    if (!target) return;
    const dangling = path.join(tmpRoot, 'dangling-link');
    try {
      fs.symlinkSync(
        path.join(target, 'strato-does-not-exist'),
        dangling,
        isWindows ? 'junction' : 'dir'
      );
    } catch {
      return;
    }
    try {
      const result = await validateFileOperationPath(path.join(dangling, 'new.txt'), {
        checkSymlinks: true
      });
      expect(result.valid).toBe(false);
    } finally {
      fs.unlinkSync(dangling);
    }
  });

  test('resolveCanonicalPath re-attaches the missing tail to the real ancestor', async () => {
    const realDir = path.join(tmpRoot, 'tail-real');
    fs.mkdirSync(realDir, { recursive: true });
    const link = path.join(tmpRoot, 'tail-link');
    try {
      fs.symlinkSync(realDir, link, isWindows ? 'junction' : 'dir');
    } catch {
      return;
    }
    try {
      const resolved = await resolveCanonicalPath(path.join(link, 'a', 'b.txt'));
      expect(resolved).toBe(path.join(fs.realpathSync.native(realDir), 'a', 'b.txt'));
    } finally {
      fs.unlinkSync(link);
    }
  });

  (isWindows ? test : test.skip)('rejects a Windows 8.3 short name of ProgramData', async () => {
    const shortName = path.win32.join('C:/', 'PROGRA~3');
    let real;
    try {
      real = fs.realpathSync.native(shortName);
    } catch {
      return; // 8.3 names disabled on this volume
    }
    if (!isPathDangerous(real) || isPathDangerous(shortName)) return;
    const result = await validateFileOperationPath(path.join(shortName, 'x.txt'), {
      checkSymlinks: true
    });
    expect(result.valid).toBe(false);
  });
});
