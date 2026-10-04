/**
 * @jest-environment node
 */
/**
 * Tests for scripts/verify-checkjs-ratchet.js — the monotonic coverage guard
 * for the JSDoc checkjs lane. Smoke-tests the CLI against the current tree
 * (mirrors test/verifyAnalysisRouting.test.js) and unit-tests runChecks()
 * against temp fixtures.
 */

// The global test-setup mocks fs/os with memfs + a virtual /tmp. These tests
// spawn real child processes and touch the real filesystem, so we must opt out
// (established pattern — see test/atomicFileOperations.test.js et al.).
jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'verify-checkjs-ratchet.js');

describe('verify-checkjs-ratchet.js', () => {
  test('CLI exits 0 against the current tree', () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: REPO_ROOT,
      encoding: 'utf8'
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/verify:checkjs-ratchet: \d+\/\d+ src \.js files opted in/);
  });

  test('CLI --list prints files lacking the directive', () => {
    // Uses a temp fixture, NOT the live tree: any live-tree assertion here
    // would break as waves opt files in.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkjs-list-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'opted.js'), '// @ts-check\nmodule.exports = 1;\n');
      fs.writeFileSync(path.join(tmpDir, 'bare.js'), 'module.exports = 2;\n');
      const result = spawnSync(process.execPath, [SCRIPT_PATH, '--list', tmpDir], {
        cwd: REPO_ROOT,
        encoding: 'utf8'
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('bare.js');
      expect(result.stdout).not.toContain('opted.js');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('runChecks', () => {
    const { runChecks } = require('../scripts/verify-checkjs-ratchet.js');
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkjs-ratchet-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('fails when opted-in count is below the floor', () => {
      fs.writeFileSync(path.join(tmpDir, 'a.js'), 'module.exports = 1;\n');
      const result = runChecks({ srcRoot: tmpDir, coveredDirs: [], floor: 1 });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatch(/fell below floor/);
    });

    test('counts a directive within the first 5 lines, trims CRLF', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'a.js'),
        "'use strict';\r\n// @ts-check\r\nmodule.exports = 1;\r\n"
      );
      const result = runChecks({ srcRoot: tmpDir, coveredDirs: [], floor: 1 });
      expect(result.failures).toHaveLength(0);
      expect(result.optedIn).toBe(1);
    });

    test('ignores a directive mentioned only in prose past the scan window', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'a.js'),
        'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\n// @ts-check in a comment\n'
      );
      const result = runChecks({ srcRoot: tmpDir, coveredDirs: [], floor: 0 });
      expect(result.optedIn).toBe(0);
    });

    test('fails when a covered dir contains a non-opted-in file', () => {
      const covered = path.join(tmpDir, 'covered');
      fs.mkdirSync(covered);
      fs.writeFileSync(path.join(covered, 'ok.js'), '// @ts-check\nmodule.exports = 1;\n');
      fs.writeFileSync(path.join(covered, 'bad.js'), 'module.exports = 2;\n');
      const result = runChecks({
        srcRoot: tmpDir,
        coveredDirs: [covered],
        floor: 0
      });
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatch(/bad\.js/);
      expect(result.failures[0]).toMatch(/lacks \/\/ @ts-check/);
    });

    test('does not follow directory junctions/symlinks', () => {
      const sub = path.join(tmpDir, 'sub');
      fs.mkdirSync(sub);
      fs.writeFileSync(path.join(sub, 'a.js'), '// @ts-check\nmodule.exports = 1;\n');
      let linked = true;
      try {
        fs.symlinkSync(sub, path.join(tmpDir, 'link'), 'junction');
      } catch {
        linked = false; // symlink creation unavailable — skip assertion below
      }
      const result = runChecks({ srcRoot: tmpDir, coveredDirs: [], floor: 0 });
      expect(result.total).toBe(linked ? 1 : 1);
      expect(result.optedIn).toBe(1);
    });
  });
});
