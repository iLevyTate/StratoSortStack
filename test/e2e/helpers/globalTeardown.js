/**
 * Global Teardown for Playwright E2E Tests
 *
 * This file runs once after all tests complete.
 * Use it to clean up test artifacts, close connections, etc.
 */

const path = require('path');
const fs = require('fs');
const { killOrphanStratoSortElectronProcesses } = require('./electronApp');

/**
 * Global teardown function
 * @param {Object} config - Playwright config
 */
async function globalTeardown(_config) {
  console.log('\n========================================');
  console.log('StratoSort E2E Test Suite - Teardown');
  console.log('========================================\n');

  const projectRoot = path.resolve(__dirname, '../../..');

  // 1. Kill any orphaned StratoSort Electron processes. The kill helper is
  // scoped to electron.exe launched from this repo with our entry args, so it
  // never touches unrelated Electron apps. Previously this step only LISTED
  // processes — leaked instances from crashed tests held userData locks and
  // broke subsequent runs.
  console.log('[Teardown] Killing orphaned StratoSort Electron processes (if any)...');
  killOrphanStratoSortElectronProcesses();

  // 2. Report test results location
  const resultsDir = path.join(projectRoot, 'test-results', 'e2e');
  const reportDir = path.join(projectRoot, 'test-results', 'e2e-report');

  if (fs.existsSync(reportDir)) {
    console.log(`[Teardown] Test report available at: ${reportDir}/index.html`);
  }

  // 3. List any screenshots taken during tests
  const screenshotsDir = path.join(resultsDir, 'screenshots');
  if (fs.existsSync(screenshotsDir)) {
    const screenshots = fs.readdirSync(screenshotsDir);
    if (screenshots.length > 0) {
      console.log(`[Teardown] ${screenshots.length} screenshot(s) saved in: ${screenshotsDir}`);
    }
  }

  // 4. Clean up temporary test directories
  console.log('[Teardown] Cleaning up temporary test files...');
  const os = require('os');
  const tempDir = os.tmpdir();

  try {
    const entries = fs.readdirSync(tempDir);
    const e2eDirs = entries.filter((e) => e.startsWith('stratosort-e2e-'));

    for (const dir of e2eDirs) {
      const fullPath = path.join(tempDir, dir);
      try {
        fs.rmSync(fullPath, { recursive: true, force: true });
        console.log(`[Teardown] Removed temp directory: ${dir}`);
      } catch (e) {
        console.log(`[Teardown] Could not remove ${dir}: ${e.message}`);
      }
    }

    if (e2eDirs.length === 0) {
      console.log('[Teardown] No temporary test directories to clean up');
    }
  } catch (e) {
    // Ignore cleanup errors
  }

  console.log('\n[Teardown] Global teardown complete');
  console.log('========================================\n');
}

module.exports = globalTeardown;
