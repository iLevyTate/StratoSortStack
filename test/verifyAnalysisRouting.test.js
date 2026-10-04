/**
 * Integration test for scripts/verify-analysis-routing.js.
 *
 * Spawns the script in a child Node process and asserts that against
 * the current tree it exits 0 (the contract holds today). This guards
 * against accidental breakage of the gate itself — e.g., a refactor
 * that removes the SUPPORTED_*_EXTENSIONS exports the script depends on.
 *
 * The negative scenario (gate exits 1 when the media bucket is removed)
 * was verified manually during the gate's introduction by temporarily
 * reverting partitionFilesByModality and re-running the script. It
 * isn't reproduced here because reliably overriding require resolution
 * across a child-process boundary is brittle and not worth the test
 * complexity for a one-shot smoke.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'verify-analysis-routing.js');

describe('verify-analysis-routing.js', () => {
  test('exits 0 against the current routing module', () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      cwd: REPO_ROOT,
      encoding: 'utf8'
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/All \d+ supported extensions route/);
  });
});
