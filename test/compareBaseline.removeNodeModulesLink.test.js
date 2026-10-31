/**
 * @jest-environment node
 *
 * compare-baseline links the main repo's node_modules into each stability
 * worktree and must detach that link before removing the worktree, without
 * ever deleting the main repo's real dependencies through it.
 *
 * Runs on the real filesystem: the global memfs mock has no Windows junctions,
 * so it would reject the rmdir that a real junction accepts.
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { removeNodeModulesLink } = require('../scripts/stability/compare-baseline');

describe('compare-baseline removeNodeModulesLink', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'stability-link-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('removes the linked node_modules and leaves its target intact', () => {
    const mainModules = path.join(root, 'main', 'node_modules');
    fs.mkdirSync(path.join(mainModules, 'jest'), { recursive: true });
    fs.writeFileSync(path.join(mainModules, 'jest', 'package.json'), '{}');
    const worktree = path.join(root, 'worktree');
    fs.mkdirSync(worktree);
    // Same call as ensureWorktreeDependencies: a junction on Windows, a plain
    // symlink elsewhere.
    fs.symlinkSync(mainModules, path.join(worktree, 'node_modules'), 'junction');

    removeNodeModulesLink(worktree);

    expect(fs.existsSync(path.join(worktree, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(mainModules, 'jest', 'package.json'))).toBe(true);
  });

  test('leaves a real node_modules directory alone', () => {
    const worktree = path.join(root, 'worktree');
    fs.mkdirSync(path.join(worktree, 'node_modules', 'pkg'), { recursive: true });

    removeNodeModulesLink(worktree);

    expect(fs.existsSync(path.join(worktree, 'node_modules', 'pkg'))).toBe(true);
  });

  test('does nothing when the worktree has no node_modules', () => {
    const worktree = path.join(root, 'worktree');
    fs.mkdirSync(worktree);

    expect(() => removeNodeModulesLink(worktree)).not.toThrow();
  });
});
