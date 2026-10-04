#!/usr/bin/env node

/**
 * Verifies that native/runtime-critical modules load correctly.
 * Intended for CI to catch sharp-like regressions before packaging.
 *
 * Uses the shared `native-modules.js` manifest so rebuild and verify stay
 * in lockstep — adding a new native dep requires only one edit.
 */

const { getVerificationChecks } = require('./native-modules');

const checks = getVerificationChecks();

async function run() {
  const failures = [];

  for (const check of checks) {
    try {
      await check.verify();

      console.log(`OK: ${check.name}`);
    } catch (error) {
      failures.push({ name: check.name, error: error?.message || String(error) });
      console.error(`FAIL: ${check.name} -> ${error?.message || error}`);
    }
  }

  if (failures.length > 0) {
    console.error(`Native module verification failed (${failures.length} issue(s)).`);
    process.exit(1);
  }

  console.log(`Native module verification passed (${checks.length} checks).`);
}

run().catch((error) => {
  console.error(`Native module verification crashed: ${error?.message || error}`);
  process.exit(1);
});
