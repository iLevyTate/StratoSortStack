/**
 * The canonical allowlist check in validateFileOperationPath must not depend
 * on resolving EVERY allowed base. In strict file-ops mode the bases include
 * smart folders, which can be network roots; one unreachable root whose
 * realpath hangs used to fail every validation that needed the canonical
 * check (including purely local files) with "Path check timeout". Real
 * filesystem in a temp directory.
 */

jest.mock('fs', () => jest.requireActual('fs'));
jest.mock('fs/promises', () => jest.requireActual('fs/promises'));
jest.mock('os', () => jest.requireActual('os'));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateFileOperationPath } = require('../src/shared/pathSanitization');

const isWindows = process.platform === 'win32';

// The temp root as a user would pass it. On Windows expand 8.3 short names
// (RUNNER~1) so it matches what the code resolves. On macOS keep the OS
// spelling: /var/folders/... resolves to /private/var/..., which is on the
// system-directory denylist as typed, and no user ever passes that form.
function spelledTempPath(p) {
  return process.platform === 'darwin' ? p : fs.realpathSync.native(p);
}

describe('validateFileOperationPath canonical allowlist bases', () => {
  /** @type {string} */
  let tmpRoot;
  /** @type {string} */
  let hangingBase;
  /** @type {string} */
  let viaLink;

  beforeEach(() => {
    tmpRoot = spelledTempPath(fs.mkdtempSync(path.join(os.tmpdir(), 'strato-bases-')));
    const target = path.join(tmpRoot, 'real-docs');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'note.txt'), 'hello');
    // A link inside the allowed base to a folder inside it: the real location
    // differs from the spelling, so the canonical check runs, and is allowed.
    fs.symlinkSync(target, path.join(tmpRoot, 'docs-link'), isWindows ? 'junction' : 'dir');
    viaLink = path.join(tmpRoot, 'docs-link', 'note.txt');
    hangingBase = path.join(tmpRoot, 'offline-share');

    const realRealpath = fs.promises.realpath.bind(fs.promises);
    jest.spyOn(fs.promises, 'realpath').mockImplementation((p, ...rest) => {
      if (path.resolve(String(p)) === hangingBase) return new Promise(() => {});
      return realRealpath(p, ...rest);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('a path really inside one base passes although another base never resolves', async () => {
    const started = Date.now();
    const result = await validateFileOperationPath(viaLink, {
      allowedBasePaths: [tmpRoot, hangingBase],
      checkSymlinks: true
    });

    expect(result).toEqual(expect.objectContaining({ valid: true }));
    expect(Date.now() - started).toBeLessThan(4000);
  }, 15000);

  test('a path whose real location is outside every base is still refused', async () => {
    const outside = spelledTempPath(fs.mkdtempSync(path.join(os.tmpdir(), 'strato-out-')));
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
      const base = path.join(tmpRoot, 'base');
      fs.mkdirSync(base);
      fs.symlinkSync(outside, path.join(base, 'escape'), isWindows ? 'junction' : 'dir');

      const result = await validateFileOperationPath(path.join(base, 'escape', 'secret.txt'), {
        allowedBasePaths: [base, hangingBase],
        checkSymlinks: true
      });

      expect(result.valid).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }, 15000);
});
